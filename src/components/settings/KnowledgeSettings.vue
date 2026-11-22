<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

interface LocalKbEntry {
    id: number;
    type: 'local';
    title: string;
    content: string;
    category?: string | null;
    tags?: string[];
    source?: string | null;
}

interface RemoteKbSource {
    id: number;
    type: 'remote';
    name: string;
    url: string;
    sourceType: 'mediawiki' | 'markdown' | 'html' | 'rss';
    enabled: boolean;
    priority?: number;
}

type KbEntry = LocalKbEntry | RemoteKbSource;

const emit = defineEmits<{ saved: [msg?: string] }>();
const errorMsg = ref("");
const kbApi = (window as any).kbApi;

const entries = ref<KbEntry[]>([]);
const loading = ref(false);
const showEditor = ref(false);
const showRemoteEditor = ref(false);
const editing = ref<{
    id?: number;
    title: string;
    content: string;
    category: string;
    tagsText: string;
}>({ title: "", content: "", category: "", tagsText: "" });
const editingRemote = ref<{
    id?: number;
    name: string;
    url: string;
    sourceType: 'mediawiki' | 'markdown' | 'html' | 'rss';
    enabled: boolean;
    priority: number;
}>({ name: "", url: "", sourceType: "mediawiki", enabled: true, priority: 6 });

const localEntries = computed(() => entries.value.filter(e => e.type === 'local') as LocalKbEntry[]);
const remoteSources = computed(() => entries.value.filter(e => e.type === 'remote') as RemoteKbSource[]);

async function load() {
    loading.value = true;
    try {
        const data = await kbApi.list();
        entries.value = Array.isArray(data) ? data : [];
    } catch {
        errorMsg.value = "读取知识库失败";
    } finally {
        loading.value = false;
    }
}

function openAdd() {
    editing.value = { title: "", content: "", category: "", tagsText: "" };
    showEditor.value = true;
}

function openAddRemote() {
    editingRemote.value = { name: "", url: "", sourceType: "mediawiki", enabled: true, priority: 6 };
    showRemoteEditor.value = true;
}

function openEdit(e: KbEntry) {
    if (e.type === 'local') {
        editing.value = {
            id: e.id,
            title: e.title,
            content: e.content,
            category: e.category ?? "",
            tagsText: Array.isArray(e.tags) ? e.tags.join(", ") : "",
        };
        showEditor.value = true;
    }
}

function openEditRemote(e: RemoteKbSource) {
    // RemoteKbSource.priority 是可选的，编辑表单要求必填，这里补默认值。
    editingRemote.value = { ...e, priority: e.priority ?? 0 };
    showRemoteEditor.value = true;
}

async function save() {
    if (!editing.value.title.trim() || !editing.value.content.trim()) {
        errorMsg.value = "标题和内容不能为空";
        return;
    }
    const tags = editing.value.tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    try {
        await kbApi.add({
            title: editing.value.title,
            content: editing.value.content,
            category: editing.value.category,
            tags,
        });
        emit("saved", "知识已保存");
        errorMsg.value = "";
        showEditor.value = false;
        await load();
    } catch {
        errorMsg.value = "保存失败";
    }
}

async function saveRemote() {
    if (!editingRemote.value.name.trim() || !editingRemote.value.url.trim()) {
        errorMsg.value = "名称和 URL 不能为空";
        return;
    }
    try {
        if (editingRemote.value.id) {
            await kbApi.updateRemote(editingRemote.value.id, {
                name: editingRemote.value.name,
                url: editingRemote.value.url,
                sourceType: editingRemote.value.sourceType,
                enabled: editingRemote.value.enabled,
                priority: editingRemote.value.priority,
            });
        } else {
            await kbApi.addRemote({
                name: editingRemote.value.name,
                url: editingRemote.value.url,
                sourceType: editingRemote.value.sourceType,
                enabled: editingRemote.value.enabled,
                priority: editingRemote.value.priority,
            });
        }
        emit("saved", "远程源已保存");
        errorMsg.value = "";
        showRemoteEditor.value = false;
        await load();
    } catch {
        errorMsg.value = "保存失败";
    }
}

async function toggleRemote(e: RemoteKbSource) {
    try {
        await kbApi.updateRemote(e.id, { enabled: !e.enabled });
        await load();
    } catch {
        errorMsg.value = "切换失败";
    }
}

async function remove(e: KbEntry) {
    try {
        await kbApi.delete(e.id);
        emit("saved", "已删除知识条目");
        await load();
    } catch {
        errorMsg.value = "删除失败";
    }
}

