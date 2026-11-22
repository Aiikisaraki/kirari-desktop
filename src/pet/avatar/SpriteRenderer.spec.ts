import { describe, expect, it } from "vitest";
import { nextSpriteFrame } from "./SpriteRenderer";

// 背景：渲染器曾经在"非循环片段播完"时自己 setState(baseStateName)，
// 而 PetStage 的 actionTimer + CHAIN_NEXT 才是状态流转的唯一所有者。
// 两个所有者各管一段 → 睡眠链的循环入口会被渲染器抢先改回站姿：
//   sleep_start 播完本该进 sleepy 循环，却被抢回 idle；
//   sleep_end   播完本该回 idle，被抢也是 idle（碰巧正确）。
// 所以这里锁住两件事：
//   1) 渲染器播到末帧就停住，不越权改状态、不归零重播；
//   2) 一次性片段停在末帧后，调度器接管切到后继状态时帧号从 0 重新开始。

describe("nextSpriteFrame", () => {
    it("循环片段回绕到第 0 帧", () => {
        expect(nextSpriteFrame(0, 42, true)).toBe(1);
        expect(nextSpriteFrame(41, 42, true)).toBe(0);
    });

    it("非循环片段停在末帧，不归零也不跳状态", () => {
        expect(nextSpriteFrame(119, 121, false)).toBe(120);
        expect(nextSpriteFrame(120, 121, false)).toBe(120);
    });

    it("停在末帧后连续调用保持稳定", () => {
        let f = 0;
        for (let i = 0; i < 500; i += 1) f = nextSpriteFrame(f, 30, false);
        expect(f).toBe(29);
    });

    it("单帧片段不会越界", () => {
        expect(nextSpriteFrame(0, 1, true)).toBe(0);
        expect(nextSpriteFrame(0, 1, false)).toBe(0);
    });

    it("空片段安全返回 0", () => {
        expect(nextSpriteFrame(0, 0, false)).toBe(0);
        expect(nextSpriteFrame(5, 0, true)).toBe(0);
    });

    it("一次性片段播到底后不会被渲染器送回第 0 帧自己重播", () => {
        // 这是"动作播完直接跳回站姿"那个 bug 的直接回归点：
        // 只要末帧能稳定停住，调度器就有机会先切到 CHAIN_NEXT 指定的后继态。
        const frames = 121;
        let f = nextSpriteFrame(0, frames, false);
        while (f < frames - 1) f = nextSpriteFrame(f, frames, false);
        expect(f).toBe(frames - 1);
        expect(nextSpriteFrame(f, frames, false)).toBe(f);
    });
});
