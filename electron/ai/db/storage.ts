// electron/ai/db/storage.ts
// 本地持久化：对话记录 / 位置记忆 / 每日简报。
//
// 由 kirari-core/src/db/dbStorage.js 迁入并大幅精简。
//
// 精简依据（见 ARCHITECTURE-PLAN 阶段 0）：桌宠端不再有账户系统与远程客户端，
// 凭证改由用户自持并存在 userData/config.json，因此删掉三张表：
//   - users        （注册/登录，桌宠本地形态不需要）
//   - api_tokens   （凭证与配置档案，改由 userData/config.json 承担；**明文存，未加密**）
//   - api_clients  （远程客户端公钥登记）
// 保留：
//   - messages     对话记录
//   - bot_locations 位置记忆（本机主人与机器人客人共用，按 scope 隔离）
//   - daily_memory 每日简报
//
// 另一处改动：数据库路径由主进程显式注入（app.getPath('userData')），
// 不再读 process.env.PET_API_DATA_DIR —— 进程内没有子进程边界，直接传参更清楚。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { ContentPart, MessageRole } from "../types";

type DB = Database.Database;

let db: DB | null = null;
let dbPathUsed = "";

/** 本机主人位置记录使用的 scope（机器人客人用群号/QQ号，见会话映射） */
export const LOCAL_SCOPE = "local";
/** 本机主人的固定 uid（桌宠单机形态下只有一个使用者） */
export const LOCAL_UID = 1;

function fallbackPath(): string {
    return path.join(os.homedir(), ".akisaki-kirari", "kirari.db");
}

/**
 * 初始化数据库。必须由主进程在启动时调用一次，传入 userData 下的路径。
 * 幂等：重复调用且路径相同时直接返回已有实例。
 */
export function initDatabase(dbPath?: string): DB {
    const target = dbPath || fallbackPath();
    if (db && dbPathUsed === target) return db;

    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(target);
    dbPathUsed = target;
    db.pragma("journal_mode = WAL");
    // 与核心版共用同一个 pet_sessions.db 时必须设：核心版（本地模式是主进程拉起的
    // 子进程）同时在写。没有 busy_timeout，一端写时另一端立刻 SQLITE_BUSY 报错。
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    migrateUiColumns();
    return db;
}

/**
 * messages 表的 UI 扩展列（emotion / images_json）。
 *
 * 为什么加：这张表现在同时是**桌宠聊天界面的记录真源**（用户拍板：聊天记录统一用
 * 数据库，废掉 chat-session.json）。界面要显示情绪动画标签和图片，而内核上下文
 * 只需要 role + content —— 两类需求共用一列 content 会互相污染，所以单开两列。
 * 核心版读历史时原样带回，两端记录完全互通。
 */
function migrateUiColumns(): void {
    if (!db) return;
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("emotion")) db.exec("ALTER TABLE messages ADD COLUMN emotion TEXT");
    if (!cols.includes("images_json")) db.exec("ALTER TABLE messages ADD COLUMN images_json TEXT");
}

/** 取得数据库实例；未显式初始化时用兜底路径（会告警，但不阻塞）。 */
export function getDb(): DB {
    if (!db) {
        console.warn("[db] 未调用 initDatabase，回退到默认路径");
        return initDatabase();
    }
    return db;
}

/** 当前数据库文件路径（供设置页展示/排障） */
export function getDbPath(): string {
    return dbPathUsed;
}

/** 关闭数据库（应用退出前调用） */
export function closeDatabase(): void {
    try {
        db?.close();
    } catch {
        /* 关闭失败不影响退出 */
    }
    db = null;
    dbPathUsed = "";
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 桌宠聊天界面需要的两个扩展字段（可空），见 migrateUiColumns。
    emotion TEXT, images_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);

  CREATE TABLE IF NOT EXISTS bot_locations (
    owner_uid INTEGER NOT NULL,
    scope TEXT NOT NULL,
    location TEXT, location_raw TEXT, location_name TEXT, location_admin1 TEXT,
    location_country TEXT, location_country_code TEXT,
    latitude REAL, longitude REAL, location_source TEXT,
    location_timezone TEXT, location_asked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_uid, scope)
  );

  CREATE TABLE IF NOT EXISTS daily_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL,
    date TEXT NOT NULL,
    brief_text TEXT NOT NULL,
    topics_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userid, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_memory_user_date ON daily_memory(userid, date);
