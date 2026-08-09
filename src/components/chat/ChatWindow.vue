<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useChatSocket } from "../../composables/useChatSocket";
import { renderMarkdownMath } from "../../utils/renderMarkdownMath";
import WindowChrome from "../common/WindowChrome.vue";
import ChatContextMenu from "./ChatContextMenu.vue";
import type { ChatMessage } from "../../stores/chat";

const { connected, messages, lastError, waitingForReply, requestState, sendMessage } =
    useChatSocket();

const draft = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const pendingImages = ref<string[]>([]);
const threadRef = ref<HTMLElement | null>(null);
const petName = ref("Kirari");

/* ===== 工具栏：表情弹层 / 戳一戳 状态 ===== */
const showEmoji = ref(false);
const petPoked = ref(false);
const emojiList = ["😊", "😂", "🥰", "😎", "🤔", "👍", "🎉", "💡", "❤️", "🌟", "🐱", "✨"];

function insertEmoji(e: string) {
    draft.value += e;
    showEmoji.value = false;
}

function pokePet() {
    petPoked.value = true;
    window.setTimeout(() => {
        petPoked.value = false;
    }, 600);
}

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
    showEmoji.value = false;
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

/* ===== 右键菜单：复制文字 / 复制图片 / 图片另存为 ===== */
type ChatWindowApi = {
    saveImageAs: (src: string) => Promise<{ ok: boolean; error?: string; canceled?: boolean }>;
    copyImage: (src: string) => Promise<{ ok: boolean; error?: string }>;
};

function getWindowApi(): ChatWindowApi | undefined {
    return (window as unknown as { windowApi?: ChatWindowApi }).windowApi;
}

interface CtxMenuItem {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}

const ctxMenu = ref<{ x: number; y: number; items: CtxMenuItem[] } | null>(null);

const toast = ref<{ text: string; id: number } | null>(null);
let toastTimer: number | null = null;

function flashToast(text: string) {
    toast.value = { text, id: Date.now() };
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.value = null;
    }, 1800);
}

function openCtxMenu(e: MouseEvent, items: CtxMenuItem[]) {
    if (!items.length) return;
    e.preventDefault();
    const MENU_W = 200;
    const ITEM_H = 38;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - items.length * ITEM_H - 16);
    ctxMenu.value = { x, y, items };
}

/** 右击气泡或图片：按消息内容组装统一的右键菜单（有文字给复制文字，有图片给复制/另存为）。 */
function onBubbleContextMenu(e: MouseEvent, msg: ChatMessage) {
    const items: CtxMenuItem[] = [];
    const text = (msg.text || "").trim();
    if (text) {
        items.push({ label: "复制文字", onClick: () => void copyText(text) });
    }
    const imgs = (msg.images || []).filter((s) => typeof s === "string" && s.trim());
    if (imgs.length === 1) {
        items.push({ label: "复制图片", onClick: () => void copyImage(imgs[0]) });
        items.push({ label: "图片另存为…", onClick: () => void saveImage(imgs[0]) });
    } else if (imgs.length > 1) {
        items.push({ label: "复制图片", onClick: () => void copyImage(imgs[0]) });
        imgs.forEach((img, i) => {
            items.push({ label: `图片 ${i + 1} 另存为…`, onClick: () => void saveImage(img) });
        });
    }
    openCtxMenu(e, items);
}

async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        flashToast("已复制文字");
        return;
    } catch {
        // 退化方案：execCommand 在部分环境可用
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand("copy");
        flashToast("已复制文字");
    } catch {
        flashToast("复制失败");
    } finally {
        document.body.removeChild(ta);
    }
}

async function copyImage(src: string) {
    const api = getWindowApi();
    if (!api?.copyImage) {
        flashToast("当前环境不支持复制图片");
        return;
    }
    try {
        const res = await api.copyImage(src);
        if (res.ok) flashToast("已复制图片");
        else flashToast(res.error || "复制图片失败");
    } catch {
        flashToast("复制图片失败");
    }
}

async function saveImage(src: string) {
    const api = getWindowApi();
    if (!api?.saveImageAs) {
        flashToast("当前环境不支持保存图片");
        return;
    }
    try {
        const res = await api.saveImageAs(src);
        if (res.ok) flashToast("图片已保存");
        else if (!res.canceled) flashToast(res.error || "保存失败");
    } catch {
        flashToast("保存失败");
    }
}
</script>

