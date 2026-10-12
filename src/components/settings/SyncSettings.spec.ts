// 组网设置页的交互验证。
//
// 这个页面之前**只能靠人手点**：主机/叶子/off 三种角色是同一套模板按 role 分支，
// 白名单勾选框只在主机侧渲染，关掉组网要整页灰显 —— 全是条件渲染，眼看过容易漏。
// 这里把三条分支与两个交互（勾选白名单、撤销连接码）钉死。
//
// ⚠️ SyncSettings.vue 在**模块顶层**取 `window.netApi`，所以必须先 stub 全局、
// 再动态 import 组件，每个用例都要 resetModules 拿一份新的。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

type Snapshot = {
    role: "off" | "host" | "leaf";
    deviceId: string;
    deviceName: string;
    address: string;
    port: number;
    hostName?: string;
    pairings: { id: string; name: string; expiresAt: number; remaining: string; usedBy: string | null; revoked: boolean }[];
    members: { deviceId: string; name: string; online: boolean; since: number }[];
    leafStatus?: string;
    pendingBackfill?: number;
    syncWhitelist?: string[];
};

function baseSnapshot(patch: Partial<Snapshot> = {}): Snapshot {
    return {
        role: "off",
        deviceId: "dev-1",
        deviceName: "我的电脑",
        address: "192.168.57.10",
        port: 19760,
        pairings: [],
        members: [],
        ...patch,
    };
}

function makeNetApi(snapshot: Snapshot) {
    return {
        getState: vi.fn(async () => snapshot),
        addresses: vi.fn(async () => ["192.168.57.10"]),
        enabled: vi.fn(async () => ({ enabled: true })),
        startHost: vi.fn(async () => ({ ok: true, code: "kirari://join?d=xxx", snapshot })),
        issuePairing: vi.fn(async () => ({ ok: true, code: "kirari://join?d=xxx", snapshot })),
        join: vi.fn(async () => ({ ok: true, snapshot })),
        resume: vi.fn(async () => ({ ok: true, snapshot })),
        stop: vi.fn(async () => ({ ok: true, snapshot })),
        revokePairing: vi.fn(async () => ({ ok: true, snapshot })),
        prunePairings: vi.fn(async () => ({ ok: true, snapshot })),
        removeDevice: vi.fn(async () => ({ ok: true, snapshot })),
        leaveHost: vi.fn(async () => ({ ok: true, snapshot })),
        renameSelf: vi.fn(async () => ({ ok: true, snapshot })),
        flushBackfill: vi.fn(async () => ({ ok: true, snapshot })),
        syncWhitelist: vi.fn(async () => ({ whitelist: snapshot.syncWhitelist ?? [] })),
        setSyncWhitelist: vi.fn(async (fields: string[]) => ({
            ok: true,
            whitelist: fields,
            snapshot: { ...snapshot, syncWhitelist: fields },
        })),
        codeQr: vi.fn(async () => ({ ok: true, dataUrl: "data:image/png;base64,xx" })),
        onState: vi.fn(),
        onNotice: vi.fn(),
    };
}

