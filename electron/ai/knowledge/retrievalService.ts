// electron/ai/knowledge/retrievalService.ts
// 知识检索编排：把"跨源检索结果"格式化为可注入 system prompt 的参考块。
// 被会话服务在构建消息前调用。
//
// 优先级遵循整体架构：
//   Layer 1 私有知识库（用户主权）> Layer 2 推荐源（离线植入 > 免注册实时）> Layer 3 联网搜索兜底
// 本服务只负责 Layer 2 的"推荐源"检索与格式化；Layer 1（DBKnowledgeSource）启用后自然排在最高。
//
// 由 kirari-core/src/knowledge/retrievalService.js 迁入。
// 主要改动：去掉 opts.ws（进程内直调，不再需要 WebSocket 通道）。

import { getRegistry } from "./SourceRegistry";
import type { RetrievedPassage } from "./types";

export type RetrieveForPromptOptions = {
    topK?: number;
    maxChars?: number;
    domains?: string[];
    /** 前端主动携带的私有知识库结果透传 */
    kbContext?: RetrievedPassage[];
    signal?: AbortSignal;
};

/**
 * 检索并格式化为提示词片段。失败/无结果返回空串，绝不阻塞主对话。
 * @param aiContext 含 userid（用于 Layer1 私有知识隔离）
 * @param query 检索词
 */
export async function retrieveForPrompt(
    aiContext: { userid?: string } | undefined,
    query: string,
    opts: RetrieveForPromptOptions = {},
): Promise<string> {
    if (!query || !query.trim()) return "";
    try {
        const registry = getRegistry();
        const passages = await registry.retrieveAcrossSources(query, {
            topK: opts.topK || 5,
            maxChars: opts.maxChars || 1200,
            domains: opts.domains,
            // 透传 userid：私有知识库据此按用户隔离检索
            userid: aiContext?.userid,
            // 透传前端主动携带的私有知识库结果
            kbContext: opts.kbContext,
            signal: opts.signal,
        });
        if (!passages.length) return "";

        const lines = passages.map(
            (p) => `- （来源：${p.source || "知识库"}${p.url ? ` ${p.url}` : ""}）${p.text}`,
        );
        return (
            "\n\n【知识库 · 检索到的参考信息】\n" +
            "（仅供作答参考，以你自身知识为准；若与你的知识冲突，或你不确定具体事实，可用工具核实）\n" +
            lines.join("\n")
        );
    } catch (e) {
        console.warn("[kb] 检索失败：", (e as Error)?.message || e);
        return "";
    }
}
