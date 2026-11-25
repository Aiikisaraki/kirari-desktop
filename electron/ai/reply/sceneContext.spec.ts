// electron/ai/reply/sceneContext.spec.ts
// 场合感知与隐私边界：群聊必须带上隐私红线、私聊不带；场合描述要能区分且缺字段安全兜底。
import { describe, it, expect } from "vitest";
import { buildSceneContext, normalizeScene } from "./sceneContext";

describe("sceneContext（场合感知）", () => {
    it("群聊：识别群名/人数/发言人，并带上隐私红线", () => {
        const out = buildSceneContext({
            chatType: "group",
            groupName: "kirari 测试群",
            groupId: "123",
            senderName: "白尔同学",
            senderRole: "member",
            isOwner: false,
            memberCount: 3,
        });
        expect(out).toContain("群聊「kirari 测试群」");
        expect(out).toContain("约 3 人");
        expect(out).toContain("白尔同学");
        // 不能再把人分成"主人 / 不是主人本人"（用户明确否掉了这种二元）
        expect(out).not.toContain("不是主人本人");
        // 隐私红线必须存在
        expect(out).toContain("群聊");
        expect(out).toContain("不要说出任何私聊内容");
        expect(out).toContain("审计日志");
        // 群聊要收着说
        expect(out).toContain("收一点");
    });

    it("私聊：不加群聊隐私红线，允许放松", () => {
        const out = buildSceneContext({ chatType: "private", senderName: "白尔", isOwner: true });
        expect(out).toContain("一对一私聊");
        // 拥有者只是管理权限更高的那一位，措辞上要说明"不代表关系更近"
        expect(out).toContain("拥有者");
        expect(out).toContain("不代表你们的关系比别人更近");
        expect(out).toContain("白尔");
        expect(out).not.toContain("不要说出任何私聊内容");
        expect(out).toContain("可以放松");
    });

    it("缺字段时按一对一保守兜底，仍然注入去模板要求", () => {
        const out = buildSceneContext(null);
        expect(out).toContain("一对一对话");
        expect(out).not.toContain("不要说出任何私聊内容");
        // 去 AI 味的自我要求在任何场合都要在
        expect(out).toContain("别像模板");
        // ⚠️ 断言过期（2026-11-25 分层改造，与核心版同步）：
        // 原来钉的是「少用语气词」——那是旧文案，语义是劝她别说话（用户反馈「太高冷」的成因之一）。
        // 核心版把这条改成「语气词和波浪号别堆：偶尔一个很自然，堆多了才像模板」，
        // 只禁「堆」、不禁「用」。所以这里钉新的措辞，并且**反向**钉住旧措辞不能回潮。
        expect(out).toContain("语气词和波浪号别堆");
        expect(out).not.toContain("少用语气词");
    });

    it("isGroup 布尔也能识别为群聊（适配器兼容）", () => {
        const sc = normalizeScene({ isGroup: true, groupId: "999" });
        expect(sc.type).toBe("group");
    });

    it("群名缺失时退化为群号", () => {
        const out = buildSceneContext({ chatType: "group", groupId: "8888" });
        expect(out).toContain("群号 8888");
    });

    it("非拥有者发言不会被说成拥有者本人", () => {
        const out = buildSceneContext({ chatType: "private", senderName: "路人", isOwner: false });
        expect(out).not.toContain("拥有者");
        expect(out).toContain("路人");
    });
});
