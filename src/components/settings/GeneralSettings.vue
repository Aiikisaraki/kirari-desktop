<script setup lang="ts">
/**
 * 通用：桌宠备注名 + 开机自启 + 她的状态（在场感）。
 * 「桌宠自带大脑」，所以这里没有本地/远程部署切换。
 */
import { onMounted, ref } from "vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

const autoLaunch = ref(false);
const autoLaunchBusy = ref(false);
const petName = ref("Kirari");
const petNameSaving = ref(false);

// ── 她的状态（在场感）────────────────────────────────────────────
// 让"她此刻是什么状态"变得可解释：心情摘要 + 今日主动开口次数 + 专注模式开关。
const presenceSummary = ref("还没有状态");
const outreachToday = ref(0);
const presenceFocus = ref(false);

type PresenceApi = {
    getStatus?: () => Promise<{ summary: string; outreachToday: number; focus: boolean }>;
    setFocus?: (on: boolean) => Promise<boolean>;
    onFocusChanged?: (cb: (on: boolean) => void) => void;
};
type WindowApi = {
    getAutoLaunch?: () => Promise<boolean>;
    setAutoLaunch?: (e: boolean) => Promise<void>;
    getPetName?: () => Promise<string>;
    setPetName?: (n: string) => Promise<void>;
    onPetNameChanged?: (cb: (name: string) => void) => void;
};


function presence(): PresenceApi | undefined {
    return (window as unknown as { presenceApi?: PresenceApi }).presenceApi;
}

async function loadPresence() {
    try {
        const p = presence();
        const s = await p?.getStatus?.();
        if (s) {
            presenceSummary.value = s.summary || "还没有状态";
            outreachToday.value = s.outreachToday ?? 0;
            presenceFocus.value = s.focus === true;
        }
        p?.onFocusChanged?.((on) => {
            presenceFocus.value = on;
        });
    } catch {
        /* 状态读取失败就显示默认值 */
    }
}

async function handleFocusChange() {
    try {
        const on = await presence()?.setFocus?.(presenceFocus.value);
        presenceFocus.value = on === true;
        emit("saved", presenceFocus.value ? "已开启专注模式：她不会主动打扰你" : "已恢复：她会按自己的节奏主动找你");
    } catch {
        /* 界面已回写 */
    }
}
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
    loadPresence();
});
</script>

<template>
    <section class="sk-page">
        <div class="sk-card">
            <div class="sk-row">
                <div class="sk-row__main">
                    <div>
                        <h3 class="sk-row__title">她的状态</h3>
                        <p class="sk-row__desc">{{ presenceSummary }}；今天已经主动找过你 {{ outreachToday }} 次（每天最多 4 次，23:30–08:00 是她的安静时段）。</p>
                    </div>
                </div>
            </div>

            <div class="sk-row">
                <div class="sk-row__main">
                    <div>
                        <h3 class="sk-row__title">专注模式（不主动打扰）</h3>
                        <p class="sk-row__desc">开启后她不会主动开口、不弹气泡；你自己找她聊天完全不受影响。右键桌宠菜单也有同一个开关。</p>
                    </div>
                </div>
                <div class="sk-row__control">
                    <label class="sk-switch" aria-label="专注模式">
                        <input type="checkbox" v-model="presenceFocus" @change="handleFocusChange" />
                        <span class="sk-switch__track" />
                    </label>
                </div>
            </div>
        </div>

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
