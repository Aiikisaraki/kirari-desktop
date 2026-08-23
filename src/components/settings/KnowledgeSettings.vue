<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import { useToast } from "../../composables/useToast";

interface KbEntry {
    id: number;
    title: string;
    content: string;
    category?: string | null;
    tags?: string[];
    source?: string | null;
}

const { request } = useApiToken();
const toast = useToast();

const entries = ref<KbEntry[]>([]);
const loading = ref(false);
const showEditor = ref(false);
const editing = ref<{
    id?: number;
    title: string;
    content: string;
    category: string;
    tagsText: string;
}>({ title: "", content: "", category: "", tagsText: "" });

async function load() {
    loading.value = true;
    try {
        const data = (await request("GET", "/api/knowledge", {})) as {
            entries: KbEntry[];
        };
        entries.value = Array.isArray(data.entries) ? data.entries : [];
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

function openEdit(e: KbEntry) {
    editing.value = {
        id: e.id,
        title: e.title,
        content: e.content,
        category: e.category ?? "",
        tagsText: Array.isArray(e.tags) ? e.tags.join(", ") : "",
    };
    showEditor.value = true;
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
        await request("POST", "/api/knowledge", {
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

async function remove(e: KbEntry) {
    try {
        await request("DELETE", "/api/knowledge", { id: e.id });
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
            <li v-for="e in entries" :key="e.id" class="kb-item">
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
        </ul>

        <div class="settings-card__group kb-add">
            <button class="btn btn--import btn--block" @click="openAdd">
                + 添加知识
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
