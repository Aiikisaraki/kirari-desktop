// @vitest-environment node
// 在场感内核：驱动衰减 / 需求识别 / 情绪评价 / 目的排程闸门 / 记账 / 提示词。
// 这一层是纯逻辑，所以测试全部用「注入 now 与 rng」的方式跑，不碰时钟、不碰数据库。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_PRESENCE_CONFIG,
    appraise,
    buildOutreachPrompt,
    buildPresenceBlock,
    commitOutreach,
    createInitialState,
    decayDrives,
    effectiveDrives,
    extractTopic,
    formGoals,
    goalWeight,
    inQuietHours,
    mineSeeds,
    needAffinity,
    pickGoal,
    planOutreach,
    reconcileReplies,
    recordUserTurn,
    summarizePresence,
} from "./index";
import { isOwnerLocalSession } from "./presenceHooks";
import type { Material, PresenceConfig, PresenceState } from "./index";

const cfg: PresenceConfig = { ...DEFAULT_PRESENCE_CONFIG, quietStart: "23:30", quietEnd: "08:00" };

/** 固定一个"今天 14:00"的时刻，避免测试随本机时间漂移。 */
function at(hour: number, minute = 0): number {
    return new Date(2026, 10, 24, hour, minute, 0, 0).getTime();
}

/** 一个"已经安静了 5 小时、到点了"的状态。 */
function readyState(now: number): PresenceState {
    return {
        ...createInitialState(now),
        lastUserAt: now - 5 * 3600_000,
        lastSelfAt: now - 6 * 3600_000,
        nextFireAt: now - 1000,
    };
}

const chatMaterial = (now: number, text: string): Material => ({
    id: "m-1",
    source: "chat",
    text,
    at: now - 30 * 60_000,
    ownerRef: true,
    sentiment: -1,
});

