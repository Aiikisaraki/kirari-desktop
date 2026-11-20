// @vitest-environment node
// electron/ai/services/ownerIdentity —— 三入口同一身份的回归。
//
// 用户 2026-11-20 拍板：「这三个入口，就是同一个身份，同一个对话框上下文。
// 在这里说的话，会同步、会记录共享、会共享会话窗口、会同步上下文；在这里
// 创建的任务，同样会返回给我的 QQ 与她私聊的窗口，会同步到网页端。」
//
// 之前"主人"有四个键（QQ 号 / '_local' / 会话 UUID / uid=1），同一个人在
// 不同子系统里成了四个人。这个文件把「只有一个键」钉死。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-ownerid-"));
const OWNER_QQ = "1980308740";
const FRIEND_QQ = "1658359753";

beforeAll(async () => {
    const db = await import("../db/storage");
    db.initDatabase(path.join(tmpDir, "pet_sessions.db"));
    const memory = await import("./memory");
    await memory.touchPerson({ personKey: OWNER_QQ, role: "owner", displayName: "Aii如樱如月" });
    await memory.touchPerson({ personKey: FRIEND_QQ, role: "user" });
});

afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 忽略 */ }
});

describe("ownerIdentity · 三入口同一个身份", () => {
    it("★ 规范身份键 = people 表里的主人账号，不是客人", async () => {
        const oi = await import("./ownerIdentity");
        expect(oi.getOwnerKey()).toBe(OWNER_QQ);
        expect(oi.getOwnerKey()).not.toBe(FRIEND_QQ);
    });

    it("★ 网页 / 桌宠 / QQ 三入口身份键逐字相同", async () => {
        const oi = await import("./ownerIdentity");
        const consoleScene = oi.ownerScene({ platform: "console" });
        const desktopScene = oi.ownerScene({ platform: "desktop" });
        const qqScene = oi.ownerScene({ platform: "onebot", chatType: "private" });
        expect(consoleScene.senderId).toBe(OWNER_QQ);
        expect(desktopScene.senderId).toBe(consoleScene.senderId);
        expect(qqScene.senderId).toBe(consoleScene.senderId);
        // 绝不是 '_local' 或会话 UUID
        expect(consoleScene.senderId).not.toBe("_local");
        for (const s of [consoleScene, desktopScene, qqScene]) {
            expect(s.role).toBe("owner");
            expect(s.isOwner).toBe(true);
            expect(s.trustedLocal).toBe(true);
        }
    });

    it("★ 三入口解析出的工作空间 owner 也完全相同", async () => {
        const oi = await import("./ownerIdentity");
        const workspace = await import("./workspace");
        for (const platform of ["console", "desktop", "onebot"]) {
            const scene = oi.ownerScene({ platform });
            expect(workspace.resolveOwnerFromCtx(scene as any)).toBe(OWNER_QQ);
        }
    });
});
