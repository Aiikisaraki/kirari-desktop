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
  editing.value = { id: genId(), name: "", description: "", enabled: true, prompt: "", tools: [] };
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
  <section class="settings-section">
    <h3 class="settings-section__title">🧩 技能（Skill）</h3>
    <p class="settings-section__desc">
      技能既可以是「行为模板」（注入模型系统指令，调整桌宠的语气/人设），也可以绑定「可调用工具」
      （如 HTTP 接口）。启用中的技能会在对话时生效，其工具会被注册到后端供模型调用。
    </p>

    <div v-if="loading" class="skill-empty">加载中…</div>
    <div v-else-if="skills.length === 0" class="skill-empty">尚未添加任何技能。</div>

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
          <label class="switch">
            <input type="checkbox" :checked="s.enabled" @change="toggle(s)" />
            <span class="switch__slider"></span>
          </label>
          <button class="btn-ghost" @click="openEdit(s)">编辑</button>
          <button class="btn-ghost btn-danger" @click="remove(s)">删除</button>
        </div>
      </li>
    </ul>

    <button class="btn-primary" @click="openAdd">+ 添加技能</button>

    <div v-if="showEditor && editing" class="skill-modal" @click.self="showEditor = false">
      <div class="skill-modal__panel">
        <h4>编辑技能</h4>
        <label class="field">
          <span>名称</span>
          <input v-model="editing.name" placeholder="例如：贴心助手" />
        </label>
        <label class="field">
          <span>描述</span>
          <input v-model="editing.description" placeholder="一句话说明这个技能的作用" />
        </label>
        <label class="field">
          <span>行为模板（注入系统指令）</span>
          <textarea v-model="editing.prompt" rows="4" placeholder="例如：你是一只温柔的桌宠，回答简洁友好…"></textarea>
        </label>
        <label class="field field--inline">
          <input type="checkbox" v-model="editing.enabled" />
          <span>启用该技能</span>
        </label>
        <p class="skill-hint">
          工具（可选）：当前内置示例技能已包含一个「回显」工具。如需自定义 HTTP 工具，可在
          <code>skills.json</code> 中手动添加 <code>tools</code> 字段。
        </p>
        <div class="skill-modal__actions">
          <button class="btn-ghost" @click="showEditor = false">取消</button>
          <button class="btn-primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-section { padding: 4px 0; }
.settings-section__title { margin: 0 0 6px; font-size: 15px; }
.settings-section__desc { margin: 0 0 14px; font-size: 12.5px; color: var(--text-2, #9aa0a6); line-height: 1.6; }
.skill-empty { font-size: 13px; color: var(--text-2, #9aa0a6); padding: 8px 0 14px; }
.skill-list { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.skill-item {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--panel-2, #f3f4f6); border-radius: 10px; padding: 10px 12px;
}
.skill-item__main { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.skill-item__name { font-weight: 600; font-size: 13.5px; }
.skill-item__desc { font-size: 11.5px; color: var(--text-2, #9aa0a6); }
.skill-item__tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #e6fcf5; color: #0ca678; }
.skill-item__actions { display: flex; align-items: center; gap: 8px; }
.btn-ghost {
  border: 1px solid var(--border, #dcdce3); background: transparent; color: var(--text, #333);
  border-radius: 8px; padding: 4px 10px; font-size: 12.5px; cursor: pointer;
}
.btn-danger { color: #e03131; border-color: #ffc9c9; }
.btn-primary {
  background: var(--accent, #5b6cff); color: #fff; border: none; border-radius: 8px;
  padding: 7px 14px; font-size: 13px; cursor: pointer;
}
.switch { position: relative; display: inline-block; width: 38px; height: 20px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch__slider { position: absolute; inset: 0; background: #cfcfd6; border-radius: 999px; transition: .2s; }
.switch input:checked + .switch__slider { background: var(--accent, #5b6cff); }
.skill-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex;
  align-items: center; justify-content: center; z-index: 50;
}
.skill-modal__panel {
  width: 460px; max-width: 90vw; background: var(--panel, #fff); border-radius: 14px;
  padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;
}
.skill-modal__panel h4 { margin: 0 0 4px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.field > span { color: var(--text-2, #9aa0a6); }
.field input, .field textarea, .field select {
  border: 1px solid var(--border, #dcdce3); border-radius: 8px; padding: 6px 9px; font-size: 13px;
  font-family: inherit; resize: vertical;
}
.field--inline { flex-direction: row; align-items: center; gap: 6px; }
.skill-hint { font-size: 11.5px; color: var(--text-2, #9aa0a6); line-height: 1.5; margin: 0; }
.skill-hint code { background: var(--panel-2, #f3f4f6); padding: 1px 5px; border-radius: 4px; }
.skill-modal__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
</style>