`;

// ---------------------------------------------------------------- 对话记录

/** 单条消息（content 可能是纯文本，也可能是 [text, image_url] 多模态数组） */
export type StoredMessage = {
    role: MessageRole;
    content: string | ContentPart[];
};

/**
 * 聊天界面用的完整消息（比 StoredMessage 多出界面需要的字段）。
 * 与核心版 dbStorage.getSessionMessages 返回的形状一致 —— 两端记录互通。
 */
export type UiMessage = {
    id: string;
    role: string;
    content: string | ContentPart[];
    emotion: string | null;
    images: string[];
    timestamp: number;
};

/**
 * 每个会话保留的最大消息条数。
 *
 * 原为 10 —— 那时这张表只当「上下文窗口」用，删旧的没关系。
 * 现在它同时是**桌宠聊天界面的记录真源**（用户拍板：聊天记录统一用数据库），
 * 10 条等于翻不了历史，所以提高到 500。
 * 上下文仍由 getRecentMessages 按需取最近几条，存得久不等于喂给模型的多。
 */
const MAX_MESSAGES_PER_SESSION = 500;

export async function initSession(sessionId: string): Promise<StoredMessage[]> {
    return getSession(sessionId);
}

export async function getSession(sessionId: string): Promise<StoredMessage[]> {
    const rows = getDb()
        .prepare("SELECT role, content, emotion, images_json FROM messages WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId) as { role: string; content: string; emotion: string | null; images_json: string | null }[];
    return rows.map((m) => ({ role: toRole(m.role), content: parseContent(m.content) }));
}

/**
 * 存一条消息。
 *
 * @param extras 界面需要的额外信息（情绪标签、图片）。引擎上下文只用 content，
 *   UI 历史用 extras —— 分开存，互不污染。不传就是纯上下文消息（组网补传等场景）。
 */
export async function saveMessage(
    sessionId: string,
    role: string,
    content: string | unknown[],
    extras?: { emotion?: string | null; images?: string[] },
): Promise<StoredMessage[]> {
    // content 可能是纯文本字符串，或 [text, image_url] 多模态数组；后者序列化为 JSON 存储。
    const c = typeof content === "string" ? content : JSON.stringify(content);
    const emotion =
        extras && typeof extras.emotion === "string" && extras.emotion.trim() ? extras.emotion.trim() : null;
    const imagesJson =
        extras && Array.isArray(extras.images) && extras.images.length
            ? JSON.stringify(extras.images.filter((x) => typeof x === "string" && x.trim()))
            : null;
    const d = getDb();
    d.prepare("INSERT INTO messages (session_id, role, content, emotion, images_json) VALUES (?, ?, ?, ?, ?)").run(
        sessionId,
        role,
        c,
        emotion,
        imagesJson,
    );
    const ids = d
        .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC")
        .all(sessionId) as { id: number }[];
    if (ids.length > MAX_MESSAGES_PER_SESSION) {
        const stale = ids.slice(MAX_MESSAGES_PER_SESSION).map((row) => row.id);
        d.prepare(`DELETE FROM messages WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale);
    }
    return getSession(sessionId);
}

/**
 * 全量会话历史（聊天界面用）。
 *
 * 与 getSession 的区别：返回形状面向 UI（带 id / 时间戳 / 情绪 / 图片），
 * 而不是面向模型上下文（只要 role + content）。
 */
export async function getSessionMessages(sessionId: string, limit = 200): Promise<UiMessage[]> {
    // ⚠️ 取的是**最近** limit 条（先倒序取再翻回正序）。
    // 直接 `ORDER BY id ASC LIMIT n` 拿到的是最老的 n 条 —— 会话长过 limit 时
    // 聊天界面永远停在开头，新消息反而看不到。
    const n = Math.min(500, Math.max(1, limit));
    const rows = getDb()
        .prepare(
            "SELECT id, role, content, emotion, images_json, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(sessionId, n)
        .reverse() as {
        id: number;
        role: string;
        content: string;
        emotion: string | null;
        images_json: string | null;
        timestamp: string;
    }[];
    return rows.map((m) => ({
        id: String(m.id),
        role: m.role,
        content: parseContent(m.content),
        emotion: m.emotion || null,
        images: parseImages(m.images_json),
        timestamp: toEpochMs(m.timestamp),
    }));
}

export async function getRecentMessages(sessionId: string, limit = 5): Promise<StoredMessage[]> {
    const rows = getDb()
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit * 2) as { role: string; content: string }[];
    return rows.reverse().map((m) => ({ role: toRole(m.role), content: parseContent(m.content) }));
}

