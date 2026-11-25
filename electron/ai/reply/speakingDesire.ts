// electron/ai/reply/speakingDesire.ts
// 「此刻的说话欲望」：把「内在状态 + 这一轮的话题」算成一个说话档位，再翻成一段提示词。
//
// ── 为什么要有它（2026-11-25 用户反馈）──────────────────────────────────
// 上一版为了去 AI 味，把「闲聊 1~3 句、不超过 50 字」「不要反问」「最后一句不许是结论」
// 写成了硬禁令。效果是稳定的——稳定地短、稳定地不主动、稳定地冷。
// 用户的原话：「真人也不是时时刻刻都简短回答，遇到感兴趣的事情或者了解的事情
// 也会忍不住多说几句。」所以长度不该由一条固定上限决定，而该由一组可解释的信号算出来。
//
// ── 打分的五个信号（权重和为 1）────────────────────────────────────────
//   精力 0.20 —— 深夜/清晨精力低，本来就不想长篇（presence 的 energyAt）
//   情绪 0.18 —— 高兴/兴奋往上推，低落/疲惫往下压（presence 的 mood）
//   驱动 0.15 —— 「想有人陪/想分享/想知道点什么」越强，越有话说（presence 的 drives）
//   话题 0.29 —— 问得认真、问得具体、带情绪、篇幅长 → 有得聊；只回一个字 → 没什么可说
//   底子 0.18 —— 知识库/记忆命中的话题她确实懂，愿意展开；完全陌生时更该短而准
//
// ── 纪律 ─────────────────────────────────────────────────────────────
//   · 零 I/O、零时钟、零 import：状态由调用方传入（now 也传），才能在测试里穷举；
//   · 输出是**倾向**，不是上限：提示词里不写「不超过 N 字」，只写此刻更想多说还是少说；
//   · 每个信号都能说清「为什么」：算错时能从 reasons 里定位是哪一项把档位压低了。
//
// 与核心版 src/services/reply/speakingDesire.js 逐字对齐，改一端必须同步另一端。

import type { PresenceEmotion } from "../presence/types";

/** 五个信号的权重。改这里就是改「说话欲望」的性格，务必同步另一端。 */
export const WEIGHTS = { energy: 0.2, mood: 0.18, drive: 0.15, topic: 0.29, knowledge: 0.18 };

/** 情绪 → 想说话的程度。用的是 presence/types 里的那 11 种情绪，别自创。 */
export const MOOD_VALENCE: Record<string, number> = {
    excited: 0.95,
    amused: 0.85,
    proud: 0.85,
    affectionate: 0.8,
    curious: 0.72,
    content: 0.6,
    bored: 0.38,
    envious: 0.38,
    worried: 0.3,
    lonely: 0.25,
    tired: 0.2,
};

/** 低落档：这几种心情下，客观的「想说话」会再压一档。 */
export const LOW_MOODS = new Set<string>(["lonely", "tired", "worried", "envious", "bored"]);

/** 认真在问 / 需要展开的信号。 */
export const DEPTH_MARKERS =
    /为什么|怎么|如何|原理|区别|是不是|有没有|能不能|帮我|看看|你觉得|建议|讲讲|说说|要不要|哪一个|选哪个/;

/** 带情绪的信号：情绪浓的时候，人更愿意多讲两句。 */
export const EMOTION_MARKERS = /好烦|难过|开心|累|加班|崩|气死|怕|慌|焦虑|失眠|疼|想哭|压力|哈哈/;

/** 纯应声（嗯/哦/好/？）：这种轮次不需要展开。 */
export const ACK_ONLY = /^(嗯+|哦+|好+|行|在|哈+|呵+|啊+|？+|\?+)$/;

/** 档位表：分数阈值从高到低，label 会出现在提示词标题里。 */
export const LEVELS = [
    { level: "eager", label: "很想聊", min: 0.7 },
    { level: "engaged", label: "有话说", min: 0.55 },
    { level: "steady", label: "平常", min: 0.38 },
    { level: "brief", label: "省电", min: 0 },
];

/** 说话档位的标识（四档之一）。 */
export type DesireLevel = "eager" | "engaged" | "steady" | "brief";

