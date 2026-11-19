// electron/ai/services/workspace.spec.ts
// 工作空间 + 定期任务（desktop 端）。
//
// 用户 2026-11-19 原话：
//   「我想给他加入工作空间的概念，这个，注意，从机（叶子节点）的任务依旧转发给
//     主机完成。这样它可以执行一些定期的自动化任务，并且保留一定量的数据。
//     这个空间文件夹是一个独立的文件夹，放在用户目录下，下面再分为不同的任务
//     所属的文件夹」
//
// 用户 2026-11-20 原话（按人隔离的由来）：
//   「我今天把机器人转发给了我一个朋友，她是私聊我的机器人，建立了几个每日任务，
//     但是我怎么可以直接看到她的任务呢……机器人的回复就像是，完全没区分这是谁的任务」
//
// 这里验五件事：
//   1) 目录形态：一个任务一个文件夹，改名不搬文件夹
//   2) 路径隔离：她拿到完整删除权限，越权就必须拒（这是最要紧的一节）
//   3) 保留策略：留一定量的数据，但不能无限长
//   4) 叶子转发：任务上行给主机，且叶子不本地跑（用户强调的那一点）
//   5) **按人隔离**：默认只看得到自己的（这是 2026-11-20 报障的回归测试）
//
// 2026-11-20 起所有任务函数第一个参数都是 owner，所以这里每个调用都显式带 OWNER。
// 这本身就是对「隔离是默认、不是特例」的一次回归：凡是还能不带 owner 就拿到别人
// 数据的调用，都该在这里编译失败或断言失败。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 必须在 import 被测模块之前设好环境变量：resolveRoot() 读的是 process.env。
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-ws-spec-"));
process.env.KIRARI_WORKSPACE = tmpWs;

import * as workspace from "./workspace";
import * as workspaceTask from "./workspaceTask";

/** 两个「人」：主人和她的朋友。用真实 QQ 号形态，顺便验证纯数字不会被 safeSegment 拦。 */
const OWNER = "1658359753";
const FRIEND = "1980308740";

afterAll(() => {
    try {
        fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        /* Windows 上偶尔删不掉，不影响测试结论 */
    }
});

describe("目录形态", () => {
    it("根目录跟 KIRARI_WORKSPACE 一致，且在用户目录之外（不是 ~/.kirari）", () => {
        expect(workspace.rootDir()).toBe(path.resolve(tmpWs));
        // 默认位置是 ~/KirariWorkspace —— 刻意跟 ~/.kirari 分开：
        // 那是配置和数据库，这里是产物，用户要能随手翻到。
        expect(workspace.ROOT_DIR_NAME).toBe("KirariWorkspace");
    });

    it("任务文件夹在 owner 层之下", () => {
        const t = workspace.ensureTask(OWNER, "daily-news-abc123", { title: "每日科技简报" });
        expect(t.dir).toBe(path.join(path.resolve(tmpWs), OWNER, "daily-news-abc123"));
        expect(fs.existsSync(t.dir)).toBe(true);
        expect(fs.existsSync(path.join(t.dir, workspace.TASK_META_FILE))).toBe(true);
        expect(workspace.readTaskMeta(OWNER, "daily-news-abc123").title).toBe("每日科技简报");
    });

    it("meta 里记了 owner（文件夹被单独拷走/还原时还能看出归属）", () => {
        workspace.ensureTask(OWNER, "daily-news-abc123", {});
        expect(workspace.readTaskMeta(OWNER, "daily-news-abc123").owner).toBe(OWNER);
    });

    it("改标题不搬文件夹（按 id 命名的核心承诺）", () => {
        const before = workspace.taskDir(OWNER, "daily-news-abc123");
        workspace.ensureTask(OWNER, "daily-news-abc123", { title: "改过的标题" });
        expect(workspace.taskDir(OWNER, "daily-news-abc123")).toBe(before);
        expect(fs.existsSync(before)).toBe(true);
        expect(workspace.readTaskMeta(OWNER, "daily-news-abc123").title).toBe("改过的标题");
    });

    it("owner 层目录名就是 owner 本身（不额外套一层公共目录）", () => {
        expect(workspace.ownerRoot(OWNER)).toBe(path.join(path.resolve(tmpWs), OWNER));
        expect(workspace.LOCAL_OWNER).toBe("_local");
    });
});

