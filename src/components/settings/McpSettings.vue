<script setup lang="ts">
import { ref, onMounted } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

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

const emit = defineEmits<{ saved: [msg?: string] }>();
const errorMsg = ref("");
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
        errorMsg.value = "读取 MCP 配置失败";
    } finally {
        loading.value = false;
    }
}

function openAdd() {
    editing.value = { id: genId(), name: "", transport: "http", url: "", enabled: true };
    showEditor.value = true;
}

function openEdit(s: McpServer) {
    editing.value = { ...JSON.parse(JSON.stringify(s)), argsStr: (s.args || []).join(", ") };
    errorMsg.value = "";
    showEditor.value = true;
}

async function save() {
    if (!editing.value) return;
    if (!editing.value.name.trim()) {
        errorMsg.value = "请填写名称";
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
        errorMsg.value = "";
        emit("saved", "MCP 配置已保存，工具已更新");
    } catch (e) {
        errorMsg.value = "保存失败";
    }
}

onMounted(load);
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head"><div><h2 class="sk-card__title">工具服务</h2><p class="sk-card__desc">连接外部 MCP 服务，使用它们提供的工具。支持 HTTP 服务地址与本地命令两种接入方式。</p></div></div>
            <div class="sk-card__body">
                <p v-if="loading" class="sk-empty">正在读取工具服务…</p>
                <p v-else-if="servers.length === 0" class="sk-empty">还没有接入工具服务。</p>
                <div v-else class="sk-items">
                    <article v-for="s in servers" :key="s.id" class="sk-item" :class="{ 'is-muted': !s.enabled }">
                        <div class="sk-item__main"><div class="sk-item__title">{{ s.name }} <span class="sk-badge sk-badge--brand">{{ s.transport === "http" ? "HTTP" : "本地命令" }}</span><span v-if="!s.enabled" class="sk-badge">已停用</span></div><p class="sk-item__meta sk-item__meta--mono">{{ s.transport === "http" ? s.url : [s.command, ...(s.args || [])].filter(Boolean).join(" ") }}</p></div>
                        <div class="sk-item__ops"><label class="sk-switch" :aria-label="'启用 ' + s.name"><input type="checkbox" :checked="s.enabled" @change="toggle(s)" /><span class="sk-switch__track" /></label><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="openEdit(s)"><SettingsIcon name="edit" /> 编辑</button><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="remove(s)"><SettingsIcon name="trash" /> 删除</button></div>
                    </article>
                </div>
            </div>
            <p v-if="errorMsg" class="sk-alert sk-alert--error"><SettingsIcon name="alert" /><span>{{ errorMsg }}</span></p>
            <div v-if="showEditor && editing" class="sk-editor"><h3 class="sk-editor__title">{{ editing.name ? "编辑工具服务" : "添加工具服务" }}</h3>
                <div class="sk-field"><span class="sk-field__label">连接方式</span><div class="sk-segmented"><button type="button" class="sk-segmented__item" :class="{ 'is-active': editing.transport === 'http' }" @click="editing.transport = 'http'">HTTP</button><button type="button" class="sk-segmented__item" :class="{ 'is-active': editing.transport === 'stdio' }" @click="editing.transport = 'stdio'">本地命令（stdio）</button></div></div>
                <div class="sk-field"><label class="sk-field__label" for="mcp-name">名称</label><input id="mcp-name" v-model="editing.name" class="sk-input" placeholder="例如：本地文件系统" /></div>
                <template v-if="editing.transport === 'http'"><div class="sk-field"><label class="sk-field__label" for="mcp-url">端点 URL</label><input id="mcp-url" v-model="editing.url" class="sk-input sk-input--mono" placeholder="https://example.com/mcp" /></div></template>
                <template v-else><div class="sk-grid"><div class="sk-field"><label class="sk-field__label" for="mcp-command">命令</label><input id="mcp-command" v-model="editing.command" class="sk-input" placeholder="npx" /></div><div class="sk-field"><label class="sk-field__label" for="mcp-args">参数（逗号分隔）</label><input id="mcp-args" v-model="editing.argsStr" class="sk-input" placeholder="-y, some-mcp-server" /></div></div></template>
                <label class="sk-check"><input type="checkbox" v-model="editing.enabled" /><span>启用（启动时注册其工具）</span></label><div class="sk-editor__foot"><button type="button" class="sk-btn sk-btn--primary" @click="save">保存</button><button type="button" class="sk-btn sk-btn--ghost" @click="showEditor = false">取消</button></div>
            </div>
            <div v-else class="sk-card__foot"><button type="button" class="sk-btn sk-btn--primary" @click="openAdd"><SettingsIcon name="plus" /> 添加工具服务</button></div>
        </div>
    </section>
</template>
