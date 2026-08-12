<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { detectMediaKind } from "../../utils/media";

/**
 * 独立窗口版媒体查看器（?window=viewer&src=...&kind=image|video）。
 *
 * 统一处理图片与视频：
 *   - 图片：滚轮缩放、双击放大/还原、拖拽平移、缩放按钮、复制到剪贴板、另存为
 *   - 视频：HTML5 播放器（controls + autoplay）、另存为（复制不适用）
 *
 * 布局参考 QQ / TIM 图片查看器：
 *   - 顶部可拖拽标题栏（解决无边框窗口无法拖动）
 *   - 底部居中胶囊工具栏，纯图标按钮，避免文字导致换行
 *   - 媒体操作集中到底部，视觉重心下移，不再挤在顶部
 *
 * 保存逻辑：渲染进程 fetch(src) 拿字节 → IPC 传 ArrayBuffer → 主进程只做
 * dialog.showSaveDialog + fs.writeFile。主进程不关心 src 是什么协议，
 * 既然 <img>/<video> 已经能渲染，fetch 必然成功——「能显示就能保存」。
 */

const props = defineProps<{ src: string; kind?: "image" | "video" }>();

// 当前展示的媒体：初始取 props，之后可被主进程 viewer:update 推送覆盖
// （viewer 窗口已打开时再点新媒体，主进程 send 此事件让当前窗口更新内容，而非再开窗口）。
const currentSrc = ref(props.src);
const currentKind = ref<"image" | "video" | undefined>(props.kind);

const kind = computed(() => currentKind.value ?? detectMediaKind(currentSrc.value));
const isVideo = computed(() => kind.value === "video");

// 顶部标题显示文件名（从 URL pathname 或完整 URL 取最后一段）
const fileName = computed(() => {
    try {
        const u = new URL(currentSrc.value);
        const seg = u.pathname.split("/").pop();
        if (seg) return decodeURIComponent(seg);
        return u.hostname || currentSrc.value;
    } catch {
        return currentSrc.value.slice(0, 60);
    }
});

/* ===== 图片缩放 / 平移 ===== */
const MIN_SCALE = 0.5;
const MAX_SCALE = 6;

const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const dragging = ref(false);
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

const imgStyle = computed(() => ({
    transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}));

function resetView() {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
}

function zoomTo(next: number) {
    scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (scale.value <= 1) {
        tx.value = 0;
        ty.value = 0;
    }
}

function onWheel(e: WheelEvent) {
    if (isVideo.value) return;
    e.preventDefault();
    zoomTo(scale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}

function onDblClick() {
    if (isVideo.value) return;
    if (scale.value > 1) resetView();
    else zoomTo(2.5);
}

function onPointerDown(e: PointerEvent) {
    if (isVideo.value || scale.value <= 1) return;
    dragging.value = true;
    dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
    if (!dragging.value) return;
    tx.value = dragStart.tx + (e.clientX - dragStart.x);
    ty.value = dragStart.ty + (e.clientY - dragStart.y);
}

function onPointerUp() {
    dragging.value = false;
}

watch(currentSrc, () => resetView());

/* ===== 键盘操作 ===== */
function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
        close();
        return;
    }
    if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save();
        return;
    }
    if (isVideo.value) return;
    if (e.key === "+" || e.key === "=") zoomTo(scale.value * 1.25);
    else if (e.key === "-") zoomTo(scale.value / 1.25);
    else if (e.key === "0") resetView();
}

/* ===== 窗口操作：close/minimize/maximize 走 windowApi；save/copy 走 viewerApi ===== */
interface WindowApiBridge {
    close?: () => void;
    minimize?: () => void;
    toggleMaximize?: () => void;
    isMaximized?: () => Promise<boolean>;
}
interface ViewerApiBridge {
    open?: (src: string, kind?: "image" | "video") => Promise<void>;
    saveMedia?: (
        bytes: ArrayBuffer,
        ext: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
    copyImage?: (bytes: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
    onUpdate?: (cb: (src: string, kind?: string) => void) => void;
}
function getWindowApi(): WindowApiBridge | undefined {
    return (window as unknown as { windowApi?: WindowApiBridge }).windowApi;
}
function getViewerApi(): ViewerApiBridge | undefined {
    return (window as unknown as { viewerApi?: ViewerApiBridge }).viewerApi;
}

const isMaximized = ref(false);

async function updateMaximizedState() {
    isMaximized.value = (await getWindowApi()?.isMaximized?.()) ?? false;
}

function close() {
    getWindowApi()?.close?.();
}

function minimize() {
    getWindowApi()?.minimize?.();
}

async function toggleMaximize() {
    getWindowApi()?.toggleMaximize?.();
    // 切换后稍等渲染，更新图标状态
    setTimeout(() => void updateMaximizedState(), 80);
}

// 把 blob.type / URL 推断成不带点号的扩展名。
// 图片：image/png → png、image/jpeg → jpg、image/svg+xml → svg
// 视频：video/mp4 → mp4、video/webm → webm、video/quicktime → mov
function extFromMime(mime: string): string {
    const m = /(image|video)\/([\w.+-]+)/i.exec(mime);
    if (!m) return "";
    const sub = m[2].toLowerCase();
    if (sub === "svg+xml") return "svg";
    if (sub === "jpeg") return "jpg";
    if (sub === "quicktime") return "mov";
    if (sub === "x-msvideo") return "avi";
    if (sub === "x-matroska") return "mkv";
    return sub;
}
function extFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const m = /\.([a-zA-Z0-9]+)$/.exec(u.pathname);
        if (!m) return "";
        const sub = m[1].toLowerCase();
        if (sub === "jpeg") return "jpg";
        return sub;
    } catch {
        return "";
    }
}