<template>
    <div class="app-shell">
        <WindowChrome :title="windowTitle" />
        <main class="chat-window" :aria-label="windowTitle">
            <header class="chat-header">
                <div class="chat-peer">
                    <div class="chat-avatar" :class="{ poking: petPoked }" aria-hidden="true">
                        {{ petNameInitial }}
                    </div>
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

                    <!-- 系统消息：居中提示 -->
                    <div v-else-if="item.message!.author === 'system'" class="chat-sysnote">
                        {{ item.message!.text }}
                    </div>

                    <!-- 消息行：头像常驻 + 带尾气泡 -->
                    <article
                        v-else
                        class="msg-row"
                        :class="`is-${item.message!.author}`"
                    >
                        <div class="msg-avatar" aria-hidden="true">
                            {{ item.message!.author === "user" ? "你" : petNameInitial }}
                        </div>
                        <div class="msg-col">
                            <div
                                class="msg-bubble markdown-body"
                                v-html="renderMarkdownMath(item.message!.text)"
                                @contextmenu="onBubbleContextMenu($event, item.message!)"
                            ></div>
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
                                    @contextmenu="onBubbleContextMenu($event, item.message!)"
                                >
                                    <img :src="img" alt="图片" class="msg-image" loading="lazy" />
                                </a>
                            </div>
                            <div class="msg-time">{{ formatTime(item.message!.timestamp) }}</div>
                        </div>
                    </article>
                </template>

                <!-- 思考中：以 pet 行呈现，头像 + 气泡 -->
                <div v-if="waitingForReply" class="msg-row is-pet">
                    <div class="msg-avatar" aria-hidden="true">{{ petNameInitial }}</div>
                    <div class="msg-col">
                        <div class="msg-bubble msg-waiting" role="status" aria-live="polite">
                            <span class="msg-waiting-dot" aria-hidden="true"></span>
                            <span>{{ petName || "Kirari" }} 正在思考...</span>
                        </div>
                    </div>
                </div>
            </section>

            <div class="composer-area" @paste="onPaste">
                <div v-if="pendingImages.length" class="pending-images">
                    <div v-for="(img, i) in pendingImages" :key="i" class="pending-thumb">
                        <img :src="img" alt="待发送图片" />
                        <button type="button" class="pending-remove" @click="removePendingImage(i)">×</button>
                    </div>
                </div>

                <div class="compose-toolbar">
                    <button
                        type="button"
                        class="ctool"
                        title="表情"
                        aria-label="表情"
                        @click="showEmoji = !showEmoji"
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                            <path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12S6.477 2 12 2m4.214 11.87a1 1 0 0 0-1.414-.014A3.98 3.98 0 0 1 12 15a3.98 3.98 0 0 1-2.8-1.144a1 1 0 0 0-1.4 1.428A6 6 0 0 0 12 17a6 6 0 0 0 4.2-1.716a1 1 0 0 0 .014-1.414M8.5 8a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m7 0a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="ctool"
                        title="图片"
                        aria-label="图片"
                        @click="fileInput?.click()"
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3a3 3 0 0 0-3 3v10a2 2 0 0 0 2 2V6a1 1 0 0 1 1-1h14a2 2 0 0 0-2-2zm0 5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11.333a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zm15 0H7v8.848L10.848 13a1.25 1.25 0 0 1 1.768 0l3.241 3.24l.884-.883a1.25 1.25 0 0 1 1.768 0L20 16.848zm-2 3a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="ctool"
                        title="语音输入即将上线"
                        aria-label="语音"
                        disabled
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                            <path d="M14.185 5.302a7 7 0 0 1 1.529 6.656l3.401 4.372c.599.77.716 1.77.383 2.631a.83.83 0 0 0 .493-.014a1 1 0 0 1 .632 1.898a2.77 2.77 0 0 1-2.546-.39a2.7 2.7 0 0 1-2.75-.337l-4.373-3.4A7 7 0 0 1 4.3 15.19a21.4 21.4 0 0 0 5.766-4.117a21.4 21.4 0 0 0 4.119-5.77M4.044 5.047a7 7 0 0 1 8.548-1.055a19.4 19.4 0 0 1-3.94 5.667c-1.69 1.69-3.612 3-5.662 3.938a7 7 0 0 1 1.054-8.55" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="ctool"
                        title="戳一戳"
                        aria-label="戳一戳"
                        @click="pokePet"
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                            <path d="M6.68 3.422a1.1 1.1 0 0 1 1.828-.754l9.91 8.79c.733.65.315 1.861-.662 1.922l-3.088.19l2.283 5.456a1.5 1.5 0 0 1-.795 1.96l-1.787.76a1.5 1.5 0 0 1-1.97-.795l-2.42-5.724l-2.302 1.989c-.738.637-1.879.07-1.817-.903z" />
                        </svg>
                    </button>
                </div>

                <div v-if="showEmoji" class="emoji-pop">
                    <button
                        v-for="e in emojiList"
                        :key="e"
                        type="button"
                        class="emoji-item"
                        @click="insertEmoji(e)"
                    >
                        {{ e }}
                    </button>
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
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="22" y1="2" x2="11" y2="13" />
                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                    </button>
                </form>
            </div>
        </main>

        <ChatContextMenu
            v-if="ctxMenu"
            :x="ctxMenu.x"
            :y="ctxMenu.y"
            :items="ctxMenu.items"
            @close="ctxMenu = null"
        />
        <div v-if="toast" class="chat-toast" role="status">{{ toast.text }}</div>
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

