// electron/ai/presence/types.ts
// 「在场感内核」的类型与默认配置。
//
// ── 为什么要有这一层 ────────────────────────────────────────────────
// 现在桌宠的链路是「用户说一句 → 模型回一句」：她的全部"内在"只有一段静态人格卡，
// 表现层的 22 个动画状态由 LLM 输出的 emotion 枚举 + 六个互相独立的随机 setTimeout 驱动。
// 于是三件事做不到：
//   ① 她不记得自己刚才是什么心情（情绪是一次性的，不回写）；
//   ② 她不会因为"想你"而主动开口（没有动机，只有用户自己建的定时提醒）；
//   ③ 同一句问候在凌晨两点和早上八点听起来一模一样（没有内部状态可参考）。
// 这一层把「她此刻是什么状态、想要什么、该不该开口」变成可持久化、可单测的纯逻辑。
// 参考 surfcore 的 drives / 目标假设 / 目的排程，见 docs/research/surfcore-realism.md。
//
// ── 设计红线（照抄 surfcore 的 purpose-engine.js）────────────────────
// 本目录**零 import、零 I/O**：状态由调用方读写，时间由调用方传入 now，
// 随机数由调用方注入 rng，模型调用在调用方。这样才能在 vitest 里完整覆盖，
// 也不会把 electron / db 拖进单测。

/** 需求维度：她"想要什么"。桌面宠物是单用户场景，所以没有 surfcore 的 install/consume。 */
export type NeedKey = "connect" | "care" | "play" | "learn" | "share" | "create" | "rest";

/** 驱动的遍历顺序（对象属性顺序不可依赖，统一走这里）。 */
export const NEED_KEYS: readonly NeedKey[] = ["connect", "care", "play", "learn", "share", "create", "rest"];

/** 每个需求的强度 0~1。 */
export type Drives = Record<NeedKey, number>;

/**
 * 轻量情绪。不追求心理学完备，只要求两件事：
 *   ① 每一种都能被规则明确触发（可单测、可解释）；
 *   ② 每一种都能映射到现成的 AvatarState（见 EMOTION_TO_AVATAR）。
 */
export type PresenceEmotion =
    | "content"
    | "lonely"
    | "curious"
    | "worried"
    | "excited"
    | "amused"
    | "bored"
    | "proud"
    | "affectionate"
    | "tired"
    | "envious";

/** 情绪 → 桌宠动画状态。null = 不表态（保持 idle，不要为了有动作而硬演）。 */
export const EMOTION_TO_AVATAR: Record<PresenceEmotion, string | null> = {
    content: null,
    lonely: "sad",
    curious: "head_tilt",
    worried: "head_tilt",
    excited: "excited",
    amused: "happy",
    bored: "stretch",
    proud: "happy",
    affectionate: "shy",
    tired: "stretch",
    envious: "sad",
};

/** 行动倾向：决定了这句话是"分享"还是"索取"。 */
export type PurposeAction = "share" | "ask" | "invite" | "confide" | "curiosity" | "follow" | "care";

/** 素材来源。桌面端能拿到的就这几种，别硬加。 */
export type MaterialSource = "chat" | "memory" | "brief" | "schedule" | "pending" | "time";

/** 一条"值得看的东西"：一句话、一条记忆、一条日程、或者干脆只是时间本身。 */
export interface Material {
    id: string;
    source: MaterialSource;
    text: string;
    at: number;
    /** 是否关于她自己（AI / 桌宠 / 她的形象 / 她的记忆 / 她的人格） */
    selfRef?: boolean;
    /** 是否关于主人 */
    ownerRef?: boolean;
    /** 没解决的问句 / 没兑现的承诺 / 话说了一半 */
    unresolved?: boolean;
    /** -1 负面 / 0 中性 / 1 正面 */
    sentiment?: -1 | 0 | 1;
    /** 0~1 唤醒度（"太突然了""笑死"这种） */
    arousal?: number;
    /** 0~1 重要度（记忆条目的重要度；未知按 0.5） */
    weight?: number;
    /** 钉住（锚点 / 初次相遇 / 用户手动钉）不参与新鲜度衰减 */
    pinned?: boolean;
}

/**
 * 目标假设 —— 注意是**假设**不是结论。
 * 「群友在说这个游戏」不等于「她想玩」；只出现一次的视频不等于她决定了什么。
 * 置信度低的目标只能"问问 / 记下来"，不能写成"我今天特别想玩"。
 */