/** 每个档位对应的提示语。全是「倾向」，没有一条写死字数上限。 */
export const LEVEL_LINES: Record<DesireLevel, readonly string[]> = {
    eager: [
        "· 你现在正想说话：可以展开讲、举个例子，也可以顺带说说自己的联想或者刚在干嘛。",
        "· 想追问就问，想主动开个话题也行。",
        "· 想多说就分成几条短消息说，一条一个念头，别攒成一大段。",
    ],
    engaged: [
        "· 有得聊：两三句到四五句都自然，能讲清楚的事可以多讲一点。",
        "· 想追问就追问，不用把话咽回去。",
    ],
    steady: [
        "· 平常状态：有事说事，一两句到三句；没什么可回的就应一声。",
        "· 对方明显想聊的时候，可以顺着多聊两句。",
    ],
    brief: [
        "· 精力或心情现在不高：一两句、应一声就够了——这是累了，不是对对方冷淡。",
        "· 别为了接话硬找话题；但对方明显需要你、或者事情重要，就说清楚。",
    ],
};

/** 一轮的「心情」。形状对齐 presence/types 的 PresenceState.mood。 */
export interface DesireMood {
    emotion?: PresenceEmotion | string;
    intensity?: number;
}

/** 知识库/记忆是否命中：决定「这个话题她有没有底」。 */
export interface DesireKnowledge {
    kbHit?: boolean;
    memHit?: boolean;
}

/** computeSpeakingDesire 的输入。全部可选，缺省按「平常」处理。 */
export interface SpeakingDesireInput {
    /** 0~1 精力（presence 的 energyAt(hour)） */
    energy?: number;
    /** presence 的 mood */
    mood?: DesireMood | null;
    /** presence 的驱动 */
    drives?: Record<string, number> | null;
    /** 距对方上次说话多久（毫秒） */
    gapMs?: number;
    /** 对方刚说的那句 */
    text?: string;
    /** 知识库/记忆是否命中 */
    knowledge?: DesireKnowledge | null;
    /** 是不是群聊场合（人多要收敛） */
    isGroup?: boolean;
}

/** 一轮的说话欲望结论（档位 + 五个信号 + 可解释的原因）。 */
export interface SpeakingDesire {
    level: DesireLevel;
    /** 档位中文名，会出现在提示块标题里 */
    label: string;
    /** 0~1 总分（保留两位小数） */
    score: number;
    energy: number;
    mood: number;
    drive: number;
    topic: number;
    knowledge: number;
    reasons: string[];
    isGroup: boolean;
}