// 核心：用 fetch 把已渲染的 src 拉成 ArrayBuffer。
// 由于 <img>/<video :src="src"> 已经能渲染，浏览器一定已经加载了字节
// （avatar:// / pet:// 已通过 registerSchemesAsPrivileged 开启 supportFetchAPI），
// fetch 必然成功——等价于「能显示就能保存」。
// 默认 ext 按 kind 区分：image → png，video → mp4。
async function fetchBytes(src: string): Promise<{ bytes: ArrayBuffer; ext: string }> {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`读取媒体失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const bytes = await blob.arrayBuffer();
    const ext = extFromMime(blob.type) || extFromUrl(src) || (isVideo.value ? "mp4" : "png");
    return { bytes, ext };
}

async function save() {
    const api = getViewerApi();
    if (!api?.saveMedia) {
        alert("当前环境不支持保存");
        return;
    }
    try {
        const { bytes, ext } = await fetchBytes(currentSrc.value);
        const res = await api.saveMedia(bytes, ext);
        if (!res.ok && !res.canceled && res.error) {
            alert(res.error);
        }
    } catch (e) {
        alert("读取媒体失败：" + (e instanceof Error ? e.message : String(e)));
    }
}

// 仅图片：视频字节无法 nativeImage.createFromBuffer，故不显示复制按钮。
async function copyImage() {
    const api = getViewerApi();
    if (!api?.copyImage) {
        alert("当前环境不支持复制图片");
        return;
    }
    try {
        const { bytes } = await fetchBytes(currentSrc.value);
        const res = await api.copyImage(bytes);
        if (!res.ok && res.error) {
            alert(res.error);
        }
    } catch (e) {
        alert("读取图片失败：" + (e instanceof Error ? e.message : String(e)));
    }
}

onMounted(() => {
    document.title = isVideo.value ? `视频查看器 - ${fileName.value}` : `图片查看器 - ${fileName.value}`;
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", updateMaximizedState);
    void updateMaximizedState();
    // viewer 窗口已打开时再点新媒体：主进程推送 viewer:update，更新当前窗口内容。
    getViewerApi()?.onUpdate?.((src, k) => {
        if (src) {
            currentSrc.value = src;
            currentKind.value = k === "video" ? "video" : k === "image" ? "image" : undefined;
            document.title = isVideo.value ? `视频查看器 - ${fileName.value}` : `图片查看器 - ${fileName.value}`;
        }
    });
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("resize", updateMaximizedState);
});
</script>

<template>
    <div
        class="mv-root"
        role="dialog"
        aria-modal="true"
        :aria-label="isVideo ? '视频播放器' : '图片查看器'"
    >
        <!-- 顶部可拖拽标题栏：解决无边框窗口无法拖动的问题 -->
        <div class="mv-drag-bar" @dblclick="toggleMaximize">
            <span class="mv-drag-title">{{ fileName }}</span>
            <div class="mv-win-controls" @dblclick.stop>
                <button
                    type="button"
                    class="mv-win-btn"
                    aria-label="最小化"
                    title="最小化"
                    @click="minimize"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="mv-win-btn"
                    :aria-label="isMaximized ? '还原' : '最大化'"
                    :title="isMaximized ? '还原' : '最大化'"
                    @click="toggleMaximize"
                >
                    <svg v-if="isMaximized" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <rect x="5" y="9" width="10" height="10" rx="1" />
                        <path d="M9 5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <rect x="4" y="4" width="16" height="16" rx="1" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="mv-win-btn mv-win-btn--close"
                    aria-label="关闭"
                    title="关闭 (Esc)"
                    @click="close"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>
        </div>

        <div class="mv-stage" :class="{ 'is-dragging': dragging }">
            <video
                v-if="isVideo"
                class="mv-video"
                :src="currentSrc"
                controls
                autoplay
                playsinline
            ></video>
            <img
                v-else
                class="mv-image"
                :class="{ zoomed: scale > 1 }"
                :src="currentSrc"
                alt="图片预览"
                :style="imgStyle"
                draggable="false"
                @dblclick="onDblClick"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
            />
        </div>

        <!-- 底部胶囊工具栏：参考 QQ / TIM 图片查看器，纯图标避免换行 -->
        <div class="mv-toolbar" role="toolbar" aria-label="媒体操作">
            <template v-if="!isVideo">
                <div class="mv-toolbar-group">
                    <button
                        type="button"
                        class="mv-btn"
                        aria-label="缩小"
                        title="缩小 (-)"
                        @click="zoomTo(scale / 1.25)"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                    <span class="mv-scale-label">{{ Math.round(scale * 100) }}%</span>
                    <button
                        type="button"
                        class="mv-btn"
                        aria-label="放大"
                        title="放大 (+)"
                        @click="zoomTo(scale * 1.25)"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="mv-btn"
                        aria-label="重置缩放"
                        title="重置 (0)"
                        @click="resetView"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 12a9 9 0 1 0 3-6.7" />
                            <polyline points="3 4 3 9 8 9" />
                        </svg>
                    </button>
                </div>
                <div class="mv-toolbar-divider" aria-hidden="true"></div>
                <div class="mv-toolbar-group">
                    <button
                        type="button"
                        class="mv-btn"
                        aria-label="复制图片"
                        title="复制到剪贴板"
                        @click="copyImage"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="11" height="11" rx="2" />
                            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                        </svg>
                    </button>
                </div>
                <div class="mv-toolbar-divider" aria-hidden="true"></div>
            </template>
            <div class="mv-toolbar-group">
                <button
                    type="button"
                    class="mv-btn mv-btn--accent"
                    :aria-label="isVideo ? '保存视频' : '另存为'"
                    :title="isVideo ? '保存视频 (Ctrl+S)' : '另存为 (Ctrl+S)'"
                    @click="save"
                >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                </button>
            </div>
        </div>

        <div class="mv-hint" aria-hidden="true">
            <template v-if="isVideo">
                空格 播放/暂停 · Esc 关闭 · Ctrl+S 保存
            </template>
            <template v-else>
                滚轮缩放 · 双击放大/还原 · 拖拽移动 · Esc 关闭 · Ctrl+S 保存
            </template>
        </div>
    </div>
</template>

<style scoped>
/* ===== 独立窗口根：占满整个 BrowserWindow ===== */
.mv-root {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0e0e12;
    color: #e7e7ea;
    overflow: hidden;
    user-select: none;
}

/* 底部暗角遮罩：高亮图片时也能衬出底部工具栏与提示 */
.mv-root::after {
    content: "";
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 220px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0.25) 40%, transparent);
    pointer-events: none;
    z-index: 1;
}

/* ===== 顶部可拖拽标题栏 ===== */
.mv-drag-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 36px;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Electron 无边框窗口拖动关键：整个标题栏是拖拽区 */
    -webkit-app-region: drag;
    app-region: drag;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.2) 60%, transparent);
}

.mv-drag-title {
    max-width: 60%;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.82);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
}

/* ===== 窗口控制按钮：必须显式取消拖拽，否则无法点击 ===== */
.mv-win-controls {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    -webkit-app-region: no-drag;
    app-region: no-drag;
}

.mv-win-btn {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.75);
    background: transparent;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
}

.mv-win-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
}

.mv-win-btn--close:hover {
    background: #e35d6a;
    color: #fff;
}

.mv-win-btn:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.8);
    outline-offset: 1px;
}

/* ===== 媒体舞台：顶部给拖拽栏留安全边距 ===== */
.mv-stage {
    max-width: 96vw;
    max-height: calc(100vh - 130px);
    margin-top: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.mv-image {
    max-width: 96vw;
    max-height: calc(100vh - 150px);
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    cursor: zoom-in;
    user-select: none;
    touch-action: none;
    transition: transform 0.12s ease-out;
}

.mv-image.zoomed {
    cursor: grab;
}

.mv-stage.is-dragging .mv-image {
    cursor: grabbing;
    transition: none;
}

.mv-video {
    max-width: 96vw;
    max-height: calc(100vh - 150px);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    background: #000;
    outline: none;
}

/* ===== 底部胶囊工具栏：参考 QQ / TIM 图片查看器 ===== */
.mv-toolbar {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border-radius: 999px;
    background: rgba(18, 18, 26, 0.95);
    backdrop-filter: blur(18px) saturate(160%);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.25) inset,
        0 12px 44px rgba(0, 0, 0, 0.45);
}

.mv-toolbar-group {
    display: flex;
    align-items: center;
    gap: 4px;
}

.mv-toolbar-divider {
    width: 1px;
    height: 22px;
    background: rgba(255, 255, 255, 0.22);
    margin: 0 2px;
}

.mv-btn {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 999px;
    color: #ffffff;
    background: transparent;
    cursor: pointer;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    transition:
        background 140ms ease,
        transform 140ms ease;
}

.mv-btn:hover {
    background: rgba(255, 255, 255, 0.18);
    transform: translateY(-1px);
}

.mv-btn:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.9);
    outline-offset: 2px;
}

.mv-btn--accent:hover {
    background: rgba(255, 107, 157, 0.42);
}

.mv-scale-label {
    min-width: 44px;
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    color: #ffffff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    font-variant-numeric: tabular-nums;
    user-select: none;
}

/* ===== 底部操作提示 ===== */
.mv-hint {
    position: fixed;
    bottom: 86px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.92);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    background: rgba(18, 18, 26, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    user-select: none;
    white-space: nowrap;
    pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
    .mv-image {
        transition: none;
    }
    .mv-btn,
    .mv-win-btn {
        transition: none;
    }
}
</style>