describe("路径隔离（她拿到完整删除权限，这节最要紧）", () => {
    const taskId = "isolation-test";

    beforeAll(() => {
        workspace.ensureTask(OWNER, taskId, { title: "越权测试" });
    });

    it("拒绝 .. 上跳", () => {
        expect(() => workspace.resolveInTask(OWNER, taskId, "../escape")).toThrow();
        expect(() => workspace.resolveInTask(OWNER, taskId, "a/../../b")).toThrow();
    });

    it("拒绝绝对路径与盘符", () => {
        expect(() => workspace.resolveInTask(OWNER, taskId, "/etc/passwd")).toThrow();
        expect(() => workspace.resolveInTask(OWNER, taskId, "C:/x")).toThrow();
        expect(() => workspace.resolveInTask(OWNER, taskId, "D:\\x")).toThrow();
    });

    it("拒绝 UNC 路径", () => {
        expect(() => workspace.resolveInTask(OWNER, taskId, "\\\\server\\share")).toThrow();
    });

    it("拒绝非法 taskId", () => {
        expect(() => workspace.taskDir(OWNER, "..")).toThrow();
        expect(() => workspace.taskDir(OWNER, "a/b")).toThrow();
        expect(() => workspace.taskDir(OWNER, "a\\b")).toThrow();
        expect(() => workspace.taskDir(OWNER, "")).toThrow();
    });

    it("拒绝 Windows 保留设备名与结尾点号", () => {
        expect(() => workspace.taskDir(OWNER, "con")).toThrow();
        expect(() => workspace.taskDir(OWNER, "abc.")).toThrow();
    });

    it("拒绝两端带空格（而不是悄悄 trim）", () => {
        // trim 会让「写进去的名字」和「调用方以为的名字」不一致，
        // 之后按原名读回来就是 404 —— 所以宁可直接拒。
        expect(() => workspace.taskDir(OWNER, "abc ")).toThrow();
        expect(() => workspace.taskDir(OWNER, " abc")).toThrow();
    });

    it("拒绝控制字符和 Windows 非法字符", () => {
        expect(() => workspace.resolveInTask(OWNER, taskId, "a\u0000b.txt")).toThrow();
        expect(() => workspace.resolveInTask(OWNER, taskId, "a:b.txt")).toThrow();
    });

    it("越权失败后确实没在空间外面留下东西", () => {
        expect(fs.existsSync(path.join(tmpWs, "..", "escape"))).toBe(false);
    });
});

describe("owner 也是路径，同样必须过校验", () => {
    // owner 来自对话者标识（senderId / counterpartId）。它一旦能带路径分隔符，
    // 上层「按人隔离」就成了摆设：一个带 .. 的 senderId 能读到别人的（甚至空间外的）目录。
    it("拒绝 .. 与多重上跳", () => {
        expect(() => workspace.ownerRoot("..")).toThrow();
        expect(() => workspace.ownerRoot("../..")).toThrow();
        expect(() => workspace.ownerDirName("..")).toThrow();
    });

    it("拒绝斜杠与反斜杠", () => {
        expect(() => workspace.ownerRoot("a/b")).toThrow();
        expect(() => workspace.ownerRoot("a\\b")).toThrow();
    });

    it("拒绝空 owner（不做「退化成公共目录」的兜底）", () => {
        // 退化成公共目录 = 把隔离抹平，所以这里必须抛，而不是返回 root。
        expect(() => workspace.ownerRoot("")).toThrow();
        expect(() => workspace.ownerDirName("")).toThrow();
        expect(() => workspace.ownerRoot(null)).toThrow();
        expect(() => workspace.ownerRoot(undefined)).toThrow();
    });

    it("拒绝保留设备名、结尾点、两端空格", () => {
        expect(() => workspace.ownerRoot("con")).toThrow();
        expect(() => workspace.ownerRoot("abc.")).toThrow();
        expect(() => workspace.ownerRoot("abc ")).toThrow();
        expect(() => workspace.ownerRoot(" abc")).toThrow();
    });

    it("但纯数字 QQ 号必须能通过（真实 owner 形态）", () => {
        expect(workspace.ownerDirName("1658359753")).toBe("1658359753");
        expect(workspace.ownerDirName(1658359753)).toBe("1658359753");
    });
});