async function mountPage(snapshot: Snapshot) {
    const api = makeNetApi(snapshot);
    vi.stubGlobal("netApi", api);
    // 组件在模块顶层读 window.netApi，必须每次重新 import 才能拿到新的 stub。
    vi.resetModules();
    const mod = await import("./SyncSettings.vue");
    const wrapper = mount(mod.default);
    await flushPromises();
    return { wrapper, api };
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

describe("组网设置页 · 角色分支", () => {
    it("主机侧渲染白名单勾选框（5 项）", async () => {
        const { wrapper } = await mountPage(baseSnapshot({ role: "host", syncWhitelist: ["model"] }));
        expect(wrapper.text()).toContain("统一哪些配置");
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(5);
    });

    it("叶子侧看不到白名单（白名单是主机单方面的东西）", async () => {
        const { wrapper } = await mountPage(baseSnapshot({ role: "leaf", hostName: "主机", leafStatus: "connected" }));
        expect(wrapper.text()).not.toContain("统一哪些配置");
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
    });

    it("没开组网时整页灰显，而不是隐藏", async () => {
        const { wrapper } = await mountPage(baseSnapshot({ role: "off" }));
        expect(wrapper.find(".is-dimmed").exists()).toBe(true);
    });
});

describe("组网设置页 · 同步白名单交互", () => {
    it("勾选状态反映主机下发的白名单", async () => {
        const { wrapper } = await mountPage(baseSnapshot({ role: "host", syncWhitelist: ["model", "searchProvider"] }));
        const boxes = wrapper.findAll('input[type="checkbox"]');
        const checked = boxes.map((b) => (b.element as HTMLInputElement).checked);
        // SYNC_ITEMS 顺序：model / endpoint / basePersona / searchEndpoint / searchProvider
        expect(checked).toEqual([true, false, false, false, true]);
    });

    it("勾上一项 → 带着已有项一起提交（不能只发新增那一项）", async () => {
        const { wrapper, api } = await mountPage(baseSnapshot({ role: "host", syncWhitelist: ["model"] }));
        const boxes = wrapper.findAll('input[type="checkbox"]');
        await boxes[1].setValue(true); // endpoint
        expect(api.setSyncWhitelist).toHaveBeenCalledTimes(1);
        expect(api.setSyncWhitelist).toHaveBeenCalledWith(["model", "endpoint"]);
    });

    it("取消勾选 → 从白名单里移除", async () => {
        const { wrapper, api } = await mountPage(baseSnapshot({ role: "host", syncWhitelist: ["model", "endpoint"] }));
        const boxes = wrapper.findAll('input[type="checkbox"]');
        await boxes[0].setValue(false); // model
        expect(api.setSyncWhitelist).toHaveBeenCalledWith(["endpoint"]);
    });

    it("白名单选项里没有密钥类条目（页面下方的说明文字不算）", async () => {
        const { wrapper } = await mountPage(baseSnapshot({ role: "host", syncWhitelist: ["model"] }));
        // 只取带勾选框的行 —— 页面底部还有一句关于「钥匙」的说明，不能拿来断言。
        const rows = wrapper
            .findAll(".settings-row")
            .filter((r) => r.find('input[type="checkbox"]').exists());
        expect(rows).toHaveLength(5);
        const labels = rows.map((r) => r.text()).join("|");
        for (const secret of ["密钥", "Key", "令牌", "口令"]) {
            expect(labels).not.toContain(secret);
        }
    });
});

describe("组网设置页 · 连接码撤销", () => {
    const withPairings: Partial<Snapshot> = {
        role: "host",
        syncWhitelist: ["model"],
        pairings: [
            { id: "p1", name: "客厅电脑", expiresAt: Date.now() + 864e5, remaining: "还剩 7 天", usedBy: null, revoked: false },
            { id: "p2", name: "笔记本", expiresAt: Date.now() + 864e5, remaining: "还剩 7 天", usedBy: "dev-9", revoked: false },
            { id: "p3", name: "已作废", expiresAt: Date.now() + 864e5, remaining: "还剩 7 天", usedBy: null, revoked: true },
        ],
    };

    it("列出还没作废的连接码，已撤销的不显示", async () => {
        const { wrapper } = await mountPage(baseSnapshot(withPairings));
        expect(wrapper.text()).toContain("客厅电脑");
        expect(wrapper.text()).toContain("笔记本");
        expect(wrapper.text()).not.toContain("已作废");
    });

    it("点撤销 → 带着对应的 id 调用 revokePairing", async () => {
        const { wrapper, api } = await mountPage(baseSnapshot(withPairings));
        const buttons = wrapper.findAll("button").filter((b) => b.text() === "撤销");
        expect(buttons).toHaveLength(2); // 两条未撤销的
        await buttons[0].trigger("click");
        expect(api.revokePairing).toHaveBeenCalledWith("p1");
    });
});
