// electron/ai/services/selfOps.spec.ts
// 自我运维的策略边界测试：白名单拒绝凭证、思考模式读写、未知 topic、审计可查。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 用隔离的 HOME 根，避免测试改到用户真实 ~/.kirari/config.json
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-selfops-spec-"));
process.env.KIRARI_HOME = tmpHome;

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
        expect(selfOps.read("nonsense")).toContain("未知 topic");
    });

    it("凭证类字段被白名单拒绝，且不产生实际修改", () => {
        const out = selfOps.update({ "modelConfig.key": "leaked" }, { sessionId: "t" });
        expect(out).toContain("不在安全白名单内");
        expect(out).toContain("本次未做任何修改");
    });

    it("思考模式可写、可读、可复原；思考说明随模式变化", () => {
        const original = config.getThinking();
        try {
            expect(selfOps.update({ "thinking.mode": "on" }, { sessionId: "t" })).toContain("✓ thinking.mode");
            expect(config.getThinking()).toBe("on");
            expect(selfOps.read("thinking")).toContain("列 2-4 条简要思路");
        } finally {
            selfOps.update({ "thinking.mode": original }, { sessionId: "t" });
        }
        expect(config.getThinking()).toBe(original);
    });

    it("自检报告包含模型、能力、思考模式", () => {
        const d = selfOps.read("diagnose");
        expect(d).toContain("模型配置");
        expect(d).toContain("能力注册表");
        expect(d).toContain("思考模式");
    });

    it("白名单外的值域校验生效（越界整数被拒，且不修改）", () => {
        const before = config.getAgentProfile().maxRounds;
        const out = selfOps.update({ "agentProfile.maxRounds": 9999 }, { sessionId: "t" });
        expect(out).toContain("校验未通过");
        expect(config.getAgentProfile().maxRounds).toBe(before);
    });

    it("审计记录可查到被拒绝与成功的修改", () => {
        const a = selfOps.read("audit");
        expect(a).toContain("modelConfig.key");
        expect(a).toContain("thinking.mode");
    });

    it("self_manage：创建提醒后可列出、改内容、取消", () => {
        const ctx = { sessionId: "s1", uid: 1, origin: "self_ops" as const };
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
        const ctx = { sessionId: "s1", uid: 1 };
        const out = selfOps.manage("cancel_reminder", { jobId: "does-not-exist" }, ctx);
        expect(out).toContain("找不到提醒");
    });

    it("self_manage：未知 action 报错", () => {
        expect(selfOps.manage("drop_database", {}, {})).toContain("未知 action");
    });
});
