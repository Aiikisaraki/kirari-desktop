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

import {
    planOutreach,
    commitOutreach,
    buildOutreachPrompt,
    localDateKey,
    quietEndAfter as quietEndAfterImpl,
    inQuietHours,
} from "./purpose";
import { loadOrInitPresenceState, savePresenceState } from "./stateStore";
import type { GoalHypothesis, Material, PresenceConfig, PresenceState } from "./types";
import { DEFAULT_PRESENCE_CONFIG } from "./types";
import { jobStore } from "../events/jobStore";
import { createJob } from "kirari-agent";
import { LOCAL_UID, getSetting, setSetting } from "../db/storage";
// 主动联系的「时机」层：补话 / 久未联系（2026-11-25，参考 HaireXe-dsh-bili-whale）。
// 与核心版 src/services/presence/presenceSchedule.js 对称，改一边必须同步另一边。
import * as proactive from "./proactive";
import type { ProactiveLedger, ProactiveTiming } from "./proactive";

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

/**
 * 账本读写（settings_kv 单键 JSON）。与 presence 状态分开存：
 * 账本是「今天说了几次」这种易失计数，塞进 presence 状态会让衰减逻辑变复杂。
 *
 * 键名与核心版逐字相同（proactive_ledger:<uid>）—— 两端共库时，
 * 「刷完B站分享一次」与「久未联系主动开口」必须吃同一份额度，各自记一份就等于没上限。
 */
const LEDGER_KEY = (uid: number) => `proactive_ledger:${uid}`;

/** 读该 uid 的主动账本。没有/坏档一律返回 null（调用方按「今天没说过」处理）。 */
export function readLedger(uid: number = LOCAL_UID): ProactiveLedger | null {
    try {
        const raw = getSetting(LEDGER_KEY(uid));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as ProactiveLedger) : null;
    } catch {
        return null;
    }
}

/** 写账本。失败只告警 —— 主动联系是锦上添花，绝不影响正常调度。 */
export function writeLedger(uid: number, ledger: ProactiveLedger): void {
    try {
        setSetting(LEDGER_KEY(uid), JSON.stringify(ledger));
    } catch (e) {
        console.warn("[presence] 主动账本写入失败:", e instanceof Error ? e.message : e);
    }
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

/** tickProactive / proactiveWithTiming 的可选项。 */
export interface ProactiveOpts {
    /** 该时机的概率（0~1）。缺省 0.35 —— 与核心版同一默认值。 */
    chance?: number;
    /** 对方此刻是否在输入（在输入就别插嘴） */
    userActive?: boolean;
    /** 上一轮对话结束的时刻（补话窗口的起点）；缺省用 state.lastUserAt */
    lastTurnEndAt?: number;
}

export interface ProactiveResult {
    fired: boolean;
    reason: string;
    timing?: ProactiveTiming;
}

/**
 * 检查两个「新时机」是否该主动联系：聊完补话 / 久未联系。
 *
 * 与 tickPresence 的分工：
 *   · tickPresence 是**随机定时**（2.5~5h），回答「她闲着的时候想说点什么」；
 *   · 这里是**关系时机**，回答「她想你了」——刚聊完还有话、或者很久没聊。
 * 两者共用同一份日账本与同一套安静时段/专注模式闸门，避免叠加刷屏。
 *
 * 与核心版的差异只有载体：那边 runner 收 (prompt, uid, goal) 交给机器人回发，
 * 这边 runner 收 (prompt, state, goal) 交给桌宠气泡；闸门、账本、素材、措辞都同源。
 */
export async function tickProactive(
    uid: number = LOCAL_UID,
    now: number = Date.now(),
    opts: ProactiveOpts = {},
): Promise<ProactiveResult> {
    const state = loadOrInitPresenceState(now, uid);
    const cfg = presenceConfig();
    const today = localDateKey(now);

    const timing = proactive.pickTiming({
        now,
        lastUserAt: state.lastUserAt,
        lastSelfAt: state.lastSelfAt,
        lastTurnEndAt: opts.lastTurnEndAt || state.lastUserAt,
        userActive: opts.userActive === true,
    });
    if (!timing) return { fired: false, reason: "不是主动联系的时机" };

    const ledger = readLedger(uid);
    const verdict = proactive.gate({
        cfg,
        ledger,
        today,
        inQuietHours: inQuietHours(cfg, now),
        focus: cfg.focus,
        now,
        chance: opts.chance === undefined ? 0.35 : opts.chance,
    });
    if (!verdict.fire) return { fired: false, reason: verdict.reason, timing: timing.timing };

    if (!runner) return { fired: false, reason: "no runner", timing: timing.timing };

    // 用和 presence tick 同一套素材/目标机制，只把「授权段」换成关系时机的措辞。
    const materials = await briefMaterials();
    const plan = planOutreach({ state, cfg, now, materials });
    const basePrompt = buildOutreachPrompt({ goal: plan.goal, goals: plan.goals, state: plan.state, now, cfg });
    const hours = Math.round(Math.max(0, now - (state.lastUserAt || now)) / 3600000);
    const permission = proactive.buildPermissionBlock({
        ownerTitle: "主人",
        timing: timing.timing,
        hours,
    });

    let ok = false;
    try {
        ok = await runner({ prompt: basePrompt + "\n" + permission, state: plan.state, goal: plan.goal });
    } catch (e) {
        console.warn("[presence] 主动联系 runner 抛错:", e instanceof Error ? e.message : e);
        ok = false;
    }

    if (ok) writeLedger(uid, proactive.markUsed(ledger, today, now));
    return { fired: ok, reason: ok ? timing.reason : "runner failed", timing: timing.timing };
}

/**
 * 带自定义 prompt 的主动开口（供「刚做完某事、想说点什么」的时机用，
 * 例如桌宠端刷完 B站之后想讲讲看到的）。
 *
 * 与 tickProactive 的区别只在素材来源：那边从简报/记忆里挖，这边由调用方直接给。
 * 闸门与账本完全共用 —— 不然「刷完B站说一次」会绕过每日上限，变成刷屏的新通道。
 */
export async function proactiveWithTiming(
    uid: number,
    now: number = Date.now(),
    opts: { prompt?: string; timing?: string; chance?: number } = {},
): Promise<{ fired: boolean; reason: string }> {
    const prompt = String((opts && opts.prompt) || "").trim();
    if (!prompt) return { fired: false, reason: "no prompt" };

    const state = loadOrInitPresenceState(now, uid);
    const cfg = presenceConfig();
    const today = localDateKey(now);
    const ledger = readLedger(uid);

    const verdict = proactive.gate({
        cfg,
        ledger,
        today,
        inQuietHours: inQuietHours(cfg, now),
        focus: cfg.focus,
        now,
        chance: opts && opts.chance !== undefined ? opts.chance : 0.35,
    });
    if (!verdict.fire) return { fired: false, reason: verdict.reason };

    if (!runner) return { fired: false, reason: "no runner" };

    let ok = false;
    try {
        ok = await runner({ prompt, state, goal: null });
    } catch (e) {
        console.warn("[presence] proactiveWithTiming runner 抛错:", e instanceof Error ? e.message : e);
        ok = false;
    }
    if (ok) writeLedger(uid, proactive.markUsed(ledger, today, now));
    return { fired: ok, reason: ok ? "说出来了" : "runner failed" };
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
