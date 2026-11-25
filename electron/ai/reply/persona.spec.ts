// electron/ai/reply/persona.spec.ts
// 身份层（persona）的回归测试，逐条对应核心版 scripts/smoke-prompt-voice.js 的 1~3 节。
//
// 背景（2026-11-25 用户反馈）：
//   「是不是现在又太高冷了，态度和语气有点捉摸不清。另外我给的自定义性格提示词的权重
//     是不是下降了。」
// 那次改造把提示词拆成四层（身份 / 声音 / 状态 / 安全），人格从「裸文本拼在最前面」
// 改成「两头各钉一次」：开头是【身份】框 + 优先级声明，结尾是【返场提醒】。
//
// 这份测试钉的是退化方向：
//   · 人格又被写成一种话术模板（"活泼软萌""亲爱的主人"这类肉麻词回潮）；
//   · 自定义人格失去「优先于语气规则」的地位（那等于用户白写）；
//   · 返场提醒丢了指向（不指回「身份」，模型就继续漂回中性助手）。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_PERSONA,
    PERSONA_MAX_CHARS,
    PERSONA_PRIORITY_NOTE,
    buildPersonaBlock,
    buildPersonaEcho,
    normalizePersona,
} from "./persona";

describe("默认人格：有性子、不肉麻", () => {
    it("包含名字", () => {
        expect(DEFAULT_PERSONA).toContain("Kirari");
    });

    it("写到了性格，不只有外形", () => {
        expect(DEFAULT_PERSONA.includes("好奇心") || DEFAULT_PERSONA.includes("自己主意")).toBe(true);
    });

    it("允许话多话少随心情浮动", () => {
        expect(DEFAULT_PERSONA).toContain("话多话少");
        expect(DEFAULT_PERSONA).toContain("多讲");
    });

    it("明确不收撒娇腔 / 不堆甜腻称呼（防肉麻闸门）", () => {
        expect(DEFAULT_PERSONA.includes("不撒娇腔") || DEFAULT_PERSONA.includes("不堆甜腻")).toBe(true);
    });

    it("不含任何肉麻词", () => {
        // 用户 2026-11-25：「默认人格权重太强也会很肉麻」。
        // 这六个词是那一次的原始投诉点，任何一个回潮都说明人格又被写成了话术模板。
        for (const word of ["活泼软萌", "可爱", "亲爱的", "宝贝", "喵", "撒娇嘛"]) {
            expect(DEFAULT_PERSONA, `不该出现肉麻词「${word}」`).not.toContain(word);
        }
    });

    it("「主人」只作为权限称号出现", () => {
        expect(DEFAULT_PERSONA).toContain("带权限含义");
        // 2026-11-20 报障：朋友建的任务里全是「给主人发提醒」——默认昵称的口径必须死。
        expect(DEFAULT_PERSONA).not.toMatch(/直接叫|称呼主人为/);
    });

    it("上限常量是 20000（与 persona-file 的 PERSONA_MAX_CHARS 一致）", () => {
        expect(PERSONA_MAX_CHARS).toBe(20000);
    });
});

describe("自定义人格：包成身份层 + 优先级声明", () => {
    const custom = "你叫小满，说话有点冲，但对熟人黏。";

    it("以【身份 · 你是谁】开头", () => {
        expect(buildPersonaBlock(custom).startsWith("【身份 · 你是谁】")).toBe(true);
    });

    it("标明是主人亲手写的", () => {
        expect(buildPersonaBlock(custom)).toContain("主人亲手写的设定");
    });

    it("带优先级声明（冲突时以人格为准）", () => {
        const blk = buildPersonaBlock(custom);
        expect(blk).toContain("以它为准");
        expect(blk).toContain(PERSONA_PRIORITY_NOTE);
    });

    it("声明里给安全底线留了口子", () => {
        expect(buildPersonaBlock(custom)).toContain("根本准则");
    });

    it("正文原样保留", () => {
        expect(buildPersonaBlock(custom)).toContain(custom);
    });

    it("没写人格时回退预设，且用不带「主人亲手写的」的标题", () => {
        for (const empty of [null, undefined, "", "   "]) {
            const blk = buildPersonaBlock(empty);
            expect(blk.startsWith("【身份 · 你是谁】")).toBe(true);
            expect(blk).toContain(DEFAULT_PERSONA);
            expect(blk).not.toContain("主人亲手写的设定");
        }
    });

    it("超长人格截断到上限（不静默爆上下文）", () => {
        const long = "啊".repeat(PERSONA_MAX_CHARS + 100);
        expect(normalizePersona(long).length).toBe(PERSONA_MAX_CHARS);
    });
});

describe("返场提醒：结尾把口吻拉回人格", () => {
    const custom = "你叫小满，说话有点冲，但对熟人黏。";

    it("有标题", () => {
        expect(buildPersonaEcho(custom).startsWith("【返场提醒")).toBe(true);
    });

    it("指向开头的「身份」", () => {
        expect(buildPersonaEcho(custom)).toContain("身份");
    });

    it("说清状态只调语气", () => {
        expect(buildPersonaEcho(custom)).toContain("语气");
    });

    it("堵住「中性助手」这个默认漂移方向", () => {
        const echo = buildPersonaEcho(custom);
        expect(echo).toContain("中性");
        expect(echo).toContain("助手");
    });

    it("自定义人格时强调优先于语气规则", () => {
        expect(buildPersonaEcho(custom)).toContain("优先于");
    });

    it("预设人格时不多那一句（省 token，也不虚构「主人写过」）", () => {
        const echo = buildPersonaEcho(null);
        expect(echo).not.toContain("主人亲手写的设定");
        expect(echo).toContain("中性");
    });
});
