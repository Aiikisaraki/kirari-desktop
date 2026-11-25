// @vitest-environment node
// 阶段 C 完成标志（desktop）：mock LLM 驱动 getReply，「查天气再提醒我带伞」一条请求完成两步。
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi, afterAll } from "vitest";

// 临时目录用**随机后缀**而不是 process.pid：
// PID 会被系统复用，`.tmp-test/tasks-reply-<pid>` 一旦残留（上一次异常退出没清理），
// 下一次同 PID 就会读到上一轮的 d-e2e 数据 —— 表现为偶发失败，且只在 CI 上偶现，最难查。
// mkdtempSync 保证每次都是全新目录。
const configDir = vi.hoisted(() => {
    const fsx = require("node:fs");
    const osx = require("node:os");
    const pax = require("node:path");
    return fsx.mkdtempSync(pax.join(osx.tmpdir(), "kirari-tasks-reply-"));
});
vi.mock("electron", () => ({ app: { getPath: () => configDir } }));

vi.mock("../reply/parser", () => ({
    parseModelReply: (s: string) => ({ speech: s, emotion: null, images: [] }),
    isValidImageUrl: () => true,
}));
vi.mock("../reply/promptBuilder", () => ({
    buildBasePrompt: () => "BASE",
    buildSystemPrompts: () => ({ normal: "SYS", withTools: "SYS {{TOOL_RESULTS}}", polish: "POLISH", locationSet: "LOC" }),
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
vi.mock("./dailyBriefingService", () => ({ ensureDailyBrief: async () => null, todayStr: () => "2026-11-16" }));
vi.mock("../knowledge/retrievalService", () => ({ retrieveForPrompt: async () => "" }));
vi.mock("../db/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../db/storage")>();
    return { ...actual, getRecentMessages: async () => [] };
});

// taskRuntime 用真实实现（含 store/状态机）；阶段 D 起 conversationService 走 capabilities.dispatch，
// 所以 mock 能力层：任务工具转发真实 taskRuntime，get_weather 返回固定值（不跑外网），listTools 给非空集。
import type { TaskToolCtx } from "./taskRuntime";
const taskRuntime = await import("./taskRuntime");
const fakeTools = ["plan", "get_weather", "schedule_reminder", "load_skill"].map((name) => ({
    type: "function", function: { name, description: name, parameters: { type: "object" } },
}));
vi.mock("../capabilities/registry", () => ({
    scopeKey: (ns: string, id: string) => `${ns}::${id}`,
    listTools: () => fakeTools,
    has: (_s: string, name: string) => fakeTools.some((t) => t.function.name === name),
    resolve: (_s: string, name: string) => fakeTools.find((t) => t.function.name === name) ? { name, scope: "builtin", timeoutMs: 30000, truncateChars: 4000 } : undefined,
    dispatch: async (_s: string, name: string, args: unknown, ctx: unknown) => {
        if (name === "plan") return { content: await taskRuntime.handlePlan(args, ctx as TaskToolCtx), isError: false, capability: null };
        if (name === "schedule_reminder") return { content: await taskRuntime.handleScheduleReminder(args, ctx as TaskToolCtx), isError: false, capability: null };
        if (name === "get_weather") return { content: "上海晴转雨", isError: false, capability: null };
        return { content: `tool:${name}`, isError: false, capability: null };
    },
    registerGlobal: () => 0,
    registerConnection: () => 0,
    unregisterConnection: () => {},
}));

const planArgs = { title: "查天气再提醒带伞", steps: [
    { kind: "tool", label: "查天气", toolName: "get_weather", toolArgs: { location: "上海" } },
    { kind: "reminder", label: "提醒带伞", text: "午后有雨带伞", delayMs: 60000 },
]};
let call = 0;
vi.mock("../reply/streaming", () => ({
    streamChatCompletion: async () => {
        call++;
        if (call === 1) return {
            choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "tc0", type: "function", function: { name: "plan", arguments: JSON.stringify(planArgs) } }] }, finish_reason: "tool_calls" }],
            model: "mock-model", usage: null, _reasoningContent: "", _chunkCount: 1,
        };
        if (call === 2) return {
            choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ location: "上海" }) } }] }, finish_reason: "tool_calls" }],
            model: "mock-model", usage: null, _reasoningContent: "", _chunkCount: 1,
        };
        if (call === 3) return {
            choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "tc2", type: "function", function: { name: "schedule_reminder", arguments: JSON.stringify({ title: "带伞", text: "午后有雨带伞", delayMs: 60000 }) } }] }, finish_reason: "tool_calls" }],
            model: "mock-model", usage: null, _reasoningContent: "", _chunkCount: 1,
        };
        return {
            choices: [{ message: { role: "assistant", content: "查过天气啦，午后有雨，也设好了带伞提醒~", tool_calls: undefined }, finish_reason: "stop" }],
            model: "mock-model", usage: null, _reasoningContent: "", _chunkCount: 1,
        };
    },
    polishToolResult: async () => ({ speech: "润色" }),
}));

import { getReply } from "./conversationService";
import * as storage from "../db/storage";
import { recorder } from "../events/recorder";

beforeAll(() => {
    fs.mkdirSync(configDir, { recursive: true });
    storage.initDatabase(path.join(configDir, "pet_sessions.db"));
});
beforeEach(() => { call = 0; });

describe("desktop 完成标志：一条请求完成两步", () => {
    it("plan → get_weather → schedule_reminder → final，任务完成、提醒落库", async () => {
        const aiContext = {
            openai: {} as never, model: "mock-model", userid: 1, closed: false,
            activeRequests: new Set<never>(), searchKey: "", searchEndpoint: "", searchProvider: "uapis",
        } as never;
        const reply = await getReply({ aiContext, content: "查天气再提醒我带伞", sessionId: "d-e2e" });
        expect(reply.speech).toContain("提醒");
        expect(call).toBe(4);

        await recorder.flush();
        const db = storage.getDb();
        const tasks = db.prepare("SELECT * FROM tasks WHERE session_id='d-e2e'").all() as { status: string; steps_json: string }[];
        const jobs = db.prepare("SELECT * FROM scheduled_jobs WHERE session_id='d-e2e'").all() as unknown[];
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe("completed");
        expect((JSON.parse(tasks[0].steps_json) as { status: string }[]).every((s) => s.status === "done")).toBe(true);
        expect(jobs).toHaveLength(1);
        const types = (db.prepare("SELECT type FROM session_events WHERE session_id='d-e2e' ORDER BY seq").all() as { type: string }[]).map((r) => r.type);
        for (const t of ["task_created", "task_updated", "task_completed", "job_created"]) expect(types).toContain(t);
    });
});

// 用完即清：别让临时目录留到下一次（配合上面的 mkdtemp 双保险）
afterAll(() => {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
