// electron/ai/services/workspace.spec.ts
// 工作空间 + 定期任务（desktop 端）。
//
// 用户 2026-11-19 原话：
//   「我想给他加入工作空间的概念，这个，注意，从机（叶子节点）的任务依旧转发给
//     主机完成。这样它可以执行一些定期的自动化任务，并且保留一定量的数据。
//     这个空间文件夹是一个独立的文件夹，放在用户目录下，下面再分为不同的任务
//     所属的文件夹」
//
// 这里验四件事：
//   1) 目录形态：一个任务一个文件夹，改名不搬文件夹
//   2) 路径隔离：她拿到完整删除权限，越权就必须拒（这是最要紧的一节）
//   3) 保留策略：留一定量的数据，但不能无限长
//   4) 叶子转发：任务上行给主机，且叶子不本地跑（用户强调的那一点）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 必须在 import 被测模块之前设好环境变量：resolveRoot() 读的是 process.env。
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-ws-spec-"));
process.env.KIRARI_WORKSPACE = tmpWs;

import * as workspace from "./workspace";
import * as workspaceTask from "./workspaceTask";

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

    it("一个任务一个文件夹，meta.json 记标题", () => {
        const t = workspace.ensureTask("daily-news-abc123", { title: "每日科技简报" });
        expect(fs.existsSync(t.dir)).toBe(true);
        expect(fs.existsSync(path.join(t.dir, workspace.TASK_META_FILE))).toBe(true);
        expect(workspace.readTaskMeta("daily-news-abc123").title).toBe("每日科技简报");
    });

    it("改标题不搬文件夹（按 id 命名的核心承诺）", () => {
        const before = workspace.taskDir("daily-news-abc123");
        workspace.ensureTask("daily-news-abc123", { title: "改过的标题" });
        expect(workspace.taskDir("daily-news-abc123")).toBe(before);
        expect(fs.existsSync(before)).toBe(true);
        expect(workspace.readTaskMeta("daily-news-abc123").title).toBe("改过的标题");
    });
});

describe("路径隔离（她拿到完整删除权限，这节最要紧）", () => {
    const taskId = "isolation-test";

    beforeAll(() => {
        workspace.ensureTask(taskId, { title: "越权测试" });
    });

    it("拒绝 .. 上跳", () => {
        expect(() => workspace.resolveInTask(taskId, "../escape")).toThrow();
        expect(() => workspace.resolveInTask(taskId, "a/../../b")).toThrow();
    });

    it("拒绝绝对路径与盘符", () => {
        expect(() => workspace.resolveInTask(taskId, "/etc/passwd")).toThrow();
        expect(() => workspace.resolveInTask(taskId, "C:/x")).toThrow();
        expect(() => workspace.resolveInTask(taskId, "D:\\x")).toThrow();
    });

    it("拒绝 UNC 路径", () => {
        expect(() => workspace.resolveInTask(taskId, "\\\\server\\share")).toThrow();
    });

    it("拒绝非法 taskId", () => {
        expect(() => workspace.taskDir("..")).toThrow();
        expect(() => workspace.taskDir("a/b")).toThrow();
        expect(() => workspace.taskDir("a\\b")).toThrow();
        expect(() => workspace.taskDir("")).toThrow();
    });

    it("拒绝 Windows 保留设备名与结尾点号", () => {
        expect(() => workspace.taskDir("con")).toThrow();
        expect(() => workspace.taskDir("abc.")).toThrow();
    });

    it("拒绝两端带空格（而不是悄悄 trim）", () => {
        // trim 会让「写进去的名字」和「调用方以为的名字」不一致，
        // 之后按原名读回来就是 404 —— 所以宁可直接拒。
        expect(() => workspace.taskDir("abc ")).toThrow();
        expect(() => workspace.taskDir(" abc")).toThrow();
    });

    it("拒绝控制字符和 Windows 非法字符", () => {
        expect(() => workspace.resolveInTask(taskId, "a\u0000b.txt")).toThrow();
        expect(() => workspace.resolveInTask(taskId, "a:b.txt")).toThrow();
    });

    it("越权失败后确实没在空间外面留下东西", () => {
        expect(fs.existsSync(path.join(tmpWs, "..", "escape"))).toBe(false);
    });
});

