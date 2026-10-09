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
import { preflightTools, buildTools, detectCorrectionIntent } from "../reply/intent";
import { streamChatCompletion, polishToolResult } from "../reply/streaming";
import * as dailyBriefing from "./dailyBriefingService";
import * as knowledgeRetrieval from "../knowledge/retrievalService";
import { runTool, getFrontendToolNames } from "../tools";
import { getRecentMessages } from "../db/storage";
import type { AiContext } from "../aiContext";
import type { RetrievedPassage } from "../knowledge/types";

/** 工具循环最多轮数（也用于超时预算计算） */
const MAX_ROUNDS = 5;

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
    /** 外部取消（用户点了停止生成） */
    signal?: AbortSignal;
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
async function salvageAsText(aiContext: AiContext, messages: unknown[]): Promise<string> {
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
        const completion = await streamChatCompletion(
            aiContext.openai,
            { model: aiContext.model, messages: patched, max_tokens: 1500 },
            { signal: ctrl.signal },
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
        signal,
    } = options;

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

    const controller = new AbortController();
    // 外部取消信号透传：用户点停止生成时立刻中断
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }

    // 超时随"可能触发的工具轮次"放大：基线至少 60s，再为每轮工具预留 15s，封顶 120s。
    const baseTimeout = getRequestTimeout(text || "[用户发送了图片]");
    const timeout = Math.min(120000, Math.max(baseTimeout, 60000) + MAX_ROUNDS * 15000);
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    aiContext.activeRequests.add(controller);
    const _t0 = Date.now();

    try {
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
                const c = await polishToolResult(raw, aiContext, sessionId, text, controller, sys.locationSet);
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

        const systemPrompt = preflight.injected
            ? sys.withTools.replace("{{TOOL_RESULTS}}", preflight.injected.join("\n"))
            : sys.normal;

        // 注入前端托管的 skill 行为模板
        const skillBlock =
            Array.isArray(skillPrompts) && skillPrompts.length
                ? "\n\n# 已启用的技能（请遵循以下设定）\n" + skillPrompts.join("\n\n")
                : "";

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

        const messages: unknown[] = [
            { role: "system", content: systemPrompt + dailyBlock + kbBlock + skillBlock },
            ...normalizedRecent,
            { role: "user", content: userContent },
        ];

        const correctionMode = detectCorrectionIntent(text);
        const allTools = buildTools();
        const toolChoice = allTools.length ? "auto" : undefined;
        // 纠正模式限 2 次、普通模式限 4 次：达到上限即强制后续轮次纯文本收尾，
        // 避免模型反复搜索（自证式空转）把请求拖到超时。
        const webSearchCap = correctionMode ? 2 : 4;
        if (correctionMode) console.log(`[aiReply] 纠正意图命中，允许有限搜索（上限 ${webSearchCap} 次）`);

        let toolsDisabled = false; // 部分端点不支持 function calling，请求带 tools 会 400，此时降级重试
        let degenerateLoop = false; // 模型反复用近重复 query 调 web_search → 强制不再带工具
        const searchQueryHistory: string[] = [];
        let webSearchCount = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            let completion;
            try {
                const useTools = allTools.length && !toolsDisabled && !degenerateLoop;
                completion = await streamChatCompletion(
                    aiContext.openai,
                    {
                        model: aiContext.model,
                        messages,
                        tools: useTools ? allTools : undefined,
                        tool_choice: useTools ? toolChoice : undefined,
                        max_tokens: 1500,
                    },
                    { signal: controller.signal },
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
                        { model: aiContext.model, messages, max_tokens: 1500 },
                        { signal: controller.signal },
                    );
                } else if (aborted) {
                    // 主请求超时/中断：用 salvageAsText（独立 60s 控制器）强制纯文本收尾，
                    // 实在救不回才冒泡到外层兜底，避免直接崩成"还在学习中"。
                    console.warn(`[aiReply] 主请求超时/中断（${errMsg}），尝试纯文本收尾`);
                    try {
                        const salvaged = await salvageAsText(aiContext, messages);
                        if (salvaged && salvaged.trim()) {
                            const { speech, emotion } = parseModelReply(salvaged.trim());
                            if (speech) {
                                return {
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

            // 无工具调用 → 最终回复
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                const rawContent = msg.content?.trim();
                if (!rawContent) {
                    // 流被截断（超时 abort / reasoning 吃满 max_tokens）导致 content 为空：
                    // 先强制一次"纯文本收尾"救回答案，不再硬抛。
                    console.error(
                        `[aiReply] round=${round} 内容为空，尝试强制纯文本收尾 model=${aiContext.model}`,
                    );
                    try {
                        const salvaged = await salvageAsText(aiContext, messages);
                        if (salvaged && salvaged.trim()) {
                            const { speech, emotion, images: parsedImages } = parseModelReply(salvaged.trim());
                            if (speech) {
                                return {
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
                };
            }

            // 有工具调用 → 执行并回灌
            for (const tc of msg.tool_calls) {
                let result: unknown;
                try {
                    const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                    const toolName = tc.function?.name;
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
                    // 前端托管工具（MCP/skill 提供，以 frontend__ 前缀标识）：由主进程注入的执行器执行
                    const frontendToolNames = aiContext.invokeFrontendTool ? getFrontendToolNames() : null;
                    if (frontendToolNames && frontendToolNames.has(toolName) && aiContext.invokeFrontendTool) {
                        result = await aiContext.invokeFrontendTool(toolName, args);
                    } else {
                        result = await runTool(toolName, args, {
                            searchKey: aiContext.searchKey,
                            searchEndpoint: aiContext.searchEndpoint,
                            searchProvider: aiContext.searchProvider,
                            openai: aiContext.openai,
                        });
                    }
                } catch (e) {
                    result = `error: ${e instanceof Error ? e.message : String(e)}`;
                }
                messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });
            }
        }

        throw new Error("工具调用轮次过多，未能生成最终回复");
    } finally {
        clearTimeout(timeoutId);
        aiContext.activeRequests.delete(controller);
        if (signal) signal.removeEventListener("abort", onAbort);
        console.log(`[getReply] 结束，耗时 ${Date.now() - _t0}ms`);
    }
}
