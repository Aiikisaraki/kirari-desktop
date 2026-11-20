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

    it("★ 组网 relayed 消息：主人设备本机会话 → owner，客人平台会话 → user", async () => {
        const oi = await import("./ownerIdentity");
        // 叶子=主人设备（配对凭据已鉴权）；本机会话派生成主人
        for (const sid of ["9284e4f6-7123-4577-bb69-d788bd1cadce", "session_1732000000000"]) {
            const sc = oi.sceneFromSessionId(sid) as any;
            expect(sc.role).toBe("owner");
            expect(sc.isOwner).toBe(true);
            expect(sc.senderId).toBe(OWNER_QQ);
        }
        // 主人 QQ 私聊平台会话 → owner
        const ownerSc = oi.sceneFromSessionId(`bot-onebot-private:xxx:user:${OWNER_QQ}`) as any;
        expect(ownerSc.role).toBe("owner");
        expect(ownerSc.senderId).toBe(OWNER_QQ);
        // 客人 QQ 平台会话 → user（隔离，不提权）
        const guestSc = oi.sceneFromSessionId(`bot-onebot-private:xxx:user:${FRIEND_QQ}`) as any;
        expect(guestSc.role).toBe("user");
        expect(guestSc.senderId).toBe(FRIEND_QQ);
        expect(guestSc.isOwner).toBe(false);
        // 群聊 → isGroup，不授 owner
        const groupSc = oi.sceneFromSessionId(`bot-onebot-group:${OWNER_QQ}`) as any;
        expect(groupSc.isGroup).toBe(true);
        expect(groupSc.role).toBe("user");
    });
});

// ── 2026-11-20 规范化：同一个主人的多种写法必须认成同一个人 ──────────────
//
// 用户原话：
//   「既然三个入口是一个身份，那我不管哪个入口都可以应该看得到啊，
//     你这bug也太多了」
//   「还是打补丁，你要考虑一下还有没有其他是主人但是没被存为 _local 的情况，
//     也一并处理掉，我们要规范化编码了」
//
// 这个 describe 把「归一化」本身钉成回归：以前每次故障都是因为某一行比较
// 没认出 '_local' / 本机会话 UUID，然后在那一行补个 ||，下条语句又漏。
describe("ownerIdentity · 身份归一化（canonical identity）", () => {
    const LOCAL_SID = "9284e4f6-7123-4577-bb69-d788bd1cadce";

    it("★ 所有「其实就是主人」的写法归一成同一个键", async () => {
        const oi = await import("./ownerIdentity");
        const forms = [
            OWNER_QQ,
            "_local",
            "local",
            "uid=1",
            "1",
            "__builtin__",
            LOCAL_SID,
            `net:device-a:${LOCAL_SID}`,
            "session_1795089710522",
            "console-abc123",
            `  ${OWNER_QQ}  `,
        ];
        for (const raw of forms) {
            expect(oi.canonicalIdentity(raw), `canonicalIdentity(${JSON.stringify(raw)})`)
                .toBe(OWNER_QQ);
        }
    });

    it("★ samePerson：任意两种主人写法都是同一个人", async () => {
        const oi = await import("./ownerIdentity");
        const forms = [OWNER_QQ, "_local", LOCAL_SID, "session_1", "1"];
        for (const a of forms) {
            for (const b of forms) {
                expect(oi.samePerson(a, b), `samePerson(${a}, ${b})`).toBe(true);
            }
        }
    });

    it("★ 客人隔离红线：客人绝不能被归一到主人", async () => {
        const oi = await import("./ownerIdentity");
        expect(oi.canonicalIdentity(FRIEND_QQ)).toBe(FRIEND_QQ);
        expect(oi.samePerson(FRIEND_QQ, OWNER_QQ)).toBe(false);
        expect(oi.samePerson(FRIEND_QQ, "_local")).toBe(false);
        expect(oi.samePerson(FRIEND_QQ, LOCAL_SID)).toBe(false);
        // 客人的平台/工作空间会话也不得归一成主人
        for (const sid of [
            `bot-onebot-private:xxx:user:${FRIEND_QQ}`,
            `workspace:${FRIEND_QQ}:每日提醒`,
            `sub::${FRIEND_QQ}::task-1`,
        ]) {
            expect(oi.canonicalIdentity(sid), sid).not.toBe(OWNER_QQ);
        }
    });

    it("★ 空值 fail-closed：绝不默认成主人", async () => {
        const oi = await import("./ownerIdentity");
        for (const v of ["", "   ", null, undefined]) {
            expect(oi.canonicalIdentity(v as any)).toBe("");
            expect(oi.samePerson(v as any, OWNER_QQ)).toBe(false);
        }
    });

    it("★ 报障复现：本机会话建的提醒，落库 ownerKey 必须是规范键", async () => {
        const oi = await import("./ownerIdentity");
        const tr = await import("./taskRuntime");
        const { jobStore } = await import("../events/jobStore");
        const sid = LOCAL_SID;

        const res = await tr.handleScheduleReminder(
            { title: "测试提醒", text: "一分钟后到", delayMs: 60_000 },
            { sessionId: sid, uid: 1, origin: "core", role: "owner", displayName: "主人" } as any,
        );
        expect(String(res)).toContain("已设好提醒");

        const jobs = jobStore.list(sid, 50) || [];
        const job = jobs.find((j: any) => String(j.title) === "测试提醒");
        expect(job).toBeTruthy();
        // 关键断言：不是 '_local'，而是规范身份键
        expect(String((job as any).ownerKey)).toBe(OWNER_QQ);
        expect(oi.samePerson((job as any).ownerKey, oi.getOwnerKey())).toBe(true);
    });

    it("★ 桌面投递闸门：_local / UUID / 规范键都收，客人不收", async () => {
        const svc = await import("./scheduledJobsService");
        const mk = (ownerKey: string) => ({
            jobId: `probe-${ownerKey}`,
            sessionId: LOCAL_SID,
            ownerKey,
            kind: "reminder",
            title: "t",
            payload: "p",
            status: "pending",
        }) as any;

        for (const k of ["_local", LOCAL_SID, OWNER_QQ]) {
            expect(svc.shouldSpeakOnDesktop(mk(k), OWNER_QQ), `want=${k}`).toBe(true);
        }
        expect(svc.shouldSpeakOnDesktop(mk(FRIEND_QQ), OWNER_QQ)).toBe(false);
        // 查不到主人是谁 → 明确归属到某人的一律 fail-closed
        expect(svc.shouldSpeakOnDesktop(mk(OWNER_QQ), null)).toBe(false);
        expect(svc.shouldSpeakOnDesktop(mk(FRIEND_QQ), null)).toBe(false);
        // '_local' 是「本机自建」的来源标记，与主人是谁无关，仍放行
        expect(svc.shouldSpeakOnDesktop(mk("_local"), null)).toBe(true);
    });
});
