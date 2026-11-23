// electron/ai/presence/purpose.ts
// 「目的机制」：从素材里提炼动机 → 决定这轮该不该主动开口 → 写成她自己的话 → 记账。
//
// 这是 surfcore 最值得借鉴的一块（src/purpose-engine.js + docs/guides/PURPOSE_OUTREACH.md）。
// 移植到桌面宠物时做了三处场景适配：
//   ① 素材只有"你和她之间"的（对话、记忆、日程、时间），没有 QQ 群和 B站；
//   ② 载体从 QQ 私聊换成桌宠气泡（可以配 TTS），所以不需要"发送工具"，只需要一段话；
//   ③ 加了「专注模式」这一层闸门 —— 桌宠常驻屏幕，打扰成本比 QQ 高得多。
//
// 纯逻辑：无 I/O、无随机源（rng 注入）、无 Date.now()（now 注入）。

import { appraise, clamp01, decayDrives, effectiveDrives, energyAt, needAffinity, biasDrives, personaBias, sentimentOf } from "./mood";
import type {
    Drives,
    GoalHypothesis,
    Material,
    NeedKey,
    PresenceConfig,
    PresenceState,
    PurposeAction,
} from "./types";
import { NEED_KEYS } from "./types";

// ── 时间工具 ─────────────────────────────────────────────────────────

/** 本地日期键（不能用 toISOString：那是 UTC，会把 23:30 之后的"今天"算成明天）。 */
export function localDateKey(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "23:30" → 1410（分钟）。解析不出时用 fallback。 */
export function parseHHMM(value: string, fallback = "08:00"): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback);
    if (!m) return 8 * 60;
    const hh = Math.max(0, Math.min(23, Number(m[1])));
    const mm = Math.max(0, Math.min(59, Number(m[2])));
    return hh * 60 + mm;
}

/**
 * 安静时段判断。两端相同 = 不设；起点大于终点 = 跨零点（23:30→08:00）。
 * 边界：含起点、不含终点（23:30 已经算"该安静了"）。
 */
export function inQuietHours(cfg: Pick<PresenceConfig, "quietStart" | "quietEnd">, now: number): boolean {
    const start = parseHHMM(cfg.quietStart, "23:30");
    const end = parseHHMM(cfg.quietEnd, "08:00");
    if (start === end) return false;
    const d = new Date(now);
    const minutes = d.getHours() * 60 + d.getMinutes();
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
}

// ── 素材 → 种子 ──────────────────────────────────────────────────────

export interface Seed {
    material: Material;
    needs: Partial<Record<NeedKey, number>>;
    dominant: NeedKey;
    topic: string;
    /** `dominant|topic`，用于观察账本与去重 */
    key: string;
    score: number;
}

const TOPIC_FILLER = /^(早|早上好|早安|你好|喂|那个|嗯|啊|哦|今天|刚刚|就是|对了)+/;

/**
 * 从一段话里抽「那件事」。
 *
 * 第一版直接取句首 18 字，结果「早，昨晚改bug改到三点，头好痛」的主题变成了整句问候 ——
 * 主动搭话的提示词里就出现「想问问主人『早，昨晚改bug…』的事」这种不通顺的念头。
 * 现在改成：先按标点切成小句，再挑**最贴合主导需求**的那一句（主导需求由整句算），
 * 最后剥掉「早/今天/那个」这类填充词。宁可短，不要长。
 */
export function extractTopic(text: string): string {
    const src = String(text || "").trim();
    if (!src) return "";
    const quoted = /[《「“"]([^》」”"]{1,24})[》」”"]/.exec(src);
    if (quoted) return quoted[1].trim();

    const dominant = dominantNeed(needAffinity(src));
    const clauses = src.split(/[，,。！？!?；;、\s]+/u).map((s) => s.trim()).filter(Boolean);
    if (!clauses.length) return "";
    let best = clauses[0];
    let bestScore = -1;
    for (const clause of clauses) {
        const needs = needAffinity(clause);
        const hit = dominant ? (needs[dominant] ?? 0) : 0;
        const total = NEED_KEYS.reduce((sum, key) => sum + (needs[key] ?? 0), 0);
        const score = hit * 2 + total * 0.5;
        if (score > bestScore) {
            bestScore = score;
            best = clause;
        }
    }
    const stripped = best
        .replace(TOPIC_FILLER, "")
        .replace(/^(昨晚|昨天|前天|刚才|刚|现在)/, "")
        // 切句后常留下悬空的虚词（「常州降温到」），听起来像半句话；剥掉它
        .replace(/(到|了|的|和|跟|在|是|有|也|都|还)$/, "")
        .trim();
    const out = stripped || best;
    return out.slice(0, 12);
}

