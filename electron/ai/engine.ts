// electron/ai/engine.ts
// 进程内 AI 引擎的门面（facade）：对外只暴露「初始化 / 换配置 / 发一句话」三个动作，
// 内部串起数据库、模型上下文、前端托管工具、私有知识库、对话历史。
//
// 对应原后端的 aiReplyService（门面）+ conversationService（编排）两层：
// 桌宠不需要再区分这两层，合并为一个入口，调用方（ChatSessionService /
// 机器人适配器）不必关心内核细节。
//
// 关键设计：AiContext 按配置指纹缓存。
//   配置没变 → 复用同一个 OpenAI 客户端，避免每句话都新建；
//   配置变了 → 自动重建（用户在设置页改了大脑，下一句立即生效，不用重启）。

import * as db from "./db/storage";
import { createAiContext, cleanupAiContext } from "./aiContext";
import type { AiContext, AiModelSettings } from "./aiContext";
import { getReply } from "./services/conversationService";
import type { ReplyResult } from "./services/conversationService";
import { getReply as getFallbackReply } from "./services/fallbackService";
import { setFrontendTools } from "./tools";
import { setPrivateKnowledgeProvider } from "./knowledge/privateKnowledge";
import type { RetrievedPassage } from "./knowledge/types";
import type { ToolSpec } from "./types";

let initialized = false;

/** 当前模型配置指纹 → 上下文。指纹变化即重建。 */
let cachedContext: AiContext | null = null;
let cachedFingerprint = "";

/** 前端托管工具（MCP / skill）的执行器 */
let frontendExecutor: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

export type EngineInitOptions = {
    /** 数据库文件路径。通常由主进程传 app.getPath('userData') 下的路径 */
    dbPath: string;
};

/** 初始化引擎：建库、建表。幂等。 */
export function initEngine(options: EngineInitOptions): void {
    if (initialized) return;
    db.initDatabase(options.dbPath);
    initialized = true;
    console.log(`[engine] 已启动，数据文件：${db.getDbPath()}`);
}

/** 关闭引擎（应用退出前）。 */
export function shutdownEngine(): void {
    cleanupAiContext(cachedContext);
    cachedContext = null;
    cachedFingerprint = "";
    db.closeDatabase();
    initialized = false;
}

/**
 * 注入前端托管工具：schema 交给模型（function-calling 可见），
 * 执行器在本进程内直接跑——不再有「后端回调解前端」的 WebSocket 往返。
 */
export function registerFrontendTools(
    schemas: unknown,
    executor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): number {
    const normalized = setFrontendTools(schemas as ToolSpec[]);
    frontendExecutor = executor;
    return normalized.length;
}

/** 注入私有知识库检索实现（本地库由主进程持有）。 */
export function registerPrivateKnowledge(
    search: (query: string, opts?: { topK?: number }) => Promise<RetrievedPassage[]>,
): void {
    setPrivateKnowledgeProvider(search);
}

function fingerprint(settings: AiModelSettings): string {
    return [
        settings.model || "",
        settings.endpoint || "",
        settings.key || "",
        settings.searchProvider || "",
        settings.searchKey || "",
        settings.searchEndpoint || "",
        settings.userid ?? 1,
    ].join("|");
}

/**
 * 取得（或按需重建）AI 上下文。
 * @throws 配置缺失时抛出可直接展示给用户的错误（文案已是大白话）
 */
export function ensureContext(settings: AiModelSettings): AiContext {
    const fp = fingerprint(settings);
    if (cachedContext && !cachedContext.closed && cachedFingerprint === fp) {
        return cachedContext;
    }
    // 旧上下文存在但配置已变：先取消在途请求再丢弃
    cleanupAiContext(cachedContext);
    cachedContext = createAiContext({
        ...settings,
        invokeFrontendTool: frontendExecutor
            ? (name, args) => frontendExecutor!(name, args)
            : undefined,
    });
    cachedFingerprint = fp;
    return cachedContext;
}

/** 配置是否已齐全（用于设置页提示，不抛错）。 */
export function isConfigured(settings: AiModelSettings | null | undefined): boolean {
    return !!(settings && settings.key && settings.model && settings.endpoint);
}

/** 前端托管工具执行器是否可用（决定模型侧是否暴露这些工具）。 */
export function hasFrontendExecutor(): boolean {
    return typeof frontendExecutor === "function";
}

