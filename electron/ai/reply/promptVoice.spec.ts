// @vitest-environment node
// electron/ai/reply/promptVoice.spec.ts
// 整段提示词的「形」：分层顺序、硬禁令是否回潮、场合层与在场感是否还在压长度。
// 逐条对应核心版 scripts/smoke-prompt-voice.js 的 4、7、8 节。
//
// 为什么按「整段」而不是按单测函数钉：这四条（身份 → 声音 → 事实 → 契约）任何一条
// 顺序错位或丢失，单测函数本身都还是绿的 —— 只有把拼好的 system 基座拿出来检查才看得见。
//
// 尤其注意「不许出现字数上限」这几条：退化方式极其自然（抱怨声立刻消失、人也立刻变冷，
// 而且要好几天才有人发现），所以这里用正则直接扫。
import { describe, expect, it } from "vitest";
import { CONVERSATIONAL_RULES, THINK_IMMERSION, VOICE_RULES } from "./style";
import { DEFAULT_PERSONA } from "./persona";
import { buildBasePrompt, buildSystemPrompts } from "./promptBuilder";
import { buildSceneContext } from "./sceneContext";
import { buildPaceBlock } from "../presence/presenceBlock";
import type { PresenceState } from "../presence/types";

/** 任何「字数上限」写法都算退化：正文里不许出现。 */
const HARD_LIMIT = /不超过\s*\d+\s*字|字以内|\d+~\d+ 句/;

describe("声音层：倾向，不是禁令", () => {
    it("明确写「是倾向，不是禁令」", () => {
        expect(CONVERSATIONAL_RULES).toContain("倾向");
        expect(CONVERSATIONAL_RULES).toContain("不是禁令");
    });

    it("允许碰到感兴趣的展开讲", () => {
        expect(CONVERSATIONAL_RULES).toContain("展开讲");
    });

    it("允许分多条短消息（配合气泡拆分）", () => {
        expect(CONVERSATIONAL_RULES).toContain("几条短消息");
    });

    it("允许主动追问", () => {
        expect(CONVERSATIONAL_RULES).toContain("想追问就追问");
    });

    it("保留去 AI 味黑名单", () => {
        expect(CONVERSATIONAL_RULES.includes("客服") || CONVERSATIONAL_RULES.includes("三段式")).toBe(true);
    });

    it("不再写字数上限", () => {
        expect(CONVERSATIONAL_RULES).not.toMatch(HARD_LIMIT);
    });

    it("不再禁反问", () => {
        expect(CONVERSATIONAL_RULES).not.toContain("不要反问");
    });

    it("不再用「最后一句不许」这种绝对禁令", () => {
        expect(CONVERSATIONAL_RULES).not.toContain("不许是结论");
    });

    it("声音层 = 说话倾向 + DeepSeek 沉浸指令（顺序固定）", () => {
        expect(VOICE_RULES).toBe(CONVERSATIONAL_RULES + "\n" + THINK_IMMERSION);
        expect(THINK_IMMERSION).toContain("角色沉浸要求");
    });
});

describe("基座顺序：身份 → 声音 → 事实 → 契约", () => {
    it("身份层在最前", () => {
        expect(buildBasePrompt(null).startsWith("【身份")).toBe(true);
    });

    it("声音层在身份之后、事实之前", () => {
        const built = buildBasePrompt(null);
        const idAt = built.indexOf("【身份");
        const voiceAt = built.indexOf("【说话方式");
        const factAt = built.indexOf("在回答涉及具体事实的问题时");
        expect(voiceAt).toBeGreaterThan(idAt);
        expect(voiceAt).toBeLessThan(factAt);
    });

    it("JSON 契约在最后", () => {
        const built = buildBasePrompt(null);
        expect(built.lastIndexOf("请只输出一个 JSON 对象")).toBeGreaterThan(
            built.indexOf("在回答涉及具体事实的问题时"),
        );
    });

    it("基座里不再有旧的硬上限与「不要反问」", () => {
        const built = buildBasePrompt(null);
        expect(built).not.toContain("不超过 50 字");
        expect(built).not.toContain("不要反问");
        expect(built).not.toMatch(HARD_LIMIT);
    });

    it("基座里包含预设人格正文", () => {
        expect(buildBasePrompt(null)).toContain(DEFAULT_PERSONA);
    });

    it("自定义人格走同一个基座，且包在身份层里", () => {
        const custom = "你叫小满，说话有点冲，但对熟人黏。";
        const built = buildBasePrompt(custom);
        expect(built.startsWith("【身份 · 你是谁】（主人亲手写的设定")).toBe(true);
        expect(built).toContain(custom);
        expect(built).toContain("【说话方式");
    });

    it("四条分支都从基座派生（人格锚点不会漂）", () => {
        const base = buildBasePrompt(null);
        const sys = buildSystemPrompts(base);
        for (const key of ["withTools", "polish", "locationSet", "normal"] as const) {
            expect(sys[key].startsWith(base), `分支 ${key} 没有从基座派生`).toBe(true);
        }
    });
});

