import { ref } from 'vue';

interface DeployConfig {
    mode: 'local' | 'remote';
    server: { wsUrl: string; httpUrl: string };
    builtinToken?: string;
}

// 模型配置文件（config.json）结构：本地模式设置界面与用户外部编辑共用。
interface ModelConfigFile {
    endpoint?: string;
    model?: string;
    key?: string;
    searchKey?: string;
    searchEndpoint?: string;
    searchProvider?: string; // 'uapis' | 'tavily' | 'searxng'
    basePersona?: string; // 用户自定义基础人格（自由文字）；缺省/空则后端回退预设人格
    seeded?: boolean;
}

interface TokenApiBridge {
    getDeployConfig(): Promise<DeployConfig>;
    getCapabilities(): Promise<{ localAvailable: boolean }>;
    setDeployServer(server: { wsUrl: string; httpUrl: string }): Promise<{ ok: boolean; server: { wsUrl: string; httpUrl: string } }>;
    setSession(token: string | null): Promise<void>;
    switchMode(target: "local" | "remote"): Promise<void>;
    login(username: string, password: string): Promise<{ ok: boolean; uid?: number; message?: string }>;
    register(username: string, password: string): Promise<{ ok: boolean; message?: string }>;
    request(request: { method: 'GET' | 'POST' | 'PUT'; path: string; body: Record<string, unknown> }): Promise<{ status: number; data: Record<string, unknown> }>;
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

// 本地缓存：保存最近一次从后端拿到的模型配置，作为打开设置界面时的「即时显示」
// 与「后端暂时不可达时的兜底」，避免表单闪现硬编码默认值、也避免重复手工设置。
const PROFILE_CACHE_KEY = 'kirari.profile.cache.v1';

interface ProfileCache {
    username?: string;
    model?: string;
    apiEndpoint?: string;
    tokenMasked?: string;
    hasToken?: boolean;
    searchKeyMasked?: string;
    hasSearchKey?: boolean;
    searchEndpoint?: string;
    searchProvider?: string;
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

export function useApiToken() {
    async function getDeployConfig(): Promise<DeployConfig> {
        return await getBridge().getDeployConfig();
    }

    async function getCapabilities(): Promise<{ localAvailable: boolean }> {
        return await getBridge().getCapabilities();
    }

    // 远程模式：修改服务端地址（ws/http），保存后立即生效（主进程重建连接）。
    async function setDeployServer(server: { wsUrl: string; httpUrl: string }) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().setDeployServer(server);
        } catch (err) {
            error.value = err instanceof Error ? err.message : '保存失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    async function request(method: 'GET' | 'POST' | 'PUT', path: string, body: Record<string, unknown>) {
        const result = await getBridge().request({ method, path, body });
        if (result.status >= 400) throw new Error(String(result.data.message || '请求失败'));
        return result.data;
    }