function dominantNeed(needs: Partial<Record<NeedKey, number>>): NeedKey | null {
    let best: NeedKey | null = null;
    for (const key of NEED_KEYS) {
        const amount = needs[key];
        if (!amount) continue;
        if (!best || amount > (needs[best] ?? 0)) best = key;
    }
    return best;
}

/** 素材 → 带分数的种子。分数 = 注意力权重（surfcore 的 scoreOf 桌面版）。 */
export function scoreMaterial(
    material: Material,
    state: PresenceState,
    drives: Drives,
    now: number,
    cfg: Pick<PresenceConfig, "materialWindowMs">,
): Seed | null {
    const needs = needAffinity(material.text);
    const dominant = dominantNeed(needs);
    if (!dominant) return null;
    const topic = extractTopic(material.text);
    if (!topic) return null;
    const key = `${dominant}|${topic}`;
    const obs = state.observations[key];
    const repeat = Math.min(1, (obs?.seen ?? 0) / 3);
    const freshness = 1 - repeat;
    const window = Math.max(1, cfg.materialWindowMs);
    const recency = Math.max(0, 1 - Math.max(0, now - material.at) / window);
    const score =
        (needs[dominant] ?? 0) * (0.35 + (drives[dominant] ?? 0.3)) +
        (material.selfRef ? 0.35 : 0) +
        (material.ownerRef ? 0.3 : 0) +
        Math.abs(material.sentiment ?? 0) * 0.15 +
        (material.arousal ?? 0) * 0.1 +
        (material.unresolved ? 0.2 : 0) +
        freshness * 0.2 +
        recency * 0.1 +
        (material.weight ?? 0.5) * 0.15;
    return { material, needs, dominant, topic, key, score };
}

/**
 * 从一堆素材里挑种子。
 * 窗口外的一律不看；钉住的（锚点记忆 / 初次相遇）例外 —— 它们本来就该常驻。
 * 同一 `need|topic` 只留分最高的那一条：否则同一件事说三遍会把自己的分数刷上去。
 */
export function mineSeeds(
    materials: Material[],
    state: PresenceState,
    now: number,
    cfg: PresenceConfig,
): Seed[] {
    const drives = effectiveDrives(state, now);
    const byKey = new Map<string, Seed>();
    for (const material of materials) {
        const outOfWindow = now - material.at > cfg.materialWindowMs;
        if (outOfWindow && !material.pinned) continue;
        const seed = scoreMaterial(material, state, drives, now, cfg);
        if (!seed) continue;
        // 「她说过的这件事，主人明确说了不要」→ 一周内不再提。
        // 关键：拒绝必须记在**观察账本**上，而不是只记在当轮那个 goal 对象上 ——
        // 每轮 goal 都是新造的（id 带时间戳），只记在对象上等于没记（模拟跑出来的真 bug）。
        const seen = state.observations[seed.key];
        if (seen && seen.negative >= 1 && seen.negative >= seen.positive && now - seen.lastAt < 7 * 24 * 3600_000) {
            continue;
        }
        const prev = byKey.get(seed.key);
        if (!prev || seed.score > prev.score) byKey.set(seed.key, seed);
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score);
}

// ── 种子 → 目标假设 ──────────────────────────────────────────────────

const SOURCE_TRUST: Record<Material["source"], number> = {
    chat: 0.9,
    memory: 0.7,
    brief: 0.55,
    schedule: 0.8,
    pending: 0.8,
    time: 0.5,
};

function actionForNeed(need: NeedKey, owner: GoalHypothesis["owner"], unresolved: boolean): PurposeAction {
    if (unresolved) return "follow";
    switch (need) {
        case "connect":
            return owner === "self" ? "confide" : "invite";
        case "care":
            return "care";
        case "play":
            return "invite";
        case "learn":
            return "curiosity";
        case "share":
            return "share";
        case "create":
            return "share";
        case "rest":
            return "confide";
        default:
            return "share";
    }
}

