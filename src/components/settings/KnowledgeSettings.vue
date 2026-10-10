<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useToast } from "../../composables/useToast";

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

const toast = useToast();
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
        toast.error("读取知识库失败");
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
        toast.error("标题和内容不能为空");
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
        toast.success("已保存");
        showEditor.value = false;
        await load();
    } catch {
        toast.error("保存失败");
    }
}

async function saveRemote() {
    if (!editingRemote.value.name.trim() || !editingRemote.value.url.trim()) {
        toast.error("名称和 URL 不能为空");
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
        toast.success("已保存");
        showRemoteEditor.value = false;
        await load();
    } catch {
        toast.error("保存失败");
    }
}

async function toggleRemote(e: RemoteKbSource) {
    try {
        await kbApi.updateRemote(e.id, { enabled: !e.enabled });
        await load();
    } catch {
        toast.error("切换失败");
    }
}

async function remove(e: KbEntry) {
    try {
        await kbApi.delete(e.id);
        toast.success("已删除");
        await load();
    } catch {
        toast.error("删除失败");
    }
}

onMounted(load);
</script>

<template>
    <section id="knowledge" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">📚</span>
            <span>知识库</span>
        </h3>
        <p class="settings-card__desc">
            你的私人知识库。在这里记下的常识，桌宠在聊天时会自然用上，让它在你关心的领域更靠谱。
            例如记一条「英梨梨 =《路人女主的养成方法》的泽村·斯宾塞·英梨梨」，它就再也不会张冠李戴。
            平时多补充一点，它会越用越懂你。
        </p>

        <div v-if="loading" class="settings-card__group">
            <span class="settings-hint">加载中…</span>
        </div>
        <div v-else-if="entries.length === 0" class="settings-card__group">
            <span class="settings-hint"
                >还没有任何条目，点击下方按钮开始记录你的第一则知识。</span
            >
        </div>

        <ul v-else class="kb-list">
            <!-- 本地条目 -->
            <li v-for="e in localEntries" :key="e.id" class="kb-item">
                <div class="kb-item__main">
                    <span class="kb-item__title">{{ e.title }}</span>
                    <span class="kb-item__content">{{ e.content }}</span>
                    <span v-if="e.category" class="kb-item__cat">{{ e.category }}</span>
                    <span
                        v-for="t in e.tags || []"
                        :key="t"
                        class="kb-item__tag"
                        >{{ t }}</span
                    >
                </div>
                <div class="kb-item__actions">
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        @click="openEdit(e)"
                    >
                        编辑
                    </button>
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm btn--danger"
                        @click="remove(e)"
                    >
                        删除
                    </button>
                </div>
            </li>
            <!-- 远程源 -->
            <li v-for="e in remoteSources" :key="e.id" class="kb-item" :class="{ 'kb-item--disabled': !e.enabled }">
                <div class="kb-item__main">
                    <span class="kb-item__title">🔗 {{ e.name }}</span>
                    <span class="kb-item__content">{{ e.url }} ({{ e.sourceType }})</span>
                    <span class="kb-item__tag">{{ e.enabled ? '已启用' : '已禁用' }}</span>
                </div>
                <div class="kb-item__actions">
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        @click="toggleRemote(e)"
                    >
                        {{ e.enabled ? '禁用' : '启用' }}
                    </button>
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        @click="openEditRemote(e)"
                    >
                        编辑
                    </button>
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm btn--danger"
                        @click="remove(e)"
                    >
                        删除
                    </button>
                </div>
            </li>
        </ul>

        <div class="settings-card__group kb-add">
            <button class="btn btn--import btn--block" @click="openAdd">
                + 添加知识
            </button>
            <button class="btn btn--secondary btn--block" @click="openAddRemote" style="margin-top: 8px;">
                🔗 添加远程源
            </button>
        </div>

        <!-- 编辑弹层 -->
        <div
            v-if="showEditor && editing"
            class="kb-modal"
            @click.self="showEditor = false"
        >
            <div class="kb-modal__panel">
                <h4>{{ editing.id ? "编辑知识" : "添加知识" }}</h4>
                <label class="field">
                    <span class="field-label">标题</span>
                    <input
                        v-model="editing.title"
                        class="text-input"
                        placeholder="例如：英梨梨的正确出处"
                    />
                </label>
                <label class="field">
                    <span class="field-label">内容</span>
                    <textarea
                        v-model="editing.content"
                        class="text-input"
                        rows="4"
                        placeholder="你要让桌宠记住的事实，例如：英梨梨是《路人女主的养成方法》里的泽村·斯宾塞·英梨梨，金发双马尾宅女画师，不是《New Game!》的角色。"
                        style="resize: vertical; padding-top: 10px; padding-bottom: 10px"
                    />
                </label>
                <label class="field">
                    <span class="field-label">分类（可选）</span>
                    <input
                        v-model="editing.category"
                        class="text-input"
                        placeholder="例如：ACGN / 化学 / 历史"
                    />
                </label>
                <label class="field">
                    <span class="field-label">标签（可选，逗号分隔）</span>
                    <input
                        v-model="editing.tagsText"
                        class="text-input"
                        placeholder="例如：角色, 动漫"
                    />
                </label>
                <div class="btn-row">
                    <button
                        type="button"
                        class="btn btn--ghost"
                        @click="showEditor = false"
                    >
                        取消
                    </button>
                    <button type="button" class="btn btn--primary" @click="save">
                        保存
                    </button>
                </div>
            </div>
        </div>

        <!-- 远程源编辑器 -->
        <div
            v-if="showRemoteEditor && editingRemote"
            class="kb-modal"
            @click.self="showRemoteEditor = false"
        >
            <div class="kb-modal__panel">
                <h4>{{ editingRemote.id ? '编辑远程源' : '添加远程源' }}</h4>
                <label class="field">
                    <span class="field-label">名称</span>
                    <input
                        v-model="editingRemote.name"
                        class="text-input"
                        placeholder="我的博客"
                    />
                </label>
                <label class="field">
                    <span class="field-label">URL</span>
                    <input
                        v-model="editingRemote.url"
                        class="text-input"
                        placeholder="https://my.wiki.com/api.php"
                    />
                </label>
                <label class="field">
                    <span class="field-label">类型</span>
                    <select v-model="editingRemote.sourceType" class="text-input">
                        <option value="mediawiki">MediaWiki (维基百科等)</option>
                        <option value="markdown">Markdown 文件</option>
                        <option value="html">HTML 页面</option>
                        <option value="rss">RSS Feed</option>
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">优先级（数字越小越高）</span>
                    <input
                        v-model.number="editingRemote.priority"
                        type="number"
                        class="text-input"
                        placeholder="6"
                    />
                </label>
                <label class="field">
                    <input v-model="editingRemote.enabled" type="checkbox" />
                    <span class="field-label">启用</span>
                </label>
                <p class="settings-hint">
                    远程源在检索时实时抓取（不存本地副本）。超时 3 秒自动跳过。
                </p>
                <div class="btn-row">
                    <button
                        type="button"
                        class="btn btn--ghost"
                        @click="showRemoteEditor = false"
                    >
                        取消
                    </button>
                    <button type="button" class="btn btn--primary" @click="saveRemote">
                        保存
                    </button>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.kb-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.kb-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--pet-accent-soft);
    border: 1px dashed var(--pet-accent-strong-border);
}
.kb-item--disabled {
    opacity: 0.5;
}
.kb-item__main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}
.kb-item__title {
    font-weight: 700;
    font-size: 13.5px;
    color: var(--pet-ink);
}
.kb-item__content {
    font-size: 12.5px;
    color: var(--pet-muted);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
}
.kb-item__cat {
    align-self: flex-start;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: rgba(99, 102, 241, 0.12);
    color: #6366f1;
    font-weight: 700;
}
.kb-item__tag {
    display: inline-block;
    margin-right: 6px;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: rgba(22, 163, 74, 0.1);
    color: #16a34a;
    font-weight: 700;
}
.kb-item__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
}

/* 宽窗口（视口 ≥ 860px）：列表限宽 760 居中，避免 item 被拉成丝带 */
@media (min-width: 860px) {
    .kb-list {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        gap: 14px;
    }
    .kb-item {
        padding: 18px 24px;
        border-radius: 16px;
    }
}

.btn--danger {
    color: var(--pet-danger);
    border-color: rgba(243, 18, 96, 0.3);
    background: rgba(243, 18, 96, 0.05);
}
.btn--danger:not(:disabled):hover {
    background: rgba(243, 18, 96, 0.12);
}

.kb-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}
.kb-modal__panel {
    width: 480px;
    max-width: 92vw;
    max-height: 88vh;
    overflow: auto;
    background: var(--pet-surface-strong);
    border: 1px solid var(--pet-border);
    border-radius: 18px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.2);
}
.kb-modal__panel h4 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 800;
    color: var(--pet-ink);
}
</style>
