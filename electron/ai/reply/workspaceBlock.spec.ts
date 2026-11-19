// @vitest-environment node
// electron/ai/reply/workspaceBlock + services/scheduledJobsService 的隔离/送达回归。
//
// 这个文件专门盯 2026-11-20 用户报的两个 bug —— 它们的共同点是「代码不报错，
// 但行为是错的」，只有断言能挡住回退：
//
//   bug 1「我怎么可以直接看到她的任务呢」
//     → 提示词注入块必须只报**当前这个人**的任务。这条最要紧：能从提示词里看到
//       别人的任务名，比她自己调工具看到还糟 —— 那是「不用问就知道」，连确认的机会都没有。
//     → workspace 能力的 others 动作必须两步：不带 confirm 只报人数，带 confirm 才列内容。
//     → 非 owner 角色连「还有别人」都不能说。
//
//   bug 2「到了7点也没提醒我」
//     → 提醒/任务结果必须两条腿（桌面 + 平台），都失败时要 warn 而不是静默。
//
// 与核心版 src/services/reply/workspaceBlock.js / src/services/scheduledJobsService.js 对称。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// resolveRoot() 读 process.env.KIRARI_WORKSPACE，必须在 import 被测模块之前设好。
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-wsblock-spec-"));
process.env.KIRARI_WORKSPACE = tmpWs;

import * as workspace from "../services/workspace";
import * as workspaceTask from "../services/workspaceTask";
import { buildWorkspaceBlock, resolveOwnerForBlock, MAX_TASKS_IN_PROMPT } from "./workspaceBlock";
import * as workspaceCap from "../capabilities/builtin/workspace";
import * as scheduledJobsService from "../services/scheduledJobsService";
import { vagueGist } from "../services/memory";
import type { ScheduledJob } from "kirari-agent";

/** 两个人。用真实 QQ 号形态，顺便验证纯数字不会被 safeSegment 拦。 */
const OWNER = "1658359753";
const FRIEND = "1980308740";

beforeAll(() => {
    // 主人一个任务、朋友一个任务，且**两个任务的标题都很有辨识度**，
    // 这样断言「块里出现谁的标题」才有意义。
    workspace.ensureTask(OWNER, "owner-daily", { title: "主人的每日简报" });
    workspace.writeFile(OWNER, "owner-daily", "2026-11-20.md", "主人自己的东西");
    workspace.ensureTask(FRIEND, "friend-daily", { title: "朋友的旅行计划" });
    workspace.writeFile(FRIEND, "friend-daily", "2026-11-20.md", "朋友自己的东西");
});

afterAll(() => {
    try {
        fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        /* Windows 上偶尔删不掉，不影响测试结论 */
    }
});

describe("提示词注入块 · 只报当前这个人的任务", () => {
    it("朋友说话时，块里绝不出现主人的任务（用户报障的回归点）", () => {
        const block = buildWorkspaceBlock({ counterpartId: FRIEND });
        // 正面：自己的要有
        expect(block).toContain("朋友的旅行计划");
        // 反面（关键）：别人的一个字都不能漏
        expect(block).not.toContain("主人的每日简报");
        expect(block).not.toContain(OWNER);
        // 路径也必须是他自己那层
        expect(block).toContain(workspace.ownerRoot(FRIEND));
        expect(block).not.toContain(workspace.ownerRoot(OWNER));
    });

    it("主人说话时同样只看到自己的 —— 权限不改变「默认只看自己」", () => {
        const block = buildWorkspaceBlock({ counterpartId: OWNER });
        expect(block).toContain("主人的每日简报");
        expect(block).not.toContain("朋友的旅行计划");
        expect(block).not.toContain(FRIEND);
    });

    it("块里必须写明「按人分开、要看别人得先问」——这是行为的唯一依据", () => {
        const block = buildWorkspaceBlock({ counterpartId: FRIEND });
        // 模型不知道这条规则，就会照实回答「我有两个任务」，等于泄露
        expect(block).toContain("按人分开");
        expect(block).toMatch(/别人的任务你看不到/);
        expect(block).toMatch(/先问|明确同意/);
        // 而且要说清工具入口，否则它知道规则却不知道该做什么
        expect(block).toContain("others");
    });

    it("本机/控制台会话（无对话者）落到 _local，不是拿 sessionId 当目录名", () => {
        expect(resolveOwnerForBlock({})).toBe(workspace.LOCAL_OWNER);
        expect(resolveOwnerForBlock({ sessionId: "session_1732000000000" })).toBe(workspace.LOCAL_OWNER);
        // 用这个 owner 生成块不能抛（_local 目录还不存在也要能出块）
        expect(() => buildWorkspaceBlock({ sessionId: "session_1732000000000" })).not.toThrow();
    });

    it("最多只列 MAX_TASKS_IN_PROMPT 个，多出来的只说总数（别挤爆上下文）", () => {
        const many = "1658359799";
        for (let i = 0; i < MAX_TASKS_IN_PROMPT + 3; i++) {
            workspace.ensureTask(many, `bulk-${i}`, { title: `批量任务 ${i}` });
        }
        const block = buildWorkspaceBlock({ counterpartId: many });
        const listed = block.split("\n").filter((l) => l.trim().startsWith("· bulk-")).length;
        expect(listed).toBe(MAX_TASKS_IN_PROMPT);
        expect(block).toMatch(/另有 3 个未列出/);
    });
});

