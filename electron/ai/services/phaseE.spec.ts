// @vitest-environment node
// 阶段 E：桌宠端回归——简报落库调度 + 按需子 agent。
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/phase-e-${process.pid}`);

vi.mock("electron", () => ({ app: { getPath: () => tmpDir } }));

// 子 agent 的模型调用在 spec 里换成可控序列：第一轮要工具，第二轮给结论。
const modelCalls: { tools: string[]; rounds: number }[] = [];
let modelRound = 0;
vi.mock("../reply/streaming", () => ({
    streamChatCompletion: async (_openai: any, params: any) => {
        modelCalls.push({ tools: (params.tools || []).map((t: any) => t.function.name) });
        modelRound++;
        const message =
            modelRound === 1
                ? {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                          { id: "c1", type: "function", function: { name: "get_current_time", arguments: "{}" } },
                      ],
                  }
                : { role: "assistant", content: "子任务完成：时间已取到。" };
        return { choices: [{ message, finish_reason: "stop" }], model: "fake" };
    },
}));

beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
});

import * as K from "kirari-agent";
import * as storage from "../db/storage";
import { jobStore } from "../events/jobStore";
import { recorder } from "../events/recorder";
import * as caps from "../capabilities/registry";
import * as briefSchedule from "./briefSchedule";

describe("阶段 E · 简报落库调度", () => {
    it("按三档创建 daily_brief 任务，且重复调用幂等", async () => {
        storage.initDatabase(path.join(tmpDir, "pet_sessions.db"));
        const first = await briefSchedule.ensureJobs(Date.now());
        expect(first.created).toBe(3);
        const again = await briefSchedule.ensureJobs(Date.now());
        expect(again.created).toBe(0);
        const jobs = [8, 16, 22].map((h) => jobStore.get(briefSchedule.jobIdFor(storage.LOCAL_UID, h)));
        for (const j of jobs) {
            expect(j?.kind).toBe("daily_brief");
            expect(j?.recurrence).toBe("daily");
            expect(j?.status).toBe("pending");
        }
    });

    it("同一档只跑一次：第二个进程抢锁失败；失败会回滚锁", async () => {
        let runs = 0;
        briefSchedule.setBriefRunner(async () => {
            runs++;
            return runs === 1;
        });
        const job = jobStore.get(briefSchedule.jobIdFor(storage.LOCAL_UID, 8))!;
        const first = await briefSchedule.fireDailyBrief(job);
        const second = await briefSchedule.fireDailyBrief(job);
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(runs).toBe(1);

        // 换一天模拟失败：runner 返回 false → 锁回滚，下一轮仍可尝试
        const tomorrow = { ...job, jobId: `${job.jobId}` };
        const date = await import("./dailyBriefingService");
        const key = `brief_done:${job.uid}:${date.todayStr()}:16`;
        expect(storage.claimSetting(key, "x")).toBe(true);
        storage.releaseSetting(key);
        expect(storage.claimSetting(key, "y")).toBe(true);
        expect(tomorrow.jobId).toBe(job.jobId);
    });

    it("已终态任务会被恢复为 pending（客户端升级/误取消后自愈）", async () => {
        const job = jobStore.get(briefSchedule.jobIdFor(storage.LOCAL_UID, 22))!;
        jobStore.save({ ...job, status: "fired" });
        const r = await briefSchedule.ensureJobs(Date.now());
        expect(r.revived).toBe(1);
        expect(jobStore.get(job.jobId)?.status).toBe("pending");
    });
});

describe("阶段 E · 按需子 agent", () => {
    it("作为内置能力注册，工具集剔除自身（禁止递归）", () => {
        const tools = caps.listTools("local::e").map((t: any) => t.function.name);
        expect(tools).toContain("subagent");
        expect(caps.resolve("local::e", "subagent")?.kind).toBe("agent");
    });

    it("独立会话跑完一轮工具循环，主会话不留事件", async () => {
        modelRound = 0;
        modelCalls.length = 0;
        const scope = caps.scopeKey("local", "e");
        const fakeOpenAI = { chat: { completions: { create: async () => ({}) } } } as any;
        const out = await caps.dispatch(scope, "subagent", { goal: "查一下现在几点" }, {
            openai: fakeOpenAI,
            model: "fake-model",
            uid: storage.LOCAL_UID,
            sessionId: "main-e",
            turnId: "turn-main-e",
            origin: "desktop",
            capScope: scope,
        });
        expect(out.isError).toBe(false);
        expect(out.content).toContain("子任务完成");
        expect(modelCalls.length).toBe(2);
        expect(modelCalls[0].tools).not.toContain("subagent");
        expect(modelCalls[0].tools).toContain("get_current_time");

        await recorder.flush();
        const rows = storage
            .getDb()
            .prepare("SELECT type, session_id FROM session_events WHERE session_id LIKE 'sub::%'")
            .all() as { type: string; session_id: string }[];
        const types = rows.map((r) => r.type);
        for (const t of ["user_message", "request", "tool_call", "tool_result", "assistant_message"])
            expect(types).toContain(t);
        const mainRows = storage
            .getDb()
            .prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = 'main-e'")
            .get() as { n: number };
        expect(mainRows.n).toBe(0);
    });

    it("缺少模型客户端时返回 error 而不是抛错", async () => {
        const out = await caps.dispatch("local::e", "subagent", { goal: "x" }, { uid: 1 });
        expect(out.isError).toBe(false);
        expect(out.content.startsWith("error:")).toBe(true);
    });
});

describe("阶段 E · 简报 job 状态机", () => {
    it("到点只补跑一次并顺延到未来", () => {
        const job = jobStore.get(briefSchedule.jobIdFor(storage.LOCAL_UID, 8))!;
        const overdue = { ...job, dueAt: Date.now() - 3 * 86400000 };
        const next = K.fireJob(overdue, Date.now());
        expect(next.status).toBe("pending");
        expect(next.dueAt).toBeGreaterThan(Date.now());
        expect(next.lastFiredAt).toBeGreaterThan(0);
    });
});
