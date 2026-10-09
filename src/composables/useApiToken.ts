import { ref } from 'vue';

// 模型配置文件（config.json）结构：设置界面与用户外部编辑共用。
interface ModelConfigFile {
    endpoint?: string;
    model?: string;
    key?: string;
    searchKey?: string;
    searchEndpoint?: string;
    searchProvider?: string; // 'uapis' | 'tavily' | 'searxng'
    basePersona?: string; // 用户自定义基础人格；缺省/空则回退到预设人格
    seeded?: boolean;
}

interface TokenApiBridge {
    getModelConfig(): Promise<ModelConfigFile>;
    setModelConfig(patch: Partial<ModelConfigFile>): Promise<ModelConfigFile>;
    onModelConfigChanged(cb: (cfg: ModelConfigFile) => void): void;
}

declare global {
    interface Window { tokenApi?: TokenApiBridge }
}

const isLoading = ref(false);
const error = ref('');

function getBridge() {
    if (!window.tokenApi) throw new Error('设置窗口通信不可用');
    return window.tokenApi;
}

// 本地缓存：保存最近一次读到的模型配置，作为打开设置界面时的「即时显示」，
// 避免表单闪现硬编码默认值。
const PROFILE_CACHE_KEY = 'kirari.profile.cache.v1';

interface ProfileCache {
    model?: string;
    apiEndpoint?: string;
    tokenMasked?: string;
    hasToken?: boolean;
    searchKeyMasked?: string;
    hasSearchKey?: boolean;
    searchEndpoint?: string;
    searchProvider?: string;
    basePersona?: string;
}

export function readProfileCache(): ProfileCache | null {
    try {
        const raw = localStorage.getItem(PROFILE_CACHE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') return obj as ProfileCache;
    } catch {
        // 缓存损坏则忽略
    }
    return null;
}

function writeProfileCache(p: ProfileCache) {
    try {
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p));
    } catch {
        // 无视缓存写入失败
    }
}

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_ENDPOINT = 'https://api.chatanywhere.tech/v1';

function maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 6) return '****';
    return `${key.slice(0, 3)}${'*'.repeat(6)}${key.slice(-4)}`;
}

export function useApiToken() {
    // ---- 本机配置：直接读写模型配置文件（config.json） ----
    async function getModelConfig() {
        const data = await getBridge().getModelConfig();
        const profile = normalize(data);
        writeProfileCache(profile);
        return profile;
    }

    async function setModelConfig(patch: {
        model?: string;
        endpoint?: string;
        key?: string;
        searchKey?: string;
        searchEndpoint?: string;
        searchProvider?: string;
        basePersona?: string;
    }) {
        isLoading.value = true;
        error.value = '';
        try {
            const data = await getBridge().setModelConfig(patch);
            const profile = normalize(data);
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            error.value = err instanceof Error ? err.message : '保存失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    function onModelConfigChanged(cb: (p: ReturnType<typeof normalize>) => void) {
        try {
            getBridge().onModelConfigChanged((cfg: ModelConfigFile) => cb(normalize(cfg)));
        } catch {
            // 桥不可用则静默
        }
    }

    return {
        isLoading,
        error,
        readProfileCache,
        getModelConfig,
        setModelConfig,
        onModelConfigChanged,
    };
}

/** 把配置文件原始内容归一化为设置页使用的形态（含密钥掩码）。 */
function normalize(data: ModelConfigFile) {
    const key = typeof data.key === 'string' ? data.key : '';
    const searchKey = typeof data.searchKey === 'string' ? data.searchKey : '';
    return {
        model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : DEFAULT_MODEL,
        apiEndpoint:
            typeof data.endpoint === 'string' && data.endpoint.trim()
                ? data.endpoint.trim()
                : DEFAULT_ENDPOINT,
        tokenMasked: key ? maskKey(key) : '',
        hasToken: !!key,
        searchKeyMasked: searchKey ? maskKey(searchKey) : '',
        hasSearchKey: !!searchKey,
        searchEndpoint: typeof data.searchEndpoint === 'string' ? data.searchEndpoint : '',
        searchProvider: typeof data.searchProvider === 'string' ? data.searchProvider : 'uapis',
        basePersona: typeof data.basePersona === 'string' ? data.basePersona : '',
    };
}