describe("workspace 能力 · others 两步确认", () => {
    it("非 owner 角色：连「还有别人」都不说（那本身就是别人的信息）", async () => {
        const out = await workspaceCap.dispatch({ action: "others" }, { counterpartId: FRIEND, role: "user" });
        expect(out).toContain("只有你自己的任务");
        // 关键：不能透露有几个别人、更不能出现别人的名字
        expect(out).not.toContain(OWNER);
        expect(out).not.toContain("主人的每日简报");
    });

    it("owner 不带 confirm：只报「你自己有几个 + 还有几个人」，不列任何任务名", async () => {
        const out = await workspaceCap.dispatch({ action: "others" }, { counterpartId: OWNER, role: "owner" });
        // 先说自己，再说别人 —— 用户原话：「优先说我有几个，然后再说可能还有别人的」
        expect(out).toContain("你自己有 1 个任务");
        // 别人的人数按实际状态算（本文件前一个用例会造出额外的 owner 目录），
        // 但「只报人数」这个性质是硬的。
        const othersCount = workspace.listOwners().filter((o) => o.owner !== OWNER).length;
        expect(othersCount).toBeGreaterThan(0);
        expect(out).toContain(`另外还有 ${othersCount} 个用户`);
        expect(out).toMatch(/要看他们的具体内容吗/);
        // 顺序：自己的结论必须排在「还有别人」之前
        expect(out.indexOf("你自己有")).toBeLessThan(out.indexOf("另外还有"));
        // 关键：这一步不能泄露任务名（只给 owner 名 + 任务数）
        expect(out).not.toContain("朋友的旅行计划");
        expect(out).not.toContain("主人的每日简报");
    });

    it("owner 带 confirm=true：才真的列出别人的任务", async () => {
        const out = await workspaceCap.dispatch(
            { action: "others", confirm: true },
            { counterpartId: OWNER, role: "owner" },
        );
        expect(out).toContain(FRIEND);
        expect(out).toContain("朋友的旅行计划");
    });

    it("owner 只看到别人的自己 —— 不该把自己的任务混进「别人」那栏", async () => {
        const out = await workspaceCap.dispatch(
            { action: "others", confirm: true },
            { counterpartId: OWNER, role: "owner" },
        );
        // 自己的任务名只出现在「你自己有 N 个任务」这句里，不该出现在【】分块里
        expect(out).not.toMatch(/【[^】]*】[^【]*主人的每日简报/);
    });

    it("owner 参数不可由模型传入：带 owner 字段也不会读到别人", async () => {
        // 这是隔离的根 —— 参数里根本没有 owner 这个入口，模型传了也无处生效
        const out = await workspaceCap.dispatch(
            { action: "tasks", owner: FRIEND },
            { counterpartId: OWNER, role: "owner" },
        );
        expect(out).toContain("主人的每日简报");
        expect(out).not.toContain("朋友的旅行计划");
    });
});