describe("驱动衰减", () => {
    it("半衰期 8 小时：8 小时后与默认值的距离减半", () => {
        const base = { connect: 0.45, care: 0.3, play: 0.35, learn: 0.3, share: 0.35, create: 0.25, rest: 0.3 };
        const drives = { ...base, play: 0.95 };
        const out = decayDrives(drives, 0, 8 * 3600_000);
        // 0.95 → 0.35 + (0.95-0.35)*0.5 = 0.65
        expect(out.play).toBeCloseTo(0.65, 5);
        expect(out.connect).toBeCloseTo(base.connect, 5);
    });

    it("越久没说话，「想陪」越高，但封顶", () => {
        const now = at(14);
        const state = { ...createInitialState(now), lastUserAt: now - 100 * 3600_000 };
        const drives = effectiveDrives(state, now);
        expect(drives.connect).toBeGreaterThan(0.6);
        expect(drives.connect).toBeLessThanOrEqual(1);
    });

    it("衰减不会把驱动推到范围外", () => {
        const out = decayDrives(
            { connect: 5, care: -3, play: 0.5, learn: 0.5, share: 0.5, create: 0.5, rest: 0.5 },
            0,
            1000,
        );
        for (const v of Object.values(out)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });
});

describe("需求识别", () => {
    it("「我好累，还要加班」指向关心", () => {
        const needs = needAffinity("我今天好累啊，还要加班到十点");
        expect(needs.care ?? 0).toBeGreaterThan(0);
    });

    it("没有需求词的句子不产生需求", () => {
        expect(needAffinity("嗯")).toEqual({});
        expect(needAffinity("")).toEqual({});
    });
});

describe("情绪评价", () => {
    it("关于自己的事 + 主人很久没出现 → lonely", () => {
        const out = appraise({
            material: { id: "m", source: "chat", text: "你的记忆是不是会丢啊", at: 0, selfRef: true },
            needs: { connect: 0.7 },
            sinceUserMs: 9 * 3600_000,
            hour: 15,
            affinity: 0.6,
        });
        expect(out.emotion).toBe("lonely");
        expect(out.intensity).toBeGreaterThan(0);
    });

    it("主人在说累 → worried", () => {
        const out = appraise({
            material: { id: "m", source: "chat", text: "今天加班好累", at: 0, ownerRef: true, sentiment: -1 },
            needs: { care: 0.9 },
            sinceUserMs: 60_000,
            hour: 20,
            affinity: 0.5,
        });
        expect(out.emotion).toBe("worried");
    });

    it("没有任何素材且深夜 → tired", () => {
        const out = appraise({ material: null, sinceUserMs: 3600_000, hour: 3, affinity: 0.5 });
        expect(out.emotion).toBe("tired");
    });

    it("lonely 不是万金油：关系素材但没有陪伴缺口时不会硬冒出来", () => {
        const out = appraise({
            material: { id: "m", source: "chat", text: "你的记忆是不是会丢啊", at: 0, selfRef: true },
            needs: { learn: 0.6 },
            sinceUserMs: 60_000,
            hour: 15,
            affinity: 0.6,
        });
        expect(out.emotion).not.toBe("lonely");
    });
});

describe("安静时段", () => {
    it("跨零点区间：23:45 与 07:00 都算安静", () => {
        expect(inQuietHours(cfg, at(23, 45))).toBe(true);
        expect(inQuietHours(cfg, at(7, 0))).toBe(true);
    });

    it("白天不算安静；两端相同表示不设", () => {
        expect(inQuietHours(cfg, at(14, 0))).toBe(false);
        expect(inQuietHours({ quietStart: "09:00", quietEnd: "09:00" }, at(9, 0))).toBe(false);
    });
});

describe("素材与目标假设", () => {
    it("同一 need|topic 只留分数更高的一条", () => {
        const now = at(14);
        const state = readyState(now);
        const low: Material = { id: "a", source: "chat", text: "想玩游戏", at: now - 3600_000, ownerRef: true, weight: 0.2 };
        const high: Material = { id: "b", source: "chat", text: "想玩游戏", at: now - 60_000, ownerRef: true, weight: 1 };
        const seeds = mineSeeds([low, high], state, now, cfg);
        expect(seeds).toHaveLength(1);
        expect(seeds[0].material.id).toBe("b");
    });

    it("窗口外的素材不看，钉住的例外", () => {
        const now = at(14);
        const state = readyState(now);
        const old: Material = { id: "old", source: "memory", text: "一个人好寂寞，想养只猫", at: now - 90 * 24 * 3600_000 };
        const pinned: Material = { ...old, id: "pinned", pinned: true };
        expect(mineSeeds([old], state, now, cfg)).toHaveLength(0);
        expect(mineSeeds([pinned], state, now, cfg)).toHaveLength(1);
    });

    it("主题优先取书名号里的内容", () => {
        expect(extractTopic("刚看完《葬送的芙莉莲》")).toBe("葬送的芙莉莲");
    });

    it("主题挑最贴合主导需求的那一句，并剥掉填充词", () => {
        // 主导需求是 care（「痛」），所以主题取「头好痛」而不是开头那句问候
        expect(extractTopic("早，昨晚改bug改到三点，头好痛")).toBe("头好痛");
        expect(extractTopic("  今天好累啊！！")).toBe("好累啊");
        // 切句后悬空的虚词要剥掉，否则念头会写成「想问问主人『常州降温到』的事」
        expect(extractTopic("今天常州降温到 3 度，还下雨")).toBe("常州降温");
    });

    it("主人明确拒绝过的话题，一周内不再出现", () => {
        const now = at(14);
        const materials = [chatMaterial(now, "我今天好累，加班到十点")];
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials, rng: () => 0.5 });
        expect(plan.fire).toBe(true);
        // 走过一轮：她说 → 主人回「不要，没空」
        const sent = commitOutreach(state, { goal: plan.goal, now, kind: "sent", cfg, rng: () => 0.5 });
        const withReply = recordUserTurn(sent, "不要，没空", now + 60_000);
        const after = reconcileReplies(withReply, plan.goal!.id, "不要，没空", now + 60_000);
        // 下一枪：同一条素材还在窗口里，但已被拉黑，不应再出发
        const next = planOutreach({
            state: { ...after, lastUserAt: now - 5 * 3600_000, nextFireAt: now - 1000 },
            cfg,
            now: now + 4 * 3600_000,
            materials,
        });
        expect(next.fire).toBe(false);
    });

    it("记账不会把「多久没见你」的加成写回盘里（驱动不棘轮）", () => {
        const now = at(14);
        const state = { ...readyState(now), lastUserAt: now - 48 * 3600_000 };
        const materials = [chatMaterial(now, "我今天好累")];
        const first = planOutreach({ state, cfg, now, materials, rng: () => 0.5 });
        const after = commitOutreach(state, { goal: first.goal, now, kind: "sent", cfg, rng: () => 0.5 });
        // 写回的是衰减基线，不该高于「有效驱动」
        expect(after.drives.connect).toBeLessThanOrEqual(effectiveDrives(state, now).connect + 0.001);
    });

    it("置信度不会因为「只有一条素材」就被吹高", () => {
        const now = at(14);
        const state = readyState(now);
        const seeds = mineSeeds([chatMaterial(now, "我今天好累，加班到十点")], state, now, cfg);
        const goals = formGoals(seeds, state, now, cfg);
        expect(goals[0].confidence).toBeLessThan(0.6);
        expect(goals[0].risk).toBeLessThan(0.3); // 关心是低风险，可以直接说
    });
});

