// electron/ai/reply/speakingDesire.spec.ts
// 「此刻的说话欲望」的回归测试，逐条对应核心版 scripts/smoke-prompt-voice.js 的 5~6 节。
//
// 为什么值得单独钉一份：这一层是「高冷」问题的对症药。上一版把长度写死成
// 「闲聊 1~3 句、不超过 50 字」「不要反问」，效果是稳定的——稳定地短、稳定地冷。
// 现在长度由五个可解释的信号算出来，所以最容易的退化方式有两种，两种都要挡住：
//   ① 有人嫌麻烦，把固定字数上限又写回提示块里；
//   ② 有人把档位算错，让「深夜+累」也落进「很想聊」（那她半夜能写小作文）。
import { describe, expect, it } from "vitest";
import {
    ACK_ONLY,
    DEPTH_MARKERS,
    LEVELS,
    LEVEL_LINES,
    LOW_MOODS,
    MOOD_VALENCE,
    WEIGHTS,
    buildDesireBlock,
    computeSpeakingDesire,
    driveScore,
    knowledgeScore,
    moodScore,
    pickLevel,
    topicScore,
} from "./speakingDesire";

/** 一个"平常的下午"：精力正常、心情平淡、驱动一般。 */
const base = {
    energy: 0.6,
    mood: { emotion: "content", intensity: 0.4 },
    drives: { connect: 0.4, share: 0.35 },
};

describe("打分信号：五个，权重和为 1", () => {
    it("权重加起来是 1（改性格不能悄悄改总分尺度）", () => {
        const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 10);
    });

    it("情绪表覆盖 presence/types 的全部 11 种情绪", () => {
        for (const emotion of [
            "content",
            "lonely",
            "curious",
            "worried",
            "excited",
            "amused",
            "bored",
            "proud",
            "affectionate",
            "tired",
            "envious",
        ]) {
            expect(MOOD_VALENCE[emotion], `情绪「${emotion}」没有打分`).toBeTypeOf("number");
        }
    });

    it("高唤醒情绪往上推、疲惫往下压", () => {
        expect(moodScore({ emotion: "excited", intensity: 0.8 })).toBeGreaterThan(
            moodScore({ emotion: "content", intensity: 0.4 }),
        );
        expect(moodScore({ emotion: "tired", intensity: 0.8 })).toBeLessThan(
            moodScore({ emotion: "content", intensity: 0.4 }),
        );
    });

    it("没有心情信息时取中立值（不默认冷，也不默认热）", () => {
        expect(moodScore(null)).toBe(0.55);
        expect(moodScore({ intensity: 0.9 })).toBe(0.55);
    });

    it("驱动越高越有话说，久没说话再加一点", () => {
        const low = driveScore({ connect: 0.1, share: 0.1 }, 0);
        const high = driveScore({ connect: 0.9, share: 0.9 }, 0);
        expect(high).toBeGreaterThan(low);
        expect(driveScore({ connect: 0.3 }, 13 * 3600_000)).toBeGreaterThan(driveScore({ connect: 0.3 }, 0));
    });

    it("知识命中比记忆命中更有底，都没有最低", () => {
        expect(knowledgeScore({ kbHit: true })).toBeGreaterThan(knowledgeScore({ memHit: true }));
        expect(knowledgeScore({ memHit: true })).toBeGreaterThan(knowledgeScore({}));
    });

    it("话题信号：问得认真加分，纯应声减分", () => {
        expect(topicScore("你为什么总是这个点还不睡啊")).toBeGreaterThan(topicScore("嗯"));
        expect(DEPTH_MARKERS.test("为什么会这样")).toBe(true);
        expect(ACK_ONLY.test("嗯嗯嗯")).toBe(true);
        expect(ACK_ONLY.test("嗯我去睡了")).toBe(false);
    });

    it("档位表从高到低，且最低档兜底 0", () => {
        expect(LEVELS.map((l) => l.level)).toEqual(["eager", "engaged", "steady", "brief"]);
        expect(pickLevel(0.99).level).toBe("eager");
        expect(pickLevel(0).level).toBe("brief");
        // 每个档位都必须有提示语，否则拼出来是个空标题
        for (const item of LEVELS) expect(LEVEL_LINES[item.level as keyof typeof LEVEL_LINES].length).toBeGreaterThan(0);
    });

    it("低落档就是那几种心情", () => {
        expect([...LOW_MOODS].sort()).toEqual(["bored", "envious", "lonely", "tired", "worried"]);
    });
});

