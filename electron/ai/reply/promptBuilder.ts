// electron/ai/reply/promptBuilder.ts
// 人格基座 + 各分支 system 提示模板 + 请求超时判定 + 对话历史归一化。
// 所有分支 prompt 都由「人格基座」派生，保证无论选哪个模型、走哪条分支，人格锚点一致、不漂移。
//
// 由 kirari-core/src/services/reply/promptBuilder.js 迁入（原 CommonJS，改写为 TypeScript）。

import type { StoredMessage } from "../types";
import { buildPersonaBlock } from "./persona";
import { VOICE_RULES } from "./style";

/**
 * 启动 / 打开聊天窗口时主进程直接推送的问候语。
 * 它本身不写入记忆，但为防止任何误落库的情况污染 LLM 上下文，拼装给模型的对话历史时统一剔除。
 */
export const GREETING_MESSAGE = "在的。";

/** 位置相关追问 / 设置提示语 */
export const LOCATION_ASK_MESSAGE =
    "我还不知道你在哪个城市。告诉我国内外的城市名就行，之后查天气和当地时间就能对上你的作息了。（比如「北京」「上海」）";

// 事实约束：防止模型编造具体台词/情节/数据，尤其是在 ACG、历史、科学等需要准确出处的领域。
// 追加在人格基座之后，所有分支（normal/withTools/polish/locationSet）都会继承。
const GROUNDING_RULES = `在回答涉及具体事实的问题时，请遵守以下约束：
- 禁止编造具体台词、情节、数据、人物关系、作品出处或未经核实的细节。如果无法从已知信息中确认某个具体事实，请直接说“我不太确定”或“这个我不记得了”，不要为了回答完整而虚构内容。
- 如果提供了【知识库参考】或【今日背景】，请优先依据其中内容作答；当参考内容与你自己的记忆冲突时，以参考内容为准。
- 如果主人纠正或质疑了你之前说的某个事实（如“你记错了”“根本没有”“她没说过”“哪有”“编的吧”），先坦然承认自己确实可能记错了，不要硬编理由或换另一个说法圆场。若你不确定真正的正确信息，可以搜索一两下找依据后再回答（这是被允许的、也是你该做的）；但搜索要“有限度”——最多一两次，找不到明确结论就坦诚说“这个我不太确定”，不要为了自证而反复搜索、也不要和主人争辩。
- 回答作品、角色、台词、情节等事实类问题时，若参考内容没有包含该信息，请明确表达不确定，不要自行脑补名台词或剧情。`;

// 系统提示模板
//
// 人格与声音规则已抽到同目录的两个模块（2026-11-25 分层改造，与核心版同构）：
//   persona.ts —— 身份层：预设人格、优先级声明、结尾返场提醒
//   style.ts   —— 声音层：说话倾向（旧的「AI 味铁律」硬禁令已下线，长度改由 speakingDesire 给档位）
// 这里保留 GROUNDING_RULES（事实约束）与 JSON 契约：它们与人格无关，任何人格都要说同样的话。
//
// ⚠️ 不要在本文件 import 之后顺手把这些常量再 export 一次（例如 export { DEFAULT_PERSONA } from "./persona"）：
// vite8/rolldown 对「import 进来只为再 export、且没人真正引用」会 panic
// （SymbolRef ... is not in any chunk），直接让 electron 构建失败。
// 需要这两个常量的地方请直接从 ./persona 或 ./style 取。

// ── 气泡拆分 ────────────────────────────────────────────────────────────
// 把一条回复拆成多条"独立气泡"（与 pet-api 的 splitSpeechBubbles 同一逻辑，改一边必须同步另一边）。
// 真人聊天是连发短消息：按换行拆，无换行的长文按句末标点切，最多 5 条，单条超长不硬切。
function splitSpeechBubbles(text: string): string[] {
    const raw = String(text || "").trim();
    if (!raw) return [];
    let lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (lines.length === 1 && lines[0].length > 40) {
        const sentences = lines[0].split(/(?<=[。？！…])/).map((s) => s.trim()).filter(Boolean);
        if (sentences.length >= 2 && sentences.every((s) => s.length >= 2)) lines = sentences;
    }
    const out: string[] = [];
    for (const line of lines) {
        if (!line) continue;
        if (out.length >= 5) {
            out[out.length - 1] += "\n" + line;

            continue;
        }
        out.push(line);
    }
    return out.length ? out : [raw];
}

