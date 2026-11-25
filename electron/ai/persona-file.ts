// electron/ai/persona-file.ts
// 人格正文的独立文件（数据根下的 persona.md）——「她是谁」的唯一可编辑来源。
// 与核心版 src/services/personaFile.js 逐字对齐（逻辑与中文文案），改一端必须同步另一端。
//
// ── 为什么要从 config.json 搬出来（2026-11-25 用户拍板「人格统一都搬到独立文件」）──
// 原来人格存在 config.json 的 basePersona 字段里，三个问题：
//   ① **4000 字上限**：写得细一点就撞墙，超出被静默截断（setBasePersona 里 slice）。
//      人格是最该写长的东西，却和一个配置字段共用同一套限额。
//   ② **一损俱损**：config.json 同时装模型、密钥、搜索配置。这个文件写坏或
//      被某个写入口整体覆盖，人格会跟着一起丢。
//   ③ **没法当文本来用**：想读、想改、想 diff、想备份，都得先进 JSON 里挖字符串，
//      换行全变 \n。人格就该是一份**明文 Markdown**。
//
// ── 新的分层 ─────────────────────────────────────────────────────
//   persona.md      人格正文（用户可自由编辑，上限 20000 字）
//   config.json     只留 basePersona 作为**兼容字段**（老版本/老部署还读它）
//
// 读取优先级：persona.md 有内容 → 用它；否则回退 config.json 的 basePersona；
// 都空 → 内置 DEFAULT_PERSONA。这样升级不会让人格突然消失。
//
// ── 写入纪律（最容易出事的地方）──────────────────────────────────
//   · 只在**内容真的变了**时才落盘，避免每轮对话都重写文件；
//   · 原子写：先写 .tmp 再 rename，断电不会留下半个文件；
//   · 备份：覆盖前把旧文件复制到 backups/persona-<时间戳>.md（只留最近 10 份）；
//   · 坏档自愈：读不出来时返回空串走回退，绝不因为人格文件坏了就起不来。

import fs from "node:fs";
import path from "node:path";
import { homePaths } from "../kirari-home";
// 老字段（config.json 的 basePersona）只在这里被读一次，走 model-config 的原始读口。
// ⚠️ 与 model-config 是**互相 import**（它转发 get/setBasePersona 到本文件）。
// 两边都只在函数体内使用对方的导出，模块体没有任何求值，所以循环 import 安全；
// 千万不要把 getRawBasePersona 提到模块顶层去调。
import { getRawBasePersona } from "../model-config";

/** 人格文件的大小上限。比旧 basePersona 的 4000 放宽 5 倍，但仍要有界。 */
export const PERSONA_MAX_CHARS = 20000;
/** 覆盖前保留的备份份数。 */
export const KEEP_BACKUPS = 10;

/**
 * 解析人格文件的绝对路径。**每次调用现算**，不用模块级缓存：
 * 测试会换 KIRARI_HOME / 换数据根，缓存会让它读到上一个用例的目录。
 */
export function personaPath(): string {
    return path.join(homePaths().home, "persona.md");
}

/** 备份目录（与其它备份同处 backups/）。 */
export function backupDir(): string {
    return homePaths().backups;
}

/**
 * 写文件的安全封装：先 .tmp 再 rename，并顺手清理超额备份。
 * 失败只 warn 不抛——人格写入失败不该让对话挂掉。
 */
export function writeAtomic(target: string, text: string): boolean {
    const tmp = target + ".tmp-" + process.pid;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 覆盖前留一份备份（首次创建时不备份，没什么可备的）
        if (fs.existsSync(target)) {
            try {
                const dir = backupDir();
                fs.mkdirSync(dir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                fs.copyFileSync(target, path.join(dir, "persona-" + stamp + ".md"));
                // 只留最近 KEEP_BACKUPS 份，别把 backups 撑爆
                const olds = fs
                    .readdirSync(dir)
                    .filter((f) => f.startsWith("persona-") && f.endsWith(".md"))
                    .sort();
                for (const f of olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS))) {
                    try {
                        fs.unlinkSync(path.join(dir, f));
                    } catch {
                        /* 删不掉就算了 */
                    }
                }
            } catch (e) {
                console.warn("[persona] 备份旧人格失败（继续写入）:", e instanceof Error ? e.message : String(e));
            }
        }
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, target);
        return true;
    } catch (e) {
        console.warn("[persona] 写入 persona.md 失败:", e instanceof Error ? e.message : String(e));
        try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
        return false;
    }
}

