<script setup lang="ts">
/**
 * 组网设置页（阶段 4）。
 *
 * 界面对主机与叶子**完全相同**，只是背后按 role 走不同分支 —— 不写两套页面。
 *
 * 三条要遵守的产品规则（ARCHITECTURE-PLAN 6.x）：
 *  1. 组网是「工作模式」：关闭时页面内容**灰显**而不是隐藏，并说明为什么不可改。
 *  2. 退出组网不清除任何配置 —— 页面上要明确告诉用户「关掉不影响已连设备」。
 *  3. 加入组网会共用主机的额度 —— 必须在接入前明示，不能让用户无声消耗别人额度。
 *
 * 文案规范：不出现 WebSocket / Token / 适配器这类词。
 *   主机 = 这台设备；连接码 = 加入凭证；额度 = 大脑的使用额度。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useToast } from "../../composables/useToast";

type NetRole = "off" | "host" | "leaf";

type NetSnapshot = {
    role: NetRole;
    deviceId: string;
    deviceName: string;
    address: string;
    port: number;
    hostName?: string;
    pairings: {
        id: string;
        name: string;
        expiresAt: number;
        remaining: string;
        usedBy: string | null;
        revoked: boolean;
    }[];
    members: { deviceId: string; name: string; online: boolean; since: number }[];
    leafStatus?: string;
    pendingBackfill?: number;
    relay?: { running: number; queued: number; maxConcurrent: number; maxQueue: number } | null;
    syncWhitelist?: string[];
};

const netApi = (window as any).netApi;
const toast = useToast();

const snap = ref<NetSnapshot | null>(null);
/** 本构建是否带组网密钥（没有就整体禁用） */
const netEnabled = ref(true);
const addresses = ref<string[]>([]);
const busy = ref(false);

// ── 开启流程：由用户选择角色（这就是「角色由创建流程决定」）──
const showSetup = ref(false);
const setupRole = ref<"host" | "leaf">("host");

// 连接码相关
const newCode = ref("");
const expiry = ref("7d");
const codeInput = ref("");

// 本机显示名
const editingName = ref(false);
const nameDraft = ref("");

const EXPIRY_OPTIONS = [
    { value: "1h", label: "1 小时" },
    { value: "1d", label: "1 天" },
    { value: "7d", label: "7 天（推荐）" },
    { value: "30d", label: "30 天" },
    { value: "forever", label: "永不过期" },
];

/**
 * 可跟随主机的配置项。
 * 刻意不含「钥匙」类字段：组网时本来就用主机的，下发过去反而是风险。
 */
const SYNC_ITEMS = [
    { key: "model", label: "大脑型号", hint: "比如 gpt-5.4-mini" },
    { key: "endpoint", label: "连接地址", hint: "大脑服务的地址" },
    { key: "basePersona", label: "小灵的人格", hint: "说话风格与性格设定" },
    { key: "searchEndpoint", label: "搜索地址", hint: "联网搜索用的服务地址" },
    { key: "searchProvider", label: "搜索来源", hint: "用哪个搜索服务" },
] as const;

/** 当前白名单（只有主机侧有内容） */
const whitelist = ref<string[]>([]);

async function toggleSyncField(key: string, checked: boolean) {
    const next = checked
        ? [...new Set([...whitelist.value, key])]
        : whitelist.value.filter((k) => k !== key);
    const r = await netApi.setSyncWhitelist(next);
    whitelist.value = r.whitelist || [];
    if (r.snapshot) apply(r.snapshot);
    toast.success(checked ? "其他设备会跟着这台设备走" : "各设备自己管，不互相影响");
}

const isHost = computed(() => snap.value?.role === "host");
const isLeaf = computed(() => snap.value?.role === "leaf");
const isOff = computed(() => snap.value?.role === "off");
const online = computed(() => snap.value?.leafStatus === "connected");
const pendingBackfill = computed(() => snap.value?.pendingBackfill ?? 0);

/** 未开启组网时整页灰显 */
const dimmed = computed(() => isOff.value);

/** 叶子侧状态的大白话说明 */
const leafStatusText = computed(() => {
    const s = snap.value?.leafStatus;
    if (s === "connected") return `已连接到 ${snap.value?.hostName || "主机"}`;
    if (s === "connecting") return "正在连接主机…";
    if (s === "fallback") return "已退出组网，现在可以独立工作";
    return "未连接";
});

function apply(s: NetSnapshot | null) {
    if (!s) return;
    snap.value = s;
    // 白名单以主机侧为准（叶子侧恒为 undefined）
    if (s.syncWhitelist) whitelist.value = [...s.syncWhitelist];
    if (!editingName.value) nameDraft.value = s.deviceName;
}

