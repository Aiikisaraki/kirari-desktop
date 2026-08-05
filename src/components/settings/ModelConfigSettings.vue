<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import { SETTINGS_CONTEXT } from "./settingsContext";

const { mode, authed } = inject(SETTINGS_CONTEXT)!;
const {
    isLoading,
    error,
    getProfile,
    updateProfile,
    getModelConfig,
    setModelConfig,
    onModelConfigChanged,
} = useApiToken();

// 免费大模型 API Key 领取指引（chatanywhere，支持 gpt/deepseek/通义千问等，国内直连免代理）
const freeKeyUrl = "https://github.com/chatanywhere/GPT_API_free";

const modelInput = ref("gpt-5.4-mini");
const apiEndpointInput = ref("https://api.chatanywhere.tech/v1");
const tokenMasked = ref("");
const hasToken = ref(false);
const newTokenInput = ref("");
const searchProvider = ref<"uapis" | "tavily" | "searxng">("uapis");
const newCredentialInput = ref("");
const hasSearchKey = ref(false);
const searchKeyMasked = ref("");
const searchEndpoint = ref("");
const isSearxng = computed(() => searchProvider.value === "searxng");
const credentialLabel = computed(() => {
    if (searchProvider.value === "searxng") return "自建搜索地址（SearXNG）";
    if (searchProvider.value === "tavily") return "Tavily API Key";
    return "UAPI 令牌（选填，提升额度）";
});
const credentialPlaceholder = computed(() => {
    if (searchProvider.value === "searxng") return "如 http://localhost:8080";
    if (searchProvider.value === "tavily") return "选填：填后改用 Tavily 搜索";
    return "选填：uapis.cn 登录令牌（留空则用匿名免费额度）";
});
const credentialType = computed(() =>
    searchProvider.value === "searxng" ? "text" : "password",
);
const saveSuccess = ref(false);
// 打开时从后端/缓存读到的最新值，保存时只发送「发生变更」的字段。
const baseProfile = ref<{
    model: string;
    apiEndpoint: string;
    searchProvider: string;
} | null>(null);
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function applyProfile(p: {
    model: string;
    apiEndpoint: string;
    tokenMasked: string;
    hasToken: boolean;
    searchKeyMasked?: string;
    hasSearchKey?: boolean;
    searchEndpoint?: string;
    searchProvider?: string;
}) {
    modelInput.value = p.model;
    apiEndpointInput.value = p.apiEndpoint;
    tokenMasked.value = p.tokenMasked;
    hasToken.value = p.hasToken;
    searchProvider.value = p.searchProvider || "uapis";
    searchKeyMasked.value = p.searchKeyMasked ?? "";
    hasSearchKey.value = p.hasSearchKey === true;
    searchEndpoint.value = p.searchEndpoint ?? "";
}

async function loadProfile() {
    if (mode.value === "local") {
        try {
            const profile = await getModelConfig();
            applyProfile(profile);
            baseProfile.value = {
                model: profile.model,
                apiEndpoint: profile.apiEndpoint,
                searchProvider: profile.searchProvider,
            };
        } catch {
            /* 读不到则保留表单当前值 */
        }
        return;
    }
    // 远程模式：已登录才拉取
    if (!authed.value) return;
    try {
        const profile = await getProfile();
        applyProfile(profile);
        baseProfile.value = {
            model: profile.model,
            apiEndpoint: profile.apiEndpoint,
            searchProvider: profile.searchProvider,
        };
    } catch {
        /* 拉取失败则保留当前值 */
    }
}

function flashSuccess() {
    saveSuccess.value = true;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
        saveSuccess.value = false;
    }, 2000);
}

function openExternal(url: string) {
    const w = window as unknown as {
        windowApi?: { openExternal?: (u: string) => Promise<void> };
    };
    w.windowApi?.openExternal?.(url);
}

