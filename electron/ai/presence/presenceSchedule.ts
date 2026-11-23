// electron/ai/presence/presenceSchedule.ts
// 目的机制的调度层：注册 presence_tick 任务、准备素材、调用 runner，把结果送出去。
//
// ── 为什么复用 scheduledJobsService ────────────────────────────────
// 那边已经有 15 秒扫描 + 落盘 job + 停机补跑 + 两条送达腿（桌面/平台）。
// 目的机制不需要自己的定时器 —— 新增一种 job kind 就行。
// planOutreach 内部自己算 nextFireAt（2.5~5h 随机 + 安静时段避让），
// 每次触发后把 dueAt 顺延到那个时间点；重启后扫表即恢复，和简报任务同构。
//
// ── 素材从哪来（第一版）────────────────────────────────────────────
//   · 今日简报（daily_brief 已在跑，生成后从 daily_memory 读出来 —— 白捡的素材源）
//   · 惦记的事（state.pending，由 runner 注入）
//   · 时间本身（energyAt / 安静时段，planOutreach 自己处理）
// 桌面观察（前台窗口/空闲时长）是 P1，等隐私拍板后再加。
//
// runner 由主进程注入（和 briefSchedule.setBriefRunner 同一模式）：
// 调度模块不认识模型配置与 AiContext，保持「调度」与「凭证」分离。

import { planOutreach, commitOutreach, buildOutreachPrompt, localDateKey, quietEndAfter as quietEndAfterImpl } from "./purpose";
import { loadOrInitPresenceState, savePresenceState } from "./stateStore";
import type { GoalHypothesis, Material, PresenceConfig, PresenceState } from "./types";
import { DEFAULT_PRESENCE_CONFIG } from "./types";
import { jobStore } from "../events/jobStore";
import { createJob } from "kirari-agent";
import { LOCAL_UID } from "../db/storage";

const PRESENCE_JOB_ID = "presence:tick";
/** 扫描兜底间隔：即使状态档丢了（重置），最迟也按这个间隔重跑一次 tick。 */
const FALLBACK_SCAN_MS = 60 * 60_000;

/**
 * kirari-agent 的 JobKind 是闭联联合（reminder | daily_brief），没有 presence_tick。
 * workspace_task 也是这么扩的（scheduledJobsService 里比较时 as never）。
 * 把强转收在这一个函数里，别处保持类型干净。
 */
function presenceJobKind(): "reminder" {
    return "presence_tick" as never;
}

/** 到点后干什么，由主进程注入。返回 true = 真的说出去了。 */
export type PresenceRunner = (input: {
    prompt: string;
    state: PresenceState;
    goal: GoalHypothesis | null;
}) => Promise<boolean>;

let runner: PresenceRunner | null = null;

export function setPresenceRunner(r: PresenceRunner | null): void {
    runner = r;
}

/** 聚焦模式的开关（桌宠右键菜单写，主进程读后传进来）。 */
let focusProvider: () => boolean = () => false;

export function setFocusProvider(p: () => boolean): void {
    focusProvider = p;
}

/** 配置（第二版可以进设置页；先给合理默认 + 专注模式开关）。 */
export function presenceConfig(): PresenceConfig {
    return { ...DEFAULT_PRESENCE_CONFIG, focus: focusProvider() };
}

/** 读今日简报当素材。没有/失败返回空数组 —— 简报本来就可能没生成。 */
async function briefMaterials(): Promise<Material[]> {
    try {
        const briefing = await import("../services/dailyBriefingService");
        const brief = await briefing.readTodayBrief(1);
        if (!brief) return [];
        return [{ id: `brief-${briefing.todayStr()}`, source: "brief", text: brief, at: Date.now(), ownerRef: true }];
    } catch (e) {
        console.warn("[presence] 读简报素材失败（跳过）:", e instanceof Error ? e.message : e);
        return [];
    }
}

/**
 * 跑一次 tick：闸门判断 → 选目标 → 出提示词。
 * 返回 fire 与否；无论结果如何都把状态写回（闸门 reason 也在里面）。
 * 这个函数不碰模型、不碰 IPC —— 那是 runner 的事。
 */