// 模型回复的 JSON 输出契约（与人格无关，始终是固定结构，永远追加在人格描述之后）。
const JSON_OUTPUT_CONTRACT = `请只输出一个 JSON 对象（不要包含任何额外文字、不要使用 markdown 代码块），格式如下：
{"speech":"你对用户的口语化回复","emotion":"见下方可选值，或 null"}
字段说明：
- speech：你真正要说的话，像随口说出来的。长短看内容需要，不必为求完整而铺陈；不要出现 JSON 或情绪标签字样。
- emotion：这轮回复表达的情绪/动作标签（从下列值中挑最贴切的一个；无明显情绪时填 null）：
  - "happy"：开心、赞同、被夸奖、送出好消息等正向情绪。
  - "wave"：打招呼、欢迎、告别、主动搭话。
  - "excited"：特别兴奋、惊喜式的好消息、雀跃（比 happy 更强烈）。
  - "surprised"：惊讶、被吓一跳、听到意料之外的事。
  - "shy"：害羞、被调戏/夸得不好意思、小声脸红。
  - "sad"：失落、委屈、被说笨/被凶、听到让人难过的事。
  - "nod"：认可、答应、表示"好的我懂了/交给我吧"。
  - "shake"：摇头拒绝、表示"不行/不可以/做不到"、轻微否定。
  - "bow"：郑重致谢、道歉、礼貌问候（如"辛苦了""谢谢你"）。
  - "thinking"：正在认真思考、权衡、准备帮主人想办法（常用于需要先想一下再答的语境）。
  - "head_tilt"：疑惑、没听懂、想让主人再说一遍；或表示"我在认真听"。
  - "angry"：生气、不满、被惹恼、假装傲娇发火（比 sad 更有攻击性）。
  - "attention"：举手示意"我在这里/请注意我"、主动引起主人注意（与 wave 的打招呼/告别不同）。
  - "stretch"：伸懒腰、打哈欠、刚睡醒或休息放松（清醒状态的舒展，非入眠）。
  - 其他情况一律填 null。
- 图片展示：如需在回复中展示图片（例如搜索结果图、或你生成的图），可在 speech 的适当位置使用标准 markdown 图片语法 ![图片描述](图片URL)；系统会将该图片单独渲染。URL 必须完整且不含空格，不要用 HTML <img> 标签。`;

export { splitSpeechBubbles };

/**
 * 根据「用户自定义人格（优先）或预设人格」构建系统提示基座。
 * persona 为空/缺省回退 DEFAULT_PERSONA（在 persona.ts 里）。
 * 无论用户切换哪个模型、走哪条分支，人格锚点都保持不变，不会发生人格偏移。
 */
export function buildBasePrompt(persona?: string | null): string {
    // 分层顺序固定：身份层（人格 + 优先级声明）→ 声音层（倾向）→ 事实约束 → JSON 契约。
    // 身份层排第一是为了让模型先建立「她是谁」，声音层紧跟其后给倾向；
    // 结尾再补一次 buildPersonaEcho（在 conversationService 里追加），防止中间上千字的
    // 准则与清单把人格稀释掉。
    return buildPersonaBlock(persona) + "\n\n" + VOICE_RULES + "\n\n" + GROUNDING_RULES + "\n\n" + JSON_OUTPUT_CONTRACT;
}

/** 由人格基座派生的四条分支 system 提示。 */
export type SystemPrompts = {
    /** 非 direct 工具（如搜索）命中时，把工具结果注入，让模型用口语回答 */
    withTools: string;
    /** direct 工具（时间/天气）命中时，把原始数据交给模型润色成口语 */
    polish: string;
    /** 位置设置确认专用润色 */
    locationSet: string;
    /** 无工具命中时的常规提示 */
    normal: string;
};

