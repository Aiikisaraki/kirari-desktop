<script setup lang="ts">
/**
 * 通用：桌宠备注名 + 开机自启。
 * 「桌宠自带大脑」，所以这里没有本地/远程部署切换。
 */
import { onMounted, ref } from "vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

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
        emit("saved", "备注名已保存");
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
        emit("saved", autoLaunch.value ? "已设为开机自动启动" : "已取消开机自动启动");
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
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-row">
                <div class="sk-row__main">
                    <div>
                        <h3 class="sk-row__title">桌宠备注名</h3>
                        <p class="sk-row__desc">
                            聊天窗口和设置窗口都会显示这个名字，与核心版控制台共用同一份；默认 Kirari。
                        </p>
                    </div>
                </div>
                <div class="sk-row__control">
                    <input
                        id="petName"
                        v-model="petName"
                        class="sk-input"
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

            <div class="sk-row">
                <div class="sk-row__main">
                    <div>
                        <h3 class="sk-row__title">开机自动启动</h3>
                        <p class="sk-row__desc">系统登录时自动把桌宠叫起来。开关切换即时生效。</p>
                    </div>
                </div>
                <div class="sk-row__control">
                    <label class="sk-switch" aria-label="开机自动启动">
                        <input
                            type="checkbox"
                            v-model="autoLaunch"
                            :disabled="autoLaunchBusy"
                            @change="handleAutoLaunchChange"
                        />
                        <span class="sk-switch__track" />
                    </label>
                </div>
            </div>
        </div>

        <p class="sk-note">
            这台机器上的桌宠自带大脑，不需要再连服务端。想让几台设备共用一个大脑，去「连接 → 组网」。
        </p>
    </section>
</template>
