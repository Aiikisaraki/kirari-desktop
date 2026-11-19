// electron/ai/services/selfOps.spec.ts
// 自我运维的策略边界测试：白名单拒绝凭证、思考模式读写、未知 topic、审计可查。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 用隔离的 HOME 根，避免测试改到用户真实 ~/.kirari/config.json
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-selfops-spec-"));
process.env.KIRARI_HOME = tmpHome;

/**
 * 显式的拥有者身份。
 *
 * 为什么需要它：2026-11-20 身份隔离大排查后，`roleOf` 改成 fail-closed ——
 * 只认 ctx 里**显式声明**的 role / isOwner / trustedLocal，不再根据
 * sessionId 形状猜主人（原来「不以 bot 开头就当 owner」让桌面聊天框、
 * 子代理、工作空间任务、组网四条路径全都拿到了最高权限，用户报的
 * 「她以为自己是主人」就是从那儿来的）。
 *
 * 所以这些**测功能**的用例必须显式表态自己是主人，否则会被正确地对
 * 拒之门外。这不是放宽权限，而是把身份声明从"猜"改成"说"。
 */
const OWNER = { role: "owner" as const, isOwner: true as const, trustedLocal: true as const };

describe("selfOps（自我运维）", () => {
    let selfOps: typeof import("./selfOps");
    let config: typeof import("../../model-config");

    beforeAll(async () => {
        // 动态 import，确保上面设置的环境变量先生效
        selfOps = await import("./selfOps");
        config = await import("../../model-config");
    });

    afterAll(() => {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("TOPICS 覆盖各领域，readme 说明自我", () => {
        expect(selfOps.TOPICS).toContain("capabilities");
        expect(selfOps.TOPICS).toContain("diagnose");
        expect(selfOps.read("readme")).toContain("Kirari");
    });

    it("未知 topic 给出可读列表", () => {
        expect(selfOps.read("nonsense", OWNER)).toContain("未知 topic");
    });

    it("凭证类字段被白名单拒绝，且不产生实际修改", () => {
        const out = selfOps.update({ "modelConfig.key": "leaked" }, OWNER);
        expect(out).toContain("不在安全白名单内");
        expect(out).toContain("本次未做任何修改");
    });

    it("思考模式可写、可读、可复原；思考说明随模式变化", () => {
        const original = config.getThinking();
        try {
            expect(selfOps.update({ "thinking.mode": "on" }, OWNER)).toContain("✓ thinking.mode");
            expect(config.getThinking()).toBe("on");
            expect(selfOps.read("thinking", OWNER)).toContain("列 2-4 条简要思路");
        } finally {
            selfOps.update({ "thinking.mode": original }, OWNER);
        }
        expect(config.getThinking()).toBe(original);
    });

    it("自检报告包含模型、能力、思考模式", () => {
        const d = selfOps.read("diagnose", OWNER);
        expect(d).toContain("模型配置");
        expect(d).toContain("能力注册表");
        expect(d).toContain("思考模式");
    });

    it("白名单外的值域校验生效（越界整数被拒，且不修改）", () => {
        const before = config.getAgentProfile().maxRounds;
        const out = selfOps.update({ "agentProfile.maxRounds": 9999 }, OWNER);
        expect(out).toContain("校验未通过");
        expect(config.getAgentProfile().maxRounds).toBe(before);
    });

    it("审计记录可查到被拒绝与成功的修改", () => {
        const a = selfOps.read("audit", OWNER);
        expect(a).toContain("modelConfig.key");
        expect(a).toContain("thinking.mode");
    });

    it("self_manage：创建提醒后可列出、改内容、取消", () => {
        const ctx = { sessionId: "s1", uid: 1, origin: "self_ops" as const, ...OWNER };
        const created = selfOps.manage("create_reminder", { title: "测试提醒", text: "出门", delayMs: 60000 }, ctx);
        expect(created).toContain("已补设提醒");
        const list = selfOps.read("reminders", ctx);
        expect(list).toContain("测试提醒");
        const jobId = (list.match(/(job-[a-z0-9]+-[a-z0-9]+)/) || [])[1];
        expect(jobId).toBeTruthy();
        expect(selfOps.manage("update_reminder", { jobId, text: "改成上午" }, ctx)).toContain("已更新提醒");
        expect(selfOps.manage("cancel_reminder", { jobId }, ctx)).toContain("已取消提醒");
        expect(selfOps.read("reminders", ctx)).toContain("已取消");
    });

    it("self_manage：系统任务(daily_brief)不可被当作提醒取消", () => {
        const ctx = { sessionId: "s1", uid: 1, ...OWNER };
        const out = selfOps.manage("cancel_reminder", { jobId: "does-not-exist" }, ctx);
        expect(out).toContain("找不到提醒");
    });

    it("self_manage：未知 action 报错", () => {
        expect(selfOps.manage("drop_database", {}, {})).toContain("未知 action");
    });

    // ── 身份闸门本身的行为（2026-11-20 排查新增）──────────────────────
    // 上面那些用例显式声明了主人身份；这里反过来钉死"没有声明就拿不到"，
    // 避免以后有人为了过测试而把 fail-closed 改回去。
    it("★ 没有显式声明身份时，拿不到拥有者专属的读权限", () => {
        const anon = { sessionId: "s1", uid: 1 }; // 什么都没声明
        expect(selfOps.read("diagnose", anon)).not.toContain("模型配置");
        expect(selfOps.update({ "thinking.mode": "on" }, anon)).toContain("noperm");
        expect(selfOps.manage("cancel_reminder", { jobId: "x" }, anon)).toContain("noperm");
    });

    it("★ sessionId 形状不能升权（原来「不以 bot 开头就当主人」的洞）", () => {
        // 这四种形状以前全被判成 owner：桌面聊天框、子代理、工作空间任务、组网
        for (const sessionId of ["session_1712345678", "sub::1::t1", "workspace:o:t1", "net:dev:s1"]) {
            expect(selfOps.read("diagnose", { sessionId, uid: 1 })).not.toContain("模型配置");
        }
    });

    it("★ 显式 trustedLocal 才是本机主人", () => {
        expect(selfOps.read("diagnose", selfOps.trustedLocalCtx({ sessionId: "session_1" })))
            .toContain("模型配置");
    });
});
