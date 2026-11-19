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
// 事件流 / 任务 / 定时任务 schema 由平级共享包 kirari-agent 定义，两端各自执行同一份 DDL，
// 保证同一份 pet_sessions.db 里的 session_events / tasks / scheduled_jobs 不分叉。
import {
    SESSION_EVENTS_DDL, SESSION_EVENTS_COLUMNS,
    TASKS_DDL, TASKS_COLUMNS,
    SCHEDULED_JOBS_DDL, SCHEDULED_JOBS_COLUMNS,
} from "kirari-agent";

type DB = Database.Database;

let db: DB | null = null;
let dbPathUsed = "";

/** 本机主人位置记录使用的 scope（机器人客人用群号/QQ号，见会话映射） */
export const LOCAL_SCOPE = "local";
/** 本机主人的固定 uid（桌宠单机形态下只有一个使用者） */
export const LOCAL_UID = 1;

function fallbackPath(): string {
    // 主进程未显式注入时的兜底：与主进程同一份数据根布局（~/.kirari/database/pet_sessions.db）。
    return path.join(os.homedir(), ".kirari", "database", "pet_sessions.db");
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
    migrateMemoryColumns();
    ensureSessionEventsSchema();
    ensureTaskSchemas();
    return db;
}

/**
 * memories 表的老库补列：about_person 是「这条记忆关于谁」，与 subject 正交。
 *
 * 为什么必须补：核心版和桌宠版共用一个 pet_sessions.db。任一端先把 memories
 * 表建成旧结构（没有 about_person），另一端再查就会报 no such column。
 * 幂等：先查 PRAGMA 再加（SQLite 的 ADD COLUMN 没有 IF NOT EXISTS）。
 */
function migrateMemoryColumns(): void {
    if (!db) return;
    const cols = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) return; // 表还不存在（由 SCHEMA 建，含该列）
    if (!cols.includes("about_person")) db.exec("ALTER TABLE memories ADD COLUMN about_person TEXT");
    // 索引放在补列之后建，两种结构都能成功
    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_about ON memories(about_person, deleted)");
}

/**
 * messages 表的 UI 扩展列（emotion / images_json）。
 *
 * 为什么加：这张表现在是**聊天界面的 UI 投影缓存**（真源是 session_events 事件流），
 * 界面要显示情绪动画标签和图片，而内核上下文只需要 role + content ——
 * 两类需求共用一列 content 会互相污染，所以单开两列。
 * 核心版读历史时原样带回，两端记录完全互通。
 */
function migrateUiColumns(): void {
    if (!db) return;
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("emotion")) db.exec("ALTER TABLE messages ADD COLUMN emotion TEXT");
    if (!cols.includes("images_json")) db.exec("ALTER TABLE messages ADD COLUMN images_json TEXT");
}

/**
 * 事件流真源表。DDL 文本来自 kirari-agent，两端各自执行同一份，
 * 保证同一份 pet_sessions.db 里的 session_events 不分叉；补列清单也由包导出，
 * 未来加列只改包里一处，两端不会分叉。
 *
 * seq 用 AUTOINCREMENT：两个进程直写同一个文件，应用层各自维护 seq 必然冲突，
 * SQLite 文件锁分配的 rowid 才是跨进程全局唯一且单调的因果序。
 */
function ensureSessionEventsSchema(): void {
    if (!db) return;
    db.exec(SESSION_EVENTS_DDL);
    const cols = (db.prepare("PRAGMA table_info(session_events)").all() as { name: string }[]).map((c) => c.name);
    for (const col of SESSION_EVENTS_COLUMNS) {
        if (!cols.includes(col.name)) db.exec(`ALTER TABLE session_events ADD COLUMN ${col.ddl}`);
    }
}