/* 戳一戳：头部宠物头像抖动反馈 */
.chat-avatar.poking {
    animation: pet-poke 0.55s ease;
}

@keyframes pet-poke {
    0%,
    100% {
        transform: translateX(0) rotate(0deg);
    }
    20% {
        transform: translateX(-4px) rotate(-8deg);
    }
    40% {
        transform: translateX(4px) rotate(8deg);
    }
    60% {
        transform: translateX(-3px) rotate(-5deg);
    }
    80% {
        transform: translateX(3px) rotate(5deg);
    }
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

/* ===== 消息流：双栏头像 + 带尾气泡 ===== */
.chat-thread {
    gap: 16px;
    padding: 18px 24px;
}

/* 系统消息居中提示 */
.chat-sysnote {
    align-self: center;
    max-width: 82%;
    text-align: center;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgba(120, 128, 140, 0.12);
    color: var(--pet-muted);
    font-size: 0.78rem;
    line-height: 1.5;
    user-select: none;
}

/* 消息行：头像 + 气泡列 */
.msg-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
}

.msg-row.is-pet {
    align-self: flex-start;
}

.msg-row.is-user {
    flex-direction: row-reverse;
    align-self: flex-end;
}

.msg-avatar {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 16px;
    font-weight: 800;
    color: #fff;
    margin-top: 1px;
    user-select: none;
    box-shadow: 0 3px 10px var(--pet-primary-shadow);
}

.msg-row.is-pet .msg-avatar {
    background: linear-gradient(135deg, var(--pet-accent-strong), var(--pet-accent));
}

.msg-row.is-user .msg-avatar {
    background: linear-gradient(135deg, #9aa3b5, #7c8597);
}

.msg-col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    max-width: min(74%, 560px);
}

.msg-row.is-user .msg-col {
    align-items: flex-end;
}

/* 带尾气泡 */
.msg-bubble {
    position: relative;
    max-width: 100%;
    padding: 11px 16px;
    font-size: 15px;
    line-height: 1.7;
    color: var(--pet-ink);
    border: 1px solid var(--pet-border);
    box-shadow: 0 4px 14px rgba(57, 44, 76, 0.08);
    transition:
        transform 0.15s ease,
        box-shadow 0.15s ease;
}

.msg-row:hover .msg-bubble {
    transform: translateY(-1px);
    box-shadow: 0 7px 20px rgba(57, 44, 76, 0.13);
}

/* pet 气泡：贴头像侧收紧圆角 + 左尾 */
.msg-row.is-pet .msg-bubble {
    background: var(--pet-surface-strong);
    border-radius: 6px 20px 20px 20px;
}

.msg-row.is-pet .msg-bubble::before {
    content: "";
    position: absolute;
    left: -7px;
    top: 12px;
    width: 13px;
    height: 13px;
    background: var(--pet-surface-strong);
    border-left: 1px solid var(--pet-border);
    border-top: 1px solid var(--pet-border);
    border-top-left-radius: 4px;
    transform: rotate(45deg);
}

/* user 气泡：贴头像侧收紧圆角 + 右尾（头像在右） */
.msg-row.is-user .msg-bubble {
    background: var(--pet-accent);
    color: #fff;
    border-color: var(--pet-accent-strong-border);
    border-radius: 20px 6px 20px 20px;
}

.msg-row.is-user .msg-bubble::before {
    content: "";
    position: absolute;
    right: -7px;
    top: 12px;
    width: 13px;
    height: 13px;
    background: var(--pet-accent);
    border-right: 1px solid var(--pet-accent-strong-border);
    border-top: 1px solid var(--pet-accent-strong-border);
    border-top-right-radius: 4px;
    transform: rotate(45deg);
}

