// electron/ai/services/social.spec.ts
// 社交环境层的硬要求（用户 2026-11-19 原话）：
//   「能看到机器人协议端的所有能力接口，看到几个好友，几个群，
//     谁加群了，谁戳一下了，群里有几个人…………一系列。
//     我希望她能完整意识到自己的人际关系和周围的环境。」
//
// 所以这里验的四件事都是"她能不能真的查出来"：
//   1) 协议端的群/好友/成员能落库并被读到
//   2) notice 事件（进群/戳一戳）能记下来、能查出来
//   3) 环境摘要块能产出可注入的自然语言（不是空串、不是 JSON）
//   4) 协议端不可用时优雅降级，不抛异常
import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import * as db from "../db/storage";
import * as social from "./social";

beforeAll(() => {
    const tmpDb = path.join(os.tmpdir(), `kirari-social-spec-${Date.now()}.db`);
    db.initDatabase(tmpDb);
});

/** 假的 OneBot 适配器：只提供 social 需要的三个拉取方法。 */
function fakeAdapter(overrides: Record<string, unknown> = {}) {
    return {
        id: "onebot",
        config: { groupReplyMode: "mention", groupFilter: "whitelist", groupAllowlist: ["111"] },
        fetchGroupList: async () => [
            { groupId: "111", groupName: "朋友的群", memberCount: 2, maxMemberCount: 200 },
            { groupId: "222", groupName: "大群", memberCount: 480, maxMemberCount: 500 },
        ],
        fetchFriendList: async () => [
            { userId: "1001", nickname: "白尔", remark: null },
            { userId: "1002", nickname: "小明", remark: "老同学" },
        ],
        fetchGroupMemberList: async (gid: string) =>
            gid === "111"
                ? [
                      { userId: "1001", nickname: "白尔", card: "群主白尔", role: "owner" },
                      { userId: "1002", nickname: "小明", card: null, role: "member" },
                  ]
                : [{ userId: "1002", nickname: "小明", card: null, role: "member" }],
        ...overrides,
    };
}

describe("social（人际环境与周围世界）", () => {
    it("同步协议端的群/好友/群成员，并落进 social_* 表", async () => {
        const r = await social.syncAdapter(fakeAdapter() as any, { groupReplyMode: "mention", groupAllowlist: ["111"] });
        expect(r.ok).toBe(true);
        expect(r.groups).toBe(2);
        expect(r.friends).toBe(2);
        // 111 拉了 2 人；222 有 480 人（>500 才跳过，这里照拉 1 人）
        expect(r.members).toBeGreaterThan(0);

        const groups = await db.listSocialGroups("onebot");
        expect(groups.map((g) => g.groupName)).toContain("朋友的群");
        // 人数排前面的是大群
        expect(groups[0].groupId).toBe("222");

        const friends = await db.listSocialContacts("onebot");
        expect(friends).toHaveLength(2);
        expect(friends.find((f) => f.userId === "1002")?.remark).toBe("老同学");

        const members = await db.listGroupMembers("onebot", "111");
        expect(members).toHaveLength(2);
        // 群主必须排第一（role 文本的字母序会把 owner 排到最后）
        expect(members[0].role).toBe("owner");
    });

    it("「我在这群能不能说话」跟着适配器配置走", async () => {
        await social.syncAdapter(fakeAdapter() as any, { groupReplyMode: "mention", groupFilter: "whitelist", groupAllowlist: ["111"] });
        const groups = await db.listSocialGroups("onebot");
        expect(groups.find((g) => g.groupId === "111")?.replyEnabled).toBe(true);
        expect(groups.find((g) => g.groupId === "222")?.replyEnabled).toBe(false);
    });

    it("notice 事件（谁进群、谁戳我、谁加好友）记下来能查出来", async () => {
        await social.recordEvent({
            adapterId: "onebot",
            eventType: "group_increase:approve",
            groupId: "111",
            actorId: "3003",
            detail: "3003 加入了群 111",
        });
        await social.recordEvent({
            adapterId: "onebot",
            eventType: "notify:poke",
            groupId: "111",
            actorId: "1002",
            targetId: "9999",
            detail: "1002 戳了戳你",
        });
        await social.recordEvent({
            adapterId: "onebot",
            eventType: "request:friend",
            actorId: "4004",
            detail: "4004 申请加你为好友（留言：你好）",
        });

        const events = await db.listSocialEvents({ adapterId: "onebot", limit: 10 });
        expect(events.length).toBeGreaterThanOrEqual(3);
        const types = events.map((e) => e.eventType);
        expect(types).toContain("group_increase:approve");
        expect(types).toContain("notify:poke");
        expect(types).toContain("request:friend");

        // 按群过滤
        const inGroup = await db.listSocialEvents({ adapterId: "onebot", groupId: "111", limit: 10 });
        expect(inGroup.every((e) => e.groupId === "111")).toBe(true);
    });

    it("环境摘要块是自然语言，且明确点出群、人数、事件", async () => {
        const block = await social.buildEnvironmentBlock({ adapterId: "onebot" });
        expect(block).not.toBe("");
        expect(block).toContain("你周围的环境");
        expect(block).toContain("朋友的群");
        expect(block).toContain("人");
        // 必须点明"这些是事实、别说不清楚"，否则她会继续答"我没有接口"
        expect(block).toContain("别说不清楚");
        // 不能是 JSON
        expect(block.trim().startsWith("{")).toBe(false);
    });

    it("成员变动事件会被识别为需要刷新成员表", () => {
        expect(social.affectsMembership("group_increase:approve")).toBe(true);
        expect(social.affectsMembership("group_decrease:leave")).toBe(true);
        expect(social.affectsMembership("notify:poke")).toBe(false);
        expect(social.affectsMembership("group_recall")).toBe(false);
    });

    it("协议端不支持时优雅降级，不抛异常", async () => {
        const noop = { id: "qqofficial", config: {} };
        expect(social.supportsSocial(noop as any)).toBe(false);
        const r = await social.syncAdapter(noop as any, {});
        expect(r.ok).toBe(false);
        expect(r.reason).toBe("unsupported");
        // 没有 adapterId 时也不能炸
        expect(await social.syncAdapter(null, {})).toMatchObject({ ok: false, reason: "no_adapter" });
        // 环境摘要拿不到数据 → 空串（绝不能抛）
        expect(await social.buildEnvironmentBlock({ adapterId: "不存在的适配器" })).toBe("");
    });

    it("单个接口失败不影响其它接口", async () => {
        const flaky = fakeAdapter({
            fetchFriendList: async () => {
                throw new Error("协议端这个接口没实现");
            },
        });
        const r = await social.syncAdapter(flaky as any, {});
        expect(r.ok).toBe(true);
        expect(r.groups).toBe(2); // 群照常同步
        expect(r.friends).toBe(0); // 好友失败但没炸
    });

    it("人物画像：好友 + 共同群 + 她记得的档案", async () => {
        const p = await social.personProfile("onebot", "1002");
        expect(p).not.toBeNull();
        expect(p!.contact?.nickname).toBeTruthy();
        expect(p!.groups.map((g) => g.groupId)).toContain("111");
    });
});
