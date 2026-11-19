// electron/ai/memoryJudge.ts
// 记忆归属与可信度的「大模型复核」层（桌面端镜像）。
//
// ── 为什么需要这一层（用户原话）──────────────────────────────────────
//   「等会，共享池不应该只有主人才能放，有没有办法加入更精准判断，
//     必要时我觉得需要大模型思考和二次确认」
//   「谁在说话也是一个很重要的考量，要是我随便说一个别人的信息怎么办，
//     这万一不是事实呢」
//
// 正则启发式（memory.ts 里的 epistemicFor / rehomeSelfSubject）能挡住
// 大部分明显情况，但有两个天生缺陷：
//   ① 只认字面： 「他老婆还不知道」里有"不知道"，但这句话仍可能在说别人的私事
//   ② 不懂语义否定与转述层级： 「小张没出轨」被负面词表命中会误判成 rumor，
//      而「听说小张人挺好的」又不该被当成事实
//
// 所以在启发式**拿不准**或**风险高**时，交给模型真读一遍；模型想把涉及
// 第三方的信息认定为**事实**时，再独立问一次做交叉确认。
//
// ── 关键安全原则 ────────────────────────────────────────────────────
//   1. 这一层**永远不能阻塞或搞挂 remember()**。任何异常（没配模型、
//      超时、返回垃圾）都必须静默退化到启发式结果。
//   2. 出错时一律**往低可信度退化**（rumor 方向），绝不往 fact 升级。
//      判成传闻只是话说得谨慎，判成事实却会替谣言背书 —— 代价不对称。
//   3. 只在必要时调用，控制成本（见 shouldConsult）。
//
// 与 kirari-core 的 src/ai/memoryJudge.js 必须保持一致。

/** 记忆可信度四档，与 memory.ts 的 EPISTEMIC 同值。 */
export const LEVELS = ["fact", "observed", "hearsay", "rumor"] as const;
export type JudgeLevel = (typeof LEVELS)[number];

/** 最小可用的 OpenAI 客户端形状（只用到 chat.completions.create）。 */
type ChatClient = {
    chat: { completions: { create: (req: any) => Promise<any> } };
};

export type JudgeAiContext = { openai?: ChatClient | null; model?: string } | null | undefined;

/**
 * 判断要不要请模型复核。
 *
 * 成本与收益的取舍：
 *   · 一句话的日常记忆（「我不吃辣」）→ 不请模型，启发式足够，
 *     而且这类写入频率最高，全量调用会显著抬高成本
 *   · 涉及第三方 / 命中负面词 / 启发式已判低可信度 → 请模型
 */
export function shouldConsult(opts: {
    content?: string;
    aboutPerson?: string | null;
    heuristicLevel?: string;
    negativeHit?: boolean;
}): boolean {
    const text = String(opts.content || "");
    if (!text) return false;
    // 涉及他人负面信息 —— 最高优先级，必须复核
    if (opts.negativeHit) return true;
    // 明确在说第三方的事
    if (opts.aboutPerson) return true;
    // 启发式已倾向"不是事实"，复核一次（只可能维持或降级，无升级风险）
    if (opts.heuristicLevel === "rumor" || opts.heuristicLevel === "hearsay") return true;
    // 出现第三人称指代但归属不明 —— 正是容易判错的地方
    if (/(他|她|他们|她们|人家|那人|这个人|那个人)/.test(text) && text.length >= 8) return true;
    return false;
}

/** 一次单轮模型调用。失败抛异常（由调用方兜）。温度 0 让分类可复现。 */
async function askOnce(aiContext: JudgeAiContext, systemPrompt: string, userPrompt: string): Promise<string> {
    const client = aiContext && aiContext.openai;
    if (!client) throw new Error("no_ai_context");
    const res = await client.chat.completions.create({
        model: aiContext!.model,
        temperature: 0,
        max_tokens: 120,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
    });
    const out = res && res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : "";
    return String(out || "");
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹与前后废话）。 */
export function parseJsonLoose(raw?: string): any | null {
    const s = String(raw || "").trim();
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch {
        /* 继续 */
    }
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            /* 继续 */
        }
    }
    const brace = s.match(/\{[\s\S]*\}/);
    if (brace) {
        try {
            return JSON.parse(brace[0]);
        } catch {
            /* 继续 */
        }
    }
    return null;
}