/** 风险：高风险的只能"问"，不能替主人决定（这里沿用 surfcore 的取值区间）。 */
function riskFor(action: PurposeAction, need: NeedKey): number {
    if (action === "ask") return 0.55;
    if (action === "confide") return 0.15;
    if (need === "rest") return 0.2;
    if (action === "care") return 0.1;
    if (action === "invite") return 0.1;
    return 0.05;
}

const INTENT_BY_ACTION: Record<PurposeAction, (topic: string) => string> = {
    share: (topic) => `想跟主人说说「${topic}」这件事`,
    ask: (topic) => `想问主人一件关于「${topic}」的事`,
    invite: (topic) => `想拉主人一起做「${topic}」`,
    confide: (topic) => `心里有点关于「${topic}」的话想说`,
    curiosity: (topic) => `对「${topic}」有点好奇，想弄明白`,
    follow: (topic) => `「${topic}」上次还没说完，想接着问`,
    care: (topic) => `想问问主人「${topic}」的事`,
};

/**
 * 把种子变成**带置信度的目标假设**。
 * 归属规则（surfcore 最关键的一条）：素材说的是别人的事，就先记成"media/owner"的目标；
 * 只有重复出现、直接点她、或她过去有同类兴趣，才升级成"我自己的"。
 */
export function formGoals(seeds: Seed[], state: PresenceState, now: number, cfg: PresenceConfig): GoalHypothesis[] {
    const drives = effectiveDrives(state, now);
    const goals: GoalHypothesis[] = [];
    for (const seed of seeds.slice(0, Math.max(1, cfg.maxGoals))) {
        const m = seed.material;
        const owner: GoalHypothesis["owner"] = m.ownerRef ? "owner" : m.selfRef ? "self" : "media";
        const obs = state.observations[seed.key];
        const repeat = Math.min(1, (obs?.seen ?? 0) / 3);
        const drive = drives[seed.dominant] ?? 0.3;
        const confidence = clamp01(
            0.15 +
                (m.selfRef ? 0.22 : 0) +
                repeat * 0.2 +
                (m.unresolved ? 0.1 : 0) +
                (SOURCE_TRUST[m.source] ?? 0.5) * 0.1 +
                drive * 0.08,
        );
        const value = clamp01(0.3 + 0.35 * drive + (m.selfRef ? 0.2 : 0) + 0.15 * repeat);
        const urgency = clamp01(0.15 + (m.ownerRef ? 0.35 : 0) + (m.unresolved ? 0.2 : 0));
        const action = actionForNeed(seed.dominant, owner, Boolean(m.unresolved));
        goals.push({
            id: `g-${seed.key}-${Math.round(m.at)}`,
            owner,
            need: seed.dominant,
            action,
            topic: seed.topic,
            intent: INTENT_BY_ACTION[action](seed.topic),
            confidence,
            value,
            urgency,
            risk: riskFor(action, seed.dominant),
            status: "hypothesis",
            evidenceIds: [m.id],
            attempts: 0,
            createdAt: now,
        });
    }
    return goals;
}

/**
 * 人格卡没有素材时的"起始动机"。
 * 作用：即使今天什么都没发生，只要人格卡有内容，她也不是空壳 ——
 * 但置信度刻意压低（0.3~0.45），只能"冒个念头"，不能理直气壮地宣布。
 */
export function personaGoals(personaText: string, state: PresenceState, now: number): GoalHypothesis[] {
    const bias = personaBias(personaText);
    const drives = biasDrives(effectiveDrives(state, now), bias);
    const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 2);
    const out: GoalHypothesis[] = [];
    for (const { key, v } of top) {
        if (v < 0.5) continue;
        const action = actionForNeed(key, "self", false);
        out.push({
            id: `g-persona-${key}-${Math.round(now / 3600_000)}`,
            owner: "self",
            need: key,
            action,
            topic: "今天",
            intent: INTENT_BY_ACTION[action]("今天"),
            confidence: clamp01(0.3 + v * 0.15),
            value: clamp01(0.25 + v * 0.3),
            urgency: 0.15,
            risk: riskFor(action, key),
            status: "hypothesis",
            evidenceIds: [],
            attempts: 0,
            createdAt: now,
        });
    }
    return out;
}

/**
 * 单个目标的抽签权重。
 * 基础 = 0.55（保底）+ 置信 × 0.7 + 价值 × 0.35 − 风险 × 0.25，
 * 再乘驱动（这个需求现在有多强）、需求轮换、去重三档。
 */
