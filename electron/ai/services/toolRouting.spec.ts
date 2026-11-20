// @vitest-environment node
// 阶段 5：工具执行位置的路由判定。
//
// 用户的规则（2026-11-20）：
//   · 主机本机 / QQ / 网页端聊天 → 默认操作**主机自己的** MCP 与 skill
//   · 模型**点明**某台叶子（@device:xxx / 别名）→ 操作**那台叶子**的
//   · 请求本身**来自某台叶子** → 默认操作**那台叶子自己**的
//
// 这一层的价值在于「不许静默换机器」：点名了却找不到设备时必须显式说明，
// 否则用户会以为查的是书房电脑，其实查的是主机 —— 这是最难排查的一类错。

import { afterEach, describe, expect, it } from "vitest";

import * as toolRouting from "./toolRouting";

const DEVICE_A = {
    deviceId: "aaaaaaaa-1111-2222-3333-444444444444",
    name: "书房的电脑",
    online: true,
};
const DEVICE_B = {
    deviceId: "bbbbbbbb-1111-2222-3333-444444444444",
    name: "卧室笔记本",
    online: true,
};

/** 装上假的组网访问器：模拟主机视角。 */
function mockNet(devices = [DEVICE_A, DEVICE_B], callResult?: any) {
    const calls: any[] = [];
    toolRouting.setToolRoutingNet({
        members: () => devices,
        callToolOnDevice: async (deviceId, name, args, opts) => {
            calls.push({ deviceId, name, args, opts });
            return callResult ?? { ok: true, result: `ran on ${deviceId}`, deviceId };
        },
    });
    return calls;
}

afterEach(() => {
    toolRouting.setToolRoutingNet(null);
});

describe("阶段 5 · 结构化设备点名解析", () => {
    it("识别 @device:<名> <工具> 前缀", () => {
        expect(toolRouting.parseDevicePrefix("@device:书房 mcp__fs__read")).toEqual({
            deviceHint: "书房",
            name: "mcp__fs__read",
        });
        // 冒号分隔也接受
        expect(toolRouting.parseDevicePrefix("@device:书房:mcp__fs__read")).toEqual({
            deviceHint: "书房",
            name: "mcp__fs__read",
        });
    });

    it("没有前缀返回 null（普通工具名不受影响）", () => {
        expect(toolRouting.parseDevicePrefix("mcp__fs__read")).toBeNull();
        expect(toolRouting.parseDevicePrefix("skill__demo__run")).toBeNull();
    });

    it("按设备名、deviceId 前缀、去尾缀别名都能解析到同一台", () => {
        mockNet();
        expect(toolRouting.resolveDevice("书房的电脑")?.deviceId).toBe(DEVICE_A.deviceId);
        expect(toolRouting.resolveDevice("书房")?.deviceId).toBe(DEVICE_A.deviceId);
        expect(toolRouting.resolveDevice("aaaaaaaa")?.deviceId).toBe(DEVICE_A.deviceId);
        // 大小写不敏感
        const lower = { deviceId: "cccc", name: "Living Room PC", online: true };
        mockNet([lower]);
        expect(toolRouting.resolveDevice("living room pc")?.deviceId).toBe("cccc");
    });

    it("找不到设备返回 null（不猜、不落到别的机器）", () => {
        mockNet();
        expect(toolRouting.resolveDevice("阳台的平板")).toBeNull();
    });
});

describe("阶段 5 · 默认执行位置（按来源）", () => {
    it("主机本机 / QQ / 网页端：没有来源设备 → 主机自己执行", () => {
        mockNet();
        const d = toolRouting.decide({}, "mcp__fs__read");
        expect(d.target).toBe("local");
        expect(d.source).toBe("host-default");
        expect(d.name).toBe("mcp__fs__read");
    });

    it("请求来自某台叶子 → 默认在那台叶子自己身上执行", () => {
        mockNet();
        const d = toolRouting.decide({ sourceDeviceId: DEVICE_A.deviceId }, "mcp__fs__read");
        expect(d.target).toBe("remote");
        expect(d.deviceId).toBe(DEVICE_A.deviceId);
        expect(d.source).toBe("from-leaf");
    });

    it("模型点名了另一台设备 → 覆盖来源，去那台执行", () => {
        mockNet();
        const d = toolRouting.decide(
            { sourceDeviceId: DEVICE_A.deviceId },
            `@device:卧室笔记本 mcp__fs__read`,
        );
        expect(d.target).toBe("remote");
        expect(d.deviceId).toBe(DEVICE_B.deviceId);
        expect(d.source).toBe("explicit");
        // 工具名里不该残留前缀
        expect(d.name).toBe("mcp__fs__read");
    });

    it("点名了但没这台设备 → 说明清楚，并按来源回落（不静默换机器）", () => {
        mockNet();
        const d = toolRouting.decide({ sourceDeviceId: DEVICE_A.deviceId }, "@device:阳台平板 mcp__fs__read");
        expect(d.explicitMiss).toBe(true);
        expect(d.note).toContain("阳台平板");
        // 回落规则 2：仍然在请求方自己那台执行
        expect(d.deviceId).toBe(DEVICE_A.deviceId);
        expect(d.target).toBe("remote");
        // 前缀必须剥掉，否则本地/远端都找不到这个工具
        expect(d.name).toBe("mcp__fs__read");
    });
});

describe("阶段 5 · 远程执行与兜底", () => {
    it("远程成功：结果原样返回，isError=false", async () => {
        mockNet([DEVICE_A], { ok: true, result: "文件内容", deviceId: DEVICE_A.deviceId });
        const out = await toolRouting.runRemote(
            {},
            { target: "remote", name: "mcp__fs__read", source: "explicit", deviceId: DEVICE_A.deviceId },
            { path: "/tmp/a" },
        );
        expect(out).toEqual({ content: "文件内容", isError: false });
    });

    it("远程失败：返回 error 前缀的内容，isError=true", async () => {
        mockNet([DEVICE_A], { ok: false, error: "目标设备不在线", deviceId: DEVICE_A.deviceId });
        const out = await toolRouting.runRemote(
            {},
            { target: "remote", name: "x", source: "explicit", deviceId: DEVICE_A.deviceId },
            {},
        );
        expect(out?.isError).toBe(true);
        expect(out?.content).toContain("目标设备不在线");
    });

    it("没有组网通道（未开组网）→ 返回 null，让调用方回退本地执行", async () => {
        toolRouting.setToolRoutingNet({ members: () => [] });
        const out = await toolRouting.runRemote(
            {},
            { target: "remote", name: "x", source: "explicit", deviceId: DEVICE_A.deviceId },
            {},
        );
        expect(out).toBeNull();
    });
});

describe("阶段 5 · 设备列表（主机能列出所有叶子）", () => {    it("listDevices 返回主机侧全部成员", () => {
        mockNet();
        expect(toolRouting.listDevices().map((d) => d.name)).toEqual(["书房的电脑", "卧室笔记本"]);
    });

    it("没装组网访问器时返回空数组而不是抛错", () => {
        toolRouting.setToolRoutingNet(null);
        expect(toolRouting.listDevices()).toEqual([]);
        expect(toolRouting.decide({}, "x").target).toBe("local");
    });
});
