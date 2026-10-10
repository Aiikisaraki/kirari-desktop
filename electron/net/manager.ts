// electron/net/manager.ts
// 组网门面：把身份、状态、主机端、叶子端串成一条可用的链路。
//
// 单独一层的理由：接线里有几个**必须成对发生**的动作，漏一个就会出诡异 bug：
//   - 配对成功后，必须同时保存「主机地址 + 端口 + 长期凭据」，否则重开组网连不上
//   - 角色切换只改 role，绝不能碰地址/凭据（否则「退出不清除」失效）
//   - 主机侧配对码被消费后要落盘，否则重启后同一个码能反复用
// 这些如果散落在 main.ts 的 IPC 回调里，迟早漏。所以收在这里。
//
// 阶段 2 范围：基础设施（配对 / 心跳 / 成员）。活锁路由在阶段 3 加。

import * as path from "node:path";
import { HostServer, guessHostAddress, localAddresses } from "./hostServer";
import type { MemberInfo } from "./hostServer";
import { LeafClient } from "./leafClient";
import type { LeafStatus } from "./leafClient";
import { loadOrCreateIdentity, renameIdentity } from "./identity";
import type { DeviceIdentity } from "./identity";
import {
    loadNetState,
    saveNetState,
    enableNetworking,
    disableNetworking,
    addPairing,
    revokePairing,
    pruneExpiredPairings,
    attachToHost,
    removeMember,
    detachFromHost,
    setSyncWhitelist,
    filterWhitelisted,
    DEFAULT_EXPIRY,
} from "./netStore";
import type { NetState, NetRole, LeafCredential } from "./netStore";
import { generatePairingCode, parsePairingCode, describeRemaining, randomToken } from "./pairingCode";
import type { PairingCode, PairingRecord, ExpiryKey } from "./pairingCode";
import { NET_PORT, PROTOCOL_VERSION, SYNC_FIELDS } from "./protocol";
import type { RelayResult, RelayBusy, RelayBackfill, ConfigPush, SyncField } from "./protocol";
import { RelayRouter } from "./relayRouter";
import type { RelayExecutor } from "./relayRouter";

export type NetSnapshot = {
    role: NetRole;
    deviceId: string;
    deviceName: string;
    /** 主机地址（叶子侧：已连的主机；主机侧：待展示给客人的地址） */
    address: string;
    port: number;
    hostName?: string;
    /** 主机侧：已生成的配对码 */
    pairings: { id: string; name: string; expiresAt: number; remaining: string; usedBy: string | null; revoked: boolean }[];
    /** 主机侧：成员 */
    members: MemberInfo[];
    /** 叶子侧：连接状态 */
    leafStatus?: LeafStatus;
    /** 叶子侧：待补传的离线对话条数 */
    pendingBackfill?: number;
    /** 主机侧：出口忙不忙 */
    relay?: { running: number; queued: number; maxConcurrent: number; maxQueue: number } | null;
    /** 主机侧：配置同步白名单 */
    syncWhitelist?: SyncField[];
};

export type NetManagerEvents = {
    onSnapshot?: (snap: NetSnapshot) => void;
    /** 自动退出组网时要告知用户（避免误以为程序崩了） */
    onFallbackNotice?: (message: string) => void;
    onLog?: (message: string) => void;
    /**
     * 收到全网广播的回复（阶段 3）。所有设备都会收到 —— 活锁模型的必然结果。
     * 请求方自己的发言已在本地显示，这里只管把回复显示出来。
     */
    onRelayResult?: (frame: RelayResult) => void;
    /** 主机拒绝了请求 */
    onRelayBusy?: (frame: RelayBusy) => void;
    /**
     * 配置被组网同步：主机侧是「批准叶子改动后应用到本机」，
     * 叶子侧是「收到主机下发后应用」。两者都落到同一个回调。
     */
    onConfigChanged?: (patch: Partial<Record<SyncField, string>>, fromDeviceId: string) => void;
    /** 叶子收到主机下发的配置 */
    onConfigPush?: (frame: ConfigPush) => void;
};

/**
 * 主机侧的模型执行器（阶段 3）。
 * 由 main.ts 注入本机 AI 引擎；不注入则主机不处理上行请求
 * （叶子会收到「主机还没准备好」而不是卡死）。
 */
export type HostExecutor = RelayExecutor;