export async function tickPresence(now = Date.now()): Promise<{ fired: boolean; reason: string }> {
    const state = loadOrInitPresenceState(now);
    const cfg = presenceConfig();
    const materials = await briefMaterials();
    const plan = planOutreach({ state, cfg, now, materials });

    if (!plan.fire) {
        // 没到点/安静时段/没素材：状态（观察账本可能更新过）落盘。
        // job 的顺延统一由 scanOnce 收口（nextFireAt 覆盖段），这里不双写。
        savePresenceState(plan.state);
        return { fired: false, reason: plan.reason };
    }

    if (!runner) {
        console.warn("[presence] 到点了但没有 runner，这轮放弃（不记失败，等下一枪）");
        return { fired: false, reason: "no runner" };
    }

    const prompt = buildOutreachPrompt({ goal: plan.goal, goals: plan.goals, state: plan.state, now, cfg });
    let ok = false;
    try {
        ok = await runner({ prompt, state: plan.state, goal: plan.goal });
    } catch (e) {
        console.warn("[presence] runner 抛错:", e instanceof Error ? e.message : e);
        ok = false;
    }

    // 记账：sent / failed。silent（模型回 SKIP）由 runner 自己转成 false 之外的第
    // 三种结果？第一版简化：runner 返回 false 一律按 failed 记（重试 maxAttempts 次）。
    const after = commitOutreach(plan.state, {
        goal: plan.goal,
        now,
        kind: ok ? "sent" : "failed",
        cfg,
    });
    savePresenceState(after);
    // job 顺延由 scanOnce 收口（见上）
    return { fired: ok, reason: ok ? (plan.goal?.intent ?? "") : "runner failed" };
}

/** 今天主动说过几次（设置页展示用）。 */
export function outreachToday(now = Date.now()): number {
    const state = loadOrInitPresenceState(now);
    return state.outreachDate === localDateKey(now) ? state.outreachToday : 0;
}

/** 调度器读当前状态（覆盖 dueAt 用）。 */
export function readState(now = Date.now()): PresenceState | null {
    return loadOrInitPresenceState(now);
}

/** 安静时段结束时刻（调度器防热循环兜底用）。 */
export function quietEndAfter(now: number): number {
    return quietEndAfterImpl(DEFAULT_PRESENCE_CONFIG, now);
}

/**
 * 补齐/校正 presence_tick 任务。
 *   · 不存在 → 新建（dueAt = 状态档里的 nextFireAt，兜底 1 小时后）；
 *   · 已终态/丢失 → 恢复为 pending 并顺延到 nextFireAt；
 *   · pending → 不动（调度器到点自己跑）。
 * 与 briefSchedule.ensureJobs 同构：停机期间过期的 job 会在首扫补跑一次 ——
 * 补跑安全，因为 tickPresence 的闸门会挡住"现在不该说话"的情况。
 */
export function ensureJob(now = Date.now()): void {
    const state = loadOrInitPresenceState(now);
    const dueAt = Math.max(now + 60_000, state.nextFireAt || now + FALLBACK_SCAN_MS);
    const existing = jobStore.get(PRESENCE_JOB_ID);
    if (!existing) {
        jobStore.save(
            createJob({
                jobId: PRESENCE_JOB_ID,
                sessionId: "presence",
                origin: "desktop",
                uid: LOCAL_UID,
                kind: presenceJobKind(),
                title: "主动搭话 tick",
                payload: "",
                dueAt,
                recurrence: "daily",
                now,
            }),
            "job_created",
        );
        console.log(`[presence] tick 任务已创建，下次 ${new Date(dueAt).toLocaleString()}`);
        return;
    }
    if (existing.status !== "pending") {
        jobStore.save(
            {
                ...existing,
                kind: presenceJobKind(),
                recurrence: "daily",
                status: "pending",
                dueAt,
                updatedAt: now,
            },
            "job_created",
        );
        console.log(`[presence] tick 任务已恢复，下次 ${new Date(dueAt).toLocaleString()}`);
    }
}

// job 的每次顺延统一由 scheduledJobsService.scanOnce 收口：
// tickPresence 只负责更新状态档里的 nextFireAt，调度器扫表后用它覆盖 fireJob 的 +24h。
// 曾经在这里也写了一次 job —— 与 scanOnce 的 fireJob 双写，lastFiredAt 会丢，已删。
