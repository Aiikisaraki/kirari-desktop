// electron/ai/knowledge/sources/RestApiSource.ts
// 通用免注册 REST 源适配器（Tier A）。通过 def.options.parser 选择具体解析器，
// 一个文件覆盖多个"免注册、可直接调用"的权威 API，避免每个源各写一套。
//
// 当前支持：pubchem(化学) / pubmed(医学生理) / musicbrainz(音乐)。
// 新增源只需在 PARSERS 里加一项（url + extract），无需改注册表/类型。
//
// 设计约定（同其他源）：任何网络/解析异常都返回 []，不向上抛，上层已兜底。
//
// 由 kirari-core/src/knowledge/sources/RestApiSource.js 迁入。

import { BaseSource } from "../BaseSource";
import type { RetrievedPassage, RetrieveOptions } from "../types";

const UA = "kirari-pet/0.8 (knowledge-retrieval; contact: user-agent)";

/** 第二步请求函数（用于需要两次调用的源，如 PubMed esearch → efetch） */
type FetchText = (url: string) => Promise<string>;

/** 解析器契约 */
type RestParser = {
    /** 返回首个请求 URL */
    url: (q: string) => string;
    /** 返回纯文本片段或 null。data 为已解析的 JSON（解析失败则为原始文本） */
    extract: (q: string, data: unknown, fetchFn: FetchText) => Promise<string | null> | string | null;
};

const PARSERS: Record<string, RestParser> = {
    pubchem: {
        url: (q) =>
            `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(q)}/property/MolecularFormula,IsomericSMILES,IUPACName/JSON`,
        extract: (_q, data) => {
            const p = (data as { PropertyTable?: { Properties?: Record<string, string>[] } })
                ?.PropertyTable?.Properties?.[0];
            if (!p) return null;
            const parts: string[] = [];
            if (p.IUPACName) parts.push(`IUPAC 名称：${p.IUPACName}`);
            if (p.MolecularFormula) parts.push(`分子式：${p.MolecularFormula}`);
            if (p.IsomericSMILES) parts.push(`SMILES：${p.IsomericSMILES}`);
            return parts.length ? parts.join("；") : null;
        },
    },

    pubmed: {
        url: (q) =>
            `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmode=json&retmax=3`,
        // 两步：esearch 拿 pmids → efetch 拿摘要文本
        extract: async (_q, data, fetchFn) => {
            const ids = (data as { esearchresult?: { idlist?: string[] } })?.esearchresult?.idlist;
            if (!Array.isArray(ids) || !ids.length) return null;
            const text = await fetchFn(
                `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&rettype=abstract&retmode=text`,
            );
            // efetch 返回的是原始摘要文本（含 PMID / Author / Abstract），截取前 ~600 字
            if (!text || !text.trim()) return null;
            return text.replace(/\s+/g, " ").trim().slice(0, 600);
        },
    },

    musicbrainz: {
        url: (q) =>
            `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=3`,
        extract: (_q, data) => {
            const recs = (data as { recordings?: Record<string, unknown>[] })?.recordings;
            if (!Array.isArray(recs) || !recs.length) return null;
            const top = recs[0] as {
                title?: string;
                "artist-credit"?: { name?: string }[];
                releases?: { date?: string }[];
                "first-release-date"?: string;
            };
            const title = top.title || "";
            const artists = Array.isArray(top["artist-credit"])
                ? top["artist-credit"].map((a) => a?.name).filter(Boolean).join("、")
                : "";
            const date = top.releases?.[0]?.date || top["first-release-date"] || "";
            const bits: string[] = [];
            if (title) bits.push(`曲目：${title}`);
            if (artists) bits.push(`艺术家：${artists}`);
            if (date) bits.push(`首发：${date}`);
            return bits.length ? bits.join("；") : null;
        },
    },
};

export class RestApiSource extends BaseSource {
    async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedPassage[]> {
        const parser = PARSERS[String(this.def.parser || "")];
        if (!parser || !query || !query.trim()) return [];
        try {
            const res = await fetch(parser.url(query), {
                headers: { "User-Agent": UA, Accept: "application/json" },
                signal: opts.signal,
            });
            if (!res.ok) return [];
            const raw = await res.text();
            let data: unknown = raw;
            try {
                data = JSON.parse(raw);
            } catch {
                /* 保留原始文本（pubmed efetch 返回纯文本） */
            }
            const text = await parser.extract(query, data, async (u) => {
                try {
                    const r2 = await fetch(u, { headers: { "User-Agent": UA } });
                    return r2.ok ? await r2.text() : "";
                } catch {
                    return "";
                }
            });
            if (!text) return [];
            return [
                {
                    text,
                    source: this.name,
                    score: 0.6,
                    tier: this.tier,
                    priority: this.priority,
                },
            ];
        } catch {
            return [];
        }
    }
}

export default RestApiSource;