describe("提醒送达 · 两条腿 + 都失败要告警", () => {
    const makeJob = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
        jobId: "rem-test-1",
        sessionId: "session_1732000000000",
        origin: "desktop",
        uid: 1,
        kind: "reminder" as never,
        title: "喝水",
        payload: "该喝水啦",
        dueAt: Date.now() - 1000,
        recurrence: "once" as never,
        status: "pending" as never,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000,
        ...over,
    });

    afterEach(() => {
        scheduledJobsService.setDesktopDeliverer(null);
        scheduledJobsService.setPlatformDeliverer(null);
    });

    it("桌面腿送到就够了（本机纯 uuid 会话没有平台通道）", () => {
        const seen: string[] = [];
        scheduledJobsService.setDesktopDeliverer((job) => {
            seen.push(job.payload);
            return true;
        });
        expect(scheduledJobsService.deliverReminder(makeJob())).toBe(1);
        expect(seen).toEqual(["该喝水啦"]);
    });
    it("桌面没开（返回 false）+ 平台会话也没有 → 0，且要 warn 不再静默", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        scheduledJobsService.setDesktopDeliverer(() => false);
        scheduledJobsService.setPlatformDeliverer(() => false);
        expect(scheduledJobsService.deliverReminder(makeJob())).toBe(0);
        const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
        // 这条 warn 是「到点了没提醒我」还能被查出来的唯一线索
        expect(msgs).toContain("没有送达任何地方");
        expect(msgs).toContain("rem-test-1");
        warn.mockRestore();
    });

    it("桌面没开但能回发 QQ 会话 → 算送到了（用户在哪定的就在哪收到）", () => {
        const platform: Array<{ text: string; sessionId: string }> = [];
        scheduledJobsService.setDesktopDeliverer(() => false);
        scheduledJobsService.setPlatformDeliverer(({ text, sessionId }) => {
            platform.push({ text, sessionId });
            return true;
        });
        const job = makeJob({ sessionId: "bot-qq-private:1980308740" });
        expect(scheduledJobsService.deliverReminder(job)).toBe(1);
        expect(platform).toEqual([{ text: "该喝水啦", sessionId: "bot-qq-private:1980308740" }]);
    });

    it("两条腿都有就都走（各算一条通道）", () => {
        scheduledJobsService.setDesktopDeliverer(() => true);
        scheduledJobsService.setPlatformDeliverer(() => true);
        expect(scheduledJobsService.deliverReminder(makeJob({ sessionId: "bot-qq-private:1" }))).toBe(2);
    });

    it("空内容直接跳过，不去刷通道", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const desktop = vi.fn(() => true);
        scheduledJobsService.setDesktopDeliverer(desktop);
        expect(scheduledJobsService.deliverReminder(makeJob({ payload: "" }))).toBe(0);
        expect(desktop).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("某条腿抛异常不影响另一条腿", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        scheduledJobsService.setDesktopDeliverer(() => {
            throw new Error("界面还没起来");
        });
        scheduledJobsService.setPlatformDeliverer(() => true);
        // 桌面炸了，平台还是得发出去 —— 否则一个异常就把提醒整个吞了
        expect(scheduledJobsService.deliverReminder(makeJob({ sessionId: "bot-qq-private:1" }))).toBe(1);
        warn.mockRestore();
    });
});

// ── ★ 归属判定：这条提醒该不该在**主人的桌面**上开口 ──────────────────
//
// 用户澄清：「桌面端本就只有主人能连，这是我自己的桌宠，机器人是它的智能核心，
// 别人怎么可能连接我的机器人的大脑呢，让她和其他人对话也是建立在我的人际关系上」
//
// 所以这里防的**不是"别人的桌面"**（不存在），而是：她在 QQ 上同时跟很多人说话，
// 朋友的提醒到点该回 QQ 给朋友，不能顺手在主人自己的桌面上也弹一份 ——
// 那正是报障原话「她的任务怎么跑到我这儿来了」。
describe("★ 提醒归属：只有这台桌面的人自己的提醒才在桌面开口", () => {
    const OWNER = "1980308740";
    const FRIEND = "1658359753";
    const jobWith = (ownerKey: unknown) =>
        ({ jobId: "j1", payload: "该喝水啦", sessionId: "x", ownerKey }) as never;

    it("本机自建的提醒（_local）→ 收", () => {
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith("_local"), OWNER)).toBe(true);
    });

    it("没有归属字段的老任务 → 收（不因噎废食）", () => {
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith(undefined), OWNER)).toBe(true);
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith(""), OWNER)).toBe(true);
    });

    it("主人自己的提醒 → 收", () => {
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith(OWNER), OWNER)).toBe(true);
    });

    it("★ 朋友的提醒 → 不收（原来会弹在主人桌面上）", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith(FRIEND), OWNER)).toBe(false);
        expect(log.mock.calls.map((c) => String(c[0])).join("")).toContain("不是本机主人");
        log.mockRestore();
    });

    it("有归属但查不到本机主人 → fail-closed（宁可不说，不乱说）", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(scheduledJobsService.shouldSpeakOnDesktop(jobWith(FRIEND), null)).toBe(false);
        warn.mockRestore();
    });

    it("★ 朋友的提醒被挡后，平台那条腿仍然要发（提醒不能因此消失）", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const desktop = vi.fn(() => true);
        const platform = vi.fn(() => true);
        scheduledJobsService.setDesktopDeliverer(desktop);
        scheduledJobsService.setPlatformDeliverer(platform);
        const job = {
            jobId: "j-friend",
            payload: "记得吃药",
            sessionId: `bot-qq-private:${FRIEND}`,
            ownerKey: FRIEND,
        } as never;
        // 查不到本机主人 → 桌面那条被 fail-closed 挡掉，但平台照发
        expect(scheduledJobsService.deliverReminder(job)).toBe(1);
        expect(desktop).not.toHaveBeenCalled();
        expect(platform).toHaveBeenCalledTimes(1);
        log.mockRestore();
        scheduledJobsService.setDesktopDeliverer(null);
        scheduledJobsService.setPlatformDeliverer(null);
    });
});

