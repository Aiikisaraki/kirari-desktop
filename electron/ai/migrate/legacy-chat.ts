// electron/ai/migrate/legacy-chat.ts
// 一次性迁移：旧版聊天记录 JSON → pet_sessions.db 的 messages 表。
//
// ── 为什么这个模块存在（历史踩坑，勿改回单文件路径）──────────────────
// 旧版聊天记录的文件名改过两次，只认一个名字必然漏读：
//   v0.1.12 – v0.5.0  →  chat-session.json
//   v0.5.1  – v0.7.2  →  chat-session.local.json          ← 绝大多数用户在这里
//                     →  chat-session.remote.<hash>.<uid>.json（远程部署模式）
//   v0.8.0 起          →  直接写数据库，本模块不再有源可迁
//
// 之前的实现只读 chat-session.json，遇到 .local / .remote.* 直接「文件不存在 → 返回」，
// 而且不打任何日志：从 v0.5.x 升上来的用户聊天记录凭空消失，全无声息。
// 所以这里**扫目录**，不写死文件名。
//
// ── 幂等怎么保证 ──────────────────────────────────────────────────
// 导入成功后才往 settings_kv 写一个键（MIGRATION_KEY_PREFIX + 文件名）。
// 之后无论源文件被删、被改名、还是用户手工放回来，都不会再导入第二次。
// 失败则不写键 —— 宁可下次重试，也不能把「迁了一半」的谎记进账。
//
// ── 为什么保留原始时间戳 ──────────────────────────────────────────
// 旧 JSON 每条消息都带毫秒级 timestamp。若走 db.saveMessage 入库，那条 INSERT 不写
// timestamp 列，会落到 DEFAULT CURRENT_TIMESTAMP —— 全部压成「迁移那一秒」，
// 一次迁几百条就等于时间信息全毁（历史上真发生过）。所以这里直接发原生 INSERT。
import fs from "fs/promises";
import path from "path";
import * as db from "../db/storage";

/** 迁移完成凭据的键前缀。最终键 = 前缀 + 源文件名。 */
const MIGRATION_KEY_PREFIX = "legacy-chat-json:";

/**
 * 旧版聊天记录的文件名匹配规则。
 *
 * 覆盖三种历史命名：固定名、本地模式、远程模式（后面跟 12 位哈希 + uid）。
 * 排除 .bak —— 那是 0.8.0 早期迁移留下的备份，里面是已经导进库的同一批数据，
 * 再导一次就是重复。
 */
const LEGACY_FILE_RE = /^chat-session\.json$|^chat-session\.local\.json$|^chat-session\.remote\..+\.json$/;

/** 单个文件的迁移结果，供调用方汇总打日志。 */
export type LegacyMigrationResult = {
    file: string;
    sessionId: string;
    imported: number;
    skipped: "already-migrated" | "session-exists" | "empty" | "invalid";
    removed: boolean;
};

/** 旧版 JSON 的顶层结构（字段名与历史版本 chat-session-service.ts 一致）。 */
type LegacyChatFile = {
    sessionId?: unknown;
    messages?: unknown;
};

/** 旧版单条消息。注意字段叫 author/text，不是 role/content。 */
type LegacyChatMessage = {
    id?: unknown;
    author?: unknown;
    text?: unknown;
    timestamp?: unknown;
    emotion?: unknown;
    images?: unknown;
};

/** 合法角色。旧版只有 user / pet（system 出现过但极少），落到库里 pet→assistant。 */
function toRole(author: unknown): "user" | "assistant" | "system" {
    return author === "pet" ? "assistant" : author === "system" ? "system" : "user";
}

/**
 * 毫秒 → SQLite 的 DATETIME 文本（UTC "YYYY-MM-DD HH:MM:SS"）。
 *
 * 必须与 storage.ts 里 toEpochMs 的解析严格互逆 —— 那边是
 * Date.parse(`${ts.replace(" ", "T")}Z`)，即按 UTC 解析。这里就得输出 UTC，不能本地时区。
 */
function toSqliteUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** 旧消息的毫秒时间戳。缺失/非法返回 null —— 由调用方决定留空还是跳过。 */
function toEpochMsOrNull(raw: unknown): number | null {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** 找出 userData 下所有旧版聊天记录文件（已排除 .bak 与已迁过的）。 */
async function findLegacyFiles(userDataDir: string): Promise<string[]> {
    let names: string[];
    try {
        names = await fs.readdir(userDataDir);
    } catch (e) {
        console.warn("[migrate] 读不到数据目录，跳过旧聊天记录迁移:", (e as Error)?.message || e);
        return [];
    }
    return names
        .filter((n) => LEGACY_FILE_RE.test(n))
        .sort()
        .map((n) => path.join(userDataDir, n));
}

/** 解析一个旧文件；结构不合法返回 null（调用方打日志并跳过，不删文件）。 */
function parseLegacyFile(text: string, file: string): LegacyChatFile | null {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as LegacyChatFile).messages)) {
            console.warn(`[migrate] 旧聊天记录 ${path.basename(file)} 结构不认识（缺 messages 数组），已保留原文件`);
            return null;
        }
        return parsed as LegacyChatFile;
    } catch (e) {
        console.warn(
            `[migrate] 旧聊天记录 ${path.basename(file)} 解析失败（已保留原文件）:`,
            (e as Error)?.message || e,
        );
        return null;
    }
}

/** 过滤出真正该入库的消息：文本非空。 */
function usableMessages(raw: unknown[]): LegacyChatMessage[] {
    const out: LegacyChatMessage[] = [];
    for (const m of raw) {
        if (!m || typeof m !== "object") continue;
        const text = (m as LegacyChatMessage).text;
        if (typeof text !== "string" || !text.trim()) continue;
        out.push(m as LegacyChatMessage);
    }
    return out;
}

/**
 * 迁移单个文件。
 *
 * 步骤：查幂等键 → 解析 → 校验 → 单事务写入（带原始时间戳）→ 写幂等键 → 删源文件。
 * 事务提交前任何异常都会让写入回滚，且**不删源文件** —— 数据安全优先于「清理干净」。
 */
