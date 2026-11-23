<script setup lang="ts">
/**
 * 语音：音色库下载与管理。
 *
 * 这个页面是**路线 A**的扩展设置页 —— 页体内置在宿主里，只有当语音扩展包
 * （manifest 里声明了 speech.tts 服务）已安装时才出现在导航中。
 * 判断逻辑在 SettingsPage.vue（启动时拉 ext:installed 过滤 sections）。
 *
 * 页面职责：列出可用音色库（内置清单 + 手动放置）、下载、删除、打开目录。
 * 真正的下载/删除逻辑在主进程 voiceLibrary.ts（多源回退、原子落地）。
 */
import { onMounted, ref } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

interface VoiceLib {
    id: string;
    name: string;
    sizeBytes: number;
    license: string;
    description: string;
    installed: boolean;
    installedBytes?: number;
    manual?: boolean;
}

const libs = ref<VoiceLib[]>([]);
const loading = ref(true);
const busyId = ref(""); // 正在下载/删除的库
const errorMsg = ref("");
const progress = ref<Record<string, string>>({});
let progressTimer: ReturnType<typeof setInterval> | undefined;

function getExtApi() {
    return (window as unknown as { extApi?: ExtApi }).extApi;
}

interface ExtApi {
    listInstalledPacks?: () => Promise<{ ok: boolean; packs?: { packId: string }[] }>;
    voiceListLibs?: () => Promise<{ ok: boolean; libs?: VoiceLib[]; error?: string }>;
    voiceDownload?: (libId: string) => Promise<{ ok: boolean; error?: string }>;
    voiceRemove?: (libId: string) => Promise<{ ok: boolean; error?: string }>;
    voiceProgress?: () => Promise<{ progress: string }>;
    voiceOpenFolder?: () => Promise<{ ok: boolean; error?: string }>;
}

async function refresh() {
    try {
        const res = await getExtApi()?.voiceListLibs?.();
        if (res?.ok && res.libs) libs.value = res.libs;
        else errorMsg.value = res?.error || "读取音色库列表失败";
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

/** 下载是长任务：轮询主进程的进度消息，落到对应行。 */
function startProgressPolling(libId: string) {
    busyId.value = libId;
    progress.value[libId] = "准备下载…";
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(async () => {
        const res = await getExtApi()?.voiceProgress?.();
        if (res?.progress) progress.value[libId] = res.progress;
    }, 600);
}

function stopProgressPolling() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
    busyId.value = "";
}

async function handleDownload(lib: VoiceLib) {
    errorMsg.value = "";
    startProgressPolling(lib.id);
    try {
        const res = await getExtApi()?.voiceDownload?.(lib.id);
        if (res?.ok) emit("saved", `「${lib.name}」下载完成`);
        else errorMsg.value = res?.error || "下载失败";
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e);
    } finally {
        stopProgressPolling();
        await refresh();
    }
}

async function handleRemove(lib: VoiceLib) {
    if (!window.confirm(`删掉音色库「${lib.name}」？删了可以重新下载。`)) return;
    errorMsg.value = "";
    try {
        const res = await getExtApi()?.voiceRemove?.(lib.id);
        if (res?.ok) emit("saved", "音色库已删除");
        else errorMsg.value = res?.error || "删除失败";
    } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e);
    } finally {
        await refresh();
    }
}

async function handleOpenFolder() {
    const res = await getExtApi()?.voiceOpenFolder?.();
    if (res && !res.ok) errorMsg.value = res.error || "打开目录失败";
}

function formatSize(bytes?: number): string {
    if (!bytes) return "";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

onMounted(refresh);
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">音色库</h2>
                    <p class="sk-card__desc">
                        音色库在本机运行：合成不联网、不上传任何聊天内容。下载一次永久使用。
                    </p>
                </div>
                <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="handleOpenFolder">
                    <SettingsIcon name="folder" />
                    打开目录
                </button>
            </div>

            <p class="sk-hint" style="margin-top: 10px">
                也可以把解压好的音色目录直接放进上面的文件夹，这里会自动识别。
            </p>

            <p v-if="loading" class="sk-empty">正在读取音色库列表…</p>

            <div v-else-if="libs.length" class="sk-card__body sk-list">
                <div v-for="lib in libs" :key="lib.id" class="sk-row">
                    <div class="sk-row__main">
                        <div>
                            <h3 class="sk-row__title">
                                {{ lib.name }}
                                <span class="sk-badge" :class="lib.installed ? 'sk-badge--ok' : ''">
                                    <span class="sk-dot" />{{ lib.installed ? "已安装" : "未安装" }}
                                </span>
                            </h3>
                            <p class="sk-row__desc">
                                {{ lib.description }}
                                <template v-if="lib.installed && lib.installedBytes">
                                    · 已占 {{ formatSize(lib.installedBytes) }}
                                </template>
                                <template v-else-if="lib.sizeBytes"> · 下载约 {{ formatSize(lib.sizeBytes) }}</template>
                            </p>
                            <p v-if="lib.license" class="sk-row__desc sk-muted">{{ lib.license }}</p>
                            <p v-if="busyId === lib.id && progress[lib.id]" class="sk-row__desc">
                                {{ progress[lib.id] }}
                            </p>
                        </div>
                    </div>
                    <div class="sk-row__control">
                        <button
                            v-if="!lib.installed"
                            type="button"
                            class="sk-btn sk-btn--primary sk-btn--sm"
                            :disabled="!!busyId"
                            @click="handleDownload(lib)"
                        >
                            <SettingsIcon name="upload" />
                            下载
                        </button>
                        <button
                            v-else
                            type="button"
                            class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger"
                            :disabled="!!busyId"
                            @click="handleRemove(lib)"
                        >
                            <SettingsIcon name="trash" />
                            删除
                        </button>
                    </div>
                </div>
            </div>
            <p v-else class="sk-empty">没有可用的音色库。</p>

            <p v-if="errorMsg" class="sk-alert sk-alert--error">
                <SettingsIcon name="alert" />
                <span>{{ errorMsg }}</span>
            </p>
        </div>
    </section>
</template>
