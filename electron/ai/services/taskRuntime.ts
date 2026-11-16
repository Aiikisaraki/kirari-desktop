// electron/ai/services/taskRuntime.ts
// 阶段 C 任务编排胶水（desktop 侧），与核心版 src/services/taskRuntime.js 对称。
//
// 共享包只放 Task/ScheduledJob 的类型 + 状态机 + 严格解析；本文件接到桌宠端的
// taskStore/jobStore 与事件流上，负责 plan / schedule_reminder 工具执行、步骤推进、
// 未完成任务跨轮恢复、提前收尾拦截提示。

import { randomBytes } from "node:crypto";
import {
    parsePlan,
    createTask,
    advanceTask,
    nextPendingStep,
    isTaskComplete,
    parseReminder,
    createJob,
} from "kirari-agent";
import type { EventType } from "kirari-agent";
import { taskStore } from "../events/taskStore";
import { jobStore } from "../events/jobStore";

export type TaskToolCtx = {
    sessionId: string;
    turnId: string;
    uid: number;
    origin: "core" | "desktop";
};

function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

// 阶段 D：schema 抽到无依赖模块，避免 eager glob 的顶层循环依赖；这里 re-export 兼容原调用方。
import { PLAN_TOOL, REMINDER_TOOL } from "./taskSchemas";
export { PLAN_TOOL, REMINDER_TOOL } from "./taskSchemas";

export function withTaskTools(tools: unknown[]): unknown[] {
    return [...tools, PLAN_TOOL, REMINDER_TOOL];
}

export function isTaskTool(name: string | undefined): boolean {
    return name === "plan" || name === "schedule_reminder";
}

export function handlePlan(args: unknown, ctx: TaskToolCtx): string {
    try {
        const parsed = parsePlan(args);
        const now = Date.now();
        const task = createTask({
            taskId: newId("task"),
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            origin: ctx.origin || "desktop",
            uid: ctx.uid ?? 1,
            title: parsed.title,
            steps: parsed.steps,
            now,
        });
        taskStore.save(task, "task_created");
        const preview = task.steps.map((s, i) => `${i + 1}. ${s.label}`).join("；");
        return `已记下任务「${task.title}」，共 ${task.steps.length} 步：${preview}。请现在开始执行第 1 步，完成后继续下一步，全部完成后再给主人一句自然总结。`;
    } catch (e) {
        return `error: 任务规划失败——${e instanceof Error ? e.message : String(e)}`;
    }
}

export function handleScheduleReminder(args: unknown, ctx: TaskToolCtx): string {
    try {
        const now = Date.now();
        const spec = parseReminder(args, now);
        const job = createJob({
            jobId: newId("job"),
            sessionId: ctx.sessionId,
            origin: ctx.origin || "desktop",
            uid: ctx.uid ?? 1,
            kind: "reminder",
            title: spec.title,
            payload: spec.payload,
            dueAt: spec.dueAt,
            recurrence: "once",
            now,
        });
        jobStore.save(job, "job_created");
        advancePendingStep(ctx.sessionId, "reminder", null, `已设置：${spec.title}`, now);
        const when = new Date(spec.dueAt).toLocaleString("zh-CN");
        return `已设好提醒「${spec.title}」，将在 ${when} 提醒主人：${spec.payload}`;
    } catch (e) {
        return `error: 设置提醒失败——${e instanceof Error ? e.message : String(e)}`;
    }
}

export function advancePendingStep(
    sessionId: string,
    kind: "tool" | "reminder" | "text",
    toolName: string | null,
    result: string | undefined,
    now = Date.now(),
): boolean {
    try {
        for (const task of taskStore.active(sessionId)) {
            const step = nextPendingStep(task);
            if (!step) continue;
            let matched = false;
            if (kind === "reminder" && step.kind === "reminder") matched = true;
            else if (kind === "tool" && step.kind === "tool" && step.toolName === toolName) matched = true;
            if (!matched) continue;
            const advanced = advanceTask(task, step.id, true, result, now);
            taskStore.save(advanced, isTaskComplete(advanced) ? "task_completed" : "task_updated");
            return true;
        }
    } catch (e) {
        console.warn("[tasks] 推进任务步骤失败（已忽略）:", e instanceof Error ? e.message : e);
    }
    return false;
}

export function hasActiveTask(sessionId: string): boolean {
    try {
        return taskStore.active(sessionId).length > 0;
    } catch (e) {
        console.warn("[tasks] 查询未完成任务失败（已忽略）:", e instanceof Error ? e.message : e);
        return false;
    }
}

export function resumeBlock(sessionId: string): string {
    try {
        const active = taskStore.active(sessionId);
        if (!active.length) return "";
        const lines = active.map((t) => {
            const step = nextPendingStep(t);
            return `- 「${t.title}」：下一步「${step ? step.label : "收尾总结"}」`;
        });
        return (
            "\n\n【未完成的待办 · 请接着做】\n" +
            lines.join("\n") +
            "\n（这些是之前答应主人、还没做完的事。合适时继续推进，做完一句自然总结即可，不要机械复述步骤。）"
        );
    } catch (e) {
        console.warn("[tasks] 生成任务恢复注入失败（已忽略）:", e instanceof Error ? e.message : e);
        return "";
    }
}

export function pendingNudge(sessionId: string): string {
    try {
        const active = taskStore.active(sessionId);
        const task = active[0];
        const step = task ? nextPendingStep(task) : null;
        const hint = step ? `下一步是「${step.label}」` : "收尾总结";
        return `[系统] 你还有答应主人的任务「${task ? task.title : "未完成"}」没做完，${hint}。请继续调用相应工具完成它，不要现在就结束回复。`;
    } catch {
        return "[系统] 你还有未完成的任务，请继续完成，不要现在结束回复。";
    }
}

// 保证 EventType 被引用（细分事件类型由 store 层转换，这里显式约束集合存在）。
export type TaskEventType = Extract<EventType, "task_created" | "task_updated" | "task_completed" | "job_created" | "job_fired">;
