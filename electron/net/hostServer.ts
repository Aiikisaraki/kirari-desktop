// electron/net/hostServer.ts
// 主机端：监听固定端口，接受叶子配对与心跳，维持成员列表。
//
// 阶段 2 范围：只做「基础设施」——配对、心跳、成员管理。
// 活锁路由（请求上行 / 结果广播）在阶段 3 加进来。
//
// 几条硬规则（ARCHITECTURE-PLAN 3.3 / 3.4 / 7.1）：
//  - 关掉主机即全网停止：stop() 后端口释放，叶子超时各自回退独立工作
//  - 断线立即回退由叶子侧负责，主机这边只负责「不推送、清理成员」
//  - 配对码用一次即作废，长期凭据可单独吊销

import { WebSocketServer, type WebSocket } from "ws";
import * as os from "node:os";
import { NET_PORT, PROTOCOL_VERSION, parseClientFrame } from "./protocol";
import type { MembersMessage, PairResponse, PongMessage, HostShutdown } from "./protocol";
import { randomToken, verifyPairing } from "./pairingCode";
import type { PairingRecord } from "./pairingCode";
import type { NetState, LeafCredential } from "./netStore";
import { rememberLeaf, removeMember } from "./netStore";

export type MemberInfo = {
    deviceId: string;
    name: string;
    online: boolean;
    since: number;
};

export type HostEvents = {
    /** 状态变化（成员增减、开关切换）—— 由调用方负责广播给 UI */
    onMembersChanged?: (members: MemberInfo[]) => void;
    /**
     * HostServer 内部状态发生变化（新增/更新成员、移除设备）。
     *
     * ⚠️ 必须回调出去让上层落盘。之前 HostServer 只在自己内存里记 members，
     *    结果主机重启后「已配对设备」凭空消失，长期凭据也没了 ——
     *    表现为叶子退出再打开永远连不上。是阶段 2 双机验收抓出来的。
     */
    onStateChanged?: (state: NetState) => void;
    /** 有叶子接入或离开，供日志与后续阶段扩展 */
    onLog?: (message: string) => void;
};

export class HostServer {
    private wss: WebSocketServer | null = null;
    private state: NetState;
    private events: HostEvents;
    /** deviceId → 在线连接 */
    private clients = new Map<string, WebSocket>();
    /** deviceId → 连接建立时间 */
    private onlineSince = new Map<string, number>();
    /** 单调递增序号：阶段 3 广播时携带，保证叶子端顺序 */
    private seq = 0;

    constructor(state: NetState, events: HostEvents = {}) {
        this.state = state;
        this.events = events;
    }

    get isRunning(): boolean {
        return !!this.wss;
    }

    /** 当前在线成员 + 已配对但离线的成员。 */
    members(): MemberInfo[] {
        const offline = this.state.members
            .filter((m) => !this.clients.has(m.deviceId))
            .map((m) => ({ deviceId: m.deviceId, name: m.assignedName || m.deviceName, online: false, since: m.issuedAt }));
        const online = [...this.clients.keys()].map((id) => ({
            deviceId: id,
            name: this.displayNameOf(id),
            online: true,
            since: this.onlineSince.get(id) ?? Date.now(),
        }));
        return [...online, ...offline];
    }

    private displayNameOf(deviceId: string): string {
        const m = this.state.members.find((x) => x.deviceId === deviceId);
        return m?.assignedName || m?.deviceName || deviceId.slice(0, 8);
    }