describe("文件读写与删除", () => {
    const taskId = "files-test";

    beforeAll(() => {
        workspace.ensureTask(OWNER, taskId, { title: "文件测试" });
    });

    it("写入自动建父目录，读回来一致", () => {
        workspace.writeFile(OWNER, taskId, "notes/2026-11-19.md", "# 今天\n有内容");
        expect(fs.existsSync(path.join(workspace.taskDir(OWNER, taskId), "notes"))).toBe(true);
        expect(workspace.readFile(OWNER, taskId, "notes/2026-11-19.md")).toContain("有内容");
    });

    it("列目录藏掉 meta.json，但不误伤子目录里同名的用户文件", () => {
        workspace.writeFile(OWNER, taskId, "sub/meta.json", '{"mine":true}');
        const root = workspace.listFiles(OWNER, taskId);
        expect(root.some((e) => e.name === workspace.TASK_META_FILE)).toBe(false);
        const sub = workspace.listFiles(OWNER, taskId, "sub");
        expect(sub.some((e) => e.name === "meta.json")).toBe(true);
    });

    it("删文件、删空目录；非空目录要拒", () => {
        workspace.writeFile(OWNER, taskId, "tmp/a.txt", "x");
        expect(workspace.remove(OWNER, taskId, "tmp/a.txt").removed).toBe(true);
        expect(workspace.remove(OWNER, taskId, "tmp").removed).toBe(true);

        workspace.writeFile(OWNER, taskId, "full/b.txt", "x");
        expect(() => workspace.remove(OWNER, taskId, "full")).toThrow();
    });

    it("不能删整个任务文件夹（要删走 removeTask）", () => {
        expect(() => workspace.remove(OWNER, taskId, "")).toThrow();
    });

    it("读超大文件要拒（否则会把上下文炸掉）", () => {
        const big = "x".repeat(workspace.LIMITS.readBytes + 10);
        workspace.writeFile(OWNER, taskId, "big.txt", big);
        expect(() => workspace.readFile(OWNER, taskId, "big.txt")).toThrow(/太大/);
    });
});

describe("保留策略", () => {
    it("按数量清理最旧的，meta.json 永不删", () => {
        const taskId = "prune-test";
        const t = workspace.ensureTask(OWNER, taskId, { title: "清理测试" });
        for (let i = 0; i < 5; i++) {
            workspace.writeFile(OWNER, taskId, `f${i}.txt`, "x".repeat(10));
            const p = path.join(t.dir, `f${i}.txt`);
            const ts = Date.now() - (5 - i) * 60000; // 拉开 mtime，排序才稳
            fs.utimesSync(p, new Date(ts), new Date(ts));
        }
        const r = workspace.pruneTask(OWNER, taskId, { keepFiles: 2, keepDays: 0, keepBytes: 0 });
        expect(r.deleted).toBe(3);
        expect(workspace.listFiles(OWNER, taskId).length).toBe(2);
        expect(fs.existsSync(path.join(t.dir, workspace.TASK_META_FILE))).toBe(true);
    });

    it("按天数清理超龄文件", () => {
        const taskId = "prune-days";
        const t = workspace.ensureTask(OWNER, taskId, { title: "超龄测试" });
        workspace.writeFile(OWNER, taskId, "old.txt", "x");
        const p = path.join(t.dir, "old.txt");
        const old = Date.now() - 60 * 86400000; // 60 天前
        fs.utimesSync(p, new Date(old), new Date(old));
        workspace.writeFile(OWNER, taskId, "new.txt", "x");
        const r = workspace.pruneTask(OWNER, taskId, { keepDays: 30, keepFiles: 0, keepBytes: 0 });
        expect(r.deleted).toBe(1);
        expect(workspace.listFiles(OWNER, taskId).some((e) => e.name === "new.txt")).toBe(true);
    });
});

describe("概览与记账", () => {
    it("recordRun 累加运行次数并记时间", () => {
        const taskId = "rec-test";
        workspace.ensureTask(OWNER, taskId, { title: "记账测试" });
        workspace.recordRun(OWNER, taskId);
        workspace.recordRun(OWNER, taskId);
        const meta = workspace.readTaskMeta(OWNER, taskId);
        expect(meta.runCount).toBe(2);
        expect(meta.lastRunAt).toBeTruthy();
    });

    it("overview 统计任务数与文件数，根路径是自己的那层", () => {
        const o = workspace.overview(OWNER);
        expect(o.root).toBe(path.join(path.resolve(tmpWs), OWNER));
        expect(o.owner).toBe(OWNER);
        expect(o.tasks).toBeGreaterThan(0);
        expect(Array.isArray(o.list)).toBe(true);
    });

    it("列表按最近运行排序（跑过的在前）", () => {
        const list = workspace.listTasks(OWNER);
        const rec = list.find((t) => t.taskId === "rec-test");
        expect(rec).toBeTruthy();
        expect(list[0].lastRunMs).toBeGreaterThanOrEqual(list[list.length - 1].lastRunMs);
    });
});

