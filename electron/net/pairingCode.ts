// electron/net/pairingCode.ts
// 连接码：生成、解析、校验、哈希。
//
// 「连接码」是设备之间配对用的通行证，形如：
//   kirari://connect?host=192.168.57.23&port=19760&token=xxxx&name=Aki-台式机&exp=1789xxxxxx&v=1
//
// 三个关键设计（来自 ARCHITECTURE-PLAN 5.3~5.5）：
//  1. **只管首次配对**。用掉一次就作废，之后设备靠长期凭据自动重连。
//     所以它过期影响的是「新设备还能不能配对」，不是「已连上的设备断不断」。
//  2. **只存哈希，不存明文**。载体是文本/二维码，极易被截图转发。
//  3. 过期用**绝对时间戳**（expiresAt），不用相对时长——否则重启后会漂移。
//
// 本模块是纯逻辑，不碰文件系统与 electron，便于单测。

import { NET_PORT, PAIRING_SCHEME, PROTOCOL_VERSION } from "./protocol";

/** 过期档位（用户自选）。 */
export const EXPIRY_PRESETS = [
    { key: "1h", label: "1 小时", ms: 60 * 60 * 1000 },
    { key: "1d", label: "1 天", ms: 24 * 60 * 60 * 1000 },
    { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000 },
    { key: "30d", label: "30 天", ms: 30 * 24 * 60 * 60 * 1000 },
    { key: "forever", label: "永不过期", ms: 0 },
] as const;

export type ExpiryKey = (typeof EXPIRY_PRESETS)[number]["key"];

/** 连接码里携带的信息（明文形态，用于展示/复制/扫码）。 */
export type PairingCode = {
    /** 主机地址（IP 或主机名） */
    host: string;
    /** 固定端口 */
    port: number;
    /** 配对口令（明文，只在生成时存在，存储用哈希） */
    token: string;
    /** 主机显示名，便于辨认 */
    name: string;
    /** 绝对过期时间戳（ms）。0 表示永不过期 */
    expiresAt: number;
    /** 协议版本 */
    v: number;
};

/** 存储形态：只有哈希，没有明文口令。 */
export type PairingRecord = {
    /** 记录 id（用于撤销单个） */
    id: string;
    /** 口令哈希（sha256 十六进制） */
    tokenHash: string;
    /** 主机显示名 */
    name: string;
    /** 绝对过期时间戳；0 = 永不过期 */
    expiresAt: number;
    createdAt: number;
    /** 已配对过的设备 id（用于「这码用过了就作废」） */
    usedBy: string | null;
    revoked: boolean;
};

