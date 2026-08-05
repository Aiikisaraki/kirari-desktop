<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";

const { getDeployConfig, getCapabilities, switchMode } = useApiToken();

const autoLaunch = ref(false);
const autoLaunchBusy = ref(false);
const petName = ref("Kirari");
const petNameSaving = ref(false);

// ── 部署模式切换 ──────────────────────────────────────────────────────
// 本地部署 ⇄ 连接远程服务端。切换会清除对方模式残留（登录态/连接配置）并重启，
// 因此无需用户手动登出重配。前端仅负责展示与确认，实际清理在主进程完成。
const deployMode = ref<"local" | "remote">("local");
const localAvailable = ref(true);
const pendingMode = ref<"local" | "remote" | null>(null);
const switching = ref(false);
const switchError = ref("");

async function loadDeploy() {
    try {
        const [cfg, cap] = await Promise.all([getDeployConfig(), getCapabilities()]);
        deployMode.value = cfg.mode;
        localAvailable.value = cap.localAvailable;
    } catch {
        /* 读取失败则保留默认 */
    }
}

function chooseMode(target: "local" | "remote") {
    if (target === deployMode.value) return;
    if (target === "local" && !localAvailable.value) return;
    pendingMode.value = target;
}

function cancelSwitch() {
    pendingMode.value = null;
    switchError.value = "";
}

async function confirmSwitch() {
    if (!pendingMode.value) return;
    switching.value = true;
    switchError.value = "";
    try {
        await switchMode(pendingMode.value);
        // 主进程随后会清除残留并重启，此处无需后续处理
    } catch (e) {
        switching.value = false;
        pendingMode.value = null;
        switchError.value = e instanceof Error ? e.message : "切换失败";
    }
}

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
    loadDeploy();
});
</script>

<template>
    <section id="general" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">✨</span>
            <span>通用</span>
        </h3>
        <p class="settings-card__desc">
            桌宠姓名、启动行为与部署模式，与外观/账号相互独立。
        </p>

        <!-- 部署模式：行状，右侧是分段选择器；切换会清残留并重启 -->
        <div class="settings-row">
            <div class="settings-row__body">
                <span class="settings-row__icon" aria-hidden="true">🔗</span>
                <div class="settings-row__text">
                    <h4 class="settings-row__title">部署模式</h4>
                    <p class="settings-row__desc">
                        本地部署：随程序启动内置后端，无需额外服务器。连接远程服务端：连接你已部署的 Kirari 服务端。切换会清除当前模式的登录态与连接配置并重启应用。
                    </p>
                </div>
            </div>
            <div class="settings-row__control">
                <div
                    class="segmented"
                    role="radiogroup"
                    aria-label="部署模式"
                >
                    <button
                        type="button"
                        class="segmented__item"
                        :class="{ 'is-active': deployMode === 'local' }"
                        :disabled="!localAvailable"
                        role="radio"
                        :aria-checked="deployMode === 'local'"
                        @click="chooseMode('local')"
                    >
                        本地部署
                    </button>
                    <button
                        type="button"
                        class="segmented__item"
                        :class="{ 'is-active': deployMode === 'remote' }"
                        role="radio"
                        :aria-checked="deployMode === 'remote'"
                        @click="chooseMode('remote')"
                    >
                        远程服务端
                    </button>
                </div>
            </div>
        </div>

        <!-- 切换确认（内联，避免引入新 IPC 弹窗） -->
        <div v-if="pendingMode" class="settings-confirm">
            <p class="settings-confirm__text">
                切换到「{{ pendingMode === 'local' ? '本地部署' : '连接远程服务端' }}」会清除当前模式的登录态与连接配置，并重启应用。确定继续吗？
            </p>
            <div class="settings-confirm__actions">
                <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    :disabled="switching"
                    @click="cancelSwitch"
                >
                    取消
                </button>
                <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    :disabled="switching"
                    @click="confirmSwitch"
                >
                    {{ switching ? "重启中…" : "确定切换" }}
                </button>
            </div>
            <p v-if="switchError" class="settings-error">{{ switchError }}</p>
        </div>

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
