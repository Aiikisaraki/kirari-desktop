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
 * 说话节奏约束（跟着状态走的长度上限与短回许可）。
 *
 *真人不会每句都一样长：深夜困了说话短、难过时更短、
 * 被夸了轻快时才话多。没有这个约束，模型默认往 100 字写 —— AI 味的主要来源之一。
 * 返回空串表示"现在不需要约束"（白天 + 心情正常）。
 */
export function buildPaceBlock(state: PresenceState | null | undefined, now: number): string {
    if (!state || state.version !== 1) return "";
    const hour = new Date(now).getHours();
    const energy = energyAt(hour);
    const mood = state.mood?.emotion ?? "content";
    const sad = mood === "lonely" || mood === "tired" || mood === "worried";

    // 深夜（体力低）或心情低落 → 硬上限 40 字，并给短回许可
    if (energy <= 0.3 || sad) {
        return [
            "【此刻的说话节奏】",
            energy <= 0.3
                ? "· 现在是深夜/清晨，你很困：回复不超过 40 字，语气可以懒一点、慢一点。"
                : "· 你现在心情不高：回复不超过 40 字，话少一点是正常的，不用强行轻松。",
            "· 一两个字也完全可以：嗯。/ 好。/ 在听。/ 困了… 这都是合法回复。",
            "· 不要反问，不要为了把话接下去而硬找话题。",
        ].join("\n");
    }
    // 白天心情正常 → 只给一个软上限，防小作文
    return "【此刻的说话节奏】正常聊天时也请克制：多数回复控制在两三句以内；有实质内容（解释/步骤/列表）才可以长。";
}

/** 给设置页/调试面板看的一行摘要（不注入 prompt）。 */
export function summarizePresence(state: PresenceState | null | undefined, now: number): string {
    if (!state) return "还没有状态";
    const drives = effectiveDrives(state, now);
    const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 })).sort((a, b) => b.v - a.v)[0];
    const mood = state.mood ? `${state.mood.emotion}` : "content";
    return `心情 ${mood} · 最想要 ${NEED_LABEL[top.key]} ${Math.round(top.v * 100)}% · 今天主动说过 ${state.outreachToday} 次`;
}
