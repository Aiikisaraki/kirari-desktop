// electron/net/leafClient.ts
// 叶子端：连主机、发心跳、断线自动回退独立工作。
//
// 核心是「断线回退」，三条规则（ARCHITECTURE-PLAN 3.4 / 3.9）：
//  1. **硬断线立即回退**：socket close/error 一到，立刻退出组网、恢复独立调用。
//     不等超时 —— 用户感知不到等待才有体感，等 5 秒会看到「桌宠卡住不动」。
//  2. **半开超时回退**：心跳 2 秒一次，5 秒没回应即判定已死，退出组网。
//  3. **回退不清配置**：只把 role 置回 off，主机地址与长期凭据留在磁盘上，
//     用户重新打开开关就能自动归位。
//
// 自动退出不需要用户确认：网络已不可用，保持组网态毫无意义。
// 上层只需监听 onFallback 提示一句「已退出组网，现在可以独立工作」。

import WebSocket from "ws";
import {
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    PROTOCOL_VERSION,
    parseServerFrame,
    SeqTracker,
} from "./protocol";
import type { MembersMessage, ServerFrame } from "./protocol";
import { randomToken } from "./pairingCode";

export type LeafStatus = "idle" | "connecting" | "paired" | "connected" | "fallback";

export type LeafEvents = {
    /** 状态变化，供 UI 显示 */
    onStatus?: (status: LeafStatus, detail?: string) => void;
    /** 掉线回退。reason 是给用户看的大白话 */
    onFallback?: (reason: string) => void;
    /** 成员列表更新 */
    onMembers?: (members: MembersMessage["members"]) => void;
    /** 阶段 3 预留：收到结果广播 */
    onRelayResult?: (frame: Extract<ServerFrame, { type: "relay_result" }>) => void;
    onLog?: (message: string) => void;
};

export class LeafClient {
    private ws: WebSocket | null = null;
    private events: LeafEvents;
    private deviceId: string;
    private deviceName: string;

    /** 主机地址与端口 */
    private host = "";
    private port = 0;
    /** 长期凭据：重连用它，不再走配对流程 */
    private credential = "";

    private status: LeafStatus = "idle";
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimer: ReturnType<typeof setTimeout> | null = null;
    /** 本机累计请求 id（阶段 3 用） */
    private requestSeq = 0;
    /** 主机广播序号跟踪，保证顺序 */
    private seqTracker = new SeqTracker();
    /** 本轮连接是否是有意的（关闭组网时不算异常） */
    private closingIntentionally = false;

    constructor(deviceId: string, deviceName: string, events: LeafEvents = {}) {
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.events = events;
    }

    getStatus(): LeafStatus {
        return this.status;
    }

    /** 诊断用：连接的真实状态。排障时看这个比看 status 靠谱。 */
    debug(): { status: LeafStatus; hasSocket: boolean; readyState: number; closingIntentionally: boolean } {
        return {
            status: this.status,
            hasSocket: !!this.ws,
            readyState: this.ws ? this.ws.readyState : -1,
            closingIntentionally: this.closingIntentionally,
        };
    }

    getSeq(): number {
        return this.seqTracker.current;
    }

    nextRequestId(): string {
        return `${this.deviceId}:${++this.requestSeq}`;
    }

    private setStatus(s: LeafStatus, detail?: string): void {
        if (this.status === s) return;
        this.status = s;
        this.events.onStatus?.(s, detail);
    }

    /**
     * 挂上「断线即回退」的生命周期处理。
     *
     * ⚠️ 这段必须对**所有**连接路径生效 —— 首次配对（pair）与重连（connect）。
     *    之前只挂在 connect() 上，结果「刚配对上的设备」掉线时不会回退，
     *    表现为桌宠一直显示已连接、实际早就不通了。是阶段 2 的双机验收抓出来的。
     */
    private attachLifecycle(ws: WebSocket): void {
        ws.on("close", () => {
            this.stopHeartbeat();
            // 规则 1：硬断线立即回退，不等超时
            if (!this.closingIntentionally) {
                this.fallback("和主机断开了");
            }
        });
        ws.on("error", () => {
            // close 紧随其后，统一在那里处理；这里只停心跳
            this.stopHeartbeat();
        });
    }