/** 生成随机十六进制串。用于配对口令与长期凭据。 */
export function randomToken(bytes = 24): string {
    // 浏览器与 Node 都有的取随机方式；Electron 主进程有 globalThis.crypto。
    const c: Crypto | undefined = globalThis.crypto;
    if (c && typeof c.getRandomValues === "function") {
        const arr = new Uint8Array(bytes);
        c.getRandomValues(arr);
        return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    // 兜底（极老的运行时才会走到）
    let out = "";
    for (let i = 0; i < bytes * 2; i++) {
        out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
}

/** 口令哈希。只存这个，不存明文。 */
export function hashToken(token: string): string {
    const c: Crypto | undefined = globalThis.crypto;
    const text = `kirari-pair:${token}`;
    if (c && typeof c.subtle !== "undefined") {
        // subtle 是异步的，这里需要同步版本，故用 Node 的 crypto 走同步哈希。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return nodeSha256(text);
    }
    return nodeSha256(text);
}

/**
 * 同步 SHA-256。
 * 用 node:crypto 而不是 crypto.subtle（后者是异步的，会把整个调用链变成异步，
 * 配对校验这种热路径不值得）。
 */
function nodeSha256(text: string): string {
    // 运行时按可用性选择实现，避免把 electron 应用打成纯 Node 专用。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = requireNodeCrypto();
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireNodeCrypto(): { createHash: (alg: string) => { update: (s: string, e: string) => { digest: (e: string) => string } } } {
    // 打包后 __dirname 变了，所以不能静态 import；这里用 eval 间接拿，
    // 避免 vite 把 node:crypto 内联进产物导致 web 构建失败。
    const req = eval("require") as NodeRequire;
    return req("crypto");
}

/** 按档位算出绝对过期时间戳。forever → 0。 */
export function resolveExpiry(key: ExpiryKey, now = Date.now()): number {
    if (key === "forever") return 0;
    const preset = EXPIRY_PRESETS.find((p) => p.key === key);
    if (!preset) return now + EXPIRY_PRESETS[2].ms; // 未知档位退回 7 天
    return now + preset.ms;
}

/** 生成一条连接码（明文形态，用于展示给用户复制/扫码）。 */
export function generatePairingCode(opts: {
    host: string;
    name: string;
    expiryKey: ExpiryKey;
    port?: number;
    now?: number;
}): { code: PairingCode; record: PairingRecord } {
    const now = opts.now ?? Date.now();
    const token = randomToken(24);
    const expiresAt = resolveExpiry(opts.expiryKey, now);
    return {
        code: {
            host: opts.host,
            port: opts.port ?? NET_PORT,
            token,
            name: opts.name,
            expiresAt,
            v: PROTOCOL_VERSION,
        },
        record: {
            id: randomToken(8),
            tokenHash: hashToken(token),
            name: opts.name,
            expiresAt,
            createdAt: now,
            usedBy: null,
            revoked: false,
        },
    };
}

/**
 * 序列化成一条可复制 / 可生成二维码的字符串。
 * 之所以要序列化成 URL 而不是 JSON：二维码对短文本的密度更友好，
 * 且 URL 形式在聊天软件里点开也有机会被识别。
 */
export function serializePairingCode(code: PairingCode): string {
    const q = new URLSearchParams();
    q.set("host", code.host);
    q.set("port", String(code.port));
    q.set("token", code.token);
    q.set("name", code.name);
    q.set("exp", String(code.expiresAt));
    q.set("v", String(code.v));
    return `${PAIRING_SCHEME}?${q.toString()}`;
}

/** 解析连接码。粘贴别人发来的串时走这里。失败返回 null（不抛）。 */
export function parsePairingCode(raw: string): PairingCode | null {
    const text = String(raw || "").trim();
    if (!text.toLowerCase().startsWith(PAIRING_SCHEME)) return null;
    let q: URLSearchParams;
    try {
        q = new URL(text).searchParams;
    } catch {
        return null;
    }
    const host = (q.get("host") || "").trim();
    const token = (q.get("token") || "").trim();
    if (!host || !token) return null;

    const portNum = Number(q.get("port") || NET_PORT);
    const expNum = Number(q.get("exp") || 0);
    const vNum = Number(q.get("v") || PROTOCOL_VERSION);

    return {
        host,
        port: Number.isFinite(portNum) && portNum > 0 && portNum < 65536 ? portNum : NET_PORT,
        token,
        name: (q.get("name") || "未命名设备").slice(0, 40),
        expiresAt: Number.isFinite(expNum) && expNum >= 0 ? expNum : 0,
        v: Number.isFinite(vNum) && vNum > 0 ? vNum : PROTOCOL_VERSION,
    };
}

/** 配对码是否还在有效期内（永不过期返回 true）。 */
export function isPairingValid(record: PairingRecord, now = Date.now()): boolean {
    if (record.revoked) return false;
    if (record.expiresAt === 0) return true;
    return record.expiresAt > now;
}

/** 剩余有效期的中文描述，用于 UI 提示。 */
export function describeRemaining(record: PairingRecord, now = Date.now()): string {
    if (record.revoked) return "已撤销";
    if (record.expiresAt === 0) return "永不过期";
    const left = record.expiresAt - now;
    if (left <= 0) return "已过期";
    const hours = Math.floor(left / 3600000);
    if (hours >= 24) return `还有 ${Math.floor(hours / 24)} 天`;
    if (hours >= 1) return `还有 ${hours} 小时`;
    return `还有 ${Math.max(1, Math.floor(left / 60000))} 分钟`;
}

/**
 * 校验一次配对请求。
 * @returns 成功返回 null，失败返回给用户看的大白话原因。
 */
export function verifyPairing(
    records: PairingRecord[],
    presentedToken: string,
    deviceId: string,
    now = Date.now(),
): { error: string } | null {
    const presented = hashToken(String(presentedToken || "").trim());
    const record = records.find((r) => r.tokenHash === presented);
    if (!record) {
        return { error: "这个连接码不认识，检查是不是复制全了，或者已经撤销了" };
    }
    if (record.revoked) {
        return { error: "这个连接码已经被撤销了，让主人在设置里重新生成一个" };
    }
    if (record.usedBy && record.usedBy !== deviceId) {
        return { error: "这个连接码已经用过了，让主人生成一个新的" };
    }
    if (!isPairingValid(record, now)) {
        return { error: "这个连接码已经过期了，让主人在设置里重新生成一个" };
    }
    return null;
}
