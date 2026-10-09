// electron/ai/knowledge/BaseSource.ts
// 知识源抽象基类。所有具体源（MediaWiki、离线向量库、用户私有库…）继承此类，
// 实现 retrieve(query, opts) 返回 RetrievedPassage[]。
//
// 设计约定：
//  - 单个源的 retrieve 必须"容错"——任何网络/解析异常都应返回 [] 而非抛出，
//    上层（SourceRegistry.retrieveAcrossSources）已做兜底，但源自身也宜自愈。
//  - 检索不应有副作用，纯查询。
//
// 由 kirari-core/src/knowledge/BaseSource.js 迁入。

import type { KnowledgeSourceDef, RetrievedPassage, RetrieveOptions } from "./types";

export abstract class BaseSource {
    readonly def: KnowledgeSourceDef;
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly auth: string;
    readonly enabled: boolean;
    readonly priority: number;
    readonly tier: string;
    readonly domains: string[];
    readonly options: Record<string, unknown>;

    constructor(def: KnowledgeSourceDef) {
        if (!def || !def.id) throw new Error("知识源定义缺少 id");
        this.def = def;
        this.id = def.id;
        this.name = def.name || def.id;
        this.type = def.type;
        this.auth = def.auth || "none";
        this.enabled = def.enabled !== false;
        this.priority = typeof def.priority === "number" ? def.priority : 100;
        this.tier = def.tier || "A";
        this.domains = Array.isArray(def.domains) ? def.domains : [];
        this.options = def.options || {};
    }

    /** 源是否可用（registry 在检索前据此过滤） */
    isAvailable(): boolean {
        return this.enabled;
    }

    /** 检索相关片段。子类必须实现。 */
    abstract retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedPassage[]>;
}
