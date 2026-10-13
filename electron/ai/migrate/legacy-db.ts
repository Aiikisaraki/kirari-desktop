// electron/ai/migrate/legacy-db.ts
// 一次性迁移：旧库 kirari.db → pet_sessions.db。
//
// 为什么改库名：桌宠版原来用 kirari.db，核心版用 pet_sessions.db，两边各存一份
// 聊天记录，用户在上一个版本里聊的内容另一个版本看不到（用户拍板：记录要互通）。
// 表结构基本一致（messages / bot_locations / daily_memory），所以直接搬行即可。
//
// 与 legacy-chat.ts 是同一套策略（那边是 JSON，这边是旧 SQLite 库）：
//   · 幂等键写在 settings_kv，且与数据在**同一事务**提交；
//   · 事务提交后才删源文件，删失败只提示；
//   · 任一步失败整体回滚，源文件原地保留，绝不阻断启动；
//   · 所有异常都被 catch 住 —— 迁移出问题顶多是看不到旧记录，绝不能连带打不开桌宠。
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import * as storage from "../db/storage";

/**
 * 目标库需要的建表语句。
 *
 * 为什么在这里手工建：本模块用自己的连接打开目标库（要在事务里显式控制提交时机），
 * 不走 storage.ts 的 initDatabase/SCHEMA。表结构与 storage.ts 的 SCHEMA 保持一致 ——
 * 其中 settings_kv 是存幂等键用的，两处都要有。
 */
const TARGET_SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    emotion TEXT, images_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
  CREATE TABLE IF NOT EXISTS bot_locations (
    owner_uid INTEGER NOT NULL, scope TEXT NOT NULL,
    location TEXT, location_raw TEXT, location_name TEXT, location_admin1 TEXT,
    location_country TEXT, location_country_code TEXT,
    latitude REAL, longitude REAL, location_source TEXT,
    location_timezone TEXT, location_asked_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_uid, scope)
  );
  CREATE TABLE IF NOT EXISTS daily_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userid INTEGER NOT NULL, date TEXT NOT NULL,
    brief_text TEXT NOT NULL, topics_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userid, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_memory_user_date ON daily_memory(userid, date);
  CREATE TABLE IF NOT EXISTS settings_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** 幂等键前缀。最终键 = 前缀 + 源文件名。 */
const KV_PREFIX = "legacy-db:";

export type LegacyDbMigrationResult = {
    imported: number;
    skippedSessions: number;
    locations: number;
    briefs: number;
    removed: boolean;
    skipped: "already-migrated" | "no-source" | "nothing-to-do";
};

/**
 * 执行旧库迁移。必须在旧 JSON 迁移**之后**调用 ——
 * 旧库里的内容是被裁剪过的纯文本，而 JSON 那份带图片和情绪，数据更全，
 * 顺序反了会被纯文本版本先占位、把完整的挡掉。
 */
export function migrateLegacyChatDb(userDataDir: string): LegacyDbMigrationResult | null {
    const legacy = path.join(userDataDir, "kirari.db");
    const target = path.join(userDataDir, "pet_sessions.db");
    const kvKey = KV_PREFIX + path.basename(legacy);

    try {
        if (!fs.existsSync(legacy)) return { imported: 0, skippedSessions: 0, locations: 0, briefs: 0, removed: false, skipped: "no-source" };

        // 幂等：键已写入说明迁过了 —— 无论源文件后来是删了、被改名还是被用户放回来
        if (storage.getSetting(kvKey) !== null) {
            fs.unlinkSync(legacy);
            console.log("[migrate] 旧库此前已迁移过，清掉残留文件");
            return { imported: 0, skippedSessions: 0, locations: 0, briefs: 0, removed: true, skipped: "already-migrated" };
        }

        const src = new Database(legacy, { readonly: true });
        const rows = src
            .prepare("SELECT session_id, role, content, timestamp FROM messages ORDER BY id ASC")
            .all() as { session_id: string; role: string; content: string; timestamp: string }[];
        const locations = src.prepare("SELECT * FROM bot_locations").all();
        const briefs = src.prepare("SELECT * FROM daily_memory").all();
        src.close();

        const dst = new Database(target);
        dst.pragma("busy_timeout = 5000");
        dst.exec(TARGET_SCHEMA);

        // 按会话跳过：目标里已有该会话的记录就不动它（刚从 JSON 迁过来的更全，
        // 用裁剪过的纯文本覆盖回去等于丢图片和情绪）
        const existingSessions = new Set(
            (dst.prepare("SELECT DISTINCT session_id FROM messages").all() as { session_id: string }[]).map(
                (r) => r.session_id,
            ),
        );
        const toInsert = rows.filter((r) => !existingSessions.has(r.session_id));
        const skippedSessions = existingSessions.size;

        const writeAll = dst.transaction(() => {
            if (toInsert.length) {
                const insertMsg = dst.prepare(
                    "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                );
                for (const r of toInsert) insertMsg.run(r.session_id, r.role, r.content, r.timestamp);
            }
            if (locations.length) {
                const insertLoc = dst.prepare(
                    "INSERT OR REPLACE INTO bot_locations (owner_uid, scope, location, location_raw, location_name, location_admin1, location_country, location_country_code, latitude, longitude, location_source, location_timezone, location_asked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                );
                for (const l of locations as Record<string, unknown>[]) {
                    insertLoc.run(
                        l.owner_uid, l.scope, l.location, l.location_raw ?? null, l.location_name ?? null,
                        l.location_admin1 ?? null, l.location_country ?? null, l.location_country_code ?? null,
                        l.latitude ?? null, l.longitude ?? null, l.location_source ?? null,
                        l.location_timezone ?? null, l.location_asked_at ?? null, l.updated_at ?? null,
                    );
                }
            }
            if (briefs.length) {
                const insertBrief = dst.prepare(
                    "INSERT OR REPLACE INTO daily_memory (userid, date, brief_text, topics_json, created_at) VALUES (?, ?, ?, ?, ?)",
                );
                for (const b of briefs as Record<string, unknown>[]) {
                    insertBrief.run(b.userid, b.date, b.brief_text, b.topics_json ?? null, b.created_at ?? null);
                }
            }
            // 幂等键与数据同事务落库：不存在「数据搬了一半但键已写」的中间态
            dst.prepare("INSERT INTO settings_kv (key, value) VALUES (?, ?)").run(kvKey, new Date().toISOString());
        });
        writeAll();
        dst.close();

        // 事务提交后才删源文件。删失败只提示 —— 键已写入，下次启动不会重复导入。
        let removed = false;
        try {
            fs.unlinkSync(legacy);
            removed = true;
        } catch (e) {
            console.warn("[migrate] 旧库已迁入数据库，但删除源文件失败（不影响使用）:", (e as Error)?.message || e);
        }
        console.log(
            `[migrate] 旧库迁移完成：补入 ${toInsert.length} 条对话（跳过 ${skippedSessions} 个已存在的会话）、${locations.length} 条位置、${briefs.length} 份简报${removed ? "；旧库已清理" : ""}`,
        );
        return {
            imported: toInsert.length,
            skippedSessions,
            locations: locations.length,
            briefs: briefs.length,
            removed,
            skipped: "nothing-to-do",
        };
    } catch (e) {
        // 迁移失败绝不能阻断启动：旧库原地留着，用户顶多是看不到旧记录，但不会丢数据
        console.warn("[migrate] 旧库迁移失败（不影响启动，旧库已保留）:", (e as Error)?.message || e);
        return null;
    }
}