/* user 气泡内 Markdown 适配（白字） */
.msg-row.is-user .msg-bubble {
    color: #fff;
}

.msg-row.is-user .msg-bubble a {
    color: #ffe3ec;
}

.msg-row.is-user .msg-bubble code {
    background: rgba(255, 255, 255, 0.22);
    color: #fff;
}

.msg-row.is-user .msg-bubble pre {
    background: rgba(0, 0, 0, 0.22);
    border-color: rgba(255, 255, 255, 0.2);
}

.msg-row.is-user .msg-bubble blockquote {
    border-left-color: rgba(255, 255, 255, 0.45);
    color: rgba(255, 255, 255, 0.9);
}

.msg-row.is-user .msg-bubble th,
.msg-row.is-user .msg-bubble td {
    border-color: rgba(255, 255, 255, 0.35);
}

.msg-row.is-user .msg-bubble th {
    background: rgba(255, 255, 255, 0.12);
}

.msg-row.is-user .msg-bubble hr {
    border-top-color: rgba(255, 255, 255, 0.35);
}

.msg-time {
    font-size: 11px;
    color: var(--pet-muted);
    font-weight: 600;
    margin-top: 5px;
    padding: 0 4px;
}

/* 消息内图片网格 */
.msg-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
}

.msg-row.is-user .msg-images {
    justify-content: flex-end;
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

/* 思考中气泡 */
.msg-waiting {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    padding: 9px 14px;
    border-radius: 6px 20px 20px 20px;
    color: var(--pet-muted);
    background: var(--pet-surface-strong);
    border: 1px solid var(--pet-border);
    font-size: 0.82rem;
}

.msg-waiting-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--pet-accent);
    box-shadow: 12px 0 0 var(--pet-dot-2), 24px 0 0 var(--pet-dot-3);
    animation: chat-waiting-pulse 1.1s ease-in-out infinite;
}

@keyframes chat-waiting-pulse {
    0%,
    100% {
        opacity: 0.45;
        transform: translateX(0);
    }
    50% {
        opacity: 1;
        transform: translateX(4px);
    }
}

/* ===== 底部输入区 ===== */
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

/* 工具栏：MingCute 图标 */
.compose-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
}

.ctool {
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--pet-muted);
    cursor: pointer;
    transition:
        background 140ms ease,
        color 140ms ease,
        transform 120ms ease;
}

.ctool:hover:not(:disabled) {
    background: var(--pet-accent-soft);
    color: var(--pet-accent);
}

.ctool:active:not(:disabled) {
    transform: translateY(1px);
}

.ctool:disabled {
    opacity: 0.4;
    cursor: default;
}

.ctool svg {
    width: 20px;
    height: 20px;
    display: block;
}

/* 表情弹层 */
.emoji-pop {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
    margin: 0 2px;
    background: var(--pet-surface-strong);
    border: 1px solid var(--pet-border);
    border-radius: 12px;
    box-shadow: 0 6px 18px rgba(57, 44, 76, 0.12);
}

.emoji-item {
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    transition: background 120ms ease;
}

.emoji-item:hover {
    background: var(--pet-accent-soft);
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

.composer-send {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    color: #ffffff;
    background: var(--pet-accent);
    box-shadow: 0 4px 12px var(--pet-primary-shadow);
    transition:
        transform 140ms ease,
        filter 140ms ease,
        opacity 140ms ease;
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

/* ===== KaTeX 公式渲染适配 ===== */
:deep(.markdown-body .katex) {
    color: inherit;
    font-size: 1.05em;
}

:deep(.markdown-body .katex-display) {
    margin: 0.6em 0;
    overflow-x: auto;
    overflow-y: hidden;
}

/* user 气泡白字：公式也跟随白色 */
.msg-row.is-user .msg-bubble :deep(.katex) {
    color: #ffffff;
}

/* 公式中的链接/编号在 user 气泡内也保持可读 */
.msg-row.is-user .msg-bubble :deep(.katex .katex-html) {
    color: #ffffff;
}

/* 轻提示 toast：复制 / 保存成功或失败后的瞬时反馈 */
.chat-toast {
    position: fixed;
    left: 50%;
    bottom: 92px;
    transform: translateX(-50%);
    z-index: 10000;
    padding: 8px 16px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: rgba(43, 36, 56, 0.86);
    box-shadow: 0 8px 22px rgba(57, 44, 76, 0.28);
    backdrop-filter: blur(10px) saturate(140%);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
    pointer-events: none;
    animation: toast-in 0.14s ease-out;
}

@keyframes toast-in {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(6px);
    }
    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}
</style>
