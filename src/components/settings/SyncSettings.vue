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
 *   主机 = 这台设备；连接码 = 加入凭证（一次性、可撤销）；额度 = 大脑的使用额度。
 *
 * ⚠️ 「连接码」现在是**邀请码**：对方事先不需要有任何密钥，密钥在配对那一刻
 *    才发给它。所以别再写「必须和主机用同一个版本/同一把密钥」这类说明。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

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
const emit = defineEmits<{ saved: [msg?: string] }>();
const errorMsg = ref("");

const snap = ref<NetSnapshot | null>(null);
/** 这个版本能不能用组网（被发行者整体关掉时为 false，整块灰显） */
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
    emit("saved", checked ? "已更新同步范围" : "已更新同步范围");
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
        errorMsg.value = "组网功能不可用";
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
        errorMsg.value = "读取组网状态失败";
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
            emit("saved", "已开始提供出口，其他设备可以填连接码接入");
        } else {
            errorMsg.value = r.error || "开启失败";
        }
    } finally {
        busy.value = false;
    }
}

async function joinAsLeaf() {
    if (busy.value) return;
    const text = codeInput.value.trim();
    if (!text) {
        errorMsg.value = "先把主机给你的连接码整串粘进来";
        return;
    }
    busy.value = true;
    try {
        const r = await netApi.join(text);
        if (r.ok) {
            apply(r.snapshot);
            codeInput.value = "";
            emit("saved", "已接入主机");
        } else {
            errorMsg.value = r.error || "接入失败";
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
                emit("saved", "已接回主机");
            } else {
                // 凭据没了才需要重新填码
                setupRole.value = "leaf";
                showSetup.value = true;
                errorMsg.value = r.error || "需要重新填一次连接码";
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
        emit("saved", "已退出组网，现在可以独立工作");
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
        emit("saved", "已复制，别把它发到公开的地方");
    } catch {
        errorMsg.value = "复制失败，手动选中复制吧";
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
    else errorMsg.value = r.error || "二维码生成失败";
}

/** 还没作废的连接码：可以在这里撤销，撤销后别人再拿这串也接不进来 */
const activePairings = computed(
    () => (snap.value?.pairings ?? []).filter((p) => !p.revoked),
);

async function revoke(id: string) {
    apply((await netApi.revokePairing(id)).snapshot);
    emit("saved", "已撤销，之后不能用了");
}

async function removeDevice(deviceId: string, name: string) {
    apply((await netApi.removeDevice(deviceId)).snapshot);
    emit("saved", `已把 ${name} 移出组网`);
}

async function leaveHost() {
    apply((await netApi.leaveHost()).snapshot);
    emit("saved", "已移除自己，与主机的连接信息也清掉了");
}

async function saveName() {
    editingName.value = false;
    apply((await netApi.renameSelf(nameDraft.value)).snapshot);
}

async function flushNow() {
    apply((await netApi.flushBackfill()).snapshot);
    emit("saved", "已同步");
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

/**
 * 各叶子节点自报的工具能力（阶段 5）。
 *
 * 用户 2026-11-20：「在主机上可以列出所有叶子节点」——光有设备名不够，
 * 还得能在界面上看见「那台机器上到底装了哪些 MCP / skill」，否则点名让
 * 它干活时心里没底。数据来自叶子连上主机时上报的 tool_caps_report。
 */
type DeviceCaps = {
    deviceId: string;
    name: string;
    mcpServers: string[];
    skills: string[];
    toolNames: { name: string; source: "mcp" | "skill"; owner: string }[];
};
const deviceCaps = ref<Record<string, DeviceCaps>>({});

async function loadDeviceCaps() {
    try {
        const r = await netApi?.devices?.();
        const next: Record<string, DeviceCaps> = {};
        for (const d of (r?.devices || []) as DeviceCaps[]) next[d.deviceId] = d;
        deviceCaps.value = next;
    } catch {
        // 能力清单是锦上添花：拿不到就不显示，不影响组网本身
        deviceCaps.value = {};
    }
}

/** 某台设备的工具摘要（一行说清装了什么） */
function capsSummary(deviceId: string): string {
    const c = deviceCaps.value[deviceId];
    if (!c) return "";
    const parts: string[] = [];
    if (c.mcpServers?.length) parts.push(`MCP ${c.mcpServers.length} 个`);
    if (c.skills?.length) parts.push(`技能 ${c.skills.length} 个`);
    if (!parts.length) return "";
    return `可以远程调用：${parts.join("、")}`;
}

let offState: ((s: NetSnapshot) => void) | null = null;

onMounted(() => {
    void load();
    void loadDeviceCaps();
    offState = (s: NetSnapshot) => {
        apply(s);
        // 成员变动（有设备连上/掉线）时刷一次能力清单：
        // 叶子刚连上时会稍后上报，所以这里不追求即时，靠用户再进设置页也能看到。
        void loadDeviceCaps();
    };
    netApi?.onState?.(offState);
});

onUnmounted(() => {
    // ipcRenderer 的 on 是累积的，这里不解绑也没关系（设置窗口销毁即失效）
});
</script>

<template>
    <section class="sk-page">
        <!-- 组网被这个版本整体关掉时：明确说清（灰显而非隐藏） -->
        <p v-if="!netEnabled" class="sk-alert sk-alert--warn"><SettingsIcon name="alert" /><span>当前这个版本的组网功能被关掉了，无法使用。</span></p>
        <p v-if="errorMsg" class="sk-alert sk-alert--error"><SettingsIcon name="alert" /><span>{{ errorMsg }}</span></p>

        <div class="sk-card"><div class="sk-card__head"><div><h2 class="sk-card__title">组网总开关</h2><p class="sk-card__desc"><template v-if="isOff">现在是独立工作，各用各的。开启后可以选「让这台设备当主机」或「接入别人的主机」。</template><template v-else-if="isHost">这台设备正在当主机，为其他设备提供出口。</template><template v-else>这台设备{{ leafStatusText }}。</template></p></div></div>
        <div class="sk-card__body"><div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">工作模式</h3><p class="sk-row__desc">退出组网不会清除本机配置，已接入的设备不受影响。</p></div></div><div class="sk-row__control"><button v-if="isOff" type="button" class="sk-btn sk-btn--primary" :disabled="busy || !netEnabled" @click="turnOn">开启组网</button><button v-else type="button" class="sk-btn sk-btn--ghost" :disabled="busy" @click="turnOff">退出组网</button></div></div></div>
        <p v-if="dimmed" class="sk-note">下面的内容要开启组网后才能使用 —— 现在组网是关的。</p></div>
        <div :class="{ 'is-dimmed': dimmed, 'sk-muted': dimmed, 'sk-dimmed': dimmed }">
        <!-- ── 总开关 ─────────────────────────────────────────── -->
        <!-- ── 设备信息 ── -->
        <div class="sk-card">
            <div class="sk-card__head"><div><h2 class="sk-card__title">这台设备</h2><p class="sk-card__desc">其他设备会在成员列表里看到的名字；设备号是组网里的唯一标识。</p></div></div>
            <div class="sk-card__body sk-list">
            <!-- ── 本机名称 ─────────────────────────────────── -->
            <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">设备名称</h3><p class="sk-row__desc">其他设备在成员列表里看到的就是这个名字。</p></div></div><div class="sk-row__control"><template v-if="editingName"><input v-model="nameDraft" class="sk-input sk-input--sm" maxlength="24" @keyup.enter="saveName" /><button type="button" class="sk-btn sk-btn--primary sk-btn--sm" @click="saveName">保存</button></template><button v-else type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="editingName = true">{{ snap?.deviceName || "改名" }}</button></div></div>
            <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">本机设备号</h3><p class="sk-row__desc">组网里的唯一标识，不用管。</p></div></div><div class="sk-row__control"><code class="sk-code--inline">{{ snap?.deviceId || "—" }}</code></div></div>
                <div v-if="isHost" class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">本机地址</h3><p class="sk-row__desc">其他设备要在这台机器上打开端口 {{ snap?.port }}；首次接入如果连不上，多半是防火墙拦了这个端口。</p></div></div><div class="sk-row__control"><code class="sk-code--inline">{{ snap?.address }}:{{ snap?.port }}</code></div></div>
            </div></div>
            <template v-if="isHost">
                <div class="sk-card"><div class="sk-card__head"><div><h2 class="sk-card__title">当主机</h2><p class="sk-card__desc">其他设备使用连接码接入，每台设备生成一串。</p></div></div><div class="sk-card__body sk-list">
                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">生成连接码</h3><p class="sk-row__desc">一串码只能用一次。选择有效期后生成并安全地分享给信任的设备。</p></div></div><div class="sk-row__control"><select v-model="expiry" class="sk-select"><option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option></select><button type="button" class="sk-btn sk-btn--primary sk-btn--sm" :disabled="busy" @click="issuePairing">生成连接码</button></div></div>

                <!-- 连接码展示 -->
                <div v-if="newCode" class="sk-note sk-note--brand">
                    <code class="sk-code">{{ newCode }}</code>
                    <div class="sk-card__foot"><button type="button" class="sk-btn sk-btn--primary sk-btn--sm" @click="copyCode"><SettingsIcon name="copy" /> 复制</button><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="toggleQr"><SettingsIcon name="qr" /> {{ showQr ? "收起二维码" : "看二维码" }}</button><span class="sk-hint">只用来首次配对，配好后就不用再填了。</span></div>
                    <div v-if="showQr" class="sk-card__body"><img v-if="qrDataUrl" :src="qrDataUrl" alt="连接码二维码" width="220" height="220" /><p v-else class="sk-hint">正在生成…</p><p class="sk-hint"><strong>扫一下最稳。</strong>连接码是一长串字符，手动粘贴容易漏字符。</p></div>
                </div>

                <!-- 已生成的连接码：可以逐个撤销 -->
                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">已生成的连接码</h3><p class="sk-row__desc">撤销后立刻失效，已经接进来的设备不受影响。</p></div></div></div>
                <p v-if="!activePairings.length" class="sk-empty">还没有可用的连接码。</p>
                <div v-else class="sk-items"><article v-for="p in activePairings" :key="p.id" class="sk-item"><div class="sk-item__main"><div class="sk-item__title">{{ p.name || "未命名" }}<span v-if="p.usedBy" class="sk-badge sk-badge--ok">已被 {{ p.usedBy }} 用过</span><span v-else class="sk-badge sk-badge--brand">待使用</span></div><p class="sk-item__meta">{{ p.remaining }}</p></div><div class="sk-item__ops"><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" :disabled="busy" @click="revoke(p.id)">撤销</button></div></article></div>



                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">已接入的设备</h3><p class="sk-row__desc">移除后那台设备就再也连不上了。</p></div></div></div>
                <p v-if="!memberRows.length" class="sk-empty">还没有设备接入。</p>
                <div v-else class="sk-items"><article v-for="m in memberRows" :key="m.deviceId" class="sk-item"><div class="sk-item__main"><div class="sk-item__title">{{ m.name }}<span class="sk-badge" :class="m.online ? 'sk-badge--ok' : 'sk-badge--warn'">{{ m.online ? "在线" : "离线" }}</span></div><p v-if="capsSummary(m.deviceId)" class="sk-item__meta">{{ capsSummary(m.deviceId) }}</p></div><div class="sk-item__ops"><button v-if="!m.isSelf" type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="removeDevice(m.deviceId, m.name)">移除</button></div></article></div>

                <!-- 出口忙不忙 -->
                <p v-if="snap?.relay && (snap.relay.running > 0 || snap.relay.queued > 0)" class="sk-hint">
                    正在处理 {{ snap.relay.running }} 个请求，排队 {{ snap.relay.queued }} 个。
                </p>
                <!-- 额度与隐私（必须在开启前明确） -->
                <p class="sk-alert sk-alert--warn"><SettingsIcon name="alert" /><span>组网期间，<strong>其他设备的提问也会用这台设备的大脑额度</strong>。所以只把连接码给家里信得过的人。</span></p>

                <!-- ── 同步白名单（只有主机有） ── -->
                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">统一哪些配置</h3><p class="sk-row__desc">勾选的项目会下发到所有设备，未勾选的各设备自管、互不干扰。钥匙始终只用这台设备自己的。</p></div></div></div>
                <label v-for="f in SYNC_ITEMS" :key="f.key" class="sk-row settings-row"><span class="sk-row__main"><span><strong class="sk-row__title">{{ f.label }}</strong><span class="sk-row__desc">{{ f.hint }}</span></span></span><span class="sk-row__control"><span class="sk-check"><input type="checkbox" :checked="whitelist.includes(f.key)" @change="toggleSyncField(f.key, ($event.target as HTMLInputElement).checked)" /><span>跟随主机</span></span></span></label>
                </div></div>
            </template>

            <!-- ── 叶子侧 ───────────────────────────────────── -->
            <template v-else-if="isLeaf">
                <div class="sk-card"><div class="sk-card__head"><div><h2 class="sk-card__title">当叶子</h2><p class="sk-card__desc">本机对话会交给主机处理；本机不用配大脑钥匙，主机地址和资格已保存，下次开机会自动重连。</p></div><span class="sk-badge" :class="online ? 'sk-badge--ok' : 'sk-badge--warn'">{{ leafStatusText }}</span></div><div class="sk-card__body sk-list">

                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">与主机的连接</h3><p class="sk-row__desc"><template v-if="online">已连接到 {{ snap?.hostName }}，聊天会用它的大脑。</template><template v-else>没连上主机，现在用的是这台设备自己的大脑。主机重新打开组网后可以自动接回。</template></p></div></div><div class="sk-row__control"><button v-if="!online" type="button" class="sk-btn sk-btn--primary sk-btn--sm" :disabled="busy" @click="turnOn">重新接入</button><code class="sk-code--inline">{{ snap?.address || "—" }}:{{ snap?.port }}</code></div></div>
                <div v-if="pendingBackfill > 0" class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">有 {{ pendingBackfill }} 条对话没同步</h3><p class="sk-row__desc">断线期间本机独立聊的记录只会补传给主机留档，不会重新问大脑，也不会重复显示给别人。</p></div></div><div class="sk-row__control"><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" :disabled="busy" @click="flushNow">立即同步</button></div></div>
                <div class="sk-row"><div class="sk-row__main"><div><h3 class="sk-row__title">移除自己</h3><p class="sk-row__desc">移除后会清掉本机的连接信息，下次要重新填连接码。</p></div></div><div class="sk-row__control"><button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="leaveHost">移除自己</button></div></div>

                <!-- 额度明示（必须） -->
                </div><p class="sk-alert sk-alert--warn"><SettingsIcon name="alert" /><span>加入组网后，<strong>你的提问会消耗主机的大脑额度</strong>。主机那边能看到你在问什么。</span></p></div>
            </template>
        </div>

        <div v-if="showSetup" class="sk-card"><div class="sk-card__head"><div><h2 class="sk-card__title"><template v-if="snap?.hostName && !isOff">这台设备之前接入过 {{ snap.hostName }}。重新接入不需要填码。</template><template v-else>选择这台设备在组网里的角色，随时可以改。</template></h2></div></div><div class="sk-card__body sk-editor"><div class="sk-field"><span class="sk-field__label">角色</span><div class="sk-segmented"><button type="button" class="sk-segmented__item" :class="{ 'is-active': setupRole === 'host' }" @click="setupRole = 'host'">当主机</button><button type="button" class="sk-segmented__item" :class="{ 'is-active': setupRole === 'leaf' }" @click="setupRole = 'leaf'">接入别的主机</button></div></div><template v-if="setupRole === 'host'"><div class="sk-field"><label class="sk-field__label" for="expiry">连接码有效期</label><select id="expiry" v-model="expiry" class="sk-select"><option v-for="o in EXPIRY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option></select><p class="sk-field__hint">过期只是不让新设备再接入，已经接进来的设备不受影响。</p></div><p class="sk-alert sk-alert--warn"><SettingsIcon name="alert" /><span>开启后这台设备会为其他设备提供大脑。其他设备的提问会消耗这台设备的额度，请只把连接码给家里信得过的人。</span></p><div class="sk-editor__foot"><button type="button" class="sk-btn sk-btn--ghost" @click="showSetup = false">取消</button><button type="button" class="sk-btn sk-btn--primary" :disabled="busy" @click="openAsHost">开始当主机</button></div></template><template v-else><div class="sk-field"><label class="sk-field__label" for="pairing">连接码</label><textarea id="pairing" v-model="codeInput" class="sk-textarea" rows="3" placeholder="把主机那边显示的那一整串粘进来" /><p class="sk-field__hint">连接码同时也是密码，粘的时候小心别粘到公开的聊天里。</p></div><p class="sk-alert sk-alert--warn"><SettingsIcon name="alert" /><span>接入后这台设备不再单独调用大脑，提问会交给主机回答，消耗的是主机的额度。</span></p><div class="sk-editor__foot"><button type="button" class="sk-btn sk-btn--ghost" @click="showSetup = false">取消</button><button type="button" class="sk-btn sk-btn--primary" :disabled="busy" @click="joinAsLeaf">接入</button></div></template></div></div>

    </section>
</template>
