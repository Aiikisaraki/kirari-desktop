// @vitest-environment node
// 阶段 C：desktop 任务与定时任务 store + 状态机 + 运行时胶水回归。
// 与核心版冒烟对称：建表、task/job CRUD、任务推进、恢复注入、调度器触发。
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const tmpDir = `${process.cwd()}/.tmp-test/tasks-c-${process.pid}`;

import * as K from "kirari-agent";
import * as storage from "../db/storage";

beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    storage.initDatabase(path.join(tmpDir, "pet_sessions.db"));
});

import { taskStore } from "./taskStore";
import { jobStore } from "./jobStore";
import { recorder } from "./recorder";
import * as taskRuntime from "../services/taskRuntime";
import * as sched from "../services/scheduledJobsService";

describe("阶段 C 建表", () => {
    it("tasks / scheduled_jobs 表已建", () => {
        const tables = (storage.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
        expect(tables).toContain("tasks");
        expect(tables).toContain("scheduled_jobs");
    });
});

describe("taskStore / jobStore 契约", () => {
    it("任务 upsert + active + 状态推进", () => {
        const plan = K.parsePlan({ title: "查天气再提醒带伞", steps: [
            { kind: "tool", label: "查天气", toolName: "get_weather", toolArgs: {} },
            { kind: "reminder", label: "提醒", text: "带伞", delayMs: 1000 },
        ]});
        const t = K.createTask({ taskId: "d-task-1", sessionId: "d-s1", turnId: "t", origin: "desktop", uid: 1, title: plan.title, steps: plan.steps, now: Date.now() });
        taskStore.save(t, "task_created");
        expect(taskStore.get("d-task-1")?.status).toBe("pending");
        expect(taskStore.active("d-s1").map((x) => x.taskId)).toContain("d-task-1");

        let t2 = K.advanceTask(t, "d-task-1:s1", true, "晴转雨", Date.now());
        taskStore.save(t2, "task_updated");
        t2 = K.advanceTask(t2, "d-task-1:s2", true, "已提醒", Date.now());
        taskStore.save(t2, "task_completed");
        expect(taskStore.get("d-task-1")?.status).toBe("completed");
        expect(taskStore.active("d-s1").length).toBe(0);
    });

    it("定时任务落库 + 到点判定", () => {
        const job = K.createJob({ jobId: "d-job-1", sessionId: "d-s1", origin: "desktop", uid: 1, kind: "reminder", title: "带伞", payload: "要下雨了", dueAt: Date.now() - 1, now: Date.now() });
        jobStore.save(job, "job_created");
        expect(jobStore.get("d-job-1")?.status).toBe("pending");
        expect(jobStore.due(Date.now()).map((j) => j.jobId)).toContain("d-job-1");
    });
});

describe("taskRuntime 恢复注入与工具分派", () => {
    it("未完成任务产生恢复注入与 nudge", () => {
        const plan = K.parsePlan({ title: "待办：续杯", steps: [{ kind: "text", label: "提醒续杯" }] });
        const t = K.createTask({ taskId: "d-task-2", sessionId: "d-resume", turnId: "t", origin: "desktop", uid: 1, title: plan.title, steps: plan.steps, now: Date.now() });
        taskStore.save(t, "task_created");
        expect(taskRuntime.hasActiveTask("d-resume")).toBe(true);
        expect(taskRuntime.resumeBlock("d-resume")).toContain("续杯");
        expect(taskRuntime.pendingNudge("d-resume")).toContain("续杯");
    });

    it("handlePlan / handleScheduleReminder 落库并返回确认", () => {
        const ctx = { sessionId: "d-tools", turnId: "t", uid: 1, origin: "desktop" as const };
        const planResult = taskRuntime.handlePlan({ title: "去办事", steps: [{ kind: "text", label: "办" }] }, ctx);
        expect(planResult).toContain("已记下任务");
        expect(taskRuntime.hasActiveTask("d-tools")).toBe(true);
        const remResult = taskRuntime.handleScheduleReminder({ title: "提醒", text: "喝水", delayMs: 1000 }, ctx);
        expect(remResult).toContain("已设好提醒");
        expect(jobStore.list("d-tools").length).toBeGreaterThan(0);
    });
});

describe("调度器触发", () => {
    it("到点 job 经 onFire 回调后 fireJob 落库", async () => {
        const fired: string[] = [];
        sched.setFireHandler((job) => { fired.push(job.payload); });
        const before = jobStore.get("d-job-1")!.status;
        expect(before).toBe("pending");
        const n = await sched.scanOnce();
        expect(n).toBeGreaterThanOrEqual(1);
        expect(fired).toContain("要下雨了");
        expect(jobStore.get("d-job-1")?.status).toBe("fired");
    });
});

describe("阶段 C 事件流", () => {
    it("task_* / job_* 事件可查", async () => {
        await recorder.flush();
        const types = (storage.getDb().prepare("SELECT type FROM session_events WHERE session_id='d-s1' ORDER BY seq").all() as { type: string }[]).map((r) => r.type);
        for (const t of ["task_created", "task_updated", "task_completed", "job_created"]) {
            expect(types).toContain(t);
        }
    });
});