describe("场合层：不再把长度压死", () => {
    it("不再写「短一点更像真人」", () => {
        expect(buildSceneContext({ isOwner: true })).not.toContain("短一点更像真人");
    });

    it("改成「长短看有没有得说」", () => {
        expect(buildSceneContext({ isOwner: true })).toContain("长短看有没有得说");
    });

    it("反问从「不要每句」改成「别每句」", () => {
        const out = buildSceneContext({ isOwner: true });
        expect(out).not.toContain("不要每句都用反问");
        expect(out).toContain("别每句都用反问");
    });

    it("语气词那条从「少用」改成「别堆」（少用=劝她别说话）", () => {
        const out = buildSceneContext({ isOwner: true });
        expect(out).not.toContain("少用语气词");
        expect(out).toContain("语气词和波浪号别堆");
    });
});

describe("在场感：说话节奏只说状态", () => {
    const deepNight = {
        version: 1,
        mood: { emotion: "tired", intensity: 0.8, at: Date.now(), reason: "累" },
        drives: { connect: 0.4, care: 0.3, play: 0.3, learn: 0.3, share: 0.3, create: 0.2, rest: 0.5 },
        lastUserAt: Date.now() - 3600_000,
        lastSelfAt: 0,
        pending: [],
        outreachToday: 0,
        outreachDate: "2026-11-25",
        affinity: 0.5,
        drivesAt: Date.now(),
        goals: [],
        observations: {},
        nextFireAt: 0,
        lastGoalId: "",
        recentNeeds: [],
    } as unknown as PresenceState;

    /** 固定时刻，避免测试随本机时间漂移。 */
    const at = (hour: number) => new Date(2026, 10, 25, hour, 0, 0).getTime();

    it("深夜的节奏块不再写「40 字」", () => {
        expect(buildPaceBlock(deepNight, at(3))).not.toContain("40 字");
    });

    it("深夜的节奏块不再写「不要反问」", () => {
        expect(buildPaceBlock(deepNight, at(3))).not.toContain("不要反问");
    });

    it("深夜的节奏块不写任何字数上限", () => {
        expect(buildPaceBlock(deepNight, at(3))).not.toMatch(HARD_LIMIT);
    });

    it("深夜仍会说「困」这层状态", () => {
        const pace = buildPaceBlock(deepNight, at(3));
        expect(pace.includes("困") || pace.includes("心情不高")).toBe(true);
    });

    it("心情低沉（lonely）时给状态、不给上限", () => {
        const lonely = {
            ...deepNight,
            mood: { emotion: "lonely", intensity: 0.7, at: Date.now(), reason: "很久没出现" },
        } as unknown as PresenceState;
        const pace = buildPaceBlock(lonely, at(14));
        expect(pace).toContain("心情不高");
        expect(pace).not.toMatch(HARD_LIMIT);
        expect(pace).not.toContain("不要反问");
    });

    it("白天心情正常时返回空串（不打扰，也不暗示每轮都要克制）", () => {
        const calm = {
            ...deepNight,
            mood: { emotion: "content", intensity: 0.2, at: Date.now(), reason: "没什么特别的" },
        } as unknown as PresenceState;
        expect(buildPaceBlock(calm, at(14))).toBe("");
    });

    it("状态缺失时返回空串", () => {
        expect(buildPaceBlock(null, at(3))).toBe("");
        expect(buildPaceBlock(undefined, at(3))).toBe("");
    });
});
