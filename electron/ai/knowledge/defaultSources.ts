// electron/ai/knowledge/defaultSources.ts
// 默认知识源清单（随包分发，零配置）。
//
// ⚠️ 原实现是 defaultSources.json + fs.readFileSync(path.join(__dirname, ...))。
//    主进程经 vite 打包后 __dirname 指向 dist-electron，随包 json 会读不到（asar 路径问题），
//    因此这里内联为常量——打包后一定存在，且省掉一次文件 IO。
//    用户覆盖仍走文件（userData 目录下，见 SourceRegistry.load）。
//
// auth:none 的源开箱即用、无需注册；auth:required 的源默认 disabled，
// 由用户自行配置凭据后启用。
//
// 优先级：tier B 离线植入 > tier A 免注册实时 > 用户私有库(Layer1)；
// 数值 priority 越小越优先。

import type { KnowledgeSourceDef } from "./types";

export const DEFAULT_SOURCES: KnowledgeSourceDef[] = [
    {
        id: "user_kb",
        name: "我的私人知识库",
        type: "user_knowledge_db",
        auth: "none",
        enabled: true,
        priority: 5,
        tier: "A",
        domains: [],
        options: {},
    },
    {
        id: "moegirl",
        name: "萌娘百科",
        type: "mediawiki_api",
        endpoint: "https://zh.moegirl.org.cn/api.php",
        auth: "none",
        enabled: true,
        priority: 20,
        tier: "A",
        domains: ["acgn", "game"],
        options: { limit: 3 },
    },
    {
        id: "pubchem",
        name: "PubChem 化学物质库",
        type: "rest_api",
        parser: "pubchem",
        auth: "none",
        enabled: true,
        priority: 25,
        tier: "A",
        domains: ["science", "chemistry", "nature"],
        options: {},
    },
    {
        id: "pubmed",
        name: "PubMed 医学文献",
        type: "rest_api",
        parser: "pubmed",
        auth: "none",
        enabled: true,
        priority: 26,
        tier: "A",
        domains: ["medicine", "science", "nature"],
        options: {},
    },
    {
        id: "musicbrainz",
        name: "MusicBrainz 音乐库",
        type: "rest_api",
        parser: "musicbrainz",
        auth: "none",
        enabled: true,
        priority: 27,
        tier: "A",
        domains: ["art", "music"],
        options: {},
    },
    {
        id: "bundled_kb",
        name: "离线基础百科（随包索引）",
        type: "local_vector_index",
        path: "./data/kb_index",
        auth: "none",
        enabled: false,
        priority: 10,
        tier: "B",
        domains: ["general", "science", "history", "art", "cs", "medicine", "nature"],
        options: {},
    },
];
