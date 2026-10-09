// electron/ai/aiContext.ts
// 一次连接（或一个会话周期）持有的 AI 上下文：模型客户端 + 搜索配置 + 取消控制。
//
// 由 kirari-core/src/ai/connectionAiContext.js 迁入。
//
// 关键改动：
//  1. 配置来源从 apiTokenManager（后端数据库）改为**调用方传入**。
//     桌宠端读 userData/config.json，核心版读 .env —— 内核不关心配置从哪来。
//  2. 「网络意义上的连接」在进程内不存在，这里只是「一组可复用的请求凭据」。
//     命名也从 connectionAiContext 简化为 AiContext。
//  3. 新增 invokeFrontendTool：前端托管工具（MCP / skill）由主进程直接提供实现，
//     不再经 WebSocket 回调。

import OpenAI from "openai";

/** 内核运行所需的模型与搜索配置。凭证由用户自持，内核不做任何持久化。 */
export type AiModelSettings = {
    /** 模型名称，如 gpt-5.4-mini */
    model: string;
    /** 接口根地址，如 https://xxx/v1 */
    endpoint: string;
    /** 模型密钥 */
    key: string;
    /** 搜索服务提供方（默认 uapis） */
    searchProvider?: string;
    /** 搜索密钥（按次计费，可为空） */
    searchKey?: string;
    /** 自建搜索服务地址（如 SearXNG） */
    searchEndpoint?: string;
    /** 使用者标识：桌宠为本地固定 uid，机器人为群号/QQ号映射出的标识 */
    userid?: number;
    /**
     * 前端托管工具的执行器（MCP / skill 提供的工具）。
     * 由主进程注入；未提供时模型侧不会暴露这些工具。
     */
    invokeFrontendTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

export type AiContext = {
    userid: number;
    model: string;
    searchProvider: string;
    searchKey: string;
    searchEndpoint: string;
    openai: OpenAI;
    /** 进行中的请求控制器，用于统一取消（如用户停止生成 / 应用退出） */
    activeRequests: Set<AbortController>;
    closed: boolean;
    invokeFrontendTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

export const DEFAULT_ENDPOINT = "https://api.chatanywhere.tech/v1";
export const DEFAULT_MODEL = "gpt-5.4-mini";

/**
 * 创建 AI 上下文。
 * @throws 配置缺失（未填密钥 / 未选模型 / 未填接口地址）时抛出可展示给用户的错误
 */
export function createAiContext(settings: AiModelSettings): AiContext {
    const model = String(settings.model || "").trim();
    const key = String(settings.key || "").trim();
    let endpoint = String(settings.endpoint || "").trim();

    if (!key) throw new Error("小灵的大脑还没连接上，去设置里填上钥匙就能聊天啦");
    if (!model) throw new Error("还没选择小灵要用的大脑");
    if (!endpoint) throw new Error("还没填写大脑的连接地址");

    // 兼容用户把完整 /chat/completions 地址粘进「接口地址」字段的情况：
    // OpenAI SDK 会在 baseURL 之后自动追加 /chat/completions，若已包含会出现
    // .../chat/completions/chat/completions 的重复路径，导致 404 或空响应。
    if (endpoint.endsWith("/chat/completions")) {
        endpoint = endpoint.slice(0, -"/chat/completions".length);
        console.warn("[aiContext] 接口地址以 /chat/completions 结尾，已自动裁掉（SDK 会自动补回）");
    }

    let host = endpoint;
    try {
        host = new URL(endpoint).host;
    } catch {
        /* 非合法 URL 时保留原值，交给后续请求报错 */
    }
    // 密钥指纹：仅取前 4 + 后 4，便于核对「设置里填的」与「实际生效的」是否一致
    console.log(`[aiContext] 已连接大脑 model=${model} host=${host} key=${key.slice(0, 4)}***${key.slice(-4)}`);

    return {
        userid: settings.userid ?? 1,
        model,
        searchProvider: settings.searchProvider || "uapis",
        searchKey: settings.searchKey || "",
        searchEndpoint: settings.searchEndpoint || "",
        openai: new OpenAI({
            apiKey: key,
            baseURL: endpoint,
            timeout: 60000,
            maxRetries: 0,
        }),
        activeRequests: new Set<AbortController>(),
        closed: false,
        invokeFrontendTool: settings.invokeFrontendTool,
    };
}

/** 释放上下文：取消所有在途请求并标记关闭。幂等。 */
export function cleanupAiContext(context: AiContext | null | undefined): void {
    if (!context || context.closed) return;
    context.closed = true;
    for (const controller of context.activeRequests) {
        try {
            controller.abort();
        } catch {
            /* 已结束的请求忽略 */
        }
    }
    context.activeRequests.clear();
}
