// electron/ai/services/memory.spec.ts
// 长期记忆的三条硬要求：
//   1) 跨对话存续（新开一个会话仍认得同一个人）
//   2) 按对话者分池联想（不把 A 的事讲给 B）
//   3) 场合可见性闸门（私密记忆绝不出现在群聊）
import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import * as db from "../db/storage";
import * as memory from "./memory";

let tmpDb = "";

beforeAll(() => {
    tmpDb = path.join(os.tmpdir(), `kirari-mem-spec-${Date.now()}.db`);
    db.initDatabase(tmpDb);
});

describe("memory（长期记忆）", () => {
    it("跨会话：换一个 sessionId 仍能想起同一个人", async () => {
        const ctx1 = { sessionId: "bot-onebot-private:1001", uid: 1, isOwner: true };
        await memory.remember({ content: "白尔喜欢猫，讨厌香菜", scope: "person" }, ctx1);

        // 完全不同的会话 id，但对话者相同 → 仍然认得
        const ctx2 = { sessionId: "bot-onebot-private:1001", uid: 1, isOwner: true };
        const { block } = await memory.buildMemoryBlock(ctx2, "晚上吃什么");
        expect(block).toContain("讨厌香菜");
    });

    it("场景隔离：群聊看不到 private/secret 记忆", async () => {
        const priv = { sessionId: "bot-onebot-private:2002", uid: 1, isOwner: true };
        await memory.remember(
            { content: "这条是私人秘密，不该进群", scope: "self", visibility: "private" },
            priv,
        );
        const grp = { sessionId: "bot-onebot-group:888:3003", uid: 1, isOwner: false, isGroup: true };
        const { block } = await memory.buildMemoryBlock(grp, "私人秘密");
        expect(block).not.toContain("这条是私人秘密");
    });

    it("scene 池在群聊内可见（不会因为闸门把自己的群记忆也挡掉）", async () => {
        const grp = { sessionId: "bot-onebot-group:777:4004", uid: 1, isOwner: false, isGroup: true };
        await memory.remember({ content: "这个群周五晚上打游戏", scope: "scene" }, grp);
        const { block } = await memory.buildMemoryBlock(grp, "周五打游戏吗");
        expect(block).toContain("周五晚上打游戏");
    });

    it("敏感内容强制升级为 secret，群聊里读不到", async () => {
        const priv = { sessionId: "bot-onebot-private:5005", uid: 1, isOwner: true };
        const r = await memory.remember({ content: "服务器密码记在密码本", scope: "self" }, priv);
        expect(r.ok).toBe(true);
        // 注意：这条内容不是「关于 Kirari 自己」的，而是对话者自己的事，
        // 所以 rehomeSelfSubject 会把它归到 person::5005（他本人的池），
        // 不再落进所有用户共享的 self::<uid> 池 —— 这正是线上跨用户泄露的修复点。
        const rows = await db.listMemories([memory.PERSON("5005")], { limit: 200 });
        const row = rows.find((x) => x.content.includes("密码本"));
        expect(row?.visibility).toBe("secret");

        const grp = { sessionId: "bot-onebot-group:999:5005", uid: 1, isOwner: false, isGroup: true };
        const { block } = await memory.buildMemoryBlock(grp, "密码本 服务器");
        expect(block).not.toContain("密码本");
    });

    it("不同对话者的池互不干扰", async () => {
        const a = { sessionId: "bot-onebot-private:A001", uid: 1, isOwner: false };
        const b = { sessionId: "bot-onebot-private:B002", uid: 1, isOwner: false };
        await memory.remember({ content: "A 说他养了一只柯基", scope: "person" }, a);

        const forB = await memory.buildMemoryBlock(b, "养了什么");
        expect(forB.block).not.toContain("柯基");
        const forA = await memory.buildMemoryBlock(a, "养了什么");
        expect(forA.block).toContain("柯基");
    });

    it("去重：同一件事记两次不会变成两条", async () => {
        const ctx = { sessionId: "bot-onebot-private:D001", uid: 1, isOwner: true };
        const first = await memory.remember({ content: "主人不吃辣", scope: "self" }, ctx);
        const second = await memory.remember({ content: "主人不吃辣。", scope: "self" }, ctx);
        expect(first.ok).toBe(true);
        expect(second.duplicate).toBe(true);
        expect(second.id).toBe(first.id);
    });

    it("forget：只删当前场合可见的记忆", async () => {
        const ctx = { sessionId: "bot-onebot-private:E001", uid: 1, isOwner: true };
        const r = await memory.remember({ content: "临时记一下这件事", scope: "self" }, ctx);
        expect(r.id).toBeTruthy();
        const del = await memory.forget({ id: r.id }, ctx);
        expect(del.ok).toBe(true);
        const left = await memory.list(ctx, { limit: 200 });
        expect(left.some((m) => m.id === r.id)).toBe(false);
    });

    it("resolveSubjects：群聊含 scene 池，私聊不含", () => {
        const grp = memory.resolveSubjects({ sessionId: "bot-onebot-group:123:456", uid: 1 });
        expect(grp.some((s) => s.startsWith("scene::"))).toBe(true);
        expect(grp.some((s) => s.startsWith("person::"))).toBe(true);
        expect(grp).toContain(memory.SELF(1));

        const priv = memory.resolveSubjects({ sessionId: "bot-onebot-private:789", uid: 1 });
        expect(priv.some((s) => s.startsWith("scene::"))).toBe(false);
        expect(priv.some((s) => s.startsWith("person::"))).toBe(true);
    });

    it("allowedVisibility：群聊只给 public，一对一不再按主人/非主人二分", () => {
        expect(memory.allowedVisibility({ sessionId: "bot-onebot-group:1:2" })).toEqual(["public"]);
        // 一对一里"能读到哪几档"对所有人一致——可见性由「这条记忆关于谁」决定，
        // 不由「说话的人是不是主人」决定（用户明确否掉了主人/非主人二元）。
        expect(memory.allowedVisibility({ sessionId: "bot-onebot-private:2", role: "owner" })).toContain("secret");
        expect(memory.allowedVisibility({ sessionId: "bot-onebot-private:2", role: "user" })).toContain("secret");
    });

    it("转述：A 说的关于 B 的事，B 自己出现时能想起，但不暴露是 A 说的", async () => {
        const a = { sessionId: "bot-onebot-private:F001", uid: 1, role: "user", counterpartId: "F001" };
        const b = { sessionId: "bot-onebot-private:G002", uid: 1, role: "user", counterpartId: "G002" };
        await memory.remember({ content: "G002 最近失恋了，状态不好", aboutPerson: "G002", importance: 5 }, a);

        // B 自己问起 → 关于自己的事浮现（记忆不撕裂）
        const forB = await memory.buildMemoryBlock(b, "我最近状态不好");
        expect(forB.block).toContain("失恋");

        // 但 A 自己的偏好仍然不给 B 看
        await memory.remember({ content: "F001 喜欢喝无糖可乐", importance: 4 }, a);
        const forB2 = await memory.buildMemoryBlock(b, "喜欢喝什么");
        expect(forB2.block).not.toContain("无糖可乐");
    });

    it("secret：关于别人的私事，除当事人外谁都读不到", async () => {
        const a = { sessionId: "bot-onebot-private:H001", uid: 1, role: "owner", counterpartId: "H001" };
        const c = { sessionId: "bot-onebot-private:I002", uid: 1, role: "user", counterpartId: "I002" };
        await memory.remember(
            { content: "J003 的病史不要外传", aboutPerson: "J003", visibility: "secret", importance: 5 },
            a,
        );
        const forC = await memory.buildMemoryBlock(c, "J003 身体怎么样");
        expect(forC.block).not.toContain("病史");
        // 拥有者自己也读不到（这条不是关于他的）
        const forOwner = await memory.buildMemoryBlock(a, "J003 身体怎么样");
        expect(forOwner.block).not.toContain("病史");
    });

    it("人物档案：role 只表达管理权限，不影响记忆归属", async () => {
        await memory.touchPerson({ personKey: "K001", role: "owner", displayName: "白尔" });
        await memory.touchPerson({ personKey: "L002", displayName: "小明" });
        const owner = await memory.getPerson("K001");
        const guest = await memory.getPerson("L002");
        expect(owner?.role).toBe("owner");
        // 没指定角色的人默认 user，但**照样有自己的池**（不是"客人没有记忆"）
        expect(guest?.role).toBe("user");

        const guestCtx = { sessionId: "bot-onebot-private:L002", uid: 1, role: "user", counterpartId: "L002" };
        await memory.remember({ content: "小明养了一只柯基" }, guestCtx);
        const { block } = await memory.buildMemoryBlock(guestCtx, "养了什么");
        expect(block).toContain("柯基");
    });

    it("记忆关联：建立 link 后可以从关系网联想", async () => {
        await memory.touchPerson({ personKey: "M001", displayName: "甲" });
        await memory.touchPerson({ personKey: "N002", displayName: "乙" });
        const r = await memory.link(memory.PERSON("M001"), memory.PERSON("N002"), "knows", 5);
        expect(r.ok).toBe(true);
        const links = await memory.linksOf(memory.PERSON("M001"));
        expect(links.some((l) => l.other === memory.PERSON("N002") && l.relation === "knows")).toBe(true);
    });

    // ── 身份隔离大排查的残留漏洞（审计 A3/A3b/A4/B1）────────────────
    //
    // 这一节的每一条都对应一个**线上真实发生过**或**探针复现过**的泄露路径。
    // 其中 A3 就是用户最初报障的原始路径，必须长期防回归。
    describe("身份隔离残留漏洞", () => {
        it("★ A3：指代歧义 —— 「我」永远指说话人，不是 Kirari", () => {
            const friend = {
                sessionId: "bot-onebot-private:1658359753",
                counterpartId: "1658359753",
                role: "user",
                uid: 1,
                isGroup: false,
                sceneScope: "",
                displayName: "",
                platform: "qq",
            } as any;
            // 这几条老实现会被判成"关于 Kirari 自己"而留在 self::1（全员共享池），
            // 于是朋友说「我心情很糟」，主人下次开口就读到了。
            for (const content of [
                "我心情很糟",
                "我今天跟我妈吵架了",
                "我妈妈说我不听话",
                "我设定里有个毛病",
            ]) {
                expect(memory.rehomeSelfSubject("self::1", friend, content)).toBe(
                    memory.PERSON("1658359753"),
                );
            }
            // 明确指出 Kirari 的才留在共享池
            for (const content of ["Kirari 的设定里她怕黑", "她的性格应该更温柔"]) {
                expect(memory.rehomeSelfSubject("self::1", friend, content)).toBe("self::1");
            }
        });

        it("★ A3：身份不明时拒绝写入，绝不能落共享池", async () => {
            for (const cp of ["", "unknown", null, undefined]) {
                expect(
                    memory.rehomeSelfSubject("self::1", { counterpartId: cp, role: "user", uid: 1 } as any, "我妈住院了"),
                ).toBeNull();
            }
            // remember 层面也拒绝，且给出可解释的原因
            const r = await memory.remember(
                { content: "我妈住院了", scope: "self" },
                { sessionId: "bot-onebot-private:", uid: 1 } as any,
            );
            expect(r.ok).toBe(false);
        });

        it("★ A3b：person::unknown 是第三个共享池，读侧必须 fail-closed", () => {
            expect(
                memory.isMemoryVisible({ subject: "person::unknown", visibility: "private" } as any, {
                    counterpartId: "unknown",
                } as any),
            ).toBe(false);
            expect(
                memory.isMemoryVisible({ subject: "self::1", visibility: "private" } as any, {
                    counterpartId: "unknown",
                } as any),
            ).toBe(false);
            // 但不能过度封锁：global 的 public 常识仍然可读
            expect(
                memory.isMemoryVisible({ subject: memory.GLOBAL, visibility: "public" } as any, {
                    counterpartId: "unknown",
                } as any),
            ).toBe(true);
        });

        it("★ A4：别人的私事注给当事人时，第三方姓名必须脱敏", () => {
            const out = memory.sanitizeForSubject("小美跟张三在偷偷交往", { dropNames: ["张三"] });
            expect(out).not.toContain("张三");
            // 脱敏后仍有信息量，不是全抹掉
            expect(out).toContain("交往");
        });
    });
});
