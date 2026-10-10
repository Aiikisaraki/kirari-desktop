// pet store 的解构方式回归测试。
//
// PetStage.vue 曾经直接 `const { isVisible, message } = petStore` —— setup store
// 是 reactive proxy，解构拿到的是**解包后的值**，于是 `isVisible.value` 恒为
// undefined，聊天气泡与可见性判断全部失效。这两条用例把「必须走 storeToRefs」
// 钉死，防止有人图省事改回直接解构。

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia, storeToRefs } from "pinia";
import { usePetStore } from "./pet";

describe("pet store", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it("storeToRefs 解构拿到的是 ref，.value 有真实值", () => {
        const { isVisible, message } = storeToRefs(usePetStore());
        expect(isVisible.value).toBe(true);
        expect(typeof message.value).toBe("string");
        expect(message.value.length).toBeGreaterThan(0);
    });

    it("直接解构拿到的是解包后的值 —— 这就是气泡曾经永不显示的原因", () => {
        const { isVisible } = usePetStore();
        // 运行时 isVisible 是 boolean，取 .value 得到 undefined（不是报错）
        expect((isVisible as unknown as { value?: unknown }).value).toBeUndefined();
    });

    it("storeToRefs 出来的 ref 跟着 store 走", () => {
        const store = usePetStore();
        const { message } = storeToRefs(store);
        store.setMessage("测试提示");
        expect(message.value).toBe("测试提示");
    });

    it("切换可见性会同步换提示语", () => {
        const store = usePetStore();
        store.toggleVisible();
        expect(store.isVisible).toBe(false);
        expect(store.message).toBe("先躲一小会儿。");
        store.toggleVisible();
        expect(store.isVisible).toBe(true);
        expect(store.message).toBe("我回来啦。");
    });
});
