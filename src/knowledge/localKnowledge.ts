// src/knowledge/localKnowledge.ts
// 私人知识库：管理本地条目 + 远程源，提供统一检索接口。
// 本地条目存 userData/knowledge.json，远程源实时抓取（不存本地副本）。

import * as fs from 'fs';
import * as path from 'path';
import { fetchRemoteKnowledge, type RemoteSourceType } from './remoteKnowledgeFetchers';

// 本地条目（手写或导入后存本地）
export interface LocalKbEntry {
    id: number;
    type: 'local';
    title: string;
    content: string;
    category?: string;
    tags?: string[];
    source?: string;  // 可选来源标注（如导入的原始 URL）
    createdAt: number;
}

// 远程源（检索时实时抓取）
export interface RemoteKbSource {
    id: number;
    type: 'remote';
    name: string;  // 显示名，如"我的博客"
    url: string;  // 抓取地址（API endpoint 或页面 URL）
    sourceType: RemoteSourceType;  // 'mediawiki' | 'markdown' | 'html' | 'rss'
    enabled: boolean;
    priority?: number;  // 优先级（数字越小越靠前），默认 6
    createdAt: number;
}

export type KbEntry = LocalKbEntry | RemoteKbSource;

export interface RetrievedPassage {
    text: string;
    source: string;
    score: number;
    tier: string;
    priority: number;
}

export class LocalKnowledge {
    private entries: KbEntry[] = [];
    private nextId = 1;
    private filePath: string;

    constructor(userDataPath: string) {
        this.filePath = path.join(userDataPath, 'knowledge.json');
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const data = JSON.parse(raw);
                if (Array.isArray(data.entries)) {
                    this.entries = data.entries;
                    this.nextId = data.nextId || 1;
                }
            }
        } catch (e) {
            console.error('[localKnowledge] 加载失败，使用空库:', e);
            this.entries = [];
            this.nextId = 1;
        }
    }

    private save(): void {
        try {
            const data = { entries: this.entries, nextId: this.nextId };
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            console.error('[localKnowledge] 保存失败:', e);
        }
    }

    getAll(category?: string): KbEntry[] {
        if (!category) return [...this.entries];
        return this.entries.filter((e) => {
            if (e.type === 'remote') return false;  // 远程源无 category
            return e.category === category;
        });
    }

    // 添加本地条目
    add(entry: Omit<LocalKbEntry, 'id' | 'type' | 'createdAt'>): number {
        const id = this.nextId++;
        const newEntry: LocalKbEntry = {
            ...entry,
            id,
            type: 'local',
            createdAt: Date.now(),
        };
        this.entries.push(newEntry);
        this.save();
        return id;
    }

    // 添加远程源
    addRemote(source: Omit<RemoteKbSource, 'id' | 'type' | 'createdAt'>): number {
        const id = this.nextId++;
        const newSource: RemoteKbSource = {
            ...source,
            id,
            type: 'remote',
            createdAt: Date.now(),
        };
        this.entries.push(newSource);
        this.save();
        return id;
    }

    // 更新远程源启用状态
    updateRemote(id: number, updates: Partial<Pick<RemoteKbSource, 'enabled' | 'name' | 'url' | 'sourceType' | 'priority'>>): boolean {
        const entry = this.entries.find(e => e.id === id && e.type === 'remote') as RemoteKbSource | undefined;
        if (!entry) return false;
        Object.assign(entry, updates);
        this.save();
        return true;
    }

    delete(id: number): boolean {
        const idx = this.entries.findIndex((e) => e.id === id);
        if (idx < 0) return false;
        this.entries.splice(idx, 1);
        this.save();
        return true;
    }

    // 异步检索：本地条目（同步 LIKE）+ 远程源（并发实时抓取）
    async search(query: string, limit = 5): Promise<RetrievedPassage[]> {
        const q = query.trim();
        if (!q) return [];

        const results: RetrievedPassage[] = [];

        // 1. 本地条目检索（同步，立即返回）
        const terms = q
            .split(/\s+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 8);

        if (terms.length > 0) {
            const localEntries = this.entries.filter((e): e is LocalKbEntry => e.type === 'local');
            const matched = localEntries.filter((e) => {
                return terms.every(
                    (t) =>
                        e.title.includes(t) ||
                        e.content.includes(t) ||
                        (e.tags && e.tags.some((tag) => tag.includes(t)))
                );
            });

            results.push(
                ...matched.slice(0, limit).map((r, i) => ({
                    text: `【${r.title}】${r.content}`,
                    source: '我的私人知识库',
                    score: 1 / (i + 1),
                    tier: 'A',
                    priority: 5,
                }))
            );
        }

        // 2. 远程源检索（异步并发，每个源最多 2 条）
        const remoteSources = this.entries.filter(
            (e): e is RemoteKbSource => e.type === 'remote' && e.enabled
        );

        if (remoteSources.length > 0) {
            const remotePromises = remoteSources.map(async (src) => {
                try {
                    const fetched = await fetchRemoteKnowledge(src.url, src.sourceType, q, 2, 3000);
                    return fetched.map((f) => ({
                        text: f.text,
                        source: src.name,
                        score: f.score * 0.9,  // 远程源略低于本地
                        tier: 'A',
                        priority: src.priority || 6,
                    }));
                } catch {
                    return [];
                }
            });

            const remoteResults = (await Promise.all(remotePromises)).flat();
            results.push(...remoteResults);
        }

        // 3. 按 score 排序，取前 limit 条
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }
}