describe("主动搭话的闸门", () => {
    it("专注模式 / 安静时段 / 每日上限 / 刚说过话 都会拦住", () => {
        const now = at(14);
        const materials = [chatMaterial(now, "我今天好累")];
        const base = readyState(now);

        expect(planOutreach({ state: base, cfg: { ...cfg, focus: true }, now, materials }).reason).toContain("专注");
        expect(planOutreach({ state: base, cfg: { ...cfg, quietStart: "13:00", quietEnd: "18:00" }, now, materials }).reason).toContain("安静");
        expect(
            planOutreach({
                state: { ...base, outreachToday: 4 },
                cfg,
                now,
                materials,
            }).reason,
        ).toContain("已经主动说过");
        expect(
            planOutreach({
                state: { ...base, lastUserAt: now - 60_000 },
                cfg,
                now,
                materials,
            }).reason,
        ).toContain("不插嘴");
    });

    it("到点且有素材 → 出发，并给出目标", () => {
        const now = at(14);
        const plan = planOutreach({ state: readyState(now), cfg, now, materials: [chatMaterial(now, "我今天好累，加班到十点")], rng: () => 0.5 });
        expect(plan.fire).toBe(true);
        expect(plan.goal).not.toBeNull();
        expect(plan.goal?.need).toBe("care");
        expect(plan.goal?.action).toBe("care");
        expect(plan.nextAt).toBeGreaterThan(now);
    });

    it("手里没有素材、也没有惦记的事 → 不硬找话", () => {
        const now = at(14);
        const plan = planOutreach({ state: readyState(now), cfg, now, materials: [] });
        expect(plan.fire).toBe(false);
        expect(plan.reason).toContain("不硬找话");
    });

    it("素材是时间本身（time）不算「有事可说」", () => {
        const now = at(14);
        const timeOnly: Material = { id: "t", source: "time", text: "现在是下午两点", at: now };
        const plan = planOutreach({ state: readyState(now), cfg, now, materials: [timeOnly] });
        expect(plan.fire).toBe(false);
    });

    it("上一枪说过的目标会被打折，不会连着两次说同一件事", () => {
        const now = at(14);
        const state = readyState(now);
        const materials = [chatMaterial(now, "我今天好累")];
        const first = planOutreach({ state, cfg, now, materials, rng: () => 0.5 });
        expect(first.fire).toBe(true);
        const after = commitOutreach(state, { goal: first.goal, now, kind: "sent", cfg, rng: () => 0.5 });
        const second = planOutreach({ state: after, cfg: { ...cfg, gapMinMs: 0, gapMaxMs: 0 }, now: now + 1000, materials });
        // 同一条素材还在窗口里，但因为刚说过，目标分被打折；要么 hold，要么换了目标
        if (second.fire) expect(second.goal?.id).not.toBe(first.goal?.id);
    });
});

describe("记账", () => {
    it("说成之后：计数 +1、对应驱动回落、下一枪排到未来", () => {
        const now = at(14);
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const before = effectiveDrives(state, now).care;
        const after = commitOutreach(state, { goal: plan.goal, now, kind: "sent", cfg, rng: () => 0.5 });
        expect(after.outreachToday).toBe(1);
        expect(after.lastOutreachAt).toBe(now);
        expect(after.drives.care).toBeLessThan(before + 0.001);
        expect(after.nextFireAt).toBeGreaterThan(now);
    });

    it("失败会按 retryMs 重试，重试到上限后回到正常间隔", () => {
        const now = at(14);
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const retry = commitOutreach(state, { goal: plan.goal, now, kind: "failed", cfg, rng: () => 0.5 });
        expect(retry.nextFireAt).toBe(now + cfg.retryMs);
        // 把尝试次数顶到上限
        const spent = { ...state, goals: [{ ...plan.goal!, attempts: cfg.maxAttempts - 1 }] };
        const giveUp = commitOutreach(spent, { goal: spent.goals[0], now, kind: "failed", cfg, rng: () => 0.5 });
        expect(giveUp.nextFireAt).toBeGreaterThan(now + cfg.retryMs);
    });

    it("沉默只让驱动轻微回落，不算失败", () => {
        const now = at(14);
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const silent = commitOutreach(state, { goal: plan.goal, now, kind: "silent", cfg, rng: () => 0.5 });
        expect(silent.outreachToday).toBe(0);
        expect(silent.drives.care).toBeLessThan(effectiveDrives(state, now).care);
    });

    it("主人下一条消息决定这次开口是对是错", () => {
        const now = at(14);
        const state = readyState(now);
        const goal = {
            id: "g-1",
            owner: "self" as const,
            need: "care" as const,
            action: "care" as const,
            topic: "加班",
            intent: "想问问主人加班的事",
            confidence: 0.4,
            value: 0.5,
            urgency: 0.5,
            risk: 0.1,
            status: "active" as const,
            evidenceIds: [],
            attempts: 1,
            createdAt: now,
        };
        const withGoal = { ...state, goals: [goal] };
        const good = reconcileReplies(withGoal, "g-1", "谢谢你还记着，我刚到家", now);
        expect(good.goals[0].status).toBe("confirmed");
        expect(good.goals[0].confidence).toBeGreaterThan(0.4);
        const bad = reconcileReplies(withGoal, "g-1", "不要了，没空", now);
        expect(bad.goals[0].status).toBe("rejected");
        expect(bad.goals[0].confidence).toBeLessThan(0.4);
    });
});

