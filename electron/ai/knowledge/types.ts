// electron/ai/knowledge/types.ts
// 知识源相关类型定义与常量。
//
// 由 kirari-core/src/knowledge/types.js 迁入（原用 JSDoc 表达类型，因为后端是纯 JS；
// 改写为 TypeScript 后有了真实类型，JSDoc 可省）。

/** 鉴权模式：none=免注册可直接调用；required=需用户自备凭据（仅可选启用，项目绝不依赖） */
export const AUTH_MODE = {
    NONE: "none",
    REQUIRED: "required",
} as const;

export type AuthMode = (typeof AUTH_MODE)[keyof typeof AUTH_MODE];

/**
 * 分层（按"是否需要注册 / 分发友好度"）：
 *   A = 免注册实时 API（开箱即用）
 *   B = 离线植入索引（维护者预构建随包分发，一致体验核心）
 *   C = 需注册可选（用户自行配置凭据后启用）
 */
export const TIER = {
    A: "A",
    B: "B",
    C: "C",
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

/** 源类型 → 适配器类映射键（见 SourceRegistry.ADAPTERS） */
export const SOURCE_TYPE = {
    MEDIAWIKI_API: "mediawiki_api",
    LOCAL_VECTOR_INDEX: "local_vector_index",
    USER_MARKDOWN: "user_markdown",
    USER_KNOWLEDGE_DB: "user_knowledge_db",
    REST_API: "rest_api",
} as const;

export type SourceType = (typeof SOURCE_TYPE)[keyof typeof SOURCE_TYPE];

/**
 * 知识源声明（来自 defaultSources.json 或用户覆盖）。
 * 覆盖 / 禁用均以 id 为键。
 */
export type KnowledgeSourceDef = {
    id: string;
    name: string;
    type: SourceType;
    /** API 类源的接入点 */
    endpoint?: string;
    /** 离线索引 / 文件的本地路径 */
    path?: string;
    /** REST 源使用的解析器名（pubchem / pubmed / musicbrainz） */
    parser?: string;
    auth?: AuthMode;
    /** 是否启用（默认 true） */
    enabled?: boolean;
    /** 数值越小优先级越高（检索排序与权重用） */
    priority?: number;
    tier?: Tier;
    /** 覆盖的领域标签（acgn/game/science/history/art/cs/medicine/nature/general...） */
    domains?: string[];
    /** 适配器私有参数（如 limit） */
    options?: Record<string, unknown>;
};

/** 单条检索结果片段。 */
export type RetrievedPassage = {
    /** 片段正文（纯文本） */
    text: string;
    source?: string;
    /** 相关度评分（0~1） */
    score?: number;
    url?: string;
    tier?: Tier;
    priority?: number;
};

/** 检索时的可选参数。 */
export type RetrieveOptions = {
    limit?: number;
    signal?: AbortSignal;
    /** 领域过滤标签（命中任一即参与检索；源自身 domains 为空表示不限） */
    domains?: string[];
    /** 前端主动携带的私有知识库检索结果（DBKnowledgeSource 优先使用） */
    kbContext?: RetrievedPassage[];
    /**
     * 用户信息。私有知识库按此隔离检索。
     * 进程内场景下为本地标识，不再经由网络传输。
     */
    userid?: string;
    /** 预留：单源超时（毫秒） */
    timeoutMs?: number;
};
