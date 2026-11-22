<script setup lang="ts">
/** 设置分区导航（受控组件）：只管渲染和 emit，激活态由 shell 决定。 */
import SettingsIcon from "./SettingsIcon.vue";
import type { SettingsGroup } from "./sections";

defineProps<{
    groups: SettingsGroup[];
    active: string;
    showChat?: boolean;
    chatActive?: boolean;
    brand?: { mark: string; name: string; sub: string };
    foot?: string;
}>();
const emit = defineEmits<{ select: [id: string]; chat: [] }>();
</script>

<template>
    <aside class="sk-side">
        <div v-if="brand" class="sk-side__brand">
            <span class="sk-side__avatar" aria-hidden="true">{{ brand.mark }}</span>
            <div class="sk-side__brand-text">
                <strong>{{ brand.name }}</strong>
                <span>{{ brand.sub }}</span>
            </div>
        </div>

        <nav class="sk-side__nav" aria-label="设置分区导航">
            <button
                v-if="showChat"
                type="button"
                class="sk-nav"
                :class="{ 'is-active': chatActive }"
                @click="emit('chat')"
            >
                <SettingsIcon name="chat" class="sk-nav__icon" />
                <span class="sk-nav__label">聊天</span>
            </button>
            <template v-for="group in groups" :key="group.id">
                <p class="sk-side__group">{{ group.label }}</p>
                <button
                    v-for="item in group.items"
                    :key="item.id"
                    type="button"
                    class="sk-nav"
                    :class="{ 'is-active': !chatActive && active === item.id }"
                    :aria-current="!chatActive && active === item.id ? 'page' : undefined"
                    @click="emit('select', item.id)"
                >
                    <SettingsIcon :name="item.icon" class="sk-nav__icon" />
                    <span class="sk-nav__label">{{ item.label }}</span>
                </button>
            </template>
        </nav>

        <p v-if="foot" class="sk-side__foot">
            <span class="sk-dot" aria-hidden="true" />
            <span>{{ foot }}</span>
        </p>
    </aside>
</template>
