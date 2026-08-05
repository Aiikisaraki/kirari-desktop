<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { SETTINGS_CONTEXT } from "./settingsContext";
import { useApiToken } from "../../composables/useApiToken";
import { useToast } from "../../composables/useToast";

const { mode, authed, accountName, refreshAuth, login, register, logout } =
    inject(SETTINGS_CONTEXT)!;
const { getDeployConfig, setDeployServer, getProfile } = useApiToken();
const toast = useToast();

const authMode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const isLoading = ref(false);
const loginError = ref("");

// —— 远程服务端地址（仅 remote 模式可编辑） ——
const wsUrl = ref("");
const httpUrl = ref("");
const serverLoading = ref(false);
const serverError = ref("");
const serverSaved = ref(false);

async function loadServerConfig() {
    try {
        const cfg = await getDeployConfig();
        wsUrl.value = cfg.server?.wsUrl || "";
        httpUrl.value = cfg.server?.httpUrl || "";
        serverSaved.value = false;
    } catch {
        // 读取失败则保留空值
    }
}

// 进入远程模式时加载当前服务端地址（首次挂载或 local→remote 切换时）。
onMounted(() => {
    if (mode.value === "remote") loadServerConfig();
});
watch(mode, (m) => {
    if (m === "remote") loadServerConfig();
});

async function handleSaveServer() {
    serverError.value = "";
    serverSaved.value = false;
    if (!httpUrl.value.trim()) {
        serverError.value = "请填写 HTTP 地址";
        return;
    }
    serverLoading.value = true;
    try {
        await setDeployServer({
            wsUrl: wsUrl.value.trim(),
            httpUrl: httpUrl.value.trim(),
        });
        serverSaved.value = true;
        // 重新校验连接状态（刷新登录态等）
        await refreshAuth();
    } catch (err) {
        serverError.value = err instanceof Error ? err.message : "保存失败";
    } finally {
        serverLoading.value = false;
    }
}

async function handleLogin() {
    loginError.value = "";
    if (!username.value || !password.value) {
        loginError.value = "请输入用户名和密码";
        return;
    }
    isLoading.value = true;
    try {
        const r = await login(username.value, password.value);
        if (r.ok) {
            await refreshAuth();
            toast.success("登录成功");
            await afterAuthSuccess();
        } else {
            loginError.value = r.message || "登录失败";
        }
    } finally {
        isLoading.value = false;
    }
}

// 注册新账号：成功后用同一凭据自动登录，省去用户再登一次。
async function handleRegister() {
    loginError.value = "";
    if (!username.value || !password.value) {
        loginError.value = "请输入用户名和密码";
        return;
    }
    if (username.value.trim().length < 3) {
        loginError.value = "用户名至少 3 个字符";
        return;
    }
    if (password.value.length < 6) {
        loginError.value = "密码至少 6 位";
        return;
    }
    isLoading.value = true;
    try {
        const r = await register(username.value.trim(), password.value);
        if (!r.ok) {
            loginError.value = r.message || "注册失败";
            return;
        }
        const lr = await login(username.value.trim(), password.value);
        if (lr.ok) {
            await refreshAuth();
            toast.success("注册并登录成功");
            await afterAuthSuccess();
        } else {
            loginError.value = lr.message || "注册成功，但自动登录失败，请手动登录";
        }
    } finally {
        isLoading.value = false;
    }
}

// 登录/注册成功后：远程模式下若服务端尚未配置大模型，主动提示去「设置 → 模型」，
// 否则用户会直接发消息、后端才报“大模型未配置”，体验上毫无前兆。
async function afterAuthSuccess() {
    if (mode.value !== "remote") return;
    try {
        const profile = await getProfile();
        if (!profile.hasToken) {
            toast.warning("远程账号尚未配置大模型，请到「设置 → 模型」填写 API 信息后即可对话", 6000);
        }
    } catch {
        // 读取失败不阻塞，聊天窗口自身会在未配置时显示错误横幅兜底。
    }
}

function handleLogout() {
    logout();
    authed.value = false;
    accountName.value = "";
    username.value = "";
    password.value = "";
    loginError.value = "";
}
</script>