describe("算档位：四个关键情形", () => {
    it("一句「嗯」→ 低档位（不落进 eager/engaged）", () => {
        // 核心版 smoke 钉的是「应声的分数 < 兴奋的分数」这个关系，而不是某个固定数字：
        // 档位阈值属于「说话欲望的性格」，允许调；调完之后「应声比兴奋低」不能翻。
        const dull = computeSpeakingDesire({ ...base, text: "嗯" });
        expect(dull.score).toBeLessThan(0.55);
        expect(["brief", "steady"]).toContain(dull.level);
        expect(dull.reasons).toContain("这一轮没什么可展开的");
    });

    it("兴奋 + 认真地在问 + 有底 → 高档位", () => {
        const lively = computeSpeakingDesire({
            ...base,
            energy: 0.9,
            mood: { emotion: "excited", intensity: 0.8 },
            drives: { connect: 0.7, share: 0.6 },
            text: "你为什么总是这个点还不睡啊，是不是又在赶那个东西",
            knowledge: { memHit: true },
        });
        expect(["eager", "engaged"]).toContain(lively.level);
        expect(lively.score).toBeGreaterThan(computeSpeakingDesire({ ...base, text: "嗯" }).score);
    });

    it("深夜 + 累 → 不高于平常", () => {
        const tired = computeSpeakingDesire({
            ...base,
            energy: 0.15,
            mood: { emotion: "tired", intensity: 0.8 },
            text: "你为什么总是这个点还不睡啊",
        });
        expect(["brief", "steady"]).toContain(tired.level);
        expect(tired.reasons).toContain("精力低（深夜/清晨）");
    });

    it("群聊里收敛一档，且不给她「很想聊」", () => {
        const livelyInput = {
            ...base,
            energy: 0.9,
            mood: { emotion: "excited", intensity: 0.8 },
            drives: { connect: 0.7, share: 0.6 },
            text: "你为什么总是这个点还不睡啊，是不是又在赶那个东西",
            knowledge: { kbHit: true },
        };
        expect(computeSpeakingDesire(livelyInput).level).toBe("eager");
        const group = computeSpeakingDesire({ ...livelyInput, isGroup: true });
        expect(group.level).not.toBe("eager");
        expect(group.reasons).toContain("群聊场合，收敛一档");
    });

    it("分数恒在 0~1，空输入不炸", () => {
        const cases = [
            computeSpeakingDesire(),
            computeSpeakingDesire({ energy: 99, text: "嗯" }),
            computeSpeakingDesire({ energy: -5, mood: { emotion: "excited", intensity: 99 } }),
        ];
        for (const d of cases) {
            expect(d.score).toBeGreaterThanOrEqual(0);
            expect(d.score).toBeLessThanOrEqual(1);
        }
        expect(computeSpeakingDesire().level).toBe("steady");
    });

    it("每个信号都能解释（reasons 能定位是哪项把档位压低了）", () => {
        const d = computeSpeakingDesire({ ...base, text: "嗯" });
        expect(d.reasons).toContain("这一轮没什么可展开的");
        const know = computeSpeakingDesire({ ...base, text: "这个怎么弄", knowledge: { kbHit: true } });
        expect(know.reasons).toContain("这个话题她有底，可以讲具体些");
    });
});

describe("提示块：只给倾向，不写上限", () => {
    const lively = computeSpeakingDesire({
        ...base,
        energy: 0.9,
        mood: { emotion: "excited", intensity: 0.8 },
        drives: { connect: 0.7, share: 0.6 },
        text: "你为什么总是这个点还不睡啊，是不是又在赶那个东西",
        knowledge: { memHit: true },
    });

    it("有标题且带档位名", () => {
        const block = buildDesireBlock(lively);
        expect(block).toContain("此刻的说话欲望");
        expect(block).toContain(lively.label);
    });

    it("不写字数上限", () => {
        // 这是整次改造的正题：一旦有人把「不超过 N 字」写回来，这段就重新变成枷锁。
        for (const d of [lively, computeSpeakingDesire({ ...base, energy: 0.15, text: "嗯" })]) {
            const block = buildDesireBlock(d);
            expect(block).not.toMatch(/不超过\s*\d+\s*字|字以内|\d+~\d+ 句/);
        }
    });

    it("明确「是倾向不是上限」", () => {
        expect(buildDesireBlock(lively)).toContain("不是上限");
    });

    it("堵住「拿简短当冷淡」", () => {
        expect(buildDesireBlock(lively)).toContain("没有温度");
    });

    it("知识命中时多点一句「有底可以讲具体」", () => {
        expect(buildDesireBlock(lively)).toContain("确实有底");
    });

    it("空输入返回空串（调用方不该塞一个空标题）", () => {
        expect(buildDesireBlock(null)).toBe("");
        expect(buildDesireBlock(undefined)).toBe("");
    });
});
