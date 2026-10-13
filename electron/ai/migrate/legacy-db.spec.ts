// @vitest-environment node
//
// 旧库 kirari.db → pet_sessions.db 的一次性迁移。
//
// 守的是三件事：数据搬全（含位置与每日简报）、按会话跳过不覆盖、重复启动不重复搬。
// 与 legacy-chat.spec.ts 是同一套策略的另一半，两边必须行为一致。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyChatDb } from "./legacy-db";
import * as storage from "../db/storage";

/** 造一个旧版 kirari.db（表结构与 0.7.x 一致，没有 emotion / images_json 列）。 */
function makeLegacyDb(p: string, msgs: { session_id: string; role: string; content: string; timestamp: string }[], opts?: { locations?: unknown[]; briefs?: unknown[] }) {
    const db = new Database(p);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE bot_locations (
        owner_uid INTEGER NOT NULL, scope TEXT NOT NULL,
        location TEXT, location_raw TEXT, location_name TEXT, location_admin1 TEXT,
        location_country TEXT, location_country_code TEXT,
        latitude REAL, longitude REAL, location_source TEXT,
        location_timezone TEXT, location_asked_at TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_uid, scope)
      );
      CREATE TABLE daily_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, userid INTEGER NOT NULL, date TEXT NOT NULL,
        brief_text TEXT NOT NULL, topics_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(userid, date)
      );
    `);
    const ins = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
    for (const m of msgs) ins.run(m.session_id, m.role, m.content, m.timestamp);
    if (opts?.locations?.length) {
        const loc = db.prepare(
            "INSERT INTO bot_locations (owner_uid, scope, location, location_name, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const l of opts.locations as Record<string, unknown>[]) {
            loc.run(l.owner_uid, l.scope, l.location, l.location_name, l.latitude, l.longitude);
        }
    }
    if (opts?.briefs?.length) {
        const b = db.prepare("INSERT INTO daily_memory (userid, date, brief_text) VALUES (?, ?, ?)");
        for (const x of opts.briefs as Record<string, unknown>[]) b.run(x.userid, x.date, x.brief_text);
    }
    db.close();
}

describe("旧库 kirari.db 迁移", () => {
    let dataDir: string;
    let legacyPath: string;
    let targetPath: string;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-db-migrate-"));
        legacyPath = path.join(dataDir, "kirari.db");
        targetPath = path.join(dataDir, "pet_sessions.db");
        // 目标库先由主进程开好（真实启动时 initEngine 已先跑过）
        storage.initDatabase(targetPath);
    });

    afterEach(() => {
        storage.closeDatabase();
    });

    function targetRows() {
        const db = new Database(targetPath, { readonly: true });
        const rows = db.prepare("SELECT session_id, role, content, timestamp FROM messages ORDER BY id ASC").all();
        db.close();
        return rows as Record<string, string>[];
    }

    it("搬入对话并保留原始时间戳", () => {
        makeLegacyDb(legacyPath, [
            { session_id: "s1", role: "user", content: "旧库的一问", timestamp: "2026-10-01 10:00:00" },
            { session_id: "s1", role: "assistant", content: "旧库的一答", timestamp: "2026-10-01 10:00:05" },
        ]);

        const r = migrateLegacyChatDb(dataDir);

        expect(r?.imported).toBe(2);
        expect(targetRows().map((x) => x.timestamp)).toEqual(["2026-10-01 10:00:00", "2026-10-01 10:00:05"]);
        // 迁完删源文件
        expect(fs.existsSync(legacyPath)).toBe(false);
    });

    it("位置与每日简报一并搬入", () => {
        makeLegacyDb(legacyPath, [{ session_id: "s1", role: "user", content: "在哪", timestamp: "2026-10-01 10:00:00" }], {
            locations: [{ owner_uid: 1, scope: "local", location: "江苏省常州市", location_name: "常州", latitude: 31.8, longitude: 119.9 }],
            briefs: [{ userid: 1, date: "2026-10-01", brief_text: "今天问了我天气" }],
        });

        migrateLegacyChatDb(dataDir);

        const db = new Database(targetPath, { readonly: true });
        expect((db.prepare("SELECT location FROM bot_locations WHERE scope = 'local'").get() as { location: string }).location).toBe("江苏省常州市");
        expect((db.prepare("SELECT brief_text FROM daily_memory WHERE date = '2026-10-01'").get() as { brief_text: string }).brief_text).toBe("今天问了我天气");
        db.close();
    });

    it("目标库已有该会话时不覆盖（刚从 JSON 迁过来的更全）", async () => {
        // 模拟 legacy-chat 先迁过：同一个 session_id 已在库里，且带图片
        await storage.saveMessage("s1", "user", "库里已有的完整版", { images: ["data:image/png;base64,AAAA"] });
        makeLegacyDb(legacyPath, [
            { session_id: "s1", role: "user", content: "旧库的纯文本版", timestamp: "2026-10-01 10:00:00" },
        ]);

        const r = migrateLegacyChatDb(dataDir);

        expect(r?.imported).toBe(0);
        expect(r?.skippedSessions).toBe(1);
        const rows = targetRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe("库里已有的完整版");
    });

    it("重复启动不重复搬（旧库被放回来也一样）", () => {
        makeLegacyDb(legacyPath, [{ session_id: "s1", role: "user", content: "只应有一条", timestamp: "2026-10-01 10:00:00" }]);

        migrateLegacyChatDb(dataDir);
        expect(targetRows()).toHaveLength(1);

        // 模拟用户手工放回旧库
        makeLegacyDb(legacyPath, [{ session_id: "s1", role: "user", content: "只应有一条", timestamp: "2026-10-01 10:00:00" }]);
        const second = migrateLegacyChatDb(dataDir);

        expect(second?.skipped).toBe("already-migrated");
        expect(targetRows()).toHaveLength(1);
        // 有键就不再留着源文件
        expect(fs.existsSync(legacyPath)).toBe(false);
    });

    it("空旧库被清理并记幂等键", () => {
        makeLegacyDb(legacyPath, []);

        migrateLegacyChatDb(dataDir);

        expect(fs.existsSync(legacyPath)).toBe(false);
        expect(storage.getSetting("legacy-db:kirari.db")).not.toBeNull();
    });

    it("新装机器（没有旧库）安静返回", () => {
        expect(migrateLegacyChatDb(dataDir)?.skipped).toBe("no-source");
    });

    it("旧库损坏时不阻断、也不删源文件", () => {
        // 造一个不是 SQLite 的文件
        fs.writeFileSync(legacyPath, "这不是数据库", "utf-8");

        const r = migrateLegacyChatDb(dataDir);

        expect(r).toBeNull();
        // 源文件必须留着 —— 出错时用户至少还能自己抢救
        expect(fs.existsSync(legacyPath)).toBe(true);
    });
});