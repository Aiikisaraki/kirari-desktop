// src/knowledge/remoteKnowledgeFetchers.ts
// 远程知识源抓取器：实时抓取在线内容（MediaWiki / Markdown / HTML / RSS），转为检索结果。

export type RemoteSourceType = 'mediawiki' | 'markdown' | 'html' | 'rss';

export interface RemoteFetchResult {
    text: string;
    title?: string;
    score: number;
}

// 抓取远程知识源，返回检索结果（最多 maxResults 条）
export async function fetchRemoteKnowledge(
    url: string,
    sourceType: RemoteSourceType,
    query: string,
    maxResults = 2,
    timeout = 3000
): Promise<RemoteFetchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        switch (sourceType) {
            case 'mediawiki':
                return await fetchMediaWiki(url, query, maxResults, controller.signal);
            case 'markdown':
                return await fetchMarkdown(url, query, maxResults, controller.signal);
            case 'html':
                return await fetchHtml(url, query, maxResults, controller.signal);
            case 'rss':
                return await fetchRss(url, query, maxResults, controller.signal);
            default:
                return [];
        }
    } catch (e) {
        if ((e as Error).name === 'AbortError') {
            console.warn(`[remote-kb] 超时: ${url}`);
        } else {
            console.error(`[remote-kb] 抓取失败: ${url}`, e);
        }
        return [];
    } finally {
        clearTimeout(timer);
    }
}

// MediaWiki API（如维基百科、萌娘百科）
async function fetchMediaWiki(
    apiUrl: string,
    query: string,
    maxResults: number,
    signal: AbortSignal
): Promise<RemoteFetchResult[]> {
    // 搜索条目
    const searchUrl = `${apiUrl}?action=opensearch&format=json&limit=${maxResults}&search=${encodeURIComponent(query)}`;
    const resp = await fetch(searchUrl, { signal });
    const data = await resp.json();
    if (!Array.isArray(data) || data.length < 4) return [];

    const titles: string[] = data[1];
    const snippets: string[] = data[2];

    const results: RemoteFetchResult[] = [];
    for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
        const title = titles[i];
        // 获取完整正文（提取前 500 字）
        const contentUrl = `${apiUrl}?action=query&format=json&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}`;
        try {
            const cr = await fetch(contentUrl, { signal });
            const cd = await cr.json();
            const pages = cd.query?.pages || {};
            const page = Object.values(pages)[0] as any;
            const extract = page?.extract || snippets[i] || '';
            results.push({
                text: `【${title}】${extract.slice(0, 500)}`,
                title,
                score: 0.9 - i * 0.1,
            });
        } catch {
            // 失败时用摘要兜底
            results.push({
                text: `【${title}】${snippets[i] || ''}`,
                title,
                score: 0.9 - i * 0.1,
            });
        }
    }
    return results;
}

// Markdown 文件（直接 fetch 文本内容，按查询词过滤段落）
async function fetchMarkdown(
    url: string,
    query: string,
    maxResults: number,
    signal: AbortSignal
): Promise<RemoteFetchResult[]> {
    const resp = await fetch(url, { signal });
    const text = await resp.text();
    const lines = text.split('\n');

    // 提取标题（第一个 # 行）
    const titleLine = lines.find(l => l.trim().startsWith('#'));
    const title = titleLine ? titleLine.replace(/^#+\s*/, '') : new URL(url).pathname.split('/').pop() || 'Markdown';

    // 按查询词过滤段落（包含任意查询词的段落）
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const paragraphs = text.split(/\n\n+/).filter(p => {
        return terms.some(t => p.includes(t));
    });

    return paragraphs.slice(0, maxResults).map((p, i) => ({
        text: `【${title}】${p.slice(0, 500)}`,
        title,
        score: 0.8 - i * 0.1,
    }));
}

// HTML 页面（抓取 <article> 或 <main> 内容，转 Markdown）
async function fetchHtml(
    url: string,
    query: string,
    maxResults: number,
    signal: AbortSignal
): Promise<RemoteFetchResult[]> {
    const resp = await fetch(url, { signal });
    const html = await resp.text();

    // 提取标题
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;

    // 提取正文（优先 <article> / <main> / class="content"）
    let content = html;
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (articleMatch) content = articleMatch[1];
    else if (mainMatch) content = mainMatch[1];

    // 简单去标签（生产环境应用 turndown 库）
    const text = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    // 按查询词过滤段落
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const sentences = text.split(/[。！？\n]+/).filter(s => {
        return s.length > 20 && terms.some(t => s.includes(t));
    });

    return sentences.slice(0, maxResults).map((s, i) => ({
        text: `【${title}】${s.slice(0, 500)}`,
        title,
        score: 0.7 - i * 0.1,
    }));
}

// RSS Feed（解析最新文章，按查询词过滤）
async function fetchRss(
    url: string,
    query: string,
    maxResults: number,
    signal: AbortSignal
): Promise<RemoteFetchResult[]> {
    const resp = await fetch(url, { signal });
    const xml = await resp.text();

    // 简单 XML 解析（生产环境应用 fast-xml-parser）
    const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
    const terms = query.trim().split(/\s+/).filter(Boolean);

    const results: RemoteFetchResult[] = [];
    for (const item of items.slice(0, maxResults * 2)) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
        const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const desc = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]+>/g, '').trim() : '';

        // 过滤：标题或描述包含查询词
        const text = `${title} ${desc}`;
        if (terms.some(t => text.includes(t))) {
            results.push({
                text: `【${title}】${desc.slice(0, 500)}`,
                title,
                score: 0.8 - results.length * 0.1,
            });
            if (results.length >= maxResults) break;
        }
    }
    return results;
}