// ─────────────────────────────────────────────────────────────────────
// 按人隔离：2026-11-20 用户报障的回归测试，不能少
// ─────────────────────────────────────────────────────────────────────
describe("按人隔离（2026-11-20 报障的回归）", () => {
    beforeAll(() => {
        workspace.ensureTask(OWNER, "owner-only-task", { title: "主人的任务" });
        workspace.ensureTask(FRIEND, "friend-secret-task", { title: "朋友的任务" });
        workspace.writeFile(OWNER, "owner-only-task", "note.md", "主人的产出");
        workspace.writeFile(FRIEND, "friend-secret-task", "note.md", "朋友的秘密产出");
    });

    it("两人各建任务，listTasks 只看到自己的", () => {
        const mine = workspace.listTasks(OWNER).map((t) => t.taskId);
        const hers = workspace.listTasks(FRIEND).map((t) => t.taskId);

        expect(mine).toContain("owner-only-task");
        expect(hers).toContain("friend-secret-task");
        // 关键：朋友的没混进主人的列表（哪怕主人有 owner 角色也一样）
        expect(mine).not.toContain("friend-secret-task");
        expect(hers).not.toContain("owner-only-task");
    });

    it("同名 taskId 在两人空间里互不干扰（内容与标题各自独立）", () => {
        const same = "daily-report";
        workspace.ensureTask(OWNER, same, { title: "主人的日报" });
        workspace.ensureTask(FRIEND, same, { title: "朋友的日报" });
        workspace.writeFile(OWNER, same, "r.md", "主人写的");
        workspace.writeFile(FRIEND, same, "r.md", "朋友写的");

        expect(workspace.taskDir(OWNER, same)).not.toBe(workspace.taskDir(FRIEND, same));
        expect(workspace.readTaskMeta(OWNER, same).title).toBe("主人的日报");
        expect(workspace.readTaskMeta(FRIEND, same).title).toBe("朋友的日报");
        expect(workspace.readFile(OWNER, same, "r.md")).toBe("主人写的");
        expect(workspace.readFile(FRIEND, same, "r.md")).toBe("朋友写的");
    });

    it("用 A 的 owner 读 B 的任务文件 → 报错", () => {
        // 朋友的目录在 <root>/<friend>/ 下，主人的 <root>/<owner>/ 根本没有这个任务，
        // 所以文件不存在；更要紧的是它**不可能**顺着路径读到对面去。
        expect(() => workspace.readFile(OWNER, "friend-secret-task", "note.md")).toThrow();
        expect(() => workspace.readFile(FRIEND, "owner-only-task", "note.md")).toThrow();
        // 连「列一下这个目录」都不该成功：主人的空间里压根没有这个任务文件夹
        expect(() => workspace.listFiles(OWNER, "friend-secret-task")).toThrow();
    });

    it("朋友那边确实能读到自己的那份（证明上面的报错是隔离而不是文件没写）", () => {
        // 反证：同一个 taskId、同一个相对路径，换 owner 就成功。
        // 少了这条，上面的 toThrow 可能只是「文件本来就不存在」而误判通过。
        expect(workspace.readFile(FRIEND, "friend-secret-task", "note.md")).toBe("朋友的秘密产出");
        expect(workspace.readFile(OWNER, "owner-only-task", "note.md")).toBe("主人的产出");
    });

    it("listOwners 能看出有两个人的空间（只给管理视角用）", () => {
        const owners = workspace.listOwners().map((o) => o.owner).sort();
        expect(owners).toContain(OWNER);
        expect(owners).toContain(FRIEND);
        const friend = workspace.listOwners().find((o) => o.owner === FRIEND);
        expect(friend?.tasks).toBeGreaterThan(0);
    });

    it("overview 只统计自己那层，绝不汇总别人", () => {
        const mine = workspace.overview(OWNER);
        const hers = workspace.overview(FRIEND);
        expect(mine.root).not.toBe(hers.root);
        expect(mine.tasks).toBe(workspace.listTasks(OWNER).length);
        expect(hers.tasks).toBe(workspace.listTasks(FRIEND).length);
        // 朋友那层的文件数不该出现在主人的概览里
        expect(mine.files).toBe(mine.list.reduce((n, t) => n + t.files, 0));
        expect(hers.files).toBe(hers.list.reduce((n, t) => n + t.files, 0));
    });

    it("pruneAll 带 owner 时只清那一个，不带才清全部", () => {
        const mine = "prune-scope-mine";
        const hers = "prune-scope-hers";
        workspace.ensureTask(OWNER, mine, { title: "我的过期任务" });
        workspace.ensureTask(FRIEND, hers, { title: "她的过期任务" });
        workspace.writeFile(OWNER, mine, "old.txt", "x".repeat(20));
        workspace.writeFile(FRIEND, hers, "old.txt", "x".repeat(20));

        // 先只清朋友的：主人那份必须原封不动。
        // 用 keepBytes=1 触发清理 —— keepFiles/keepDays 为 0 在实现里表示「这条不启用」，
        // 不是「留 0 个」，写 0 什么都不会删（跟核心版同语义）。
        const r = workspace.pruneAll(FRIEND, { keepFiles: 0, keepDays: 0, keepBytes: 1 });
        expect(r.deleted).toBeGreaterThan(0);
        expect(workspace.listFiles(FRIEND, hers).length).toBe(0);
        expect(workspace.listFiles(OWNER, mine).some((e) => e.name === "old.txt")).toBe(true);

        // 不带 owner = 清全部
        workspace.pruneAll(null, { keepFiles: 0, keepDays: 0, keepBytes: 1 });
        expect(workspace.listFiles(OWNER, mine).length).toBe(0);
    });

    it("removeTask 只删自己那一个（同名任务对面还在）", () => {
        const same = "shared-name-remove";
        workspace.ensureTask(OWNER, same, { title: "我的" });
        workspace.ensureTask(FRIEND, same, { title: "她的" });
        expect(workspace.removeTask(OWNER, same).removed).toBe(true);
        expect(fs.existsSync(workspace.taskDir(FRIEND, same))).toBe(true);
        expect(workspace.listTasks(FRIEND).some((t) => t.taskId === same)).toBe(true);
    });
});