/** 阶段 C：tasks / scheduled_jobs 表，DDL 与补列清单均来自共享包，与核心版同源。 */
function ensureTaskSchemas(): void {
    if (!db) return;
    db.exec(TASKS_DDL);
    const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    for (const col of TASKS_COLUMNS) {
        if (!taskCols.includes(col.name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col.ddl}`);
    }
    db.exec(SCHEDULED_JOBS_DDL);
    const jobCols = (db.prepare("PRAGMA table_info(scheduled_jobs)").all() as { name: string }[]).map((c) => c.name);
    for (const col of SCHEDULED_JOBS_COLUMNS) {
        if (!jobCols.includes(col.name)) db.exec(`ALTER TABLE scheduled_jobs ADD COLUMN ${col.ddl}`);
    }
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

  -- ── 长期记忆（与核心版 src/db/dbStorage.js 的 memories 表逐列一致）──────
  -- 记忆不能挂在 session_id 上，否则新开一个对话她就像不认识你。改为按 subject
  -- 分层 + visibility 控制跨场合可见性，两个维度都由本表字段表达。
  -- subject：person::{key}（每个对话者独立池）/ self::{uid} / scene::{scope} / global
  -- about_person：这条内容说的是谁（A 转述 B 的事时，池子在 A、内容关于 B）
  -- visibility：public（任何场合可提）/ private（仅私下）/ secret（仅当事人本人）
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    origin_session TEXT,
    about_person TEXT,
    source TEXT NOT NULL DEFAULT 'owner',
    importance INTEGER NOT NULL DEFAULT 3,
    hits INTEGER NOT NULL DEFAULT 0,
    last_hit_at DATETIME,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject, deleted);
  CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, deleted);
  -- 注意：about_person 的索引不在这里建。老库的 memories 表可能是没有该列的旧结构，
  -- 上面的 CREATE TABLE IF NOT EXISTS 对它是空操作，紧接着建该列的索引会直接报
  -- "no such column: about_person" 把整个 initDatabase 打断。统一放到
  -- migrateMemoryColumns() 里，补完列再建索引。

  -- ── 人（每个对话者一份稳定档案）────────────────────────────────────
  -- 身份不是「主人 / 客人」二元。每个跟她说过话的人都在这里有自己的一条记录，
  -- 各自有独立的记忆池。role 只表达**管理权限**（谁能改她的设置、看她的内部状态），
  -- 不决定她记得谁、也不决定记忆给谁看。
  CREATE TABLE IF NOT EXISTS people (
    person_key TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'user',
    display_name TEXT,
    platform TEXT,
    alias TEXT,
    notes TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ── 记忆关联（联想网络）────────────────────────────────────────────
  -- 「这些记忆可以随着人际关系的拓展而产生互相关联」：
  --   (person:1001) --knows--> (person:2002)  A 和 B 认识
  --   (memories:12)  --about--> (person:1001) 这条记忆是关于 A 的
  CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related',
    weight INTEGER NOT NULL DEFAULT 3,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(a, b, relation)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_links_a ON memory_links(a, relation);
  CREATE INDEX IF NOT EXISTS idx_memory_links_b ON memory_links(b, relation);

  -- 轻量键值对（与核心版 dbStorage.js 同名同结构）。
  -- 当前用途：记「旧版聊天记录已迁移」这类一次性动作的完成凭据 —— 迁移成功后写入键，
  -- 之后无论源文件还在不在（已被删 / 被改名 / 用户手工放回来）都不会重复导入。
  CREATE TABLE IF NOT EXISTS settings_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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
 * 这张表现在是 UI 投影缓存（真源是 session_events 事件流），所以这个值同时是
 * 「界面能翻回多早」的界限。500 条足够日常使用又不至于让单文件无限膨胀；
 * 上下文窗口与此无关（由 getRecentMessages 按需取最近几条），存得久不等于喂给模型的多。
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
    // 事件流旁路记录真源；原有 SQL 一字不动。
    // 动态 import 避开 storage → recorder → store → storage 的顶层循环
    // （与核心版惰性 require 同构）。
    try {
        const { recorder, currentTurnId } = await import("../events/recorder");
        recorder.enqueue({
            origin: "desktop",
            sessionId,
            turnId: currentTurnId(),
            type: role === "user" ? "user_message" : "assistant_message",
            payload: { role, content, extras: extras || undefined },
        });
    } catch (e) {
        // 红线：事件写失败只警告，绝不冒泡到用户、绝不打断存消息。
        console.warn("[events] 记录消息事件失败（已忽略）:", (e as Error)?.message || e);
    }
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
        // 只记审计信息：这里拿到的是 messages 表的 id，与事件流 seq 不是同一个编号空间，
        // 不能拿来给投影器当 keptFromSeq 用。投影器自己按 UI_HISTORY_LIMIT 收口。
        try {
            const { recorder, currentTurnId } = await import("../events/recorder");
            recorder.enqueue({
                origin: "desktop",
                sessionId,
                turnId: currentTurnId(),
                type: "messages_pruned",
                payload: {
                    droppedCount: ids.length - MAX_MESSAGES_PER_SESSION,
                    remaining: MAX_MESSAGES_PER_SESSION,
                },
            });
            void recorder.flush();
        } catch (e) {
            console.warn("[events] 记录裁剪事件失败（已忽略）:", (e as Error)?.message || e);
        }
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
    // 事件流不删自身，只记 tombstone：投影据此截断 UI 缓存，历史仍可审计。
    try {
        const { recorder, currentTurnId } = await import("../events/recorder");
        recorder.enqueue({
            origin: "desktop",
            sessionId,
            turnId: currentTurnId(),
            type: "session_cleared",
            payload: { reason: "clearSession" },
        });
        void recorder.flush();
    } catch (e) {
        console.warn("[events] 记录清空事件失败（已忽略）:", (e as Error)?.message || e);
    }
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
    // 事件里 session_id 保持原值不改，靠 messages_merged 表达「归属变了」。
    try {
        const { recorder, currentTurnId } = await import("../events/recorder");
        recorder.enqueue({
            origin: "desktop",
            sessionId: intoSessionId,
            turnId: currentTurnId(),
            type: "messages_merged",
            payload: { fromSessionIds: from, intoSessionId },
        });
        void recorder.flush();
    } catch (e) {
        console.warn("[events] 记录合并事件失败（已忽略）:", (e as Error)?.message || e);
    }
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

// ---------------------------------------------------------------- 长期记忆 DAO
// 与核心版 dbStorage 的同名方法语义一致（两端共库，列名相同）。只负责存取，
// 「该不该记 / 谁能看到」的判断在 ai/services/memory.ts。

export type MemoryRow = {
    id: number;
    subject: string;
    kind: string;
    content: string;
    visibility: string;
    originSession: string | null;
    aboutPerson: string | null;
    source: string;
    importance: number;
    hits: number;
    lastHitAt: string | null;
    createdAt: string;
    updatedAt: string;
};

type RawMemoryRow = {
    id: number;
    subject: string;
    kind: string;
    content: string;
    visibility: string;
    origin_session: string | null;
    about_person: string | null;
    source: string;
    importance: number;
    hits: number;
    last_hit_at: string | null;
    created_at: string;
    updated_at: string;
};

function mapMemoryRow(r: RawMemoryRow): MemoryRow {
    return {
        id: r.id,
        subject: r.subject,
        kind: r.kind,
        content: r.content,
        visibility: r.visibility,
        originSession: r.origin_session,
        aboutPerson: r.about_person || null,
        source: r.source,
        importance: r.importance,
        hits: r.hits,
        lastHitAt: r.last_hit_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export async function addMemory(row: {
    subject?: string;
    kind?: string;
    content: string;
    visibility?: string;
    originSession?: string | null;
    aboutPerson?: string | null;
    source?: string;
    importance?: number;
}): Promise<number | null> {
    const content = String(row.content || "").trim();
    if (!content) return null;
    const info = getDb()
        .prepare(
            `INSERT INTO memories (subject, kind, content, visibility, origin_session, about_person, source, importance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            String(row.subject || "global"),
            String(row.kind || "fact"),
            content.slice(0, 2000),
            ["public", "private", "secret"].includes(String(row.visibility)) ? String(row.visibility) : "private",
            row.originSession || null,
            row.aboutPerson || null,
            String(row.source || "owner"),
            Math.min(5, Math.max(1, Number(row.importance) || 3)),
        );
    return Number(info.lastInsertRowid);
}

export async function listMemories(
    subjects: string[],
    opts: { limit?: number; includeDeleted?: boolean } = {},
): Promise<MemoryRow[]> {
    const subs = (Array.isArray(subjects) ? subjects : [subjects]).filter(Boolean).map(String);
    if (!subs.length) return [];
    const ph = subs.map(() => "?").join(", ");
    const rows = getDb()
        .prepare(
            `SELECT * FROM memories WHERE subject IN (${ph}) ${opts.includeDeleted ? "" : "AND deleted = 0"}
             ORDER BY importance DESC, id DESC LIMIT ?`,
        )
        .all(...subs, Math.min(500, Math.max(1, Number(opts.limit) || 120))) as RawMemoryRow[];
    return rows.map(mapMemoryRow);
}

export async function findMemoryByContent(subject: string, content: string): Promise<MemoryRow | null> {    const row = getDb()
        .prepare("SELECT * FROM memories WHERE subject = ? AND deleted = 0 AND content = ? LIMIT 1")
        .get(String(subject), String(content || "").trim().slice(0, 2000)) as RawMemoryRow | undefined;
    return row ? mapMemoryRow(row) : null;
}

export async function updateMemory(
    id: number,
    patch: { content?: string; visibility?: string; importance?: number },
): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.content !== undefined) {
        const c = String(patch.content || "").trim();
        if (!c) return false;
        sets.push("content = ?");
        vals.push(c.slice(0, 2000));
    }
    if (patch.visibility !== undefined && ["public", "private", "secret"].includes(patch.visibility)) {
        sets.push("visibility = ?");
        vals.push(patch.visibility);
    }
    if (patch.importance !== undefined) {
        sets.push("importance = ?");
        vals.push(Math.min(5, Math.max(1, Number(patch.importance) || 3)));
    }
    if (!sets.length) return false;
    sets.push("updated_at = CURRENT_TIMESTAMP");
    vals.push(Number(id));
    const info = getDb().prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return info.changes > 0;
}