const SYSTEM_ATTRIBUTION = [
    "你是一个记忆归属判别器。给你一句\"别人对 AI 说的话\"，你要判断两件事，只输出 JSON。",
    "",
    "## 判断一：这句话主要在说谁的事？（subject）",
    '  "speaker"   —— 说他自己：他的习惯、偏好、经历、要求、近况',
    '  "kirari"    —— 说这个 AI 自己：她的人格、设定、成长、心情、她该怎么表现',
    '  "third"     —— 说一个不在场的第三方',
    '  "unclear"   —— 真的分不清',
    "",
    "## 判断二：这句话有多可信？（epistemic）",
    '  "fact"      —— 陈述自己确定知道的事，或当事人自己说的',
    '  "observed"  —— 说话人称自己亲眼所见',
    '  "hearsay"   —— 转述别人的话，说话人不是当事人',
    '  "rumor"     —— 传闻、猜测、或涉及第三方私生活的负面陈述',
    "",
    "## 关键规则（必须遵守）",
    "1. **说别人的负面私事，一律 rumor**，哪怕说话人语气非常确定。",
    '   例：「小张出轨了」「我朋友欠了赌债」→ third + rumor',
    "2. **转述不等于事实**。只要说话人不是在说自己的亲历，就不是 fact。",
    '   例：「听说小王离婚了」→ third + hearsay',
    "3. 说自己的事 → fact。",
    '   例：「我不吃辣」「我下周三要出差」→ speaker + fact',
    "4. 否定句不要误判。",
    '   例：「小张没有出轨，别乱说」→ third + hearsay（是在否认传闻，不是在传）',
    "5. 关于 AI 本身的设定/人格/她该怎么做 → kirari + fact",
    "",
    "## 输出格式（只输出这个 JSON，不要任何解释）",
    '{"subject":"speaker|kirari|third|unclear","epistemic":"fact|observed|hearsay|rumor","confidence":0到1的小数,"reason":"十个字以内"}',
].join("\n");

export type AttributionVerdict = {
    subject: "speaker" | "kirari" | "third" | "unclear";
    epistemic: JudgeLevel;
    confidence: number;
    reason: string;
};

/**
 * 请模型判断一条记忆的归属与可信度。
 * 任何失败都返回 null（调用方据此保留启发式结果）。
 */
export async function judgeAttribution(
    aiContext: JudgeAiContext,
    opts: { content?: string; speakerId?: string; speakerRole?: string },
): Promise<AttributionVerdict | null> {
    const text = String(opts.content || "").slice(0, 800);
    if (!text) return null;

    const userPrompt = [
        `说话人账号：${opts.speakerId || "未知"}`,
        `说话人是否拥有者：${opts.speakerRole === "owner" ? "是" : "否"}`,
        "",
        `他说的话：「${text}」`,
    ].join("\n");

    try {
        const raw = await askOnce(aiContext, SYSTEM_ATTRIBUTION, userPrompt);
        const obj = parseJsonLoose(raw);
        if (!obj || typeof obj !== "object") return null;

        const subjectRaw = String(obj.subject || "").toLowerCase();
        const subject = (["speaker", "kirari", "third", "unclear"] as const).includes(subjectRaw as any)
            ? (subjectRaw as AttributionVerdict["subject"])
            : "unclear";
        const epiRaw = String(obj.epistemic || "").toLowerCase();
        const epistemic = (LEVELS as readonly string[]).includes(epiRaw) ? (epiRaw as JudgeLevel) : "hearsay";
        const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
        const reason = String(obj.reason || "").slice(0, 40);
        return { subject, epistemic, confidence, reason };
    } catch (e: any) {
        // 不抛：调用方必须能继续。只留一行日志便于排查。
        console.warn(`[memoryJudge] 归属判别失败（已退化为启发式）: ${e?.message || e}`);
        return null;
    }
}

const SYSTEM_CONFIRM = [
    "你是第二道复核。前一道判断要把一条涉及第三方的信息认定为**事实（fact）**，这在下面的场景里是危险的，请你独立判断。",
    "",
    '只回答 JSON：{"agree":true|false,"epistemic":"fact|observed|hearsay|rumor","why":"十个字以内"}',
    "",
    "## 复核标准",
    "只有当说话人**确实直接知道**这件事（他是当事人，或他明确说自己亲眼所见），才 agree=true。",
    "以下情况必须 agree=false：",
    '  · 他是从别人那里听来的（"听说""据说"）',
    "  · 他在评价别人的品行、感情、健康、财务",
    "  · 他在猜测、推测、或传播对某人的负面说法",
    "  · 他虽语气肯定，但这件事只有当事人本人能确知",
    "",
    "agree=false 时，请在 epistemic 里给出你认为的正确档位。",
].join("\n");

/**
 * 二次确认：模型想把涉及第三方的信息认定为 fact 时，独立再问一次。
 *
 * 只在这个方向做二次确认的原因：判成 rumor 的错误是「话说得过于谨慎」；
 * 判成 fact 的错误是「把谣言当事实讲出去」。代价不对称。
 */
