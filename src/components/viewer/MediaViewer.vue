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
 * 顶部工具栏 position: fixed，滚轮只作用于 <img>（视频不缩放），
 * 工具栏始终在原位可点击——解决 overlay 时代滚轮后按钮难触发的问题。
 *
 * 保存逻辑：渲染进程 fetch(src) 拿字节 → IPC 传 ArrayBuffer → 主进程只做
 * dialog.showSaveDialog + fs.writeFile。主进程不关心 src 是什么协议，
 * 既然 <img>/<video> 已经能渲染，fetch 必然成功——「能显示就能保存」。
 */

const props = defineProps<{ src: string; kind?: "image" | "video" }>();

const kind = computed(() => props.kind ?? detectMediaKind(props.src));
const isVideo = computed(() => kind.value === "video");

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

watch(() => props.src, () => resetView());

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

/* ===== 窗口操作：close 走 windowApi；save/copy 走 viewerApi（fetch 字节后传主进程） ===== */
interface WindowApiBridge {
    close?: () => void;
    minimize?: () => void;
    toggleMaximize?: () => void;
}
interface ViewerApiBridge {
    open?: (src: string, kind?: "image" | "video") => Promise<void>;
    saveMedia?: (
        bytes: ArrayBuffer,
        ext: string,
    ) => Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
    copyImage?: (bytes: ArrayBuffer) => Promise<{ ok: boolean; error?: string }>;
}
function getWindowApi(): WindowApiBridge | undefined {
    return (window as unknown as { windowApi?: WindowApiBridge }).windowApi;
}
function getViewerApi(): ViewerApiBridge | undefined {
    return (window as unknown as { viewerApi?: ViewerApiBridge }).viewerApi;
}

function close() {
    getWindowApi()?.close?.();
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
        const { bytes, ext } = await fetchBytes(props.src);
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
        const { bytes } = await fetchBytes(props.src);
        const res = await api.copyImage(bytes);
        if (!res.ok && res.error) {
            alert(res.error);
        }
    } catch (e) {
        alert("读取图片失败：" + (e instanceof Error ? e.message : String(e)));
    }
}

const closeBtn = ref<HTMLButtonElement | null>(null);

onMounted(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("wheel", onWheel, { passive: false });
    closeBtn.value?.focus();
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("wheel", onWheel);
});
</script>

<template>
    <div
        class="mv-root"
        role="dialog"
        aria-modal="true"
        :aria-label="isVideo ? '视频播放器' : '图片查看器'"
    >
        <div class="mv-stage" :class="{ 'is-dragging': dragging }">
            <video
                v-if="isVideo"
                class="mv-video"
                :src="src"
                controls
                autoplay
                playsinline
            ></video>
            <img
                v-else
                class="mv-image"
                :class="{ zoomed: scale > 1 }"
                :src="src"
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

        <!-- 顶部工具栏：固定，不随滚轮消失 -->
        <div class="mv-toolbar" role="toolbar" aria-label="媒体操作">
            <template v-if="!isVideo">
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
            </template>
            <button
                type="button"
                class="mv-btn mv-btn--save"
                :aria-label="isVideo ? '保存视频' : '另存为'"
                :title="isVideo ? '保存视频 (Ctrl+S)' : '另存为 (Ctrl+S)'"
                @click="save"
            >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span class="mv-btn-text">保存</span>
            </button>
            <button
                ref="closeBtn"
                type="button"
                class="mv-btn mv-btn--close"
                aria-label="关闭"
                title="关闭 (Esc)"
                @click="close"
            >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            </button>
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

.mv-stage {
    max-width: 92vw;
    max-height: calc(100vh - 100px);
    margin-top: 56px; /* 给固定工具栏留位置 */
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.mv-image {
    max-width: 92vw;
    max-height: calc(100vh - 120px);
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
    max-width: 92vw;
    max-height: calc(100vh - 120px);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    background: #000;
    outline: none;
}

/* ===== 顶部工具栏：position: fixed，滚轮事件被 onWheel preventDefault，按钮始终可点 ===== */
.mv-toolbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(20, 20, 28, 0.78);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.mv-btn {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    color: #e7e7ea;
    background: rgba(255, 255, 255, 0.06);
    cursor: pointer;
    transition:
        background 140ms ease,
        transform 140ms ease;
}

.mv-btn:hover {
    background: rgba(255, 255, 255, 0.16);
    transform: translateY(-1px);
}

.mv-btn:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.85);
    outline-offset: 2px;
}

.mv-btn--save {
    width: auto;
    padding: 0 12px;
    gap: 6px;
    background: rgba(255, 107, 157, 0.32);
    border-color: rgba(255, 107, 157, 0.45);
}

.mv-btn--save:hover {
    background: rgba(255, 107, 157, 0.5);
}

.mv-btn--close {
    background: rgba(227, 93, 106, 0.32);
    border-color: rgba(227, 93, 106, 0.45);
}

.mv-btn--close:hover {
    background: rgba(227, 93, 106, 0.5);
}

.mv-btn-text {
    font-size: 13px;
    font-weight: 600;
}

.mv-scale-label {
    min-width: 48px;
    text-align: center;
    font-size: 12px;
    color: #b5b5be;
    font-variant-numeric: tabular-nums;
}

/* ===== 底部操作提示 ===== */
.mv-hint {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.06);
    user-select: none;
    white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
    .mv-image {
        transition: none;
    }
    .mv-btn {
        transition: none;
    }
}
</style>
