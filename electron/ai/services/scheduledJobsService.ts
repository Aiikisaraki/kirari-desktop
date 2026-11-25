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
import { getOwnerKeySync, LOCAL_UID } from "../db/storage";
// 2026-11-20 规范化：身份比较一律走 samePerson（两侧先归一），
// 不再在各处手写 ownerKey === "_local" / !== desktopOwner。
import { FALLBACK, samePerson } from "./ownerIdentity";
import * as briefSchedule from "./briefSchedule";
import * as workspaceTask from "./workspaceTask";
// 在场感：她的主动搭话走同一条调度链（到点 → tickPresence → runner 决定说不说）。
import * as presenceSchedule from "../presence/presenceSchedule";

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
 * 这条提醒该不该在**主人的桌面**上开口？
 *
 * ── 在防什么（2026-11-20 用户澄清后重写）──────────────────────────
 *   「桌面端本就只有主人能连，这是我自己的桌宠，机器人是它的智能核心，
 *     别人怎么可能连接我的机器人的大脑呢，让她和其他人对话也是建立在我的人际
 *     关系上」
 *
 * 说得对 —— 桌宠只有这一台，**不存在"别人的桌面"**。所以这里不判"连接归谁"，
 * 只判一件事：这条提醒**归谁**，是不是这台桌面的人。
 *
 * 她在 QQ 上同时跟很多人说话。朋友的提醒到点时，正确去向是回 QQ 给朋友本人；
 * 如果也往桌面塞一份，主人看到的就是「她的任务怎么跑到我这儿来了」—— 报障原话。
 *
 * 取值语义：
 *   · `_local`       本机桌面自己建的提醒 → 就是给这台桌面的，收
 *   · 空            老任务没有归属字段 → 照常收（不因噎废食）
 *   · 等于本机主人   → 收
 *   · 其他任何人     → 不收，走平台那条腿回给他
 *   · 查不到主人是谁（全新装机）且这条有归属 → fail-closed，不收
 *
 * @param job 待送达的任务
 * @param ownerOfSystem 本机主人是谁；省略时按需从库里查（单测可直接传）
 */
