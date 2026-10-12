// @vitest-environment node
// electron/model-config.ts 多模型功能的隔离回归测试。
//
// 桌面端把核心版控制台那套多模型语义照搬了过来（models 列表 + activeModelId +
// 顶层字段即「当前生效」）。核心版在隔离环境里抓到过「删除当前套不回退」「全新
// 部署被前置检查挡住」这类 bug，这里把桌面端同样关键的分支钉死，防止以后改坏：
//  - 懒迁移：老用户只有顶层单套配置 → 自动导成「默认」套，行为零变化
//  - 第一套自动成为当前使用（覆盖顶层字段，聊天立刻可用）
//  - 「设为当前」= 覆盖顶层 + 记 activeModelId
//  - 编辑时钥匙留空 = 不改（不能把空串当新钥匙写进去）
//  - 删除当前套：activeId 置空但顶层字段不动（聊天还能用）
//  - 列表永远不泄明文钥匙
//  - 外部编辑把 models 写坏 → 懒自愈不崩
import fs from "fs";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ 临时目录放在项目内（.tmp-test/）：部分沙箱环境会杀掉写系统临时目录的进程。
// vi.hoisted 早于 import 初始化执行，这里只能用纯字符串拼路径（不用 path.join）。
const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/model-config-${process.pid}`);

vi.mock("electron", () => ({
    app: { getPath: () => tmpDir },
}));

beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
});

import {
    addModelProfile,
    activateModelProfile,
    deleteModelProfile,
    listModelProfiles,
    readModelConfigFile,
    updateModelProfile,
} from "./model-config";

const CONFIG_FILE = path.join(tmpDir, "config.json");

/** 直接覆写 config.json（模拟外部编辑器 / 旧版本写入的内容） */
function seedConfig(obj: Record<string, unknown>) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), "utf-8");
}

beforeEach(() => {
    seedConfig({});
});

describe("model-config 多模型", () => {
    it("懒迁移：老用户只有顶层单套配置 → 自动导成「默认」套并设为当前", () => {
        seedConfig({
            endpoint: "https://api.example.com/v1",
            model: "deepseek-chat",
            key: "sk-legacy-key-123",
        });
        const { items, activeId } = listModelProfiles();
        expect(items.length).toBe(1);
        expect(items[0].name).toBe("默认");
        expect(items[0].model).toBe("deepseek-chat");
        expect(activeId).toBe(1);
        // 迁移落盘：顶层字段原样保留，行为零变化
        const cfg = readModelConfigFile();
        expect(cfg.endpoint).toBe("https://api.example.com/v1");
        expect(cfg.key).toBe("sk-legacy-key-123");
        expect(cfg.models?.length).toBe(1);
    });

    it("第一套自动成为当前使用：覆盖顶层字段 + 记 activeModelId", () => {
        const id = addModelProfile({
            name: "便宜快档",
            endpoint: "https://api.cheap.example/v1",
            model: "deepseek-chat",
            key: "sk-cheap",
        });
        expect(id).toBe(1);
        const cfg = readModelConfigFile();
        expect(cfg.activeModelId).toBe(1);
        expect(cfg.endpoint).toBe("https://api.cheap.example/v1");
        expect(cfg.model).toBe("deepseek-chat");
        expect(cfg.key).toBe("sk-cheap");
    });

    it("添加第二套不动当前生效的顶层字段", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" });
        addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k-b" });
        const cfg = readModelConfigFile();
        // 顶层还是 A
        expect(cfg.endpoint).toBe("https://a/v1");
        expect(cfg.activeModelId).toBe(1);
        expect(cfg.models?.length).toBe(2);
    });

    it("「设为当前」覆盖顶层字段并记 activeModelId", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" });
        addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k-b" });
        const next = activateModelProfile(2);
        expect(next).not.toBeNull();
        expect(next!.endpoint).toBe("https://b/v1");
        expect(next!.key).toBe("k-b");
        const cfg = readModelConfigFile();
        expect(cfg.activeModelId).toBe(2);
        expect(cfg.endpoint).toBe("https://b/v1");
    });

    it("编辑时钥匙留空/不传 = 保持原值；传了才更新", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "sk-original" });
        // 只改名字，钥匙不动
        expect(updateModelProfile(1, { name: "改名了" })).not.toBeNull();
        let cfg = readModelConfigFile();
        expect(cfg.models![0].name).toBe("改名了");
        expect(cfg.models![0].key).toBe("sk-original");
        // 显式空串也不算改
        updateModelProfile(1, { key: "" });
        cfg = readModelConfigFile();
        expect(cfg.models![0].key).toBe("sk-original");
        // 传新钥匙才覆盖
        updateModelProfile(1, { key: "sk-new" });
        cfg = readModelConfigFile();
        expect(cfg.models![0].key).toBe("sk-new");
    });

    it("编辑「当前使用」那一套：顶层生效字段跟着同步（聊天立刻用新值）", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" });
        addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k-b" });
        activateModelProfile(2);
        // 编辑的是当前套（B）：顶层三件套必须一起变
        updateModelProfile(2, { endpoint: "https://b2/v1", key: "k-b2" });
        const cfg = readModelConfigFile();
        expect(cfg.activeModelId).toBe(2);
        expect(cfg.endpoint).toBe("https://b2/v1");
        expect(cfg.model).toBe("m-b");
        expect(cfg.key).toBe("k-b2");
        // 编辑的是非当前套（A）：顶层保持 B 不受影响
        updateModelProfile(1, { endpoint: "https://a2/v1" });
        const cfg2 = readModelConfigFile();
        expect(cfg2.endpoint).toBe("https://b2/v1");
        expect(cfg2.models![0].endpoint).toBe("https://a2/v1");
    });

    it("删除非当前套：activeId 和顶层字段都不动", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" });
        addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k-b" });
        expect(deleteModelProfile(2)).toBe(true);
        const cfg = readModelConfigFile();
        expect(cfg.activeModelId).toBe(1);
        expect(cfg.endpoint).toBe("https://a/v1");
        expect(cfg.models?.length).toBe(1);
    });

    it("删除当前套：activeId 置空但顶层字段保持（聊天还能用）", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" });
        addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k-b" });
        activateModelProfile(2);
        expect(deleteModelProfile(2)).toBe(true);
        const cfg = readModelConfigFile();
        expect(cfg.activeModelId).toBeUndefined();
        // 顶层还是 B 的值：当前会话不受删除影响
        expect(cfg.endpoint).toBe("https://b/v1");
        expect(cfg.key).toBe("k-b");
        // 删不存在的 id 返回 false
        expect(deleteModelProfile(2)).toBe(false);
    });

    it("id 取当前最大 +1：删掉最大 id 后新增会复用该号（行为如实钉住）", () => {
        const a = addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k" });
        const b = addModelProfile({ name: "B", endpoint: "https://b/v1", model: "m-b", key: "k" });
        deleteModelProfile(b);
        const c = addModelProfile({ name: "C", endpoint: "https://c/v1", model: "m-c", key: "k" });
        // 删的是最大 id：最大变回 a，所以 c 复用了 b 的号。无害（activeModelId 已同步清理），
        // 但如果有天要改成严格单调递增，这里就是显式的行为变更点。
        expect(a).toBe(1);
        expect(b).toBe(2);
        expect(c).toBe(2);
    });

    it("列表只回掩码钥匙，绝不泄明文", () => {
        addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "sk-very-secret-key-9876" });
        const { items } = listModelProfiles();
        expect(items[0].hasKey).toBe(true);
        expect(items[0].keyMasked).toBe("sk-******9876");
        expect(JSON.stringify(items)).not.toContain("sk-very-secret-key-9876");
    });

    it("外部编辑把 models 写坏 → 懒自愈当没有，不崩", () => {
        // 注意 seed 里不能带顶层 endpoint/model/key，否则会走懒迁移分支导出「默认」套
        seedConfig({ models: "坏了", activeModelId: 1 });
        const { items, activeId } = listModelProfiles();
        expect(items.length).toBe(0);
        // activeId 指向的列表都没了，读出来如实是 1（不额外发明状态）
        expect(activeId).toBe(1);
        // 照常能加新套：坏掉的 models 会被安全列表替换，且这套自动成为当前使用
        expect(() => addModelProfile({ name: "A", endpoint: "https://a/v1", model: "m-a", key: "k-a" })).not.toThrow();
        const cfg = readModelConfigFile();
        expect(Array.isArray(cfg.models)).toBe(true);
        expect(cfg.activeModelId).toBe(1);
        expect(cfg.endpoint).toBe("https://a/v1");
    });
});
