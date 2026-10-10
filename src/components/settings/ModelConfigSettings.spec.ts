// 模型配置页的回归测试。
//
// 主要盯两件事：
//  1. 这个页面曾经「点进去就卡死」—— onMounted 里引用了已被删除的 `mode` 变量，
//     抛 ReferenceError 导致整个组件渲染失败。这里保证它能正常挂载。
//  2. 主进程给回来的 searchProvider 是 string，认不出来的值要回退到 uapis，
//     否则单选框一个都不选中，界面上看着像没配置。

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

function makeTokenApi(config: ModelConfigFile) {
    return {
        getModelConfig: vi.fn(async () => config),
        setModelConfig: vi.fn(async (patch: Partial<ModelConfigFile>) => ({ ...config, ...patch })),
        onModelConfigChanged: vi.fn(),
    };
}

async function mountPage(config: ModelConfigFile = {}) {
    const api = makeTokenApi(config);
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
});

describe("模型配置页", () => {
    it("能正常挂载（曾经因为引用了已删除的 mode 变量直接白屏）", async () => {
        const { wrapper } = await mountPage({ model: "gpt-5.4-mini" });
        expect(wrapper.exists()).toBe(true);
        expect(wrapper.text().length).toBeGreaterThan(0);
    });

    it("挂载时读一次配置并订阅外部改动", async () => {
        const { api } = await mountPage({ model: "gpt-5.4-mini" });
        expect(api.getModelConfig).toHaveBeenCalledTimes(1);
        expect(api.onModelConfigChanged).toHaveBeenCalledTimes(1);
    });

    it("读回来的值填进表单", async () => {
        const { wrapper } = await mountPage({
            model: "deepseek-chat",
            endpoint: "https://api.example.com/v1",
        });
        const modelInput = wrapper.find("input#model");
        expect((modelInput.element as HTMLInputElement).value).toBe("deepseek-chat");
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
