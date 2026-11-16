// @vitest-environment node
//
// 桌宠端事件流接入的验收。与 kirari-agent 包内单测的分工：
//   - 包内单测：纯逻辑（投影 / inject / recorder）
//   - 这里：两端适配器是否真的把事件写进同一个 pet_sessions.db，
//     且写完后能从磁盘重新读出来逐字重建 —— 也就是阶段 A 的硬指标。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    SESSION_EVENTS_COLUMNS,
    SCHEMA_VERSION,
    createInjector,
    buildSystemContent,
    concatInjects,
    deriveModelMessages,
    deriveSystemContentFromInjects,
    deriveUiMessages,
} from "kirari-agent";
import type { AgentEvent } from "kirari-agent";

import * as storage from "../db/storage";
import { eventStore } from "./store";
import { recorder } from "./recorder";

describe("桌宠端 session_events 接入", () => {
    let dataDir: string;
    let dbPath: string;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-agent-events-"));
        dbPath = path.join(dataDir, "pet_sessions.db");
        // 与真实启动一致：initEngine → initDatabase 先跑，事件适配器复用这份连接。
        storage.initDatabase(dbPath);
        // 记录器是进程内单例，每个用例从干净队列开始：先禁用清空残留，再启用。
        recorder.setEnabled(false);
        recorder.setEnabled(true);
    });

    afterEach(async () => {
        // 先 flush 清空队列再关库，避免 beforeExit 兜底 flush 时
        // closeDatabase 之后重新 getDb() 用兜底路径多建一个库。
        await recorder.flush();
        storage.closeDatabase();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("initDatabase 建出 session_events 表且列齐全", () => {
        const cols = (storage.getDb().prepare("PRAGMA table_info(session_events)").all() as { name: string }[]).map(
            (c) => c.name,
        );
        for (const col of SESSION_EVENTS_COLUMNS) expect(cols).toContain(col.name);
        expect(cols).toContain("seq");
    });

    it("saveMessage 旁路记录消息事件，UI 历史读回逐字不变", async () => {
        await storage.saveMessage("s1", "user", "你好", { emotion: "happy" });
        await storage.saveMessage("s1", "assistant", "我在", { images: ["data:image/png;base64,AAA"] });
        await recorder.flush();

        const events = eventStore.query({ sessionId: "s1" });
        expect(events.map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
        expect(events.every((e) => e.origin === "desktop")).toBe(true);
        expect(events[0].payload).toMatchObject({ role: "user", content: "你好" });

        // 原有 SQL 一字不动：界面读回的形状和内容保持行为等价。
        const ui = await storage.getSessionMessages("s1");
        expect(ui.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(ui[0].content).toBe("你好");
        expect(ui[0].emotion).toBe("happy");
        expect(ui[1].images).toEqual(["data:image/png;base64,AAA"]);

        // seq 由 SQLite AUTOINCREMENT 分配，跨进程严格单调。
        expect(events[1].seq!).toBeGreaterThan(events[0].seq!);
    });

    it("clearSession 只记 tombstone，事件流自身不删不改", async () => {
        await storage.saveMessage("s1", "user", "A");
        await recorder.flush();
        const before = eventStore.query({ sessionId: "s1" }).length;

        await storage.clearSession("s1");
        await recorder.flush();

        const events = eventStore.query({ sessionId: "s1" });
        expect(events.map((e) => e.type)).toEqual(["user_message", "session_cleared"]);
        expect(events.length).toBe(before + 1);
        // messages 表被清空，但事件流仍能审计；投影据此把 UI 历史截断为空。
        expect((await storage.getSessionMessages("s1")).length).toBe(0);
        expect(deriveUiMessages(events, { sessionId: "s1" })).toEqual([]);
    });

    it("mergeSessions 记 messages_merged，旧会话消息事件归属到目标会话", async () => {
        await storage.saveMessage("from", "user", "A");
        await storage.saveMessage("into", "user", "B");
        await recorder.flush();

        const moved = await storage.mergeSessions(["from"], "into");
        await recorder.flush();
        expect(moved).toBe(1);

        // 合并事件本身写在 into 会话；旧消息事件的 session_id 仍是 from，
        // 投影靠 messages_merged 的 alias 把 A 归到 into。
        const fromEvents = eventStore.query({ sessionId: "from" });
        const intoEvents = eventStore.query({ sessionId: "into" });
        expect(intoEvents.some((e) => e.type === "messages_merged")).toBe(true);
        const all = [...fromEvents, ...intoEvents].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        expect(deriveUiMessages(all, { sessionId: "into" }).map((m) => m.content)).toEqual(["A", "B"]);
    });

    it("eventStore.append 对 (origin, event_id) 幂等", () => {
        const evt: AgentEvent = {
            schemaVersion: SCHEMA_VERSION,
            origin: "desktop",
            eventId: "dup-1",
            sessionId: "s1",
            turnId: "t1",
            ts: 1,
            type: "turn_start",
            payload: {},
        };
        eventStore.append([evt]);
        eventStore.append([evt]); // 模拟批量 flush 重试
        const events = eventStore.query({ sessionId: "s1" });
        expect(events.length).toBe(1);
        expect(eventStore.maxSeq("s1")).toBe(events[0].seq);
    });

    it("模拟杀进程重启：从 session_events 逐字重建发给模型的 messages", () => {
        // 多模态 content 也要能逐字还原，不能只测纯文本。
        const sent = [
            { role: "system", content: "S\n\nD\n\nK" },
            {
                role: "user",
                content: [
                    { type: "text", text: "带图" },
                    { type: "image_url", image_url: { url: "https://example.com/y.png" } },
                ],
            },
        ];
        eventStore.append([
            {
                schemaVersion: SCHEMA_VERSION,
                origin: "desktop",
                eventId: "r0",
                sessionId: "s1",
                turnId: "t1",
                ts: 1,
                type: "turn_start",
                payload: {},
            },
            {
                schemaVersion: SCHEMA_VERSION,
                origin: "desktop",
                eventId: "r1",
                sessionId: "s1",
                turnId: "t1",
                ts: 2,
                type: "context_inject",
                payload: { source: "system.base", content: "S", order: 0, meta: {} },
            },
            {
                schemaVersion: SCHEMA_VERSION,
                origin: "desktop",
                eventId: "r2",
                sessionId: "s1",
                turnId: "t1",
                ts: 3,
                type: "request",
                payload: { round: 0, callSite: "main", messages: JSON.parse(JSON.stringify(sent)) },
            },
        ]);

        // 重启 = 只从磁盘重新读，不复用内存里的任何对象。
        const fromDisk = eventStore.query({ sessionId: "s1" });
        const restarted: AgentEvent[] = JSON.parse(JSON.stringify(fromDisk));
        expect(deriveModelMessages(restarted)).toEqual(sent);
        expect(deriveModelMessages(restarted, { turnId: "t1" })).toEqual(sent);
        // 非本轮 / 非主链路的 request 不进模型历史。
        expect(deriveModelMessages(restarted, { turnId: "other" })).toEqual([]);
    });

    it("四段 inject 拼接逐字等价，且 context_inject 事件可拼回同一 system", () => {
        const captured: AgentEvent[] = [];
        const injector = createInjector({
            origin: "desktop",
            sessionId: "s1",
            turnId: "t1",
            enqueue: (e) => {
                captured.push({
                    schemaVersion: SCHEMA_VERSION,
                    origin: e.origin,
                    eventId: `inj-${captured.length}`,
                    sessionId: e.sessionId,
                    turnId: e.turnId,
                    ts: captured.length,
                    type: e.type,
                    payload: e.payload,
                });
            },
        });
        const a = "SYSTEM";
        const b = "\n\n【今日背景】\nX";
        const c = "\n\n知识片段";
        const d = "\n\n# 技能\nY";
        injector.inject("system.base", a, { preflightInjected: [] });
        injector.inject("daily_brief", b, { failed: false });
        injector.inject("knowledge", c, { failed: false });
        injector.inject("skills", d, { skillCount: 1 });

        // 关键：段间绝不插入任何分隔符，必须与改造前的直接相加逐字一致。
        const joined = a + b + c + d;
        expect(buildSystemContent(injector.segments)).toBe(joined);
        expect(concatInjects(injector.segments)).toBe(joined);
        expect(deriveSystemContentFromInjects(captured, "t1")).toBe(joined);

        // 乱序注入仍按 source 的固定 order 拼接。
        expect(
            concatInjects([
                injector.segments[3],
                injector.segments[1],
                injector.segments[0],
                injector.segments[2],
            ]),
        ).toBe(joined);

        // 真实落库后再读回来拼，仍然一致（校验路径不是内存里的巧合）。
        eventStore.append(captured);
        const fromDisk = eventStore.query({ sessionId: "s1", types: ["context_inject"] });
        expect(deriveSystemContentFromInjects(fromDisk, "t1")).toBe(joined);
    });
});
