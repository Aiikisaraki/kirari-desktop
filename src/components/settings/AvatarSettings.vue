<script setup lang="ts">
/**
 * 形象（仅桌宠端）：换一只桌宠 + 导入 / 打开形象文件夹。
 * 页头与标题由壳渲染，这里只输出卡片。
 */
import { onMounted, ref } from "vue";
import { useAvatarStore } from "../../stores/avatar";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

const avatarStore = useAvatarStore();
const isZipping = ref(false);
const zipError = ref("");
const avatarError = ref("");

async function handleImportZip() {
    zipError.value = "";
    isZipping.value = true;
    try {
        const r = await avatarStore.importAvatarZip();
        if (!r.ok) zipError.value = r.message || "上传失败";
        else emit("saved", "形象已导入，已经换过去了");
    } finally {
        isZipping.value = false;
    }
}

async function handleOpenFolder() {
    try {
        await avatarStore.openAvatarsFolder();
    } catch {
        /* 忽略 */
    }
}

async function handleSelectAvatar(id: string) {
    avatarError.value = "";
    const found = avatarStore.list.find((a) => a.id === id);
    if (!found) {
        avatarError.value = `未找到形象 ${id}`;
        return;
    }
    try {
        await avatarStore.setAvatar(found);
        emit("saved", `已换成「${found.name}」`);
    } catch (e) {
        avatarError.value = e instanceof Error ? e.message : "切换形象失败";
    }
}

onMounted(async () => {
    await avatarStore.init();
    // 每次打开设置页自动重新扫描形象目录，无需手动刷新。
    await avatarStore.rescanAvatars();
});
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">当前形象</h2>
                    <p class="sk-card__desc">
                        每个形象自带立绘与动作，换完立刻出现在桌面上，不用重启。
                    </p>
                </div>
            </div>

            <div class="sk-card__body">
                <div class="sk-row">
                    <div class="sk-row__main">
                        <span class="sk-row__icon"><SettingsIcon name="paw" /></span>
                        <div>
                            <h3 class="sk-row__title">{{ avatarStore.current.name }}</h3>
                            <p class="sk-row__desc">
                                {{ avatarStore.list.length }} 个形象可选，切换即时生效。
                            </p>
                        </div>
                    </div>
                    <div class="sk-row__control">
                        <select
                            class="sk-select"
                            aria-label="选择桌宠形象"
                            :value="avatarStore.current.id"
                            @change="
                                handleSelectAvatar(
                                    ($event.target as HTMLSelectElement).value,
                                )
                            "
                        >
                            <option
                                v-for="a in avatarStore.list"
                                :key="a.id"
                                :value="a.id"
                            >
                                {{ a.name }}
                            </option>
                        </select>
                    </div>
                </div>
            </div>

            <div v-if="zipError || avatarError" class="sk-card__body">
                <div class="sk-alert sk-alert--error">
                    <SettingsIcon name="alert" />
                    <span>{{ zipError || avatarError }}</span>
                </div>
            </div>
        </div>

        <div class="sk-card">
            <div class="sk-card__head">
                <div>
                    <h2 class="sk-card__title">管理形象</h2>
                    <p class="sk-card__desc">
                        上传压缩包自动解压并注册；也可以直接把形象文件夹丢进形象目录。
                    </p>
                </div>
            </div>

            <div class="sk-card__body">
                <div class="sk-btn-row">
                    <button
                        type="button"
                        class="sk-btn sk-btn--primary"
                        :disabled="isZipping"
                        @click="handleImportZip"
                    >
                        <SettingsIcon name="upload" />
                        {{ isZipping ? "解压中…" : "上传压缩包" }}
                    </button>
                    <button type="button" class="sk-btn" @click="handleOpenFolder">
                        <SettingsIcon name="folder" />
                        打开形象文件夹
                    </button>
                </div>
            </div>

            <div class="sk-card__body">
                <p class="sk-hint">
                    自定义形象请放入「形象文件夹」，或点「上传压缩包」自动解压。每个形象需包含配置文件与对应的图片素材；打开设置页时会自动刷新列表。
                </p>
            </div>
        </div>
    </section>
</template>
