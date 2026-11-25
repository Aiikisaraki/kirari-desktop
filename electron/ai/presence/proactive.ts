// electron/ai/presence/proactive.ts
// 主动联系的「时机」层：除了随机 tick，再补两个更自然的时机。
//
// ── 在解决什么（用户 2026-11-25：「尤其是她还可以主动联系我」）──────
// 原来她只在 presence tick（2.5~5h 随机）那一刻才可能开口。问题是：
//   · tick 是「她闲着没事」的时机，不是「她想你了」的时机；
//   · 聊完就消失，中间那句「其实我还想说」永远没机会说出来；
//   · 你一整天不找她，她也不会想起你 —— 变成永远是你找她。
//
// 参考 HaireXe-d/HaireXe-dsh-bili-whale 的 lib/proactive.js，补两个时机：
//   ① 聊完补话：她刚回完，30~90 秒后可能再补一句（像突然想到）
//   ② 久未联系：很久没聊时，她按概率主动开腔
//
// ── 为什么不做成「系统直接替她发」────────────────────────────────
// 消息内容得她自己写（人设、语气、当天心情）。系统代写就成了定时通知，
// 那不是「想你」，是「打卡」。所以这里和 presence tick 一样：
// 只负责决定「这次要不要说」+「告诉她可以说」，正文交给模型。
//
// ── 纪律 ────────────────────────────────────────────────────────
//   · 纯逻辑：now / rng 一律注入，零 I/O（账本由调用方读写）；
//   · 三个时机**共用同一份日账本**，不然一天能被她找八回；
//   · 安静时段一律不主动（半夜三点找人很怪）；
//   · 拒绝是正常选项：提示里必须写明「不想说就跳过」。
//
// 与核心版 src/services/presence/proactive.js 逐字对称：改一边必须同步另一边。
// 两端对齐的机器闸门见 electron/ai/presence/proactive.spec.ts 与核心版
// scripts/smoke-proactive.js（同一批断言，33 项）。

// ── 类型（JS 版没有，TS 版补上；逻辑与常量一字不改）──────────────────

/** 两个关系时机：聊完补话 / 久未联系。互斥，同一轮只会命中一个。 */
export type ProactiveTiming = "followup" | "idle";

/** 注入随机源（测试用）。默认 Math.random。 */
export type Rng = () => number;

/**
 * 主动联系账本：今天已经主动说过几次。
 * 与 presence 状态分开存（settings_kv 单键 JSON，键 proactive_ledger:<uid>）——
 * 它只是「今天说了几次」这种易失计数，塞进 presence 状态会让衰减逻辑变复杂。
 */
export interface ProactiveLedger {
    /** YYYY-MM-DD（本地日期键，不能用 UTC） */
    date: string;
    /** 当天累计次数 */
    count: number;
    /** 最后一次记账的时刻 */
    at?: number;
}

/** pickTiming 的输入。全部可选：调用方拿不到的时刻按 0 处理（等于「没有」）。 */
export interface PickTimingInput {
    /** 当前毫秒 */
    now?: number;
    /** 对方上次说话的时刻 */
    lastUserAt?: number;
    /** 她上次开口的时刻 */
    lastSelfAt?: number;
    /** 上一轮对话结束的时刻（用于补话窗口） */
    lastTurnEndAt?: number;
    /** 对方此刻是否在输入（在输入就别插嘴） */
    userActive?: boolean;
}

/** 命中的时机与说给人听的理由。 */
export interface TimingVerdict {
    timing: ProactiveTiming;
    reason: string;
}

/** 闸门需要的配置子集（presence 配置本来就带这几个字段）。 */
export interface GateConfig {
    enabled?: boolean;
    focus?: boolean;
    /** 每天最多主动开口几次（0 / 缺省 = 不限） */
    dailyMax?: number;
}

/** 闸门输入：两个时机与随机 tick 共用这一套。 */
export interface GateInput {
    /** presence 配置（dailyMax / quietStart / quietEnd / focus） */
    cfg?: GateConfig;
    /** 主动账本 */
    ledger?: ProactiveLedger | null;
    /** YYYY-MM-DD */
    today: string;
    /** 是否在安静时段 */
    inQuietHours?: boolean;
    /** 是否专注模式（不打扰） */
    focus?: boolean;
    now?: number;
    rng?: Rng;
    /** 该时机的概率 */
    chance?: number;
}

/** 闸门结论：fire=false 时 reason 是「为什么没说」，可直接打日志。 */
export interface GateVerdict {
    fire: boolean;
    reason: string;
}

/** 授权段的选项。timing 非法时返回空串（不该给授权）。 */
export interface PermissionOpts {
    /** 称呼 */
    ownerTitle?: string;
    timing?: string;
    /** 久未联系的小时数（idle 时用） */
    hours?: number;
}

/** 聊完补话的等待窗口（毫秒）：回完 30~90 秒再决定要不要补一句。 */
export const FOLLOWUP_MIN_MS = 30 * 1000;
export const FOLLOWUP_MAX_MS = 90 * 1000;

/** 久未联系的门槛：至少 3 小时没聊过，才考虑主动找人。 */
export const IDLE_MIN_MS = 3 * 3600000;

/** 久未联系的检查周期：每 10 分钟看一次，不频繁。 */
export const IDLE_CHECK_MS = 10 * 60000;