onMounted(load);
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">本地知识</h2>
                    <p class="sk-card__desc">写下希望她记住的事实，聊天时自然会参考。内容留在本机，也会和核心版共用。</p>
                </div>
            </div>
            <div class="sk-card__body">
                <p v-if="loading" class="sk-empty">正在读取知识库…</p>
                <p v-else-if="localEntries.length === 0" class="sk-empty">还没有本地知识。可以先记一条她容易弄混的事实。</p>
                <div v-else class="sk-items">
                    <article v-for="e in localEntries" :key="e.id" class="sk-item">
                        <div class="sk-item__main">
                            <div class="sk-item__title">
                                {{ e.title }}
                                <span v-if="e.category" class="sk-badge sk-badge--brand">{{ e.category }}</span>
                            </div>
                            <p class="sk-item__meta sk-clamp">{{ e.content }}</p>
                            <div v-if="e.tags?.length" class="sk-toolbar">
                                <span v-for="t in e.tags" :key="t" class="sk-badge">#{{ t }}</span>
                            </div>
                        </div>
                        <div class="sk-item__ops">
                            <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="openEdit(e)">
                                <SettingsIcon name="edit" /> 编辑
                            </button>
                            <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="remove(e)">
                                <SettingsIcon name="trash" /> 删除
                            </button>
                        </div>
                    </article>
                </div>
            </div>
            <p v-if="errorMsg" class="sk-alert sk-alert--error">
                <SettingsIcon name="alert" /><span>{{ errorMsg }}</span>
            </p>
            <div v-if="showEditor" class="sk-editor">
                <h3 class="sk-editor__title">{{ editing.id ? "编辑知识" : "添加知识" }}</h3>
                <div class="sk-field">
                    <label class="sk-field__label" for="kb-title">标题</label>
                    <input id="kb-title" v-model="editing.title" class="sk-input" placeholder="例如：英梨梨的正确出处" />
                </div>
                <div class="sk-field">
                    <label class="sk-field__label" for="kb-content">内容</label>
                    <textarea id="kb-content" v-model="editing.content" class="sk-textarea" rows="4" placeholder="写下你希望她记住的事实。" />
                </div>
                <div class="sk-grid">
                    <div class="sk-field">
                        <label class="sk-field__label" for="kb-category">分类（可选）</label>
                        <input id="kb-category" v-model="editing.category" class="sk-input" placeholder="例如：ACGN / 化学 / 历史" />
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="kb-tags">标签（可选，逗号分隔）</label>
                        <input id="kb-tags" v-model="editing.tagsText" class="sk-input" placeholder="例如：角色, 动漫" />
                    </div>
                </div>
                <div class="sk-editor__foot">
                    <button type="button" class="sk-btn sk-btn--primary" @click="save">保存</button>
                    <button type="button" class="sk-btn sk-btn--ghost" @click="showEditor = false">取消</button>
                </div>
            </div>
            <div v-else class="sk-card__foot">
                <button type="button" class="sk-btn sk-btn--primary" @click="openAdd"><SettingsIcon name="plus" /> 添加知识</button>
            </div>
        </div>

        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">远程源</h2>
                    <p class="sk-card__desc">检索时实时抓取指定地址，不在本机保存远程副本。超时 3 秒会自动跳过。</p>
                </div>
            </div>
            <div class="sk-card__body">
                <p v-if="remoteSources.length === 0" class="sk-empty">还没有远程源。</p>
                <div v-else class="sk-items">
                    <article v-for="e in remoteSources" :key="e.id" class="sk-item" :class="{ 'is-muted': !e.enabled }">
                        <div class="sk-item__main">
                            <div class="sk-item__title">
                                {{ e.name }}
                                <span class="sk-badge" :class="e.enabled ? 'sk-badge--ok' : ''">{{ e.enabled ? "已启用" : "已停用" }}</span>
                                <span class="sk-badge">{{ e.sourceType }}</span>
                            </div>
                            <p class="sk-item__meta sk-item__meta--mono">{{ e.url }}</p>
                        </div>
                        <div class="sk-item__ops">
                            <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="toggleRemote(e)">{{ e.enabled ? "禁用" : "启用" }}</button>
                            <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="openEditRemote(e)"><SettingsIcon name="edit" /> 编辑</button>
                            <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="remove(e)"><SettingsIcon name="trash" /> 删除</button>
                        </div>
                    </article>
                </div>
            </div>
            <p v-if="errorMsg" class="sk-alert sk-alert--error"><SettingsIcon name="alert" /><span>{{ errorMsg }}</span></p>
            <div v-if="showRemoteEditor" class="sk-editor">
                <h3 class="sk-editor__title">{{ editingRemote.id ? "编辑远程源" : "添加远程源" }}</h3>
                <div class="sk-grid">
                    <div class="sk-field">
                        <label class="sk-field__label" for="remote-name">名称</label>
                        <input id="remote-name" v-model="editingRemote.name" class="sk-input" placeholder="我的博客" />
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="remote-url">URL</label>
                        <input id="remote-url" v-model="editingRemote.url" class="sk-input sk-input--mono" placeholder="https://my.wiki.com/api.php" />
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="remote-type">类型</label>
                        <select id="remote-type" v-model="editingRemote.sourceType" class="sk-select">
                            <option value="mediawiki">MediaWiki（维基）</option><option value="markdown">Markdown 文件</option><option value="html">HTML 页面</option><option value="rss">RSS Feed</option>
                        </select>
                    </div>
                    <div class="sk-field">
                        <label class="sk-field__label" for="remote-priority">优先级（数字越小越高）</label>
                        <input id="remote-priority" v-model.number="editingRemote.priority" type="number" min="1" max="99" class="sk-input" placeholder="6" />
                    </div>
                </div>
                <label class="sk-check"><input v-model="editingRemote.enabled" type="checkbox" /><span>启用这个远程源</span></label>
                <div class="sk-editor__foot">
                    <button type="button" class="sk-btn sk-btn--primary" @click="saveRemote">保存</button>
                    <button type="button" class="sk-btn sk-btn--ghost" @click="showRemoteEditor = false">取消</button>
                </div>
            </div>
            <div v-else class="sk-card__foot">
                <button type="button" class="sk-btn" @click="openAddRemote"><SettingsIcon name="plus" /> 添加远程源</button>
            </div>
        </div>
    </section>
</template>
