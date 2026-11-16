// @vitest-environment node
//
// 与核心版改造后的冒烟对等：跑一轮 getReply，检查落到 session_events 的
// 事件序列是否与核心版完全一致（两端共享同一个内核的硬证据）。
//
// 只 mock 外部依赖（模型调用 / 检索 / 工具），db 层用真实实现 + 覆盖
// getRecentMessages —— 这样事件是真的写进 SQLite，不是内存假象。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../reply/parser", () => ({
    parseModelReply: (s: string) => ({ speech: s, emotion: null, images: [] }),
    isValidImageUrl: () => true,
}));
vi.mock("../reply/promptBuilder", () => ({
    buildBasePrompt: () => "BASE",
    buildSystemPrompts: () => ({
        normal: "SYS",
        withTools: "SYS {{TOOL_RESULTS}}",
        polish: "POLISH",
        locationSet: "LOC",
    }),
    getRequestTimeout: () => 60000,
    locationSetMessage: () => "OK",
    buildLocationSetRaw: () => "RAW",
    LOCATION_ASK_MESSAGE: "在哪",
    stripNonConversational: (x: unknown[]) => x,
}));
vi.mock("../reply/intent", () => ({
    preflightTools: async () => ({ injected: [], needLocation: false, direct: null, setLocation: null }),
    buildTools: () => [],
    detectCorrectionIntent: () => false,
}));
vi.mock("../reply/streaming", () => ({
    streamChatCompletion: async (_client: unknown, params: { messages?: unknown[] }) => {
        // 逐字快照：验证脚本不能直接持有 params.messages 引用（后续会被 push 改掉）。
        (globalThis as Record<string, unknown>).__sent = JSON.parse(JSON.stringify(params.messages));
        return {
            choices: [{ message: { role: "assistant", content: "回复" }, finish_reason: "stop" }],
            model: "mock-model",
            usage: null,
            _reasoningContent: "",
            _chunkCount: 1,
        };
    },
    polishToolResult: async () => ({ speech: "润色" }),
}));
vi.mock("./dailyBriefingService", () => ({
    ensureDailyBrief: async () => "今日简报",
    todayStr: () => "2026-11-14",
}));
vi.mock("../knowledge/retrievalService", () => ({
    retrieveForPrompt: async () => "知识片段",
}));
vi.mock("../tools", () => ({
    runTool: async () => "OK",
    getFrontendToolNames: () => new Set<string>(),
}));
vi.mock("../db/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../db/storage")>();
    return { ...actual, getRecentMessages: async () => [] };
});

import { deriveModelMessages, deriveSystemContentFromInjects } from "kirari-agent";
import type { AgentEvent } from "kirari-agent";
import * as storage from "../db/storage";
import { eventStore } from "../events/store";
import { recorder } from "../events/recorder";
import { getReply } from "./conversationService";
import type { AiContext } from "../aiContext";

describe("桌宠 conversationService 事件序列（与核心版对等）", () => {
    let dataDir: string;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-agent-reply-"));
        storage.initDatabase(path.join(dataDir, "pet_sessions.db"));
        recorder.setEnabled(false);
        recorder.setEnabled(true);
    });

    afterEach(async () => {
        await recorder.flush();
        storage.closeDatabase();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("一轮 getReply 落 turn_start / 4×context_inject / request / turn_end，且重启可逐字重建", async () => {
        const aiContext = {
            openai: {},
            model: "mock-model",
            userid: 1,
            activeRequests: new Set<AbortController>(),
            closed: false,
        } as unknown as AiContext;

        const result = await getReply({ aiContext, content: "你好", sessionId: "s1" });
        expect(result.speech).toBe("回复");

        await recorder.flush();
        const events = eventStore.query({ sessionId: "s1" });

        // 与核心版冒烟逐字一致的事件序列。
        expect(events.map((e) => e.type)).toEqual([
            "turn_start",
            "context_inject",
            "context_inject",
            "context_inject",
            "context_inject",
            "request",
            "turn_end",
        ]);
        expect(events.every((e) => e.origin === "desktop")).toBe(true);
        expect(events.every((e) => e.turnId === events[0].turnId)).toBe(true);

        // 模拟杀进程重启：只从磁盘重读事件，不复用内存里的任何对象。
        const restarted: AgentEvent[] = JSON.parse(JSON.stringify(events));

        // 四段 system content 必须等于 context_inject 事件按 order 拼回的结果
        // （校验路径，不写死字符串以免依赖 preflight.injected 空数组的 truthy 细节）。
        const req = events.find((e) => e.type === "request") as AgentEvent;
        const sent = (req.payload as { messages: { role: string; content: string }[] }).messages;
        expect(sent[0].content).toBe(deriveSystemContentFromInjects(restarted, events[0].turnId));
        expect(sent[0].content).toContain("SYS");
        expect(sent[0].content).toContain("今日简报");
        expect(sent[0].content).toContain("知识片段");

        // 逐字重建当时发给模型的 messages，并与流式调用处的快照相等。
        expect(deriveModelMessages(restarted)).toEqual(sent);
        expect(deriveModelMessages(restarted)).toEqual(
            (globalThis as Record<string, unknown>).__sent as unknown[],
        );
    });
});