async function handleSave() {
    const model = modelInput.value.trim();
    const endpoint = apiEndpointInput.value.trim();
    if (!model || !endpoint) {
        error.value = "模型名称和 API 端点不能为空";
        return;
    }
    // 远程模式兜底：之前若因 key 名漂移把空 token 写进 DB（典型：已注册用户首次保存），
    // 单凭改动 model/endpoint 不会自动补上 Token，会原地报「用户尚未配置 API Token」。
    // 此时必须让用户主动重输 Token，否则 PUT 仍然不带 token，聊天还是不工作。
    if (mode.value === "remote" && !hasToken.value && !newTokenInput.value.trim()) {
        error.value = "远程账户尚未配置 API Token，请在「API Token」框里重新填入并保存";
        return;
    }
    // 仅发送变更过的字段：改一个就只发一个，不必三个一起填。
    const patch: {
        model?: string;
        endpoint?: string;
        key?: string;
        searchKey?: string;
        searchEndpoint?: string;
        searchProvider?: string;
    } = {};
    if (model !== (baseProfile.value?.model ?? "")) patch.model = model;
    if (endpoint !== (baseProfile.value?.apiEndpoint ?? ""))
        patch.endpoint = endpoint;
    if (newTokenInput.value.trim()) patch.key = newTokenInput.value.trim();
    if (searchProvider.value !== (baseProfile.value?.searchProvider ?? "uapis"))
        patch.searchProvider = searchProvider.value;
    if (newCredentialInput.value.trim()) {
        if (searchProvider.value === "searxng")
            patch.searchEndpoint = newCredentialInput.value.trim();
        else patch.searchKey = newCredentialInput.value.trim();
    }

    if (Object.keys(patch).length === 0) {
        flashSuccess();
        return;
    }
    try {
        // 本地模式直接写 config.json；远程模式写后端 /api/profile。
        const updated =
            mode.value === "remote"
                ? await updateProfile(patch)
                : await setModelConfig(patch);
        modelInput.value = updated.model;
        apiEndpointInput.value = updated.apiEndpoint;
        tokenMasked.value = updated.tokenMasked;
        hasToken.value = updated.hasToken;
        searchKeyMasked.value = updated.searchKeyMasked;
        hasSearchKey.value = updated.hasSearchKey;
        searchEndpoint.value = updated.searchEndpoint;
        if (updated.searchProvider) searchProvider.value = updated.searchProvider;
        baseProfile.value = {
            model: updated.model,
            apiEndpoint: updated.apiEndpoint,
            searchProvider: updated.searchProvider || "uapis",
        };
        newTokenInput.value = "";
        newCredentialInput.value = "";
        flashSuccess();
    } catch {
        // error 已由 composable 写入
    }
}

onMounted(() => {
    if (mode.value === "local") {
        // 本地模式：config.json 为权威配置，订阅外部编辑实时刷新
        onModelConfigChanged((p) => {
            applyProfile(p);
            baseProfile.value = {
                model: p.model,
                apiEndpoint: p.apiEndpoint,
                searchProvider: p.searchProvider,
            };
        });
    }
    loadProfile();
});

// 远程模式登录态变化（登录/会话恢复）后自动加载配置
watch(authed, (v) => {
    if (v) loadProfile();
});
</script>