export class NetManager {
    private userDataDir: string;
    private identity: DeviceIdentity;
    private state: NetState;
    private host: HostServer | null = null;
    private leaf: LeafClient | null = null;
    private events: NetManagerEvents;
    /** 主机侧活锁路由（阶段 3）。有执行器才会建。 */
    private router: RelayRouter | null = null;
    /** 叶子侧补传入库回调（只记对话，不调模型） */
    private backfillSink: ((msg: RelayBackfill) => Promise<void> | void) | null = null;

    constructor(userDataDir: string, events: NetManagerEvents = {}) {
        this.userDataDir = userDataDir;
        this.events = events;
        this.identity = loadOrCreateIdentity(userDataDir);
        this.state = loadNetState(userDataDir, this.identity.deviceId, this.identity.name);
    }

    /**
     * 装上主机侧的模型执行器（阶段 3）。
     *
     * 组网启动时才调用 —— 也就是说「主机能不能当出口」取决于本机有没有配好大脑。
     * 没配就应该是「不能当主机」，而不是让人配好了发现组网是坏的。
     * @param executor 调用本机 AI 引擎
     * @param onBackfill 补传入库（把断线期间的对话写进本机历史）
     */
    attachHostExecutor(executor: HostExecutor, onBackfill?: (msg: RelayBackfill) => Promise<void> | void): void {
        this.backfillSink = onBackfill ?? null;
        if (!this.router) {
            this.router = new RelayRouter({
                executor,
                maxConcurrent: Number(process.env.NET_MAX_CONCURRENT || 2),
                maxQueue: Number(process.env.NET_MAX_QUEUE || 20),
                events: {
                    // 广播：发给所有叶子 + 自己也收到（主机也是全网一员）
                    broadcast: (frame) => {
                        this.host?.broadcast(frame);
                        this.events.onRelayResult?.(frame);
                    },
                    replyTo: (deviceId, frame) => this.host?.replyTo(deviceId, frame),
                    onBackfill: async (msg) => {
                        await this.backfillSink?.(msg);
                        // 回执让叶子清掉本地待补队列
                        this.host?.replyTo(msg.deviceId, {
                            type: "relay_backfill_ack",
                            v: PROTOCOL_VERSION,
                            count: msg.entries.length,
                        });
                    },
                    onLog: (m) => this.log(m),
                },
            });
        } else {
            this.router.setExecutor(executor);
        }
    }

    /** 活锁路由的运行状态，给 UI 显示「主机现在忙不忙」。 */
    relayStats(): { running: number; queued: number; maxConcurrent: number; maxQueue: number } | null {
        return this.router?.stats() ?? null;
    }

    // ── 查询 ────────────────────────────────────────────────────

    snapshot(): NetSnapshot {
        const address =
            this.state.role === "leaf" && this.state.hostAddress
                ? this.state.hostAddress
                : guessHostAddress();
        return {
            role: this.state.role,
            deviceId: this.identity.deviceId,
            deviceName: this.identity.name,
            address,
            port: this.state.role === "leaf" && this.state.hostPort ? this.state.hostPort : NET_PORT,
            hostName: this.state.hostDisplayName,
            pairings: this.state.pairings.map((p) => ({
                id: p.id,
                name: p.name,
                expiresAt: p.expiresAt,
                remaining: describeRemaining(p),
                usedBy: p.usedBy,
                revoked: p.revoked,
            })),
            members: this.host ? this.host.members() : [],
            leafStatus: this.leaf?.getStatus(),
            pendingBackfill: this.leaf?.pendingBackfillCount(),
            relay: this.relayStats(),
            syncWhitelist: this.state.role === "host" ? [...this.state.syncWhitelist] : undefined,
        };
    }

    /** 本机所有可用于组网的地址（给 UI 展示「用哪个地址连」）。 */
    addresses(): string[] {
        return localAddresses();
    }

    private persist(): void {
        saveNetState(this.userDataDir, this.state);
        this.events.onSnapshot?.(this.snapshot());
    }

    private log(message: string): void {
        console.log(`[net] ${message}`);
        this.events.onLog?.(message);
    }

    // ── 身份 ────────────────────────────────────────────────────

    renameSelf(name: string): void {
        this.identity = renameIdentity(this.userDataDir, name);
        this.state = { ...this.state, deviceName: this.identity.name };
        this.persist();
    }

