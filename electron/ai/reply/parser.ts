// electron/ai/reply/parser.ts
// 模型回复解析：把 LLM 返回的文本（可能是 JSON / 残缺 JSON / 自由文本）规整为
// { speech, emotion, images } 的稳定结构。四级容错：严格解析 → 修复后解析 → 正则提取 → 纯文本兜底。
//
// 由 kirari-core/src/services/reply/parser.js 迁入（原 CommonJS，改写为 TypeScript）。

import { EMOTION_VALUES, EMOTION_WHITELIST } from "../types";
import type { ParsedReply, PetEmotion } from "../types";

/** 把文本安全地 JSON.parse 为对象；失败返回 null。 */
function tryParseJson(text: string): Record<string, unknown> | null {
    try {
        const obj = JSON.parse(text);
        return obj && typeof obj === "object" && !Array.isArray(obj)
            ? (obj as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * 尽力修复残缺 JSON：剥离代码块、裁掉前后多余符号、补缺失大括号、去尾随逗号。
 * 返回修复后的字符串；无法判定为 JSON 片段时返回 null。
 */
function repairJson(text: string): string | null {
    let s = text.trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) s = fence[1].trim();
    if (!s) return null;

    // 只取首个 { 到最后一个 } 之间的片段，容忍前后多余符号（如 "好的 {...} 再见"）
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    s = s.slice(start, end + 1);

    // 去尾随逗号：{, ] 之前的多余逗号
    s = s.replace(/,(\s*[}\]])/g, "$1");

    // 配对大括号：缺右括号则在末尾补齐（容忍模型漏写闭合 }）
    const open = (s.match(/\{/g) || []).length;
    const close = (s.match(/\}/g) || []).length;
    if (open > close) s += "}".repeat(open - close);

    return s;
}

/** 末级兜底：从残缺 JSON 文本里用正则把 speech / emotion 抠出来。 */
function extractByRegex(text: string): { speech: string; emotion: PetEmotion | null } {
    const speechMatch = text.match(/"speech"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|"\s*[a-zA-Z]|$)/);
    const speech = speechMatch
        ? speechMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim()
        : "";
    const emoMatch = text.match(
        new RegExp(`"emotion"\\s*:\\s*"(${EMOTION_VALUES.join("|")})"`, "i"),
    );
    const emotion = emoMatch ? (emoMatch[1].toLowerCase() as PetEmotion) : null;
    return {
        speech,
        emotion: emotion && EMOTION_WHITELIST.has(emotion) ? emotion : null,
    };
}

/** 把解析出的对象收敛成 { speech, emotion }，speech 缺失时退回原对象的 JSON 文本。 */
function toResult(obj: Record<string, unknown>): { speech: string; emotion: PetEmotion | null } {
    if (typeof obj.speech === "string") {
        const speech = obj.speech.trim();
        if (speech) {
            const emotion =
                typeof obj.emotion === "string" && EMOTION_WHITELIST.has(obj.emotion)
                    ? (obj.emotion as PetEmotion)
                    : null;
            return { speech, emotion };
        }
        return { speech: "", emotion: null };
    }
    return { speech: JSON.stringify(obj), emotion: null };
}

/**
 * 从 speech 中提取 markdown 图片（![alt](url)），url 进入 images 数组并从文本移除，
 * 避免气泡里出现裸 markdown 语法；前端会单独以图片网格渲染 images。
 */
function extractImagesFromSpeech(speech: string): { speech: string; images: string[] } {
    const images: string[] = [];
    const cleaned = String(speech).replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_full, url) => {
        const u = String(url).trim();
        if (/^(https?:\/\/|data:image\/)/i.test(u)) images.push(u);
        return "";
    });
    return { speech: cleaned.replace(/\n{2,}/g, "\n").trim(), images };
}

/**
 * 合法的模型图片 URL：data:image/... 内联（入口处已解码缩放）或 http(s) 远程地址。
 * 其余（裸文件名 FF3C....jpg、base64:... 、data:image/ 之外的非法 data: 等）一律视为非法，
 * 丢弃以避免模型侧 base64 解码失败（500 error counting image token）。
 */
export function isValidImageUrl(url: unknown): boolean {
    if (typeof url !== "string") return false;
    const u = url.trim();
    if (/^https?:\/\//i.test(u)) return true;
    if (/^data:image\//i.test(u)) {
        const comma = u.indexOf(",");
        if (comma === -1) return false;
        const payload = u.slice(comma + 1).trim();
        // 载荷是 URL 而非 base64（部分客户端把真实链接塞进 base64 字段，
        // 形如 data:image/jpeg;base64,https://...）→ 视为非法，避免模型侧 500
        if (/^https?:\/\//i.test(payload)) return false;
        return true;
    }
    return false;
}

/** 补上 images 字段。 */
function withImages(result: { speech: string; emotion: PetEmotion | null }): ParsedReply {
    const { speech, images } = extractImagesFromSpeech(result.speech);
    return { speech, emotion: result.emotion ?? null, images };
}

/**
 * 将模型返回内容解析为 { speech, emotion, images }。四级容错。
 * 这是模型输出进入桌宠之前唯一的格式化关口，容错必须留足。
 */
export function parseModelReply(raw: unknown): ParsedReply {
    if (!raw) return { speech: "", emotion: null, images: [] };
    const text = String(raw).trim();
    if (!text) return { speech: "", emotion: null, images: [] };

    const strict = tryParseJson(text);
    if (strict) return withImages(toResult(strict));

    const repaired = repairJson(text);
    if (repaired) {
        const obj = tryParseJson(repaired);
        if (obj) return withImages(toResult(obj));
    }

    const heur = extractByRegex(text);
    if (heur.speech) return withImages(heur);

    if (text.startsWith("{")) return { speech: "", emotion: null, images: [] };
    return withImages({ speech: text, emotion: null });
}
