// @vitest-environment node
// 阶段 5：dispatch 与「执行位置路由」的集成。
//
// toolRouting.spec.ts 测的是判定规则本身；这里测的是**接进 dispatch 之后**
// 整条链路的行为，尤其是那些"静默出错"的退化路径：
//   · 没开组网的普通安装不能被路由拖坏（最好一点影响都没有）
//   · 点名了不存在的设备，即使本地执行成功，也必须把"没找到那台设备"带回去
//   · 未知工具仍然明确报未知，不能被路由吞成空结果

import { afterAll, describe, expect, it } from "vitest";

import * as caps from "./registry";
import * as toolRouting from "../services/toolRouting";

afterAll(() => {
    toolRouting.setToolRoutingNet(null);
});

describe("阶段 5 · dispatch 集成（未开组网：行为必须与从前一致）", () => {
    it("普通内置工具照旧在本地执行", async () => {
        toolRouting.setToolRoutingNet(null);
        const r = await caps.dispatch("local::route-test", "get_current_time", {});
        expect(r.isError).toBe(false);
        expect(r.content.length).toBeGreaterThan(0);
    });

    it("未知工具仍然明确报未知（不被路由吞掉）", async () => {
        toolRouting.setToolRoutingNet(null);
        const r = await caps.dispatch("local::route-test", "__no_such_tool__", {});
        expect(r.isError).toBe(true);
        expect(r.content).toContain("__no_such_tool__");
    });
});

describe("阶段 5 · dispatch 集成（点名设备失败必须让模型知道）", () => {
    it("★ 点名不存在的设备 → 本地执行成功，但结果里带「没找到那台设备」", async () => {
        toolRouting.setToolRoutingNet({ members: () => [] });
        const r = await caps.dispatch(
            "local::route-test",
            "@device:阳台的平板 get_current_time",
            {},
        );
        // 本地工具仍然跑成功（至少能给出答案）
        expect(r.isError).toBe(false);
        // 但模型必须知道点错了设备，否则它以为自己查的是阳台平板
        expect(r.content).toContain("没找到设备");
        expect(r.content).toContain("阳台的平板");
    });

    it("点名不存在的设备 + 工具也不存在 → 两条信息都在", async () => {
        toolRouting.setToolRoutingNet({ members: () => [] });
        const r = await caps.dispatch(
            "local::route-test",
            "@device:阳台的平板 __no_such_tool__",
            {},
        );
        expect(r.isError).toBe(true);
        expect(r.content).toContain("没找到设备");
        expect(r.content).toContain("__no_such_tool__");
    });

    it("点名成功 + 远程执行成功 → 结果来自那台设备", async () => {
        const deviceId = "dddddddd-0000-0000-0000-000000000000";
        const calls: any[] = [];
        toolRouting.setToolRoutingNet({
            members: () => [{ deviceId, name: "书房的电脑", online: true }],
            callToolOnDevice: async (id, name, args) => {
                calls.push({ id, name, args });
                return { ok: true, result: "远程拿到的内容", deviceId: id };
            },
        });
        const r = await caps.dispatch("net::remote", "@device:书房 __fake_tool__", { a: 1 });
        expect(r.isError).toBe(false);
        expect(r.content).toContain("远程拿到的内容");
        // 转发的是剥掉前缀后的真实工具名，且目标就是那台设备
        expect(calls[0]).toEqual({ id: deviceId, name: "__fake_tool__", args: { a: 1 } });
    });

    it("远程执行失败 → isError=true 且原因可见", async () => {
        const deviceId = "eeeeeeee-0000-0000-0000-000000000000";
        toolRouting.setToolRoutingNet({
            members: () => [{ deviceId, name: "书房的电脑", online: false }],
            callToolOnDevice: async () => ({ ok: false, error: "那台设备掉线了", deviceId }),
        });
        const r = await caps.dispatch("net::remote", "@device:书房 __fake_tool__", {});
        expect(r.isError).toBe(true);
        expect(r.content).toContain("那台设备掉线了");
    });
});

// 模型更常见的写法不是 @device:，而是把设备塞进参数（{"device":"书房"}）。
// 这条链路多一步：路由用的键必须摘掉，否则 MCP 工具按 schema 校验会直接拒绝。
describe("阶段 5 · dispatch 集成（自然语言点名的入参清理）", () => {
    it("★ 参数里点名 → 走远程，且转发给叶子的参数里没有路由专用的 device 键", async () => {
        const deviceId = "ffffffff-0000-0000-0000-000000000000";
        const calls: any[] = [];
        toolRouting.setToolRoutingNet({
            members: () => [{ deviceId, name: "书房的电脑", online: true }],
            callToolOnDevice: async (id, name, args) => {
                calls.push({ id, name, args });
                return { ok: true, result: "远程结果", deviceId: id };
            },
        });
        const r = await caps.dispatch("net::remote", "read_file", { device: "书房", path: "/a.txt" });
        expect(r.isError).toBe(false);
        expect(calls.length).toBe(1);
        expect(calls[0].id).toBe(deviceId);
        // 路由指令不能混进工具入参
        expect("device" in calls[0].args).toBe(false);
        // 业务参数原样保留
        expect(calls[0].args.path).toBe("/a.txt");
    });

    it("没改路由时不动参数（别误删工具本来就有的 device 参数）", async () => {
        toolRouting.setToolRoutingNet({ members: () => [] });
        const r = await caps.dispatch("local::route-test", "get_current_time", { device: "随便" });
        expect(r.isError).toBe(false);
    });
});
