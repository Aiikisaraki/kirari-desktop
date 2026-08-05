<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useChatSocket } from "../../composables/useChatSocket";
import { marked } from "marked";
import DOMPurify from "dompurify";
import WindowChrome from "../common/WindowChrome.vue";
import type { ChatMessage } from "../../stores/chat";

marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
    const rawHtml = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rawHtml);
}

const { connected, messages, lastError, waitingForReply, requestState, sendMessage } =
    useChatSocket();

const draft = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const pendingImages = ref<string[]>([]);
const threadRef = ref<HTMLElement | null>(null);
const petName = ref("Kirari");

/* ===== 时间分隔标记 ===== */
const TIME_SEP_THRESHOLD = 5 * 60 * 1000; // 5 分钟

interface ThreadItem {
    type: "message" | "timestamp";
    key: string;
    message?: ChatMessage;
    timestamp?: number;
}

/** 将消息列表展开为 [消息/时间标记] 混合数组 */
const threadItems = computed<ThreadItem[]>(() => {
    const items: ThreadItem[] = [];
    const msgs = messages.value;
    for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        // 与上一条对比，间隔超过阈值则插入时间标记
        if (i > 0) {
            const diff = msg.timestamp - msgs[i - 1].timestamp;
            if (diff >= TIME_SEP_THRESHOLD) {
                items.push({
                    type: "timestamp",
                    key: `ts-${msg.id}`,
                    timestamp: msg.timestamp,
                });
            }
        }
        items.push({ type: "message", key: msg.id, message: msg });
    }
    return items;
});

/** 格式化时间戳为 HH:mm */
function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

onMounted(() => {
    void requestState();
    void loadPetName();
});

const windowTitle = computed(() => `和 ${petName.value || "Kirari"} 聊天`);
const petNameInitial = computed(() => (petName.value || "K").slice(0, 1).toUpperCase());

async function loadPetName() {
    const w = window as unknown as {
        windowApi?: {
            getPetName?: () => Promise<string>;
            onPetNameChanged?: (cb: (name: string) => void) => void;
        };
        require?: (mod: string) => { ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: (channel: string, listener: (...args: unknown[]) => void) => void } };
    };
    try {
        let name = "Kirari";
        if (w.windowApi?.getPetName) {
            name = String((await w.windowApi.getPetName()) || "Kirari");
        } else if (w.require) {
            name = String((await w.require("electron").ipcRenderer.invoke("pet-name:get")) || "Kirari");
        }
        petName.value = name;
        document.title = windowTitle.value;

        const handler = (next: string) => {
            petName.value = next || "Kirari";
            document.title = windowTitle.value;
        };
        if (w.windowApi?.onPetNameChanged) {
            w.windowApi.onPetNameChanged(handler);
        } else if (w.require) {
            w.require("electron").ipcRenderer.on("pet-name:changed", (_e: unknown, next: unknown) => handler(String(next || "Kirari")));
        }
    } catch {
        // 读取失败则使用默认值
    }
}

async function scrollToLatest() {
    await nextTick();
    threadRef.value?.scrollTo({
        top: threadRef.value.scrollHeight,
        behavior: "smooth",
    });
}

function readImageAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

async function onPickImages(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []).filter((f) => f.type.startsWith("image/"));
    for (const f of files) {
        try {
            pendingImages.value.push(await readImageAsDataUrl(f));
        } catch {
            // 忽略无法读取的图片
        }
    }
    input.value = ""; // 允许再次选择同一文件
}

async function onPaste(event: ClipboardEvent) {
    const items = Array.from(event.clipboardData?.items || []);
    for (const it of items) {
        if (it.type.startsWith("image/")) {
            const file = it.getAsFile();
            if (file) {
                try {
                    pendingImages.value.push(await readImageAsDataUrl(file));
                } catch {
                    // 忽略
                }
            }
        }
    }
}

function removePendingImage(idx: number) {
    pendingImages.value.splice(idx, 1);
}

function sendMessageLocal() {
    const text = draft.value.trim();
    if (!text && pendingImages.value.length === 0) return;
    sendMessage(draft.value, pendingImages.value);
    draft.value = "";
    pendingImages.value = [];
}