describe("提示词与注入块", () => {
    it("主动搭话提示词给出候选方向、允许 SKIP、禁止提机制", () => {
        const now = at(14);
        const plan = planOutreach({ state: readyState(now), cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const prompt = buildOutreachPrompt({ goal: plan.goal, goals: plan.goals, state: plan.state, now, cfg });
        expect(prompt).toContain("主动找主人说一句话");
        expect(prompt).toContain("SKIP");
        expect(prompt).toContain("不要提");
        expect(prompt).toContain("1~2 句");
    });

    it("注入块包含此刻时间/间隔/心情，并明确要求不要念出来", () => {
        const now = at(14);
        const state = recordUserTurn(readyState(now), "今天加班好累", now - 60_000);
        const block = buildPresenceBlock(state, now);
        expect(block).toContain("【此刻的你】");
        expect(block).toContain("14:00");
        expect(block).toContain("不要");
        expect(buildPresenceBlock(null, now)).toBe("");
    });

    it("调试摘要能一行说完状态", () => {
        const now = at(14);
        expect(summarizePresence(readyState(now), now)).toContain("今天主动说过");
        expect(summarizePresence(null, now)).toBe("还没有状态");
    });

    it("recordUserTurn 刷新「多久没说话」并落一次情绪", () => {
        const now = at(14);
        const state = recordUserTurn(readyState(now), "我好累啊", now);
        expect(state.lastUserAt).toBe(now);
        expect(state.mood?.emotion).toBe("worried");
        expect(state.affinity).toBeGreaterThan(0.15);
    });

    it("身份边界：只有主人的本机会话才写在场感状态", () => {
        // 本机会话（纯 UUID）
        expect(isOwnerLocalSession("3f2c9a1e-8b7d-4c2a-9e1f-5a6b7c8d9e0f")).toBe(true);
        // 机器人会话（QQ 官方 / OneBot）：对外营业，不写
        expect(isOwnerLocalSession("bot-qqofficial-12345")).toBe(false);
        // 组网 relay
        expect(isOwnerLocalSession("relay-abc")).toBe(false);
        expect(isOwnerLocalSession("x-relay-3f2c")).toBe(false);
        // 任务/调度会话（workspace: / brief: / presence:）：是本机的，但不是"聊天"
        expect(isOwnerLocalSession("workspace:task-42")).toBe(false);
        expect(isOwnerLocalSession("brief:1:8")).toBe(false);
        // 空与垃圾
        expect(isOwnerLocalSession("")).toBe(false);
        expect(isOwnerLocalSession(null)).toBe(false);
        expect(isOwnerLocalSession(undefined)).toBe(false);
    });

    it("pickGoal 跳过被拒绝的目标", () => {
        const now = at(14);
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const rejected = { ...plan.goal!, status: "rejected" as const };
        expect(pickGoal([rejected], state, now)).toBeNull();
    });

    it("选目标是抽签：rng 极值能改变结果（不是永远取最大值）", () => {
        const now = at(14);
        const state = readyState(now);
        const materials = [
            chatMaterial(now, "我今天好累"),
            { id: "m-2", source: "memory" as const, text: "想玩游戏，好久没联机了", at: now - 3600_000, weight: 0.6 },
        ];
        const plan = planOutreach({ state, cfg, now, materials, rng: () => 0.5 });
        const goals = plan.goals;
        expect(goals.length).toBeGreaterThan(1);
        const low = pickGoal(goals, state, now, () => 0);
        const high = pickGoal(goals, state, now, () => 0.999);
        expect(low).not.toBeNull();
        expect(high).not.toBeNull();
        expect(low!.id).not.toBe(high!.id);
    });

    it("需求轮换：连续两次同一需求后，权重被压下去", () => {
        const now = at(14);
        const state = readyState(now);
        const plan = planOutreach({ state, cfg, now, materials: [chatMaterial(now, "我今天好累")], rng: () => 0.5 });
        const goal = plan.goal!;
        const drives = effectiveDrives(state, now);
        const fresh = goalWeight(goal, state, drives, now);
        const repeated = goalWeight({ ...goal, id: "another" }, { ...state, recentNeeds: [goal.need, goal.need] }, drives, now);
        expect(repeated).toBeLessThan(fresh);
    });
});
