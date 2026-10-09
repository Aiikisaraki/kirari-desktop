// electron/ai/db/storage.ts
// 本地持久化：对话记录 / 位置记忆 / 每日简报。
//
// 由 kirari-core/src/db/dbStorage.js 迁入并大幅精简。
//
// 精简依据（见 ARCHITECTURE-PLAN 阶段 0）：桌宠端不再有账户系统与远程客户端，
// 凭证改由用户自持并存在 userData/config.json，因此删掉三张表：
//   - users        （注册/登录，桌宠本地形态不需要）
//   - api_tokens   （凭证与配置档案，改由 config.json + safeStorage 承担）
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
    db.exec(SCHEMA);
    return db;
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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
    role: string;
    content: string | unknown[];
};

/** 每个会话保留的最大消息条数（与内核原行为一致，避免上下文无限膨胀） */
const MAX_MESSAGES_PER_SESSION = 10;

export async function initSession(sessionId: string): Promise<StoredMessage[]> {
    return getSession(sessionId);
}

export async function getSession(sessionId: string): Promise<StoredMessage[]> {
    const rows = getDb()
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId) as { role: string; content: string }[];
    return rows.map((m) => ({ role: m.role, content: parseContent(m.content) }));
}

export async function saveMessage(
    sessionId: string,
    role: string,
    content: string | unknown[],
): Promise<StoredMessage[]> {
    // content 可能是纯文本字符串，或 [text, image_url] 多模态数组；后者序列化为 JSON 存储。
    const c = typeof content === "string" ? content : JSON.stringify(content);
    const d = getDb();
    d.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, c);
    const ids = d
        .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC")
        .all(sessionId) as { id: number }[];
    if (ids.length > MAX_MESSAGES_PER_SESSION) {
        const stale = ids.slice(MAX_MESSAGES_PER_SESSION).map((row) => row.id);
        d.prepare(`DELETE FROM messages WHERE id IN (${stale.map(() => "?").join(",")})`).run(...stale);
    }
    return getSession(sessionId);
}

export async function getRecentMessages(sessionId: string, limit = 5): Promise<StoredMessage[]> {
    const rows = getDb()
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit * 2) as { role: string; content: string }[];
    return rows.reverse().map((m) => ({ role: m.role, content: parseContent(m.content) }));
}

/** 清空指定会话（用户点了"清空聊天记录"） */
export async function clearSession(sessionId: string): Promise<void> {
    getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
}

/** 列出全部会话 id（按最近消息时间倒序） */
export async function listSessions(): Promise<string[]> {
    const rows = getDb()
        .prepare("SELECT session_id, MAX(timestamp) AS t FROM messages GROUP BY session_id ORDER BY t DESC")
        .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
}

function parseContent(raw: string): string | unknown[] {
    if (typeof raw !== "string") return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : raw;
    } catch {
        // 非 JSON → 纯文本，保持原样
        return raw;
    }
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