    // ── 组网开关 ────────────────────────────────────────────────

    /**
     * 开启组网并作为主机。
     * 之前当过叶子也没关系：主机不需要凭据，反之亦然 —— 角色只是「当前参与方式」。
     */
    async startHosting(expiryKey: ExpiryKey = DEFAULT_EXPIRY): Promise<{
        ok: true;
        code: PairingCode;
    } | { ok: false; error: string }> {
        this.state = enableNetworking(this.state, "host");
        // 主机不依赖凭据，但家庭标识要有（阶段 3 用它识别「同一伙设备」）
        if (!this.state.homeId) this.state = { ...this.state, homeId: randomToken(8) };
        this.persist();

        const hostAddress = guessHostAddress();
        const { code, record } = generatePairingCode({
            host: hostAddress,
            name: this.identity.name,
            expiryKey,
            port: NET_PORT,
        });
        this.state = addPairing(this.state, record);
        this.persist();

        if (!this.host) {
            // HostServer 不再自己存状态：一律通过 getState/setState 走这里。
            // 单一数据源是必须的 —— 之前两边各存一份互相覆盖，循环下来
            // 成员会莫名丢失（叶子重连时主机说「不认识」）。
            this.host = new HostServer(
                () => this.state,
                (s) => {
                    this.state = s;
                    this.persist();
                },
                {
                    onLog: (m) => this.log(m),
                    onMembersChanged: () => this.events.onSnapshot?.(this.snapshot()),
                    // 阶段 3：上行请求交给活锁路由
                    onRelayRequest: (req) => this.router?.handle(req) ?? false,
                    onRelayBackfill: (msg) => void this.router?.handleBackfill(msg),
                    // 叶子上报配置改动：白名单内的字段应用到本机并转发给所有叶子
                    onConfigReport: (msg, allowed) => {
                        const fields = Object.keys(allowed) as SyncField[];
                        this.events.onConfigChanged?.(allowed, msg.deviceId);
                        this.log(`[net] 已批准 ${msg.deviceId.slice(0, 8)} 的配置改动：${fields.join("、")}`);
                        this.broadcastConfig(allowed, msg.deviceId);
                    },
                },
            );
        }

        const started = await this.host.start(NET_PORT);
        if (!started.ok) {
            // 端口起不来 → 退回独立工作，绝不让用户卡在「开了但用不了」的状态
            this.state = disableNetworking(this.state);
            this.persist();
            return { ok: false, error: started.error };
        }
        // 重新打开 → 路由恢复收单
        this.router?.reopen();

        this.host.updateState(this.state);
        return { ok: true, code };
    }

    /**
     * 开启组网并作为叶子：填入连接码完成配对。
     * 配对成功会把主机地址与长期凭据一并落盘，下次打开开关直接连、免重新配对。
     */
    async startFollowing(pairingText: string): Promise<{ ok: true } | { ok: false; error: string }> {
        const code = parsePairingCode(pairingText);
        if (!code) {
            return { ok: false, error: "这个连接码看起来不完整。让主机那边重新复制一次，粘完整的那一串。" };
        }

        this.state = enableNetworking(this.state, "leaf");
        this.persist();

        if (!this.leaf) {
            this.leaf = new LeafClient(this.identity.deviceId, this.identity.name, {
                onLog: (m) => this.log(m),
                onStatus: () => this.events.onSnapshot?.(this.snapshot()),
                onMembers: () => this.events.onSnapshot?.(this.snapshot()),
                onRelayResult: (f) => this.events.onRelayResult?.(f),
                onRelayBusy: (f) => this.events.onRelayBusy?.(f),
                onConfigPush: (f) => this.events.onConfigPush?.(f),
                onFallback: (reason) => {
                    // 关键：只改 role，不动地址与凭据 —— 退出不清除。
                    // 下次用户打开开关，凭持久化的信息自动归位，无需重新配对。
                    this.state = disableNetworking(this.state);
                    this.persist();
                    this.events.onFallbackNotice?.(
                        `已退出组网（${reason}），现在可以独立工作。主机那边重新打开组网后，这里打开开关就能自动接回去，不用重新配对。`,
                    );
                },
            });
        }

        const result = await this.leaf.pair(code);
        if (!result.ok) {
            this.state = disableNetworking(this.state);
            this.persist();
            return { ok: false, error: result.error };
        }

        // 配对成功的三件事必须一起做：存地址、存凭据、切角色
        this.state = attachToHost(
            this.state,
            { address: code.host, port: code.port, displayName: code.name },
            result.credential,
        );
        this.persist();
        return { ok: true };
    }

