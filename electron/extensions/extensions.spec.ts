// electron/extensions/extensions.spec.ts
//
// 扩展接口层的契约测试。重点守三件事：
//   1. manifest 是不可信输入 —— 越权路径必须被拒；
//   2. 没装扩展包时，所有消费点必须安全地拿到 null（这是"不影响主程序"的硬保证）；
//   3. 通用动词的转发形态稳定（service.call / capability.call 的参数形状），
//      否则第三方包会跟着漂。

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseManifest, discoverExtensions, ExtensionManifestError } from "./manifest";
import { ServiceRegistry } from "./services";
import { buildVoiceOutgoing } from "./voiceOutgoing";
import { setExtensionHost, getService } from "./host";

function baseManifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "com.example.demo",
        name: "示例扩展",
        version: "1.0.0",
        apiVersion: 1,
        engine: { runtime: "sidecar", protocol: "jsonrpc-stdio@1", command: "bin/server.cjs" },
        contributions: [{ type: "service", id: "speech.tts", title: "语音合成" }],
        ...patch,
    };
}

describe("扩展包 manifest 校验", () => {
    it("接受合法的通用清单", () => {
        const m = parseManifest(baseManifest());
        expect(m.id).toBe("com.example.demo");
        expect(m.contributions).toHaveLength(1);
        expect(m.contributions[0]).toMatchObject({ type: "service", id: "speech.tts" });
    });

    it("拒绝绝对路径与 .. 逃逸（否则等于允许 spawn 任意可执行文件）", () => {
        expect(() =>
            parseManifest(
                baseManifest({
                    engine: { runtime: "sidecar", protocol: "jsonrpc-stdio@1", command: "/usr/bin/node" },
                }),
            ),
        ).toThrow(ExtensionManifestError);
        expect(() =>
            parseManifest(
                baseManifest({
                    engine: { runtime: "sidecar", protocol: "jsonrpc-stdio@1", command: "../../evil.sh" },
                }),
            ),
        ).toThrow(ExtensionManifestError);
    });

    it("拒绝高于宿主 API 版本的包（明确报错而不是半死不活）", () => {
        expect(() => parseManifest(baseManifest({ apiVersion: 99 }))).toThrow(/只支持到 v1/);
    });

    it("不认识的贡献类型忽略，不因此拒绝整包", () => {
        const m = parseManifest(
            baseManifest({
                contributions: [
                    { type: "service", id: "speech.tts", title: "语音" },
                    { type: "future-thing", id: "x.y", title: "未来能力" },
                ],
            }),
        );
        expect(m.contributions).toHaveLength(1);
    });

    it("过滤掉未知权限与危险的 engine.env 键", () => {
        const m = parseManifest(
            baseManifest({
                permissions: ["network", "root-everything"],
                engine: {
                    runtime: "sidecar",
                    protocol: "jsonrpc-stdio@1",
                    command: "bin/server.cjs",
                    env: { MY_MODEL_DIR: "/models", PATH: "/evil", NODE_OPTIONS: "--require x" },
                },
            }),
        );
        expect(m.permissions).toEqual(["network"]);
        expect(m.engine.env).toEqual({ MY_MODEL_DIR: "/models" });
    });
});

describe("扩展包目录扫描", () => {
    it("跳过非扩展目录，并保留坏包的失败原因", async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kirari-ext-"));
        try {
            // 正常包
            const good = path.join(root, "good");
            await fs.promises.mkdir(good);
            await fs.promises.writeFile(
                path.join(good, "manifest.json"),
                JSON.stringify(baseManifest()),
                "utf-8",
            );
            // 坏包：命令越权
            const bad = path.join(root, "bad");
            await fs.promises.mkdir(bad);
            await fs.promises.writeFile(
                path.join(bad, "manifest.json"),
                JSON.stringify(
                    baseManifest({
                        id: "com.example.bad",
                        engine: { runtime: "sidecar", protocol: "jsonrpc-stdio@1", command: "../x" },
                    }),
                ),
                "utf-8",
            );
            // 不是扩展包的目录
            await fs.promises.mkdir(path.join(root, "not-a-pack"));

            const found = await discoverExtensions(root);
            expect(found).toHaveLength(2);
            const goodEntry = found.find((f) => f.manifest.id === "com.example.demo");
            const badEntry = found.find((f) => f.manifest.id === "bad");
            expect(goodEntry?.error).toBeUndefined();
            expect(badEntry?.error).toMatch(/相对路径/);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    it("目录不存在时返回空数组而不是抛错", async () => {
        await expect(discoverExtensions(path.join(os.tmpdir(), "kirari-ext-not-exist-xyz"))).resolves.toEqual([]);
    });
});

describe("没有扩展包时主程序行为不变", () => {
    it("服务注册表为空时 get() 返回 null", () => {
        const registry = new ServiceRegistry();
        expect(registry.has("speech.tts")).toBe(false);
        expect(registry.get("speech.tts")).toBeNull();
        expect(registry.list()).toEqual([]);
    });

    it("宿主未启动时 getService() 返回 null", () => {
        setExtensionHost(null);
        expect(getService("speech.tts")).toBeNull();
    });

    it("出站语音策略在没有 TTS 服务时直接返回 null（不抛错、不等待）", async () => {
        setExtensionHost(null);
        await expect(
            buildVoiceOutgoing({ text: "你好呀", isGroup: false, isOwner: true }),
        ).resolves.toBeNull();
    });
});

describe("服务转发形态", () => {
    it("方法调用被翻译成 service.call { serviceId, method, params: { args } }", async () => {
        const callService = vi.fn(async () => ({ voices: [] }));
        const registry = new ServiceRegistry();
        registry.register(
            { id: "speech.tts", title: "语音合成", packId: "com.example.demo" },
            { callService } as never,
        );
        const svc = registry.get<{ listVoices(): Promise<unknown> }>("speech.tts");
        expect(svc).not.toBeNull();
        await svc!.listVoices();
        expect(callService).toHaveBeenCalledWith("speech.tts", "listVoices", { args: [] });
    });

    it("服务对象对 then/constructor 之类属性返回 undefined（避免被当成 thenable）", () => {
        const registry = new ServiceRegistry();
        registry.register(
            { id: "speech.tts", title: "语音合成", packId: "p" },
            { callService: vi.fn() } as never,
        );
        const svc = registry.get<Record<string, unknown>>("speech.tts")!;
        expect(svc.then).toBeUndefined();
        expect(svc.constructor).toBeUndefined();
    });
});