describe("owner 解析规则（resolveOwnerFromCtx，顺序不可反）", () => {
    it("显式 counterpartId / senderId 优先", () => {
        expect(workspace.resolveOwnerFromCtx({ counterpartId: "1658359753" })).toBe("1658359753");
        expect(workspace.resolveOwnerFromCtx({ senderId: "1980308740" })).toBe("1980308740");
        // 两者都给时 counterpartId 更具体
        expect(
            workspace.resolveOwnerFromCtx({ counterpartId: "1658359753", senderId: "1980308740" }),
        ).toBe("1658359753");
        // 平台会话也照样以显式字段为准
        expect(
            workspace.resolveOwnerFromCtx({ sessionId: "bot-x-private:1:2", counterpartId: "777" }),
        ).toBe("777");
    });

    it("bot- 平台会话从 sessionId 拆对话者（与记忆池同一套解析）", () => {
        expect(workspace.resolveOwnerFromCtx({ sessionId: "bot-qq-private:1658359753" }))
            .toBe("1658359753");
        // 群聊里也取消息发送者（最后一段），不是群号
        expect(workspace.resolveOwnerFromCtx({ sessionId: "bot-qq-group:12345:1658359753" }))
            .toBe("1658359753");
    });

    it("uuid 本地会话 / 空 ctx 落到 _local（不能把 sessionId 当 owner）", () => {
        // 这条最关键：推不出来就当 counterpartId 用，会让每台桌宠建出一堆
        // 以会话 uuid 命名的 owner 目录。
        const uuid = "8f14e45f-ceea-467a-9f7d-12c3b4a5d6e7";
        expect(workspace.resolveOwnerFromCtx({ sessionId: uuid })).toBe("_local");
        expect(workspace.resolveOwnerFromCtx({})).toBe("_local");
        expect(workspace.resolveOwnerFromCtx()).toBe("_local");
        expect(workspace.resolveOwnerFromCtx({ sessionId: "console" })).toBe("_local");
    });

    it("解析结果一定能当目录名用（再解析一次不抛）", () => {
        for (const ctx of [{}, { sessionId: "bot-qq-private:777" }, { senderId: "888" }]) {
            expect(() => workspace.ownerDirName(workspace.resolveOwnerFromCtx(ctx))).not.toThrow();
        }
    });
});

