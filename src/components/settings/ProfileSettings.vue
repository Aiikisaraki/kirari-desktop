<script setup lang="ts">
/**
 * 个人：聊天时代表你的那张头像。图片只留在本机。
 */
import { onMounted, ref } from "vue";
import { useUserProfileStore } from "../../stores/userProfile";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

const store = useUserProfileStore();
const isPicking = ref(false);

async function handlePick() {
    isPicking.value = true;
    try {
        const url = await store.pickAvatar();
        // 用户取消不会写 lastError；只有真的换了图才提示。
        if (url) emit("saved", "头像已更新");
    } finally {
        isPicking.value = false;
    }
}

async function handleRemove() {
    await store.clearAvatar();
    if (!store.lastError) emit("saved", "已移除头像，恢复默认占位");
}

onMounted(() => {
    void store.init();
});
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-media-row">
                <div class="sk-avatar">
                    <img v-if="store.avatar" :src="store.avatar" alt="我的头像" />
                    <span v-else aria-hidden="true">你</span>
                </div>
                <div class="sk-btn-row">
                    <button
                        type="button"
                        class="sk-btn sk-btn--primary"
                        :disabled="isPicking"
                        @click="handlePick"
                    >
                        <SettingsIcon name="upload" />
                        {{ isPicking ? "选择中…" : store.avatar ? "更换图片" : "选择图片" }}
                    </button>
                    <button
                        v-if="store.avatar"
                        type="button"
                        class="sk-btn sk-btn--ghost sk-btn--danger"
                        @click="handleRemove"
                    >
                        <SettingsIcon name="trash" />
                        移除
                    </button>
                </div>
            </div>

            <div v-if="store.lastError" class="sk-card__body">
                <div class="sk-alert sk-alert--error">
                    <SettingsIcon name="alert" />
                    <span>{{ store.lastError }}</span>
                </div>
            </div>

            <div class="sk-card__body">
                <p class="sk-hint">
                    支持 PNG / JPG / GIF / WebP / BMP。设置后即时在聊天窗口生效；移除即恢复默认占位头像。
                </p>
            </div>
        </div>
    </section>
</template>
