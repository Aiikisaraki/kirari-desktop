<script setup lang="ts">
import { onMounted, ref } from "vue";

const autoLaunch = ref(false);
const autoLaunchBusy = ref(false);
const petName = ref("Kirari");
const petNameSaving = ref(false);

type WindowApi = {
    getAutoLaunch?: () => Promise<boolean>;
    setAutoLaunch?: (e: boolean) => Promise<void>;
    getPetName?: () => Promise<string>;
    setPetName?: (n: string) => Promise<void>;
    onPetNameChanged?: (cb: (name: string) => void) => void;
};

function api(): WindowApi | undefined {
    return (window as unknown as { windowApi?: WindowApi }).windowApi;
}

async function loadAutoLaunch() {
    try {
        const a = api();
        if (a?.getAutoLaunch) autoLaunch.value = await a.getAutoLaunch();
    } catch {
        /* 读取失败则不勾选 */
    }
}

async function loadPetName() {
    try {
        const a = api();
        if (a?.getPetName) petName.value = (await a.getPetName()) || "Kirari";
        a?.onPetNameChanged?.((name) => {
            petName.value = name || "Kirari";
        });
    } catch {
        /* 忽略 */
    }
}

async function handlePetNameChange() {
    const name = petName.value.trim() || "Kirari";
    petName.value = name;
    const a = api();
    if (!a?.setPetName) return;
    petNameSaving.value = true;
    try {
        await a.setPetName(name);
    } catch {
        /* 保存失败时界面已回写 */
    } finally {
        petNameSaving.value = false;
    }
}

async function handleAutoLaunchChange() {
    autoLaunchBusy.value = true;
    try {
        await api()?.setAutoLaunch?.(autoLaunch.value);
    } catch {
        /* 忽略 */
    } finally {
        autoLaunchBusy.value = false;
    }
}

onMounted(() => {
    loadAutoLaunch();
    loadPetName();
});
</script>

<template>
    <section id="general" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">✨</span>
            <span>通用</span>
        </h3>
        <p class="settings-card__desc">
            桌宠姓名与启动行为，与外观/账号相互独立。
        </p>

        <!-- 桌宠备注名：行状，右侧是输入框 -->
        <div class="settings-row">
            <div class="settings-row__body">
                <span class="settings-row__icon" aria-hidden="true">🐾</span>
                <div class="settings-row__text">
                    <h4 class="settings-row__title">桌宠备注名</h4>
                    <p class="settings-row__desc">聊天窗口顶部会显示这个名字；默认 Kirari。</p>
                </div>
            </div>
            <div class="settings-row__control">
                <input
                    id="petName"
                    v-model="petName"
                    class="text-input"
                    type="text"
                    autocomplete="off"
                    placeholder="例如：绮莉、Kirari、小K…"
                    maxlength="16"
                    :disabled="petNameSaving"
                    @change="handlePetNameChange"
                    @keyup.enter="handlePetNameChange"
                />
            </div>
        </div>

        <!-- 开机自启动：行状，右侧是开关 -->
        <div class="settings-row">
            <div class="settings-row__body">
                <span class="settings-row__icon" aria-hidden="true">⚡</span>
                <div class="settings-row__text">
                    <h4 class="settings-row__title">开机自动启动</h4>
                    <p class="settings-row__desc">系统登录时自动启动 Kirari，开关切换即时生效。</p>
                </div>
            </div>
            <div class="settings-row__control">
                <label class="switch" aria-label="开机自动启动">
                    <input
                        type="checkbox"
                        v-model="autoLaunch"
                        :disabled="autoLaunchBusy"
                        @change="handleAutoLaunchChange"
                    />
                    <span class="switch__slider"></span>
                </label>
            </div>
        </div>
    </section>
</template>
