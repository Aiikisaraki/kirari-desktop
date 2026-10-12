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
    // 多模型
    listModels(): Promise<{ items: ModelListItem[]; activeId: number | null }>;
    addModel(p: { name: string; endpoint: string; model: string; key: string }): Promise<number>;
    updateModel(
        id: number,
        patch: { name?: string; endpoint?: string; model?: string; key?: string },
    ): Promise<{ ok: boolean }>;
    deleteModel(id: number): Promise<{ ok: boolean; list: { items: ModelListItem[]; activeId: number | null } }>;
    activateModel(id: number): Promise<{ ok: boolean; list: { items: ModelListItem[]; activeId: number | null } }>;
}

interface ModelListItem {
    id: number;
    name: string;
    endpoint: string;
    model: string;
    keyMasked: string;
    hasKey: boolean;
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
// 字段命名与 config.json / 核心版控制台 API 三处统一：endpoint / keyMasked / hasKey / searchKey...
const PROFILE_CACHE_KEY = 'kirari.profile.cache.v2';

interface ProfileCache {
    model?: string;
    endpoint?: string;
    keyMasked?: string;
    hasKey?: boolean;
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

    // ---- 多模型 ----
    async function listModels() {
        return getBridge().listModels();
    }
    async function addModel(p: { name: string; endpoint: string; model: string; key: string }) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().addModel(p);
        } catch (err) {
            error.value = err instanceof Error ? err.message : '添加失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }
    async function updateModel(id: number, patch: { name?: string; endpoint?: string; model?: string; key?: string }) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().updateModel(id, patch);
        } catch (err) {
            error.value = err instanceof Error ? err.message : '保存失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }
    async function deleteModel(id: number) {
        error.value = '';
        try {
            return await getBridge().deleteModel(id);
        } catch (err) {
            error.value = err instanceof Error ? err.message : '删除失败';
            throw err;
        }
    }
    async function activateModel(id: number) {
        error.value = '';
        try {
            // 切换后主进程会广播 config:changed → 表单自动刷新成新套的值
            return await getBridge().activateModel(id);
        } catch (err) {
            error.value = err instanceof Error ? err.message : '切换失败';
            throw err;
        }
    }

    return {
        isLoading,
        error,
        readProfileCache,
        getModelConfig,
        setModelConfig,
        onModelConfigChanged,
        listModels,
        addModel,
        updateModel,
        deleteModel,
        activateModel,
    };
}

/** 把配置文件原始内容归一化为设置页使用的形态（含密钥掩码）。 */
function normalize(data: ModelConfigFile) {
    const key = typeof data.key === 'string' ? data.key : '';
    const searchKey = typeof data.searchKey === 'string' ? data.searchKey : '';
    return {
        model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : DEFAULT_MODEL,
        endpoint:
            typeof data.endpoint === 'string' && data.endpoint.trim()
                ? data.endpoint.trim()
                : DEFAULT_ENDPOINT,
        keyMasked: key ? maskKey(key) : '',
        hasKey: !!key,
        searchKeyMasked: searchKey ? maskKey(searchKey) : '',
        hasSearchKey: !!searchKey,
        searchEndpoint: typeof data.searchEndpoint === 'string' ? data.searchEndpoint : '',
        searchProvider: typeof data.searchProvider === 'string' ? data.searchProvider : 'uapis',
        basePersona: typeof data.basePersona === 'string' ? data.basePersona : '',
    };
}