describe("定期任务：时间计算", () => {
    // 用本地时间构造基准：2026-11-19 是周四
    const base = new Date(2026, 10, 19, 10, 0, 0).getTime();

    it("daily：时刻已过顺延到明天，未到就是今天", async () => {
        const { computeDueAt } = await import("../capabilities/builtin/schedule_task");
        const d8 = new Date(computeDueAt({ repeat: "daily", hour: 8 }, base));
        expect(d8.getDate()).toBe(20);
        expect(d8.getHours()).toBe(8);

        const d22 = new Date(computeDueAt({ repeat: "daily", hour: 22 }, base));
        expect(d22.getDate()).toBe(19);
        expect(d22.getHours()).toBe(22);
    });

    it("weekly：按星期几算，当天时刻未到就取今天", async () => {
        const { computeDueAt } = await import("../capabilities/builtin/schedule_task");
        const mon = new Date(computeDueAt({ repeat: "weekly", weekday: 1, hour: 8 }, base));
        expect(mon.getDay()).toBe(1);
        expect(mon.getDate()).toBe(23);

        const thu = new Date(computeDueAt({ repeat: "weekly", weekday: 4, hour: 12 }, base));
        expect(thu.getDay()).toBe(4);
        expect(thu.getDate()).toBe(19);
    });

    it("monthly：已过顺延到下月同日", async () => {
        const { computeDueAt } = await import("../capabilities/builtin/schedule_task");
        const m1 = new Date(computeDueAt({ repeat: "monthly", day: 1, hour: 8 }, base));
        expect(m1.getMonth()).toBe(11);
        expect(m1.getDate()).toBe(1);
    });

    it("weekly 触发后顺延 7 天，daily 交给共享包（返回 null）", async () => {
        const { nextDueAtAfterFire } = await import("../capabilities/builtin/schedule_task");
        expect(nextDueAtAfterFire({ repeat: "weekly" }, base)).toBe(base + 7 * 86400000);
        expect(nextDueAtAfterFire({ repeat: "daily" }, base)).toBeNull();
    });
});

describe("payload 与会话前缀", () => {
    it("payload 往返保留周期字段", () => {
        const raw = workspaceTask.buildPayload({
            owner: OWNER,
            taskId: "abc",
            instruction: "做点事",
            repeat: "weekly",
            hour: 9,
            minute: 30,
            weekday: 3,
        });
        const p = workspaceTask.parsePayload(raw);
        expect(p?.repeat).toBe("weekly");
        expect(p?.weekday).toBe(3);
        expect(p?.hour).toBe(9);
    });

    it("payload 往返保留 owner（调度器到点时唯一能拿到归属的来源）", () => {
        const raw = workspaceTask.buildPayload({ owner: OWNER, taskId: "abc", instruction: "x" });
        expect(workspaceTask.parsePayload(raw)?.owner).toBe(OWNER);
    });

    it("坏 payload 返回 null 而不抛", () => {
        expect(workspaceTask.parsePayload("{{{")).toBeNull();
        expect(workspaceTask.parsePayload("")).toBeNull();
    });

    it("会话 id 带上 owner，且能原样拆回来", () => {
        // 不带 owner 的话，主机只知道「要跑 taskId=X」，不知道 X 是谁的。
        expect(workspaceTask.sessionIdFor(OWNER, "abc")).toBe(`workspace:${OWNER}:abc`);
        expect(workspaceTask.isWorkspaceSession(`workspace:${OWNER}:abc`)).toBe(true);
        expect(workspaceTask.parseSessionId(`workspace:${OWNER}:abc`)).toEqual({
            owner: OWNER,
            taskId: "abc",
        });
        expect(workspaceTask.taskIdFromSession(`workspace:${OWNER}:abc`)).toBe("abc");
        expect(workspaceTask.ownerFromSession(`workspace:${OWNER}:abc`)).toBe(OWNER);
        // 普通群会话不能被误判成任务
        expect(workspaceTask.isWorkspaceSession("bot-x-group:1:2")).toBe(false);
    });

    it("老格式 workspace:<taskId> 仍能认（owner 为空，交给调用方兜底）", () => {
        expect(workspaceTask.parseSessionId("workspace:legacy-abc")).toEqual({
            owner: "",
            taskId: "legacy-abc",
        });
        expect(workspaceTask.taskIdFromSession("workspace:legacy-abc")).toBe("legacy-abc");
    });
});

