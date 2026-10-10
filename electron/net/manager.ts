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
    DEFAULT_EXPIRY,
} from "./netStore";
import type { NetState, NetRole, LeafCredential } from "./netStore";
import { generatePairingCode, parsePairingCode, describeRemaining, randomToken } from "./pairingCode";
import type { PairingCode, PairingRecord, ExpiryKey } from "./pairingCode";
import { NET_PORT } from "./protocol";

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
};

export type NetManagerEvents = {
    onSnapshot?: (snap: NetSnapshot) => void;
    /** 自动退出组网时要告知用户（避免误以为程序崩了） */
    onFallbackNotice?: (message: string) => void;
    onLog?: (message: string) => void;
};

export class NetManager {
    private userDataDir: string;
    private identity: DeviceIdentity;
    private state: NetState;
    private host: HostServer | null = null;
    private leaf: LeafClient | null = null;
    private events: NetManagerEvents;

    constructor(userDataDir: string, events: NetManagerEvents = {}) {
        this.userDataDir = userDataDir;
        this.events = events;
        this.identity = loadOrCreateIdentity(userDataDir);
        this.state = loadNetState(userDataDir, this.identity.deviceId, this.identity.name);
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
            this.host = new HostServer(this.state, {
                onLog: (m) => this.log(m),
                // HostServer 内部状态变化（新增/更新/移除成员）必须回流到
                // NetManager 并落盘，否则主机重启后忘记已配对设备。
                onStateChanged: (s) => {
                    this.state = s;
                    this.persist();
                },
                onMembersChanged: () => this.events.onSnapshot?.(this.snapshot()),
            });
        } else {
            this.host.updateState(this.state);
        }

        const started = await this.host.start(NET_PORT);
        if (!started.ok) {
            // 端口起不来 → 退回独立工作，绝不让用户卡在「开了但用不了」的状态
            this.state = disableNetworking(this.state);
            this.persist();
            return { ok: false, error: started.error };
        }

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
    relay(content: string, images?: string[]): boolean {
        return this.leaf?.sendRelay(content, images) ?? false;
    }

    dispose(): void {
        this.leaf?.disconnect();
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
