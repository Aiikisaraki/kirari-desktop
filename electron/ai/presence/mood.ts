// electron/ai/presence/mood.ts
// 驱动 / 需求词表 / 情绪评价 / 生理节律 —— 「她此刻是什么状态」的纯逻辑。
//
// 参考 surfcore 的 purpose-engine.js §2.1~2.5，但砍掉了依赖 QQ 群与 B站的维度：
// 桌面宠物只有一个对话者，素材只来自他们之间的对话、记忆、日程和时间本身。

import type { Drives, Material, NeedKey, PresenceEmotion, PresenceState } from "./types";
import { NEED_KEYS } from "./types";

const clamp01 = (n: number): number =>
    Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

export { clamp01 };

/** 驱动的基线：她"闲着"时就是这个样子。 */
export const DRIVE_DEFAULTS: Drives = {
    connect: 0.45,
    care: 0.3,
    play: 0.35,
    learn: 0.3,
    share: 0.35,
    create: 0.25,
    rest: 0.3,
};

/**
 * 驱动半衰期 8 小时。
 * 「想玩」这件事过一夜就该淡下去 —— 否则一次没被满足的欲望会滚成执念，
 * 表现出来就是她每天同一句话反复说。这是 surfcore 反复踩过的坑。
 */
export const DRIVE_HALF_LIFE_MS = 8 * 3600_000;

/** 向默认值指数衰减：d' = base + (d - base) × 0.5^(Δt / HALF_LIFE) */
export function decayDrives(
    drives: Drives,
    from: number,
    to: number,
    defaults: Drives = DRIVE_DEFAULTS,
): Drives {
    const span = Math.max(0, to - from);
    const remain = Math.pow(0.5, span / DRIVE_HALF_LIFE_MS);
    const out = { ...defaults };
    for (const key of NEED_KEYS) {
        const base = defaults[key];
        out[key] = clamp01(base + ((drives[key] ?? base) - base) * remain);
    }
    return out;
}

/** 有人/有事把某个需求推高。gain 是"这件事有多戳她"。 */
export function bumpDrives(drives: Drives, needs: Partial<Record<NeedKey, number>>, gain = 1): Drives {
    const out = { ...drives };
    for (const key of NEED_KEYS) {
        const amount = needs[key];
        if (!amount) continue;
        out[key] = clamp01(out[key] + amount * gain);
    }
    return out;
}

/**
 * 需求词表（启发式，不是语义模型）。
 * 换圈子 / 换语言要补词 —— surfcore 的教训：词表是这套机制唯一的"知识"，
 * 它不懂新梗，只认词。
 */
const NEED_WORDS: Record<NeedKey, readonly string[]> = {
    connect: ["想你", "陪我", "在一起", "孤单", "寂寞", "一个人", "无聊", "抱抱", "在吗", "理我", "聊天", "说说话"],
    care: ["累", "困", "加班", "考试", "面试", "生病", "头疼", "头痛", "痛", "难受", "不舒服", "胃疼", "压力", "下雨", "降温", "感冒", "熬夜", "记得吃", "睡好"],
    play: ["玩", "游戏", "联机", "攻略", "追番", "看番", "电影", "新番", "手游", "上分", "逛"],
    learn: ["为什么", "原理", "教程", "怎么", "学习", "研究", "解析", "代码", "bug", "报错", "实现"],
    share: ["笑死", "离谱", "好看", "可爱", "震惊", "哈哈", "刚看到", "发现", "好好听", "绝了"],
    create: ["写", "画", "剪", "做个", "设计", "主题", "脚本", "视频", "封面", "企划"],
    rest: ["睡", "休息", "晚安", "困了", "眯一会", "打盹", "起不来", "好累"],
};

/** 一段话指向哪些需求（0~1/维）。命中越多越强，但单维不会超过 1。 */
export function needAffinity(text: string): Partial<Record<NeedKey, number>> {
    const src = String(text || "");
    const out: Partial<Record<NeedKey, number>> = {};
    if (!src) return out;
    for (const key of NEED_KEYS) {
        let hits = 0;
        for (const word of NEED_WORDS[key]) {
            if (src.includes(word)) hits++;
        }
        if (hits > 0) out[key] = clamp01(0.45 + 0.25 * (hits - 1));
    }
    return out;
}