export async function deleteMemory(id: number): Promise<boolean> {
    const info = getDb()
        .prepare("UPDATE memories SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(Number(id));
    return info.changes > 0;
}

export async function deleteMemoriesBySubject(subject: string): Promise<number> {
    const info = getDb()
        .prepare("UPDATE memories SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE subject = ? AND deleted = 0")
        .run(String(subject));
    return info.changes;
}

export async function touchMemory(ids: number[]): Promise<number> {
    const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    if (!list.length) return 0;
    const stmt = getDb().prepare(
        "UPDATE memories SET hits = hits + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?",
    );
    let n = 0;
    for (const id of list) n += stmt.run(id).changes;
    return n;
}

export async function memoryStats(): Promise<{ total: number; bySubject: { subject: string; count: number }[] }> {
    const rows = getDb()
        .prepare("SELECT subject, COUNT(*) AS n FROM memories WHERE deleted = 0 GROUP BY subject ORDER BY n DESC LIMIT 200")
        .all() as { subject: string; n: number }[];
    const total = getDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted = 0").get() as { n: number } | undefined;
    return { total: total ? total.n : 0, bySubject: rows.map((r) => ({ subject: r.subject, count: r.n })) };
}

/** 按「这条记忆关于谁」取（跨 subject 池）。用于想起某个人相关的事。 */
export async function listMemoriesAbout(personKey: string, opts: { limit?: number } = {}): Promise<MemoryRow[]> {
    const k = String(personKey || "").trim();
    if (!k) return [];
    const rows = getDb()
        .prepare(
            `SELECT * FROM memories WHERE about_person = ? AND deleted = 0
             ORDER BY importance DESC, id DESC LIMIT ?`,
        )
        .all(k, Math.min(500, Math.max(1, Number(opts.limit) || 120))) as RawMemoryRow[];
    return rows.map(mapMemoryRow);
}

// ---------------------------------------------------------------- 人物档案（people）

export type PersonRow = {
    personKey: string;
    role: string;
    displayName: string | null;
    platform: string | null;
    alias: string | null;
    notes: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
};

function mapPersonRow(r: any): PersonRow {
    return {
        personKey: r.person_key,
        role: r.role,
        displayName: r.display_name,
        platform: r.platform,
        alias: r.alias,
        notes: r.notes,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
    };
}

/**
 * 建档/刷新。role 只表达管理权限，不影响记忆归属。
 * COALESCE 保护：新消息没带昵称时不要把已有昵称覆盖成空。
 */
export async function upsertPerson(row: {
    personKey?: string;
    role?: string;
    displayName?: string | null;
    platform?: string | null;
    alias?: string | null;
}): Promise<boolean> {
    const key = String(row.personKey || "").trim();
    if (!key) return false;
    getDb()
        .prepare(
            `INSERT INTO people (person_key, role, display_name, platform, alias)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(person_key) DO UPDATE SET
               display_name = COALESCE(excluded.display_name, people.display_name),
               platform     = COALESCE(excluded.platform, people.platform),
               role         = CASE WHEN excluded.role = 'owner' THEN 'owner' ELSE people.role END,
               last_seen_at = CURRENT_TIMESTAMP`,
        )
        .run(
            key,
            ["owner", "admin", "user"].includes(String(row.role)) ? String(row.role) : "user",
            row.displayName || null,
            row.platform || null,
            row.alias || null,
        );
    return true;
}

export async function getPerson(personKey: string): Promise<PersonRow | null> {
    const r = getDb().prepare("SELECT * FROM people WHERE person_key = ?").get(String(personKey || ""));
    return r ? mapPersonRow(r) : null;
}

export async function listPeople(limit = 200): Promise<PersonRow[]> {
    const rows = getDb()
        .prepare("SELECT * FROM people ORDER BY last_seen_at DESC LIMIT ?")
        .all(Math.min(500, Math.max(1, Number(limit) || 200))) as any[];
    return rows.map(mapPersonRow);
}

export async function setPersonRole(personKey: string, role: string): Promise<boolean> {
    if (!["owner", "admin", "user"].includes(role)) return false;
    return getDb().prepare("UPDATE people SET role = ? WHERE person_key = ?").run(role, String(personKey || "")).changes > 0;
}

export async function setPersonNotes(personKey: string, notes: string): Promise<boolean> {
    return (
        getDb()
            .prepare("UPDATE people SET notes = ? WHERE person_key = ?")
            .run(String(notes || "").slice(0, 2000), String(personKey || "")).changes > 0
    );
}

export async function setPersonAlias(personKey: string, alias: string): Promise<boolean> {
    return (
        getDb()
            .prepare("UPDATE people SET alias = ? WHERE person_key = ?")
            .run(String(alias || "").slice(0, 100), String(personKey || "")).changes > 0
    );
}

/** 谁是拥有者（管理权判定）。 */
export async function getOwnerKey(): Promise<string | null> {
    const r = getDb()
        .prepare("SELECT person_key FROM people WHERE role = 'owner' ORDER BY first_seen_at ASC LIMIT 1")
        .get() as { person_key: string } | undefined;
    return r ? r.person_key : null;
}

// ---------------------------------------------------------------- 记忆关联（memory_links）

export type LinkRow = { id: number; a: string; b: string; relation: string; weight: number; other: string };

/** 建立/更新关联。人—人、人—事、事—事都走这里。 */
export async function addLink(a: string, b: string, relation = "related", weight = 3): Promise<boolean> {
    const A = String(a || "").trim();
    const B = String(b || "").trim();
    if (!A || !B || A === B) return false;
    getDb()
        .prepare(
            `INSERT INTO memory_links (a, b, relation, weight) VALUES (?, ?, ?, ?)
             ON CONFLICT(a, b, relation) DO UPDATE SET weight = excluded.weight`,
        )
        .run(A, B, String(relation || "related"), Math.min(5, Math.max(1, Number(weight) || 3)));
    return true;
}

/** 取某个节点的关联网络（双向）。 */
export async function listLinks(node: string, relation: string | null = null): Promise<LinkRow[]> {
    const n = String(node || "").trim();
    if (!n) return [];
    const sql = relation
        ? "SELECT * FROM memory_links WHERE (a = ? OR b = ?) AND relation = ? ORDER BY weight DESC LIMIT 200"
        : "SELECT * FROM memory_links WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT 200";
    const args = relation ? [n, n, String(relation)] : [n, n];
    const rows = getDb().prepare(sql).all(...args) as any[];
    return rows.map((r) => ({
        id: r.id,
        a: r.a,
        b: r.b,
        relation: r.relation,
        weight: r.weight,
        other: r.a === n ? r.b : r.a,
    }));
}

export async function removeLink(a: string, b: string, relation = "related"): Promise<boolean> {
    return (
        getDb()
            .prepare("DELETE FROM memory_links WHERE a = ? AND b = ? AND relation = ?")
            .run(String(a || ""), String(b || ""), String(relation || "related")).changes > 0
    );
}

/**
 * 联想扩散：从起点出发沿 memory_links 走 1-2 跳。
 * 用于「A 和 B 是朋友，所以 B 的公开的事在 A 面前也能自然想起」。
 */
export async function expandLinks(
    nodes: string[],
    opts: { depth?: number; minWeight?: number } = {},
): Promise<LinkRow[]> {
    const seen = new Set((Array.isArray(nodes) ? nodes : []).map(String).filter(Boolean));
    if (!seen.size) return [];
    const depth = Math.min(2, Math.max(1, Number(opts.depth) || 1));
    const minWeight = opts.minWeight != null ? Number(opts.minWeight) : 1;
    let frontier = [...seen];
    const found: LinkRow[] = [];
    for (let d = 0; d < depth; d += 1) {
        const next: string[] = [];
        for (const node of frontier) {
            const links = await listLinks(node);
            for (const l of links) {
                if (l.weight < minWeight) continue;
                if (seen.has(l.other)) continue;
                seen.add(l.other);
                next.push(l.other);
                found.push(l);
            }
        }
        if (!next.length) break;
        frontier = next;
    }
    return found;
}

// ---------------------------------------------------------------- 工具函数

/** 遮蔽密钥，用于设置页展示（绝不回显完整值） */
export function maskToken(token: unknown): string {
    if (typeof token !== "string" || token.length <= 6) return "****";
    return `${token.slice(0, 3)}${"*".repeat(6)}${token.slice(-4)}`;
}

// ---------------------------------------------------------------- 轻量 KV

/**
 * 读一个 KV 值；键不存在返回 null。
 *
 * 用途：记「一次性动作已完成」的凭据（如旧版聊天记录迁移）。
 * 为什么放数据库而不是记一个标记文件：这份数据本来就只有一份，
 * 状态和数据放一起，删库即重来一次，不存在「标记文件和数据文件对不上」的中间态。
 */
export function getSetting(key: string): string | null {
    const row = getDb().prepare("SELECT value FROM settings_kv WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row ? row.value : null;
}

/** 写入一个 KV 值（同名覆盖）。 */
export function setSetting(key: string, value: string): void {
    getDb()
        .prepare("INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
}

/**
 * 阶段 E：抢占式写入（INSERT OR IGNORE）。返回 true=本次抢到，false=键已存在。
 * 用途：两端共库时给「同一档简报」加去重锁，只有一个进程真正去采集+压缩。
 */
export function claimSetting(key: string, value = "1"): boolean {
    const info = getDb().prepare("INSERT OR IGNORE INTO settings_kv (key, value) VALUES (?, ?)").run(key, value);
    return info.changes > 0;
}

/** 释放抢占（生成失败时回滚，让另一进程/下一轮还能补）。 */
export function releaseSetting(key: string): void {
    getDb().prepare("DELETE FROM settings_kv WHERE key = ?").run(key);
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

// ---------------------------------------------------------------- 阶段 C：tasks / scheduled_jobs
// 行级 CRUD：对象 ↔ 行的转换放在 events/taskStore.ts 与 events/jobStore.ts 适配器里；
// 这里只提供最小 SQL，与核心版 dbStorage.js 对称。

export type TaskRow = {
    task_id: string; session_id: string; turn_id: string; origin: string; uid: number;
    title: string; status: string; steps_json: string; current_step: number;
    created_at: number; updated_at: number; completed_at: number | null;
};
export type JobRow = {
    job_id: string; session_id: string; origin: string; uid: number;
    kind: string; title: string; payload: string; due_at: number; recurrence: string;
    status: string; created_at: number; updated_at: number; last_fired_at: number | null;
};

export function getTaskRow(taskId: string): TaskRow | undefined {
    return getDb().prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
}
export function saveTaskRow(row: TaskRow): void {
    getDb().prepare(`
        INSERT INTO tasks (task_id, session_id, turn_id, origin, uid, title, status, steps_json, current_step, created_at, updated_at, completed_at)
        VALUES (@task_id, @session_id, @turn_id, @origin, @uid, @title, @status, @steps_json, @current_step, @created_at, @updated_at, @completed_at)
        ON CONFLICT(task_id) DO UPDATE SET
            session_id=excluded.session_id, turn_id=excluded.turn_id, title=excluded.title,
            status=excluded.status, steps_json=excluded.steps_json, current_step=excluded.current_step,
            updated_at=excluded.updated_at, completed_at=excluded.completed_at
    `).run(row);
}
export function activeTaskRows(sessionId: string): TaskRow[] {
    return getDb().prepare(
        "SELECT * FROM tasks WHERE session_id = ? AND status IN ('pending','running') ORDER BY created_at ASC",
    ).all(sessionId) as TaskRow[];
}
export function listTaskRows(sessionId: string, limit: number): TaskRow[] {
    return getDb().prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as TaskRow[];
}
export function getJobRow(jobId: string): JobRow | undefined {
    return getDb().prepare("SELECT * FROM scheduled_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
}
export function saveJobRow(row: JobRow): void {
    getDb().prepare(`
        INSERT INTO scheduled_jobs (job_id, session_id, origin, uid, kind, title, payload, due_at, recurrence, status, created_at, updated_at, last_fired_at)
        VALUES (@job_id, @session_id, @origin, @uid, @kind, @title, @payload, @due_at, @recurrence, @status, @created_at, @updated_at, @last_fired_at)
        ON CONFLICT(job_id) DO UPDATE SET
            title=excluded.title, payload=excluded.payload, due_at=excluded.due_at,
            status=excluded.status, updated_at=excluded.updated_at, last_fired_at=excluded.last_fired_at
    `).run(row);
}
export function dueJobRows(now: number, limit: number): JobRow[] {
    return getDb().prepare(
        "SELECT * FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    ).all(now, limit) as JobRow[];
}
export function listJobRows(sessionId: string, limit: number): JobRow[] {
    return getDb().prepare("SELECT * FROM scheduled_jobs WHERE session_id = ? ORDER BY due_at DESC LIMIT ?").all(sessionId, limit) as JobRow[];
}
