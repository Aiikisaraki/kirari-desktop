<script setup lang="ts">
/** 外观：四套配色，切换即时生效并自动保存。 */
import { THEMES, useThemeStore } from "../../stores/theme";

const emit = defineEmits<{ saved: [msg?: string] }>();
const themeStore = useThemeStore();

function pick(id: string, label: string) {
    if (themeStore.current === id) return;
    themeStore.setTheme(id as never);
    emit("saved", `已换成「${label}」`);
}
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">主题配色</h2>
                    <p class="sk-card__desc">
                        桌宠窗口、聊天窗口和这个设置窗口共用一套配色，换完立刻生效，所有已打开的窗口一起变。
                    </p>
                </div>
            </div>

            <div class="sk-card__body">
                <div class="sk-choices" role="radiogroup" aria-label="主题配色">
                    <button
                        v-for="t in THEMES"
                        :key="t.id"
                        type="button"
                        role="radio"
                        class="sk-choice"
                        :class="{ 'is-active': themeStore.current === t.id }"
                        :aria-checked="themeStore.current === t.id ? 'true' : 'false'"
                        @click="pick(t.id, t.label)"
                    >
                        <span class="sk-swatch" :class="'sk-swatch--' + t.id" aria-hidden="true" />
                        <span class="sk-choice__text">
                            <span class="sk-choice__label">{{ t.label }}</span>
                            <span class="sk-choice__sub">{{ t.sub }}</span>
                        </span>
                        <span
                            v-if="themeStore.current === t.id"
                            class="sk-choice__check"
                            aria-hidden="true"
                        >✓</span>
                    </button>
                </div>
            </div>

            <p class="sk-hint">
                配色只改颜色，不动布局和字号。想换个性格，去「人格」；想换只桌宠，去「形象」。
            </p>
        </div>
    </section>
</template>