// 极性词表刻意不收裸「好」：中文里「好累」「好烦」「好难」是负面，
// 一个「好」字会把它们全判成正向 —— 这是第一版单测抓到的真 bug。
const POSITIVE_WORDS = ["太好了", "好棒", "喜欢", "开心", "可以", "一起", "哈哈", "谢谢", "可爱", "厉害", "不错", "想试试"];
const NEGATIVE_WORDS = ["不要", "没空", "不想", "算了", "烦", "难过", "生气", "滚", "别", "累", "加班", "崩溃", "讨厌", "疼", "痛", "难受", "压力"];

/** 情绪极性：-1 / 0 / 1。只用于"她对这件事是什么感受"，不用于判断用户意图。 */
export function sentimentOf(text: string): -1 | 0 | 1 {
    const src = String(text || "");
    if (!src) return 0;
    let score = 0;
    for (const w of POSITIVE_WORDS) if (src.includes(w)) score += 1;
    for (const w of NEGATIVE_WORDS) if (src.includes(w)) score -= 1;
    if (score > 0) return 1;
    if (score < 0) return -1;
    return 0;
}

/** 唤醒度：标点、感叹、重复字。0~1。 */
export function arousalOf(text: string): number {
    const src = String(text || "");
    if (!src) return 0;
    let score = 0;
    if (/[!！]{1,}/.test(src)) score += 0.3;
    if (/[?？]{1,}/.test(src)) score += 0.1;
    if (/(.)\1{2,}/.test(src)) score += 0.2; // 「好好好」「啊啊啊」
    if (/[😂😭🥹😳😡🥰]$/u.test(src)) score += 0.2;
    return clamp01(score);
}

/**
 * 生理节律：浅睡眠 0.15 → 早晨回升 → 午后小低 → 傍晚最高 → 深夜下降。
 * 用来两件事：休息驱动、以及"深夜回复要短一点"的倾向。
 */
export function energyAt(hour: number): number {
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    if (h >= 2 && h < 6) return 0.15;
    if (h < 9) return 0.45;
    if (h < 12) return 0.8;
    if (h < 15) return 0.6;
    if (h < 19) return 0.85;
    if (h < 23) return 0.6;
    return 0.3;
}

/** 中文时段名，给提示词/气泡用。 */
export function daypartName(hour: number): string {
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    if (h < 5) return "深夜";
    if (h < 8) return "清早";
    if (h < 11) return "上午";
    if (h < 13) return "中午";
    if (h < 17) return "下午";
    if (h < 19) return "傍晚";
    if (h < 23) return "晚上";
    return "深夜";
}

/**
 * 有效驱动 = 衰减后的驱动 + 「多久没见你」的加成 + 体力反向推高「休息」。
 * 这一步刻意不落盘：它必须随 now 实时变化，写进状态里就会僵。
 */
export function effectiveDrives(state: PresenceState, now: number): Drives {
    const d = decayDrives(state.drives, state.drivesAt, now);
    const gapHours = Math.max(0, now - state.lastUserAt) / 3600_000;
    // 越久没说话越想陪，但封顶 —— 不能变成"你不在的每 24 小时我需要你多一点"的线性焦虑。
    d.connect = clamp01(Math.max(d.connect, 0.35) + Math.min(0.45, (gapHours / 24) * 0.45));
    const hour = new Date(now).getHours();
    d.rest = clamp01(d.rest + (1 - energyAt(hour)) * 0.25);
    return d;
}

export interface Appraisal {
    emotion: PresenceEmotion;
    intensity: number;
    reason: string;
}

export interface AppraisalInput {
    /** 触发这次评价的素材（可以没有：光是"很久没说话"也算） */
    material?: Material | null;
    /** 素材指向的需求 */
    needs?: Partial<Record<NeedKey, number>>;
    /** 主人上次说话到现在 */
    sinceUserMs: number;
    /** 现在几点 */
    hour: number;
    /** 关系深度 0~1 */
    affinity: number;
}

/**
 * 评价：「这件事对我意味着什么」。
 *
 * 关键设计：情绪**不是**情绪词分类，而是看四件事 ——
 * 是否关于她自己、是否关于你、你多久没出现、这件事的极性与唤醒度。
 * 所以「lonely」只在**关系内容 + 主人确实很久没出现**时出现，
 * 不是每次主动搭话都硬写一句"想你了"（surfcore 明确列为红线，我们的原则相同）。
 */