/**
 * 掷一次骰子。
 * @param chance 0~1
 * @param rng 注入随机源（测试用）
 */
export function roll(chance: number, rng?: Rng): boolean {
    const p = Number(chance);
    if (!Number.isFinite(p) || p <= 0) return false;
    if (p >= 1) return true;
    return (rng || Math.random)() < p;
}

/**
 * 哪个时机该考虑开口了。两个时机互斥，返回一个。
 *
 * @param input now / lastUserAt / lastSelfAt / lastTurnEndAt / userActive
 */
export function pickTiming(input: PickTimingInput): TimingVerdict | null {
    const o = input || {};
    const now = Number(o.now) || Date.now();
    const lastUserAt = Number(o.lastUserAt) || 0;
    const lastSelfAt = Number(o.lastSelfAt) || 0;
    const lastTurnEndAt = Number(o.lastTurnEndAt) || 0;
    if (o.userActive === true) return null;
    // 她最近已经开过口 → 两个时机都不算（避免连发）
    if (lastSelfAt && now - lastSelfAt < IDLE_MIN_MS) return null;

    // ① 聊完补话：刚回完不久，且对方没再接话
    if (lastTurnEndAt && lastUserAt <= lastTurnEndAt) {
        const gap = now - lastTurnEndAt;
        if (gap >= FOLLOWUP_MIN_MS && gap <= FOLLOWUP_MAX_MS) {
            return { timing: "followup", reason: "刚聊完，可能还有一句没说" };
        }
    }

    // ② 久未联系：很久没聊
    const silence = now - lastUserAt;
    if (lastUserAt && silence >= IDLE_MIN_MS) {
        const hours = Math.round(silence / 3600000);
        return { timing: "idle", reason: "已经 " + hours + " 小时没说话了" };
    }
    return null;
}

/**
 * 今天已经主动说过几次。
 */
export function usedToday(ledger: ProactiveLedger | null | undefined, today: string): number {
    if (!ledger || ledger.date !== today) return 0;
    return Number(ledger.count) || 0;
}

/**
 * 记一次。**只有真的投递出去才记账** —— 失败了下次还有机会，
 * 不然「生成失败」会白白吃掉一次额度。
 */
export function markUsed(ledger: ProactiveLedger | null | undefined, today: string, now: number): ProactiveLedger {
    const count = usedToday(ledger, today);
    return { date: today, count: count + 1, at: now };
}

/**
 * 「体验版」闸门：两个时机与随机 tick 共用这一套，避免三重叠加刷屏。
 */
export function gate(input: GateInput): GateVerdict {
    const o = input || ({} as GateInput);
    const cfg = o.cfg || {};
    if (cfg.enabled === false) return { fire: false, reason: "主动联系关着" };
    if (o.focus === true || cfg.focus === true) return { fire: false, reason: "专注模式（不主动打扰）" };
    if (o.inQuietHours === true) return { fire: false, reason: "安静时段" };
    const used = usedToday(o.ledger, o.today);
    const dailyMax = Number(cfg.dailyMax);
    if (Number.isFinite(dailyMax) && dailyMax > 0 && used >= dailyMax) {
        return { fire: false, reason: "今天已经主动说过 " + used + " 次" };
    }
    if (!roll(o.chance as number, o.rng)) return { fire: false, reason: "这一轮没掷中" };
    return { fire: true, reason: "可以说" };
}

/**
 * 拼进 system 的「可以主动联系」授权段。
 *
 * 措辞纪律（照 HaireXe 的教训）：
 *   · 给的是**许可和边界**，不是任务清单 —— 写成任务就成了定时汇报；
 *   · 必须写明「不想说就跳过」，否则她会为了完成任务硬找话；
 *   · 不许提「系统让我发的」，否则角色立刻破。
 *
 * @returns 空串表示不该给授权
 */
export function buildPermissionBlock(opts?: PermissionOpts): string {
    const o = opts || {};
    const timing = o.timing;
    if (timing !== "followup" && timing !== "idle") return "";
    const who = "「" + (o.ownerTitle || "主人") + "」";
    const lines = [""];
    if (timing === "followup") {
        lines.push("【可以再补一句】");
        lines.push("你刚跟 " + who + " 聊完，心里还有点没说出来的 —— 可能是余温，也可能是刚想到的。");
        lines.push("· 想说就说，**不想说就跳过**（不想说是正常选项，不是任务）。");
        lines.push("· 一到两句就够，短。不追问、不重开一个话题。");
        lines.push("· 他如果不回，就让它停在那儿；别连发。");
    } else {
        const hours = Number(o.hours) > 0 ? Math.round(Number(o.hours)) + " 个多小时" : "挺久";
        lines.push("【有点想起他】");
        lines.push("距上次跟 " + who + " 说话，已经过了 " + hours + "。");
        lines.push("不是任务，也不是提醒 —— 只是你现在想起了他。");
        lines.push("· 想找他说话就说；没什么想说的就继续过你的，**完全没问题**。");
        lines.push("· 最多两三句，短；一行一个念头。");
        lines.push("· 不要问「你在忙吗」「在不在」这种试探性开场，除非你真想问。");
        lines.push("· 不要汇报你今天看了什么 —— 说你想说的，不是交作业。");
        lines.push("· 他可能不回，别追。");
    }
    lines.push("· 别说这是「系统让我发的」或「到点了」—— 是你自己想起来他了。");
    return lines.join("\n");
}

