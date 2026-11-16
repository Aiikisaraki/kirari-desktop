// electron/ai/services/briefSchedule.ts
// 阶段 E：每日简报落库调度（桌宠端）。与核心版 briefSchedule.js 对称。
//
// 每个本地 uid × 08/16/22 三档一条 daily_brief job，交给 scheduledJobsService 统一扫描。
// 共库双进程（core + desktop）用 settings_kv 的 brief_done:<uid>:<date>:<slot> 抢占锁，
// 同一档只让一个进程真正去采集 + 压缩；另一进程只把 job 顺延。
//
// 真正的「生成」动作由主进程注入（setBriefRunner）：本模块不碰模型配置与 AiContext，
// 保持「调度」与「凭证」两件事分离。

import { createJob } from "kirari-agent";
import { jobStore } from "../events/jobStore";
import { claimSetting, releaseSetting, LOCAL_UID } from "../db/storage";
import { todayStr } from "./dailyBriefingService";

export const BRIEF_SLOTS = [8, 16, 22] as const;
const JOB_ID_PREFIX = "brief";

type BriefRunner = (job: { uid: number; slot: number; date: string }) => Promise<boolean> | boolean;

let briefRunner: BriefRunner | null = null;

/** 主进程注入「如何生成一份简报」（读配置 + 建上下文 + 调 dailyBriefing）。 */
export function setBriefRunner(runner: BriefRunner): void {
    briefRunner = runner;
}

export function jobIdFor(uid: number, slot: number): string {
    return `${JOB_ID_PREFIX}:${uid}:${slot}`;
}

/** 下一个 slot 整点（本地时区）。已过则顺延到明天同一档。 */
export function nextSlotAt(slot: number, now: number): number {
    const d = new Date(now);
    d.setHours(slot, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
}

/** 从 jobId 尾段取档位；解析不出时按 dueAt 的小时数兜底。 */
export function slotOf(job: { jobId: string; dueAt: number }): number {
    const tail = Number(String(job.jobId).split(":").pop());
    if ((BRIEF_SLOTS as readonly number[]).includes(tail)) return tail;
    const h = new Date(job.dueAt).getHours();
    return (BRIEF_SLOTS as readonly number[]).includes(h) ? h : BRIEF_SLOTS[0];
}

/**
 * 补齐/校正简报任务。只补「不存在的」和「已终态的」记录；pending 一律不动 ——
 * 停机期间过期的那一档正是要留给调度器补跑的补偿信号。
 */
export async function ensureJobs(now = Date.now()): Promise<{ created: number; revived: number }> {
    let created = 0;
    let revived = 0;
    for (const slot of BRIEF_SLOTS) {
        const jobId = jobIdFor(LOCAL_UID, slot);
        const existing = jobStore.get(jobId);
        if (!existing) {
            jobStore.save(
                createJob({
                    jobId,
                    sessionId: `${JOB_ID_PREFIX}:${LOCAL_UID}`,
                    origin: "desktop",
                    uid: LOCAL_UID,
                    kind: "daily_brief",
                    title: `每日简报 ${String(slot).padStart(2, "0")}:00`,
                    payload: "",
                    dueAt: nextSlotAt(slot, now),
                    recurrence: "daily",
                    now,
                }),
                "job_created",
            );
            created++;
            continue;
        }
        if (existing.status !== "pending") {
            jobStore.save(
                {
                    ...existing,
                    kind: "daily_brief",
                    recurrence: "daily",
                    status: "pending",
                    dueAt: nextSlotAt(slot, now),
                    updatedAt: now,
                },
                "job_created",
            );
            revived++;
        }
    }
    if (created || revived) {
        console.log(`[brief] 简报任务已就绪：新建 ${created} 条，恢复 ${revived} 条`);
    }
    return { created, revived };
}

/**
 * 触发一条简报任务。true=本进程生成了简报，false=被抢到/未配置/失败。
 * 失败会回滚锁，且不抛错——避免 job 保持 pending 形成 15s 热循环；
 * 当天缺简报由对话时的 ensureDailyBrief 惰性兜底。
 */
export async function fireDailyBrief(job: { uid: number; dueAt: number; jobId: string }, now = Date.now()): Promise<boolean> {
    const slot = slotOf(job);
    const date = todayStr();
    const lockKey = `brief_done:${job.uid}:${date}:${slot}`;
    if (!claimSetting(lockKey, String(now))) {
        console.log(`[brief] ${date} ${slot}:00 已由另一进程生成，本进程跳过`);
        return false;
    }
    if (!briefRunner) {
        releaseSetting(lockKey);
        return false;
    }
    try {
        const ok = await briefRunner({ uid: job.uid, slot, date });
        if (!ok) {
            releaseSetting(lockKey);
            console.warn(`[brief] ${date} ${slot}:00 生成失败 uid=${job.uid}`);
            return false;
        }
        return true;
    } catch (e) {
        releaseSetting(lockKey);
        console.warn(`[brief] ${date} ${slot}:00 生成失败 uid=${job.uid}:`, e instanceof Error ? e.message : e);
        return false;
    }
}
