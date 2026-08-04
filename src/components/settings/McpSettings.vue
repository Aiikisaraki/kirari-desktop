<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useToast } from "../../composables/useToast";

interface McpServer {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  argsStr?: string;
  enabled: boolean;
}

const toast = useToast();
const servers = ref<McpServer[]>([]);
const loading = ref(false);
const showEditor = ref(false);
const editing = ref<McpServer | null>(null);

function genId() {
  return "mcp-" + Math.random().toString(36).slice(2, 9);
}

async function load() {
  loading.value = true;
  try {
    const list = (await (window as any).mcpApi.list()) as McpServer[];
    servers.value = Array.isArray(list) ? list : [];
  } catch (e) {
    toast.error("读取 MCP 配置失败");
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  editing.value = { id: genId(), name: "", transport: "http", url: "", enabled: true };
  showEditor.value = true;
}

function openEdit(s: McpServer) {
  editing.value = JSON.parse(JSON.stringify(s));
  showEditor.value = true;
}

async function save() {
  if (!editing.value) return;
  if (!editing.value.name.trim()) {
    toast.error("请填写名称");
    return;
  }
  const idx = servers.value.findIndex((x) => x.id === editing.value!.id);
  const toSave: McpServer = { ...editing.value };
  // stdio 型：把逗号分隔的参数串转为数组
  if (toSave.transport === "stdio" && typeof toSave.argsStr === "string") {
    toSave.args = toSave.argsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  delete (toSave as any).argsStr;
  if (idx >= 0) servers.value[idx] = toSave;
  else servers.value.push(toSave);
  await persist();
  showEditor.value = false;
}

async function remove(s: McpServer) {
  servers.value = servers.value.filter((x) => x.id !== s.id);
  await persist();
}

async function toggle(s: McpServer) {
  s.enabled = !s.enabled;
  await persist();
}

async function persist() {
  try {
    await (window as any).mcpApi.save(servers.value);
    toast.success("MCP 配置已保存，工具已重新注册到后端");
  } catch (e) {
    toast.error("保存失败");
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-section">
    <h3 class="settings-section__title">🔌 MCP 服务器</h3>
    <p class="settings-section__desc">
      连接 MCP（Model Context Protocol）服务器，把它们的工具暴露给后端模型调用。支持 HTTP
      (streamable) 与 stdio 两种传输方式。启用中的服务器会在连接时自动把工具注册到桌宠。
    </p>

    <div v-if="loading" class="mcp-empty">加载中…</div>
    <div v-else-if="servers.length === 0" class="mcp-empty">尚未添加任何 MCP 服务器。</div>

    <ul v-else class="mcp-list">
      <li v-for="s in servers" :key="s.id" class="mcp-item">
        <div class="mcp-item__main">
          <span class="mcp-item__name">{{ s.name }}</span>
          <span class="mcp-item__tag">{{ s.transport }}</span>
          <span class="mcp-item__endpoint">{{ s.transport === "http" ? s.url : s.command }}</span>
        </div>
        <div class="mcp-item__actions">
          <label class="switch">
            <input type="checkbox" :checked="s.enabled" @change="toggle(s)" />
            <span class="switch__slider"></span>
          </label>
          <button class="btn-ghost" @click="openEdit(s)">编辑</button>
          <button class="btn-ghost btn-danger" @click="remove(s)">删除</button>
        </div>
      </li>
    </ul>

    <button class="btn-primary" @click="openAdd">+ 添加 MCP 服务器</button>

    <!-- 编辑弹层 -->
    <div v-if="showEditor && editing" class="mcp-modal" @click.self="showEditor = false">
      <div class="mcp-modal__panel">
        <h4>编辑 MCP 服务器</h4>
        <label class="field">
          <span>名称</span>
          <input v-model="editing.name" placeholder="例如：本地文件系统" />
        </label>
        <label class="field">
          <span>传输方式</span>
          <select v-model="editing.transport">
            <option value="http">HTTP (streamable)</option>
            <option value="stdio">stdio（本地命令）</option>
          </select>
        </label>
        <template v-if="editing.transport === 'http'">
          <label class="field">
            <span>端点 URL</span>
            <input v-model="editing.url" placeholder="https://example.com/mcp" />
          </label>
        </template>
        <template v-else>
          <label class="field">
            <span>命令</span>
            <input v-model="editing.command" placeholder="npx" />
          </label>
          <label class="field">
            <span>参数（逗号分隔）</span>
            <input v-model="editing.argsStr" placeholder="-y, some-mcp-server" />
          </label>
        </template>
        <label class="field field--inline">
          <input type="checkbox" v-model="editing.enabled" />
          <span>启用（启动时注册其工具）</span>
        </label>
        <div class="mcp-modal__actions">
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
.mcp-empty { font-size: 13px; color: var(--text-2, #9aa0a6); padding: 8px 0 14px; }
.mcp-list { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.mcp-item {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--panel-2, #f3f4f6); border-radius: 10px; padding: 10px 12px;
}
.mcp-item__main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mcp-item__name { font-weight: 600; font-size: 13.5px; }
.mcp-item__tag {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: #e3e8ff; color: #3b5bdb;
}
.mcp-item__endpoint {
  font-size: 11.5px; color: var(--text-2, #9aa0a6);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px;
}
.mcp-item__actions { display: flex; align-items: center; gap: 8px; }
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
.switch__slider {
  position: absolute; inset: 0; background: #cfcfd6; border-radius: 999px; transition: .2s;
}
.switch input:checked + .switch__slider { background: var(--accent, #5b6cff); }
.mcp-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex;
  align-items: center; justify-content: center; z-index: 50;
}
.mcp-modal__panel {
  width: 420px; max-width: 90vw; background: var(--panel, #fff); border-radius: 14px;
  padding: 18px 20px; display: flex; flex-direction: column; gap: 10px;
}
.mcp-modal__panel h4 { margin: 0 0 4px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.field > span { color: var(--text-2, #9aa0a6); }
.field input, .field select {
  border: 1px solid var(--border, #dcdce3); border-radius: 8px; padding: 6px 9px; font-size: 13px;
}
.field--inline { flex-direction: row; align-items: center; gap: 6px; }
.mcp-modal__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
</style>
