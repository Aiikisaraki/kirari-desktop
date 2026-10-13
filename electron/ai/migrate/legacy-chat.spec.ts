// @vitest-environment node
//
// 旧版聊天记录 JSON → 数据库 的一次性迁移。
//
// 这组用例守的是一次真实事故：迁移最初只读 chat-session.json，
// 而 v0.5.1 起文件名就改成了 chat-session.local.json（远程模式另有 .remote.*），
// 结果从 v0.5.x～v0.7.x 升上来的用户聊天记录"凭空消失"且无任何日志。
// 后来还发现入库时丢了原始时间戳（saveMessage 的 INSERT 不写 timestamp 列）。
// 三条红线：文件名要全、时间戳要准、重复启动不能重复导入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyChatJson } from "./legacy-chat";
import * as db from "../db/storage";

// 与真实旧版一致的毫秒时间戳，间隔一小时 —— 一小时前的偏移足够被测出来
const T1 = Date.UTC(2026, 9, 8, 3, 4, 5);
const T2 = Date.UTC(2026, 9, 8, 4, 5, 6);

function legacyFile(sessionId: string, messages: unknown[]) {
    return { sessionId, messages, bubbleMessage: "在的", bubbleInteractive: false };
}

/** 造一条旧版消息。字段名必须是旧版的 author/text，不是 role/content。 */
function msg(author: string, text: string, timestamp: number, extra: Record<string, unknown> = {}) {
    return { id: `m-${text}`, author, text, timestamp, emotion: null, ...extra };
}

describe("旧版聊天记录迁移", () => {
    let dataDir: string;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-legacy-"));
        db.initDatabase(path.join(dataDir, "pet_sessions.db"));
    });

    afterEach(() => {
        db.closeDatabase();
    });

    function allRows() {
        return db
            .getDb()
            .prepare(
                "SELECT session_id, role, content, timestamp, emotion, images_json FROM messages ORDER BY id ASC",
            )
            .all() as Record<string, string | null>[];
    }

    it("读得到 v0.5.1 起的 chat-session.local.json（历史上漏的就是这个）", async () => {
        fs.writeFileSync(
            path.join(dataDir, "chat-session.local.json"),
            JSON.stringify(
                legacyFile("sess-local", [
                    msg("user", "旧版本地的第一条", T1),
                    msg("pet", "旧版本地的回复", T2),
                ]),
            ),
        );

        await migrateLegacyChatJson(dataDir);

        const rows = allRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.session_id)).toEqual(["sess-local", "sess-local"]);
    });

    it("保留原始毫秒时间戳，不压成「迁移那一秒」", async () => {
        fs.writeFileSync(
            path.join(dataDir, "chat-session.local.json"),
            JSON.stringify(
                legacyFile("sess-ts", [msg("user", "一问", T1), msg("pet", "一答", T2)]),
            ),
        );

        await migrateLegacyChatJson(dataDir);

        // SQLite 存 UTC 文本；storage.ts 的 toEpochMs 按 UTC 反解，两边必须严格互逆
        expect(allRows().map((r) => r.timestamp)).toEqual([
            "2026-10-08 03:04:05",
            "2026-10-08 04:05:06",
        ]);
        // 反解回毫秒应与原始值一致（证明格式与读取端匹配）
        const back = allRows().map((r) => Date.parse(`${String(r.timestamp).replace(" ", "T")}Z`));
        expect(back).toEqual([T1, T2]);
    });

    it("情绪与图片一并带过去，author=pet 落成 assistant", async () => {
        fs.writeFileSync(
            path.join(dataDir, "chat-session.local.json"),
            JSON.stringify(
                legacyFile("sess-emotion", [
                    msg("pet", "带图带情绪", T1, {
                        emotion: "happy",
                        images: ["data:image/png;base64,AAAA"],
                    }),
                ]),
            ),
        );

        await migrateLegacyChatJson(dataDir);

        const [r] = allRows();
        expect(r.role).toBe("assistant");
        expect(r.emotion).toBe("happy");
        expect(r.images_json).toBe('["data:image/png;base64,AAAA"]');
    });

    it("远程模式命名 chat-session.remote.<hash>.<uid>.json 也导入", async () => {
        fs.writeFileSync(
            path.join(dataDir, "chat-session.remote.abc123def456.1.json"),
            JSON.stringify(legacyFile("sess-remote", [msg("user", "远程记录", T1)])),
        );

        await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(1);
        expect(allRows()[0].session_id).toBe("sess-remote");
    });

    it(".bak 不被读入（那是已导进库的同一批数据，误读就是重复）", async () => {
        fs.writeFileSync(
            path.join(dataDir, "chat-session.json.migrated-123.bak"),
            JSON.stringify(legacyFile("sess-bak", [msg("user", "备份里的", T1)])),
        );

        await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(0);
        // 备份文件本身不该被动
        expect(fs.existsSync(path.join(dataDir, "chat-session.json.migrated-123.bak"))).toBe(true);
    });

    it("导入成功后删掉源文件", async () => {
        const p = path.join(dataDir, "chat-session.local.json");
        fs.writeFileSync(p, JSON.stringify(legacyFile("sess-del", [msg("user", "删我", T1)])));

        await migrateLegacyChatJson(dataDir);

        expect(fs.existsSync(p)).toBe(false);
    });

    it("重复启动不会重复导入（幂等键生效，源文件被放回来也一样）", async () => {
        const p = path.join(dataDir, "chat-session.local.json");
        const payload = JSON.stringify(legacyFile("sess-idem", [msg("user", "只应有一条", T1)]));
        fs.writeFileSync(p, payload);

        await migrateLegacyChatJson(dataDir);
        expect(allRows()).toHaveLength(1);

        // 源文件已删；模拟用户手工放回来，或删了 DB 迁移键以外的各种情况
        fs.writeFileSync(p, payload);
        const second = await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(1);
        expect(second[0]?.skipped).toBe("already-migrated");
        // 有键就不再留着源文件
        expect(fs.existsSync(p)).toBe(false);
    });

    it("库里已有该会话记录时不重复导入", async () => {
        await db.saveMessage("sess-dup", "user", "库里已有");
        fs.writeFileSync(
            path.join(dataDir, "chat-session.local.json"),
            JSON.stringify(legacyFile("sess-dup", [msg("user", "旧文件里的", T1)])),
        );

        await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(1);
        expect(allRows()[0].content).toBe("库里已有");
    });

    it("损坏文件被保留，且不影响其它文件正常导入", async () => {
        fs.writeFileSync(path.join(dataDir, "chat-session.remote.corrupt.json"), "{ 这不是 JSON", "utf-8");
        fs.writeFileSync(
            path.join(dataDir, "chat-session.local.json"),
            JSON.stringify(legacyFile("sess-ok", [msg("user", "好的", T1)])),
        );

        await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(1);
        expect(allRows()[0].session_id).toBe("sess-ok");
        expect(fs.existsSync(path.join(dataDir, "chat-session.remote.corrupt.json"))).toBe(true);
    });

    it("空消息列表的文件会被清理，不会每次启动都重扫", async () => {
        const p = path.join(dataDir, "chat-session.local.json");
        fs.writeFileSync(p, JSON.stringify(legacyFile("sess-empty", [])));

        await migrateLegacyChatJson(dataDir);

        expect(allRows()).toHaveLength(0);
        expect(fs.existsSync(p)).toBe(false);
    });

    it("新装机器（没有任何旧文件）安静返回", async () => {
        expect(await migrateLegacyChatJson(dataDir)).toEqual([]);
        expect(allRows()).toHaveLength(0);
    });
});