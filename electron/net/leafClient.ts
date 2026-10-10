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
    CONNECT_TIMEOUT_MS,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    PROTOCOL_VERSION,
    parseServerFrame,
    SeqTracker,
} from "./protocol";
import type { MembersMessage, RelayResult, RelayBusy, RelayBackfill, ServerFrame, ConfigPush, SyncField } from "./protocol";
import { randomToken } from "./pairingCode";

export type LeafStatus = "idle" | "connecting" | "paired" | "connected" | "fallback";

export type LeafEvents = {
    /** 状态变化，供 UI 显示 */
    onStatus?: (status: LeafStatus, detail?: string) => void;
    /** 掉线回退。reason 是给用户看的大白话 */
    onFallback?: (reason: string) => void;
    /** 成员列表更新 */
    onMembers?: (members: MembersMessage["members"]) => void;
    /**
     * 收到广播的回复（阶段 3）。
     * 注意是**全网广播**——别人的提问也会推过来，这是活锁模型的必然结果：
     * 请求统一走主机，结果广播，所以其他设备也会看到这次对话。
     */
    onRelayResult?: (frame: RelayResult) => void;
    /** 主机拒绝了这次请求（排队满 / 正在关停） */
    onRelayBusy?: (frame: RelayBusy) => void;
    /** 主机下发了配置（白名单内的字段），写进本机即生效 */
    onConfigPush?: (frame: ConfigPush) => void;
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
    /**
     * 连接代号：每次新建连接 +1。
     *
     * ⚠️ 必需：disconnect() 里的 close 事件是异步到达的，往往在 connect()
     *    已经建好新连接之后才触发。若不校验代号，这条「旧连接的关闭事件」
     *    会被当成「新连接断了」，把刚建好的连接又关掉 —— 表现为重连永远失败，
     *    报「WebSocket was closed before the connection was established」。
     */
    private connGeneration = 0;
    /** 建连超时定时器：CONNECTING 状态卡住时兜底 */
    private connectTimer: ReturnType<typeof setTimeout> | null = null;

    /** 本轮连接是否是有意的（关闭组网时不算异常） */
    private closingIntentionally = false;
    /**
     * 断线期间本地独立工作产生的对话，等主机回来后补传。
     * 只补记录、**不重放模型调用**（ARCHITECTURE-PLAN 3.5）——
     * 重放会让其他叶子看到重复内容，还等于白花主机的额度。
     */
    private pendingBackfill: { sessionId: string; entries: RelayBackfill["entries"] }[] = [];

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
    private attachLifecycle(ws: WebSocket, gen: number): void {
        ws.on("close", () => {
            // 过期连接（如刚被 disconnect 的那条）的迟到 close 不能影响当前连接，
            // 否则重连会被自己刚发起的关闭打死。
            if (gen !== this.connGeneration) return;
            this.clearConnectTimeout();
            this.stopHeartbeat();
            // 规则 1：硬断线立即回退，不等超时
            if (!this.closingIntentionally) {
                this.fallback("和主机断开了");
            }
        });
        ws.on("error", (err: any) => {
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
            const gen = ++this.connGeneration;
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
                    this.attachLifecycle(ws, gen);
                    // 关键：配对成功后这条连接就是长期连接了，
                    // 后续所有广播（心跳、成员、回复）都要能处理，
                    // 否则表现为「配对成功但组网一直没反应」。
                    this.attachMessage(ws, gen);
                    this.startHeartbeat();
                    this.events.onLog?.(`[net] 配对成功，主机：${code.name || code.host}`);
                    // 首次配对成功也可能带着历史待补
                    this.flushBackfill();
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
        const gen = ++this.connGeneration;
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

        this.attachMessage(ws, gen);
        // 断线回退统一交给 attachLifecycle，避免同一连接注册两份 handler
        // （重复注册会让 fallback 触发两次，用户收到两条一样的提示）。
        this.attachLifecycle(ws, gen);
    }

    /**
     * 挂上「服务端帧处理」。
     *
     * ⚠️ 必须对**所有**连接路径生效 —— 首次配对（pair）与重连（connect）。
     *    之前这段只写在 openSocket() 里，而首次配对走的是 pair() 那条路，
     *    于是「刚配对上的设备」只能收到 pair_ok，之后所有广播（心跳 pong、
     *    成员变化、回复内容）都被静默丢弃 —— 表现为组网开着但永远没反应。
     *    是阶段 3 的三设备并发验收抓出来的。
     */
    private attachMessage(ws: WebSocket, gen: number): void {
        ws.on("message", (data: unknown) => {
            // 过期连接的迟到帧：忽略，否则会污染当前状态
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
                // 连上了：把断线期间的对话补传给主机（只记不重放）
                this.flushBackfill();
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
                // 阶段 3：顺序保证 —— 交给重排序缓冲，按 seq 升序交付。
                // 注意**不是**「非递增就丢弃」：并发生成时完成顺序 ≠ seq 顺序，
                // 严格递增会真的把消息丢掉。缓冲负责排序，但不丢。
                if (this.seqTracker.accept(frame.seq)) {
                    this.events.onRelayResult?.(frame as RelayResult);
                } else {
                    this.events.onLog?.(`[net] 忽略重复广播 seq=${frame.seq}`);
                }
                return;
            }
            if (frame.type === "relay_busy") {
                this.events.onRelayBusy?.(frame as RelayBusy);
                return;
            }
            if (frame.type === "config_push") {
                // 主机批准下发的配置：写进本机即生效
                this.events.onConfigPush?.(frame as ConfigPush);
                return;
            }
            if (frame.type === "relay_backfill_ack") {
                // 主机确认收到补传，可以清本地待补队列了
                this.pendingBackfill = [];
                this.events.onLog?.(`[net] 补传已被主机接收（${frame.count} 条）`);
                return;
            }
        });
    }

    /** 建连超时：CONNECTING 卡住超过阈值就放弃，回退独立工作。 */
    private armConnectTimeout(ws: WebSocket, gen: number): void {
        this.clearConnectTimeout();
        this.connectTimer = setTimeout(() => {
            this.connectTimer = null;
            if (gen !== this.connGeneration) return;
            if (ws.readyState !== 0) return; // 已经连上了
            this.events.onLog?.("[net] 建连超时，放弃这次连接");
            try {
                ws.terminate();
            } catch {
                // 忽略
            }
            this.fallback("连不上主机");
        }, CONNECT_TIMEOUT_MS);
    }

    private clearConnectTimeout(): void {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
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
        this.clearConnectTimeout();
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
        this.clearConnectTimeout();
        this.stopHeartbeat();
        try {
            this.ws?.close(1000, "user closed networking");
        } catch {
            // 忽略
        }
        this.ws = null;
        this.setStatus("idle");
    }

    /**
     * 阶段 3：把请求上行给主机。
     *
     * @param sessionId 本机的会话 ID —— 主机据此取上下文，所以每台设备
     *        的对话脉络互不串味，且重连后上下文还在（存在主机那边）。
     * @returns false 表示当前没连上，调用方应回退到本地独立处理
     */
    sendRelay(content: string, sessionId: string, images?: string[], nickname?: string): boolean {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return false;
        try {
            ws.send(
                JSON.stringify({
                    type: "relay_request",
                    v: PROTOCOL_VERSION,
                    deviceId: this.deviceId,
                    requestId: this.nextRequestId(),
                    sessionId,
                    content,
                    images,
                    nickname,
                }),
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 记录一条「本地独立工作期间产生的对话」，等主机回来后补传。
     * 只入库不重放 —— 详见 pendingBackfill 的注释。
     */
    recordLocalExchange(sessionId: string, role: "user" | "assistant", text: string): void {
        if (!text || !text.trim()) return;
        const bucket = this.pendingBackfill.find((b) => b.sessionId === sessionId);
        const entry = { role, text, at: Date.now() };
        if (bucket) {
            // 单次补传最多 200 条，避免长期离线攒出一大坨把主机库撑爆
            if (bucket.entries.length < 200) bucket.entries.push(entry);
        } else {
            this.pendingBackfill.push({ sessionId, entries: [entry] });
        }
    }

    /**
     * 上报配置改动给主机。
     *
     * **无条件上报**——叶子不判断该不该同步。判断在主机那边做（白名单是
     * 主机侧的东西，叶子看不到也不该管）。这样用户调整白名单立刻生效。
     * 返回 false 表示当前没连上主机。
     */
    reportConfigChange(patch: Partial<Record<SyncField, string>>): boolean {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return false;
        const clean: Partial<Record<SyncField, string>> = {};
        let has = false;
        for (const [k, v] of Object.entries(patch)) {
            if (typeof v === "string") {
                clean[k as SyncField] = v;
                has = true;
            }
        }
        if (!has) return false;
        try {
            ws.send(
                JSON.stringify({
                    type: "config_report",
                    v: PROTOCOL_VERSION,
                    deviceId: this.deviceId,
                    patch: clean,
                }),
            );
            return true;
        } catch {
            return false;
        }
    }

    /** 待补传的条数（给 UI 显示「有 N 条待同步」） */
    pendingBackfillCount(): number {
        return this.pendingBackfill.reduce((n, b) => n + b.entries.length, 0);
    }

    /** 重连成功后自动补传。主机确认（backfill_ack）后清空。 */
    flushBackfill(): void {
        if (!this.pendingBackfill.length) return;
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return;
        const deviceName = this.deviceName;
        for (const bucket of this.pendingBackfill) {
            try {
                ws.send(
                    JSON.stringify({
                        type: "relay_backfill",
                        v: PROTOCOL_VERSION,
                        deviceId: this.deviceId,
                        sessionId: bucket.sessionId,
                        nickname: deviceName,
                        entries: bucket.entries,
                    }),
                );
            } catch {
                return; // 下次重连再试
            }
        }
        this.events.onLog?.(`[net] 已补传 ${this.pendingBackfillCount()} 条离线对话`);
    }
}