describe("文件读写与删除", () => {
    const taskId = "files-test";

    beforeAll(() => {
        workspace.ensureTask(taskId, { title: "文件测试" });
    });

    it("写入自动建父目录，读回来一致", () => {
        workspace.writeFile(taskId, "notes/2026-11-19.md", "# 今天\n有内容");
        expect(fs.existsSync(path.join(workspace.taskDir(taskId), "notes"))).toBe(true);
        expect(workspace.readFile(taskId, "notes/2026-11-19.md")).toContain("有内容");
    });

    it("列目录藏掉 meta.json，但不误伤子目录里同名的用户文件", () => {
        workspace.writeFile(taskId, "sub/meta.json", '{"mine":true}');
        const root = workspace.listFiles(taskId);
        expect(root.some((e) => e.name === workspace.TASK_META_FILE)).toBe(false);
        const sub = workspace.listFiles(taskId, "sub");
        expect(sub.some((e) => e.name === "meta.json")).toBe(true);
    });

    it("删文件、删空目录；非空目录要拒", () => {
        workspace.writeFile(taskId, "tmp/a.txt", "x");
        expect(workspace.remove(taskId, "tmp/a.txt").removed).toBe(true);
        expect(workspace.remove(taskId, "tmp").removed).toBe(true);

        workspace.writeFile(taskId, "full/b.txt", "x");
        expect(() => workspace.remove(taskId, "full")).toThrow();
    });

    it("不能删整个任务文件夹（要删走 removeTask）", () => {
        expect(() => workspace.remove(taskId, "")).toThrow();
    });

    it("读超大文件要拒（否则会把上下文炸掉）", () => {
        const big = "x".repeat(workspace.LIMITS.readBytes + 10);
        workspace.writeFile(taskId, "big.txt", big);
        expect(() => workspace.readFile(taskId, "big.txt")).toThrow(/太大/);
    });
});

describe("保留策略", () => {
    it("按数量清理最旧的，meta.json 永不删", () => {
        const taskId = "prune-test";
        const t = workspace.ensureTask(taskId, { title: "清理测试" });
        for (let i = 0; i < 5; i++) {
            workspace.writeFile(taskId, `f${i}.txt`, "x".repeat(10));
            const p = path.join(t.dir, `f${i}.txt`);
            const ts = Date.now() - (5 - i) * 60000; // 拉开 mtime，排序才稳
            fs.utimesSync(p, new Date(ts), new Date(ts));
        }
        const r = workspace.pruneTask(taskId, { keepFiles: 2, keepDays: 0, keepBytes: 0 });
        expect(r.deleted).toBe(3);
        expect(workspace.listFiles(taskId).length).toBe(2);
        expect(fs.existsSync(path.join(t.dir, workspace.TASK_META_FILE))).toBe(true);
    });

    it("按天数清理超龄文件", () => {
        const taskId = "prune-days";
        const t = workspace.ensureTask(taskId, { title: "超龄测试" });
        workspace.writeFile(taskId, "old.txt", "x");
        const p = path.join(t.dir, "old.txt");
        const old = Date.now() - 60 * 86400000; // 60 天前
        fs.utimesSync(p, new Date(old), new Date(old));
        workspace.writeFile(taskId, "new.txt", "x");
        const r = workspace.pruneTask(taskId, { keepDays: 30, keepFiles: 0, keepBytes: 0 });
        expect(r.deleted).toBe(1);
        expect(workspace.listFiles(taskId).some((e) => e.name === "new.txt")).toBe(true);
    });
});

