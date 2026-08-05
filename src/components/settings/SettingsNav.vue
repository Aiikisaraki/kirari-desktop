<script setup lang="ts">
/**
 * 设置页分区导航（受控组件）。
 *
 * 之前实现了 IntersectionObserver 滚动联动 + scrollTo 跳转，
 * 但当 SettingsPage 改为"标签页式"（一次只渲染一张卡）后，
 * 滚动联动失去意义——这里只负责点击切换，激活态完全由父组件控制。
 *
 * 视觉上桌面端走左侧垂直侧栏，移动端走顶部水平胶囊，
 * 两种模式共用同一份 props / emit 契约。
 */
interface Section {
    id: string;
    label: string;
    emoji: string;
    hint?: string;
    count?: number | (() => number);
}

const props = defineProps<{
    mode: "sidebar" | "pills";
    sections: Section[];
    activeId?: string;
    /** 侧栏顶部问候语，如 "Hi Kirari · 🎨 外观"。不传则不显示问候行。 */
    greeting?: string;
}>();
const emit = defineEmits<{
    "update:activeId": [id: string];
}>();

const versionTag = "0.3.1"; // 与 package.json 同步，发布时一齐改

function resolveCount(c: Section["count"]): number | undefined {
    if (typeof c === "function") return c();
    return c;
}

function go(id: string) {
    // 受控组件：本地不维护激活态，点击只 emit 让父级切换。
    if (id !== props.activeId) emit("update:activeId", id);
}
</script>

<template>
    <!-- 桌面端：左侧垂直侧栏 -->
    <nav
        v-if="mode === 'sidebar'"
        class="settings-sidebar"
        aria-label="设置分区导航"
    >
        <div class="settings-sidebar__header">
            <p v-if="greeting" class="settings-sidebar__title settings-sidebar__title--greeting">
                {{ greeting }}
            </p>
            <p v-else class="settings-sidebar__title">⚙️ 分区导航</p>
            <p class="settings-sidebar__sub">
                {{ sections.length }} 个分区，点击切换对应设置。
            </p>
        </div>
        <div class="settings-sidebar__list" role="tablist" aria-orientation="vertical">
            <button
                v-for="s in sections"
                :key="s.id"
                type="button"
                role="tab"
                class="settings-sidebar__item"
                :class="{ 'is-active': activeId === s.id }"
                :aria-selected="activeId === s.id ? 'true' : 'false'"
                @click="go(s.id)"
            >
                <span class="nav-emoji" aria-hidden="true">{{ s.emoji }}</span>
                <span class="nav-label">{{ s.label }}</span>
                <span
                    v-if="resolveCount(s.count) !== undefined"
                    class="settings-sidebar__count"
                >
                    {{ resolveCount(s.count) }}
                </span>
            </button>
        </div>
        <p class="settings-sidebar__footer">
            <span class="dot" />
            <span>v{{ versionTag }} · 一切为你而设</span>
        </p>
    </nav>

    <!-- 移动端：顶部水平胶囊 -->
    <nav
        v-else
        class="settings-mobile-nav"
        aria-label="设置分区导航"
        role="tablist"
    >
        <button
            v-for="s in sections"
            :key="s.id"
            type="button"
            role="tab"
            class="nav-pill"
            :class="{ 'is-active': activeId === s.id }"
            :aria-selected="activeId === s.id ? 'true' : 'false'"
            @click="go(s.id)"
        >
            <span class="nav-pill__emoji" aria-hidden="true">{{ s.emoji }}</span>
            <span class="nav-pill__label">{{ s.label }}</span>
        </button>
    </nav>
</template>
