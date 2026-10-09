// electron/ai/knowledge/sources/DBKnowledgeSource.ts
// 用户私人知识库（Layer 1，最高优先级）。
//
// 检索策略 v3（进程内）：
//  1. 主动携带：调用方在 opts.kbContext 里直接带上已检索好的片段（最省事，零往返）。
//  2. 反向拉取：未携带时，通过主进程注入的取数函数直接 await（原实现走 WebSocket，已去掉）。
//
// 数据主权完全在用户本机：内核对私人知识库零存储、零状态。
//
// 由 kirari-core/src/knowledge/sources/DBKnowledgeSource.js 迁入。

import { BaseSource } from "../BaseSource";
import { requestPrivateKnowledge } from "../privateKnowledge";
import type { RetrievedPassage, RetrieveOptions } from "../types";

export class DBKnowledgeSource extends BaseSource {
    async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedPassage[]> {
        // 1. 优先用调用方携带的结果
        if (Array.isArray(opts.kbContext) && opts.kbContext.length > 0) {
            return opts.kbContext.map((p) => ({
                text: p.text || "",
                source: this.name,
                score: typeof p.score === "number" ? p.score : 1,
                tier: this.tier,
                priority: this.priority,
            }));
        }

        // 2. 未携带 → 走主进程注入的取数函数（进程内直调，无网络往返）
        try {
            const results = await requestPrivateKnowledge(query, {
                topK: opts.limit,
                userid: opts.userid,
            });
            return results.map((r, i) => ({
                text: r.text || "",
                source: this.name,
                score: typeof r.score === "number" ? r.score : 1 / (i + 1),
                tier: this.tier,
                priority: this.priority,
            }));
        } catch {
            return [];
        }
    }
}

export default DBKnowledgeSource;