export async function confirmFact(
    aiContext: JudgeAiContext,
    opts: { content?: string; speakerId?: string; speakerRole?: string },
): Promise<{ agree: boolean; epistemic: JudgeLevel } | null> {
    const text = String(opts.content || "").slice(0, 800);
    if (!text) return null;

    const userPrompt = [
        `说话人账号：${opts.speakerId || "未知"}`,
        `说话人是否拥有者：${opts.speakerRole === "owner" ? "是" : "否"}`,
        "",
        `前一道判断认为这句涉及第三方的话是事实：「${text}」`,
        "",
        "请你独立复核是否同意。",
    ].join("\n");

    try {
        const raw = await askOnce(aiContext, SYSTEM_CONFIRM, userPrompt);
        const obj = parseJsonLoose(raw);
        if (!obj || typeof obj !== "object") return null;
        const agree = obj.agree === true || String(obj.agree).toLowerCase() === "true";
        const epiRaw = String(obj.epistemic || "").toLowerCase();
        const epistemic = (LEVELS as readonly string[]).includes(epiRaw) ? (epiRaw as JudgeLevel) : "hearsay";
        return { agree, epistemic };
    } catch (e: any) {
        console.warn(`[memoryJudge] 二次确认失败（已退化为启发式）: ${e?.message || e}`);
        return null;
    }
}

export type MemoryVerdict = {
    subjectKind: "speaker" | "kirari" | "third" | "unclear";
    epistemic: JudgeLevel;
    consulted: boolean;
    confirmed: boolean;
    note: string;
};

/**
 * 综合判定：启发式 + 必要时模型复核 + 必要时二次确认。
 *
 * 这是给 memory.ts 调用的唯一入口。**保证有返回值**，且返回的 epistemic
 * 永远不会因为模型故障而比启发式更乐观。
 */
export async function judgeMemory(opts: {
    aiContext?: JudgeAiContext;
    content?: string;
    identity?: { counterpartId?: string; role?: string | null };
    heuristicLevel?: string;
    negativeHit?: boolean;
    aboutPerson?: string | null;
}): Promise<MemoryVerdict> {
    const aiContext = opts.aiContext;
    const content = String(opts.content || "");
    const identity = opts.identity || {};
    const heuristicLevel = (LEVELS as readonly string[]).includes(String(opts.heuristicLevel))
        ? (String(opts.heuristicLevel) as JudgeLevel)
        : "fact";
    const aboutPerson = opts.aboutPerson || null;
    const negativeHit = !!opts.negativeHit;

    const speakerId = String(identity.counterpartId || "");
    const speakerRole = String(identity.role || "");

    const heuristicSubjectKind: MemoryVerdict["subjectKind"] = aboutPerson
        ? "third"
        : heuristicLevel === "fact" || heuristicLevel === "observed"
          ? "speaker"
          : "unclear";

    const base: MemoryVerdict = {
        subjectKind: heuristicSubjectKind,
        epistemic: heuristicLevel,
        consulted: false,
        confirmed: false,
        note: "heuristic",
    };

    // 没配模型 / 不需要复核 → 直接用启发式
    if (!aiContext || !aiContext.openai) return base;
    if (!shouldConsult({ content, aboutPerson, heuristicLevel, negativeHit })) return base;

    const judged = await judgeAttribution(aiContext, { content, speakerId, speakerRole });
    if (!judged) return base; // 模型失败 → 保持启发式，绝不因此升级

    // 采纳模型结果，但**只允许往低可信度方向走**。
    const riskyUpgrade =
        (judged.subject === "third" || judged.subject === "unclear") &&
        judged.epistemic === "fact" &&
        heuristicLevel !== "fact";

    let epistemic: JudgeLevel = judged.epistemic;
    let confirmed = false;
    let note = `llm:${judged.reason || ""}`;

    if (riskyUpgrade) {
        // 想把涉及第三方的信息认定为事实 → 必须二次确认
        const second = await confirmFact(aiContext, { content, speakerId, speakerRole });
        if (second && second.agree) {
            epistemic = "fact";
            confirmed = true;
            note = `${note}|confirmed`;
        } else {
            // 任一道不同意（含第二道失败）→ 退回低可信度
            epistemic = second && (LEVELS as readonly string[]).includes(second.epistemic) ? second.epistemic : "hearsay";
            // 再保险：永远不要因为复核而变成 fact
            if (epistemic === "fact") epistemic = "hearsay";
            note = `${note}|refuted`;
        }
    }

    // 兜底：模型给出的档位不能比启发式更乐观，除非通过了二次确认。
    if (!confirmed && LEVELS.indexOf(epistemic) < LEVELS.indexOf(heuristicLevel)) {
        epistemic = heuristicLevel;
    }

    return {
        subjectKind: judged.subject,
        epistemic,
        consulted: true,
        confirmed,
        note,
    };
}