export function shouldSpeakOnDesktop(
    job: ScheduledJob,
    ownerOfSystem?: string | null,
): boolean {
    const ownerKey = String((job as any).ownerKey || "").trim();
    // 没有归属信息（老任务）或本机自建 → 不拦。
    if (!ownerKey) return true;

    let desktopOwner = ownerOfSystem;
    if (desktopOwner === undefined) {
        try {
            desktopOwner = getOwnerKeySync();
        } catch {
            desktopOwner = null;
        }
    }

    // ── 2026-11-20 规范化：归属判断一律走 samePerson ──────────────────
    // 原来这里有两处手写比较：
    //     if (!ownerKey || ownerKey === "_local") return true;
    //     if (ownerKey !== desktopOwner) return false;
    // 两者叠加的后果是：存成 '_local' 的老提醒**无条件注入桌面**（不管
    // 它是谁的），而存成本机会话 UUID 的提醒反而因为 !== '1980308740'
    // 被拒。一个过宽、一个过窄，方向还相反 —— "打补丁"留下的典型形状。
    //
    // 归一后的语义分三层：
    //   ① '_local' 是「本机自建」这个**来源标记**，与"主人是谁"无关，
    //      所以直接放行（它只可能是本机建的，不可能是别人远程塞进来的）。
    //      其余「其实就是本机主人」的写法（本机会话 UUID）交给 ③ 的
    //      samePerson 认，不放宽成"只要不像客人就收"。
    if (ownerKey === FALLBACK) return true;

    if (!desktopOwner) {
        console.warn(
            `[sched] 提醒 job=${job.jobId} 有归属 ${ownerKey} 但查不到本机主人，不注入桌面`,
        );
        return false;
    }
    if (!samePerson(ownerKey, desktopOwner, desktopOwner)) {
        console.log(
            `[sched] 提醒 job=${job.jobId} 归属 ${ownerKey} 不是本机主人，不注入桌面`,
        );
        return false;
    }
    return true;
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

    // ① 桌面 —— 先判该不该让它在**主人的桌面**上开口，见 shouldSpeakOnDesktop
    if (deliverDesktop && shouldSpeakOnDesktop(job)) {
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

/**
 * 一次性提醒的「过期容忍窗口」：超过这么久还没送出去的 once 提醒，直接结掉，不再补发。
 *
 * ── 在防什么（2026-11-25 用户报障，桌宠端先出现的同款问题）────────────
 *   「能不能把这测试任务清理掉，我每次启动都会触发」
 *
 * 根因不是清理没做，而是调度器对 once 任务的语义太宽：
 *   · once 任务的 status 只有 pending / fired / cancelled，没有「已过期」这个终态；
 *   · 进程停机期间的 once 任务会一直躺在 pending 里；
 *   · 每次启动首扫把 due_at <= now 的 pending 全部补发一次 ——
 *     于是一条两周前的测试提醒，每次开机都会再念一遍，永久重复。
 *
 * 补发本身是对的（用户 2026-11-19 要的就是「关机期间的提醒开机补上」），
 * 但不能无限期补：窗口内补发保住原意，窗口外的静默清掉并写清日志。
 */
export const ONCE_CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * 这条一次性提醒是不是已经过期到不值得补发了。
 *
 * 抽成独立纯函数是为了可测：调度器里「送没送到」很难在单测中断言，
 * 但「该不该送」可以一行钉死（见 electron/ai/services/scheduledJobs.spec.ts）。
 * 与核心版 scheduledJobsService.isStaleOnceReminder 同一语义。
 *
 * 周期任务（daily）永远返回 false —— 迟到一天也该补跑。
 *
 * @param job 待判定的任务
 * @param now 当前毫秒
 * @returns true = 已过期，不补发
 */
export function isStaleOnceReminder(
    job: { recurrence?: string; dueAt?: number } | null | undefined,
    now: number,
): boolean {
    if (!job || job.recurrence !== "once") return false;
    const due = Number(job.dueAt);
    if (!Number.isFinite(due)) return false;
    return now - due > ONCE_CATCHUP_WINDOW_MS;
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
                    // 一次性提醒超出补发窗口 = 已经没意义了：直接结掉，不补发。
                    // 必须在 deliverReminder **之前**判，否则用户开机就会被两周前的旧提醒刷屏。
                    if (isStaleOnceReminder(job, now)) {
                        const lateMinutes = Math.round((now - job.dueAt) / 60_000);
                        console.log(
                            `[sched] 提醒 job=${job.jobId} 已过期 ${lateMinutes} 分钟，超出补发窗口，标记结束（不补发）`,
                        );
                        jobStore.save({ ...job, status: "fired", updatedAt: now }, "job_fired");
                        continue;
                    }
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
                } else if (job.kind === ("presence_tick" as never)) {
                    // 在场感主动搭话：tickPresence 内部自己判闸门（安静时段/每日上限/素材），
                    // 没 fire 也会返回下一次该跑的时间 —— 把 job 顺延到那个点。
                    const result = await presenceSchedule.tickPresence(now);
                    if (result.fired) {
                        console.log(`[sched] presence 主动搭话完成：${result.reason}`);
                    }
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

                // presence_tick 的间隔不是 24h：2.5~5h 区间随机 + 安静时段避让，
                // 都算在状态档的 nextFireAt 里（tickPresence 里 scheduleNext 的产物）。
                // fireJob 的 daily 语义只会 +24h，必须在这里覆盖回去，否则她一天最多开口一次。
                // ⚠️ nextFireAt 已经过去时（比如到点被安静时段挡下）不能退回 now+60s ——
                // 那会变成安静时段里每分钟热循环；改用 quietEndAfter 推到安静时段结束。
                if (job.kind === ("presence_tick" as never) && next.status === "pending") {
                    const state = presenceSchedule.readState(now);
                    const want = state?.nextFireAt || 0;
                    const overridden =
                        want > now ? want : presenceSchedule.quietEndAfter(now) || now + 60 * 60_000;
                    next.dueAt = overridden;
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

// ── 主动联系：久未联系的检查周期（2026-11-25）────────────────────────
// 每 10 分钟看一次「是不是很久没跟主人说话了」，比 presence tick（2.5~5h）灵敏得多。
// 为什么不用 job：这是个**关系时机**，不是一件「事」—— 塞进 scheduled_jobs
// 会变成一条永远 pending 的记录，还会被 once/daily 语义纠缠。独立定时器更干净。
export const PROACTIVE_CHECK_MS = 10 * 60 * 1000;
let proactiveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 检查一次久未联系。失败只 warn —— 主动联系是锦上添花，绝不能影响正常调度。
 *
 * 与核心版的差异只有「查谁的」：核心版是多用户服务，从 api_tokens 里取最近活跃的 uid；
 * 桌宠端是单机单主人，uid 恒为 LOCAL_UID，不需要也没有那张表。
 * 时机/闸门/账本全部走 presenceSchedule.tickProactive，两端同一套。
 */
export async function tickProactiveIdle(now = Date.now()): Promise<void> {
    try {
        await presenceSchedule.tickProactive(LOCAL_UID, now, {});
    } catch (e) {
        console.warn("[sched] 久未联系检查失败（已忽略）:", e instanceof Error ? e.message : e);
    }
}

export function start(): void {
    if (timer) return;
    void scanOnce();
    timer = setInterval(() => {
        void scanOnce();
    }, SCAN_INTERVAL_MS);
    // 久未联系：独立定时器，10 分钟一次（见 PROACTIVE_CHECK_MS 注释）
    if (!proactiveTimer) {
        proactiveTimer = setInterval(() => {
            void tickProactiveIdle();
        }, PROACTIVE_CHECK_MS);
        proactiveTimer.unref?.();
    }
    timer.unref?.();
    console.log("[sched] 定时任务调度器已启动（每 15s 扫描）");
}

export function stop(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (proactiveTimer) {
        clearInterval(proactiveTimer);
        proactiveTimer = null;
    }
}