/** 清空指定会话（用户点了"清空聊天记录"） */
export async function clearSession(sessionId: string): Promise<void> {
    getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
}

/**
 * 列出全部会话 id（最近有消息的排前面）。
 *
 * ⚠️ 排序键用自增 id 而不是 timestamp：timestamp 是秒级精度，
 * 同一秒里写入的多条（欢迎语+首轮问答、迁移批量导入等）时间完全相同，
 * 按时间排会产生平局、顺序不确定 —— 「采纳最近一段对话」就可能挑错会话。
 * 自增 id 严格单调，没有这个问题。
 */
export async function listSessions(): Promise<string[]> {
    const rows = getDb()
        .prepare("SELECT session_id, MAX(id) AS mx FROM messages GROUP BY session_id ORDER BY mx DESC")
        .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
}

/**
 * 把若干会话的消息并进目标会话（只改 session_id，消息本身、时间戳、自增 id
 * 全都原样不动，所以时间顺序天然保持）。
 *
 * 用途：修复「同一段本机对话被拆成好几个会话」的历史数据 —— 旧版本每次启动
 * 重掷一个随机 sessionId，聊一次就多一个孤儿会话。
 */
export async function mergeSessions(fromSessionIds: string[], intoSessionId: string): Promise<number> {
    const from = (Array.isArray(fromSessionIds) ? fromSessionIds : []).filter(
        (s) => typeof s === "string" && s && s !== intoSessionId,
    );
    if (!from.length) return 0;
    const d = getDb();
    const stmt = d.prepare("UPDATE messages SET session_id = ? WHERE session_id = ?");
    let moved = 0;
    for (const s of from) moved += stmt.run(intoSessionId, s).changes;
    return moved;
}

function parseContent(raw: string): string | ContentPart[] {
    if (typeof raw !== "string") return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ContentPart[]) : raw;
    } catch {
        // 非 JSON → 纯文本，保持原样
        return raw;
    }
}

