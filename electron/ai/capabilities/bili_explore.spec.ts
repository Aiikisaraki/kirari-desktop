// @vitest-environment node
// 桌宠端 bili_explore 的「读完之后想说点什么」闸门。
//
// 在防两件事：
//   ① 判据挂了一条永不到达的线（原来想用 fromSchedule，但两端都没有调用方置它）
//      —— 结果就是「功能写了，但永远不会触发」，用户感知等于没做。
//   ② 主人当面叫她「去B站看看」时再补一条主动消息，自己跟自己抢话。
//
// 分享本身的闸门/账本在 presence 那一侧（见 presence/proactive.spec.ts），
// 这里只钉「什么时候该尝试分享」这一个判断。
import { describe, expect, it } from "vitest";
import { isAutonomousBrowse } from "./builtin/bili_explore";

describe("自主浏览判定：只在她自己去的时候才分享", () => {
    it("定期任务会话（workspace:<owner>:<task>）→ 自主", () => {
        expect(isAutonomousBrowse({ sessionId: "workspace:1980308740:morning-bili" })).toBe(true);
    });

    it("子任务会话（sub::<uid>::<task>）→ 自主", () => {
        expect(isAutonomousBrowse({ sessionId: "sub::1::bili-digest" })).toBe(true);
    });

    it("主人当面的桌面会话（纯 UUID）→ 不抢话", () => {
        expect(isAutonomousBrowse({ sessionId: "0f6c2a1e-9b3d-4c8a-a1e2-3f4b5c6d7e8f" })).toBe(false);
    });

    it("QQ 会话（bot-<adapter>-<conv>）→ 不抢话", () => {
        expect(isAutonomousBrowse({ sessionId: "bot-onebot-private:1980308740" })).toBe(false);
    });

    it("没有会话上下文 → 按自主处理（后台链路本来就没有人在旁边）", () => {
        expect(isAutonomousBrowse({})).toBe(true);
        expect(isAutonomousBrowse(null)).toBe(true);
    });
});