    /**
     * 首次配对：用连接码里的口令换一个长期凭据。
     * @param code 解析好的连接码（见 pairingCode.parsePairingCode）
     */
    async pair(code: { host: string; port: number; token: string; name: string }): Promise<
        { ok: true; credential: string } | { ok: false; error: string }
    > {
        this.host = code.host;
        this.port = code.port;
        this.closingIntentionally = false;
        this.setStatus("connecting", `正在连接 ${code.host}:${code.port}`);

        return new Promise((resolve) => {
            let settled = false;
            const ws = new WebSocket(`ws://${code.host}:${code.port}`);
            this.ws = ws;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    ws.close();
                } catch {
                    // 忽略
                }
                this.setStatus("idle");
                resolve({ ok: false, error: "连不上主机，检查地址和防火墙，或者确认主机上的组网开关是开着的" });
            }, 10000);

            ws.on("open", () => {
                ws.send(
                    JSON.stringify({
                        type: "pair",
                        v: PROTOCOL_VERSION,
                        deviceId: this.deviceId,
                        deviceName: this.deviceName,
                        token: code.token,
                        v2: PROTOCOL_VERSION,
                    }),
                );
            });

            ws.on("message", (data: unknown) => {
                const frame = parseServerFrame(String(data));
                if (!frame) return;
                if (frame.type === "pair_ok") {
                    clearTimeout(timer);
                    settled = true;
                    this.credential = frame.credential || "";
                    this.setStatus("connected", `已连接到 ${code.name || code.host}`);
                    // 关键：配对成功后这条连接就是长期连接了，
                    // 必须补挂断线回退，否则掉线时桌宠会一直假装连着。
                    this.attachLifecycle(ws);
                    this.startHeartbeat();
                    this.events.onLog?.(`[net] 配对成功，主机：${code.name || code.host}`);
                    resolve({ ok: true, credential: this.credential });
                } else if (frame.type === "pair_fail") {
                    clearTimeout(timer);
                    settled = true;
                    const reason = frame.reason || "主机拒绝了这次配对";
                    this.setStatus("idle", reason);
                    try {
                        ws.close();
                    } catch {
                        // 忽略
                    }
                    resolve({ ok: false, error: reason });
                }
            });

            ws.on("error", () => {
                if (!settled) {
                    clearTimeout(timer);
                    settled = true;
                    this.setStatus("idle");
                    resolve({ ok: false, error: "连不上主机，检查地址和防火墙，或者确认主机上的组网开关是开着的" });
                }
            });

