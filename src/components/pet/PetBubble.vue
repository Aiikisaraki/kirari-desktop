<script setup lang="ts">
import { computed } from "vue";
import { renderInlineMath } from "../../utils/renderMarkdownMath";

const props = defineProps<{
    message: string;
    visible: boolean;
    interactive: boolean;
}>();

defineEmits<{
    openChat: [];
    dismiss: [];
}>();

// 桌宠气泡是短文本，仅渲染 LaTeX 公式（不展开完整 Markdown，避免布局被破坏）
const renderedMessage = computed(() => renderInlineMath(props.message));
</script>

<template>
    <button
        v-if="visible && interactive"
        type="button"
        class="pet-bubble is-actionable"
        v-html="renderedMessage"
        @click="$emit('openChat')"
    ></button>
    <button
        v-else-if="visible"
        type="button"
        class="pet-bubble"
        v-html="renderedMessage"
        @click="$emit('dismiss')"
    ></button>
</template>

<style scoped>
.pet-bubble :deep(.katex) {
    color: inherit;
    font-size: 0.95em;
}

/* 气泡较窄，长公式允许横向滚动而不撑破布局 */
.pet-bubble :deep(.katex-display) {
    margin: 0.3em 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
}
</style>
