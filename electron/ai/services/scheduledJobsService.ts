// electron/ai/services/scheduledJobsService.ts
// 阶段 C 定时任务调度器（desktop 侧 IO，不进共享包）。与核心版对称。
//
// 周期扫 scheduled_jobs 的到点任务（isDue / fireJob 来自共享包），到点后调用注入的
// onFire 回调把提醒送进聊天界面，再 fireJob 落库。调度状态以 job 的 status+dueAt
// 为准，重启后扫表即恢复——提醒落库、重启不丢。

import { isDue, fireJob } from "kirari-agent";
import { jobStore } from "../events/jobStore";
import { recorder } from "../events/recorder";
import * as briefSchedule from "./briefSchedule";
import * as workspaceTask from "./workspaceTask";

type FireHandler = (job: { title: string; payload: string; sessionId: string; uid: number }) => boolean | void;

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let onFire: FireHandler | null = null;
const SCAN_INTERVAL_MS = 15 * 1000;

/** 由主进程注入「到点提醒如何送达界面」的回调（通常调用 chatSessionService.injectProactiveMessage）。 */
export function setFireHandler(handler: FireHandler): void {
    onFire = handler;
}

export async function scanOnce(): Promise<number> {
    if (scanning) return 0;
    scanning = true;
    let fired = 0;
    try {
        const now = Date.now();
        const due = jobStore.due(now, 100);
        for (const job of due) {
            if (!isDue(job, now)) continue;
            try {
                if (job.kind === "reminder" && onFire) {
                    onFire({ title: job.title, payload: job.payload, sessionId: job.sessionId, uid: job.uid });
                } else if (job.kind === "daily_brief") {
                    // 阶段 E：简报任务。生成失败也只 warn（briefSchedule 内部回滚档位锁），
                    // job 照常顺延，避免 15s 热循环；当天缺简报由对话时惰性兜底。
                    await briefSchedule.fireDailyBrief(job, now);
                } else if (job.kind === "workspace_task" as never) {
                    // 工作空间定期任务：到点让它自己去执行并把产出写进任务文件夹。
                    // 叶子节点在这里会**转发给主机**执行（见 services/workspaceTask.ts），
                    // 产出落在主机，叶子只拿结果——用户 2026-11-19 明确要求的行为。
                    await workspaceTask.fire(job, now);
                }
                const next = fireJob(job, now);

                // weekly / monthly 的间隔不是 24h，共享包的 computeNextRun 只会 +24h。
                // 这里按 payload 里存的周期字段把 dueAt 覆盖成正确的下一次。
                // once / daily 走共享包的原有语义，不碰。
                if (job.kind === ("workspace_task" as never) && next.status === "pending") {
                    try {
                        const payload = workspaceTask.parsePayload(next.payload);
                        const scheduleTask = await import("../capabilities/builtin/schedule_task");
                        const overridden = payload
                            ? scheduleTask.nextDueAtAfterFire(payload, next.dueAt)
                            : null;
                        if (overridden != null) next.dueAt = overridden;
                    } catch (e) {
                        console.warn(
                            `[sched] 重算 job=${job.jobId} 下次时间失败（沿用共享包结果）:`,
                            e instanceof Error ? e.message : e,
                        );
                    }
                }

                jobStore.save(next, "job_fired");
                fired++;
            } catch (e) {
                console.warn(`[sched] 触发 job=${job.jobId} 失败（稍后重试）:`, e instanceof Error ? e.message : e);
            }
        }
    } catch (e) {
        console.warn("[sched] 扫表失败（稍后重试）:", e instanceof Error ? e.message : e);
    } finally {
        scanning = false;
    }
    if (fired > 0) {
        try {
            await recorder.flush();
        } catch (e) {
            console.warn("[sched] 事件 flush 失败:", e instanceof Error ? e.message : e);
        }
    }
    return fired;
}

export function start(): void {
    if (timer) return;
    void scanOnce();
    timer = setInterval(() => {
        void scanOnce();
    }, SCAN_INTERVAL_MS);
    timer.unref?.();
    console.log("[sched] 定时任务调度器已启动（每 15s 扫描）");
}

export function stop(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
