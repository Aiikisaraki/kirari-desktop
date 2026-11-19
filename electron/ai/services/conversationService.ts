// electron/ai/services/conversationService.ts
// 对话主流程编排：意图预检 → 位置/工具处理 → 构建上下文与 system 提示 → LLM 多轮 tool-call loop。
//
// 纯编排层：提示拼装、意图识别、流式调用、回复解析均已下沉到 ./reply/* 子模块。
//
// 由 kirari-core/src/services/conversationService.js 迁入。
// 改动：
//  1. 去掉 ws 参数（进程内没有 WebSocket，前端工具由主进程注入执行器）
//  2. sessionManager 精简为直接调 db 层（桌宠固定本地库，不再有内存/数据库两种模式）
//  3. clientIp 在桌宠本机场景无意义，保留参数供机器人复用，默认空
//  4. 所有诊断日志保留，便于与核心版对照排查

import { parseModelReply, isValidImageUrl } from "../reply/parser";
import {
    buildBasePrompt,
    buildSystemPrompts,
    getRequestTimeout,
    locationSetMessage,
    buildLocationSetRaw,
    LOCATION_ASK_MESSAGE,
    stripNonConversational,
} from "../reply/promptBuilder";
import { preflightTools, detectCorrectionIntent } from "../reply/intent";
import { buildTimeContext } from "../reply/timeContext";
import { buildSceneContext, type RawScene } from "../reply/sceneContext";
import { buildCharter } from "../reply/charter";
import * as memory from "./memory";
import * as social from "./social";
import * as selfOps from "./selfOps";
import * as locationSvc from "./locationService";
import { streamChatCompletion, polishToolResult } from "../reply/streaming";
import * as dailyBriefing from "./dailyBriefingService";
import * as knowledgeRetrieval from "../knowledge/retrievalService";
// 阶段 D：统一能力注册表（scope 隔离 + 超时 + 截断），SKILL.md 目录摘要。
import * as capabilities from "../capabilities/registry";
import * as skillMd from "../skills/skillMd";
import { getRecentMessages } from "../db/storage";
import type { AiContext } from "../aiContext";
import type { RetrievedPassage } from "../knowledge/types";
// 事件流：把「模型看到的东西」收归 append-only 事件流。
// 共享包只放纯逻辑，db 连接由 events/recorder + events/store 注入（不碰 native 模块）。
import {
    createInjector,
    buildSystemContent,
    AgentRunner,
    webSearchCapFor,
    computeLoopTimeout,
    type AgentProfile,
} from "kirari-agent";
import { recorder, beginTurn, endTurn, newTurnId, refreshEnabled } from "../events/recorder";
import { getAgentProfile, getThinking } from "../../model-config";
// 阶段 C 任务编排：plan / schedule_reminder 工具分派 + 未完成任务跨轮恢复。
import * as taskRuntime from "./taskRuntime";

// 工具循环参数已从硬编码常量收进 config.json 的 agentProfile（阶段 B）。
// 数值逐字等于改造前的 MAX_ROUNDS=5 / max_tokens=1500 / 超时 60s+15s*轮-封顶120s。

export type GetReplyOptions = {
    aiContext: AiContext;
    content?: string;
    /** 图片 URL 或 base64 data URL 列表 */
    images?: string[];
    sessionId: string;
    /** 机器人场景下带客户端 IP（桌宠本机为空） */
    clientIp?: string;
    /** 机器人客人按 scope 隔离位置记忆；桌宠本机为空 */
    locationScope?: string | null;
    /** 前端托管的 skill 行为模板（提示词形态能力） */
    skillPrompts?: string[];
    persona?: string | null;
    /** 前端主动携带的私有知识库检索结果 */
    kbContext?: RetrievedPassage[] | null;
    /** 阶段 D：能力作用域（本地 UI / 组网 hostExecutor / 机器人），隔离 frontend 工具与技能执行器 */
    capabilityScope?: string | null;
    /**
     * 场合信息：群聊/私聊、群名、发言人。
     * 用于注入【当前场合】段——让模型知道该收着还是放松，并守住群聊隐私边界。
     * 缺省（桌宠本机一对一）按「一对一对话」处理。
     */
    scene?: RawScene | null;
    /** 外部取消（用户点了停止生成） */
    signal?: AbortSignal;
    /**
     * 正文逐字回调（上层做流式展示）。约定：
     *   onDelta(text) —— 追加一段正文增量
     *   onDelta(null) —— 前面流出的内容作废（工具轮碎片/换收尾路径），调用方应清空
     * 回调抛出的异常一律吞掉：流式展示是锦上添花，绝不能因为它打断生成。
     */
    onDelta?: ((text: string | null) => void) | null;
};

