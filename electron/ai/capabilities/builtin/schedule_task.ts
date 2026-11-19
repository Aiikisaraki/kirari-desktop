// electron/ai/capabilities/builtin/schedule_task.ts
// 内置能力：schedule_task —— 她给主人建一个「定期自动化任务」。与核心版对称。
//
// 与 schedule_reminder 的分工（最容易混的一对）：
//   schedule_reminder → 到点「说一句话」，说完就没了，不落任何东西。
//   schedule_task     → 到点「做一件事并把结果存下来」，产出进工作空间的任务文件夹，
//                       第二天还能读回来做对比/累计。
// 用户 2026-11-19 要的是后者：「这样它可以执行一些定期的自动化任务，
// 并且保留一定量的数据」。
import { createJob } from "kirari-agent";
import { defineCapability, type Capability } from "kirari-agent";
import { randomBytes } from "crypto";
import { jobStore } from "../../events/jobStore";
import * as storage from "../../db/storage";
import * as workspace from "../../services/workspace";
import * as workspaceTask from "../../services/workspaceTask";

// 枚举内联：registry 用 eager glob 加载 builtin，顶层读外部数组容易拿到未初始化值。
const RECURRENCE_ENUM = ["once", "daily", "weekly", "monthly"];

/**
 * 每人最多挂几个定期任务。
 * 定期任务每次都真实调模型（花钱、花时间）。不设上限的话，一句「每小时提醒我
 * 喝水」就能挂 24 条/天，用户自己都数不清有多少任务在后台烧凭证。
 * 上限的作用是让她**如实说超限了**，而不是偷偷建一堆。
 */
export const MAX_TASKS_PER_UID = 24;

const capability: Capability = defineCapability({
    id: "schedule_task",
    name: "schedule_task",
    kind: "tool",
    scope: "builtin",
    description:
        "给主人建一个定期自动化任务：到点由你自动去做，并把产出保存在你的工作空间里" +
        "（一个任务一个文件夹），所以第二天还能读回昨天的结果。" +
        "例如「每天早上整理昨天的科技新闻并存下来」「每周五汇总这周聊过的待办」。" +
        "如果只是「到点提醒我一句」，用 schedule_reminder；要「做完并留下东西」才用这个。" +
        "需要给：任务标题、要做什么（instruction，写清楚执行的步骤和产出放哪）、" +
        "repeat（once / daily / weekly / monthly，默认 daily）、时间。",
    parameters: {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "任务标题，如「每日科技简报」。会成为工作空间里这个任务的名字。",
            },
            instruction: {
                type: "string",
                description:
                    "这个任务每次要做什么。写清楚：从哪里取信息、产出什么、存成什么文件。" +
                    "越具体越好——将来是「没有你在场」的情况下自动执行的。",
            },
            repeat: {
                type: "string",
                enum: RECURRENCE_ENUM,
                description: "once=只做一次；daily=每天；weekly=每周同一天；monthly=每月同日。默认 daily。",
            },
            hour: { type: "number", description: "几点执行（0-23，本地时间）。默认 8 点。" },
            minute: { type: "number", description: "几分执行（0-59）。默认 0 分。" },
            weekday: { type: "number", description: "repeat=weekly 时指定星期几：1=周一 … 7=周日。默认 1。" },
            day: {
                type: "number",
                description: "repeat=monthly 时指定几号（1-28，超过 28 会跑到下个月去）。默认 1。",
            },
            retentionDays: { type: "number", description: "产出保留多少天（默认 30 天）。超龄文件每次运行后自动清理。" },
            retentionFiles: { type: "number", description: "最多保留多少个产出文件（默认 200 个）。" },
        },
        required: ["title", "instruction"],
    },
    tags: ["builtin", "workspace", "task"],
});

/**
 * 算下一次触发时间。全部用**本地时间**：用户说「早上 8 点」就是他家墙上钟的 8 点。
 * 这也是 briefSchedule.nextSlotAt 的做法。
 */
export function computeDueAt(
    opts: { repeat?: string; hour?: number; minute?: number; weekday?: number; day?: number },
    now = Date.now(),
): number {
    const h = Number.isFinite(opts.hour) ? Math.min(23, Math.max(0, Math.floor(opts.hour as number))) : 8;
    const m = Number.isFinite(opts.minute) ? Math.min(59, Math.max(0, Math.floor(opts.minute as number))) : 0;
    const repeat = opts.repeat || "daily";

    const d = new Date(now);
    d.setSeconds(0, 0);

    if (repeat === "once") {
        // 一次性：取今天该时刻，已经过了就取明天（用户说「明早八点」多半是这个意思）
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
    }

    if (repeat === "monthly") {
        const want = Number.isFinite(opts.day) ? Math.min(28, Math.max(1, Math.floor(opts.day as number))) : 1;
        d.setDate(want);
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= now) {
            d.setMonth(d.getMonth() + 1);
            d.setDate(want); // 跨月后重设，避免 1/31 → 2/31 溢出
        }
        return d.getTime();
    }

    if (repeat === "weekly") {
        // getDay() 是 0=周日；这里用 1=周一…7=周日，转换一下
        const want = Number.isFinite(opts.weekday)
            ? Math.min(7, Math.max(1, Math.floor(opts.weekday as number)))
            : 1;
        const wantSun0 = want === 7 ? 0 : want;
        const delta = (wantSun0 - d.getDay() + 7) % 7;
        d.setDate(d.getDate() + delta);
        d.setHours(h, m, 0, 0);
        // 今天就是那一天但时刻已过 → 顺延一周
        if (d.getTime() <= now) d.setDate(d.getDate() + 7);
        return d.getTime();
    }

    // daily（默认）
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
}

