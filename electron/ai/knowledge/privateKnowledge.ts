// electron/ai/knowledge/privateKnowledge.ts
// 私有知识库（Layer 1）的取数通道。
//
// 原实现（kirari-core）：后端通过 WebSocket 向前端发 kb_request，前端本地检索后回 kb_response，
// 后端 3 秒超时。这条路在"AI 内核跑进主进程"后不成立——前端就在同一个进程里，
// 再绕一圈网络纯属自找麻烦。
//
// 现实现：主进程启动时注入一个取数函数，私有知识库源直接 await 它。
//   - 省掉序列化 / call_id 配对表 / 3 秒挂起的超时风险
//   - 未注入时静默返回空，不阻塞推理

import type { RetrievedPassage } from "./types";

/** 私有知识库取数函数签名 */
export type PrivateKnowledgeProvider = (
    query: string,
    opts?: { topK?: number; timeoutMs?: number; userid?: string },
) => Promise<RetrievedPassage[]>;

let provider: PrivateKnowledgeProvider | null = null;

/**
 * 注入私有知识库取数实现。由主进程在初始化 AI 引擎时调用。
 * 传 null 可解除注入（例如用户清空了知识库）。
 */
export function setPrivateKnowledgeProvider(fn: PrivateKnowledgeProvider | null): void {
    provider = fn;
}

/** 当前是否已有可用的私有知识库取数实现。 */
export function hasPrivateKnowledgeProvider(): boolean {
    return typeof provider === "function";
}

/**
 * 向私有知识库取数。任何异常都降级为空数组，绝不向上抛。
 */
export async function requestPrivateKnowledge(
    query: string,
    opts: { topK?: number; timeoutMs?: number; userid?: string } = {},
): Promise<RetrievedPassage[]> {
    if (!provider || !query || !query.trim()) return [];
    try {
        const out = await provider(query, opts);
        return Array.isArray(out) ? out : [];
    } catch (e) {
        console.warn("[kb] 私有知识库取数失败：", (e as Error)?.message || e);
        return [];
    }
}