export type ReplyResult = {
    speech: string;
    emotion: string | null;
    images: string[];
    action: string;
    mood: string;
    /** 回复来源，便于排障：model / model_salvaged / tool_direct / location_ask / location_set */
    source: string;
    model: string;
    usage: unknown;
    sessionId: string;
    userid: number;
};

/**
 * 兜底收尾：模型在工具循环末尾只吐了 reasoning、或流被截断导致 content 为空时，
 * 用 tools:undefined + 一句强指令强制模型直接产出最终文本（不再调用任何工具）。
 * 自带独立 AbortController（不与主请求共享），避免主超时已触发导致救回也一并被掐断。
 */
async function salvageAsText(
    aiContext: AiContext,
    messages: unknown[],
    onDelta?: ((text: string | null) => void) | null,
    profile?: AgentProfile,
): Promise<string> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60000);
    try {
        // 若末尾是一条被截断的空 assistant 消息，先移除，避免部分供应商拒绝空 content
        const cleaned = messages.filter(
            (m, i) =>
                !(
                    i === messages.length - 1 &&
                    (m as { role?: string }).role === "assistant" &&
                    !(m as { content?: string }).content?.trim() &&
                    (!(m as { tool_calls?: unknown[] }).tool_calls ||
                        (m as { tool_calls?: unknown[] }).tool_calls!.length === 0)
                ),
        ) as { role: string; content: string }[];
        const FORCE =
            "\n\n[系统] 你必须现在直接给出最终回复，不要再调用任何工具。用你平时和主人说话的口吻回答即可。";
        const patched = cleaned.map((m) =>
            m.role === "system" ? { ...m, content: (m.content || "") + FORCE } : m,
        );
        // 前面流出去的碎片已作废（主请求没产出可用 content），先让调用方清空
        if (onDelta) {
            try {
                onDelta(null);
            } catch {
                /* ignore */
            }
        }
        const completion = await streamChatCompletion(
            aiContext.openai,
            { model: aiContext.model, messages: patched, max_tokens: profile ? profile.maxTokens : 1500 },
            { signal: ctrl.signal, onDelta },
        );
        return completion.choices?.[0]?.message?.content || "";
    } finally {
        clearTimeout(tid);
    }
}

