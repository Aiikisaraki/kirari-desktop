<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { detectMediaKind } from "../../utils/media";

/**
 * 统一媒体查看器 / 播放器（应用内覆盖层，替代 target="_blank" 弹原生窗口）。
 * - 图片：滚轮缩放、双击放大/还原、拖拽平移、缩放按钮、另存为。
 * - 视频：HTML5 播放器（controls + autoplay）。
 * 通过 emit('save') 把「另存为」交给父组件复用既有 IPC（含 windowApi/require 兜底）。
 */

const props = defineProps<{
    src: string;
    kind?: "image" | "video";
    alt?: string;
}>();

const emit = defineEmits<{ close: []; save: [src: string] }>();

const kind = computed(() => props.kind ?? detectMediaKind(props.src));

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
    // 缩回原始尺寸时复位位移，避免图片"漂走"
    if (scale.value <= 1) {
        tx.value = 0;
        ty.value = 0;
    }
}

function onWheel(e: WheelEvent) {
    if (kind.value !== "image") return;
    e.preventDefault();
    zoomTo(scale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}

function onDblClick() {
    if (kind.value !== "image") return;
    if (scale.value > 1) resetView();
    else zoomTo(2.5);
}

function onPointerDown(e: PointerEvent) {
    if (kind.value !== "image" || scale.value <= 1) return;
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

// 切换媒体时复位视图
watch(
    () => props.src,
    () => resetView(),
);

/* ===== 键盘操作 ===== */
function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
        emit("close");
        return;
    }
    if (kind.value !== "image") return;
    if (e.key === "+" || e.key === "=") zoomTo(scale.value * 1.25);
    else if (e.key === "-") zoomTo(scale.value / 1.25);
    else if (e.key === "0") resetView();
}

const closeBtn = ref<HTMLButtonElement | null>(null);

onMounted(() => {
    window.addEventListener("keydown", onKeydown);
    closeBtn.value?.focus();
});

onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
    <div
        class="mv-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="kind === 'video' ? '视频播放器' : '图片查看器'"
        @click.self="emit('close')"
        @wheel="onWheel"
    >
        <div class="mv-stage" :class="{ 'is-dragging': dragging }">
            <video
                v-if="kind === 'video'"
                class="mv-video"
                :src="src"
                controls
                autoplay
                playsinline
                @click.stop
            ></video>
            <img
                v-else
                class="mv-image"
                :class="{ zoomed: scale > 1 }"
                :src="src"
                :alt="alt || '图片预览'"
                :style="imgStyle"
                draggable="false"
                @click.stop
                @dblclick="onDblClick"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
            />
        </div>

        <div class="mv-toolbar" role="toolbar" aria-label="媒体操作">
            <template v-if="kind === 'image'">
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
            </template>
            <button
                type="button"
                class="mv-btn"
                aria-label="另存为"
                title="另存为"
                @click="emit('save', src)"
            >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
            </button>
            <button
                ref="closeBtn"
                type="button"
                class="mv-btn mv-btn--close"
                aria-label="关闭"
                title="关闭 (Esc)"
                @click="emit('close')"
            >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            </button>
        </div>

        <div v-if="kind === 'image'" class="mv-hint" aria-hidden="true">
            滚轮缩放 · 双击放大/还原 · 拖拽移动 · Esc 关闭
        </div>
    </div>
</template>

<style scoped>
/* ===== 遮罩：深色 + 毛玻璃，聚焦媒体本身 ===== */
.mv-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9990;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(16, 18, 28, 0.86);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    animation: mv-fade-in 0.16s ease;
}

@keyframes mv-fade-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}

.mv-stage {
    max-width: 92vw;
    max-height: 86vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.mv-image {
    max-width: 92vw;
    max-height: 86vh;
    object-fit: contain;
    border-radius: 10px;
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
    max-height: 86vh;
    border-radius: 10px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
    background: #000;
    outline: none;
}

/* ===== 工具栏：44px 触控目标，毛玻璃按钮 ===== */
.mv-toolbar {
    position: fixed;
    top: 14px;
    right: 14px;
    display: flex;
    gap: 8px;
}

.mv-btn {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 12px;
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    cursor: pointer;
    transition:
        background 140ms ease,
        transform 140ms ease;
}

.mv-btn:hover {
    background: rgba(255, 255, 255, 0.22);
    transform: translateY(-1px);
}

.mv-btn:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.85);
    outline-offset: 2px;
}

.mv-btn--close {
    background: rgba(227, 93, 106, 0.32);
    border-color: rgba(227, 93, 106, 0.45);
}

.mv-btn--close:hover {
    background: rgba(227, 93, 106, 0.5);
}

/* ===== 底部操作提示 ===== */
.mv-hint {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
    background: rgba(255, 255, 255, 0.08);
    user-select: none;
    white-space: nowrap;
}

/* 尊重减少动效偏好 */
@media (prefers-reduced-motion: reduce) {
    .mv-backdrop {
        animation: none;
    }
    .mv-image {
        transition: none;
    }
    .mv-btn {
        transition: none;
    }
}
</style>