export function buildSystemPrompts(base: string): SystemPrompts {
    const withTools =
        base +
        `\n以下是通过工具获取到的实时数据，请据此用口语化方式回答用户的问题（不要提及「工具」二字）：\n{{TOOL_RESULTS}}`;

    const polish =
        base +
        `\n请根据下面的「用户问题」和「已查到的实时数据」生成回复。
用户问题：{{USER_QUESTION}}
实时数据：{{TOOL_RESULTS}}
要求：
- 用你平时说话的自然口吻，直接回答用户问题；
- 严格使用实时数据中的数字、时间、地点，不得改动；
- 直接回答，不要反问，不要问"要看天气还是时间"之类的问题；
- 不要说你还需要查询、获取、等待或刷新，数据已经是最新的；
- 禁止照搬原始格式：不要输出 "Asia/Shanghai" 这类时区ID，不要输出 "2026-07-31T01:15" 这类ISO时间，不要输出"观测时间"等字段名；
- 时间用"凌晨/早上/上午/中午/下午/晚上"自然表达；天气不要把所有数字列表式报完，挑重点组织成一句流畅的话；
- 可以顺带一句关心或闲聊，但绝对不要编造数据，不要提「工具」二字。

示例（只作「信息怎么取舍」和「同一个问题可以怎么说」的参考，数字以实时数据为准）：
用户问题：现在几点
实时数据：现在本地时间是 2026年7月31日 星期五 凌晨01:15:06
可以这样回：{"speech":"凌晨一点十五了。","emotion":"stretch"}
也可以这样回：{"speech":"星期五，凌晨 1 点 15。这个点还没睡？","emotion":null}
不要这样（把字段名、时区原样倒出来）：{"speech":"当前时间：2026年7月31日星期五 01:15:06（时区 Asia/Shanghai）","emotion":null}

用户问题：常州现在天气怎么样
实时数据：常州市现在晴，气温 30.4°C（体感 36.8°C），相对湿度 73%，风速 1.8 km/h。
可以这样回：{"speech":"常州晴，30 度出头，体感快 37 了，挺闷的。","emotion":null}
也可以这样回：{"speech":"晴着，30.4°C，体感 36.8°C，风很小——这种天气容易中暑。","emotion":"happy"}
不要这样（把数字和字段名列表式念一遍）：{"speech":"明天在常州市，天气晴，气温 30.4℃，体感 36.8℃，湿度 73%，风速 1.8 km/h，观测时间 2026-07-31T01:15","emotion":null}

注意：上面两组「可以这样回」是同一个问题的两种说法，不是要你每次都照着第一种写。
你的回答应该随当时的心情、和对方的关系、问题急不急而变化——不要每次都套同一个句子结构。

只输出约定的 JSON。`;

    const locationSet =
        base +
        `\n下面是刚刚发生的「位置设置」事实（已经确定的事实，请勿改动其中的地名）：
{{TOOL_RESULTS}}
请用你平时说话的口吻，自然地告诉对方"位置已经记成上面这个行政区划"，
并请对方确认一下：如果记错了（比如同名城市选错、或者更具体的区县/街道没记到），补充一下具体地址就好。
可以顺带闲聊一句，但绝对不要编造地名，也不要提「工具」二字。只输出约定的 JSON。`;

    const normal =
        base +
        "\n如果用户询问实时信息（如当前时间、天气、最新新闻或需要联网检索的事实），你可以使用提供的工具获取最新数据，再据此组织口语化回复。" +
        "\n对于作品、角色、台词、情节、数据等事实类问题，优先使用【知识库参考】和工具结果；若参考内容无法确认该事实，请明确表达不确定，不要自行脑补或编造细节。";

    return { withTools, polish, locationSet, normal };
}

/**
 * 把"已记录的行政区划"整理成给 LLM 润色的原始事实文本（数字/地名不可改动）。
 */
export function buildLocationSetRaw(loc: string, ambiguous?: boolean): string {
    let raw = `已记录的用户位置（行政区划，请勿改动其中的地名）：${loc}`;
    if (ambiguous) {
        raw +=
            "\n备注：该地名在多个地方都有重名，系统按最可能的候选记录，若记错请等待主人纠正。";
    }
    return raw;
}

/** 位置设置成功后给用户看的确认语。 */
export function locationSetMessage(loc: string, ambiguous?: boolean): string {
    let msg = `位置记成${loc}了，之后查天气和时间按这里算。`;
    if (ambiguous) {
        msg += "（这个名字好几个地方都有，我先按最可能的记了；不对的话告诉我城市名就行。）";
    }
    return msg;
}

/** 复杂度规则：命中则给更长超时。 */
const COMPLEXITY_RULES: { pattern: RegExp; timeout: number }[] = [
    {
        pattern: /什么模型|哪个模型|由什么驱动|模型驱动|为什么|原理|分析|比较|区别|设计|实现/,
        timeout: 90000,
    },
    {
        pattern: /详细|具体|举例|步骤|代码|方案|如何接入|怎么实现/,
        timeout: 90000,
    },
];

/** 按问题复杂度决定请求超时（毫秒）。 */
export function getRequestTimeout(content: string): number {
    const matchedRule = COMPLEXITY_RULES.find((rule) => rule.pattern.test(content));
    if (matchedRule) return matchedRule.timeout;
    if (content.length > 120) return 90000;
    if (content.length > 40) return 60000;
    return 45000;
}

/**
 * 剔除交给 LLM 的对话历史中的系统噪声消息（如启动问候语），避免污染上下文。
 */
export function stripNonConversational(messages: StoredMessage[]): StoredMessage[] {
    return messages.filter((m) => {
        const c = m.content;
        let text = "";
        if (Array.isArray(c)) {
            const t = c.find((p) => p && p.type === "text");
            text = t ? String((t as { text?: string }).text || "") : "";
        } else {
            text = typeof c === "string" ? c : String(c || "");
        }
        return text.trim() !== GREETING_MESSAGE;
    });
}
