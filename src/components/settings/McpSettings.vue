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
    <section id="mcp" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🔌</span>
            <span>MCP 服务器</span>
        </h3>
        <p class="settings-card__desc">
            连接 MCP（Model Context Protocol）服务器，把它们的工具暴露给后端模型调用。支持 HTTP
            (streamable) 与 stdio 两种传输方式。启用中的服务器会在连接时自动把工具注册到桌宠。
        </p>

        <div v-if="loading" class="settings-card__group">
            <span class="settings-hint">加载中…</span>
        </div>
        <div v-else-if="servers.length === 0" class="settings-card__group">
            <span class="settings-hint">尚未添加任何 MCP 服务器，点击下方按钮开始接入。</span>
        </div>

        <ul v-else class="mcp-list">
            <li v-for="s in servers" :key="s.id" class="mcp-item">
                <div class="mcp-item__main">
                    <span class="mcp-item__name">{{ s.name }}</span>
                    <span class="mcp-item__tag">{{ s.transport }}</span>
                    <span class="mcp-item__endpoint">
                        {{ s.transport === "http" ? s.url : s.command }}
                    </span>
                </div>
                <div class="mcp-item__actions">
                    <label class="switch" :aria-label="`启用 ${s.name}`">
                        <input type="checkbox" :checked="s.enabled" @change="toggle(s)" />
                        <span class="switch__slider"></span>
                    </label>
                    <button type="button" class="btn btn--ghost btn--sm" @click="openEdit(s)">
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

        <div class="settings-card__group mcp-add">
            <button class="btn btn--import btn--block" @click="openAdd">
                + 添加 MCP 服务器
            </button>
        </div>

        <!-- 编辑弹层 -->
        <div
            v-if="showEditor && editing"
            class="mcp-modal"
            @click.self="showEditor = false"
        >
            <div class="mcp-modal__panel">
                <h4>编辑 MCP 服务器</h4>
                <label class="field">
                    <span class="field-label">名称</span>
                    <input
                        v-model="editing.name"
                        class="text-input"
                        placeholder="例如：本地文件系统"
                    />
                </label>
                <label class="field">
                    <span class="field-label">传输方式</span>
                    <select v-model="editing.transport" class="settings-select">
                        <option value="http">HTTP (streamable)</option>
                        <option value="stdio">stdio（本地命令）</option>
                    </select>
                </label>
                <template v-if="editing.transport === 'http'">
                    <label class="field">
                        <span class="field-label">端点 URL</span>
                        <input
                            v-model="editing.url"
                            class="text-input"
                            placeholder="https://example.com/mcp"
                        />
                    </label>
                </template>
                <template v-else>
                    <label class="field">
                        <span class="field-label">命令</span>
                        <input v-model="editing.command" class="text-input" placeholder="npx" />
                    </label>
                    <label class="field">
                        <span class="field-label">参数（逗号分隔）</span>
                        <input
                            v-model="editing.argsStr"
                            class="text-input"
                            placeholder="-y, some-mcp-server"
                        />
                    </label>
                </template>
                <label class="checkbox-row">
                    <input type="checkbox" v-model="editing.enabled" />
                    <span>启用（启动时注册其工具）</span>
                </label>
                <div class="btn-row">
                    <button type="button" class="btn btn--ghost" @click="showEditor = false">
                        取消
                    </button>
                    <button type="button" class="btn btn--primary" @click="save">保存</button>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
/* 基础样式：窄窗口（视口 < 860px）沿用原样，不做任何改动 */
.mcp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.mcp-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--pet-accent-soft);
    border: 1px dashed var(--pet-accent-strong-border);
}
.mcp-item__main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
}
.mcp-item__name {
    font-weight: 700;
    font-size: 13.5px;
    color: var(--pet-ink);
}
.mcp-item__tag {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: rgba(91, 141, 239, 0.12);
    color: #3b5bdb;
    font-weight: 700;
    text-transform: lowercase;
    letter-spacing: 0.3px;
}
.mcp-item__endpoint {
    font-size: 12px;
    color: var(--pet-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.mcp-item__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
}
/* 宽窗口（视口 ≥ 860px）：限宽 760 居中 + 加大 item 内边距，与技能 tab 一致 */
@media (min-width: 860px) {
    .mcp-list {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        gap: 14px;
    }
    .mcp-item {
        padding: 18px 24px;
        gap: 16px;
        border-radius: 16px;
    }
    .mcp-item__main { gap: 10px; }
    .mcp-item__name,
    .mcp-item__tag { flex: 0 0 auto; }
    .mcp-item__endpoint {
        white-space: normal;
        line-height: 1.5;
        max-width: 380px;
        flex: 1 1 220px;
    }
    .mcp-item__actions { gap: 10px; }
}
.btn--danger {
    color: var(--pet-danger);
    border-color: rgba(243, 18, 96, 0.3);
    background: rgba(243, 18, 96, 0.05);
}
.btn--danger:not(:disabled):hover {
    background: rgba(243, 18, 96, 0.12);
}

/* 弹层（表单，保留居中卡片） */
.mcp-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}
.mcp-modal__panel {
    width: 460px;
    max-width: 90vw;
    background: var(--pet-surface-strong);
    border: 1px solid var(--pet-border);
    border-radius: 18px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.2);
}
.mcp-modal__panel h4 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 800;
    color: var(--pet-ink);
}
</style>
