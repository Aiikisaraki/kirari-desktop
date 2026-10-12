// 模型配置页的回归测试。
//
// 主要盯这几件事：
//  1. 这个页面曾经「点进去就卡死」—— onMounted 里引用了已被删除的 `mode` 变量，
//     抛 ReferenceError 导致整个组件渲染失败。这里保证它能正常挂载。
//  2. 主进程给回来的 searchProvider 是 string，认不出来的值要回退到 uapis，
//     否则单选框一个都不选中，界面上看着像没配置。
//  3. 多模型：列表要正确渲染（名字/型号/地址/钥匙掩码 + 使用中徽标）；
//     编辑时钥匙留空必须等价于「不改」（不能把空字符串当新钥匙写进去）；
//     「设为当前」要把对的 id 交给主进程。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

type ModelConfigFile = {
    endpoint?: string;
    model?: string;
    key?: string;
    searchKey?: string;
    searchEndpoint?: string;
    searchProvider?: string;
    basePersona?: string;
    seeded?: boolean;
};

type ModelItem = {
    id: number;
    name: string;
    endpoint: string;
    model: string;
    keyMasked: string;
    hasKey: boolean;
};

function makeModels(items: ModelItem[], activeId: number | null) {
    return { items, activeId };
}

function makeTokenApi(config: ModelConfigFile, models = makeModels([], null)) {
    return {
        getModelConfig: vi.fn(async () => config),
        setModelConfig: vi.fn(async (patch: Partial<ModelConfigFile>) => ({ ...config, ...patch })),
        onModelConfigChanged: vi.fn(),
        listModels: vi.fn(async () => models),
        addModel: vi.fn(async () => 1),
        updateModel: vi.fn(async () => ({ ok: true })),
        deleteModel: vi.fn(async () => ({ ok: true, list: makeModels([], null) })),
        activateModel: vi.fn(async () => ({ ok: true, list: makeModels([], null) })),
    };
}

async function mountPage(config: ModelConfigFile = {}, models = makeModels([], null)) {
    const api = makeTokenApi(config, models);
    vi.stubGlobal("tokenApi", api);
    vi.resetModules();
    const mod = await import("./ModelConfigSettings.vue");
    const wrapper = mount(mod.default);
    await flushPromises();
    return { wrapper, api };
}

/** 单选框当前选中了哪个值（按 type 过滤，不用属性选择器，更稳） */
function radioValue(wrapper: ReturnType<typeof mount>): string | null {
    const checked = wrapper
        .findAll("input")
        .filter((r) => (r.element as HTMLInputElement).type === "radio")
        .find((r) => (r.element as HTMLInputElement).checked);
    return checked ? ((checked.element as HTMLInputElement).value as string) : null;
}

beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    // removeModel 里会弹 confirm，默认放行，需要拦的用例自己 stub
    vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("模型配置页", () => {
    it("能正常挂载（曾经因为引用了已删除的 mode 变量直接白屏）", async () => {
        const { wrapper } = await mountPage({ model: "gpt-5.4-mini" });
        expect(wrapper.exists()).toBe(true);
        expect(wrapper.text().length).toBeGreaterThan(0);
    });

    it("挂载时读一次配置和模型列表并订阅外部改动", async () => {
        const { api } = await mountPage({ model: "gpt-5.4-mini" });
        expect(api.getModelConfig).toHaveBeenCalledTimes(1);
        expect(api.listModels).toHaveBeenCalledTimes(1);
        expect(api.onModelConfigChanged).toHaveBeenCalledTimes(1);
    });

    it("多模型列表正确渲染：名字/型号/地址/钥匙掩码 + 使用中徽标", async () => {
        const { wrapper } = await mountPage(
            {},
            makeModels(
                [
                    {
                        id: 1,
                        name: "便宜快档",
                        endpoint: "https://api.cheap.example/v1",
                        model: "deepseek-chat",
                        keyMasked: "sk-******abcd",
                        hasKey: true,
                    },
                    {
                        id: 2,
                        name: "贵但聪明",
                        endpoint: "https://api.example.com/v1",
                        model: "gpt-5.4",
                        keyMasked: "",
                        hasKey: false,
                    },
                ],
                1,
            ),
        );
        const items = wrapper.findAll(".model-item");
        expect(items.length).toBe(2);
        // 第一套：使用中徽标 + 型号 + 掩码钥匙
        expect(items[0].classes()).toContain("model-item--active");
        expect(items[0].text()).toContain("便宜快档");
        expect(items[0].text()).toContain("使用中");
        expect(items[0].text()).toContain("deepseek-chat");
        expect(items[0].text()).toContain("https://api.cheap.example/v1");
        expect(items[0].text()).toContain("sk-******abcd");
        // 第二套：非当前（无徽标）、没钥匙给警示、不显示掩码
        expect(items[1].classes()).not.toContain("model-item--active");
        expect(items[1].text()).not.toContain("使用中");
        expect(items[1].text()).toContain("还没填钥匙");
        // 当前使用中的那套不该有「设为当前」按钮
        expect(items[0].text()).not.toContain("设为当前");
        expect(items[1].text()).toContain("设为当前");
    });

    it("编辑时钥匙留空 = 不改（不能把空字符串当新钥匙传下去）", async () => {
        const { wrapper, api } = await mountPage(
            {},
            makeModels(
                [
                    {
                        id: 7,
                        name: "旧套",
                        endpoint: "https://api.example.com/v1",
                        model: "deepseek-chat",
                        keyMasked: "sk-******abcd",
                        hasKey: true,
                    },
                ],
                7,
            ),
        );
        // 点「编辑」打开内联表单
        const editBtn = wrapper.findAll("button").find((b) => b.text() === "编辑");
        expect(editBtn).toBeDefined();
        await editBtn!.trigger("click");
        // 钥匙不回填明文：编辑框初始为空
        const keyInput = wrapper.find("input#mp-key");
        expect((keyInput.element as HTMLInputElement).value).toBe("");
        // 什么都不动直接保存
        const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("保存"));
        await saveBtn!.trigger("click");
        await flushPromises();
        expect(api.updateModel).toHaveBeenCalledTimes(1);
        expect(api.updateModel).toHaveBeenCalledWith(7, {
            name: "旧套",
            endpoint: "https://api.example.com/v1",
            model: "deepseek-chat",
            key: undefined,
        });
    });

    it("「设为当前」把对的 id 交给主进程并刷新列表", async () => {
        const { wrapper, api } = await mountPage(
            {},
            makeModels(
                [
                    {
                        id: 1,
                        name: "A",
                        endpoint: "https://a/v1",
                        model: "m-a",
                        keyMasked: "k",
                        hasKey: true,
                    },
                    {
                        id: 2,
                        name: "B",
                        endpoint: "https://b/v1",
                        model: "m-b",
                        keyMasked: "k",
                        hasKey: true,
                    },
                ],
                1,
            ),
        );
        const setActiveBtn = wrapper
            .findAll("button")
            .find((b) => b.text() === "设为当前");
        expect(setActiveBtn).toBeDefined();
        await setActiveBtn!.trigger("click");
        await flushPromises();
        expect(api.activateModel).toHaveBeenCalledTimes(1);
        expect(api.activateModel).toHaveBeenCalledWith(2);
        // 切换后刷新一次列表
        expect(api.listModels).toHaveBeenCalledTimes(2);
    });

    it("新增一套没填钥匙时提示且不调 addModel", async () => {
        const { wrapper, api } = await mountPage();
        // 点「添加一套」打开表单
        const addBtn = wrapper.findAll("button").find((b) => b.text().includes("添加一套"));
        await addBtn!.trigger("click");
        // 只填名字/地址/型号，钥匙留空
        await wrapper.find("input#mp-name").setValue("新套");
        await wrapper.find("input#mp-endpoint").setValue("https://api.example.com/v1");
        await wrapper.find("input#mp-model").setValue("gpt-5.4-mini");
        const saveBtn = wrapper.findAll("button").find((b) => b.text().includes("保存"));
        await saveBtn!.trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain("新的一套要把钥匙也填上");
        expect(api.addModel).not.toHaveBeenCalled();
    });

    it("认不出来的搜索来源一律回退到 uapis", async () => {
        const { wrapper } = await mountPage({ searchProvider: "不存在的来源" });
        expect(radioValue(wrapper)).toBe("uapis");
    });

    it("合法的搜索来源照常选中", async () => {
        const { wrapper } = await mountPage({ searchProvider: "searxng" });
        expect(radioValue(wrapper)).toBe("searxng");
    });

    it("没配过搜索来源时默认 uapis（单选框不能一个都不选中）", async () => {
        const { wrapper } = await mountPage({});
        expect(radioValue(wrapper)).toBe("uapis");
    });
});
