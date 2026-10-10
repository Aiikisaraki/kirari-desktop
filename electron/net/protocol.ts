// electron/net/protocol.ts
// 组网协议定义：主机与叶子之间跑的消息格式。
//
// 设计原则（来自 ARCHITECTURE-PLAN 阶段 2）：
//  - 阶段 2 只做「基础设施」：配对、心跳、成员管理。**不含**活锁路由
//    （请求上行 / 结果广播属于阶段 3）。这里先把帧格式定好，阶段 3 往里加消息类型即可。
//  - 纯数据层，不 import electron / node 特有 API，因此核心版（kirari-core）
//    能直接复用同一份协议定义。
//  - 所有消息都带 `type` 与 `v`（协议版本），未知类型一律忽略而不是报错，
//    这样 v1 客户端连上 v2 主机不会崩。

/** 协议版本。主机与叶子版本不一致时，仍以能处理的最低能力为准。 */
export const PROTOCOL_VERSION = 1;

/** 固定端口：动态端口无法写进连接码（地址要能提前填进去）。 */
export const NET_PORT = 19760;

/** 心跳节奏：2 秒一次，超过 5 秒没回应即判定连接已死。 */
export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * 配对码格式版本。用于将来扩展字段时区分旧码。
 * 形如：kirari://connect?host=192.168.57.23&port=19760&token=xxx&name=Aki-台式机&exp=1789xxxxxx&v=1
 */
export const PAIRING_SCHEME = "kirari://connect";

// ── 客户端 → 主机 ────────────────────────────────────────────────

/** 配对：用一次性配对码换一个长期凭据。 */
export type PairRequest = {
    type: "pair";
    v: number;
    /** 本机设备标识（持久化生成，不可变） */
    deviceId: string;
    /** 设备显示名，让主人能在成员列表里认出来 */
    deviceName: string;
    /** 配对码里的口令 */
    token: string;
    /** 协议版本，用于主机侧判断能力 */
    v2?: number;
};

/** 心跳：叶子每 2 秒一次，主机回 pong。兼作「叶子还活着」的证据。 */
export type PingMessage = {
    type: "ping";
    v: number;
    deviceId: string;
};

// ── 主机 → 客户端 ────────────────────────────────────────────────

/** 配对结果。 */
export type PairResponse = {
    type: "pair_ok" | "pair_fail";
    v: number;
    /** 失败原因（pair_fail 时给用户看，必须是大白话） */
    reason?: string;
    /** 长期凭据：配对码用一次就作废，之后靠这个自动重连 */
    credential?: string;
    /** 主机分配的设备名（叶子可能被主机改名，便于辨认） */
    assignedName?: string;
    /** 当前在线成员数 */
    memberCount?: number;
};

/** 心跳回应。 */
export type PongMessage = {
    type: "pong";
    v: number;
    /** 主机侧维护的单调递增序号，叶子据此保证顺序 */
    seq: number;
    /** 服务器时间（毫秒），叶子据此估算时钟偏差 */
    serverTime: number;
};

/** 成员变化通知（阶段 2 只用于刷新 UI 列表）。 */
export type MembersMessage = {
    type: "members";
    v: number;
    members: { deviceId: string; name: string; online: boolean; since: number }[];
};

/**
 * 主机即将关闭的通告。
 *
 * 为什么不能只靠 TCP close 通知：服务端 close() 是「发起优雅关闭」，
 * 要等对端回应才真正断开；期间叶子那边完全无感知，桌宠看起来就是「卡住了」。
 * 明确发一帧通告，叶子能立刻带着原因回退独立工作 —— 符合「硬断线立即响应」
 * 和「退出要告知用户」两条要求。
 */
export type HostShutdown = {
    type: "host_shutdown";
    v: number;
    /** 给用户看的大白话 */
    reason: string;
};

/**
 * 阶段 3 预留：请求上行 / 结果广播。
 * 这里只占位以便协议版本对齐时不返工，实际逻辑在阶段 3 实现。
 */
export type RelayRequest = {
    type: "relay_request";
    v: number;
    deviceId: string;
    requestId: string;
    content: string;
    images?: string[];
};

export type RelayResult = {
    type: "relay_result";
    v: number;
    requestId: string;
    speech: string;
    emotion?: string | null;
    seq: number;
};

export type ServerFrame = PairResponse | PongMessage | MembersMessage | HostShutdown | RelayResult;
export type ClientFrame = PairRequest | PingMessage | RelayRequest;

/** 解析服务端发来的文本帧。非法 JSON / 缺 type 一律返回 null（不抛）。 */
export function parseServerFrame(raw: unknown): ServerFrame | null {
    return parseFrame(raw) as ServerFrame | null;
}

/** 解析叶子发来的文本帧。非法 JSON / 缺 type 一律返回 null（不抛）。 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
    return parseFrame(raw) as ClientFrame | null;
}

function parseFrame(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string") return null;
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const frame = obj as Record<string, unknown>;
    if (typeof frame.type !== "string") return null;
    return frame;
}

/** 叶子端本地记录已收到的主机 seq，用于阶段 3 的顺序保证。 */
export class SeqTracker {
    private last = 0;

    /** 只接受递增的 seq。乱序或重复一律丢弃。 */
    accept(seq: number): boolean {
        if (typeof seq !== "number" || !Number.isFinite(seq)) return false;
        if (seq <= this.last) return false;
        this.last = seq;
        return true;
    }

    get current(): number {
        return this.last;
    }

    reset(): void {
        this.last = 0;
    }
}