export async function getReply(options: GetReplyOptions): Promise<ReplyResult> {
    const {
        aiContext,
        content = "",
        images = [],
        sessionId,
        clientIp = "",
        locationScope = null,
        skillPrompts = [],
        persona = null,
        kbContext = null,
        capabilityScope = null,
        scene = null,
        onDelta = null,
        signal,
    } = options;

    // 阶段 D：能力作用域，缺省按「本地 UI」处理。三类调用方各持一份 frontend 工具，
    // 不再有全局 last-writer-wins（本地 UI / 组网 hostExecutor / 机器人互不覆盖）。
    const capScope = capabilityScope || capabilities.scopeKey("local", "ui");

    if (!aiContext || aiContext.closed || !aiContext.openai) {
        throw new Error("小灵的大脑还没准备好，去设置里检查一下连接吧");
    }

    const text = content.trim();
    const imgList = Array.isArray(images)
        ? images.filter((x) => typeof x === "string" && x.trim() && isValidImageUrl(x))
        : [];

    // 人格基座：自定义人格优先，缺省回退预设。各分支 prompt 全部由此派生，
    // 因此无论选用哪个模型、走哪条分支，人格锚点都一致，不会漂移。
    const base = buildBasePrompt(persona);
    const sys = buildSystemPrompts(base);

    if (!text && imgList.length === 0) {
        throw new Error("消息不能为空");
    }

    // 本轮工具循环参数从 config.json 的 agentProfile 读（改配置立即生效）。
    // 缺配置首次补写默认落盘；缺字段 / 坏值显式报错，不回退默认值。
    const profile = getAgentProfile();

    const controller = new AbortController();
    // 外部取消信号透传：用户点停止生成时立刻中断
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }

    // 超时随"可能触发的工具轮次"放大：基线取消息复杂度超时，
    // 再按 profile 的轮数 × 每轮预留放大，封顶由 profile 决定（见 computeLoopTimeout）。
    const baseTimeout = getRequestTimeout(text || "[用户发送了图片]");
    const timeout = computeLoopTimeout(profile, baseTimeout);
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    aiContext.activeRequests.add(controller);
    const _t0 = Date.now();

    // 一轮对话一个 turnId。所有早退 return 全部经由下面的 finally 收口，
    // 所以 turn_start / turn_end 成对出现，不需要改任何 if 判断。
    const turnId = newTurnId();
    beginTurn(turnId);
    // 每轮刷新一次事件开关。此时 initEngine() 已建库，读表不会触发兜底建库
    //（见 events/recorder.ts 里 refreshEnabled 的说明）。
    refreshEnabled();

    try {
        recorder.enqueue({
            origin: "desktop",
            sessionId,
            turnId,
            type: "turn_start",
            payload: { userid: aiContext.userid, model: aiContext.model, maxRounds: profile.maxRounds, sessionId },
        });
        // ── Step 1: 意图预检 ──
        const preflight = await preflightTools(
            text || "[用户发送了图片]",
            aiContext,
            clientIp,
            sessionId,
            locationScope ?? null,
        );

        // 需要位置但未获取：先问用户一次（不调工具、不调 LLM，直接返回追问语）
        if (preflight.needLocation) {
            return {
                speech: LOCATION_ASK_MESSAGE,
                emotion: "wave",
                images: [],
                action: "idle",
                mood: "curious",
                source: "location_ask",
                model: aiContext.model,
                usage: null,
                sessionId,
                userid: aiContext.userid,
            };
        }

        // 位置设置确认：把"已记录的行政区划"交给 LLM，用桌宠口吻告诉主人"我记成了 X"。
        // 润色失败则回退到兜底提示语。
        let confirmSpeech: string | null = null;
        if (preflight.setLocation) {
            const raw = buildLocationSetRaw(preflight.setLocation.location, preflight.setLocation.ambiguous);
            try {
                const c = await polishToolResult(raw, aiContext, sessionId, text, controller, sys.locationSet, onDelta);
                confirmSpeech = c.speech;
            } catch (e) {
                console.warn("[aiReply] 位置设置确认润色失败，回退到预设提示语：", (e as Error)?.message || e);
                confirmSpeech = locationSetMessage(preflight.setLocation.location, preflight.setLocation.ambiguous);
            }
        }

        // direct 命中（时间/天气）：先取回工具原始数据，再交给 LLM 润色成符合人设的口语；
        // 若 LLM 调用失败/无有效回复，则回退到工具原始结果，保证永远有应答。
        if (preflight.direct) {
            const rawText = preflight.direct.raw || preflight.direct.speech;
            const fallback: ReplyResult = {
                speech: preflight.direct.speech,
                emotion: preflight.direct.emotion,
                images: [],
                action: "idle",
                mood: "curious",
                source: "tool_direct",
                model: aiContext.model,
                usage: null,
                sessionId,
                userid: aiContext.userid,
            };
            try {
                const polishUserText = preflight.direct.userText || text;
                const polished = await polishToolResult(
                    rawText,
                    aiContext,
                    sessionId,
                    polishUserText,
                    controller,
                    sys.polish,
                    onDelta,
                );
                if (confirmSpeech) {
                    // 合并句：时间/天气答复 + 位置设置确认（两者均经 LLM 润色）
                    return {
                        ...polished,
                        images: [],
                        speech: `${polished.speech}\n${confirmSpeech}`,
                        source: "model",
                        userid: aiContext.userid,
                    };
                }
                return { ...polished, images: [], userid: aiContext.userid };
            } catch (e) {
                console.warn("[aiReply] LLM 润色失败，回退到工具直接回复：", (e as Error)?.message || e);
                if (confirmSpeech) {
                    return { ...fallback, speech: `${fallback.speech}\n${confirmSpeech}` };
                }
                return fallback;
            }
        }

        // 仅有位置设置确认（无 direct 查询）
        if (confirmSpeech) {
            return {
                speech: confirmSpeech,
                emotion: "happy",
                images: [],
                action: "idle",
                mood: "curious",
                source: "location_set",
                model: aiContext.model,
                usage: null,
                sessionId,
                userid: aiContext.userid,
            };
        }

        // ── Step 2: 构建 messages 并调用 LLM ──
        const recentMessages = await getRecentMessages(sessionId, 6);

        // 主动感知：当日简报注入（失败静默降级，绝不阻塞主对话）
        let dailyBlock = "";
        try {
            const brief = await dailyBriefing.ensureDailyBrief(aiContext);
            if (brief) {
                dailyBlock =
                    `\n\n【今日背景 · 已自动了解，可作参考】\n日期：${dailyBriefing.todayStr()}\n` +
                    `${brief}\n（以上为截止今日的已知信息；若你不确定具体实时事实，仍可使用工具核实。）`;
            }
        } catch (e) {
            console.warn("[aiReply] 简报注入失败（已忽略）：", (e as Error)?.message || e);
        }

        // 知识库检索（Layer 1 私有库 > Layer 2 推荐源）。失败静默降级。
        let kbBlock = "";
        try {
            kbBlock = await knowledgeRetrieval.retrieveForPrompt(
                { userid: String(aiContext.userid) },
                text || "[用户发送了图片]",
                { kbContext: kbContext || undefined },
            );
        } catch (e) {
            console.warn("[aiReply] 知识库检索失败（已忽略）：", (e as Error)?.message || e);
        }

        let systemPrompt = preflight.injected
            ? sys.withTools.replace("{{TOOL_RESULTS}}", preflight.injected.join("\n"))
            : sys.normal;

        // 时间基准：查主人已存时区，生成带标签、唯一可信的「当前时间」注入段。
        // 与核心版对称；见 reply/timeContext.ts 的背景说明。
        let timeContext = "";
        try {
            const locRec = await locationSvc.getUserLocation(aiContext.userid, locationScope || undefined);
            timeContext = buildTimeContext({
                timezone: locRec?.timezone,
                locationLabel: locRec?.name || locRec?.location || undefined,
            });
        } catch (e) {
            // 查库失败也要有时间基准，用默认时区兜底，绝不留空让模型猜。
            timeContext = buildTimeContext({});
        }
        systemPrompt += timeContext;

        // 自我认知清单：像 lead 上下文里自带的工具清单那样，每轮注入「我是谁 / 我有什么能力 /
        // 当前模型 / 未完成任务与提醒 / 如何自我排查」。让模型天生就知道自己，不必先查一轮。
        try {
            systemPrompt += selfOps.buildManifest({ sessionId, capScope: capabilityScope || undefined, uid: aiContext.userid, origin: "desktop" });
        } catch (e) {
            console.warn("[aiReply] 自我认知清单注入失败（已忽略）：", (e as Error)?.message || e);
        }

        // 思考模式：on/auto 时在 system 里加「先想再答」指引（prompt 策略，对任何模型生效）。
        try {
            const thinking = getThinking();
            if (thinking !== "off") {
                systemPrompt += thinking === "on"
                    ? "\n\n【思考模式：开启】回答前先在心里列 2-4 条简要思路（可一句话带过），再给出结论；思路不要冗长，最终仍只输出约定的 JSON。"
                    : "\n\n【思考模式：自动】简单问题直接答；多步、有争议或需要权衡的问题，先列 2-4 条简要思路再深入。最终只输出约定的 JSON。";
            }
        } catch {
            /* 思考模式读取失败不影响正常回答 */
        }

        // 阶段 C：把该会话尚未完成的任务拼进 system.base，实现「新消息进来先恢复未完成任务」。
        const taskResume = taskRuntime.resumeBlock(sessionId);
        if (taskResume) systemPrompt += taskResume;

        // 场合感知：告诉模型此刻在群聊还是私聊、对谁说话、该收着还是放松，
        // 并给出群聊隐私红线与「别像模板」的语气要求。
        systemPrompt += buildSceneContext(scene);

        // 元指令（根本准则）：比人格更高一层，约束底线行为。永远追加、不可被覆盖。
        systemPrompt += buildCharter();

        // 社交环境：几个群、几个好友、多少人在周围、谁刚进群/戳她。
        // 用户 2026-11-19：「我希望她能完整意识到自己的人际关系和周围的环境。」
        // 这些是协议端的真实数据，不是记忆——两者互不替代（记忆走下面的 memory 块）。
        try {
            const envBlock = await social.buildEnvironmentBlock({
                adapterId: scene?.platform ? String(scene.platform) : null,
            });
            if (envBlock) systemPrompt += envBlock;
        } catch (e: any) {
            // 环境摘要是增强项，读失败也不能让整轮回复挂掉
            console.warn("[conversationService] 社交环境摘要注入失败（已忽略）:", e?.message || e);
        }

        // 长期记忆：按当前场合可见的记忆池做联想检索（跨对话存续的关键）。
        try {
            const mem = await memory.buildMemoryBlock(
                {
                    sessionId,
                    uid: aiContext.userid,
                    isGroup: String(scene?.chatType || "") === "group",
                    counterpartId: scene?.senderId ? String(scene.senderId) : undefined,
                    // 管理权限角色（owner/admin/user）。只影响"能改什么设置"，
                    // 不影响她记得谁——记忆按人分池，与权限无关。
                    role: scene?.role ? String(scene.role) : null,
                    displayName: scene?.senderName ? String(scene.senderName) : null,
                    platform: scene?.platform ? String(scene.platform) : null,
                },
                text || "",
            );
            if (mem.block) systemPrompt += mem.block;
        } catch (e: any) {
            console.warn("[aiReply] 记忆注入失败（已忽略）:", e?.message || e);
        }

        // 记忆机制的使用指引：只给判断标准，不逼她每轮都调工具。
        systemPrompt +=
            "\n\n【关于记忆 · 什么时候该动用 remember】" +
            "\n你有跨对话的长期记忆（工具名 memory）。它不依赖当前这场对话，所以对方下次换个窗口找你，你依然认得。" +
            "\n值得记：对方明确说「记住这个」、透露长期偏好与习惯（忌口、作息、称呼偏好）、重要个人信息、" +
            "你们约定以后要怎么做、发生了一件以后可能还会提起的事。" +
            "\n不值得记：寒暄、一次性问答、闲聊里随口提的细节、你自己刚说过的话。" +
            "\n记的时候 scope 想清楚：关于主人本人的长期事实 → self；关于此刻这个人 → person；" +
            "关于这个群/这个场合大家的事 → scene；通用约定与常识 → global。" +
            "\n不确定要不要记就先别记；记错了比没记更麻烦。对方说「忘了这件事」时用 action=forget。";

        // 阶段 D：SKILL.md 渐进披露——system 里只放目录摘要，正文用 load_skill 按需加载。
        const skillCatalog = skillMd.catalogBlock();
        // 前端上报的 skill 行为模板仍保留（与 SKILL.md 是两类能力）。
        const skillBlock =
            (Array.isArray(skillPrompts) && skillPrompts.length
                ? "\n\n# 已启用的技能（请遵循以下设定）\n" + skillPrompts.join("\n\n")
                : "") + skillCatalog;

        // 历史消息 content 可能是字符串，或 [text, image_url] 多模态数组（JSON 序列化存储）；
        // 统一归一化为 OpenAI 消息格式，确保发送过的图片在上下文里不被丢弃。
        const normalizedRecent = stripNonConversational(recentMessages).map((m) => {
            const c = m.content;
            // 过滤历史中残留的非法图片条目（裸文件名 / base64 等），避免送进模型导致报错
            const dropBadImage = (arr: unknown[]) =>
                Array.isArray(arr)
                    ? arr.filter(
                          (part) =>
                              !(
                                  part &&
                                  (part as { type?: string }).type === "image_url" &&
                                  !isValidImageUrl(
                                      (part as { image_url?: { url?: string } }).image_url?.url,
                                  )
                              ),
                      )
                    : arr;
            if (Array.isArray(c)) return { role: m.role, content: dropBadImage(c as unknown[]) };
            if (typeof c === "string") return { role: m.role, content: c };
            try {
                const parsed = JSON.parse(String(c));
                if (Array.isArray(parsed)) return { role: m.role, content: dropBadImage(parsed) };
            } catch {
                // 非 JSON，按纯文本处理
            }
            return { role: m.role, content: String(c) };
        });

        // 本轮用户消息：文本 + 图片构成多模态 content 数组
        const userParts: { type: string; text?: string; image_url?: { url: string } }[] = [];
        if (text) userParts.push({ type: "text", text });
        for (const img of imgList) {
            userParts.push({ type: "image_url", image_url: { url: img } });
        }
        const userContent =
            userParts.length > 1 || (userParts.length === 1 && userParts[0].type !== "text")
                ? userParts
                : text || "";

        // 显式注入：四段各自带 source 与 order，逐条落 context_inject 事件。
        // 过去是 systemPrompt + dailyBlock + kbBlock + skillBlock 直接相加，
        // 无法追溯「哪段是哪来的」；现在换成显式 inject，行为逐字等价
        // （buildSystemContent 用空串 join('')，段间不加任何字符）。
        const injector = createInjector({
            origin: "desktop",
            sessionId,
            turnId,
            enqueue: (event) => recorder.enqueue(event),
        });
        injector.inject("system.base", systemPrompt, { preflightInjected: preflight.injected || [] });
        injector.inject("daily_brief", dailyBlock, { failed: dailyBlock === "" });
        injector.inject("knowledge", kbBlock, { failed: kbBlock === "" });
        injector.inject("skills", skillBlock, {
            skillCount: Array.isArray(skillPrompts) ? skillPrompts.length : 0,
        });

        const messages: unknown[] = [
            { role: "system", content: buildSystemContent(injector.segments) },
            ...normalizedRecent,
            { role: "user", content: userContent },
        ];

        const correctionMode = detectCorrectionIntent(text);
        // 阶段 D：工具集统一按 scope 从能力注册表列举（内置 + 全局 MCP/技能 + 本 scope 前端工具）。
        // builtin 能力文件已含 plan / schedule_reminder / load_skill，不再额外 withTaskTools。
        const allTools = capabilities.listTools(capScope);
        const toolChoice = allTools.length ? "auto" : undefined;
        // 纠正模式限 2 次、普通模式限 4 次：达到上限即强制后续轮次纯文本收尾，
        // 避免模型反复搜索（自证式空转）把请求拖到超时。
        const webSearchCap = webSearchCapFor(profile, correctionMode);
        if (correctionMode) console.log(`[aiReply] 纠正意图命中，允许有限搜索（上限 ${webSearchCap} 次）`);

        // 循环控制（何时收尾 / 熔断上限）交给共享包 AgentRunner，停止条件语义化：
        // 有工具欠账就继续，maxRounds 只作熔断上限。IO 留在本回调内（模型/工具/事件）。
        let toolsDisabled = false; // 部分端点不支持 function calling，请求带 tools 会 400，此时降级重试
        let degenerateLoop = false; // 模型反复用近重复 query 调 web_search → 强制不再带工具
        const searchQueryHistory: string[] = [];
        let webSearchCount = 0;

        const runner = new AgentRunner<ReplyResult>(profile);
        const finalReply = await runner.run(async (round, r) => {
            let completion;
            try {
                const useTools = allTools.length && !toolsDisabled && !degenerateLoop;
                // 调用模型前落一条 request：payload.messages 是当时完整数组的逐字深拷贝，
                // 杀进程重启后靠它重建「发给模型的 messages」（Harness 的硬指标）。
                recorder.enqueue({
                    origin: "desktop",
                    sessionId,
                    turnId,
                    type: "request",
                    payload: {
                        round,
                        callSite: "main",
                        params: {
                            model: aiContext.model,
                            useTools: !!useTools,
                            max_tokens: profile.maxTokens,
                            tool_choice: useTools ? toolChoice : undefined,
                            toolsCount: useTools ? allTools.length : 0,
                        },
                        messages: JSON.parse(JSON.stringify(messages)),
                    },
                });
                completion = await streamChatCompletion(
                    aiContext.openai,
                    {
                        model: aiContext.model,
                        messages,
                        tools: useTools ? allTools : undefined,
                        tool_choice: useTools ? toolChoice : undefined,
                        max_tokens: profile.maxTokens,
                    },
                    { signal: controller.signal, onDelta },
                );
            } catch (e) {
                const err = e as Error & { name?: string };
                const errMsg = err?.message || String(e);
                const toolErr = /tool|2013|function.?call|invalid param/i.test(errMsg);
                const aborted = err?.name === "AbortError" || /abort/i.test(errMsg);
                if (!toolsDisabled && allTools.length && toolErr) {
                    console.warn(`[aiReply] 端点/模型不支持工具调用（${errMsg}），降级为纯文本重试`);
                    toolsDisabled = true;
                    completion = await streamChatCompletion(
                        aiContext.openai,
                        { model: aiContext.model, messages, max_tokens: profile.maxTokens },
                        { signal: controller.signal, onDelta },
                    );
                } else if (aborted) {
                    // 主请求超时/中断：用 salvageAsText（独立 60s 控制器）强制纯文本收尾，
                    // 实在救不回才冒泡到外层兜底，避免直接崩成"还在学习中"。
                    console.warn(`[aiReply] 主请求超时/中断（${errMsg}），尝试纯文本收尾`);
                    try {
                        const salvaged = await salvageAsText(aiContext, messages, onDelta, profile);
                        if (salvaged && salvaged.trim()) {
                            const { speech, emotion } = parseModelReply(salvaged.trim());
                            if (speech) {
                                return {
                                    kind: "final" as const,
                                    value: {
                                        speech,
                                        emotion,
                                        images: [],
                                        action: "idle",
                                        mood: "curious",
                                        source: "model_salvaged",
                                        model: aiContext.model,
                                        usage: null,
                                        sessionId,
                                        userid: aiContext.userid,
                                    },
                                };
                            }
                        }
                    } catch (se) {
                        console.warn("[aiReply] 超时后纯文本收尾失败：", (se as Error)?.message || se);
                    }
                    throw e;
                } else {
                    throw e;
                }
            }

            const msg = completion.choices[0].message;

            console.log(
                `[aiReply] round=${round} finish=${completion.choices[0].finish_reason} ` +
                    `content=${(msg.content || "").length} reasoning=${completion._reasoningContent.length} ` +
                    `chunks=${completion._chunkCount} tool_calls=${msg.tool_calls?.length || 0}`,
            );

            messages.push(msg);

            // 工具轮的中间产物：模型吐过的正文碎片随后会被 onDelta(null) 作废，
            // 记一条 discarded 事件供轨迹追溯，不进模型历史的最终态。
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                recorder.enqueue({
                    origin: "desktop",
                    sessionId,
                    turnId,
                    type: "assistant_attempt",
                    payload: {
                        round,
                        content: msg.content || "",
                        tool_calls: msg.tool_calls,
                        discarded: true,
                        reason: "tool_round",
                    },
                });
            }

            // 无工具调用 → 模型想收尾
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                const rawContent = msg.content?.trim();
                // 阶段 C：任务未完成时拦截提前收尾——text 步骤先推进，仍有未做步骤则
                // 注入 nudge、保持 turn 打开再转一轮（maxRounds 熔断兜底）。
                if (taskRuntime.hasActiveTask(sessionId)) {
                    if (rawContent) taskRuntime.advancePendingStep(sessionId, "text", null, rawContent.slice(0, 200));
                    if (taskRuntime.hasActiveTask(sessionId)) {
                        console.log("[aiReply] 任务未完成，拦截收尾并继续推进");
                        if (onDelta) {
                            try {
                                onDelta(null);
                            } catch {
                                /* ignore */
                            }
                        }
                        messages.push({ role: "user", content: taskRuntime.pendingNudge(sessionId) });
                        return { kind: "continue" as const, reason: "active task not finished" };
                    }
                    // 任务恰好在这轮完成 → 落到下方正常 final
                }
                if (!rawContent) {
                    // 流被截断（超时 abort / reasoning 吃满 max_tokens）导致 content 为空：
                    // 先强制一次"纯文本收尾"救回答案，不再硬抛。
                    console.error(
                        `[aiReply] round=${round} 内容为空，尝试强制纯文本收尾 model=${aiContext.model}`,
                    );
                    try {
                        const salvaged = await salvageAsText(aiContext, messages, onDelta, profile);
                        if (salvaged && salvaged.trim()) {
                            const { speech, emotion, images: parsedImages } = parseModelReply(salvaged.trim());
                            if (speech) {
                                return {
                                    kind: "final" as const,
                                    value: {
                                        speech,
                                        emotion,
                                        images: Array.isArray(parsedImages) ? parsedImages : [],
                                        action: "idle",
                                        mood: "curious",
                                        source: "model_salvaged",
                                        model: completion.model,
                                        usage: completion.usage,
                                        sessionId,
                                        userid: aiContext.userid,
                                    },
                                };
                            }
                        }
                    } catch (se) {
                        console.warn("[aiReply] 纯文本收尾失败：", (se as Error)?.message || se);
                    }
                    throw new Error(`模型返回内容为空（model=${aiContext.model}，可能只输出了思考过程或流被截断）`);
                }
                const { speech, emotion, images: parsedImages } = parseModelReply(rawContent);
                if (!speech) throw new Error("模型返回内容为空");
                return {
                    kind: "final" as const,
                    value: {
                        speech,
                        emotion,
                        images: Array.isArray(parsedImages) ? parsedImages : [],
                        action: "idle",
                        mood: "curious",
                        source: "model",
                        model: completion.model,
                        usage: completion.usage,
                        sessionId,
                        userid: aiContext.userid,
                    },
                };
            }

            // 有工具调用 → 这轮吐过的正文碎片全部作废（那不是最终回复），让调用方清空。
            // 然后执行工具并回灌，下一轮重新流。
            if (onDelta) {
                try {
                    onDelta(null);
                } catch {
                    /* ignore */
                }
            }
            // 领取本轮工具欠账：执行并回灌完毕后逐一 settle，账本清空才进下一轮。
            const toolCallIds = msg.tool_calls.map((tc) => tc.id);
            r.note(toolCallIds);
            for (const tc of msg.tool_calls) {
                let result: unknown;
                try {
                    const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                    const toolName = tc.function?.name;
                    recorder.enqueue({
                        origin: "desktop",
                        sessionId,
                        turnId,
                        type: "tool_call",
                        payload: { round, tool_call_id: tc.id, name: toolName, arguments: args },
                    });
                    // 退化循环检测：记录 web_search 的 query，出现近重复即标记 degenerateLoop
                    if (toolName === "web_search") {
                        webSearchCount++;
                        try {
                            const q = (tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}).query || "";
                            const key = String(q).trim().toLowerCase();
                            if (key) {
                                if (searchQueryHistory.includes(key)) degenerateLoop = true;
                                else searchQueryHistory.push(key);
                            }
                        } catch {
                            /* 参数解析失败忽略 */
                        }
                        if (webSearchCap > 0 && webSearchCount >= webSearchCap) {
                            console.log(`[aiReply] web_search 已达上限(${webSearchCap})，强制纯文本收尾`);
                            degenerateLoop = true;
                        }
                    }
                    // 阶段 D：统一 dispatch 流水线——按 scope 选执行器（内置/全局/本 scope 前端）
                    // + 统一超时 + 统一截断。前端执行器由调用方按 scope 注册进注册表，
                    // 不再用全局 getFrontendToolNames 判断归属（那正是串线根因）。
                    const dispatched = await capabilities.dispatch(capScope, toolName, args, {
                        searchKey: aiContext.searchKey,
                        searchEndpoint: aiContext.searchEndpoint,
                        searchProvider: aiContext.searchProvider,
                        openai: aiContext.openai,
                        // 阶段 E：子 agent 要用同一套模型与同一 scope 的工具集。
                        model: aiContext.model,
                        capScope,
                        sessionId,
                        turnId,
                        uid: aiContext.userid,
                        origin: "desktop",
                        // 记忆/自我运维要判断「是不是主人在说话」「这是不是群聊」——
                        // 从本轮 scene 透传，避免工具里再猜一遍。
                        isOwner: typeof scene?.isOwner === "boolean" ? scene!.isOwner : null,
                        isGroup: String(scene?.chatType || "") === "group",
                        counterpartId: scene?.senderId ? String(scene.senderId) : undefined,
                        // 管理权限角色（owner/admin/user）；self_* 工具按它判可读/可写范围
                        role: scene?.role ? String(scene.role) : null,
                        // 前端执行器兜底（兼容尚未按新接口注册的调用方），形态 (name, args)。
                        invokeFrontendTool: aiContext.invokeFrontendTool,
                    });
                    result = dispatched.content;
                } catch (e) {
                    result = `error: ${e instanceof Error ? e.message : String(e)}`;
                }
                messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
                // 阶段 D：截断已在 capabilities.dispatch 流水线里统一执行。
                recorder.enqueue({
                    origin: "desktop",
                    sessionId,
                    turnId,
                    type: "tool_result",
                    payload: {
                        round,
                        tool_call_id: tc.id,
                        name: tc.function?.name,
                        content: String(result),
                        isError: typeof result === "string" && result.startsWith("error:"),
                    },
                });
                r.settle(tc.id); // 该工具结果已回灌，清偿欠账
                // 阶段 C：工具成功后推进 active task 的对应 tool 步骤。
                const isErr = typeof result === "string" && result.startsWith("error:");
                if (!isErr && !taskRuntime.isTaskTool(tc.function?.name)) {
                    taskRuntime.advancePendingStep(sessionId, "tool", tc.function?.name ?? null, String(result).slice(0, 300));
                }
            }
            // 本轮工具全部回灌、账本清空 → 请求 runner 进入下一轮。
            return { kind: "tools" as const, toolCallIds };
        });

        // runner 在「无工具欠账」时才返回；跑满熔断上限抛与原实现逐字一致的错误。
        return finalReply;
    } finally {
        clearTimeout(timeoutId);
        aiContext.activeRequests.delete(controller);
        if (signal) signal.removeEventListener("abort", onAbort);
        // 每轮强制 flush：回复返回前把本轮 request / tool_* 全部落库，
        // 「杀进程重启后逐字重建」才成立。失败只警告，绝不影响回复。
        try { await recorder.flush(); } catch (e) { console.warn("[events] 本轮事件落库失败（已忽略）:", (e as Error)?.message || e); }
        recorder.enqueue({
            origin: "desktop",
            sessionId,
            turnId,
            type: "turn_end",
            payload: { elapsedMs: Date.now() - _t0, model: aiContext.model },
        });
        try { await recorder.flush(); } catch (e) { console.warn("[events] 本轮事件落库失败（已忽略）:", (e as Error)?.message || e); }
        endTurn();
        console.log(`[getReply] 结束，耗时 ${Date.now() - _t0}ms`);
    }
}