async function load() {
    if (!netApi) {
        toast.error("组网功能不可用");
        return;
    }
    try {
        apply(await netApi.getState());
        addresses.value = (await netApi.addresses()) || [];
        try {
            netEnabled.value = (await netApi.enabled())?.enabled !== false;
        } catch {
            netEnabled.value = true;
        }
    } catch {
        toast.error("读取组网状态失败");
    }
}

async function openAsHost() {
    if (busy.value) return;
    busy.value = true;
    try {
        const r = await netApi.startHost(expiry.value);
        if (r.ok) {
            newCode.value = r.code || "";
            qrDataUrl.value = "";
            apply(r.snapshot);
            toast.success("已开始提供出口，其他设备可以填连接码接入");
        } else {
            toast.error(r.error || "开启失败");
        }
    } finally {
        busy.value = false;
    }
}

async function joinAsLeaf() {
    if (busy.value) return;
    const text = codeInput.value.trim();
    if (!text) {
        toast.error("先把主机给你的连接码整串粘进来");
        return;
    }
    busy.value = true;
    try {
        const r = await netApi.join(text);
        if (r.ok) {
            apply(r.snapshot);
            codeInput.value = "";
            toast.success("已接入");
        } else {
            toast.error(r.error || "接入失败");
        }
    } finally {
        busy.value = false;
    }
}

/**
 * 打开组网开关。
 * 之前当过叶子 → 直接用已保存的凭据接回，不需要重新填码（退出不清除的兑现）。
 */
async function turnOn() {
    if (isLeaf.value && snap.value?.hostName) {
        busy.value = true;
        try {
            const r = await netApi.resume();
            if (r.ok) {
                apply(r.snapshot);
                toast.success("已接回主机");
            } else {
                // 凭据没了才需要重新填码
                setupRole.value = "leaf";
                showSetup.value = true;
                toast.error(r.error || "需要重新填一次连接码");
            }
        } finally {
            busy.value = false;
        }
        return;
    }
    showSetup.value = true;
}

async function turnOff() {
    busy.value = true;
    try {
        apply((await netApi.stop()).snapshot);
        toast.success("已退出组网，现在可以独立工作");
    } finally {
        busy.value = false;
    }
}

async function issuePairing() {
    busy.value = true;
    try {
        const r = await netApi.issuePairing(expiry.value);
        if (r.ok) {
            newCode.value = r.code || "";
            qrDataUrl.value = "";
            apply(r.snapshot);
        }
    } finally {
        busy.value = false;
    }
}

async function copyCode() {
    if (!newCode.value) return;
    try {
        await navigator.clipboard.writeText(newCode.value);
        toast.success("已复制，别把它发到公开的地方");
    } catch {
        toast.error("复制失败，手动选中复制吧");
    }
}

/** 二维码：内容就是连接码本身，生成在主进程（不让 qrcode 进渲染层产物） */
const showQr = ref(false);
const qrDataUrl = ref("");

async function toggleQr() {
    showQr.value = !showQr.value;
    if (!showQr.value) return;
    if (qrDataUrl.value) return;
    const r = await netApi.codeQr(newCode.value);
    if (r.ok && r.dataUrl) qrDataUrl.value = r.dataUrl;
    else toast.error(r.error || "二维码生成失败");
}

async function revoke(id: string) {
    apply((await netApi.revokePairing(id)).snapshot);
    toast.success("已撤销，之后不能用了");
}

async function removeDevice(deviceId: string, name: string) {
    apply((await netApi.removeDevice(deviceId)).snapshot);
    toast.success(`已把 ${name} 移出组网`);
}

async function leaveHost() {
    apply((await netApi.leaveHost()).snapshot);
    toast.success("已移除自己，与主机的连接信息也清掉了");
}

async function saveName() {
    editingName.value = false;
    apply((await netApi.renameSelf(nameDraft.value)).snapshot);
}

async function flushNow() {
    apply((await netApi.flushBackfill()).snapshot);
    toast.success("已同步");
}

/** 成员列表（主机侧）：自己 + 其他设备 */
const memberRows = computed(() => {
    const s = snap.value;
    if (!s) return [];
    const rows = [
        { deviceId: s.deviceId, name: `${s.deviceName}（这台设备）`, online: true, isSelf: true },
        ...s.members.map((m) => ({ ...m, isSelf: false })),
    ];
    return rows;
});

let offState: ((s: NetSnapshot) => void) | null = null;

onMounted(() => {
    void load();
    offState = (s: NetSnapshot) => apply(s);
    netApi?.onState?.(offState);
});

