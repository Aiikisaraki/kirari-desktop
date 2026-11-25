// electron/ai/presence/presenceBlock.ts
// 把内在状态翻译成一段可以塞进 system prompt 的「此刻的你」。
//
// ── 这一段是整个改造里性价比最高的地方 ─────────────────────────────
// 人格卡解决「她是谁」，记忆解决「她记得什么」，但两者都不回答
// 「她现在什么心情、多久没见你、刚才那句话让她怎么样」——
// 所以同一句"你回来啦"在凌晨和早上永远一个味道。
// 这一段每次对话都注入，让她的语气、长度、关注点跟着状态走。
//
// 写作红线（踩过的坑）：
//   · 只能写"状态"，不能写"台词"，否则模型会把它念出来；
//   · 显式要求在措辞里**不要提及**这些字段；
//   · 越短越好 —— 这段每轮都进上下文，膨胀了就是白烧 token。

import { daypartName, effectiveDrives, energyAt } from "./mood";
import type { NeedKey, PresenceState } from "./types";
import { NEED_KEYS } from "./types";

const NEED_LABEL: Record<NeedKey, string> = {
    connect: "想有人陪",
    care: "想关心你",
    play: "想玩点什么",
    learn: "想弄明白点什么",
    share: "想分享点什么",
    create: "想动手做点什么",
    rest: "想歇一会儿",
};

function clockText(now: number): string {
    const d = new Date(now);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function gapText(ms: number): string {
    const min = Math.round(ms / 60_000);
    if (min < 2) return "刚刚还在说话";
    if (min < 60) return `${min} 分钟`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} 小时`;
    return `${Math.round(h / 24)} 天`;
}

/**
 * 生成注入块。返回空串表示"这次不值得注入"（新装、状态缺失），
 * 调用方直接把空串丢掉即可，不要塞一个空标题。
 */
export function buildPresenceBlock(state: PresenceState | null | undefined, now: number): string {
    if (!state || state.version !== 1) return "";
    const drives = effectiveDrives(state, now);
    const hour = new Date(now).getHours();
    const energy = energyAt(hour);
    const sinceUser = Math.max(0, now - state.lastUserAt);
    const sinceSelf = Math.max(0, now - state.lastSelfAt);

    const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .filter((x) => x.v >= 0.5)
        .slice(0, 2)
        .map((x) => `${NEED_LABEL[x.key]}（${Math.round(x.v * 100)}）`);

    const lines: string[] = [];
    lines.push("【此刻的你】");
    lines.push(`· 现在 ${clockText(now)}，${daypartName(hour)}。` + (energy <= 0.25 ? "你已经很困了，说话比平时更短、更慢。" : ""));
    lines.push(`· 上次和对方说话是 ${gapText(sinceUser)}前` + (sinceSelf < sinceUser ? "；你上次主动开口是" + gapText(sinceSelf) + "前。" : "。"));
    if (state.mood) {
        lines.push(`· 你现在的心情：${state.mood.emotion}（${state.mood.reason}），强度 ${Math.round(state.mood.intensity * 100)}%。`);
    }
    if (top.length) lines.push(`· 此刻最想要的是：${top.join("、")}。`);
    if (state.pending.length) {
        lines.push(`· 心里还惦记着：${state.pending.slice(0, 3).map((p) => "「" + p.text + "」").join("、")}。`);
    }
    lines.push(
        "· 这些只是你此刻的状态，**不要**把它们念出来，也不要提「状态」「心情值」「驱动」这类词；" +
            "它只应该体现在：你挑什么话题、句子长短、语气松紧、以及要不要主动问一句。",
    );
    return lines.join("\n");
}

/**
 * 说话节奏：状态怎么给语气上色。**只描述状态，不设字数上限。**
 *
 * 2026-11-25 改造：原来的写法是「深夜/低落 → 回复不超过 40 字 + 一两个字也完全可以 +
 * 不要反问」。三条都是硬约束，叠上声音层原有的「闲聊 1~3 句、不超过 50 字」，
 * 结果是她被两道锁同时摁住——遇到想聊的话题也只能憋着，用户读到的就是「高冷」。
 *
 * 现在的分工：
 *   · 这一段只说「此刻的状态让语气往哪儿偏」（困了就慢、低了就安静），不写字数；
 *   · 「这一轮该多说还是少说」交给 reply/speakingDesire.ts，那边按精力/情绪/驱动/话题/
 *     底子五个信号算档位，并且只输出倾向。
 *
 * 白天或心情正常时返回空串：不打扰，也不制造「每轮都要克制」的心理暗示。
 *
 * @param state presence 状态
 * @param now 当前毫秒
 * @returns 需要时返回一段「此刻的说话节奏」，否则空串
 */
export function buildPaceBlock(state: PresenceState | null | undefined, now: number): string {
    if (!state || state.version !== 1) return "";
    const hour = new Date(now).getHours();
    const energy = energyAt(hour);
    const mood = state.mood ? state.mood.emotion : "content";
    const low = mood === "lonely" || mood === "tired" || mood === "worried" || mood === "envious";
    const lines: string[] = [];
    if (energy <= 0.3) {
        lines.push("【此刻的说话节奏】现在是深夜或清晨，你有点困：说话自然会短一些、慢一些，语气可以懒一点。");
        lines.push("· 累了话少是正常的；但别拿「省字数」当借口把话说得冷淡——困着也还是你自己。");
    } else if (low) {
        lines.push("【此刻的说话节奏】你现在心情不高：话少一点、语速慢一点都是正常的，不用强行轻松。");
        lines.push("· 对方问起来就照实说；用冷淡当保护色会把人推远，不如说实话。");
    }
    return lines.join("\n");
}

/** 给设置页/调试面板看的一行摘要（不注入 prompt）。 */
export function summarizePresence(state: PresenceState | null | undefined, now: number): string {
    if (!state) return "还没有状态";
    const drives = effectiveDrives(state, now);
    const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 })).sort((a, b) => b.v - a.v)[0];
    const mood = state.mood ? `${state.mood.emotion}` : "content";
    return `心情 ${mood} · 最想要 ${NEED_LABEL[top.key]} ${Math.round(top.v * 100)}% · 今天主动说过 ${state.outreachToday} 次`;
}