function clamp01(n: unknown): number {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * 情绪 → 0~1 的「想说话」程度。强度越大，越往两端推。
 */
export function moodScore(mood?: DesireMood | null): number {
    if (!mood || !mood.emotion) return 0.55;
    const base = MOOD_VALENCE[mood.emotion] ?? 0.55;
    const intensity = clamp01(Number(mood.intensity));
    // 强度放大「偏离中立」的幅度：兴奋 0.9 → 更想说；疲惫 0.2 → 更不想说
    return clamp01(0.5 + (base - 0.5) * (0.6 + 0.8 * intensity));
}

/**
 * 驱动 → 0~1：想有人陪 / 想分享 / 想弄明白 越强，越有话说。
 * 久没说话（>3h）再加一点「攒了一肚子话」的分。
 */
export function driveScore(drives?: Record<string, number> | null, gapMs?: number): number {
    const keys = ["connect", "share", "learn", "play"];
    const values = keys.map((k) => clamp01(drives ? drives[k] : 0));
    const max = values.reduce((a, b) => Math.max(a, b), 0);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    let score = 0.35 + 0.65 * (0.6 * max + 0.4 * avg);
    const gap = Number(gapMs);
    if (Number.isFinite(gap) && gap > 3 * 3600000) score += gap > 12 * 3600000 ? 0.08 : 0.05;
    return clamp01(score);
}

/**
 * 这一轮的话题 → 0~1：有多「有得聊」。
 * @param text 对方刚说的那句
 */
export function topicScore(text?: string): number {
    const raw = String(text || "");
    const t = raw.trim();
    if (!t) return 0.4;
    let score = 0.45;
    if (DEPTH_MARKERS.test(t)) score += 0.2;
    if (/[?？]/.test(t)) score += 0.08;
    if (EMOTION_MARKERS.test(t)) score += 0.12;
    if (t.length >= 60) score += 0.15;
    if (t.length >= 150) score += 0.1;
    if (t.length <= 6) score -= 0.15;
    if (ACK_ONLY.test(t)) score -= 0.2;
    return clamp01(score);
}

/**
 * 底子 → 0~1：这个话题她懂不懂。
 * 懂（知识库命中/记忆命中）就愿意展开；完全陌生时更该短而准，别硬撑长篇。
 */
export function knowledgeScore(knowledge?: DesireKnowledge | null): number {
    const k = knowledge || {};
    if (k.kbHit) return 0.9;
    if (k.memHit) return 0.7;
    return 0.32;
}

/**
 * 分数 → 档位。
 * @param score 0~1
 */
export function pickLevel(score: number): (typeof LEVELS)[number] {
    const hit = LEVELS.find((item) => score >= item.min);
    return hit || LEVELS[LEVELS.length - 1];
}

/**
 * 算这一轮的说话欲望。
 */
export function computeSpeakingDesire(input?: SpeakingDesireInput | null): SpeakingDesire {
    const opts = input || {};
    const energy = clamp01(opts.energy === undefined ? 0.6 : opts.energy);
    const mood = moodScore(opts.mood);
    const drive = driveScore(opts.drives, opts.gapMs);
    const topic = topicScore(opts.text);
    const knowledge = knowledgeScore(opts.knowledge);

    const reasons: string[] = [];
    let score =
        WEIGHTS.energy * energy +
        WEIGHTS.mood * mood +
        WEIGHTS.drive * drive +
        WEIGHTS.topic * topic +
        WEIGHTS.knowledge * knowledge;

    const isGroup = opts.isGroup === true;
    if (isGroup) {
        score -= 0.12;
        reasons.push("群聊场合，收敛一档");
    }
    const lowMood = !!(opts.mood && LOW_MOODS.has(String(opts.mood.emotion)));
    if (energy <= 0.25 || lowMood) {
        score -= 0.08;
        reasons.push(energy <= 0.25 ? "精力低（深夜/清晨）" : "心情偏低");
    }
    if (knowledge >= 0.7) reasons.push("这个话题她有底，可以讲具体些");
    if (topic >= 0.65) reasons.push("对方问得认真/说得具体");
    if (topic <= 0.3) reasons.push("这一轮没什么可展开的");

    score = clamp01(score);
    let picked = pickLevel(score);
    // 群聊里不给她「很想聊」的档位：人多的时候话痨是灾难（surfcore 的教训）
    if (isGroup && picked.level === "eager") picked = LEVELS[1];

    return {
        level: picked.level as DesireLevel,
        label: picked.label,
        score: Math.round(score * 100) / 100,
        energy,
        mood,
        drive,
        topic,
        knowledge,
        reasons,
        isGroup,
    };
}

/**
 * 把档位翻成一段可以直接拼进 system 的提示。
 *
 * 措辞纪律：只写「此刻更想多说还是少说」＋「说了算失礼吗」，不写字数上限；
 * 结尾固定两条：① 这只是倾向不是上限；② 别用「要简短」当借口把话说得没温度。
 * 第 ② 条是这次改造的正题——高冷往往不是态度问题，而是被长度规则逼出来的。
 *
 * @param desire computeSpeakingDesire 的结果
 * @returns 空输入返回空串（调用方直接丢掉，不要塞空标题）
 */
export function buildDesireBlock(desire?: SpeakingDesire | null): string {
    if (!desire || !desire.level) return "";
    const lines = ["【此刻的说话欲望 · " + desire.label + "】"];
    const body = LEVEL_LINES[desire.level] || LEVEL_LINES.steady;
    for (const line of body) lines.push(line);
    if (desire.knowledge >= 0.7) {
        lines.push("· 这个话题你确实有底（记得的、查得到的），可以讲得具体些，别含糊过去。");
    }
    lines.push("· 这只是此刻的倾向，不是上限：对方想聊、事情也重要，多说几句不算失礼。");
    lines.push("· 别因为「要简短」就把话说得客气、中性、没有温度。");
    return lines.join("\n");
}