export function goalWeight(goal: GoalHypothesis, state: PresenceState, drives: Drives, now: number): number {
    let weight = 0.55 + goal.confidence * 0.7 + goal.value * 0.35 - goal.risk * 0.25;
    weight *= 0.65 + 0.55 * (drives[goal.need] ?? 0);
    const recent = state.recentNeeds ?? [];
    // 需求轮换：连续两次同一个需求 → 重折；最近三次出现过 → 轻折。
    // 不打这个折，她的人设会被聊成单曲循环（连续三天都在问「你今天累不累」）。
    // ⚠️ 必须先判长度：空数组的 every() 返回 true（真空真），
    // 不判长度会把「一次都没说过」也当成「连续两次说过」，所有人一律打 0.65 折。
    if (recent.length >= 2 && recent.slice(-2).every((n) => n === goal.need)) weight *= 0.65;
    else if (recent.length >= 1 && recent.slice(-3).includes(goal.need)) weight *= 0.72;
    // 同一个目标说过就不再提，哪怕换了措辞（这一项要够狠，否则会绕回来）
    if (goal.id === state.lastGoalId) weight *= 0.35;
    if (goal.lastActionAt && now - goal.lastActionAt < 12 * 3600_000) weight *= 0.6;
    return Math.max(0, weight);
}

/**
 * 选一个目标：**加权抽签**，不是取最大值。
 *
 * 取最大值会让行为完全可预测（永远挑分最高那个），真人不是这样：同样几个念头，
 * 今天说这个、明天说那个。抽签 + 需求轮换才既「有偏好」又「不单曲循环」。
 * rng 由调用方注入，所以单测可复现。
 */