<template>
    <section id="model" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🧠</span>
            <span>模型与联网搜索</span>
        </h3>
        <p class="settings-card__desc">
            配置桌宠使用的大模型与联网搜索能力。
        </p>

        <!-- 本地模式免登录，模型配置（含 API Token）直接可填；远程模式需先登录。 -->
        <template v-if="mode === 'local' || authed">
            <div class="field">
                <label class="field-label" for="model">模型名称</label>
                <input
                    id="model"
                    v-model="modelInput"
                    class="text-input"
                    type="text"
                    autocomplete="off"
                    placeholder="例如 gpt-5.4-mini"
                    :disabled="isLoading"
                />
            </div>

            <div class="field">
                <label class="field-label" for="endpoint">模型 API 端点</label>
                <input
                    id="endpoint"
                    v-model="apiEndpointInput"
                    class="text-input"
                    type="url"
                    autocomplete="off"
                    placeholder="https://api.chatanywhere.tech/v1"
                    :disabled="isLoading"
                />
                <p class="settings-hint">
                    这是大模型 API 地址，不是本地后端地址。
                </p>
                <p class="settings-hint">
                    没有 API Key？可前往
                    <a
                        href="#"
                        class="inline-link"
                        @click.prevent="openExternal(freeKeyUrl)"
                        >chatanywhere</a
                    >
                    免费领取（支持 gpt / deepseek /
                    通义千问等常用模型，国内直连、免代理，每日有免费额度）。
                </p>
            </div>

            <div class="field">
                <label class="field-label" for="newToken">API Token</label>
                <input
                    id="newToken"
                    v-model="newTokenInput"
                    class="text-input"
                    type="password"
                    autocomplete="new-password"
                    placeholder="输入新 Token 以替换（留空则不修改）"
                    :disabled="isLoading"
                />
                <p v-if="hasToken" class="settings-hint">
                    当前 Token：{{ tokenMasked }}（已加密保存，无需查看明文）
                </p>
            </div>

            <div class="field">
                <span class="field-label">联网搜索提供商</span>
                <div class="provider-row">
                    <label class="provider-option">
                        <input type="radio" value="uapis" v-model="searchProvider" />
                        <span>UAPI（内置免费）</span>
                    </label>
                    <label class="provider-option">
                        <input type="radio" value="tavily" v-model="searchProvider" />
                        <span>Tavily</span>
                    </label>
                    <label class="provider-option">
                        <input
                            type="radio"
                            value="searxng"
                            v-model="searchProvider"
                        />
                        <span>SearXNG（自建）</span>
                    </label>
                </div>
                <p class="settings-hint">
                    默认使用内置 UAPI 免费搜索，<strong>无需任何配置即可联网</strong>；选
                    Tavily 需填其 API Key；选 SearXNG 需填自建实例地址（隐私可控、零成本）。
                </p>
            </div>

            <div class="field">
                <label class="field-label" for="searchCredential">{{
                    credentialLabel
                }}</label>
                <input
                    id="searchCredential"
                    v-model="newCredentialInput"
                    class="text-input"
                    :type="credentialType"
                    autocomplete="new-password"
                    :placeholder="credentialPlaceholder"
                    :disabled="isLoading"
                />
                <p v-if="!isSearxng && hasSearchKey" class="settings-hint">
                    当前 Key：{{ searchKeyMasked }}（已加密保存，无需查看明文）
                </p>
                <p v-if="isSearxng && searchEndpoint" class="settings-hint">
                    当前地址：{{ searchEndpoint }}
                </p>
                <p v-if="searchProvider === 'uapis'" class="settings-hint">
                    免 key 即可用（匿名每月约 375 次）。在
                    <a
                        href="#"
                        class="inline-link"
                        @click.prevent="openExternal('https://uapis.cn')"
                        >uapis.cn</a
                    >
                    登录获取令牌填到此处，额度可提升至约 875 次/月。
                </p>
                <p v-if="searchProvider === 'tavily'" class="settings-hint">
                    Tavily 结果质量更高，在
                    <a
                        href="#"
                        class="inline-link"
                        @click.prevent="openExternal('https://tavily.com')"
                        >Tavily</a
                    >
                    免费领取 Key。
                </p>
                <p v-if="searchProvider === 'searxng'" class="settings-hint">
                    填后改用你自建的 SearXNG 实例（隐私可控、零成本）。需开启 JSON
                    API：<code>settings.yml</code> 中
                    <code>search.formats: [json]</code> 且
                    <code>limiter: false</code>。
                </p>
            </div>

            <button
                type="button"
                class="btn btn--primary btn--block"
                :disabled="isLoading"
                @click="handleSave"
            >
                {{ isLoading ? "保存中..." : "保存设置" }}
            </button>
            <div v-if="saveSuccess" class="settings-success">保存成功</div>
            <div v-if="error" class="settings-error">{{ error }}</div>
        </template>

        <p v-else class="settings-hint">
            请先在「服务端账号」分区登录后，再配置模型与搜索。
        </p>

        <!-- 仅远程模式且未登录时显示上述提示；本地模式表单始终可填，不会走到这里。 -->
    </section>
</template>