describe("概览与记账", () => {
    it("recordRun 累加运行次数并记时间", () => {
        const taskId = "rec-test";
        workspace.ensureTask(taskId, { title: "记账测试" });
        workspace.recordRun(taskId);
        workspace.recordRun(taskId);
        const meta = workspace.readTaskMeta(taskId);
        expect(meta.runCount).toBe(2);
        expect(meta.lastRunAt).toBeTruthy();
    });

    it("overview 统计任务数与文件数", () => {
        const o = workspace.overview();
        expect(o.root).toBe(path.resolve(tmpWs));
        expect(o.tasks).toBeGreaterThan(0);
        expect(Array.isArray(o.list)).toBe(true);
    });

    it("列表按最近运行排序（跑过的在前）", () => {
        const list = workspace.listTasks();
        const rec = list.find((t) => t.taskId === "rec-test");
        expect(rec).toBeTruthy();
        expect(list[0].lastRunMs).toBeGreaterThanOrEqual(list[list.length - 1].lastRunMs);
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

    it("坏 payload 返回 null 而不抛", () => {
        expect(workspaceTask.parsePayload("{{{")).toBeNull();
        expect(workspaceTask.parsePayload("")).toBeNull();
    });

    it("会话前缀是主机识别任务的关键", () => {
        expect(workspaceTask.sessionIdFor("abc")).toBe("workspace:abc");
        expect(workspaceTask.isWorkspaceSession("workspace:abc")).toBe(true);
        // 普通群会话不能被误判成任务
        expect(workspaceTask.isWorkspaceSession("bot-x-group:1:2")).toBe(false);
        expect(workspaceTask.taskIdFromSession("workspace:abc")).toBe("abc");
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
});

describe("叶子节点：任务转发给主机", () => {
    it("叶子角色时上行给主机且不本地跑模型", async () => {
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

        const fired = await workspaceTask.fire({
            jobId: "wstask:leaf-test",
            uid: 1,
            title: "转发测试",
            payload: workspaceTask.buildPayload({ taskId: "leaf-test", instruction: "写条产出" }),
            dueAt: Date.now(),
        });

        expect(fired).toBe(true);
        // 两个断言必须同时成立：只查「转发了」会漏掉「转发之后又本地跑一遍」的双跑 bug
        expect(up.length).toBe(1);
        expect(localRuns).toBe(0);
        expect(up[0].sessionId).toBe("workspace:leaf-test");
        // 上行的是 JSON 载荷，主机要按自己的日期与最新标题重建指令
        expect(workspaceTask.parsePayload(up[0].content)?.taskId).toBe("leaf-test");

        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
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
        workspace.ensureTask(taskId, { title: "上行失败" });
        const before = workspace.readTaskMeta(taskId).runCount;

        const fired = await workspaceTask.fire({
            jobId: `wstask:${taskId}`,
            uid: 1,
            title: "上行失败",
            payload: workspaceTask.buildPayload({ taskId, instruction: "做点事" }),
            dueAt: Date.now(),
        });

        // 返回 true 是必须的：否则 job 卡在 pending，每 15s 重试一次打向连不上的主机
        expect(fired).toBe(true);
        expect(localRuns).toBe(0);
        // 关键：meta 不能声称跑过一次实际没发生的事
        expect(workspace.readTaskMeta(taskId).runCount).toBe(before);

        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
    });

    it("组网未启用（roleProbe 返回 null）时按本机执行", async () => {        let localRuns = 0;
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setRelaySender(async () => {
            throw new Error("组网没开时不该走上行");
        });
        workspaceTask.setTaskRunner(async () => {
            localRuns += 1;
            return { ok: true, speech: "本机跑完了" };
        });

        const taskId = "solo-test";
        workspace.ensureTask(taskId, { title: "单机" });
        const fired = await workspaceTask.fire({
            jobId: `wstask:${taskId}`,
            uid: 1,
            title: "单机",
            payload: workspaceTask.buildPayload({ taskId, instruction: "做点事" }),
            dueAt: Date.now(),
        });

        expect(fired).toBe(true);
        expect(localRuns).toBe(1);
        // 跑成了就要记账
        expect(workspace.readTaskMeta(taskId).runCount).toBe(1);

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
            dueAt: Date.now(),
        });
        expect(fired).toBe(true);
    });

    it("空 title 不会清空已有 meta 标题（主机代叶子执行时传的就是空串）", async () => {
        // 上行 payload 里不带 title：主机要按自己 meta.json 的标题来，
        // 传空串如果被当成「改成空」，每次叶子任务跑完标题都会被抹成 taskId。
        workspaceTask.setTaskRunner(async () => ({ ok: true }));
        const taskId = "empty-title-test";
        workspace.ensureTask(taskId, { title: "用户设的标题" });

        await workspaceTask.runLocally({ taskId, title: "", instruction: "主机代跑", deliver: false });

        expect(workspace.readTaskMeta(taskId).title).toBe("用户设的标题");
        workspaceTask.setTaskRunner(null);
    });
});

describe("任务结果推送", () => {
    it("本机跑完把结果推给用户", async () => {
        const pushed: Array<{ speech: string; taskId: string }> = [];
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setResultPusher(({ speech, taskId }) => {
            pushed.push({ speech, taskId });
        });
        workspaceTask.setTaskRunner(async () => ({ ok: true, speech: "今天的简报写好了" }));

        const taskId = "push-test";
        workspace.ensureTask(taskId, { title: "推送测试" });
        await workspaceTask.fire({
            jobId: `wstask:${taskId}`,
            uid: 1,
            title: "推送测试",
            payload: workspaceTask.buildPayload({ taskId, instruction: "做点事" }),
            dueAt: Date.now(),
        });

        expect(pushed.length).toBe(1);
        expect(pushed[0].speech).toContain("简报");
        expect(pushed[0].taskId).toBe(taskId);

        workspaceTask.setResultPusher(null);
        workspaceTask.setTaskRunner(null);
    });
});
