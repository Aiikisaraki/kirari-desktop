// @vitest-environment node
// 阶段 B：desktop agentProfile 配置读写回归。
// 钉死四个关键点：首次补写默认落盘、改配置立即生效、手写未知字段保留、坏配置显式报错。
import fs from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/agent-profile-${process.pid}`);
vi.mock("electron", () => ({ app: { getPath: () => tmpDir } }));

beforeAll(() => fs.mkdirSync(tmpDir, { recursive: true }));

import { getAgentProfile } from "./model-config";
import { DEFAULT_AGENT_PROFILE } from "kirari-agent";

const CONFIG_FILE = path.join(tmpDir, "config.json");
function read(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}
function seed(obj: Record<string, unknown>) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), "utf8");
}

beforeEach(() => seed({}));

describe("agentProfile 配置（desktop 与 core 同构）", () => {
    it("首次读取缺 agentProfile → 补写默认落盘", () => {
        const p = getAgentProfile();
        expect(p).toEqual(DEFAULT_AGENT_PROFILE);
        expect(read().agentProfile).toEqual(DEFAULT_AGENT_PROFILE);
    });

    it("改 maxRounds 立即生效（每次读文件）", () => {
        getAgentProfile(); // 先补写
        const cfg = read();
        cfg.agentProfile = { ...DEFAULT_AGENT_PROFILE, maxRounds: 9 };
        seed(cfg);
        expect(getAgentProfile().maxRounds).toBe(9);
        expect(getAgentProfile().maxTokens).toBe(DEFAULT_AGENT_PROFILE.maxTokens);
    });

    it("手写未知字段：补写默认时不丢", () => {
        seed({ someUnknownField: { keep: "me" }, model: "m" });
        getAgentProfile();
        const after = read();
        expect(after.someUnknownField).toEqual({ keep: "me" });
        expect(after.model).toBe("m");
        expect(after.agentProfile).toEqual(DEFAULT_AGENT_PROFILE);
    });

    it("坏配置（缺字段）显式报错，不回退默认值", () => {
        seed({ agentProfile: { maxRounds: 5 } }); // 缺其它字段
        expect(() => getAgentProfile()).toThrow(/必须是整数|缺失/);
    });

    it("坏配置（类型错）显式报错", () => {
        seed({ agentProfile: { ...DEFAULT_AGENT_PROFILE, maxRounds: "x" } });
        expect(() => getAgentProfile()).toThrow(/maxRounds 必须是整数/);
    });
});