export interface GoalHypothesis {
    id: string;
    /** 这个目标算谁的：她自己的 / 主人的 / 一条素材的 */
    owner: "self" | "owner" | "media";
    need: NeedKey;
    action: PurposeAction;
    /** 「那件事」——可复述的主题 */
    topic: string;
    /** 一句话说清"她想干嘛"，给提示词用 */
    intent: string;
    /** 0~1 */
    confidence: number;
    value: number;
    urgency: number;
    /** 0~1：越高的目标越只能"问"，不能"说"（花钱 / 装东西 / 联系别人） */
    risk: number;
    status: "hypothesis" | "active" | "confirmed" | "rejected" | "done" | "expired";
    evidenceIds: string[];
    attempts: number;
    createdAt: number;
    lastActionAt?: number;
}

/** 观察账本：同一件事见过几次。防「一次观看变成永久欲望」。 */
export interface Observation {
    /** `domain|object` */
    key: string;
    topic: string;
    seen: number;
    positive: number;
    negative: number;
    lastAt: number;
}

/** 心里惦记的事：主动说过但没聊完的，或主人提到却没下文的。 */
export interface PendingThought {
    id: string;
    text: string;
    at: number;
}

/** 可持久化的全部内在状态。落盘位置建议 ~/.kirari/presence/<uid>.json。 */
export interface PresenceState {
    version: 1;
    drives: Drives;
    drivesAt: number;
    /** 最近一次 appraisal 的结论 */
    mood: { emotion: PresenceEmotion; intensity: number; at: number; reason: string } | null;
    affinity: number;
    lastUserAt: number;
    lastSelfAt: number;
    lastOutreachAt: number;
    /** 当天已经主动说了几次 */
    outreachDate: string;
    outreachToday: number;
    goals: GoalHypothesis[];
    observations: Record<string, Observation>;
    pending: PendingThought[];
    /** 上一次投递时间点（落盘，重启后仍能算"该不该出发"） */
    nextFireAt: number;
    lastGoalId: string;
    /**
     * 最近 3 次开口用的是哪个需求。
     * 用途：需求轮换 —— 连续两次都在「陪」，第三次就该换维度了，
     * 否则她的人设会被聊成单曲循环（surfcore 给这一项打折 0.72 / 0.65）。
     */
    recentNeeds: NeedKey[];
}

export interface PresenceConfig {
    enabled: boolean;
    /** 专注模式（不主动打扰）。与桌宠右键菜单同一个开关，由调用方写入。 */
    focus: boolean;
    /** 两枪之间的最短 / 最长间隔 */
    gapMinMs: number;
    gapMaxMs: number;
    /** 首次启动 / 重启后的起跑延迟 */
    initialDelayMs: number;
    /** 每天最多主动开口几次（0 = 不限） */
    dailyMax: number;
    /** 安静时段（含起点不含终点，可跨零点）。两个值相同 = 不设。 */
    quietStart: string;
    quietEnd: string;
    /** 主人最近说过话之后，至少安静这么久才插嘴 */
    idleThresholdMs: number;
    /** 素材窗口 */
    materialWindowMs: number;
    /** 低于这个素材数且没有 pending 就这轮不硬找话 */
    minMaterials: number;
    /** 提示词里最多给几个候选方向 */
    maxGoals: number;
    /** 投递失败后的重试间隔 */
    retryMs: number;
    /** 连续失败几次后放弃这一枪，回到正常间隔 */
    maxAttempts: number;
    /** 「惦记的事」保留天数 */
    pendingTtlDays: number;
    /** 去重用的历史条数 */
    historyLimit: number;
}

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
    enabled: true,
    focus: false,
    gapMinMs: 2.5 * 3600_000,
    gapMaxMs: 5 * 3600_000,
    initialDelayMs: 20 * 60_000,
    dailyMax: 4,
    quietStart: "23:30",
    quietEnd: "08:00",
    idleThresholdMs: 30 * 60_000,
    materialWindowMs: 72 * 3600_000,
    minMaterials: 1,
    maxGoals: 5,
    retryMs: 15 * 60_000,
    maxAttempts: 3,
    pendingTtlDays: 14,
    historyLimit: 40,
};