onUnmounted(() => {
    // ipcRenderer 的 on 是累积的，这里不解绑也没关系（设置窗口销毁即失效）
});
</script>

<template>
    <section id="sync" class="settings-card">
        <h3 class="settings-card__title">
            <span class="title-emoji">🔗</span>
            <span>组网</span>
        </h3>
        <p class="settings-card__desc">
            让家里几台设备共用一个大脑。开启后只有一台在干活（主机），其他设备把问题交给它，
            这样一份回复只会有一个，不会几台设备抢着回答。
        </p>

        <!-- 没有密钥的构建：明确说清为什么不可用（灰显而非隐藏） -->
        <div v-if="!netEnabled" class="settings-hint" style="margin-bottom: 8px">
            当前这个版本没有包含组网密钥，无法使用组网功能。
        </div>

        <!-- ── 总开关 ─────────────────────────────────────────── -->
        <div class="settings-row">
            <div class="settings-row__body">
                <span class="settings-row__icon" aria-hidden="true">⚡</span>
                <div class="settings-row__text">
                    <h4 class="settings-row__title">组网总开关</h4>
                    <p class="settings-row__desc">
                        <template v-if="isOff">
                            现在是独立工作，各用各的。开启后可以选「让这台设备当主机」或「接入别人的主机」。
                        </template>
                        <template v-else-if="isHost">
                            这台设备正在当主机，为其他设备提供出口。
                        </template>
                        <template v-else>
                            这台设备{{ leafStatusText }}。
                        </template>
                    </p>
                </div>
            </div>
            <div class="settings-row__control">
                <button
                    v-if="isOff"
                    type="button"
                    class="btn btn--primary btn--sm"
                    :disabled="busy || !netEnabled"
                    @click="turnOn"
                >
                    开启组网
                </button>
                <button
                    v-else
                    type="button"
                    class="btn btn--ghost btn--sm"
                    :disabled="busy"
                    @click="turnOff"
                >
                    退出组网
                </button>
            </div>
        </div>

        <!-- ── 未开启时：整页灰显 + 说明为什么不可改 ──────────── -->
        <div v-if="dimmed" class="settings-hint" style="margin: 12px 0">
            下面的内容要开启组网后才能使用 —— 现在组网是关的。
        </div>

        <div :class="{ 'is-dimmed': dimmed }" style="display: flex; flex-direction: column; gap: 4px">
            <!-- ── 本机名称 ─────────────────────────────────── -->
            <div class="settings-row">
                <div class="settings-row__body">
                    <span class="settings-row__icon" aria-hidden="true">🏷️</span>
                    <div class="settings-row__text">
                        <h4 class="settings-row__title">这台设备的名字</h4>
                        <p class="settings-row__desc">其他设备在成员列表里看到的就是这个名字</p>
                    </div>
                </div>
                <div class="settings-row__control">
                    <template v-if="editingName">
                        <input
                            v-model="nameDraft"
                            class="text-input"
                            type="text"
                            maxlength="24"
                            style="width: 160px"
                            @keyup.enter="saveName"
                        />
                        <button type="button" class="btn btn--primary btn--sm" @click="saveName">保存</button>
                    </template>
                    <button
                        v-else
                        type="button"
                        class="btn btn--ghost btn--sm"
                        @click="editingName = true"
                    >
                        {{ snap?.deviceName || "改名" }}
                    </button>
                </div>
            </div>

            <!-- ── 主机侧 ───────────────────────────────────── -->
            <template v-if="isHost">
                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">📱</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">连接码</h4>
                            <p class="settings-row__desc">
                                其他设备填这一串就能接进来。<strong>一串码只能用一次</strong>，
                                接一台设备生成一串。
                            </p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <select v-model="expiry" class="settings-select" style="width: 150px">
                            <option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">
                                {{ o.label }}
                            </option>
                        </select>
                        <button type="button" class="btn btn--primary btn--sm" :disabled="busy" @click="issuePairing">
                            生成连接码
                        </button>
                    </div>
                </div>

                <!-- 连接码展示 -->
                <div v-if="newCode" class="settings-hint" style="padding: 12px">
                    <div style="word-break: break-all; font-family: monospace; margin-bottom: 8px">
                        {{ newCode }}
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
                        <button type="button" class="btn btn--primary btn--sm" @click="copyCode">复制</button>
                        <button type="button" class="btn btn--ghost btn--sm" @click="toggleQr">
                            {{ showQr ? "收起二维码" : "看二维码" }}
                        </button>
                        <span style="opacity: 0.75">只用来首次配对，配好后就不用再填了</span>
                    </div>

                    <!-- 二维码：内容就是连接码本身 -->
                    <div v-if="showQr" style="margin-top: 12px">
                        <img
                            v-if="qrDataUrl"
                            :src="qrDataUrl"
                            alt="连接码二维码"
                            style="width: 220px; height: 220px; border-radius: 8px; background: #fff"
                        />
                        <div v-else style="opacity: 0.7">正在生成…</div>
                        <p style="margin-top: 8px; opacity: 0.85">
                            <strong>扫一下最稳。</strong>连接码是加密过的乱码，手动粘贴容易漏字符。
                        </p>
                    </div>
                </div>

                <!-- 本机地址 -->
                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">📍</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">这台设备的地址</h4>
                            <p class="settings-row__desc">
                                其他设备要在这台机器上打开端口 {{ snap?.port }}。
                                首次接入如果连不上，多半是防火墙拦了这个端口。
                            </p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <span style="font-family: monospace">{{ snap?.address }}:{{ snap?.port }}</span>
                    </div>
                </div>

                <!-- 设备列表 -->
                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">👥</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">已接入的设备</h4>
                            <p class="settings-row__desc">移除后那台设备就再也连不上了</p>
                        </div>
                    </div>
                </div>
                <div
                    v-for="m in memberRows"
                    :key="m.deviceId"
                    class="settings-row"
                    style="padding-left: 32px"
                >
                    <div class="settings-row__body">
                        <div class="settings-row__text">
                            <h4 class="settings-row__title" style="font-weight: 500">
                                {{ m.name }}
                                <span
                                    class="badge-dot"
                                    :style="{
                                        background: m.online ? '#4caf50' : '#9e9e9e',
                                        display: 'inline-block',
                                        marginRight: '4px',
                                    }"
                                />
                                <span style="font-size: 12px; opacity: 0.7">
                                    {{ m.online ? "在线" : "离线" }}
                                </span>
                            </h4>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <button
                            v-if="!m.isSelf"
                            type="button"
                            class="btn btn--ghost btn--sm"
                            @click="removeDevice(m.deviceId, m.name)"
                        >
                            移除
                        </button>
                    </div>
                </div>

                <!-- 出口忙不忙 -->
                <div v-if="snap?.relay && (snap.relay.running > 0 || snap.relay.queued > 0)" class="settings-hint">
                    正在处理 {{ snap.relay.running }} 个请求，排队 {{ snap.relay.queued }} 个
                </div>

                <!-- 额度明示（必须） -->
                <div class="settings-hint" style="margin-top: 12px">
                    组网期间，<strong>其他设备的提问也会用这台设备的大脑额度</strong>。
                    所以只把连接码给家里信得过的人。
                </div>

                <!-- ── 同步白名单（只有主机有）─────────────────── -->
                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">📋</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">统一哪些配置</h4>
                            <p class="settings-row__desc">
                                勾上的项目会下发到所有设备，所有人跟着这台设备走；
                                不勾的各管各的，互不干扰。
                            </p>
                        </div>
                    </div>
                </div>
                <div
                    v-for="f in SYNC_ITEMS"
                    :key="f.key"
                    class="settings-row"
                    style="padding-left: 32px"
                >
                    <div class="settings-row__body">
                        <div class="settings-row__text">
                            <h4 class="settings-row__title" style="font-weight: 500">{{ f.label }}</h4>
                            <p class="settings-row__desc">{{ f.hint }}</p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <label class="checkbox-row">
                            <input
                                type="checkbox"
                                :checked="whitelist.includes(f.key)"
                                @change="toggleSyncField(f.key, ($event.target as HTMLInputElement).checked)"
                            />
                            <span>跟随主机</span>
                        </label>
                    </div>
                </div>
                <div class="settings-hint">
                    密钥不会下发 —— 组网时本来就用这台设备的，其他设备不用单独配置。
                </div>
            </template>

            <!-- ── 叶子侧 ───────────────────────────────────── -->
            <template v-else-if="isLeaf">
                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">📡</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">连接状态</h4>
                            <p class="settings-row__desc">
                                <template v-if="online">
                                    已连接到 <strong>{{ snap?.hostName }}</strong>，聊天会用它的大脑。
                                </template>
                                <template v-else>
                                    没连上主机，现在用的是这台设备自己的大脑。
                                    主机那边重新打开组网后，这里打开开关就能自动接回，不用重新填连接码。
                                </template>
                            </p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <button
                            v-if="!online"
                            type="button"
                            class="btn btn--primary btn--sm"
                            :disabled="busy"
                            @click="turnOn"
                        >
                            重新接入
                        </button>
                    </div>
                </div>

                <!-- 断线期间的待同步 -->
                <div v-if="pendingBackfill > 0" class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">📥</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">有 {{ pendingBackfill }} 条对话没同步</h4>
                            <p class="settings-row__desc">
                                这些是断线期间本机独立聊的。同步只是把记录传给主机留档，
                                不会重新问一遍大脑，也不会重复显示给别人。
                            </p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <button type="button" class="btn btn--ghost btn--sm" @click="flushNow">立即同步</button>
                    </div>
                </div>

                <div class="settings-row">
                    <div class="settings-row__body">
                        <span class="settings-row__icon" aria-hidden="true">🔌</span>
                        <div class="settings-row__text">
                            <h4 class="settings-row__title">与主机的连接</h4>
                            <p class="settings-row__desc">
                                移除后会清掉本机的连接信息，下次要重新填连接码。
                            </p>
                        </div>
                    </div>
                    <div class="settings-row__control">
                        <button type="button" class="btn btn--ghost btn--sm" @click="leaveHost">
                            移除自己
                        </button>
                    </div>
                </div>

                <!-- 额度明示（必须） -->
                <div class="settings-hint" style="margin-top: 12px">
                    加入组网后，<strong>你的提问会消耗主机的大脑额度</strong>。
                    主机那边能看到你在问什么。
                </div>
            </template>
        </div>

        <!-- ── 开启流程：选角色 ─────────────────────────────── -->
        <div v-if="showSetup" class="settings-confirm">
            <p class="settings-confirm__text">
                <template v-if="snap?.hostName && !isOff">
                    这台设备之前接入过 {{ snap.hostName }}。重新接入不需要填码。
                </template>
                <template v-else>
                    选择这台设备在组网里的角色，随时可以改。
                </template>
            </p>

            <div class="segmented" role="radiogroup" style="margin: 12px 0">
                <button
                    type="button"
                    class="segmented__item"
                    :class="{ 'is-active': setupRole === 'host' }"
                    role="radio"
                    :aria-checked="setupRole === 'host'"
                    @click="setupRole = 'host'"
                >
                    当主机
                </button>
                <button
                    type="button"
                    class="segmented__item"
                    :class="{ 'is-active': setupRole === 'leaf' }"
                    role="radio"
                    :aria-checked="setupRole === 'leaf'"
                    @click="setupRole = 'leaf'"
                >
                    接入别的主机
                </button>
            </div>

            <!-- 主机：有效期 + 开始 -->
            <div v-if="setupRole === 'host'">
                <div class="field">
                    <label class="field-label" for="expiry">连接码有效期</label>
                    <select id="expiry" v-model="expiry" class="settings-select">
                        <option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">
                            {{ o.label }}
                        </option>
                    </select>
                    <p class="settings-hint">
                        过期只是不让新设备再接入，<strong>已经接进来的设备不受影响</strong>。
                    </p>
                </div>
                <p class="settings-hint">
                    开启后这台设备会为其他设备提供大脑。其他设备的提问会消耗这台设备的额度，
                    请只把连接码给家里信得过的人。
                </p>
                <div class="settings-confirm__actions">
                    <button type="button" class="btn btn--ghost btn--sm" @click="showSetup = false">取消</button>
                    <button type="button" class="btn btn--primary btn--sm" :disabled="busy" @click="openAsHost">
                        开始当主机
                    </button>
                </div>
            </div>

            <!-- 叶子：填码 -->
            <div v-else>
                <div class="field">
                    <label class="field-label" for="pairing">连接码</label>
                    <textarea
                        id="pairing"
                        v-model="codeInput"
                        class="text-input"
                        rows="3"
                        placeholder="把主机那边显示的那一整串粘进来"
                    />
                    <p class="settings-hint">
                        连接码同时也是密码，粘的时候小心别粘到公开的聊天里。
                    </p>
                </div>
                <p class="settings-hint">
                    接入后这台设备不再单独调用大脑，提问会交给主机回答，
                    <strong>消耗的是主机的额度</strong>。
                </p>
                <div class="settings-confirm__actions">
                    <button type="button" class="btn btn--ghost btn--sm" @click="showSetup = false">取消</button>
                    <button type="button" class="btn btn--primary btn--sm" :disabled="busy" @click="joinAsLeaf">
                        接入
                    </button>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.is-dimmed {
    opacity: 0.5;
    /* 灰显期间不可交互，但内容仍可见 —— 说明「为什么不可改」而不是藏起来 */
    pointer-events: none;
    filter: grayscale(0.4);
}
</style>