export type ChatOptions = {
    /** 模型与搜索配置。通常由主进程读 config.json 得到 */
    settings: AiModelSettings;
    sessionId: string;
    text: string;
    images?: string[];
    /** 人格（自定义或预设），来自设置页 */
    persona?: string | null;
    /** 前端 skill 的行为模板 */
    skillPrompts?: string[];
    /** 机器人场景：按群号/QQ号隔离位置记忆 */
    locationScope?: string | null;
    /**
     * 调用方自带的私人知识库检索结果（可选）。
     * 叶子上行到主机时，主机必须带上它 —— 片段存在叶子本地，主机拿不到别的副本。
     * 桌面端本地回答时带上可跳过重复检索。
     *
     * 刻意用宽松形状而不是 ai/knowledge/types 的 RetrievedPassage：
     * 调用方可能拿的是 src/knowledge/localKnowledge 的同名类型（tier: string），
     * 也可能是 kirari-net 的 KbPassage（没有 tier）——收宽形状在入口归一化。
     */
    kbContext?:
        | ReadonlyArray<{
              text: string;
              source?: string;
              url?: string;
              score?: number;
              tier?: string;
              priority?: number;
          }>
        | null;
    /**
     * 正文逐字回调（上层做流式展示）。约定：
     *   onDelta(text)  —— 追加一段正文增量（模型原始输出，可能带情绪标签碎片）
     *   onDelta(null)  —— 之前流出的内容作废（工具轮碎片/换收尾路径），调用方应清空
     * 回调抛出的异常一律在内核里吞掉，不会影响生成；最终仍以 chat() 返回的
     * result.speech（解析后的权威正文）为准。
     */
    onDelta?: ((text: string | null) => void) | null;
    /** 外部取消（用户点停止生成） */
    signal?: AbortSignal;
    /** 失败时是否回退到预设兜底语。桌宠默认 true，保证永远有反应 */
    allowFallback?: boolean;
};

/**
 * 发一句话并拿到回复。
 *
 * 与旧实现的差别：历史由本地库承载（内核自己读最近消息构造上下文），
 * 不再经后端 sessionManager；失败时回退到预设兜底语，绝不把异常抛给 UI。
 */
export async function chat(options: ChatOptions): Promise<ReplyResult> {
    const {
        settings,
        sessionId,
        text,
        images = [],
        persona = null,
        skillPrompts = [],
        locationScope = null,
        kbContext = null,
        onDelta = null,
        signal,
        allowFallback = true,
    } = options;

    const context = ensureContext(settings);

    // 用户消息入库（内核构造上下文时读取）。images 一并落库 ——
    // 这张表现在同时是桌宠聊天界面的记录真源，只存文字会让历史里的图片全丢。
    await db.saveMessage(sessionId, "user", text, { images: images.length ? images : undefined });

    try {
        // 归一化：tier 只接受白名单值（A/B/C），其余剥掉，别让脏数据进内核
        const kbNormalized: RetrievedPassage[] | null = kbContext
            ? kbContext.map((p) => ({
                  text: p.text,
                  source: p.source,
                  url: p.url,
                  score: p.score,
                  tier: p.tier === "A" || p.tier === "B" || p.tier === "C" ? p.tier : undefined,
                  priority: p.priority,
              }))
            : null;
        const result = await getReply({
            aiContext: context,
            content: text,
            images,
            sessionId,
            locationScope,
            kbContext: kbNormalized,
            onDelta,
            skillPrompts,
            persona,
            signal,
        });
        // 助手回复入库，保证下一轮上下文连贯。emotion 一并落库 ——
        // 界面重放历史时要按当时的情绪播动画，见 ChatSessionService.loadFromDb。
        await db.saveMessage(sessionId, "assistant", result.speech, {
            emotion: (result.emotion as string | undefined) ?? null,
            images: Array.isArray(result.images) && result.images.length ? result.images : undefined,
        });
        return result;
    } catch (e) {
        const err = e as Error & { name?: string };
        // 用户主动取消：不写回复、不兜底，直接向上抛（UI 需要知道是被取消的）
        if (err?.name === "AbortError" || /abort/i.test(err?.message || "")) {
            throw err;
        }
        if (!allowFallback) throw err;

        console.warn("[engine] 调用大脑失败，回退到预设回复：", err?.message || err);
        const fallback = getFallbackReply({ content: text, persona });
        return {
            speech: fallback.speech,
            emotion: (fallback.emotion as ReplyResult["emotion"]) ?? null,
            images: [],
            action: fallback.action || "idle",
            mood: fallback.mood || "curious",
            source: "fallback",
            model: settings.model || "",
            usage: null,
            sessionId,
            userid: settings.userid ?? 1,
        };
    }
}

/** 清空某个会话的历史（UI 的"清空聊天记录"）。 */
export async function clearHistory(sessionId: string): Promise<void> {
    await db.clearSession(sessionId);
}

/** 列出所有会话（供后续多会话切换）。 */
export async function listSessions(): Promise<string[]> {
    return db.listSessions();
}