/**
 * 读人格正文。
 *
 * @returns trim 过的正文；空串 = 没写过（调用方回退到下一级）
 */
export function readPersonaFile(): string {
    try {
        const p = personaPath();
        if (!fs.existsSync(p)) return "";
        const raw = fs.readFileSync(p, "utf8");
        return String(raw || "").trim().slice(0, PERSONA_MAX_CHARS);
    } catch (e) {
        console.warn("[persona] 读取 persona.md 失败（按未自定义处理）:", e instanceof Error ? e.message : String(e));
        return "";
    }
}

/** writePersonaFile 的结果。 */
export interface PersonaWriteResult {
    ok: boolean;
    saved: string;
    truncated: boolean;
    path: string;
}

/**
 * 写人格正文。传空串 = 删除文件（等价于「恢复预设」）。
 *
 * @param value 人格正文
 */
export function writePersonaFile(value: string | null | undefined): PersonaWriteResult {
    const text = typeof value === "string" ? value.trim() : "";
    const target = personaPath();

    if (!text) {
        // 「恢复预设」= 真的删掉文件，而不是留一个空文件。
        // 留空文件会让下次读取误判成「用户写了但内容为空」，回退逻辑要额外分支。
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch (e) {
            console.warn("[persona] 删除 persona.md 失败:", e instanceof Error ? e.message : String(e));
        }
        return { ok: true, saved: "", truncated: false, path: target };
    }

    // 变更检测：内容没变就不写盘（否则每轮自省都可能触发一次备份 + 写文件）
    const current = readPersonaFile();
    if (current === text.slice(0, PERSONA_MAX_CHARS)) {
        return { ok: true, saved: current, truncated: text.length > PERSONA_MAX_CHARS, path: target };
    }

    const truncated = text.length > PERSONA_MAX_CHARS;
    const saved = text.slice(0, PERSONA_MAX_CHARS);
    const ok = writeAtomic(target, saved + "\n");
    return { ok: ok, saved: saved, truncated: truncated, path: target };
}

/** resolvePersona 的结果：正文 + 它从哪一层来。 */
export interface ResolvedPersona {
    text: string;
    source: "file" | "config" | "none";
}

/**
 * 人格正文的「有效值」：persona.md → config.json 的 basePersona → 空串。
 *
 * 空串表示「三层都没有」，交给上层回退到内置 DEFAULT_PERSONA。
 * 之所以保留 config.json 那一级：老部署升级上来时人格还在 JSON 里，
 * 直接丢掉等于让用户的人格凭空消失。迁移在首次启动时做（见 migrateFromConfig）。
 */
export function resolvePersona(): ResolvedPersona {
    const fromFile = readPersonaFile();
    if (fromFile) return { text: fromFile, source: "file" };
    try {
        const legacy = getRawBasePersona();
        if (legacy && legacy.trim()) return { text: legacy.trim(), source: "config" };
    } catch {
        /* config 读不到就当没有 */
    }
    return { text: "", source: "none" };
}

/** migrateFromConfig 的结果。 */
export interface PersonaMigrationResult {
    migrated: boolean;
    chars: number;
}

/**
 * 一次性迁移：config.json 里有人格、persona.md 还没有 → 搬过去。
 *
 * **不删 config.json 里的旧值**。理由：两端（核心版 / 桌宠版）可能版本不同步，
 * 旧版本还在读 basePersona；删了会让它在升级前突然「人格变回预设」。
 * 等两端都升级到读 persona.md 之后，这个字段自然不再被读，留着无害。
 */
export function migrateFromConfig(): PersonaMigrationResult {
    try {
        const legacy = getRawBasePersona();
        if (!legacy || !legacy.trim()) return { migrated: false, chars: 0 };
        if (readPersonaFile()) return { migrated: false, chars: 0 };
        const r = writePersonaFile(legacy);
        if (r.ok) {
            console.log("[persona] 已把 config.json 的 basePersona 迁移到 persona.md（" + r.saved.length + " 字）");
            return { migrated: true, chars: r.saved.length };
        }
        return { migrated: false, chars: 0 };
    } catch (e) {
        console.warn("[persona] 迁移人格失败（不影响启动）:", e instanceof Error ? e.message : String(e));
        return { migrated: false, chars: 0 };
    }
}