async function migrateOne(file: string): Promise<LegacyMigrationResult | null> {
    const name = path.basename(file);
    const kvKey = MIGRATION_KEY_PREFIX + name;

    // 幂等第一道：迁移键已存在 → 这个文件早就处理过了，直接把残留清掉即可。
    if (db.getSetting(kvKey) !== null) {
        console.log(`[migrate] 旧聊天记录 ${name} 此前已迁移过，跳过`);
        await fs.unlink(file).catch(() => { /* 已不存在或被占用都无所谓，键才是判据 */ });
        return { file: name, sessionId: "", imported: 0, skipped: "already-migrated", removed: true };
    }

    let text: string;
    try {
        text = await fs.readFile(file, "utf-8");
    } catch (e) {
        // 读不到（权限/占用/已删）→ 当没有这个文件，不报错不阻断
        console.warn(`[migrate] 读旧聊天记录 ${name} 失败，跳过:`, (e as Error)?.message || e);
        return null;
    }

    const legacy = parseLegacyFile(text, file);
    if (!legacy) return null;

    const sessionId = typeof legacy.sessionId === "string" && legacy.sessionId.trim()
        ? legacy.sessionId.trim()
        : crypto.randomUUID();
    const messages = usableMessages(legacy.messages as unknown[]);

    if (messages.length === 0) {
        // 空文件（或只剩空消息）：没什么可导，但仍然算「处理完了」→ 写键 + 删文件，
        // 否则每次启动都会重扫它。
        db.setSetting(kvKey, new Date().toISOString());
        await fs.unlink(file).catch(() => { /* 删不掉就留着，下次启动会因有键而跳过 */ });
        console.log(`[migrate] 旧聊天记录 ${name} 里没有可导入的消息，已清理`);
        return { file: name, sessionId, imported: 0, skipped: "empty", removed: true };
    }

    // 幂等第二道：这个会话在库里已经有消息 → 数据早就进去了（迁移后又聊过，或上次迁过）。
    // 同样写键 + 删文件，避免反复触发。
    if ((await db.getSessionMessages(sessionId, 1)).length > 0) {
        db.setSetting(kvKey, new Date().toISOString());
        await fs.unlink(file).catch(() => { /* 同上 */ });
        console.log(`[migrate] 旧聊天记录 ${name} 对应的会话在数据库里已有记录，跳过导入`);
        return { file: name, sessionId, imported: 0, skipped: "session-exists", removed: true };
    }

    // 真正写入：单事务 + 原生 INSERT（为了带 timestamp 列）。
    const d = db.getDb();
    const insert = d.prepare(
        "INSERT INTO messages (session_id, role, content, timestamp, emotion, images_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const stamp = new Date().toISOString();
    const tx = d.transaction(() => {
        for (const m of messages) {
            const text2 = (m.text as string).trim();
            const emotion = typeof m.emotion === "string" && m.emotion.trim() ? m.emotion.trim() : null;
            const images = Array.isArray(m.images)
                ? m.images.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
                : [];
            const ms = toEpochMsOrNull(m.timestamp);
            insert.run(
                sessionId,
                toRole(m.author),
                text2,
                ms === null ? toSqliteUtc(Date.now()) : toSqliteUtc(ms),
                emotion,
                images.length ? JSON.stringify(images) : null,
            );
        }
        // 键与数据在同一事务里落库：不存在「数据写了一半但键已写」的中间态。
        d.prepare("INSERT INTO settings_kv (key, value) VALUES (?, ?)").run(kvKey, stamp);
    });
    tx();

    // 事务提交后才删源文件。删失败只提示 —— 键已写入，下次启动不会重复导入。
    let removed = false;
    try {
        await fs.unlink(file);
        removed = true;
    } catch (e) {
        console.warn(`[migrate] 旧聊天记录 ${name} 已导入数据库，但删除原文件失败（不影响使用）:`, (e as Error)?.message || e);
    }

    console.log(`[migrate] 已把 ${name} 的 ${messages.length} 条记录导入数据库（会话 ${sessionId.slice(0, 8)}…）${removed ? "，原文件已清理" : ""}`);
    return { file: name, sessionId, imported: messages.length, skipped: "invalid", removed };
}

/**
 * 执行旧版 JSON → 数据库的一次性迁移。
 *
 * 必须在 ChatSessionService 读取历史**之前**调用（main.ts 里由启动时序保证），
 * 否则界面会先渲染一份空历史。
 *
 * @param userDataDir app.getPath("userData")
 */
export async function migrateLegacyChatJson(userDataDir: string): Promise<LegacyMigrationResult[]> {
    try {
        const files = await findLegacyFiles(userDataDir);
        if (files.length === 0) return [];

        const results: LegacyMigrationResult[] = [];
        for (const file of files) {
            try {
                const r = await migrateOne(file);
                if (r) results.push(r);
            } catch (e) {
                // 单个文件失败绝不能拖垮整个启动：记录警告，继续迁下一个。
                // 这里绝不删文件 —— 下次启动会重试。
                console.warn(`[migrate] 迁移 ${path.basename(file)} 失败（已保留原文件，不影响启动）:`, (e as Error)?.message || e);
            }
        }

        const total = results.reduce((n, r) => n + r.imported, 0);
        if (total > 0) {
            console.log(`[migrate] 旧聊天记录导入完成，共 ${total} 条`);
        }
        return results;
    } catch (e) {
        console.warn("[migrate] 旧聊天记录迁移整体失败（不影响启动）:", (e as Error)?.message || e);
        return [];
    }
}