describe("指令拼装（定期任务相对一次性的价值）", () => {
    it("要求里必须包含：固定 taskId、日期、先读上次、不许提问", () => {
        const s = workspaceTask.buildInstruction(
            { taskId: "daily-1", title: "每日简报", instruction: "整理科技新闻" },
            "2026-11-19",
        );
        // 1) 固定 taskId —— 否则她会新建文件夹，产出散成好几处
        expect(s).toContain("daily-1");
        // 2) 日期进文件名 —— 否则每天覆盖同一个文件，留不住数据
        expect(s).toContain("2026-11-19");
        // 3) 先读上次 —— 这是「定期」相对「一次性」的唯一增量价值
        expect(s).toMatch(/ls|read/);
        // 4) 不许反问 —— 没人在场，问了也没人答
        expect(s).toMatch(/不要提问|不要等确认/);
    });

    it("带上 owner 时指令里要说清写到谁的目录", () => {
        const s = workspaceTask.buildInstruction(
            { taskId: "daily-1", title: "每日简报", instruction: "整理科技新闻", owner: FRIEND },
            "2026-11-19",
        );
        expect(s).toContain(FRIEND);
    });
});

describe("叶子节点：任务转发给主机", () => {
    it("叶子角色时上行给主机且不本地跑模型，sessionId 带 owner", async () => {
        const up: Array<{ sessionId: string; content: string }> = [];
        let localRuns = 0;

        workspaceTask.setRoleProbe(() => "leaf");
        workspaceTask.setRelaySender(async ({ sessionId, content }) => {
            up.push({ sessionId, content });
            return { speech: "主机说：已写入 2026-11-19.md" };
        });
        workspaceTask.setTaskRunner(async () => {
            localRuns += 1;
            return { ok: true, speech: "LOCAL" };
        });
        workspaceTask.setPlatformSender(() => true);

        const fired = await workspaceTask.fire({
            jobId: `wstask:${OWNER}:leaf-test`,
            uid: 1,
            title: "转发测试",
            payload: workspaceTask.buildPayload({
                owner: OWNER,
                taskId: "leaf-test",
                instruction: "写条产出",
            }),
        });

        expect(fired).toBe(true);
        // 两个断言必须同时成立：只查「转发了」会漏掉「转发之后又本地跑一遍」的双跑 bug
        expect(up.length).toBe(1);
        expect(localRuns).toBe(0);
        // 主机靠这段 sessionId 才知道是谁的任务
        expect(up[0].sessionId).toBe(`workspace:${OWNER}:leaf-test`);
        // 上行的是 JSON 载荷，主机要按自己的日期与最新标题重建指令
        expect(workspaceTask.parsePayload(up[0].content)?.taskId).toBe("leaf-test");
        expect(workspaceTask.parsePayload(up[0].content)?.owner).toBe(OWNER);

        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
        workspaceTask.setPlatformSender(null);
    });

    it("主机不可达时：不本地跑、不记运行次数、job 仍顺延", async () => {
        let localRuns = 0;
        workspaceTask.setRoleProbe(() => "leaf");
        workspaceTask.setRelaySender(async () => null);
        workspaceTask.setTaskRunner(async () => {
            localRuns += 1;
            return { ok: true };
        });

        const taskId = "leaf-fail-test";
        workspace.ensureTask(OWNER, taskId, { title: "上行失败" });
        const before = workspace.readTaskMeta(OWNER, taskId).runCount;

        const fired = await workspaceTask.fire({
            jobId: `wstask:${OWNER}:${taskId}`,
            uid: 1,
            title: "上行失败",
            payload: workspaceTask.buildPayload({ owner: OWNER, taskId, instruction: "做点事" }),
        });

        // 返回 true 是必须的：否则 job 卡在 pending，每 15s 重试一次打向连不上的主机
        expect(fired).toBe(true);
        expect(localRuns).toBe(0);
        // 关键：meta 不能声称跑过一次实际没发生的事
        expect(workspace.readTaskMeta(OWNER, taskId).runCount).toBe(before);

        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
    });

    it("组网未启用（roleProbe 返回 null）时按本机执行", async () => {
        let localRuns = 0;
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setRelaySender(async () => {
            throw new Error("组网没开时不该走上行");
        });
        workspaceTask.setTaskRunner(async () => {
            localRuns += 1;
            return { ok: true, speech: "本机跑完了" };
        });

        const taskId = "solo-test";
        workspace.ensureTask(OWNER, taskId, { title: "单机" });
        const fired = await workspaceTask.fire({
            jobId: `wstask:${OWNER}:${taskId}`,
            uid: 1,
            title: "单机",
            payload: workspaceTask.buildPayload({ owner: OWNER, taskId, instruction: "做点事" }),
        });

        expect(fired).toBe(true);
        expect(localRuns).toBe(1);
        // 跑成了就要记账
        expect(workspace.readTaskMeta(OWNER, taskId).runCount).toBe(1);

        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
        workspaceTask.setTaskRunner(null);
    });

    it("payload 坏掉也不让 job 卡住", async () => {
        const fired = await workspaceTask.fire({
            jobId: "wstask:bad",
            uid: 1,
            title: "坏数据",
            payload: "{{{",
        });
        expect(fired).toBe(true);
    });

    it("空 title 不会清空已有 meta 标题（主机代叶子执行时传的就是空串）", async () => {
        // 上行 payload 里不带 title：主机要按自己 meta.json 的标题来，
        // 传空串如果被当成「改成空」，每次叶子任务跑完标题都会被抹成 taskId。
        workspaceTask.setTaskRunner(async () => ({ ok: true }));
        const taskId = "empty-title-test";
        workspace.ensureTask(OWNER, taskId, { title: "用户设的标题" });

        await workspaceTask.runLocally({
            owner: OWNER,
            taskId,
            title: "",
            instruction: "主机代跑",
            deliver: false,
        });

        expect(workspace.readTaskMeta(OWNER, taskId).title).toBe("用户设的标题");
        workspaceTask.setTaskRunner(null);
    });
});

