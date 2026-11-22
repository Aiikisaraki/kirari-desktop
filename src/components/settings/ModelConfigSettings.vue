<script setup lang="ts">
/**
 * 模型：可以存好几套（服务地址 / 型号 / 钥匙），随时切换聊天用哪套；
 * 以及所有套共用的联网搜索渠道。
 */
import { computed, onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

const {
    isLoading,
    error,
    getModelConfig,
    setModelConfig,
    onModelConfigChanged,
    listModels,
    addModel,
    updateModel,
    deleteModel,
    activateModel,
} = useApiToken();

// 免费大模型 API Key 领取指引（chatanywhere，支持 gpt/deepseek/通义千问等，国内直连免代理）
const freeKeyUrl = "https://github.com/chatanywhere/GPT_API_free";

// ── 多模型 ──
// 每套 = 名字 + 服务地址 + 型号 + 钥匙；「设为当前」后聊天就走那套。
interface ModelItem {
    id: number;
    name: string;
    endpoint: string;
    model: string;
    keyMasked: string;
    hasKey: boolean;
}
const models = ref<ModelItem[]>([]);
const activeId = ref<number | null>(null);
const modelsError = ref("");
// null = 没在编辑；"new" = 新增；数字 = 编辑那一套
const editing = ref<{ id: "new" | number; name: string; endpoint: string; model: string; key: string } | null>(null);

async function loadModels() {
    try {
        const d = await listModels();
        models.value = d.items;
        activeId.value = d.activeId;
    } catch {
        /* 读不到保留现状 */
    }
}

function startAdd() {
    editing.value = { id: "new", name: "", endpoint: "", model: "gpt-5.4-mini", key: "" };
    modelsError.value = "";
}

function startEdit(m: ModelItem) {
    // 钥匙不回填明文，留空 = 不改
    editing.value = { id: m.id, name: m.name, endpoint: m.endpoint, model: m.model, key: "" };
    modelsError.value = "";
}

function cancelEdit() {
    editing.value = null;
    modelsError.value = "";
}

async function saveEdit() {
    const f = editing.value;
    if (!f) return;
    if (!f.name.trim() || !f.endpoint.trim() || !f.model.trim()) {
        modelsError.value = "名字、服务地址、型号都要填";
        return;
    }
    if (f.id === "new" && !f.key.trim()) {
        modelsError.value = "新的一套要把钥匙也填上";
        return;
    }
    try {
        if (f.id === "new") {
            await addModel({ name: f.name, endpoint: f.endpoint, model: f.model, key: f.key });
            emit("saved", "已添加一套模型");
        } else {
            await updateModel(f.id, {
                name: f.name,
                endpoint: f.endpoint,
                model: f.model,
                key: f.key.trim() ? f.key.trim() : undefined,
            });
            emit("saved", "已保存，立即生效");
        }
        editing.value = null;
        await loadModels();
    } catch {
        /* error 已由 composable 写入 */
    }
}

async function setActive(m: ModelItem) {
    modelsError.value = "";
    try {
        await activateModel(m.id);
        emit("saved", `已切换到「${m.name}」`);
        await loadModels();
    } catch {
        /* error 已由 composable 写入 */
    }
}

async function removeModel(m: ModelItem) {
    if (!window.confirm(`删掉「${m.name}」？删了就找不回来了。`)) return;
    modelsError.value = "";
    try {
        await deleteModel(m.id);
        emit("saved", "已删除");
        await loadModels();
    } catch {
        /* error 已由 composable 写入 */
    }
}

// ── 联网搜索（渠道配置，所有模型共用）──
const searchProvider = ref<"uapis" | "tavily" | "searxng">("uapis");
function normalizeProvider(v: string | undefined): "uapis" | "tavily" | "searxng" {
    return v === "tavily" || v === "searxng" ? v : "uapis";
}
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
const credentialType = computed(() => (searchProvider.value === "searxng" ? "text" : "password"));
const baseSearchProvider = ref("uapis");

function applySearch(p: {
    searchKeyMasked?: string;
    hasSearchKey?: boolean;
    searchEndpoint?: string;
    searchProvider?: string;
}) {
    searchProvider.value = normalizeProvider(p.searchProvider);
    searchKeyMasked.value = p.searchKeyMasked ?? "";
    hasSearchKey.value = p.hasSearchKey === true;
    searchEndpoint.value = p.searchEndpoint ?? "";
}

async function loadSearch() {
    try {
        applySearch(await getModelConfig());
        baseSearchProvider.value = searchProvider.value;
    } catch {
        /* 读不到则保留当前值 */
    }
}

function openExternal(url: string) {
    const w = window as unknown as {
        windowApi?: { openExternal?: (u: string) => Promise<void> };
    };
    w.windowApi?.openExternal?.(url);
}

async function handleSave() {
    const patch: { searchKey?: string; searchEndpoint?: string; searchProvider?: string } = {};
    if (searchProvider.value !== baseSearchProvider.value) patch.searchProvider = searchProvider.value;
    if (newCredentialInput.value.trim()) {
        if (searchProvider.value === "searxng") patch.searchEndpoint = newCredentialInput.value.trim();
        else patch.searchKey = newCredentialInput.value.trim();
    }
    if (Object.keys(patch).length === 0) {
        emit("saved", "没有改动，搜索设置还是原来那套");
        return;
    }
    try {
        const updated = await setModelConfig(patch);
        applySearch(updated);
        baseSearchProvider.value = updated.searchProvider || "uapis";
        newCredentialInput.value = "";
        emit("saved", "搜索设置已保存");
    } catch {
        // error 已由 composable 写入
    }
}

onMounted(() => {
    // 订阅 config.json 的外部改动：手动编辑、组网同步过来的配置实时刷新。
    onModelConfigChanged((p) => applySearch(p));
    loadModels();
    loadSearch();
});
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">模型</h2>
                    <p class="sk-card__desc">
                        可以保存好几套模型（不同的服务地址、型号、钥匙），随时切换聊天用哪套。标着「使用中」的就是当前生效的。
                    </p>
                </div>
            </div>

            <div class="sk-card__body">
                <p v-if="models.length === 0 && !editing" class="sk-empty">
                    还没配过模型。点下面的「添加一套」填上服务地址和钥匙就能聊。
                </p>

                <div v-else class="sk-items">
                    <div
                        v-for="m in models"
                        :key="m.id"
                        class="sk-item model-item"
                        :class="{ 'model-item--active': m.id === activeId, 'is-active': m.id === activeId }"
                    >
                        <div class="sk-item__main">
                            <div class="sk-item__title">
                                {{ m.name }}
                                <span v-if="m.id === activeId" class="sk-badge sk-badge--brand">使用中</span>
                                <span v-if="!m.hasKey" class="sk-badge sk-badge--warn">还没填钥匙</span>
                            </div>
                            <p class="sk-item__meta">型号 {{ m.model }}</p>
                            <p class="sk-item__meta">地址 {{ m.endpoint }}</p>
                            <p v-if="m.hasKey" class="sk-item__meta sk-item__meta--mono">
                                钥匙 {{ m.keyMasked }}
                            </p>
                        </div>
                        <div class="sk-item__ops">
                            <button
                                v-if="m.id !== activeId"
                                type="button"
                                class="sk-btn sk-btn--ghost sk-btn--sm"
                                :disabled="isLoading"
                                @click="setActive(m)"
                            >
                                设为当前
                            </button>
                            <button
                                type="button"
                                class="sk-btn sk-btn--ghost sk-btn--sm"
                                :disabled="isLoading"
                                @click="startEdit(m)"
                            >
                                编辑
                            </button>
                            <button
                                type="button"
                                class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger"
                                :disabled="isLoading"
                                @click="removeModel(m)"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>

                <div v-if="modelsError || error" class="sk-card__body">
                    <div class="sk-alert sk-alert--error">
                        <SettingsIcon name="alert" />
                        <span>{{ modelsError || error }}</span>
                    </div>
                </div>
            </div>

            <!-- 添加 / 编辑：内联展开，不再用弹层 -->
            <div v-if="editing" class="sk-editor">
                <h3 class="sk-editor__title">
                    {{ editing.id === "new" ? "添加一套模型" : "编辑这套模型" }}
                </h3>

                <div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="mp-name">名字</label>
                        <input
                            id="mp-name"
                            v-model="editing.name"
                            class="sk-input"
                            type="text"
                            maxlength="40"
                            placeholder="自己起个好认的，例如「便宜快档」"
                        />
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="mp-endpoint">服务地址</label>
                        <input
                            id="mp-endpoint"
                            v-model="editing.endpoint"
                            class="sk-input sk-input--mono"
                            type="url"
                            placeholder="https://api.chatanywhere.tech/v1"
                        />
                        <p class="sk-field__hint">
                            没有 API Key？可前往
                            <a href="#" @click.prevent="openExternal(freeKeyUrl)">chatanywhere</a>
                            免费领取（国内直连、每日有免费额度）。
                        </p>
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="mp-model">型号</label>
                        <input
                            id="mp-model"
                            v-model="editing.model"
                            class="sk-input"
                            type="text"
                            placeholder="例如 gpt-5.4-mini"
                        />
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="mp-key">钥匙</label>
                        <input
                            id="mp-key"
                            v-model="editing.key"
                            class="sk-input"
                            type="password"
                            autocomplete="new-password"
                            :placeholder="editing.id === 'new' ? '这家服务给你的钥匙' : '留空表示不改'"
                        />
                    </div>
                </div>

                <div class="sk-editor__foot">
                    <button type="button" class="sk-btn sk-btn--primary" :disabled="isLoading" @click="saveEdit">
                        {{ isLoading ? "保存中…" : "保存" }}
                    </button>
                    <button type="button" class="sk-btn sk-btn--ghost" @click="cancelEdit">取消</button>
                </div>
            </div>

            <div v-else class="sk-card__foot">
                <button type="button" class="sk-btn sk-btn--block" :disabled="isLoading" @click="startAdd">
                    <SettingsIcon name="plus" />
                    添加一套
                </button>
            </div>
        </div>

        <!-- 联网搜索（所有模型共用） -->
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">联网搜索</h2>
                    <p class="sk-card__desc">
                        回答实时问题（天气、新闻之类）时用的查证渠道，所有模型共用这一套。
                    </p>
                </div>
            </div>

            <div class="sk-card__body">
                <div class="sk-choices" role="radiogroup" aria-label="联网搜索提供商">
                    <label class="sk-choice">
                        <input type="radio" value="uapis" v-model="searchProvider" />
                        <span class="sk-choice__text">
                            <span class="sk-choice__label">UAPI（内置免费）</span>
                            <span class="sk-choice__sub">匿名免费额度，日常够用</span>
                        </span>
                    </label>
                    <label class="sk-choice">
                        <input type="radio" value="tavily" v-model="searchProvider" />
                        <span class="sk-choice__text">
                            <span class="sk-choice__label">Tavily</span>
                            <span class="sk-choice__sub">填自己的 Key，结果更稳</span>
                        </span>
                    </label>
                    <label class="sk-choice">
                        <input type="radio" value="searxng" v-model="searchProvider" />
                        <span class="sk-choice__text">
                            <span class="sk-choice__label">SearXNG（自建）</span>
                            <span class="sk-choice__sub">隐私可控、零成本</span>
                        </span>
                    </label>
                </div>
            </div>

            <div class="sk-card__body">
                <div class="sk-field">
                    <label class="sk-field__label" for="searchCredential">{{ credentialLabel }}</label>
                    <input
                        id="searchCredential"
                        v-model="newCredentialInput"
                        class="sk-input"
                        :type="credentialType"
                        autocomplete="new-password"
                        :placeholder="credentialPlaceholder"
                        :disabled="isLoading"
                    />
                    <p v-if="!isSearxng && hasSearchKey" class="sk-field__hint">
                        当前 Key：{{ searchKeyMasked }}（已加密保存，无需查看明文）
                    </p>
                    <p v-if="isSearxng && searchEndpoint" class="sk-field__hint">
                        当前地址：{{ searchEndpoint }}
                    </p>
                    <p v-if="searchProvider === 'searxng'" class="sk-field__hint">
                        填后改用你自建的 SearXNG 实例（隐私可控、零成本）。需开启 JSON
                        API：<code>settings.yml</code> 中
                        <code>search.formats: [json]</code> 且
                        <code>limiter: false</code>。
                    </p>
                </div>
            </div>

            <div class="sk-card__foot">
                <button
                    type="button"
                    class="sk-btn sk-btn--primary"
                    :disabled="isLoading"
                    @click="handleSave"
                >
                    {{ isLoading ? "保存中…" : "保存" }}
                </button>
            </div>
        </div>
    </section>
</template>
