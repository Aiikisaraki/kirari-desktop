// electron/ai/services/scheduledJobsService.ts
// 阶段 C 定时任务调度器（desktop 侧 IO，不进共享包）。与核心版对称。
//
// 周期扫 scheduled_jobs 的到点任务（isDue / fireJob 来自共享包），到点后先把提醒
// 真正送到用户手上（deliverReminder），再 fireJob 落库。调度状态以 job 的
// status+dueAt 为准，重启后扫表即恢复——提醒落库、重启不丢。

import { isDue, fireJob } from "kirari-agent";
import type { ScheduledJob } from "kirari-agent";
import { jobStore } from "../events/jobStore";
import { recorder } from "../events/recorder";
import * as briefSchedule from "./briefSchedule";
import * as workspaceTask from "./workspaceTask";

/**
 * 送达回调（由主进程注入）：把一句话送进桌面聊天界面。
 * 入参就是整条 job —— 要发的文本是 `job.payload`（ScheduledJob 里它本来就是文本）。
 * 返回 truthy 表示**真的送到了**（界面会话存在、消息推成功了）；
 * false/void 表示没送到 —— 这个返回值是「到点了却没提醒我」能被查出来的关键。
 */
type DesktopDeliver = (job: ScheduledJob) => boolean | void;

/**
 * 平台回发回调（由主进程注入）：把一句话发回原来的 QQ 会话。
 * 只对 `bot-<adapterId>-<conversationKey>` 形式的 sessionId 有效，其余返回 false。
 */
type PlatformDeliver = (input: { text: string; sessionId: string }) => boolean | void;

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let deliverDesktop: DesktopDeliver | null = null;
let deliverPlatform: PlatformDeliver | null = null;
const SCAN_INTERVAL_MS = 15 * 1000;

/** 兼容旧调用点：只注入桌面这一条腿（等价于只设 deliverDesktop）。 */
export function setFireHandler(handler: DesktopDeliver | null): void {
    deliverDesktop = handler;
}

/** 注入桌面这条腿（"让桌宠说出来"）。 */
export function setDesktopDeliverer(handler: DesktopDeliver | null): void {
    deliverDesktop = handler;
}

/** 注入平台这条腿（"用户在 QQ 里定的，就在 QQ 里收到"）。 */
export function setPlatformDeliverer(handler: PlatformDeliver | null): void {
    deliverPlatform = handler;
}

/**
 * 把一条提醒真正送到用户手上，返回送达的通道数。
 *
 * ── 为什么不能只推桌面（2026-11-20 用户报障）────────────────────
 *   「六点多的时候，它还知道要7点提醒我，但是到了7点也没提醒我」
 *
 * 原因：提醒几乎都是在 QQ 里定的，而原先只有「推桌面界面」这一条路。
 * 到点那一刻桌面没开 → 推给 0 个连接 → 消息静默消失，job 却仍然被标成 fired。
 * 用户视角就是「说好的提醒没来」，而且事后查库还显示「已触发」，无从追。
 *
 * 所以改成两条腿：
 *   ① 桌面界面（桌宠能开口说出来）
 *   ② 原会话所在平台（QQ 私聊/群）——用户在哪儿定的，就在哪儿收到
 * 两条都失败时**明确告警**，不再假装成功。
 */
export function deliverReminder(job: ScheduledJob): number {
    const text = String(job.payload || "");
    if (!text) {
        console.warn(`[sched] 提醒 job=${job.jobId} 内容为空，跳过`);
        return 0;
    }

    let sentDesktop = 0;
    let sentPlatform = 0;

    // ① 桌面
    if (deliverDesktop) {
        try {
            sentDesktop = deliverDesktop(job) ? 1 : 0;
        } catch (e) {
            console.warn(`[sched] 提醒 job=${job.jobId} 推送桌面失败:`, e instanceof Error ? e.message : e);
        }
    }

    // ② 原会话所在平台。sessionId 是 `bot-<adapterId>-<conversationKey>` 才发得出去；
    //    桌面本地会话（纯 uuid）没有平台通道，只能靠 ①。
    if (deliverPlatform) {
        try {
            if (deliverPlatform({ text, sessionId: job.sessionId })) sentPlatform = 1;
        } catch (e) {
            console.warn(`[sched] 提醒 job=${job.jobId} 发回平台失败:`, e instanceof Error ? e.message : e);
        }
    }

    const total = sentDesktop + sentPlatform;
    if (total > 0) {
        console.log(
            `[sched] 提醒 job=${job.jobId} uid=${job.uid} 已送达（桌面 ${sentDesktop} 个 / 平台 ${sentPlatform ? 1 : 0} 条）`,
        );
    } else {
        // 这个 warn 是刻意留的：以前这种情况完全静默，出了问题只能靠猜。
        console.warn(
            `[sched] ⚠️ 提醒 job=${job.jobId} 没有送达任何地方` +
                `（桌面无连接、sessionId=${job.sessionId} 也不是平台会话）。内容：${text.slice(0, 60)}`,
        );
    }
    return total;
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
                if (job.kind === "reminder") {
                    // 送没送到都算「触发过」：once 任务不能因为「没连上」而永远 pending 反复推。
                    // 但送达数会被 deliverReminder 如实打日志，不再假装成功。
                    deliverReminder(job);
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

                // ★ 归属人要跟着任务走到下一次。
                //   fireJob 是共享包的纯函数，不认识 ownerKey；不在这里补，
                //   周期任务**从第二次起就没有归属**，到点又只能从 sessionId 猜，
                //   而 workspace:<taskId> 猜出来是「本机」= 主人的桌面。
                //   一次性任务的 bug 会被"只错一次"掩盖，周期任务则是每天错一次。
                if ((job as any).ownerKey && !(next as any).ownerKey) {
                    (next as any).ownerKey = (job as any).ownerKey;
                }

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