    /**
     * 开始监听。端口被占用时返回错误信息（不抛），由上层决定怎么提示用户
     * —— 常见原因是上一实例没退干净，或被别的程序占了 19760。
     */
    start(port = NET_PORT): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
        if (this.wss) return Promise.resolve({ ok: true, port });
        return new Promise((resolve) => {
            let settled = false;
            const finish = (r: { ok: true; port: number } | { ok: false; error: string }) => {
                if (settled) return;
                settled = true;
                resolve(r);
            };

            const wss = new WebSocketServer({ port, host: "0.0.0.0" });
            this.wss = wss;

            wss.on("listening", () => {
                this.events.onLog?.(`[net] 主机已启动，端口 ${port}，本机地址 ${localAddresses().join(" / ")}`);
                finish({ ok: true, port });
            });
            wss.on("error", (err: NodeJS.ErrnoException) => {
                const msg =
                    err.code === "EADDRINUSE"
                        ? `端口 ${port} 已被占用。可能有另一个 Kirari 还在运行，或被其他程序占了。可以关掉那个程序，或等它退出后重试。`
                        : `主机启动失败：${err.message}`;
                this.events.onLog?.(`[net] ${msg}`);
                this.wss = null;
                finish({ ok: false, error: msg });
            });
            wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
        });
    }

    /** 停止监听并断开所有叶子（「主机退出即全网停止」）。 */
    stop(): void {
        // 先广播关停通告，再关连接。
        // 只靠 socket.close() 的话，优雅关闭要等对端回应，期间叶子毫无感知，
        // 用户看到的就是「桌宠卡住不动」——这正是要避免的体感。
        this.broadcast({
            type: "host_shutdown",
            v: PROTOCOL_VERSION,
            reason: "主机这边关掉了组网",
        } satisfies HostShutdown);

        // ⚠️ send() 只是把帧写进 socket 缓冲，立刻 close() 会让缓冲里的帧来不及
        // 发出去（表现为叶子「什么都没收到」）。留 150ms 让它真正 flush 到网卡。
        //
        // 但「已停止」的标记必须**立即**置位：否则这 150ms 内调用 start() 会被
        // 「还在运行」的判断挡掉，端口其实随后就被关掉了。
        const clients = [...this.clients.values()];
        const wss = this.wss;
        this.wss = null;
        this.clients.clear();
        this.onlineSince.clear();

        setTimeout(() => {
            for (const ws of clients) {
                try {
                    ws.close(1001, "host shutdown");
                } catch {
                    // 已经断了
                }
            }
            try {
                wss?.close();
            } catch {
                // 忽略
            }
        }, 150);
        this.events.onLog?.("[net] 主机已关闭，其他设备会自动转为独立工作");
    }

    /** 移除设备：作废其长期凭据，之后再也连不上。 */
    kick(deviceId: string): boolean {
        const existed = this.state.members.some((m) => m.deviceId === deviceId);
        this.state = removeMember(this.state, deviceId);
        this.syncState();
        const ws = this.clients.get(deviceId);
        if (ws) {
            try {
                ws.close(1008, "removed by host");
            } catch {
                // 忽略
            }
            this.clients.delete(deviceId);
        }
        if (existed) {
            this.events.onLog?.(`[net] 已移除设备 ${this.displayNameOf(deviceId)}`);
            this.emitMembers();
        }
        return existed;
    }

    /** 广播成员列表变化给所有叶子。 */
    emitMembers(): void {
        const frame: MembersMessage = { type: "members", v: PROTOCOL_VERSION, members: this.members() };
        this.broadcast(frame);
        this.events.onMembersChanged?.(this.members());
    }

    /** 向所有叶子广播（阶段 3 的结果广播也走这里）。 */
    broadcast(payload: unknown): void {
        const text = JSON.stringify(payload);
        for (const ws of this.clients.values()) {
            if (ws.readyState === 1) {
                try {
                    ws.send(text);
                } catch {
                    // 单个发送失败不影响其他人
                }
            }
        }
    }

    /** 下一个序号（阶段 3 广播时用）。 */
    nextSeq(): number {
        return ++this.seq;
    }

    /** 把内部状态变化同步给上层（上层负责落盘）。 */
    private syncState(): void {
        this.events.onStateChanged?.(this.state);
    }

    /** 替换状态（上层改动后调用）。 */
    updateState(state: NetState): void {
        this.state = state;
    }

    getState(): NetState {
        return this.state;
    }

    private send(ws: WebSocket, frame: PairResponse | MembersMessage | PongMessage): void {
        try {
            ws.send(JSON.stringify(frame));
        } catch {
            // 忽略
        }
    }

    private handleConnection(ws: WebSocket): void {
        /** 本连接是否已通过鉴权（配对或长期凭据）。未鉴权的连接只能发 pair。 */
        let authedDeviceId = "";
        /** 没鉴权时的超时：防止有人只连不发，白占资源。 */
        const authTimeout = setTimeout(() => {
            if (!authedDeviceId) {
                try {
                    ws.close(1008, "pair timeout");
                } catch {
                    // 忽略
                }
            }
        }, 15000);

        ws.on("message", (data: unknown) => {
            const frame = parseClientFrame(typeof data === "string" ? data : String(data));
            if (!frame) return;

            // ── 配对 ──
            if (frame.type === "pair") {
                const f = frame as { deviceId: string; deviceName: string; token: string };
                const deviceId = String(f.deviceId || "").trim();
                const deviceName = String(f.deviceName || "未命名设备").trim().slice(0, 24);
                const token = String(f.token || "").trim();

                if (!deviceId || !token) {
                    this.send(ws, { type: "pair_fail", v: PROTOCOL_VERSION, reason: "连接码信息不完整，重新复制一次" });
                    return;
                }

                // ── 先看是不是已配对过的设备拿长期凭据回来（重连）──
                // 这一步必须在配对码校验之前：配对码用一次就作废了，
                // 设备之后每次重连都只带长期凭据。若这里也去查配对码表，
                // 会把「已经配对好的设备」判成「连接码不认识」而拒绝，
                // 表现为：退出组网后再打开永远连不上。
                const known = this.state.members.find(
                    (m) => m.deviceId === deviceId && m.credential === token,
                );
                if (known) {
                    const now = Date.now();
                    authedDeviceId = deviceId;
                    clearTimeout(authTimeout);
                    this.clients.set(deviceId, ws);
                    this.onlineSince.set(deviceId, now);
                    this.state = rememberLeaf(this.state, { ...known, lastSeenAt: now });
                    this.syncState();
                    this.send(ws, {
                        type: "pair_ok",
                        v: PROTOCOL_VERSION,
                        credential: known.credential,
                        assignedName: known.assignedName || known.deviceName,
                        memberCount: this.state.members.length,
                    });
                    this.events.onLog?.(`[net] 设备已重连：${known.deviceName}（当前 ${this.clients.size} 台在线）`);
                    this.emitMembers();
                    return;
                }

                const err = verifyPairing(this.state.pairings, token, deviceId);
                if (err) {
                    this.events.onLog?.(`[net] 配对被拒：${err.error}`);
                    this.send(ws, { type: "pair_fail", v: PROTOCOL_VERSION, reason: err.error });
                    try {
                        ws.close(1008, "pair rejected");
                    } catch {
                        // 忽略
                    }
                    return;
                }

                // 签发长期凭据：配对码此后作废，重连靠这个
                const credential = randomToken(32);
                const now = Date.now();
                const leaf: LeafCredential = {
                    deviceId,
                    deviceName: deviceName || "未命名设备",
                    credential,
                    issuedAt: now,
                    lastSeenAt: now,
                };
                this.state = rememberLeaf(this.state, leaf);
                    this.syncState();
                // 把用掉的配对码标记为已使用（同时仍允许同一设备用它重连，见 verifyPairing）
                const used = this.state.pairings.find((p) => p.tokenHash && !p.revoked && p.usedBy === null);
                if (used) {
                    this.state = {
                        ...this.state,
                        pairings: this.state.pairings.map((p) => (p.id === used.id ? { ...p, usedBy: deviceId } : p)),
                    };
                }

                authedDeviceId = deviceId;
                clearTimeout(authTimeout);
                this.clients.set(deviceId, ws);
                this.onlineSince.set(deviceId, now);

                this.send(ws, {
                    type: "pair_ok",
                    v: PROTOCOL_VERSION,
                    credential,
                    assignedName: leaf.deviceName,
                    memberCount: this.state.members.length,
                });
                this.events.onLog?.(`[net] 设备已接入：${leaf.deviceName}（当前 ${this.clients.size} 台在线）`);
                this.emitMembers();
                return;
            }

            // ── 以下需要先通过鉴权 ──
            if (!authedDeviceId) {
                try {
                    ws.close(1008, "not authenticated");
                } catch {
                    // 忽略
                }
                return;
            }

            if (frame.type === "ping") {
                // 心跳：回 pong，兼作「叶子还活着」的证据
                this.send(ws, { type: "pong", v: PROTOCOL_VERSION, seq: this.nextSeq(), serverTime: Date.now() });
                const m = this.state.members.find((x) => x.deviceId === authedDeviceId);
                if (m) {
                    this.state = rememberLeaf(this.state, { ...m, lastSeenAt: Date.now() });
                }
            }
        });

        ws.on("close", () => {
            clearTimeout(authTimeout);
            if (authedDeviceId && this.clients.get(authedDeviceId) === ws) {
                this.clients.delete(authedDeviceId);
                this.onlineSince.delete(authedDeviceId);
                this.events.onLog?.(`[net] 设备已离线：${this.displayNameOf(authedDeviceId)}`);
                this.emitMembers();
            }
        });

        ws.on("error", () => {
            // close 会紧随其后，这里不重复处理
        });
    }
}

/** 取本机可用于组网的 IPv4 地址（优先私有网段，其次回环以外的一切）。 */
export function localAddresses(): string[] {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
            if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
        }
    }
    return out;
}

/** 猜测最适合填进连接码的地址：私有网段优先。 */
export function guessHostAddress(): string {
    const addrs = localAddresses();
    const priv = addrs.find((a) => /^192\.168\./.test(a) || /^10\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a));
    return priv || addrs[0] || "127.0.0.1";
}
