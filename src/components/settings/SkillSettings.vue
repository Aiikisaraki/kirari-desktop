<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useToast } from "../../composables/useToast";

interface SkillTool {
    name: string;
    description: string;
    parameters: unknown;
    exec: { kind: "http" | "echo"; url?: string; method?: string };
}
interface Skill {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    prompt?: string;
    tools?: SkillTool[];
}

const toast = useToast();
const skills = ref<Skill[]>([]);
const loading = ref(false);
const showEditor = ref(false);
const editing = ref<Skill | null>(null);

function genId() {
    return "skill-" + Math.random().toString(36).slice(2, 9);
}

async function load() {
    loading.value = true;
    try {
        const list = (await (window as any).skillApi.list()) as Skill[];
        skills.value = Array.isArray(list) ? list : [];
    } catch (e) {
        toast.error("读取技能配置失败");
    } finally {
        loading.value = false;
    }
}

function openAdd() {
    editing.value = {
        id: genId(),
        name: "",
        description: "",
        enabled: true,
        prompt: "",
        tools: [],
    };
    showEditor.value = true;
}

function openEdit(s: Skill) {
    editing.value = JSON.parse(JSON.stringify(s));
    showEditor.value = true;
}

async function save() {
    if (!editing.value) return;
    if (!editing.value.name.trim()) {
        toast.error("请填写技能名称");
        return;
    }
    const idx = skills.value.findIndex((x) => x.id === editing.value!.id);
    if (idx >= 0) skills.value[idx] = { ...editing.value };
    else skills.value.push({ ...editing.value });
    await persist();
    showEditor.value = false;
}

async function remove(s: Skill) {
    skills.value = skills.value.filter((x) => x.id !== s.id);
    await persist();
}

async function toggle(s: Skill) {
    s.enabled = !s.enabled;
    await persist();
}

async function persist() {
    try {
        await (window as any).skillApi.save(skills.value);
        toast.success("技能配置已保存");
    } catch (e) {
        toast.error("保存失败");
    }
}

onMounted(load);
</script>

<template>
    <section id="skill" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🧩</span>
            <span>技能</span>
        </h3>
        <p class="settings-card__desc">
            技能既可以是「行为模板」（注入模型系统指令，调整桌宠的语气/人设），也可以绑定「可调用工具」
            （如 HTTP 接口）。启用中的技能会在对话时生效，其工具会被注册到后端供模型调用。
        </p>

        <div v-if="loading" class="settings-card__group">
            <span class="settings-hint">加载中…</span>
        </div>
        <div v-else-if="skills.length === 0" class="settings-card__group">
            <span class="settings-hint">尚未添加任何技能，点击下方按钮开始接入。</span>
        </div>

        <ul v-else class="skill-list">
            <li v-for="s in skills" :key="s.id" class="skill-item">
                <div class="skill-item__main">
                    <span class="skill-item__name">{{ s.name }}</span>
                    <span class="skill-item__desc">{{ s.description }}</span>
                    <span v-if="s.tools && s.tools.length" class="skill-item__tag">
                        {{ s.tools.length }} 个工具
                    </span>
                </div>
                <div class="skill-item__actions">
                    <label class="switch" :aria-label="`启用 ${s.name}`">
                        <input
                            type="checkbox"
                            :checked="s.enabled"
                            @change="toggle(s)"
                        />
                        <span class="switch__slider"></span>
                    </label>
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        @click="openEdit(s)"
                    >
                        编辑
                    </button>
                    <button
                        type="button"
                        class="btn btn--ghost btn--sm btn--danger"
                        @click="remove(s)"
                    >
                        删除
                    </button>
                </div>
            </li>
        </ul>

        <div class="settings-card__group skill-add">
            <button class="btn btn--import btn--block" @click="openAdd">
                + 添加技能
            </button>
        </div>

        <!-- 编辑弹层 -->
        <div
            v-if="showEditor && editing"
            class="skill-modal"
            @click.self="showEditor = false"
        >
            <div class="skill-modal__panel">
                <h4>编辑技能</h4>
                <label class="field">
                    <span class="field-label">名称</span>
                    <input
                        v-model="editing.name"
                        class="text-input"
                        placeholder="例如：贴心助手"
                    />
                </label>
                <label class="field">
                    <span class="field-label">描述</span>
                    <input
                        v-model="editing.description"
                        class="text-input"
                        placeholder="一句话说明这个技能的作用"
                    />
                </label>
                <label class="field">
                    <span class="field-label">行为模板（注入系统指令）</span>
                    <textarea
                        v-model="editing.prompt"
                        class="text-input"
                        rows="4"
                        placeholder="例如：你是一只温柔的桌宠，回答简洁友好…"
                        style="resize: vertical; padding-top: 10px; padding-bottom: 10px"
                    />
                </label>
                <label class="checkbox-row">
                    <input type="checkbox" v-model="editing.enabled" />
                    <span>启用该技能</span>
                </label>
                <p class="settings-hint">
                    工具（可选）：当前内置示例技能已包含一个「回显」工具。如需自定义 HTTP
                    工具，可在 <code>skills.json</code> 中手动添加 <code>tools</code> 字段。
                </p>
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
/* 基础样式：窄窗口（视口 < 860px）沿用你喜欢的原样，不做任何改动 */
.skill-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.skill-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--pet-accent-soft);
    border: 1px dashed var(--pet-accent-strong-border);
}
.skill-item__main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
}
.skill-item__name {
    font-weight: 700;
    font-size: 13.5px;
    color: var(--pet-ink);
}
.skill-item__desc {
    font-size: 12.5px;
    color: var(--pet-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
}
.skill-item__tag {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: rgba(22, 163, 74, 0.1);
    color: #16a34a;
    font-weight: 700;
}
.skill-item__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
}
/* 宽窗口（视口 ≥ 860px）：列表限宽 760 居中 + 加大 item 内边距，
   避免 item 在宽卡里被拉成"丝带"且内边距显得过薄。
   窄窗口完全不进这个 media query，保持原样。 */
@media (min-width: 860px) {
    .skill-list {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        gap: 14px;
    }
    .skill-item {
        padding: 18px 24px;
        gap: 16px;
        border-radius: 16px;
    }
    .skill-item__main { gap: 10px; }
    .skill-item__name,
    .skill-item__tag { flex: 0 0 auto; }
    .skill-item__desc {
        font-size: 13px;
        white-space: normal;
        max-width: 360px;
        flex: 1 1 200px;
        line-height: 1.5;
    }
    .skill-item__actions { gap: 10px; }
}
.btn--danger {
    color: var(--pet-danger);
    border-color: rgba(243, 18, 96, 0.3);
    background: rgba(243, 18, 96, 0.05);
}
.btn--danger:not(:disabled):hover {
    background: rgba(243, 18, 96, 0.12);
}

/* 弹层 */
.skill-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}
.skill-modal__panel {
    width: 480px;
    max-width: 92vw;
    background: var(--pet-surface-strong);
    border: 1px solid var(--pet-border);
    border-radius: 18px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.2);
}
.skill-modal__panel h4 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 800;
    color: var(--pet-ink);
}
</style>
