<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAvatarStore } from "../../stores/avatar";

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
    <section id="avatar" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🐾</span>
            <span>桌宠形象</span>
        </h3>
        <p class="settings-card__desc">
            切换桌宠形象。渲染方式由皮肤配置文件（frames.json）里的
            <code>type</code> 字段自动决定，无需手动选择。
        </p>

        <!-- 当前形象：行状 -->
        <div class="settings-row">
            <div class="settings-row__body">
                <span class="settings-row__icon" aria-hidden="true">🎭</span>
                <div class="settings-row__text">
                    <h4 class="settings-row__title">当前形象</h4>
                    <p class="settings-row__desc">{{ avatarStore.list.length }} 个形象可选，切换即时生效。</p>
                </div>
            </div>
            <div class="settings-row__control">
                <div class="select-wrap">
                    <select
                        class="settings-select"
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
                    <svg
                        class="select-caret"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </div>
            </div>
        </div>

        <!-- 操作：导入 / 打开文件夹 -->
        <div class="settings-card__group">
            <h5 class="settings-card__group-title">
                <span class="group-mark" />
                管理形象
            </h5>
            <div class="avatar-actions">
                <button
                    type="button"
                    class="btn btn--import"
                    :disabled="isZipping"
                    @click="handleImportZip"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="17"
                        height="17"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M12 15V8m0 0L8.5 11.5M12 8l3.5 3.5" />
                        <path d="M20 16.5A4.5 4.5 0 0 0 17.5 8h-1.3A6 6 0 1 0 6 14.6" />
                    </svg>
                    <span>{{ isZipping ? "解压中…" : "上传压缩包" }}</span>
                </button>
                <button
                    type="button"
                    class="btn btn--ghost"
                    @click="handleOpenFolder"
                >
                    <svg
                        viewBox="0 0 24 24"
                        width="17"
                        height="17"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path
                            d="M3 7a2 2 0 0 1 2-2h3.6a1 1 0 0 1 .8.4L10.5 7H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                        />
                    </svg>
                    <span>打开形象文件夹</span>
                </button>
            </div>

            <div v-if="zipError || avatarError" class="settings-error">
                {{ zipError || avatarError }}
            </div>

            <p class="avatar-tip">
                <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v5" />
                    <path d="M12 7.5h.01" />
                </svg>
                <span>
                    自定义形象文件夹需包含
                    <code>frames.json</code>
                    与对应精灵图。直接丢进「形象文件夹」，或点「上传压缩包」自动解压；打开设置页时会自动刷新列表。
                </span>
            </p>
        </div>
    </section>
</template>