export function pickGoal(
    goals: GoalHypothesis[],
    state: PresenceState,
    now: number,
    rng: () => number = Math.random,
): GoalHypothesis | null {
    const drives = effectiveDrives(state, now);
    const candidates = goals.filter(
        (g) => g.status !== "rejected" && g.status !== "done" && g.status !== "expired" && g.confidence >= 0.25,
    );
    if (!candidates.length) return null;
    const weights = candidates.map((g) => goalWeight(g, state, drives, now));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return candidates[0];
    let roll = Math.abs(rng()) * total;
    for (let i = 0; i < candidates.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
}

// ── 闸门与排程 ───────────────────────────────────────────────────────

export interface OutreachPlan {
    fire: boolean;
    /** 为什么（给日志用，中文短句） */
    reason: string;
    goal: GoalHypothesis | null;
    goals: GoalHypothesis[];
    seeds: Seed[];
    nextAt: number;
    /** 更新了观察账本/目标状态之后的状态（调用方负责落盘） */
    state: PresenceState;
}

/** 安静时段结束的那个时刻（下一次 quietEnd）。 */
export function quietEndAfter(cfg: Pick<PresenceConfig, "quietStart" | "quietEnd">, now: number): number {
    const end = parseHHMM(cfg.quietEnd, "08:00");
    const d = new Date(now);
    d.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
}

/**
 * 排下一枪。三条来自 surfcore 的细节：
 *   ① 间隔是**区间随机**（不是固定 3 小时整点）—— 人不会按周期找人；
 *   ② 以 now 为基准往前推，所以停机很久之后**只补一枪**，不会连发一串；
 *   ③ 算出来的点落在安静时段里就推到安静时段结束 + 0~20 分钟抖动。
 */
function scheduleNext(now: number, cfg: PresenceConfig, rng: () => number): number {
    const min = Math.max(1000, cfg.gapMinMs);
    const max = Math.max(min, cfg.gapMaxMs);
    const at = now + min + Math.abs(rng()) * (max - min);
    if (!inQuietHours(cfg, at)) return at;
    return quietEndAfter(cfg, at) + Math.abs(rng()) * 20 * 60_000;
}

/**
 * 一次 tick 的全部判断：**先闸门、后内容**。
 *
 * 闸门顺序是刻意的 —— 越便宜、越"绝对"的条件越靠前，
 * 这样"为什么没开口"永远有一个明确的理由，不会出现"她自己也不知道为什么不说话"。
 */
export function planOutreach(input: {
    state: PresenceState;
    cfg: PresenceConfig;
    now: number;
    materials: Material[];
    personaText?: string;
    rng?: () => number;
}): OutreachPlan {
    const { cfg, now } = input;
    const rng = input.rng ?? Math.random;
    const state: PresenceState = {
        ...input.state,
        observations: { ...input.state.observations },
    };
    const seeds = mineSeeds(input.materials, state, now, cfg);
    const base = { seeds, goal: null, goals: [] as GoalHypothesis[], state };

    const hold = (reason: string, nextAt: number): OutreachPlan => ({ ...base, fire: false, reason, nextAt });

    if (!cfg.enabled) return hold("开关关着", state.nextFireAt);
    if (cfg.focus) return hold("专注模式（不主动打扰）", state.nextFireAt);
    if (inQuietHours(cfg, now)) return hold("安静时段", state.nextFireAt);

    // 跨天重置每日计数（用本地日期，不能用 UTC）
    const today = localDateKey(now);
    if (state.outreachDate !== today) {
        state.outreachDate = today;
        state.outreachToday = 0;
    }
    if (cfg.dailyMax > 0 && state.outreachToday >= cfg.dailyMax) {
        return hold(`今天已经主动说过 ${state.outreachToday} 次`, state.nextFireAt);
    }
    if (now - state.lastUserAt < cfg.idleThresholdMs) {
        return hold("主人刚说过话，不插嘴", state.nextFireAt);
    }
    if (now < state.nextFireAt) {
        const mins = Math.round((state.nextFireAt - now) / 60_000);
        return hold(`还没到点（还有 ${mins} 分钟）`, state.nextFireAt);
    }

    // 记账：见过一次。只在新证据上累加，防止旧素材每轮刷分。
    for (const seed of seeds) {
        const obs = state.observations[seed.key];
        state.observations[seed.key] =
            obs && now - obs.lastAt < 3600_000
                ? { ...obs, lastAt: now }
                : {
                      key: seed.key,
                      topic: seed.topic,
                      seen: (obs?.seen ?? 0) + 1,
                      positive: obs?.positive ?? 0,
                      negative: obs?.negative ?? 0,
                      lastAt: now,
                  };
    }

    const realMaterials = seeds.filter((s) => s.material.source !== "time").length;
    const goals = [
        ...formGoals(seeds, state, now, cfg),
        ...(input.personaText ? personaGoals(input.personaText, state, now) : []),
    ];
    const pendingSeeds = state.pending.length;
    if (realMaterials < cfg.minMaterials && pendingSeeds === 0 && goals.length === 0) {
        return hold("手里没有值得一提的事，不硬找话", now + cfg.gapMinMs);
    }
    const goal = pickGoal(goals, state, now, rng);
    if (!goal) return hold("有素材但没有成型的目标", now + cfg.gapMinMs);
    return { fire: true, reason: goal.intent, goal, goals, seeds, nextAt: scheduleNext(now, cfg, rng), state };
}

/** 回执：她到底说没说成。三种结局对应三种记账方式。 */
export function commitOutreach(
    state: PresenceState,
    input: { goal: GoalHypothesis | null; now: number; kind: "sent" | "silent" | "failed"; cfg: PresenceConfig; rng?: () => number },
): PresenceState {
    const { goal, now, kind, cfg } = input;
    const rng = input.rng ?? Math.random;
    const next: PresenceState = { ...state, goals: state.goals.slice(), observations: { ...state.observations } };
    // ⚠️ 这里用**衰减后的基线**，不能用 effectiveDrives：
    // effectiveDrives 里含「多久没见你」的加成，把它写回盘里，下一次 tick 会在这个已经被抬高的值上
    // 再加一次加成 —— 驱动会棘轮式漂移（模拟里跑出过 rest 84% 这种不合理数值）。
    const drives = decayDrives(state.drives, state.drivesAt, now);
    const today = localDateKey(now);
    if (next.outreachDate !== today) {
        next.outreachDate = today;
        next.outreachToday = 0;
    }

    if (kind === "sent") {
        next.outreachToday += 1;
        next.lastOutreachAt = now;
        next.lastSelfAt = now;
        // 说出来了，对应需求就被满足掉一大半；"想陪"被满足得更多。
        if (goal) {
            drives[goal.need] = clamp01(drives[goal.need] * (goal.action === "confide" ? 0.45 : 0.55));
            next.lastGoalId = goal.id;
            const idx = next.goals.findIndex((g) => g.id === goal.id);
            const updated: GoalHypothesis = { ...goal, attempts: goal.attempts + 1, lastActionAt: now, status: "active" };
            next.recentNeeds = [...(next.recentNeeds ?? []), goal.need].slice(-3);
            if (idx >= 0) next.goals[idx] = updated;
            else next.goals.push(updated);
        }
        next.drives = drives;
        next.drivesAt = now;
        next.mood = { emotion: "content", intensity: 0.3, at: now, reason: "刚跟主人说过话" };
        next.nextFireAt = scheduleNext(now, cfg, rng);
        return next;
    }

    if (kind === "silent") {
        // 她看了素材但决定不说：需求只轻微回落，别奖励"沉默"也别惩罚它。
        if (goal) {
            drives[goal.need] = clamp01(drives[goal.need] * 0.85);
            const idx = next.goals.findIndex((g) => g.id === goal.id);
            if (idx >= 0) next.goals[idx] = { ...next.goals[idx], attempts: next.goals[idx].attempts + 1 };
        }
        next.drives = drives;
        next.drivesAt = now;
        next.nextFireAt = scheduleNext(now, cfg, rng);
        return next;
    }

    // failed：失败不能假装成功。重试若干次后回到正常间隔，避免 15s 热循环。
    const attempts = goal ? goal.attempts + 1 : 1;
    if (goal) {
        const idx = next.goals.findIndex((g) => g.id === goal.id);
        if (idx >= 0) next.goals[idx] = { ...next.goals[idx], attempts };
    }
    next.nextFireAt = attempts >= cfg.maxAttempts ? scheduleNext(now, cfg, rng) : now + cfg.retryMs;
    return next;
}

/**
 * 她说完之后，用主人**下一条**消息判断"这次开口对不对"。
 * 正反馈 → 目标确认、置信度上调；负反馈 → 目标拒绝、不再提。
 * surfcore 把这一步叫「回执之后的目标记账」，是这套机制真正会学习的地方。
 */
export function reconcileReplies(state: PresenceState, goalId: string, replyText: string, now: number): PresenceState {
    const next: PresenceState = { ...state, goals: state.goals.slice(), observations: { ...state.observations } };
    const idx = next.goals.findIndex((g) => g.id === goalId);
    if (idx < 0) return next;
    const goal = { ...next.goals[idx] };
    const sentiment = sentimentOf(replyText);
    if (sentiment > 0) {
        goal.status = "confirmed";
        goal.confidence = clamp01(goal.confidence + 0.15);
    } else if (sentiment < 0) {
        goal.status = "rejected";
        goal.confidence = clamp01(goal.confidence - 0.25);
    } else {
        goal.confidence = clamp01(goal.confidence + 0.02);
    }
    next.goals[idx] = goal;
    // 观察账本必须「无论有没有旧记录都写」：调用方可能拿的是还没跑过 planOutreach 的旧状态，
    // 那时账本里没有这一条，判空一过就会把负反馈丢掉 —— 于是被拒绝的话题下一轮又冒出来。
    const key = `${goal.need}|${goal.topic}`;
    const obs = next.observations[key] ?? {
        key,
        topic: goal.topic,
        seen: 1,
        positive: 0,
        negative: 0,
        lastAt: now,
    };
    next.observations[key] = {
        ...obs,
        positive: obs.positive + (sentiment > 0 ? 1 : 0),
        negative: obs.negative + (sentiment < 0 ? 1 : 0),
        lastAt: now,
    };
    return next;
}

/**
 * 记一轮用户的发言：更新"多久没说话"、关系深度、以及需求驱动。
 * 这是让"她记得你刚才说了什么"变成"她因此有点想要什么"的那一步。
 */
export function recordUserTurn(state: PresenceState, text: string, now: number, opts: { personaText?: string } = {}): PresenceState {
    const needs = needAffinity(text);
    // 同一句话对不同人格的"戳中程度"不同：黏人的人格被「陪」推得更狠，爱玩的人格被「玩」推得更狠。
    const bias = opts.personaText ? personaBias(opts.personaText) : {};
    const base = decayDrives(state.drives, state.drivesAt, now);
    const drives = bumpForNeeds(biasDrives(base, bias), needs, 0.22);
    const affinity = clamp01(state.affinity + 0.01);
    const material: Material = {
        id: `chat-${now}`,
        source: "chat",
        text,
        at: now,
        ownerRef: true,
        sentiment: sentimentOf(text),
        arousal: Math.min(1, (text.match(/[!！]/g)?.length ?? 0) * 0.2),
    };
    const appraisal = appraise({
        material,
        needs,
        sinceUserMs: now - state.lastUserAt,
        hour: new Date(now).getHours(),
        affinity,
    });
    return {
        ...state,
        drives,
        drivesAt: now,
        affinity,
        lastUserAt: now,
        mood: { emotion: appraisal.emotion, intensity: appraisal.intensity, at: now, reason: appraisal.reason },
    };
}

function bumpForNeeds(drives: Drives, needs: Partial<Record<NeedKey, number>>, gain: number): Drives {
    const out = { ...drives };
    for (const key of NEED_KEYS) {
        const amount = needs[key];
        if (!amount) continue;
        out[key] = clamp01(out[key] + amount * gain);
    }
    return out;
}

/** 体力：给提示词和动画用（深夜 → 句子短、动作少）。 */
export function energyNow(now: number): number {
    return energyAt(new Date(now).getHours());
}

export function createInitialState(now: number): PresenceState {
    return {
        version: 1,
        drives: { connect: 0.45, care: 0.3, play: 0.35, learn: 0.3, share: 0.35, create: 0.25, rest: 0.3 },
        drivesAt: now,
        mood: null,
        affinity: 0.15,
        lastUserAt: now,
        lastSelfAt: now,
        lastOutreachAt: 0,
        outreachDate: localDateKey(now),
        outreachToday: 0,
        goals: [],
        observations: {},
        pending: [],
        nextFireAt: now + 20 * 60_000,
        lastGoalId: "",
        recentNeeds: [],
    };
}

/**
 * 主动搭话的提示词。
 *
 * 三条来自 surfcore 的硬要求：
 *   ① 给她**候选方向**而不是命令 —— 允许改写、允许换、允许不发；
 *   ② 明确「不要提这是定时任务 / 机制」；
 *   ③ 短。主动搭话是搭话，不是小作文。
 */
export function buildOutreachPrompt(input: {
    goal: GoalHypothesis | null;
    goals: GoalHypothesis[];
    state: PresenceState;
    now: number;
    cfg: PresenceConfig;
}): string {
    const { goal, goals, state, now } = input;
    const drives = effectiveDrives(state, now);
    const top = NEED_KEYS.map((key) => ({ key, v: drives[key] ?? 0 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 2)
        .map((x) => `${x.key} ${Math.round(x.v * 100)}%`)
        .join(" / ");
    const gapMin = Math.round((now - state.lastUserAt) / 60_000);
    const gapText = gapMin < 60 ? `${gapMin} 分钟` : `${Math.round(gapMin / 60)} 小时`;
    const d = new Date(now);
    const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const pending = state.pending.slice(0, 3).map((p) => `「${p.text}」`).join("、");

    const candidates = goals
        .filter((g) => g.status !== "rejected" && g.status !== "done")
        .slice(0, Math.max(1, input.cfg.maxGoals))
        .map((g, i) => `${i + 1}. ${g.intent}（置信度 ${Math.round(g.confidence * 100)}%，${g.action === "ask" ? "只能问，别替主人决定" : "可以直接说"}）`)
        .join("\n");

    const lines = [
        `【主动找主人说一句话】现在是 ${clock}，你已经 ${gapText} 没和主人说话了。`,
        `你此刻的状态：情绪 ${state.mood?.emotion ?? "content"}（${state.mood?.reason ?? "没什么特别的"}）；最想要的是 ${top}。`,
    ];
    if (pending) lines.push(`心里还惦记着：${pending}。`);
    lines.push("这次可以先冒出来的念头：", `→ ${goal?.intent ?? "随你，想说什么都行"}`);
    if (candidates) lines.push("备选方向（可以改写、可以换、也可以都不用）：", candidates);
    lines.push(
        "要求：",
        "· 用你自己的口吻，1~2 句就够，像随口说的，不要小作文；",
        "· 结合你此刻的状态，但**不要把状态念出来**，也不要提「定时」「机制」「状态」「驱动」这类词；",
        "· 不要重复你最近说过的话；不要问「你在吗」这种空问题，要具体；",
        "· 如果实在没话说，只输出一行：SKIP（这比硬找话好）；",
        "· 直接输出你要说的那句话，不要 JSON、不要引号、不要解释。",
    );
    return lines.join("\n");
}
