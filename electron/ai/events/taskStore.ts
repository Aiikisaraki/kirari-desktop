// electron/ai/events/taskStore.ts
// TaskStore 适配器：把 kirari-agent 的 TaskStore 纯契约接到桌宠端已有的 better-sqlite3。
// 与核心版 src/session/taskStore.js 对称；顶层只 import 函数，DB 访问都在方法内惰性进行
// （避免 initDatabase 前 getDb() 走兜底路径多建一个 kirari.db）。

import type { Task, TaskStore } from "kirari-agent";
import * as storage from "../db/storage";
import { recorder, currentTurnId } from "./recorder";

function rowToTask(row: storage.TaskRow | undefined): Task | undefined {
    if (!row) return undefined;
    let steps: Task["steps"] = [];
    try {
        const parsed = JSON.parse(row.steps_json);
        if (Array.isArray(parsed)) steps = parsed;
    } catch (e) {
        console.warn("[tasks] steps_json 不是合法 JSON，按空步骤处理：", (e as Error)?.message || e);
    }
    const task: Task = {
        taskId: row.task_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        origin: row.origin as Task["origin"],
        uid: row.uid,
        title: row.title,
        status: row.status as Task["status"],
        steps,
        currentStep: row.current_step,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (row.completed_at != null) task.completedAt = row.completed_at;
    return task;
}

function taskToRow(task: Task): storage.TaskRow {
    return {
        task_id: task.taskId,
        session_id: task.sessionId,
        turn_id: task.turnId,
        origin: task.origin,
        uid: task.uid ?? 1,
        title: task.title,
        status: task.status,
        steps_json: JSON.stringify(task.steps ?? []),
        current_step: task.currentStep ?? 0,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        completed_at: task.completedAt ?? null,
    };
}

function enqueueTaskEvent(task: Task, eventType?: string): void {
    try {
        recorder.enqueue({
            origin: task.origin,
            sessionId: task.sessionId,
            turnId: eventType ? currentTurnId() : (task.turnId || currentTurnId()),
            type: (eventType || "task_updated") as "task_updated",
            payload: {
                taskId: task.taskId,
                title: task.title,
                status: task.status,
                currentStep: task.currentStep,
                stepCount: task.steps.length,
            },
        });
    } catch (e) {
        console.warn("[tasks] 记录任务事件失败（已忽略）:", (e as Error)?.message || e);
    }
}

/** 在共享包契约上扩展一个可选事件类型参数，便于细分 task_created/completed/failed。 */
export interface TaskStoreWithEvents extends TaskStore {
    save(task: Task, eventType?: string): void;
}

export const taskStore: TaskStoreWithEvents = {
    get(taskId): Task | undefined {
        return rowToTask(storage.getTaskRow(taskId));
    },
    active(sessionId): Task[] {
        return storage.activeTaskRows(sessionId).map((r) => rowToTask(r)!);
    },
    save(task, eventType?: string): void {
        storage.saveTaskRow(taskToRow(task));
        enqueueTaskEvent(task, eventType);
    },
    list(sessionId, limit = 100): Task[] {
        return storage.listTaskRows(sessionId, limit).map((r) => rowToTask(r)!);
    },
};
