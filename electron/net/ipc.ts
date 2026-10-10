// electron/net/ipc.ts
// 组网的 IPC 出口：把 NetManager 的能力暴露给设置窗口。
//
// 单独成文件的原因：组网有 10 来个入口，全塞进 main.ts 会把已经很长的
// main.ts 撑得更难读；而且这一层只做「参数校验 + 转发 + 文案兜底」，
// 有独立的边界。
//
// 设计原则（ARCHITECTURE-PLAN 6.7）：错误提示要说清「下一步该做什么」，
// 且不裸露 WebSocket / Token / 适配器这类术语。

import { ipcMain } from "electron";
import QRCode from "qrcode";
import type { NetManager, NetSnapshot } from "./manager";
import type { ExpiryKey, PairingCode } from "./pairingCode";
import { SYNC_FIELDS } from "./protocol";
import type { SyncField } from "./protocol";

/** 允许的过期档位，防止非法值进来 */
const EXPIRY_KEYS: ExpiryKey[] = ["1h", "1d", "7d", "30d", "forever"];

function pickExpiry(value: unknown): ExpiryKey {
    return EXPIRY_KEYS.includes(value as ExpiryKey) ? (value as ExpiryKey) : "7d";
}

function serializeCode(code: PairingCode): string {
    // 延迟引入避免循环：pairingCode 是纯逻辑模块
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { serializePairingCode } = require("./pairingCode") as typeof import("./pairingCode");
    return serializePairingCode(code);
}

export function setupNetIpc(getManager: () => NetManager | null): void {
    const withManager = (fn: (m: NetManager, ...args: any[]) => unknown) =>
        async (_event: unknown, ...args: unknown[]) => {
            const m = getManager();
            if (!m) {
                return { ok: false, error: "组网功能还没准备好，稍等一下再试" };
            }
            return fn(m, ...args);
        };

    /** 当前组网状态（页面渲染的唯一数据源） */
    ipcMain.handle("net:get-state", withManager((m) => m.snapshot() satisfies NetSnapshot));

    /** 本机可用于组网的地址（页面提示「用哪个地址连」） */
    ipcMain.handle("net:addresses", withManager((m) => m.addresses()));

    /**
     * 作为主机开启组网，并生成第一个连接码。
     * 成功即表示：开始监听固定端口，其他设备可以填码接入。
     */
    ipcMain.handle(
        "net:start-host",
        withManager(async (m, expiry: unknown) => {
            const r = await m.startHosting(pickExpiry(expiry));
            if (!r.ok) return r;
            return { ok: true as const, code: serializeCode(r.code), snapshot: m.snapshot() };
        }),
    );

    /** 再生成一个连接码（每台设备一个码） */
    ipcMain.handle(
        "net:issue-pairing",
        withManager((m, expiry: unknown) => ({
            ok: true as const,
            code: serializeCode(m.issuePairing(pickExpiry(expiry))),
            snapshot: m.snapshot(),
        })),
    );

    /** 作为叶子加入：填入连接码完成首次配对 */
    ipcMain.handle(
        "net:join",
        withManager(async (m, pairingText: unknown) => {
            const text = typeof pairingText === "string" ? pairingText.trim() : "";
            if (!text) return { ok: false as const, error: "先把主机给你的连接码整串粘进来" };
            const r = await m.startFollowing(text);
            return { ...r, snapshot: m.snapshot() };
        }),
    );

    /** 重新加入已配对的主机（打开开关时用，不需要重新填码） */
    ipcMain.handle(
        "net:resume",
        withManager((m) => ({ ...m.resumeFollowing(), snapshot: m.snapshot() })),
    );

    /**
     * 关闭组网。
     * 只「暂停参与」，不清除主机地址 / 长期凭据 / 已生成的连接码 ——
     * 下次打开开关凭持久化信息自动归位，用户零成本反复切换。
     */
    ipcMain.handle(
        "net:stop",
        withManager((m) => {
            m.stopNetworking();
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /** 撤销某个连接码：作废配对入口，不影响已连上的设备 */
    ipcMain.handle(
        "net:revoke-pairing",
        withManager((m, id: unknown) => {
            if (typeof id !== "string" || !id) return { ok: false as const, error: "没指定要撤销哪个" };
            m.revokePairingCode(id);
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /** 清理已过期的连接码 */
    ipcMain.handle(
        "net:prune-pairings",
        withManager((m) => {
            m.prunePairings();
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /**
     * 移除设备：作废它的长期凭据，之后再也连不上。
     * 与「退出组网」语义不同 —— 退出是暂停参与（凭据留着），移除是彻底断开。
     */
    ipcMain.handle(
        "net:remove-device",
        withManager((m, deviceId: unknown) => {
            if (typeof deviceId !== "string" || !deviceId) return { ok: false as const, error: "没指定要移除哪台设备" };
            m.removeDevice(deviceId);
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /** 叶子端「移除自己」：断开与主机的绑定并清掉本地凭据 */
    ipcMain.handle(
        "net:leave-host",
        withManager((m) => {
            m.leaveHost();
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /** 改本机在组网里的显示名 */
    ipcMain.handle(
        "net:rename-self",
        withManager((m, name: unknown) => {
            m.renameSelf(typeof name === "string" ? name : "");
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /** 立刻把待同步的离线对话补传给主机（页面上的「立即同步」按钮） */
    ipcMain.handle(
        "net:flush-backfill",
        withManager((m) => {
            m.flushBackfillNow();
            return { ok: true as const, snapshot: m.snapshot() };
        }),
    );

    /**
     * 读取配置同步白名单。
     * 只有主机侧有内容；叶子侧返回空数组（叶子看不到也改不了这个开关）。
     */
    ipcMain.handle("net:sync-whitelist", withManager((m) => ({ whitelist: m.syncWhitelist() })));

    /** 设置白名单。调整后立即生效，不需要叶子重新连接。 */
    ipcMain.handle(
        "net:set-sync-whitelist",
        withManager((m, fields: unknown) => {
            const clean = Array.isArray(fields) ? (fields.filter((f) => SYNC_FIELDS.includes(f)) as SyncField[]) : [];
            m.setSyncWhitelist(clean);
            return { ok: true as const, whitelist: m.syncWhitelist(), snapshot: m.snapshot() };
        }),
    );

    /**
     * 把连接码渲染成二维码（data URL）。
     * 放主进程是为了不让 qrcode 进渲染层产物 —— 它只在「看一眼扫一扫」时用一次。
     */
    ipcMain.handle(
        "net:code-qr",
        withManager(async (_m, code: unknown) => {
            const text = typeof code === "string" ? code.trim() : "";
            if (!text) return { ok: false as const, error: "没有可生成的连接码" };
            try {
                const dataUrl = await QRCode.toDataURL(text, {
                    width: 360,
                    margin: 2,
                    // 容错等级 M：打印/屏幕截图都能扫出来
                    errorCorrectionLevel: "M",
                    color: { dark: "#1f2937", light: "#ffffff" },
                });
                return { ok: true as const, dataUrl };
            } catch (e) {
                return { ok: false as const, error: `二维码生成失败：${(e as Error)?.message || e}` };
            }
        }),
    );

    /** 出口忙不忙（主机侧显示排队情况） */
    ipcMain.handle("net:relay-stats", withManager((m) => m.relayStats()));
}
