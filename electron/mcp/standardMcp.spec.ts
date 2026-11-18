// @vitest-environment node
// electron/mcp/standardMcp.ts 的隔离回归测试。
//
// 这层是「跨 agent 无缝迁移」的关键：文件里必须是标准 mcp.json（Claude Code /
// codebuddy / WorkBuddy / Cursor 同一个格式），内存里才是 Kirari 的带 id 数组。
// 一旦转换出错，用户在大号 agent 里配好的 MCP 拷过来就用不了；反过来我们写回
// 时丢了人家的私有字段，等于把对方配置吃掉了。所以两边方向都要钉住。
import fs from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/standard-mcp-${process.pid}`);

vi.mock("electron", () => ({
    app: { getPath: () => tmpDir },
}));

beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
});

import type { McpServerConfig } from "../frontend-tools";
import {
    entryToInternal,
    fromStandard,
    internalToEntry,
    readStandardFile,
    toStandard,
    writeStandardFile,
} from "./standardMcp";

const FILE = path.join(tmpDir, "mcp.json");

beforeEach(() => {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

describe("standardMcp 标准格式 ↔ 内部结构", () => {
    it("stdio 条目：command/args/env/cwd 都转进内部", () => {
        const s = entryToInternal("fs", {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { TOKEN: "abc" },
            cwd: "/work",
        });
        expect(s).toMatchObject({
            id: "fs",
            name: "fs",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { TOKEN: "abc" },
            cwd: "/work",
            enabled: true,
        });
    });

    it("http 条目：url/headers 转进内部", () => {
        const s = entryToInternal("remote", {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer x" },
        });
        expect(s).toMatchObject({
            id: "remote",
            transport: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer x" },
            enabled: true,
        });
    });

    it("url 与 command 同时存在时以 url 为准（远程优先，与各家一致）", () => {
        const s = entryToInternal("both", { url: "https://x/mcp", command: "npx" });
        expect(s!.transport).toBe("http");
        expect(s!.url).toBe("https://x/mcp");
        expect(s!.command).toBeUndefined();
    });

    it("disabled:true → enabled:false（WorkBuddy 写法）", () => {
        expect(entryToInternal("a", { command: "x", disabled: true })!.enabled).toBe(false);
        expect(entryToInternal("b", { command: "x", enabled: false })!.enabled).toBe(false);
        expect(entryToInternal("c", { command: "x" })!.enabled).toBe(true);
    });

    it("缺 command 和 url 的条目返回 null（调方会跳过并计数）", () => {
        expect(entryToInternal("bad", {})).toBeNull();
        expect(entryToInternal("bad", { command: "  " })).toBeNull();
        expect(entryToInternal("", { command: "x" })).toBeNull();
    });

    it("内部 → 标准：id 不进值里，enabled:false 变 disabled:true", () => {
        const e = internalToEntry({
            id: "fs",
            name: "fs",
            transport: "stdio",
            command: "npx",
            args: ["-y", "pkg"],
            enabled: false,
        } as McpServerConfig);
        expect(e).toEqual({ command: "npx", args: ["-y", "pkg"], disabled: true });
    });

    it("半配置（没 url 也没 command）转标准返回 null", () => {
        expect(internalToEntry({ id: "x", name: "x", transport: "stdio", enabled: true } as McpServerConfig)).toBeNull();
    });

    it("往返不丢用户私有字段（两个方向都保留）", () => {
        const raw = {
            mcpServers: {
                fs: { command: "npx", args: ["-y", "pkg"], timeout: 60, retry: { max: 3 } },
            },
        };
        const { servers } = fromStandard(raw);
        // 内部带着私有字段
        expect((servers[0] as Record<string, unknown>).timeout).toBe(60);
        expect((servers[0] as Record<string, unknown>).retry).toEqual({ max: 3 });
        // 写回标准格式时原样带出去
        const back = toStandard(servers);
        expect(back.mcpServers.fs.timeout).toBe(60);
        expect(back.mcpServers.fs.retry).toEqual({ max: 3 });
    });

    it("名字冲突时加序号后缀，不静默丢 server", () => {
        const out = toStandard([
            { id: "dup", name: "a", transport: "stdio", command: "x", enabled: true },
            { id: "dup", name: "b", transport: "stdio", command: "y", enabled: true },
        ] as McpServerConfig[]);
        expect(Object.keys(out.mcpServers).sort()).toEqual(["dup", "dup-2"]);
    });

    it("文件不存在 → 空清单且 missing=true（首次启动正常）", () => {
        const r = readStandardFile(FILE);
        expect(r.servers).toEqual([]);
        expect(r.missing).toBe(true);
    });

    it("文件坏掉 → 抛错（绝不静默当空，否则保存会覆盖配置）", () => {
        fs.writeFileSync(FILE, "{ 这不是 JSON", "utf-8");
        expect(() => readStandardFile(FILE)).toThrow(/不是合法 JSON/);
    });

    it("写入保留文件里的其他顶级键", () => {
        fs.writeFileSync(FILE, JSON.stringify({ mcpServers: {}, $schema: "https://x/schema.json" }), "utf-8");
        writeStandardFile(FILE, [
            { id: "fs", name: "fs", transport: "stdio", command: "npx", enabled: true },
        ] as McpServerConfig[]);
        const written = JSON.parse(fs.readFileSync(FILE, "utf-8"));
        expect(written.$schema).toBe("https://x/schema.json");
        expect(written.mcpServers.fs.command).toBe("npx");
    });

    it("写出的文件是 { mcpServers: {...} } 形状（与别家 agent 同格式）", () => {
        writeStandardFile(FILE, [
            { id: "r", name: "r", transport: "http", url: "https://x/mcp", enabled: true },
        ] as McpServerConfig[]);
        const written = JSON.parse(fs.readFileSync(FILE, "utf-8"));
        expect(Object.keys(written)).toContain("mcpServers");
        expect(Array.isArray(written.mcpServers)).toBe(false);
        expect(written.mcpServers.r.url).toBe("https://x/mcp");
    });
});