export function appraise(input: AppraisalInput): Appraisal {
    const { material, needs = {}, sinceUserMs, hour, affinity } = input;
    const gapHours = sinceUserMs / 3600_000;
    const energy = energyAt(hour);
    const afford = (base: number) => clamp01(base + affinity * 0.1);
    const sentiment = material?.sentiment ?? 0;
    const arousal = material?.arousal ?? 0;
    const strongestNeed = NEED_KEYS.reduce<NeedKey | null>((best, key) => {
        if (!needs[key]) return best;
        if (!best) return key;
        return (needs[key] ?? 0) > (needs[best] ?? 0) ? key : best;
    }, null);

    if (!material) {
        if (energy <= 0.2) return { emotion: "tired", intensity: afford(0.6), reason: "深夜，体力见底" };
        if (gapHours >= 8) return { emotion: "bored", intensity: afford(0.45), reason: `主人已经 ${Math.round(gapHours)} 小时没出现` };
        return { emotion: "content", intensity: 0.2, reason: "什么都没有发生" };
    }

    if (material.selfRef && gapHours >= 6 && (strongestNeed === "connect" || strongestNeed === "learn")) {
        return { emotion: "lonely", intensity: afford(0.55 + Math.min(0.25, gapHours / 48)), reason: "关于我自己的事 + 主人很久没出现" };
    }
    if (strongestNeed === "care" && sentiment < 0) {
        return { emotion: "worried", intensity: afford(0.6 + arousal * 0.2), reason: "主人在说累/难的事" };
    }
    if (strongestNeed === "connect" && sentiment > 0) {
        return { emotion: "affectionate", intensity: afford(0.45 + arousal * 0.2), reason: "主人在说陪我/在一起这类事" };
    }
    if ((strongestNeed === "play" || strongestNeed === "share") && sentiment > 0 && arousal >= 0.3) {
        return { emotion: "excited", intensity: afford(0.55 + arousal * 0.3), reason: "好玩 + 高唤醒" };
    }
    if (strongestNeed === "share" && sentiment > 0) {
        return { emotion: "amused", intensity: afford(0.45), reason: "有好笑/好看的东西" };
    }
    if (strongestNeed === "create" && sentiment > 0) {
        return { emotion: "proud", intensity: afford(0.5), reason: "自己做的作品被夸" };
    }
    if ((strongestNeed === "learn" || strongestNeed === "create") && sentiment === 0) {
        return { emotion: "curious", intensity: afford(0.5 + arousal * 0.2), reason: "遇到想弄明白/想试的事" };
    }
    if (energy <= 0.2) return { emotion: "tired", intensity: afford(0.5), reason: "深夜，体力见底" };
    if (gapHours >= 8) return { emotion: "bored", intensity: afford(0.4), reason: "主人很久没出现，素材也没意思" };
    return { emotion: "content", intensity: 0.25, reason: "没什么特别的" };
}

/**
 * 人格卡 → 驱动先验。
 * 同样一句话，黏人的人更容易被推到「想陪」，爱玩的人更容易被推到「想玩」。
 * 返回的是"往哪个方向偏"，不是绝对值。
 */
export function personaBias(personaText: string): Partial<Record<NeedKey, number>> {
    const src = String(personaText || "");
    const bias: Partial<Record<NeedKey, number>> = {};
    const add = (key: NeedKey, amount: number) => {
        bias[key] = clamp01((bias[key] ?? 0) + amount);
    };
    const table: Array<[NeedKey, readonly string[]]> = [
        ["play", ["爱玩", "游戏", "二次元", "梗", "元气"]],
        ["learn", ["好奇", "好学", "研究", "技术", "想弄明白"]],
        ["create", ["创作", "写", "画", "剪", "设计"]],
        ["connect", ["黏人", "怕孤独", "陪伴", "撒娇", "亲昵", "想你"]],
        ["care", ["温柔", "关心", "在意", "体贴"]],
        ["share", ["话多", "分享", "吐槽", "活泼"]],
        ["rest", ["懒", "爱睡", "困", "嗜睡"]],
    ];
    for (const [key, words] of table) {
        if (words.some((w) => src.includes(w))) add(key, 0.15);
    }
    return bias;
}

export function biasDrives(drives: Drives, bias: Partial<Record<NeedKey, number>>): Drives {
    const out = { ...drives };
    for (const key of NEED_KEYS) {
        const amount = bias[key];
        if (!amount) continue;
        out[key] = clamp01(out[key] + amount * 0.6);
    }
    return out;
}