    async function login(username: string, password: string) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().login(username, password);
        } catch (err) {
            const message = err instanceof Error ? err.message : '登录失败';
            error.value = message;
            return { ok: false, message };
        } finally {
            isLoading.value = false;
        }
    }

    async function register(username: string, password: string) {
        isLoading.value = true;
        error.value = '';
        try {
            return await getBridge().register(username, password);
        } catch (err) {
            const message = err instanceof Error ? err.message : '注册失败';
            error.value = message;
            return { ok: false, message };
        } finally {
            isLoading.value = false;
        }
    }

    async function getProfile(): Promise<{ username: string; model: string; apiEndpoint: string; tokenMasked: string; hasToken: boolean; searchKeyMasked: string; hasSearchKey: boolean; searchEndpoint: string; searchProvider: string }> {
        try {
            const data = await request('GET', '/api/profile', {});
            const profile = {
                username: typeof data.username === 'string' ? data.username : '',
                model: typeof data.model === 'string' ? data.model : 'gpt-5.4-mini',
                apiEndpoint: typeof data.api_endpoint === 'string' ? data.api_endpoint : 'https://api.chatanywhere.tech/v1',
                tokenMasked: typeof data.token_masked === 'string' ? data.token_masked : '',
                hasToken: data.hasToken === true,
                searchKeyMasked: typeof data.search_key_masked === 'string' ? data.search_key_masked : '',
                hasSearchKey: data.hasSearchKey === true,
                searchEndpoint: typeof data.search_endpoint === 'string' ? data.search_endpoint : '',
                searchProvider: typeof data.search_provider === 'string' ? data.search_provider : 'uapis',
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            // 后端不可达时回退本地缓存，避免表单直接闪现硬编码默认值
            const cached = readProfileCache();
            if (cached) {
                return {
                    username: cached.username ?? '',
                    model: cached.model ?? 'gpt-5.4-mini',
                    apiEndpoint: cached.apiEndpoint ?? 'https://api.chatanywhere.tech/v1',
                    tokenMasked: cached.tokenMasked ?? '',
                    hasToken: cached.hasToken === true,
                    searchKeyMasked: cached.searchKeyMasked ?? '',
                    hasSearchKey: cached.hasSearchKey === true,
                    searchEndpoint: cached.searchEndpoint ?? '',
                    searchProvider: cached.searchProvider ?? 'uapis',
                };
            }
            throw err;
        }
    }

    async function updateProfile(patch: {
        // 远程模式下「原生」命名（/api/profile 直接吃 apiEndpoint/token 的字段名）。
        model?: string;
        apiEndpoint?: string;
        token?: string;
        searchKey?: string;
        searchEndpoint?: string;
        searchProvider?: string;
        // 兼容形态：ModelConfigSettings.handleSave 在本地/远程模式下共用同一份 patch，
        // 但本地模式 patch 的字段名是 endpoint / key。若只用 remote 字段名，
        // 远程模式下 endpoint/token 会被静默丢弃导致后端 INSERT 出空 token（用户实际遇到过）。
        endpoint?: string;
        key?: string;
    }) {
        isLoading.value = true;
        error.value = '';
        try {
            // 双形态归一化：优先用 remote 字段名（更贴合 /api/profile），回退到 local 形态。
            const apiEndpoint =
                patch.apiEndpoint !== undefined
                    ? patch.apiEndpoint
                    : patch.endpoint !== undefined
                      ? patch.endpoint
                      : undefined;
            const token =
                patch.token !== undefined ? patch.token : patch.key !== undefined ? patch.key : undefined;

            const body: Record<string, string> = {};
            if (patch.model !== undefined) body.model = patch.model;
            if (apiEndpoint !== undefined) body.api_endpoint = apiEndpoint;
            if (token !== undefined) body.token = token;
            if (patch.searchKey !== undefined) body.search_key = patch.searchKey;
            if (patch.searchEndpoint !== undefined) body.search_endpoint = patch.searchEndpoint;
            if (patch.searchProvider !== undefined) body.search_provider = patch.searchProvider;
            const data = await request('PUT', '/api/profile', body);
            const profile = {
                model: typeof data.model === 'string' ? data.model : 'gpt-5.4-mini',
                apiEndpoint: typeof data.api_endpoint === 'string' ? data.api_endpoint : '',
                tokenMasked: typeof data.token_masked === 'string' ? data.token_masked : '',
                hasToken: data.hasToken === true,
                searchKeyMasked: typeof data.search_key_masked === 'string' ? data.search_key_masked : '',
                hasSearchKey: data.hasSearchKey === true,
                searchEndpoint: typeof data.search_endpoint === 'string' ? data.search_endpoint : '',
                searchProvider: typeof data.search_provider === 'string' ? data.search_provider : 'uapis',
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            error.value = err instanceof Error ? err.message : '保存失败';
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    async function logout() {
        await getBridge().setSession(null);
    }

    // 切换部署模式（本地部署 ⇄ 连接远程服务端）。主进程会清除对方模式残留并重启应用。
    async function switchMode(target: "local" | "remote"): Promise<void> {
        await getBridge().switchMode(target);
    }

    // ---- 本地模式：直接读写模型配置文件（config.json） ----
    function maskKeyLocal(key: string): string {
        if (!key) return "";
        if (key.length <= 6) return "****";
        return `${key.slice(0, 3)}${"*".repeat(6)}${key.slice(-4)}`;
    }

    async function getModelConfig(): Promise<{ username: string; model: string; apiEndpoint: string; tokenMasked: string; hasToken: boolean; searchKeyMasked: string; hasSearchKey: boolean; searchEndpoint: string; searchProvider: string }> {
        const data = await getBridge().getModelConfig();
        const model = typeof data.model === "string" && data.model.trim() ? data.model.trim() : "gpt-5.4-mini";
        const apiEndpoint = typeof data.endpoint === "string" && data.endpoint.trim() ? data.endpoint.trim() : "https://api.chatanywhere.tech/v1";
        const key = typeof data.key === "string" ? data.key : "";
        const searchKey = typeof data.searchKey === "string" ? data.searchKey : "";
        const searchEndpoint = typeof data.searchEndpoint === "string" ? data.searchEndpoint : "";
        const searchProvider = typeof data.searchProvider === "string" ? data.searchProvider : "uapis";
        const profile = {
            username: "",
            model,
            apiEndpoint,
            tokenMasked: key ? maskKeyLocal(key) : "",
            hasToken: !!key,
            searchKeyMasked: searchKey ? maskKeyLocal(searchKey) : "",
            hasSearchKey: !!searchKey,
            searchEndpoint,
            searchProvider,
            basePersona: typeof data.basePersona === "string" ? data.basePersona : "",
        };
        writeProfileCache(profile);
        return profile;
    }

    async function setModelConfig(patch: { model?: string; endpoint?: string; key?: string; searchKey?: string; searchEndpoint?: string; searchProvider?: string; basePersona?: string }) {
        isLoading.value = true;
        error.value = "";
        try {
            const data = await getBridge().setModelConfig(patch);
            const key = typeof data.key === "string" ? data.key : "";
            const searchKey = typeof data.searchKey === "string" ? data.searchKey : "";
            const searchEndpoint = typeof data.searchEndpoint === "string" ? data.searchEndpoint : "";
            const searchProvider = typeof data.searchProvider === "string" ? data.searchProvider : "uapis";
            const profile = {
                model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : "gpt-5.4-mini",
                apiEndpoint: typeof data.endpoint === "string" && data.endpoint.trim() ? data.endpoint.trim() : "https://api.chatanywhere.tech/v1",
                tokenMasked: key ? maskKeyLocal(key) : "",
                hasToken: !!key,
                searchKeyMasked: searchKey ? maskKeyLocal(searchKey) : "",
                hasSearchKey: !!searchKey,
                searchEndpoint,
                searchProvider,
            };
            writeProfileCache(profile);
            return profile;
        } catch (err) {
            error.value = err instanceof Error ? err.message : "保存失败";
            throw err;
        } finally {
            isLoading.value = false;
        }
    }

    function onModelConfigChanged(cb: (p: { model: string; apiEndpoint: string; hasToken: boolean; tokenMasked: string; hasSearchKey: boolean; searchKeyMasked: string; searchEndpoint: string; searchProvider: string }) => void) {
        try {
            getBridge().onModelConfigChanged((cfg: ModelConfigFile) => {
                const key = typeof cfg.key === "string" ? cfg.key : "";
                const searchKey = typeof cfg.searchKey === "string" ? cfg.searchKey : "";
                const searchEndpoint = typeof cfg.searchEndpoint === "string" ? cfg.searchEndpoint : "";
                const searchProvider = typeof cfg.searchProvider === "string" ? cfg.searchProvider : "uapis";
                cb({
                    model: typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : "gpt-5.4-mini",
                    apiEndpoint: typeof cfg.endpoint === "string" && cfg.endpoint.trim() ? cfg.endpoint.trim() : "https://api.chatanywhere.tech/v1",
                    tokenMasked: key ? maskKeyLocal(key) : "",
                    hasToken: !!key,
                    searchKeyMasked: searchKey ? maskKeyLocal(searchKey) : "",
                    hasSearchKey: !!searchKey,
                    searchEndpoint,
                    searchProvider,
                });
            });
        } catch {
            // 桥不可用则静默
        }
    }

    return { isLoading, error, getDeployConfig, getCapabilities, setDeployServer, login, register, getProfile, updateProfile, logout, switchMode, readProfileCache, getModelConfig, setModelConfig, onModelConfigChanged };
}
