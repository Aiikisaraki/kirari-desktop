// @vitest-environment node
// 阶段 D：desktop 统一能力注册表 + SKILL.md 渐进披露回归。
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/capabilities-d-${process.pid}`);
vi.mock("electron", () => ({ app: { getPath: () => tmpDir } }));

beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(
        path.join(tmpDir, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: 演示技能\n---\n# 步骤\n1. 做 A\n2. 做 B",
    );
    // ESM 下 require("electron") 不可用，显式注入 skills 根目录，不依赖 electron mock。
    skillMd.setSkillMdRoot(path.join(tmpDir, "skills"));
});

import * as caps from "./registry";
import * as skillMd from "../skills/skillMd";

describe("阶段 D · builtin 自动加载 + schema", () => {
    it("7 个内置能力自动加载，均为标准 function schema", () => {
        const tools = caps.listTools("local::test");
        const names = tools.map((t: any) => t.function.name).sort();
        for (const n of ["get_current_time", "get_weather", "web_search", "generate_image", "plan", "schedule_reminder", "load_skill"])
            expect(names).toContain(n);
        expect(tools.every((t: any) => t.type === "function")).toBe(true);
    });

    it("builtin 优先级高于同名 global，防止覆盖内置 schema", () => {
        caps.registerGlobal([{ name: "get_weather", description: "同名", parameters: {}, execute: async () => "global" }]);
        expect(caps.resolve("local::test", "get_weather")?.scope).toBe("builtin");
    });
});

describe("阶段 D · scope 隔离（多客户端不串线）", () => {
    const scopeA = caps.scopeKey("ws", "A");
    const scopeB = caps.scopeKey("ws", "B");

    it("A/B 各只看得到自己的前端工具", () => {
        caps.registerConnection(scopeA, [{ function: { name: "fa", description: "A", parameters: {} } }], async (n: string) => `A:${n}`);
        caps.registerConnection(scopeB, [{ function: { name: "fb", description: "B", parameters: {} } }], async (n: string) => `B:${n}`);
        const a = caps.listTools(scopeA).map((t: any) => t.function.name);
        const b = caps.listTools(scopeB).map((t: any) => t.function.name);
        expect(a).toContain("fa");
        expect(a).not.toContain("fb");
        expect(b).toContain("fb");
        expect(b).not.toContain("fa");
    });

    it("执行器按 scope 路由，跨 scope 被拒绝，注销后不残留", async () => {
        const ra = await caps.dispatch(scopeA, "fa", {});
        const rb = await caps.dispatch(scopeB, "fb", {});
        expect(ra.content).toBe("A:fa");
        expect(rb.content).toBe("B:fb");
        const cross = await caps.dispatch(scopeA, "fb", {});
        expect(cross.isError).toBe(true);
        caps.unregisterConnection(scopeA);
        expect(caps.listTools(scopeA).map((t: any) => t.function.name)).not.toContain("fa");
    });
});

describe("阶段 D · 统一超时与截断", () => {
    it("per-capability 超时生效", async () => {
        caps.registerGlobal([{ name: "__slow", description: "slow", parameters: {}, timeoutMs: 40, execute: async () => { await new Promise((r) => setTimeout(r, 300)); return "late"; } }]);
        const r = await caps.dispatch("local::t", "__slow", {});
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/超时/);
    });

    it("per-capability 截断生效并附标记", async () => {
        caps.registerGlobal([{ name: "__big", description: "big", parameters: {}, truncateChars: 20, execute: async () => "x".repeat(500) }]);
        const r = await caps.dispatch("local::t", "__big", {});
        expect(r.content).toContain("结果已截断");
        expect(r.content.length).toBeLessThan(100);
    });
});

describe("阶段 D · SKILL.md 渐进披露", () => {
    it("目录摘要只含 name: description，不含正文", () => {
        const cat = skillMd.catalogBlock();
        expect(cat).toContain("demo: 演示技能");
        expect(cat).not.toContain("做 A");
    });

    it("load_skill 按需加载正文，未命中列出可用技能", async () => {
        const ok = await caps.dispatch("local::t", "load_skill", { name: "demo" });
        expect(ok.content).toContain("# 步骤");
        expect(ok.content).toContain("做 A");
        const miss = await caps.dispatch("local::t", "load_skill", { name: "nope" });
        expect(miss.content).toContain("可用技能");
    });
});