    /**
     * 重新加入已配对的主机（打开开关时若已有凭据，走这里而不是重新配对）。
     * 这就是「退出不清除」的兑现：用户零成本反复切换。
     */
    resumeFollowing(): { ok: true } | { ok: false; error: string } {
        if (!this.state.hostAddress || !this.state.hostPort || !this.state.credential) {
            return { ok: false, error: "还没连过主机，先让主机生成一个连接码" };
        }
        this.state = enableNetworking(this.state, "leaf");
        this.persist();
        if (!this.leaf) {
            this.leaf = new LeafClient(this.identity.deviceId, this.identity.name, {
                onLog: (m) => this.log(m),
                onStatus: () => this.events.onSnapshot?.(this.snapshot()),
                onMembers: () => this.events.onSnapshot?.(this.snapshot()),
                onRelayResult: (f) => this.events.onRelayResult?.(f),
                onRelayBusy: (f) => this.events.onRelayBusy?.(f),
                onConfigPush: (f) => this.events.onConfigPush?.(f),
                onFallback: (reason) => {
                    this.state = disableNetworking(this.state);
                    this.persist();
                    this.events.onFallbackNotice?.(
                        `已退出组网（${reason}），现在可以独立工作。打开开关就能重新接入，不用重新配对。`,
                    );
                },
            });
        }
        const { hostAddress, hostPort, credential } = this.state;
        // 上面的判空已经保证了三个字段都有值，这里取局部变量让 TS 也认得
        this.leaf.connect(hostAddress!, hostPort!, credential!);
        return { ok: true };
    }

    /**
     * 关闭组网。
     * **只把角色改回独立，不清任何配置**（地址、凭据、配对码、成员全留着），
     * 下次打开开关自动归位。这是 ARCHITECTURE-PLAN 5.6 的硬要求。
     */
    stopNetworking(): void {
        this.leaf?.disconnect();
        // 先停路由：排队中的叶子要立刻收到「主机不接了」，而不是干等到超时
        this.router?.close();
        this.host?.stop();
        this.state = disableNetworking(this.state);
        this.persist();
    }

    // ── 主机侧管理 ──────────────────────────────────────────────

        /** 再生成一个连接码（支持多台设备分别配对）。 */
    issuePairing(expiryKey: ExpiryKey = DEFAULT_EXPIRY): PairingCode {
        const { code, record } = generatePairingCode({
            host: guessHostAddress(),
            name: this.identity.name,
            expiryKey,
            port: NET_PORT,
        });
        this.state = addPairing(this.state, record);
        this.persist();
        return code;
    }

    /** 撤销配对码：作废配对入口，不影响已连上的设备。 */
    revokePairingCode(pairingId: string): void {
        this.state = revokePairing(this.state, pairingId);
        this.persist();
    }

    /** 清理过期且未被用过的配对码。 */
    prunePairings(): void {
        this.state = pruneExpiredPairings(this.state);
        this.persist();
    }

    /** 移除设备：作废其长期凭据，之后再也连不上（与「退出组网」语义不同）。 */
    removeDevice(deviceId: string): boolean {
        const ok = this.host?.kick(deviceId) ?? false;
        // kick() 内部已通过 onStateChanged 回流状态并落盘，这里只在
        // 「设备只存在于持久层、当前不在线」时补一次清理。
        if (!this.state.members.some((m) => m.deviceId === deviceId)) {
            this.state = removeMember(this.state, deviceId);
            this.persist();
        }
        return ok || true;
    }

    // ── 叶子侧管理 ──────────────────────────────────────────────

    /** 断开与主机的绑定并清掉本地凭据（对应 UI 的「移除自己」）。 */
    leaveHost(): void {
        this.leaf?.disconnect();
        this.state = detachFromHost(this.state);
        this.persist();
    }

    /** 序列化当前配对码（供 UI 复制 / 生成二维码）。 */
    serializePairing(code: PairingCode): string {
        // 延迟引入避免循环依赖：pairingCode 是纯逻辑层
        const { serializePairingCode } = require("./pairingCode") as typeof import("./pairingCode");
        return serializePairingCode(code);
    }