// ── ★ VAGUE 档不得注入原文 ────────────────────────────────────────────
//
// 用户要求「既不是完全记忆隔离，也不是完全泄露隐私」。旧实现对 VAGUE 的处理
// 是把原文注进 prompt、再附一句「别把细节讲出去」—— 等于先把秘密交出去
// 再嘱咐保密。漏一轮就漏了，所以改成注入前就压成话题方向。
describe("★ 别人的私事只给话题方向，不给原文", () => {

    it("医疗细节不泄露（只 9 个字，截断/抽首句都挡不住）", () => {
        const out = vagueGist("她妈妈下周要做手术，费用还差三万");
        expect(out).toContain("身体状况");
        expect(out).not.toContain("手术");
        expect(out).not.toContain("妈妈");
        expect(out).not.toContain("三万");
    });

    it("感情八卦不泄露", () => {
        const out = vagueGist("小美跟张三在偷偷交往");
        expect(out).toContain("感情");
        expect(out).not.toContain("交往");
        expect(out).not.toContain("张三");
    });

    it("★ 单字关键词不能误伤（「毛病」不是身体状况）", () => {
        const out = vagueGist('想改掉"啥都说"的毛病：在公众场合控制音量');
        expect(out).not.toContain("身体状况");
        expect(out).toContain("分寸");
    });

    it("任何输出都不含原文里的连续 4 字片段", () => {
        const inputs = [
            "她妈妈下周要做手术，费用还差三万",
            "小美跟张三在偷偷交往",
            "老板上个月把我辞退了，房贷还不上了",
            "最近失眠很严重，焦虑得不行",
        ];
        for (const src of inputs) {
            const out = vagueGist(src);
            for (let i = 0; i + 4 <= src.length; i++) {
                const frag = src.slice(i, i + 4);
                if (/^[，。、：；！？\s]/.test(frag)) continue;
                expect(out).not.toContain(frag);
            }
        }
    });
});

