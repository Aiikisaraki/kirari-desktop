// electron/ai/knowledge/SourceRegistry.ts
// 知识源注册表：加载声明式清单（默认随包 + 用户覆盖），实例化已启用源，
// 提供跨源检索入口 retrieveAcrossSources。这是"可插拔数据源"的核心。
//
// 沿用「注册表 + dispatcher」范式：源以声明式清单描述，按 type 映射适配器类；
// 检索时并行跑所有可用源，合并/去重/截断为 top-k。
//
// 由 kirari-core/src/knowledge/SourceRegistry.js 迁入。
// 主要改动：默认清单从 json 文件读改为内联常量（避免打包后 __dirname 失效）。

import * as fs from "node:fs";
import * as path from "node:path";
import { SOURCE_TYPE } from "./types";
import type { KnowledgeSourceDef, RetrievedPassage, RetrieveOptions } from "./types";
import { DEFAULT_SOURCES } from "./defaultSources";
import { MediaWikiSource } from "./sources/MediaWikiSource";
import { LocalVectorSource } from "./sources/LocalVectorSource";
import { UserMarkdownSource } from "./sources/UserMarkdownSource";
import { DBKnowledgeSource } from "./sources/DBKnowledgeSource";
import { RestApiSource } from "./sources/RestApiSource";
import type { BaseSource } from "./BaseSource";

/** 源类型 → 适配器类 */
export const ADAPTERS: Record<string, new (def: KnowledgeSourceDef) => BaseSource> = {
    [SOURCE_TYPE.MEDIAWIKI_API]: MediaWikiSource,
    [SOURCE_TYPE.LOCAL_VECTOR_INDEX]: LocalVectorSource,
    [SOURCE_TYPE.USER_MARKDOWN]: UserMarkdownSource,
    [SOURCE_TYPE.USER_KNOWLEDGE_DB]: DBKnowledgeSource,
    [SOURCE_TYPE.REST_API]: RestApiSource,
};

export class SourceRegistry {
    defs: KnowledgeSourceDef[] = [];
    instances: BaseSource[] = [];
    private _loaded = false;

    /**
     * 加载默认清单 + 用户覆盖。
     * @param userOverrides 按 id 的补丁（可改 enabled/auth/endpoint 等）
     * @param userManifestPath 可选：用户清单文件路径（通常在 userData 下）。
     *                         读取失败不致命，退化为"仅默认清单"。
     */
    load(
        userOverrides: Record<string, Partial<KnowledgeSourceDef>> = {},
        userManifestPath?: string,
    ): this {
        let defs: KnowledgeSourceDef[] = [...DEFAULT_SOURCES];

        // 用户清单文件（可选扩展点）
        if (userManifestPath) {
            try {
                const raw = fs.readFileSync(userManifestPath, "utf8");
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed?.sources)) defs = defs.concat(parsed.sources);
            } catch {
                /* 用户清单不存在或损坏 → 忽略，用默认清单 */
            }
        }

        // 合并用户覆盖（按 id；覆盖可改 enabled/auth/endpoint 等）
        const byId = new Map<string, KnowledgeSourceDef>();
        for (const d of defs) byId.set(d.id, { ...d });
        for (const [id, patch] of Object.entries(userOverrides || {})) {
            byId.set(id, { ...(byId.get(id) || ({ id } as KnowledgeSourceDef)), ...patch } as KnowledgeSourceDef);
        }
        this.defs = [...byId.values()];

        // 实例化已启用且类型已知的源（实例化失败不致命，跳过）
        this.instances = this.defs
            .filter((d) => d.enabled !== false && ADAPTERS[String(d.type)])
            .map((d) => {
                try {
                    return new ADAPTERS[String(d.type)](d);
                } catch (e) {
                    console.warn(`[kb] 源 ${d.id} 实例化失败：`, (e as Error)?.message || e);
                    return null;
                }
            })
            .filter((x): x is BaseSource => Boolean(x));
        this._loaded = true;
        return this;
    }

    /** 懒加载单例帮助方法 */
    ensureLoaded(): this {
        if (!this._loaded) this.load();
        return this;
    }

    /** 列出全部声明的源（供设置页渲染/开关） */
    listSources(): {
        id: string;
        name: string;
        type: string;
        auth: string;
        enabled: boolean;
        tier: string;
        domains: string[];
    }[] {
        return this.defs.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            auth: d.auth || "none",
            enabled: d.enabled !== false,
            tier: d.tier || "A",
            domains: d.domains || [],
        }));
    }

    /**
     * 跨所有已启用源并行检索，合并 + 去重 + 截断，返回 top-k 片段。
     */
    async retrieveAcrossSources(
        query: string,
        opts: RetrieveOptions & { topK?: number; maxChars?: number } = {},
    ): Promise<RetrievedPassage[]> {
        this.ensureLoaded();
        const topK = opts.topK || 5;
        const maxChars = opts.maxChars || 1200;
        const domainFilter =
            Array.isArray(opts.domains) && opts.domains.length ? opts.domains : null;

        const candidates = this.instances.filter(
            (s) =>
                s.isAvailable() &&
                (!domainFilter ||
                    s.domains.length === 0 ||
                    s.domains.some((d) => domainFilter.includes(d))),
        );
        if (!candidates.length) return [];

        const results = await Promise.all(
            candidates.map((s) => s.retrieve(query, opts).catch(() => [])),
        );
        let flat = results.flat();

        // 去重（按文本前缀近似；当前用精确去重，后续可升级语义去重）
        const seen = new Set<string>();
        flat = flat.filter((p) => {
            const key = (p.text || "").slice(0, 80);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // 排序：分数降序，其次源优先级升序
        flat.sort(
            (a, b) => (b.score || 0) - (a.score || 0) || (a.priority || 100) - (b.priority || 100),
        );

        // 截断到 maxChars（保证注入不撑爆上下文）
        const out: RetrievedPassage[] = [];
        let used = 0;
        for (const p of flat) {
            if (out.length >= topK) break;
            const len = (p.text || "").length;
            if (used + len > maxChars && out.length > 0) break;
            out.push(p);
            used += len;
        }
        return out;
    }
}

// 单例（进程内共享，避免重复实例化/重复读清单）
let _singleton: SourceRegistry | null = null;

export function getRegistry(): SourceRegistry {
    if (!_singleton) _singleton = new SourceRegistry().load();
    return _singleton;
}

/** 重建单例（用户改了知识源配置后调用） */
export function resetRegistry(userOverrides?: Record<string, Partial<KnowledgeSourceDef>>, manifestPath?: string): SourceRegistry {
    _singleton = new SourceRegistry().load(userOverrides, manifestPath);
    return _singleton;
}

/** 用户清单默认路径（由主进程传入 userData 目录） */
export function defaultUserManifestPath(userDataDir: string): string {
    return path.join(userDataDir, "kb-sources.json");
}
