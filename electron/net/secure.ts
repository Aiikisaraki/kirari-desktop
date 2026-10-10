// electron/net/secure.ts
// 组网通信加密：对称加密 + 防重放。
//
// ── 为什么用预共享密钥（PSK）而不是 TLS ──
//   家用组网没有公网基础设施，也不该要求每台设备装证书。PSK 只要两边
//   拿着同一串密钥就能安全通信，实现和维护成本都低得多。
//
// ── 安全边界（务必明白，不要误以为能挡住所有人）──
//   能挡住：局域网里扫端口试探的陌生设备、蹭网抓包偷看对话的人。
//   挡不住：拿到安装包并解包 JS 的人 —— 密钥必然在程序里。
//   所以它防的是「随手接入」，不是「定向破解」。
//
// ── 加密范围 ──
//   hello / hello_ack 保持明文（握手必须明文，否则无法协商 salt）
//   心跳 ping / pong 保持明文（不含信息，加密纯浪费 CPU，且明文方便排障）
//   其余**全部**加密：配对结果、长期凭据、对话内容、配置同步、成员列表
//
// ── 每帧独立 IV，不做流式同步 ──
//   自包含、无需维护序号窗口的流状态，代价只是每帧多 28 字节。
//   聊天场景的量级下这个开销可以忽略。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * 构建期注入的组网密钥。
 *
 * 由 vite 的 define 在打包时替换成字符串字面量（见 vite.config.ts）。
 * 本地开发走 .env.local，CI 走 GitHub Secret。
 */
declare const __KIRARI_NET_SECRET__: string;

function readSecret(): string {
    // 打包后 __KIRARI_NET_SECRET__ 被替换成字面量；dev 下可能未定义
    try {
        if (typeof __KIRARI_NET_SECRET__ === "string" && __KIRARI_NET_SECRET__) {
            return __KIRARI_NET_SECRET__;
        }
    } catch {
        // 未定义 → 走下面的环境变量
    }
    // dev 模式（vite dev 不做 define 替换）从环境变量兜底
    if (typeof process !== "undefined" && process.env?.KIRARI_NET_SECRET) {
        return process.env.KIRARI_NET_SECRET;
    }
    return "";
}

/**
 * 本机构建是否包含组网密钥。
 *
 * false 时组网功能整体禁用 —— 这样 fork 后自行构建的人拿不到密钥，
 * 也不会把别人的密钥带进自己的构建产物。
 */
export const NET_SECRET = readSecret();
export const NET_ENABLED = NET_SECRET.length >= 16;

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM 推荐 12 字节
const TAG_LEN = 16;
/** 加密帧的线格式标识 */
export const SEALED_MARK = "e";

/**
 * 由密钥 + salt 派生会话密钥。
 *
 * 用 scrypt 而不是直接拿密钥当 AES key：
 *   - 密钥是给人输入/构建时注入的短串，不是合规的 32 字节密钥材料
 *   - scrypt 慢，能大幅提高暴力猜解的成本
 *   - 加 salt 后不同主机派生出不同会话密钥 —— 一台被攻破不牵连其他主机
 */
export function deriveKey(secret: string, salt: string): Buffer {
    return scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** 生成新的 salt（主机首次启动时生成一次并持久化） */
export function newSalt(): string {
    return randomBytes(16).toString("hex");
}

/** 加密一帧。返回可直接放进 {e,d} 的 base64 串。 */
export function seal(key: Buffer, frame: unknown): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(frame), "utf8");
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

/**
 * 解密一帧。失败返回 null（密钥不对 / 数据被篡改 / 不是密文）。
 *
 * 不抛异常是刻意的：握手阶段会拿各种畸形数据来试，不该因此崩掉。
 */
export function open(key: Buffer, payload: string): Record<string, unknown> | null {
    try {
        const raw = Buffer.from(payload, "base64");
        if (raw.length <= IV_LEN + TAG_LEN) return null;
        const iv = raw.subarray(0, IV_LEN);
        const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const data = raw.subarray(IV_LEN + TAG_LEN);
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(data), decipher.final()]);
        const obj = JSON.parse(dec.toString("utf8"));
        return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * 常量时间比较两个字符串，避免时序侧信道。
 * 用于比对长期凭据。
 */
export function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/**
 * 防重放窗口。
 *
 * AES-GCM 能防篡改，但**不能防重放**：抓到一条合法密文就能无限重发。
 * 加密帧里带一个自增序号，接收端只接受「比已见最大值大」的帧，
 * 并保留最近 N 个序号 —— 既挡住重放，又允许轻微乱序。
 *
 * 这里用「水位 + 环形缓冲」而不是位图：逻辑简单，且窗口大小固定不增长。
 */
export class ReplayGuard {
    private highWater = 0;
    private seen: number[] = [];
    constructor(private readonly windowSize = 256) {}

    /** 返回 true 表示这是首次出现、应当接受。 */
    accept(seq: number): boolean {
        if (!Number.isSafeInteger(seq) || seq <= 0) return false;
        if (seq > this.highWater) {
            this.highWater = seq;
            this.remember(seq);
            return true;
        }
        // 落在历史窗口内：见过就丢
        if (this.seen.includes(seq)) return false;
        // 离水位太远（远超窗口）的旧帧也丢：多半是重放
        if (this.highWater - seq > this.windowSize) return false;
        this.remember(seq);
        return true;
    }

    private remember(seq: number): void {
        this.seen.push(seq);
        if (this.seen.length > this.windowSize) {
            this.seen.shift();
        }
    }

    reset(): void {
        this.highWater = 0;
        this.seen = [];
    }

    /** 诊断用 */
    get state(): { highWater: number; windowUsed: number } {
        return { highWater: this.highWater, windowUsed: this.seen.length };
    }
}