describe("任务结果送达 · 与提醒同一套两条腿", () => {
    afterEach(() => {
        workspaceTask.setResultPusher(null);
        workspaceTask.setPlatformSender(null);
        workspaceTask.setRoleProbe(null);
        workspaceTask.setRelaySender(null);
        workspaceTask.setTaskRunner(null);
    });

    it("桌面上没开、平台能发 → 结果仍然送到用户手上", async () => {
        const platform: string[] = [];
        workspaceTask.setRoleProbe(() => null); // 单机
        workspaceTask.setTaskRunner(async () => ({ ok: true, speech: "今天的简报写好了" }));
        workspaceTask.setResultPusher(() => false); // 桌面没开
        workspaceTask.setPlatformSender(({ text }) => {
            platform.push(text);
            return true;
        });

        const taskId = "deliver-two-legs";
        workspace.ensureTask(OWNER, taskId, { title: "双腿送达" });
        await workspaceTask.fire({
            jobId: `wstask:${OWNER}:${taskId}`,
            uid: 1,
            title: "双腿送达",
            sessionId: `workspace:${OWNER}:${taskId}`,
            payload: workspaceTask.buildPayload({ owner: OWNER, taskId, instruction: "写点东西" }),
        });

        // 关键断言：QQ 里建的任务，结果必须回到 QQ，而不是只往桌面推一次就完了
        expect(platform).toEqual(["今天的简报写好了"]);
    });

    it("两条腿都失败要 warn，不再假装送达成功", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setTaskRunner(async () => ({ ok: true, speech: "写完了" }));
        workspaceTask.setResultPusher(() => false);
        workspaceTask.setPlatformSender(() => false);

        const taskId = "deliver-fail";
        workspace.ensureTask(FRIEND, taskId, { title: "双败" });
        await workspaceTask.fire({
            jobId: `wstask:${FRIEND}:${taskId}`,
            uid: 1,
            title: "双败",
            sessionId: `workspace:${FRIEND}:${taskId}`,
            payload: workspaceTask.buildPayload({ owner: FRIEND, taskId, instruction: "写点东西" }),
        });

        const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
        expect(msgs).toContain("没有送达任何地方");
        expect(msgs).toContain(FRIEND);
        warn.mockRestore();
    });

    it("deliver=false 时一条腿都不发（主机替叶子跑，结果由返回值带给叶子）", async () => {
        const desktop = vi.fn(() => true);
        const platform = vi.fn(() => true);
        workspaceTask.setRoleProbe(() => null);
        workspaceTask.setTaskRunner(async () => ({ ok: true, speech: "主机跑完了" }));
        workspaceTask.setResultPusher(desktop);
        workspaceTask.setPlatformSender(platform);

        const taskId = "deliver-off";
        workspace.ensureTask(OWNER, taskId, { title: "不发" });
        await workspaceTask.fire({
            jobId: `wstask:${OWNER}:${taskId}`,
            uid: 1,
            title: "不发",
            sessionId: `workspace:${OWNER}:${taskId}`,
            payload: workspaceTask.buildPayload({
                owner: OWNER,
                taskId,
                instruction: "做事",
                deliver: false,
            }),
        });
        // 主机这边推一次，会在主机界面上凭空冒出一条不属于它的消息
        expect(desktop).not.toHaveBeenCalled();
        expect(platform).not.toHaveBeenCalled();
    });

    // ── 2026-11-20 身份排查（A2）：任务归属必须能穿越存储层 ────────────
    //
    // 到点触发时调度器手上只有一行 job，没有会话上下文。归属只能靠 owner_key
    // 这一列带出来。以前 taskRuntime 写了 job.ownerKey，但 jobToRow 的白名单
    // 把它静默丢掉，存进库的是一条无主任务 —— 上游修了也白修。
    describe("★ 任务归属 ownerKey 持久化", () => {
        it("ownerKey 存得进、读得回（不被 jobToRow 白名单丢弃）", async () => {
            const { jobStore } = await import("../events/jobStore");
            const { createJob } = await import("kirari-agent");
            const job = createJob({
                jobId: "job-ownerkey-probe",
                sessionId: `workspace:${FRIEND}:probe`,
                origin: "core" as never,
                uid: 1,
                kind: "reminder" as never,
                title: "归属回归",
                payload: "朋友的提醒",
                dueAt: Date.now() + 3600_000,
                recurrence: "once" as never,
                now: Date.now(),
            } as never);
            (job as any).ownerKey = FRIEND;
            jobStore.save(job, "job_created");

            const back = jobStore.get("job-ownerkey-probe");
            expect((back as any)?.ownerKey).toBe(FRIEND);
        });

        it("due() 也带出 ownerKey（触发瞬间唯一的归属来源）", async () => {
            const { jobStore } = await import("../events/jobStore");
            const row = jobStore.due(Date.now() + 7200_000, 100).find(
                (j) => j.jobId === "job-ownerkey-probe",
            );
            expect((row as any)?.ownerKey).toBe(FRIEND);
        });

        it("周期任务顺延后仍然带着 ownerKey（不用 sessionId 猜）", async () => {
            const { fireJob } = await import("kirari-agent");
            const base = {
                jobId: "job-recur-probe",
                sessionId: `workspace:${FRIEND}:recur`,
                origin: "core",
                uid: 1,
                kind: "reminder",
                title: "周期",
                payload: "每天提醒",
                dueAt: Date.now() - 1000,
                recurrence: "daily",
                status: "pending",
                createdAt: Date.now() - 50_000,
                updatedAt: Date.now() - 50_000,
            };
            const next: any = fireJob(base as never, Date.now());
            // 共享包是纯函数，不认识 ownerKey —— 叠加逻辑在 scheduledJobsService 里。
            // 这里断言的是「它确实不保留」，用来固定住"必须由上层补"这个事实。
            expect(next.ownerKey).toBeUndefined();
        });
    });
});
