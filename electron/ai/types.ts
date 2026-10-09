// electron/ai/types.ts
// 内核公共类型定义（对话、工具、知识库、模型配置）。
//
// 说明：本目录是从 kirari-core 迁入的进程内 AI 内核。原为 CommonJS，改写为 TypeScript 后
// 主进程直接 import，不再经过 WebSocket / HTTP，桌宠因此可以脱离后端独立工作。

// ── 情绪标签 ────────────────────────────────────────────────────────────────
// 需与前端 AvatarState 的情绪白名单保持一致：基础态 idle / blink / sleepy / speak 不在内。
// 新增动画状态时同步扩展这里。
export type PetEmotion =
    | "happy"
    | "wave"
    | "bow"
    | "excited"
    | "nod"
    | "sad"
    | "shake"
    | "shy"
    | "stretch"
    | "surprised"
    | "thinking";

export const EMOTION_VALUES: readonly PetEmotion[] = [
    "happy",
    "wave",
    "bow",
    "excited",
    "nod",
    "sad",
    "shake",
    "shy",
    "stretch",
    "surprised",
    "thinking",
] as const;

export const EMOTION_WHITELIST: ReadonlySet<string> = new Set<string>(EMOTION_VALUES);

// ── 模型回复 ────────────────────────────────────────────────────────────────

/** 解析后的模型回复（已提取图片、校验情绪白名单）。 */
export type ParsedReply = {
    speech: string;
    emotion: PetEmotion | null;
    images: string[];
};

/** 多模态内容片段：与 OpenAI Chat Completions 的 content 数组同形。 */
export type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 送进模型的单条消息。content 为纯文本或多模态数组。 */
export type ChatMessage = {
    role: MessageRole;
    content: string | ContentPart[];
};

/** 记忆/历史里存的一条消息（不含工具调用细节）。 */
export type StoredMessage = {
    role: MessageRole;
    content: string | ContentPart[];
};

// ── 工具 ────────────────────────────────────────────────────────────────────

/** OpenAI function-calling 的工具声明。 */
export type ToolSpec = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
};

/**
 * 工具执行结果回传通道。
 *
 * 原实现在 tools/bridge.js 中通过 ws.send() 把前端托管工具的结果送回内核；
 * 迁入进程内后不再有 WebSocket，改由主进程直接注入实现（见 frontend-tools.ts）。
 */
export type ToolResultSink = (toolCallId: string, result: unknown) => void;

/** 一次工具调用的执行上下文。 */
export type ToolInvocationContext = {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    sessionId: string;
};

// ── 知识库 ──────────────────────────────────────────────────────────────────

/** 检索到的一条知识条目。 */
export type KnowledgeChunk = {
    id?: string;
    source: string;
    title?: string;
    text: string;
    score?: number;
    url?: string;
};

/** 知识来源的检索请求。 */
export type RetrievalQuery = {
    query: string;
    limit?: number;
    /** 限定来源 id，为空则查全部已启用来源。 */
    sourceIds?: string[];
};

// ── 模型配置 ────────────────────────────────────────────────────────────────

/**
 * 内核所需的模型配置。
 *
 * 凭证由用户自持：桌宠端从 config.json（userData）读取，不经后端分配。
 */
export type AiModelConfig = {
    endpoint?: string;
    model?: string;
    key?: string;
    /** 推理接口（如 ModelScope）需要额外标识。 */
    reasoning?: boolean;
};

// ── 流式 ────────────────────────────────────────────────────────────────────

/** 流式生成过程中的回调。 */
export type StreamHandlers = {
    /** 增量文本分片。 */
    onDelta?: (chunk: string) => void;
    /** 生成结束，携带完整结果。 */
    onDone?: (reply: ParsedReply) => void;
    /** 出错。 */
    onError?: (error: Error) => void;
    /** 外部取消（用户停止生成）。 */
    signal?: AbortSignal;
};