describe("任务结果推送", () => {
    it("本机跑完把结果推给用户，且带上是哪个 owner 的", async () => {
        const pushed: Array<{ speech: string; taskId: string; owner: string }> = [];
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setResultPusher(({ speech, taskId, owner }) => {
            pushed.push({ speech, taskId, owner });
            return true; // 「送到了」
        });
        workspaceTask.setTaskRunner(async () => ({ ok: true, speech: "今天的简报写好了" }));

        const taskId = "push-test";
        workspace.ensureTask(OWNER, taskId, { title: "推送测试" });
        await workspaceTask.fire({
            jobId: `wstask:${OWNER}:${taskId}`,
            uid: 1,
            title: "推送测试",
            payload: workspaceTask.buildPayload({ owner: OWNER, taskId, instruction: "做点事" }),
        });

        expect(pushed.length).toBe(1);
        expect(pushed[0].speech).toContain("简报");
        expect(pushed[0].taskId).toBe(taskId);
        // 推送要能落到正确的人：只说「跑完了」而不知道是谁的，等于没区分
        expect(pushed[0].owner).toBe(OWNER);

        workspaceTask.setResultPusher(null);
        workspaceTask.setTaskRunner(null);
    });

    it("老 job 没有 payload.owner 时落到 _legacy，绝不回退成公共目录", async () => {
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setTaskRunner(async () => ({ ok: true }));
        const taskId = "legacy-owner-test";
        workspaceTask.setResultPusher(() => true);

        await workspaceTask.fire({
            jobId: `wstask:${taskId}`,
            uid: 1,
            title: "老任务",
            // 故意不给 owner：模拟 2026-11-19 那批 payload
            payload: JSON.stringify({ taskId, instruction: "老格式" }),
        });

        // 落到 _legacy/ 而不是根目录（根目录 = 所有历史任务重新混在一起）
        expect(fs.existsSync(path.join(path.resolve(tmpWs), workspaceTask.LEGACY_OWNER, taskId)))
            .toBe(true);
        expect(fs.existsSync(path.join(path.resolve(tmpWs), taskId))).toBe(false);

        workspaceTask.setResultPusher(null);
        workspaceTask.setTaskRunner(null);
    });
});