/** images_json 列 → string[]；坏 JSON 当空数组（历史记录不该让界面崩）。 */
function parseImages(raw: string | null): string[] {
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

/**
 * SQLite 的 CURRENT_TIMESTAMP 是 UTC "YYYY-MM-DD HH:MM:SS"，转成毫秒时间戳。
 * 桌宠界面按毫秒排序/显示，与旧 chat-session.json 里的 timestamp 同单位。
 */
function toEpochMs(ts: string | null): number {
    if (ts == null) return Date.now();
    const parsed = Date.parse(`${String(ts).replace(" ", "T")}Z`);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

/** 数据库读出的 role 统一收敛为合法的 MessageRole */
function toRole(raw: string): MessageRole {
    const r = String(raw || "") as MessageRole;
    return r === "system" || r === "user" || r === "assistant" || r === "tool" ? r : "user";
}

// ---------------------------------------------------------------- 位置记忆

export type UserLocation = {
    location: string | null;
    raw: string | null;
    name: string | null;
    admin1: string | null;
    country: string | null;
    countryCode: string | null;
    latitude: number | null;
    longitude: number | null;
    source: string | null;
    timezone: string | null;
    askedAt: string | null;
};

/** 位置字段 → 列名（patch 用的是驼峰，列用 snake_case） */
const LOCATION_COLS: Record<string, string> = {
    location: "location",
    raw: "location_raw",
    name: "location_name",
    admin1: "location_admin1",
    country: "location_country",
    countryCode: "location_country_code",
    latitude: "latitude",
    longitude: "longitude",
    source: "location_source",
    timezone: "location_timezone",
    askedAt: "location_asked_at",
};

type LocationRow = {
    location?: string | null;
    location_raw?: string | null;
    location_name?: string | null;
    location_admin1?: string | null;
    location_country?: string | null;
    location_country_code?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    location_source?: string | null;
    location_timezone?: string | null;
    location_asked_at?: string | null;
};

/**
 * 读取位置记忆。
 * @param uid 本机固定为 LOCAL_UID
 * @param scope 机器人客人用群号/QQ号；本机主人用 LOCAL_SCOPE
 */
export async function getUserLocation(uid: number, scope: string = LOCAL_SCOPE): Promise<UserLocation | null> {
    const r = getDb()
        .prepare(
            "SELECT location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at FROM bot_locations WHERE owner_uid = ? AND scope = ?",
        )
        .get(uid, scope) as LocationRow | undefined;
    if (!r) return null;
    return {
        location: r.location || null,
        raw: r.location_raw || null,
        name: r.location_name || null,
        admin1: r.location_admin1 || null,
        country: r.location_country || null,
        countryCode: r.location_country_code || null,
        latitude: r.latitude != null ? Number(r.latitude) : null,
        longitude: r.longitude != null ? Number(r.longitude) : null,
        source: r.location_source || null,
        timezone: r.location_timezone || null,
        askedAt: r.location_asked_at || null,
    };
}

/** 写入/更新位置记忆（只更新传入的字段） */
export async function setUserLocation(
    uid: number,
    patch: Partial<UserLocation>,
    scope: string = LOCAL_SCOPE,
): Promise<boolean> {
    const d = getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of Object.keys(LOCATION_COLS)) {
        const v = (patch as Record<string, unknown>)[key];
        if (v === undefined) continue;
        sets.push(`${LOCATION_COLS[key]} = ?`);
        if (v == null) {
            vals.push(null);
        } else if (key === "latitude" || key === "longitude") {
            vals.push(Number(v));
        } else {
            vals.push(v);
        }
    }
    if (!sets.length) return false;

    const existing = d
        .prepare("SELECT 1 FROM bot_locations WHERE owner_uid = ? AND scope = ?")
        .get(uid, scope);
    if (existing) {
        d.prepare(
            `UPDATE bot_locations SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE owner_uid = ? AND scope = ?`,
        ).run(...vals, uid, scope);
    } else {
        const cols = ["owner_uid", "scope", ...sets.map((s) => s.split(" = ")[0])];
        const placeholders = cols.map(() => "?").join(", ");
        d.prepare(`INSERT INTO bot_locations (${cols.join(", ")}) VALUES (${placeholders})`).run(
            uid,
            scope,
            ...vals,
        );
    }
    return true;
}

// ---------------------------------------------------------------- 每日简报

export type DailyBrief = {
    briefText: string;
    topics: string[];
};

/** 读取某天的简报（按 uid + date 去重，每天仅一份） */
export async function getDailyBrief(uid: number, date: string): Promise<DailyBrief | null> {
    const row = getDb()
        .prepare("SELECT brief_text, topics_json FROM daily_memory WHERE userid = ? AND date = ?")
        .get(uid, date) as { brief_text: string; topics_json?: string | null } | undefined;
    if (!row) return null;
    return { briefText: row.brief_text, topics: safeJsonArray(row.topics_json) };
}

export async function upsertDailyBrief(
    uid: number,
    date: string,
    briefText: string,
    topics: string[] = [],
): Promise<boolean> {
    if (!briefText || !briefText.trim()) return false;
    getDb()
        .prepare(
            `INSERT INTO daily_memory (userid, date, brief_text, topics_json) VALUES (?, ?, ?, ?)
             ON CONFLICT(userid, date) DO UPDATE SET brief_text=excluded.brief_text, topics_json=excluded.topics_json, created_at=CURRENT_TIMESTAMP`,
        )
        .run(uid, date, briefText, JSON.stringify(topics));
    return true;
}

// ---------------------------------------------------------------- 工具函数

/** 遮蔽密钥，用于设置页展示（绝不回显完整值） */
export function maskToken(token: unknown): string {
    if (typeof token !== "string" || token.length <= 6) return "****";
    return `${token.slice(0, 3)}${"*".repeat(6)}${token.slice(-4)}`;
}

/** JSON 数组字段的容错解析（解析失败回退空数组） */
export function safeJsonArray(s: unknown): string[] {
    if (!s || typeof s !== "string") return [];
    try {
        const p = JSON.parse(s);
        return Array.isArray(p) ? p : [];
    } catch {
        return [];
    }
}