function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessageLocal();
    }
}

watch(
    () => messages.value.length,
    async () => {
        await scrollToLatest();
    },
);

const statusState = computed(() => {
    if (connected.value) {
        return { label: "在线", className: "is-online", dot: true };
    }
    if (lastError.value) {
        return { label: "连接异常", className: "is-offline", dot: false };
    }
    return { label: "连接中", className: "is-connecting", dot: true };
});
</script>

<template>
    <div class="app-shell">
        <WindowChrome :title="windowTitle" />
        <main class="chat-window" :aria-label="windowTitle">
            <header class="chat-header">
                <div class="chat-peer">
                    <div class="chat-avatar" aria-hidden="true">{{ petNameInitial }}</div>
                    <div class="chat-peer-info">
                        <div class="chat-peer-name">{{ petName || "Kirari" }}</div>
                        <div class="chat-peer-status" :class="statusState.className">
                            <span class="status-dot" :class="{ pulsing: statusState.dot }"></span>
                            {{ statusState.label }}
                        </div>
                    </div>
                </div>
            </header>

            <!-- 错误横幅：后端明确下发的错误（如“大模型未配置”）在此可见呈现，
                 不再只表现为状态栏的“连接异常”文字。模型修复后收到正常回复会自动消失。 -->
            <div v-if="lastError" class="chat-error-banner" role="alert">
                <span class="chat-error-banner__icon" aria-hidden="true">⚠</span>
                <span class="chat-error-banner__text">{{ lastError }}</span>
            </div>

            <section ref="threadRef" class="chat-thread" aria-live="polite">
                <template v-for="item in threadItems" :key="item.key">
                    <!-- 时间分隔标记 -->
                    <div v-if="item.type === 'timestamp'" class="chat-time-sep">
                        <span class="chat-time-sep__pill">{{ formatTime(item.timestamp!) }}</span>
                    </div>
                    <!-- 消息气泡 -->
                    <article
                        v-else
                        class="chat-message"
                        :class="`is-${item.message!.author}`"
                    >
                        <div class="markdown-body" v-html="renderMarkdown(item.message!.text)"></div>
                        <div
                            v-if="item.message!.images && item.message!.images!.length"
                            class="msg-images"
                        >
                            <a
                                v-for="(img, i) in item.message!.images"
                                :key="i"
                                :href="img"
                                target="_blank"
                                class="msg-image-wrap"
                            >
                                <img :src="img" alt="图片" class="msg-image" loading="lazy" />
                            </a>
                        </div>
                    </article>
                </template>

                <div v-if="waitingForReply" class="chat-waiting" role="status" aria-live="polite">
                    <span class="chat-waiting-dot" aria-hidden="true"></span>
                    <span>{{ petName || "Kirari" }} 正在思考...</span>
                </div>
            </section>

            <div class="composer-area" @paste="onPaste">
                <div v-if="pendingImages.length" class="pending-images">
                    <div v-for="(img, i) in pendingImages" :key="i" class="pending-thumb">
                        <img :src="img" alt="待发送图片" />
                        <button type="button" class="pending-remove" @click="removePendingImage(i)">×</button>
                    </div>
                </div>
                <form class="composer-bar" @submit.prevent="sendMessageLocal">
                    <input
                        ref="fileInput"
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        @change="onPickImages"
                    />
                    <button
                        type="button"
                        class="composer-attach"
                        title="发送图片"
                        aria-label="发送图片"
                        @click="fileInput?.click()"
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                    </button>
                    <input
                        v-model="draft"
                        class="composer-input"
                        type="text"
                        :placeholder="`给 ${petName || 'Kirari'} 发消息…`"
                        autocomplete="off"
                        @keydown="handleKeydown"
                    />
                    <button
                        type="submit"
                        class="composer-send"
                        :disabled="!connected || waitingForReply || (!draft.trim() && !pendingImages.length)"
                        aria-label="发送"
                        title="发送"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13" />
                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                    </button>
                </form>
            </div>
        </main>
    </div>
</template>

<style scoped>
/* ===== 头部：更像聊天 App 的联系人资料 ===== */
.chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--pet-border);
    background: rgba(255, 255, 255, 0.45);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
}

