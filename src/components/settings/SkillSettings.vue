<script setup lang="ts">
import { ref, onMounted } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

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

const emit = defineEmits<{ saved: [msg?: string] }>();
const errorMsg = ref("");
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
        errorMsg.value = "读取技能配置失败";
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
        errorMsg.value = "请填写技能名称";
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
        errorMsg.value = "";
        emit("saved", "技能配置已保存");
    } catch (e) {
        errorMsg.value = "保存失败";
    }
}

onMounted(load);
</script>

<template>
    <section class="sk-page"><div class="sk-card">
        <div class="sk-card__head"><div><h2 class="sk-card__title">技能</h2><p class="sk-card__desc">行为模板可以设定她的语气和职责；技能也可以包含可调用工具。启用后会在对话中生效。</p></div></div>
        <div class="sk-card__body"><p v-if="loading" class="sk-empty">正在读取技能…</p><p v-else-if="skills.length === 0" class="sk-empty">还没有技能，可以先添加一个行为模板。</p>
            <div v-else class="sk-items"><article v-for="s in skills" :key="s.id" class="sk-item" :class="{ 'is-muted': !s.enabled }"><div class="sk-item__main"><div class="sk-item__title">{{ s.name }}<span v-if="s.prompt" class="sk-badge sk-badge--brand">行为模板</span><span v-if="s.tools?.length" class="sk-badge">{{ s.tools.length }} 个工具</span><span v-if="!s.enabled" class="sk-badge">已停用</span></div><p class="sk-item__meta">{{ s.description || "（还没有说明这个技能做什么）" }}</p></div>
                <div class="sk-item__ops"><label class="sk-switch" :aria-label="'启用 ' + s.name"><input type="checkbox" :checked="s.enabled" @change="toggle(s)" /><span class="sk-switch__track" /></label><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="openEdit(s)"><SettingsIcon name="edit" /> 编辑</button><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="remove(s)"><SettingsIcon name="trash" /> 删除</button></div></article></div>
        </div>
        <p v-if="errorMsg" class="sk-alert sk-alert--error"><SettingsIcon name="alert" /><span>{{ errorMsg }}</span></p>
        <div v-if="showEditor && editing" class="sk-editor"><h3 class="sk-editor__title">{{ skills.some((s) => s.id === editing!.id) ? "编辑技能" : "添加技能" }}</h3><div class="sk-grid">
            <div class="sk-field"><label class="sk-field__label" for="skill-name">名称</label><input id="skill-name" v-model="editing.name" class="sk-input" placeholder="例如：贴心助手" /></div><div class="sk-field"><label class="sk-field__label" for="skill-desc">描述</label><input id="skill-desc" v-model="editing.description" class="sk-input" placeholder="一句话说明这个技能的作用" /></div>
        </div><div class="sk-field"><label class="sk-field__label" for="skill-prompt">行为模板</label><textarea id="skill-prompt" v-model="editing.prompt" class="sk-textarea" rows="4" placeholder="例如：你是一只温柔的桌宠，回答简洁友好…" /></div>
        <label class="sk-check"><input type="checkbox" v-model="editing.enabled" /><span>启用该技能</span></label><p class="sk-hint">工具（可选）：内置示例已包含一个「回显」工具。如需自定义 HTTP 工具，可在技能配置文件中手动扩展。</p>
        <div class="sk-editor__foot"><button type="button" class="sk-btn sk-btn--primary" @click="save">保存</button><button type="button" class="sk-btn sk-btn--ghost" @click="showEditor = false">取消</button></div></div>
        <div v-else class="sk-card__foot"><button type="button" class="sk-btn sk-btn--primary" @click="openAdd"><SettingsIcon name="plus" /> 添加技能</button></div>
    </div></section>
</template>
