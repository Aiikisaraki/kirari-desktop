<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";

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
const modelsNotice = ref("");
// null = 没在编辑；"new" = 新增；数字 = 编辑那一套
const editing = ref<{ id: "new" | number; name: string; endpoint: string; model: string; key: string } | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function flashNotice(msg: string) {
    modelsNotice.value = msg;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (modelsNotice.value = ""), 2500);
}

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
            flashNotice("已添加");
        } else {
            await updateModel(f.id, {
                name: f.name,
                endpoint: f.endpoint,
                model: f.model,
                key: f.key.trim() ? f.key.trim() : undefined,
            });
            flashNotice("已保存，立即生效");
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
        flashNotice(`已切换到「${m.name}」`);
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
        flashNotice("已删除");
        await loadModels();
    } catch {
        /* error 已由 composable 写入 */
    }
}

// ── 联网搜索（渠道配置，所有大脑共用）──
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
const saveSuccess = ref(false);
const baseSearchProvider = ref("uapis");
let clearTimer: ReturnType<typeof setTimeout> | undefined;

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
    const patch: { searchKey?: string; searchEndpoint?: string; searchProvider?: string } = {};
    if (searchProvider.value !== baseSearchProvider.value) patch.searchProvider = searchProvider.value;
    if (newCredentialInput.value.trim()) {
        if (searchProvider.value === "searxng") patch.searchEndpoint = newCredentialInput.value.trim();
        else patch.searchKey = newCredentialInput.value.trim();
    }
    if (Object.keys(patch).length === 0) {
        flashSuccess();
        return;
    }
    try {
        const updated = await setModelConfig(patch);
        applySearch(updated);
        baseSearchProvider.value = updated.searchProvider || "uapis";
        newCredentialInput.value = "";
        flashSuccess();
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
    <section id="model" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🧠</span>
            <span>大脑（可配多套）</span>
        </h3>
        <p class="settings-card__desc">
            可以保存好几套大脑（不同的服务地址、型号、钥匙），随时切换聊天用哪套。标着「使用中」的就是当前生效的。
        </p>

        <!-- 列表 -->
        <div v-if="models.length === 0 && !editing" class="models-empty">
            还没配过大脑。点下面的「添加一套」填上服务地址和钥匙就能聊。
        </div>
        <div
            v-for="m in models"
            :key="m.id"
            class="model-item"
            :class="{ 'model-item--active': m.id === activeId }"
        >
            <div class="model-item__main">
                <div class="model-item__name">
                    {{ m.name }}
                    <span v-if="m.id === activeId" class="model-item__badge">使用中</span>
                    <span v-if="!m.hasKey" class="model-item__warn">还没填钥匙</span>
                </div>
                <div class="model-item__meta">{{ m.model }}</div>
                <div class="model-item__meta model-item__meta--dim">{{ m.endpoint }}</div>
                <div v-if="m.hasKey" class="model-item__meta model-item__meta--dim">钥匙 {{ m.keyMasked }}</div>
            </div>
            <div class="model-item__ops">
                <button
                    v-if="m.id !== activeId"
                    type="button"
                    class="btn btn--small btn--primary"
                    :disabled="isLoading"
                    @click="setActive(m)"
                >
                    设为当前
                </button>
                <button type="button" class="btn btn--small" :disabled="isLoading" @click="startEdit(m)">
                    编辑
                </button>
                <button type="button" class="btn btn--small btn--danger" :disabled="isLoading" @click="removeModel(m)">
                    删除
                </button>
            </div>
        </div>

        <p v-if="modelsNotice" class="settings-success">{{ modelsNotice }}</p>
        <p v-if="modelsError" class="settings-error">{{ modelsError }}</p>

        <!-- 添加 / 编辑 -->
        <div v-if="editing" class="model-edit">
            <h4 class="model-edit__title">{{ editing.id === "new" ? "添加一套大脑" : "编辑这套大脑" }}</h4>
            <div class="field">
                <label class="field-label" for="mp-name">名字</label>
                <input
                    id="mp-name"
                    v-model="editing.name"
                    class="text-input"
                    type="text"
                    maxlength="40"
                    placeholder="自己起个好认的，例如「便宜快档」"
                />
            </div>
            <div class="field">
                <label class="field-label" for="mp-endpoint">服务地址</label>
                <input
                    id="mp-endpoint"
                    v-model="editing.endpoint"
                    class="text-input"
                    type="url"
                    placeholder="https://api.chatanywhere.tech/v1"
                />
                <p class="settings-hint">
                    没有 API Key？可前往
                    <a href="#" class="inline-link" @click.prevent="openExternal(freeKeyUrl)">chatanywhere</a>
                    免费领取（国内直连、每日有免费额度）。
                </p>
            </div>
            <div class="field">
                <label class="field-label" for="mp-model">型号</label>
                <input
                    id="mp-model"
                    v-model="editing.model"
                    class="text-input"
                    type="text"
                    placeholder="例如 gpt-5.4-mini"
                />
            </div>
            <div class="field">
                <label class="field-label" for="mp-key">钥匙</label>
                <input
                    id="mp-key"
                    v-model="editing.key"
                    class="text-input"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="editing.id === 'new' ? '这家服务给你的钥匙' : '留空表示不改'"
                />
            </div>
            <div class="model-edit__ops">
                <button type="button" class="btn btn--primary" :disabled="isLoading" @click="saveEdit">
                    {{ isLoading ? "保存中..." : "保存" }}
                </button>
                <button type="button" class="btn" @click="cancelEdit">取消</button>
            </div>
        </div>
        <button v-else type="button" class="btn btn--block models-add" :disabled="isLoading" @click="startAdd">
            ＋ 添加一套
        </button>

        <!-- 联网搜索（所有大脑共用） -->
        <div class="field models-divider">
            <span class="field-label">联网搜索提供商</span>
            <p class="settings-hint">回答实时问题（天气、新闻之类）时用的查证渠道，所有大脑共用这一套。</p>
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
                    <input type="radio" value="searxng" v-model="searchProvider" />
                    <span>SearXNG（自建）</span>
                </label>
            </div>
        </div>

        <div class="field">
            <label class="field-label" for="searchCredential">{{ credentialLabel }}</label>
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
            <p v-if="isSearxng && searchEndpoint" class="settings-hint">当前地址：{{ searchEndpoint }}</p>
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
            {{ isLoading ? "保存中..." : "保存搜索设置" }}
        </button>
        <div v-if="saveSuccess" class="settings-success">保存成功</div>
        <div v-if="error" class="settings-error">{{ error }}</div>
    </section>
</template>

<style scoped>
.models-empty {
    color: var(--text-secondary, #888);
    font-size: 13px;
    padding: 12px 0;
}
.model-item {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 10px 0;
}
.model-item--active {
    border-color: var(--primary-color, #5b6cff);
    background: color-mix(in srgb, var(--primary-color, #5b6cff) 6%, transparent);
}
.model-item__main {
    flex: 1;
    min-width: 0;
}
.model-item__name {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.model-item__badge {
    font-size: 11px;
    font-weight: 400;
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary-color, #5b6cff) 14%, transparent);
    color: var(--primary-color, #5b6cff);
}
.model-item__warn {
    font-size: 11px;
    color: #d64545;
}
.model-item__meta {
    font-size: 12.5px;
    margin-top: 3px;
    word-break: break-all;
}
.model-item__meta--dim {
    opacity: 0.65;
}
.model-item__ops {
    display: flex;
    gap: 6px;
    flex: none;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.btn--small {
    padding: 5px 10px;
    font-size: 12.5px;
}
.btn--danger {
    color: #d64545;
}
.model-edit {
    border: 1px dashed var(--primary-color, #5b6cff);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 12px 0;
}
.model-edit__title {
    margin: 0 0 6px;
    font-size: 14px;
}
.model-edit__ops {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}
.models-add {
    margin-top: 10px;
}
.models-divider {
    margin-top: 22px;
    padding-top: 16px;
    border-top: 1px solid var(--border-color, #e0e0e0);
}
</style>