.chat-peer {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.chat-avatar {
    flex: 0 0 auto;
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 18px;
    font-weight: 800;
    color: #ffffff;
    background: linear-gradient(135deg, var(--pet-accent-strong) 0%, var(--pet-accent) 100%);
    box-shadow: 0 4px 12px var(--pet-primary-shadow);
    user-select: none;
}

.chat-peer-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.chat-peer-name {
    font-size: 16px;
    font-weight: 700;
    color: var(--pet-ink);
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.chat-peer-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--pet-muted);
    line-height: 1.3;
}

.chat-peer-status.is-online {
    color: #397051;
}

.chat-peer-status.is-offline {
    color: #8e4553;
}

.chat-peer-status.is-connecting {
    color: #8a5a16;
}

.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.85;
}

.status-dot.pulsing {
    animation: status-pulse 1.6s ease-in-out infinite;
}

@keyframes status-pulse {
    0%,
    100% {
        opacity: 0.55;
        transform: scale(0.92);
    }
    50% {
        opacity: 1;
        transform: scale(1.05);
    }
}

/* ===== 错误横幅：后端明确下发的错误（如大模型未配置） ===== */
.chat-error-banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 8px 12px 2px;
    padding: 9px 12px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.5;
    color: #8e4553;
    background: rgba(214, 110, 130, 0.14);
    border: 1px solid rgba(214, 110, 130, 0.38);
    backdrop-filter: blur(8px) saturate(140%);
    -webkit-backdrop-filter: blur(8px) saturate(140%);
}

.chat-error-banner__icon {
    flex: 0 0 auto;
    font-size: 15px;
    line-height: 1.4;
}

.chat-error-banner__text {
    min-width: 0;
}

/* ===== 底部输入区：圆角工具栏 + 对齐修复 ===== */
.composer-area {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--pet-border);
    background: rgba(255, 255, 255, 0.42);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
}

.composer-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 5px 4px 6px;
    border: 1px solid var(--pet-border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
    box-shadow: 0 4px 14px rgba(57, 44, 76, 0.06);
    transition:
        border-color 160ms ease,
        box-shadow 160ms ease;
}

.composer-bar:focus-within {
    border-color: var(--pet-focus-border);
    box-shadow: 0 0 0 3px var(--pet-focus-ring), 0 4px 14px rgba(57, 44, 76, 0.06);
}

.composer-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--pet-ink);
    font: inherit;
    font-size: 15px;
    line-height: 40px;
    outline: none;
}

.composer-input::placeholder {
    color: var(--pet-muted);
    opacity: 0.75;
}

.composer-attach,
.composer-send {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    transition:
        transform 140ms ease,
        filter 140ms ease,
        opacity 140ms ease;
}

.composer-attach {
    color: var(--pet-muted);
    background: transparent;
}

.composer-attach:hover {
    color: var(--pet-accent);
    background: var(--pet-accent-soft);
}

.composer-send {
    color: #ffffff;
    background: var(--pet-accent);
    box-shadow: 0 4px 12px var(--pet-primary-shadow);
}

.composer-send:not(:disabled):hover {
    filter: brightness(1.06);
    transform: translateY(-1px);
}

.composer-send:not(:disabled):active {
    transform: translateY(0) scale(0.96);
}

.composer-send:disabled {
    opacity: 0.45;
    cursor: default;
}

/* ===== 待发送图片预览 ===== */
.pending-images {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding: 0 2px;
}

.pending-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: rgba(0, 0, 0, 0.04);
}

.pending-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.pending-remove {
    position: absolute;
    top: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    border: 0;
    border-radius: 0 0 0 6px;
    width: 18px;
    height: 18px;
    line-height: 16px;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    transition: background 140ms ease;
}

.pending-remove:hover {
    background: rgba(0, 0, 0, 0.8);
}

/* ===== 消息内图片网格 ===== */
.msg-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
}

.msg-image-wrap {
    display: block;
    max-width: 240px;
}

.msg-image {
    width: 100%;
    border-radius: 8px;
    display: block;
    cursor: zoom-in;
}
</style>