    /** 诊断用：透出叶子连接的真实状态。 */
    debugLeaf(): ReturnType<LeafClient["debug"]> | null {
        return this.leaf ? this.leaf.debug() : null;
    }

    /** 诊断用：主机是否在监听。 */
    get hostRunning(): boolean {
        return this.host?.isRunning ?? false;
    }

    /** 阶段 3 预留：叶子端上行请求。 */
    relay(content: string, sessionId: string, images?: string[]): boolean {
        return this.leaf?.sendRelay(content, sessionId, images, this.identity.name) ?? false;
    }

    /**
     * 记录一条「本地独立工作期间产生的对话」（阶段 3 离线补传）。
     *
     * 只在**没连上主机**时才有意义 —— 连着的时候对话本来就走主机、不缺记录。
     * 这些内容会在下次连上主机时补传（只入库，不重放模型调用）。
     */
    recordLocalExchange(sessionId: string, role: "user" | "assistant", text: string): void {
        if (!this.leaf) return;
        // 已连上主机 → 对话已由主机记录，不需要补传
        if (this.leaf.getStatus() === "connected") return;
        this.leaf.recordLocalExchange(sessionId, role, text);
        this.events.onSnapshot?.(this.snapshot());
    }

    /** 手动触发一次补传（用户在 UI 上点「立即同步」时用）。 */
    flushBackfillNow(): void {
        this.leaf?.flushBackfill();
    }

    /**
     * 把配置广播给所有叶子（只带白名单内的字段）。
     * @param fromDeviceId 谁改的（主机自己或某个叶子）
     */
    private broadcastConfig(patch: Partial<Record<SyncField, string>>, fromDeviceId: string): void {
        const allowed = filterWhitelisted(this.state, patch);
        if (!Object.keys(allowed).length) return;
        const frame: ConfigPush = {
            type: "config_push",
            v: PROTOCOL_VERSION,
            fromDeviceId,
            patch: allowed,
        };
        this.host?.broadcast(frame);
        // 主机自己也应用（叶子改了、白名单批准 → 主机的配置跟着变，保持全网一致）
        this.events.onConfigChanged?.(allowed, fromDeviceId);
    }

    /**
     * 本机配置被用户改动时的统一入口。
     *
     * 主机：白名单内的字段广播给所有叶子。
     * 叶子：**无条件上报**给主机，由主机决定要不要传播（白名单是主机侧的东西）。
     * 独立模式（没组网）：什么都不做。
     */
    notifyLocalConfigChanged(patch: Partial<Record<SyncField, string>>): void {
        if (this.state.role === "host") {
            this.broadcastConfig(patch, this.identity.deviceId);
            return;
        }
        if (this.state.role === "leaf") {
            this.leaf?.reportConfigChange(patch);
        }
    }

    /** 当前同步白名单（只有主机侧有内容，叶子侧返回空数组）。 */
    syncWhitelist(): SyncField[] {
        return this.state.role === "host" ? [...this.state.syncWhitelist] : [];
    }

    /** 设置白名单（仅主机侧生效）。设置后立即生效，无需叶子重连。 */
    setSyncWhitelist(fields: SyncField[]): void {
        if (this.state.role !== "host") return;
        const clean = fields.filter((f) => SYNC_FIELDS.includes(f));
        this.state = setSyncWhitelist(this.state, clean);
        this.persist();
        // 白名单放开后，把当前值补推给所有叶子（否则用户要先改一次才生效）
        this.events.onSnapshot?.(this.snapshot());
    }

    dispose(): void {
        this.leaf?.disconnect();
        this.router?.close("主机已退出");
        this.host?.stop();
        this.leaf = null;
        this.host = null;
    }
}

/** 便捷工厂：主进程启动时调一次。 */
export function createNetManager(userDataDir: string, events: NetManagerEvents = {}): NetManager {
    const mgr = new NetManager(userDataDir, events);
    // 启动即清理过期配对码（过期的码留着只会让列表越来越乱）
    if (mgr.snapshot().role === "host") mgr.prunePairings();
    return mgr;
}

/** 组网状态文件所在路径（诊断用）。 */
export function netStatePath(userDataDir: string): string {
    return path.join(userDataDir, "net-state.json");
}