            ws.on("close", () => {
                if (!settled) {
                    clearTimeout(timer);
                    settled = true;
                    this.setStatus("idle");
                    resolve({ ok: false, error: "连接被主机断开" });
                }
            });
        });
    }

    /**
     * 用已有长期凭据连接主机（自动重连 / 打开组网开关时走这里，不再配对）。
     */
    connect(host: string, port: number, credential: string): void {
        if (!host || !port || !credential) {
            this.setStatus("idle");
            this.events.onFallback?.("还没连过主机，先填一个连接码");
            return;
        }
        this.host = host;
        this.port = port;
        this.credential = credential;
        this.closingIntentionally = false;
        this.seqTracker.reset();
        this.openSocket();
    }

    private openSocket(): void {
        this.stopHeartbeat();
        const wasConnected = this.status === "connected";
        if (!wasConnected) this.setStatus("connecting", `正在连接 ${this.host}`);

        let ws: WebSocket;
        try {
            ws = new WebSocket(`ws://${this.host}:${this.port}`);
        } catch (e) {
            this.fallback((e as Error)?.message || "连接失败");
            return;
        }
        this.ws = ws;

        ws.on("open", () => {
            this.setStatus("connected");
            // 用长期凭据握手：主机校验通过才算真正连上
            ws.send(
                JSON.stringify({
                    type: "pair",
                    v: PROTOCOL_VERSION,
                    deviceId: this.deviceId,
                    deviceName: this.deviceName,
                    // 长期凭据也走 pair 帧的 token 字段；主机优先按已配对设备校验
                    token: this.credential,
                    v2: PROTOCOL_VERSION,
                }),
            );
            this.startHeartbeat();
        });

        ws.on("message", (data: unknown) => {
            const frame = parseServerFrame(String(data));
            if (!frame) return;

            // 收到任何帧都算「对方活着」，重置半开计时
            this.armPongTimeout();

            if (frame.type === "pong") {
                this.setStatus("connected");
                return;
            }
            if (frame.type === "pair_ok") {
                // 主机确认了身份（可能换了新凭据）
                if (frame.credential && frame.credential !== this.credential) {
                    this.credential = frame.credential;
                    this.events.onLog?.("[net] 收到主机签发的新凭据，已更新");
                }
                this.setStatus("connected");
                this.armPongTimeout();
                return;
            }
            if (frame.type === "pair_fail") {
                // 凭据被吊销（主机移除了这台设备）→ 只能回独立工作
                this.events.onLog?.(`[net] 主机拒绝了连接：${frame.reason || "未知原因"}`);
                this.fallback(frame.reason || "主机不再接受这台设备");
                return;
            }
            if (frame.type === "members") {
                this.events.onMembers?.((frame as MembersMessage).members);
                return;
            }
            if (frame.type === "host_shutdown") {
                // 主机主动通告关停：立刻回退，不等 socket 关闭握手。
                // 硬断线必须立即响应 —— 用户感知不到等待才有体感。
                this.events.onLog?.(`[net] ${frame.reason}`);
                this.fallback(frame.reason);
                return;
            }
            if (frame.type === "relay_result") {
                // 阶段 3：顺序保证 —— 只接受递增 seq，乱序丢弃
                if (this.seqTracker.accept(frame.seq)) {
                    this.events.onRelayResult?.(frame);
                } else {
                    this.events.onLog?.(`[net] 丢弃乱序广播 seq=${frame.seq}`);
                }
            }
        });

        // 断线回退统一交给 attachLifecycle，避免同一连接注册两份 handler
        // （重复注册会让 fallback 触发两次，用户收到两条一样的提示）。
        this.attachLifecycle(ws);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== 1) return;
            try {
                ws.send(
                    JSON.stringify({ type: "ping", v: PROTOCOL_VERSION, deviceId: this.deviceId }),
                );
            } catch {
                // 发送失败，等 close 事件
                return;
            }
            // 规则 2：半开 —— 发完心跳等回应，超时即判定已死
            this.armPongTimeout();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private armPongTimeout(): void {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => {
            this.events.onLog?.("[net] 心跳超时，判定连接已失效");
            try {
                this.ws?.close(4000, "heartbeat timeout");
            } catch {
                // 忽略
            }
            this.fallback("和主机联系不上了");
        }, HEARTBEAT_TIMEOUT_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
    }

    /** 回退到独立工作。**不清任何配置**，用户重新打开开关就能自动归位。 */
    private fallback(reason: string): void {
        this.stopHeartbeat();
        this.closingIntentionally = true;
        try {
            this.ws?.close();
        } catch {
            // 忽略
        }
        this.ws = null;
        this.setStatus("fallback", reason);
        this.events.onFallback?.(reason);
        // 复位标记，方便下次 connect
        setTimeout(() => {
            this.closingIntentionally = false;
        }, 0);
    }

    /** 用户主动关闭组网：安静断开，不算异常。 */
    disconnect(): void {
        this.closingIntentionally = true;
        this.stopHeartbeat();
        try {
            this.ws?.close(1000, "user closed networking");
        } catch {
            // 忽略
        }
        this.ws = null;
        this.setStatus("idle");
    }

    /** 阶段 3 用：把请求上行给主机。 */
    sendRelay(content: string, images?: string[]): boolean {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return false;
        try {
            ws.send(
                JSON.stringify({
                    type: "relay_request",
                    v: PROTOCOL_VERSION,
                    deviceId: this.deviceId,
                    requestId: this.nextRequestId(),
                    content,
                    images,
                }),
            );
            return true;
        } catch {
            return false;
        }
    }
}
