// electron/ai/knowledge/sources/LocalVectorSource.ts
// 离线植入源（Tier B）：维护者预构建的向量索引随包分发，是所有用户"一致体验"的核心。
//
// 检索 = 本地 embedding(query) → 向量库相似检索 top-k → 返回片段。
// embedding 模型（BGE-M3 / Qwen3-Embedding，MIT/Apache）与索引文件作为发布资产
// 随包分发（或首次按需下载），全程不联网、无注册。
//
// ⚠️ 当前为占位实现：未携带索引与模型权重，retrieve 返回空，不影响主流程。
//    后续落地时在此接入 FAISS / Chroma / SQLite 向量扩展。
//
// 由 kirari-core/src/knowledge/sources/LocalVectorSource.js 迁入。

import { BaseSource } from "../BaseSource";
import type { RetrievedPassage, RetrieveOptions } from "../types";

export class LocalVectorSource extends BaseSource {
    async retrieve(_query: string, _opts: RetrieveOptions = {}): Promise<RetrievedPassage[]> {
        // TODO(impl): 加载 this.def.path 指向的本地向量索引，用本地 embedding 模型对 query 编码，
        //   做相似检索返回 top-k 段落。索引与模型权重由维护者预构建、随发布包分发。
        //   当前未携带索引文件 → 返回空（安全降级）。
        return [];
    }
}

export default LocalVectorSource;