/**
 * 共享包只认 once / daily 两种 recurrence。
 * weekly/monthly 不为了一个字段去改共享包（改了要两端一起发版），
 * 而是用 daily + 触发后按 payload 重算 dueAt 实现。
 */
export function jobRecurrence(repeat?: string): "once" | "daily" {
    return repeat === "once" ? "once" : "daily";
}

/** 触发后重算下一次（overrides 共享包的 +24h）。daily/once 返回 null 表示不覆盖。 */
export function nextDueAtAfterFire(
    opts: { repeat?: string; day?: number },
    fromDueAt: number,
): number | null {
    if (opts.repeat === "weekly") {
        const d = new Date(fromDueAt);
        d.setDate(d.getDate() + 7);
        return d.getTime();
    }
    if (opts.repeat === "monthly") {
        const d = new Date(fromDueAt);
        const want = Number.isFinite(opts.day) ? Math.min(28, Math.max(1, Math.floor(opts.day as number))) : d.getDate();
        d.setMonth(d.getMonth() + 1);
        d.setDate(want);
        return d.getTime();
    }
    return null;
}

function newTaskId(title: string): string {
    // taskId 也是工作空间的文件夹名：用「可读前缀 + 短随机」而不是纯随机，
    // 用户翻目录时能认出是哪个任务；随机后缀保证同一标题可以建多个不撞。
    let slug = String(title || "task")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    if (!slug) slug = "task";
    return `${slug}-${randomBytes(3).toString("hex")}`;
}

async function dispatch(args: any, ctx: any): Promise<string> {
    const a = args || {};
    const title = String(a.title || "").trim();
    const instruction = String(a.instruction || "").trim();
    if (!title) return "error: 要给任务一个标题。";
    if (!instruction) return "error: 要写清楚这个任务每次做什么（instruction）。";

    const repeat = RECURRENCE_ENUM.includes(String(a.repeat || "").toLowerCase())
        ? String(a.repeat).toLowerCase()
        : "daily";
    const uid = ctx?.uid ?? 1;

    // 配额：超了如实说，让她转告用户，而不是偷偷建成或静默失败。
    try {
        const used = storage.countJobRowsByKind("workspace_task", uid);
        if (used >= MAX_TASKS_PER_UID) {
            return `error: 已有 ${used} 个定期任务，达到上限 ${MAX_TASKS_PER_UID} 个。要新建的话，先跟主人确认删掉哪个旧的。`;
        }
    } catch (e) {
        console.warn("[schedule_task] 统计任务数失败（跳过配额检查）:", (e as Error)?.message || e);
    }

    try {
        const now = Date.now();
        const dueAt = computeDueAt(
            { repeat, hour: a.hour, minute: a.minute, weekday: a.weekday, day: a.day },
            now,
        );
        const taskId = newTaskId(title);

        // 先把文件夹和 meta 建起来：这样即使第一次还没跑，用户现在就能在
        // 文件管理器里看到这个任务，也能自己往里丢参考资料。
        const retention: Partial<workspace.Retention> = {};
        if (Number.isFinite(a.retentionDays)) retention.keepDays = Math.max(1, Math.floor(a.retentionDays));
        if (Number.isFinite(a.retentionFiles)) retention.keepFiles = Math.max(1, Math.floor(a.retentionFiles));
        workspace.ensureTask(taskId, { title, description: instruction, retention });

        jobStore.save(
            createJob({
                jobId: `wstask:${taskId}`,
                // 会话 ID 带 workspace: 前缀，主机侧据此认出是任务而不是闲聊
                sessionId: workspaceTask.sessionIdFor(taskId),
                origin: "desktop",
                uid,
                // kind 不在共享包的 JobKind 联合里，但 DB 层是自由 TEXT（无 CHECK 约束），
                // 所以新增 job 类型不需要给共享包发版。
                kind: "workspace_task" as never,
                title,
                // 周期信息一并写进 payload：weekly/monthly 的间隔不是 24h，
                // 触发后由调度器按这里存的字段重算 dueAt。
                payload: workspaceTask.buildPayload({
                    taskId,
                    instruction,
                    repeat,
                    hour: a.hour,
                    minute: a.minute,
                    weekday: a.weekday,
                    day: a.day,
                }),
                dueAt,
                recurrence: jobRecurrence(repeat),
                now,
            }),
            "job_created",
        );

        const when = new Date(dueAt).toLocaleString("zh-CN");
        const repeatText =
            ({ once: "只做这一次", daily: "每天", weekly: "每周", monthly: "每月" } as Record<string, string>)[repeat] ||
            "每天";
        return (
            `已建好定期任务「${title}」（${repeatText}），第一次在 ${when} 执行。` +
            `执行结果会存进你的工作空间 ${workspace.rootDir()}\\${taskId} 里，按保留策略自动清理旧文件。` +
            `到点我会自动去做，做完告诉主人写了什么。`
        );
    } catch (e) {
        return `error: 建定期任务失败——${e instanceof Error ? e.message : String(e)}`;
    }
}

export { capability, dispatch };
