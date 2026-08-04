<script setup lang="ts">
import { computed, onMounted, provide, ref } from "vue";
import WindowChrome from "../common/WindowChrome.vue";
import SettingsNav from "./SettingsNav.vue";
import AppearanceSettings from "./AppearanceSettings.vue";
import GeneralSettings from "./GeneralSettings.vue";
import AvatarSettings from "./AvatarSettings.vue";
import AccountSettings from "./AccountSettings.vue";
import ModelConfigSettings from "./ModelConfigSettings.vue";
import BotAdapterSettings from "./BotAdapterSettings.vue";
import McpSettings from "./McpSettings.vue";
import SkillSettings from "./SkillSettings.vue";
import { useApiToken } from "../../composables/useApiToken";
import { SETTINGS_CONTEXT, type SettingsContext } from "./settingsContext";

const { getDeployConfig, login, register, getProfile, logout } = useApiToken();

const mode = ref<"local" | "remote">("local");
const authed = ref(false);
const accountName = ref("");
const error = ref("");
const petName = ref("Kirari");
const activeId = ref<string>("appearance");

function setActiveId(id: string) {
    activeId.value = id;
}

async function refreshAuth() {
    try {
        const config = await getDeployConfig();
        mode.value = config.mode;
        if (config.mode === "local") {
            // 本地内置账户：必须真正向后端验证内置令牌是否已被接受，
            // 不能无条件视为已登录（否则会与后端实际拒绝握手的凭证状态不一致）。
            try {
                const profile = await getProfile();
                authed.value = true;
                accountName.value = profile.username || "本地内置账户";
            } catch (err) {
                authed.value = false;
                accountName.value = "";
                error.value =
                    err instanceof Error && err.message
                        ? `内置账户令牌未被后端接受：${err.message}（请检查服务端 BUILTIN_ACCOUNT_TOKEN 与本地配置是否一致）`
                        : "内置账户令牌未被后端接受，请检查后端状态或内置令牌配置";
            }
            return;
        }
        try {
            const profile = await getProfile();
            authed.value = true;
            accountName.value = profile.username;
        } catch {
            authed.value = false;
            accountName.value = "";
        }
    } catch {
        authed.value = false;
    }
}

async function loadPetName() {
    try {
        const w = window as unknown as {
            windowApi?: { getPetName?: () => Promise<string> };
        };
        if (w.windowApi?.getPetName) {
            const name = await w.windowApi.getPetName();
            if (name) petName.value = name;
        }
    } catch {
        /* 保留默认 */
    }
}

const ctx: SettingsContext = {
    mode,
    authed,
    accountName,
    refreshAuth,
    login,
    register,
    logout,
};
provide(SETTINGS_CONTEXT, ctx);

// 导航项：远端模式才显示「账号」分区。
const sections = computed(() => {
    const list: { id: string; label: string; emoji: string }[] = [
        { id: "appearance", label: "外观", emoji: "🎨" },
        { id: "general", label: "通用", emoji: "✨" },
        { id: "avatar", label: "形象", emoji: "🐾" },
    ];
    if (mode.value === "remote") list.push({ id: "account", label: "账号", emoji: "🔑" });
    list.push(
        { id: "model", label: "模型", emoji: "🧠" },
        { id: "mcp", label: "MCP", emoji: "🔌" },
        { id: "skill", label: "技能", emoji: "🧩" },
        { id: "bot", label: "机器人", emoji: "🤖" },
    );
    return list;
});

const activeLabel = computed(() => {
    const m = sections.value.find((s) => s.id === activeId.value);
    return m ? `${m.emoji} ${m.label}` : "✨ 准备就绪";
});

onMounted(() => {
    refreshAuth();
    loadPetName();
});
</script>

<template>
    <div class="app-shell">
        <WindowChrome title="设置" />
        <div class="settings-root">
            <section class="settings-top" aria-label="设置概览">
                <header class="settings-greeting">
                    <span class="settings-greeting__avatar" aria-hidden="true">🐾</span>
                    <p class="settings-greeting__text">
                        <span class="settings-greeting__hi">Hi</span>
                        <span class="settings-greeting__name">{{ petName }}</span>
                        <span class="settings-greeting__sub">· {{ activeLabel }}</span>
                    </p>
                    <p v-if="error" class="settings-greeting__error">{{ error }}</p>
                    <span class="settings-greeting__spacer" />
                    <span
                        v-if="mode === 'remote'"
                        class="settings-greeting__badge"
                        :class="{ 'is-on': authed, 'is-off': !authed }"
                    >
                        <span class="badge-dot" />
                        {{ authed ? "已登录" : "未登录" }}
                    </span>
                </header>
                <SettingsNav :sections="sections" @update:active-id="setActiveId" />
            </section>
            <main class="settings-main">
                <div class="settings-main__inner">
                    <AppearanceSettings />
                    <GeneralSettings />
                    <AvatarSettings />
                    <AccountSettings />
                    <ModelConfigSettings />
                    <McpSettings />
                    <SkillSettings />
                    <BotAdapterSettings />
                </div>
            </main>
        </div>
    </div>
</template>
