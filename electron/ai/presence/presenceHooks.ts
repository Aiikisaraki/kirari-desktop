// electron/ai/presence/presenceHooks.ts
// 在场感内核的「接线层」：把纯逻辑（mood/purpose）接到对话主流程（engine.ts）上。
//
// 这一层的职责刻意只有三件事：
//   ① 判断这个会话值不值得写状态（只认本机主人的桌面会话）；
//   ② 把「主人说了一句话」翻译成 recordUserTurn；
//   ③ 把「她说了一句话」翻译成一次评价（appraiseReply）。
// 主动搭话（planOutreach / commitOutreach）不在这层 —— 那是调度器的事，见 presenceSchedule。
//
// 为什么「她说的话」也要评价：真人的心情不只被别人的话影响。
// 她自己讲了句得意的话（happy/excited）之后是一阵轻快的；
// 讲了句道歉（bow/sad）之后会低落一会儿。这就是"情绪有惯性"的最小实现。

import { appraise, needAffinity, sentimentOf } from "./mood";
import { recordUserTurn as recordTurn } from "./purpose";
import type { Material, PresenceEmotion, PresenceState } from "./types";
import { EMOTION_TO_AVATAR } from "./types";

/**
 * 只认「本机主人在自己桌面上说话」的会话。
 *
 * 对话链路里 sessionId 的形状有三种：
 *   · 本机桌面会话：UUID / ensureLocalSessionId 固定下来的那一个；
 *   · 机器人会话：bot-<adapterId>-<conversationKey>（QQ 官方 / OneBot）；
 *   · 组网 relay 会话：带 relay 前缀（协议里另有约定）。
 *
 * 只有第一种是"私下相处"。QQ 群聊和组网是对外营业：
 * 在群里被陌生人夸了一句不该让她的「想有人陪」掉下去，
 * 客人的一句话更不该写进主人的亲密度 —— 那是 2026-11-20「朋友任务跑到主人桌面」
 * 同一类串线事故的在场感版本。
 */
export function isOwnerLocalSession(sessionId: string | null | undefined): boolean {
    const sid = String(sessionId || "");
    if (!sid) return false;
    if (sid.startsWith("bot-")) return false;
    if (sid.startsWith("relay") || sid.includes("relay-")) return false;
    // 任务/调度类会话（workspace:<taskId>、brief:<uid>:<slot>、presence:* 等）
    // 都带冒号；本机会话是纯 UUID（无冒号）。不排除的话，工作空间任务的指令文本
    // 会当成"主人说的话"写进她的心情与亲密度。
    if (sid.includes(":")) return false;
    return true;
}

/** 模型给的 emotion 标签 → 内在情绪。只取能映射的；映射不到就不硬安一个。 */
function emotionFromLabel(label: string | null): PresenceEmotion | null {
    switch (label) {
        case "happy":
        case "excited":
        case "wave":
            return "excited";
        case "shy":
            return "affectionate";
        case "sad":
            return "lonely";
        case "angry":
            return "worried";
        case "nod":
        case "bow":
            return "content";
        case "surprised":
            return "curious";
        case "thinking":
        case "head_tilt":
            return "curious";
        case "attention":
        case "stretch":
            return "content";
        default:
            return null;
    }
}

/** 她回复的语气 → 极性/唤醒度（selfRef = 这是她自己说的话）。 */
function selfMaterial(text: string, label: string | null, now: number): Material {
    return {
        id: `self-${now}`,
        source: "chat",
        text,
        at: now,
        selfRef: true,
        sentiment: sentimentOf(text),
        arousal: Math.min(1, (text.match(/[!！]/g)?.length ?? 0) * 0.2 + (label === "excited" ? 0.3 : 0)),
    };
}

/**
 * 主人说了一句话 → 更新后的状态。
 * 直接转发 purpose.recordUserTurn（那里管驱动/间隔/心情评价），这里只做会话判定后的转接。
 */
export function recordUserTurn(state: PresenceState, text: string, now: number): PresenceState {
    return recordTurn(state, text, now);
}

/**
 * 她自己回了一句话 → 更新后的状态。
 * 不改 lastUserAt / drives（那是主人说话的事），只更新 mood：
 * 评价用的是「她自己这句话」的素材，心情基调以它为准 ——
 * 这样被凶了之后回了一句道歉，接下来一段时间她是低落的，而不是立刻弹回中性。
 */
export function appraiseReply(state: PresenceState, speech: string, emotionLabel: string | null, now: number): PresenceState {
    const material = selfMaterial(speech, emotionLabel, now);
    const needs = needAffinity(speech);
    const emotion = emotionFromLabel(emotionLabel) ?? appraise({
        material,
        needs,
        sinceUserMs: 0, // 她刚说完话，谈不上"想念"
        hour: new Date(now).getHours(),
        affinity: state.affinity,
    }).emotion;
    const intensity = 0.35 + (material.arousal ?? 0) * 0.3;
    return {
        ...state,
        mood: {
            emotion,
            intensity: Math.min(1, intensity),
            at: now,
            reason: emotionLabel
                ? `刚才的回复带了「${emotionLabel}」`
                : "刚才那段话的语气",
        },
    };
}

/** 给渲染层用：当前心情该配哪个动画变体（播完情绪后回落到这里，而不是无条件 idle）。 */
export function idleVariantFor(state: PresenceState | null | undefined): string | null {
    if (!state?.mood) return null;
    const mapped = EMOTION_TO_AVATAR[state.mood.emotion];
    return mapped ?? null;
}