<template>
    <!--
        single root wrapper：避免 fragment 导致 SettingsPage 传入的
        class="settings-shell__card from-fade" 被 Vue 静默丢弃。
        这里只是占位元素，所有真实样式由内层 <section class="settings-card"> 承担。
    -->
    <div class="settings-account-wrap">
        <template v-if="mode === 'remote'">
            <!-- 远程服务端地址 -->
            <section class="settings-card">
                <h3 class="settings-card__title">
                    <span class="title-emoji">🌐</span>
                    <span>服务端地址</span>
                </h3>
            <p class="settings-card__desc">
                连接远程服务端时使用的地址。修改后自动重新连接，无需重启应用。
            </p>

            <!-- WebSocket 地址 -->
            <div class="settings-row">
                <div class="settings-row__body">
                    <span class="settings-row__icon" aria-hidden="true">🔗</span>
                    <div class="settings-row__text">
                        <h4 class="settings-row__title">WebSocket 地址</h4>
                        <p class="settings-row__desc">实时双向通道，用于桌宠 ↔ 服务端推拉消息。</p>
                    </div>
                </div>
                <div class="settings-row__control">
                    <input
                        v-model="wsUrl"
                        class="text-input"
                        type="text"
                        placeholder="ws://your-server:9089/ws"
                        :disabled="serverLoading"
                    />
                </div>
            </div>

            <!-- HTTP 地址 -->
            <div class="settings-row">
                <div class="settings-row__body">
                    <span class="settings-row__icon" aria-hidden="true">📡</span>
                    <div class="settings-row__text">
                        <h4 class="settings-row__title">HTTP 地址</h4>
                        <p class="settings-row__desc">REST 通道，用于登录、文件、配置同步。</p>
                    </div>
                </div>
                <div class="settings-row__control">
                    <input
                        v-model="httpUrl"
                        class="text-input"
                        type="text"
                        placeholder="http://your-server:9089"
                        :disabled="serverLoading"
                    />
                </div>
            </div>

            <!-- 操作 -->
            <div class="settings-card__group">
                <div class="btn-row">
                    <button
                        type="button"
                        class="btn btn--primary"
                        :disabled="serverLoading"
                        @click="handleSaveServer"
                    >
                        {{
                            serverLoading
                                ? "保存中..."
                                : serverSaved
                                  ? "已保存 ✓"
                                  : "保存并重新连接"
                        }}
                    </button>
                </div>
                <div v-if="serverError" class="settings-error">{{ serverError }}</div>
            </div>
        </section>

        <!-- 账号：登录 / 注册 -->
        <section id="account" class="settings-card">
            <!-- 未登录：登录 / 注册 -->
            <template v-if="!authed">
                <h3 class="settings-card__title">
                    <span class="title-emoji">🔑</span>
                    <span>{{
                        authMode === "login" ? "登录服务端" : "注册服务端账号"
                    }}</span>
                </h3>
                <p class="settings-card__desc">
                    {{
                        authMode === "login"
                            ? "连接远程服务端，验证通过后才能修改配置。"
                            : "创建服务端账号（用户名 3-32 字符、密码至少 6 位），注册成功后将自动登录。"
                    }}
                </p>

                <div class="auth-tabs">
                    <button
                        type="button"
                        class="auth-tab"
                        :class="{ 'is-active': authMode === 'login' }"
                        @click="authMode = 'login'"
                    >
                        登录
                    </button>
                    <button
                        type="button"
                        class="auth-tab"
                        :class="{ 'is-active': authMode === 'register' }"
                        @click="authMode = 'register'"
                    >
                        注册
                    </button>
                </div>

                <form id="auth-form" class="auth-form" @submit.prevent="authMode === 'login' ? handleLogin() : handleRegister()">
                    <label class="auth-field">
                        <span class="auth-field__label">用户名</span>
                        <span class="auth-field__hint">3-32 个字符，用于登录与显示</span>
                        <input
                            v-model="username"
                            class="text-input"
                            type="text"
                            autocomplete="username"
                            placeholder="用户名"
                            :disabled="isLoading"
                        />
                    </label>

                    <label class="auth-field">
                        <span class="auth-field__label">密码</span>
                        <span class="auth-field__hint">至少 6 位，注册 / 登录共用</span>
                        <input
                            v-model="password"
                            class="text-input"
                            type="password"
                            :autocomplete="
                                authMode === 'login' ? 'current-password' : 'new-password'
                            "
                            placeholder="密码"
                            :disabled="isLoading"
                        />
                    </label>
                </form>

                <div class="settings-card__group">
                    <div class="btn-row">
                        <button
                            type="submit"
                            form="auth-form"
                            class="btn btn--primary auth-submit"
                            :disabled="isLoading"
                            @click="authMode === 'login' ? handleLogin() : handleRegister()"
                        >
                            {{
                                isLoading
                                    ? authMode === "login"
                                        ? "登录中..."
                                        : "注册中..."
                                    : authMode === "login"
                                      ? "登录"
                                      : "注册"
                            }}
                        </button>
                    </div>
                    <div v-if="loginError" class="settings-error">{{ loginError }}</div>
                </div>
            </template>

            <!-- 已登录：账户信息 + 退出 -->
            <template v-else>
                <h3 class="settings-card__title">
                    <span class="title-emoji">🔑</span>
                    <span>服务端账号</span>
                </h3>
                <div class="account-bar">
                    <span class="account-bar__name">
                        当前账户：<span class="me">{{ accountName || "已登录" }}</span>
                    </span>
                    <button type="button" class="btn btn--link" @click="handleLogout">
                        退出登录
                    </button>
                </div>
            </template>
        </section>
        </template>
    </div>
</template>
