// electron/ai/events/jobStore.ts
// JobStore 适配器：把 kirari-agent 的 JobStore 纯契约接到桌宠端已有的 better-sqlite3。
// 与核心版 src/session/jobStore.js 对称；顶层只 import 函数，DB 访问都在方法内惰性进行。

import type { ScheduledJob, JobStore } from "kirari-agent";
import * as storage from "../db/storage";
import { recorder, currentTurnId } from "./recorder";

function rowToJob(row: storage.JobRow | undefined): ScheduledJob | undefined {
    if (!row) return undefined;
    const job: ScheduledJob = {
        jobId: row.job_id,
        sessionId: row.session_id,
        origin: row.origin as ScheduledJob["origin"],
        uid: row.uid,
        kind: row.kind as ScheduledJob["kind"],
        title: row.title,
        payload: row.payload,
        dueAt: row.due_at,
        recurrence: row.recurrence as ScheduledJob["recurrence"],
        status: row.status as ScheduledJob["status"],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (row.last_fired_at != null) job.lastFiredAt = row.last_fired_at;
    return job;
}

function jobToRow(job: ScheduledJob): storage.JobRow {
    return {
        job_id: job.jobId,
        session_id: job.sessionId,
        origin: job.origin,
        uid: job.uid ?? 1,
        kind: job.kind,
        title: job.title,
        payload: job.payload,
        due_at: job.dueAt,
        recurrence: job.recurrence ?? "once",
        status: job.status,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        last_fired_at: job.lastFiredAt ?? null,
    };
}

function enqueueJobEvent(job: ScheduledJob, type: string): void {
    try {
        recorder.enqueue({
            origin: job.origin,
            sessionId: job.sessionId,
            turnId: currentTurnId(),
            type: type as "job_created",
            payload: { jobId: job.jobId, kind: job.kind, title: job.title, dueAt: job.dueAt, status: job.status },
        });
    } catch (e) {
        console.warn("[jobs] 记录定时任务事件失败（已忽略）:", (e as Error)?.message || e);
    }
}

export interface JobStoreWithEvents extends JobStore {
    save(job: ScheduledJob, eventType?: string): void;
}

export const jobStore: JobStoreWithEvents = {
    get(jobId): ScheduledJob | undefined {
        return rowToJob(storage.getJobRow(jobId));
    },
    due(now, limit = 100): ScheduledJob[] {
        return storage.dueJobRows(now, limit).map((r) => rowToJob(r)!);
    },
    save(job, eventType?: string): void {
        storage.saveJobRow(jobToRow(job));
        enqueueJobEvent(job, eventType || "job_created");
    },
    list(sessionId, limit = 100): ScheduledJob[] {
        return storage.listJobRows(sessionId, limit).map((r) => rowToJob(r)!);
    },
};
