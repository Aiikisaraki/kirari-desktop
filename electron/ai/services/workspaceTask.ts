// electron/ai/services/workspaceTask.ts
// 工作空间定期任务的执行编排（desktop 侧）。与核心版 src/services/workspaceTask.js 对称。
//
// ── 为什么这个文件自己不碰模型 ───────────────────────────────────────
// 跟 briefSchedule 同一个理由：「调度」和「凭证/上下文」两件事分开。
// 真正生成回复需要一个已配置的 AiContext（读 model-config、建 openai client），
// 那是主进程的事；这里只负责组织指令、记账（recordRun）、按保留策略清理、
// 以及把结果推给界面。所以模型调用和执行结果投递都由主进程注入：
//   setTaskRunner()  —— 怎么用给定指令跑一轮模型
//   setResultPusher() —— 结果怎么送到用户眼前
//
// ── 叶子节点 ────────────────────────────────────────────────────────
// 用户 2026-11-19：「从机（叶子节点）的任务依旧转发给主机完成」。
// 叶子没有模型凭证，所以 fire() 里先问 netBootstrap 自己是不是叶子：
//   是叶子 → uplinkChat 把 JSON 载荷上行给主机（云端执行、产出写主机）
//   不是   → 本地 runner 执行
// 上行失败时**返回 true 但不记运行次数**：job 必须顺延（否则 15s 一次热重试），
// 但 meta 不能谎报「跑过了」。

import * as workspace from "./workspace";

export const SESSION_PREFIX = "workspace:";

export function sessionIdFor(taskId: string): string {
    return `${SESSION_PREFIX}${taskId}`;
}

export function isWorkspaceSession(sessionId: string): boolean {
    return String(sessionId || "").startsWith(SESSION_PREFIX);
}

export function taskIdFromSession(sessionId: string): string {
    const s = String(sessionId || "");
    return s.startsWith(SESSION_PREFIX) ? s.slice(SESSION_PREFIX.length) : "";
}

export type TaskPayload = {
    taskId: string;
    instruction: string;
    deliver: boolean;
    repeat?: string;
    hour?: number;
    minute?: number;
    weekday?: number;
    day?: number;
};

/** job.payload 是 JSON 文本（TEXT 列）。坏数据返回 null，绝不抛。 */
export function parsePayload(raw: unknown): TaskPayload | null {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;
    // 兼容两种形态：JSON 载荷，或者历史遗留的纯文本指令
    if (!text.startsWith("{")) {
        return { taskId: "", instruction: text, deliver: true };
    }
    try {
        const o = JSON.parse(text);
        if (!o || typeof o !== "object") return null;
        return {
            taskId: String(o.taskId || ""),
            instruction: String(o.instruction || ""),
            deliver: o.deliver !== false,
            repeat: o.repeat ? String(o.repeat) : undefined,
            hour: Number.isFinite(o.hour) ? Number(o.hour) : undefined,
            minute: Number.isFinite(o.minute) ? Number(o.minute) : undefined,
            weekday: Number.isFinite(o.weekday) ? Number(o.weekday) : undefined,
            day: Number.isFinite(o.day) ? Number(o.day) : undefined,
        };
    } catch {
        return null;
    }
}

export function buildPayload(p: {
    taskId: string;
    instruction: string;
    deliver?: boolean;
    repeat?: string;
    hour?: number;
    minute?: number;
    weekday?: number;
    day?: number;
}): string {
    const out: Record<string, unknown> = {
        taskId: p.taskId,
        instruction: String(p.instruction || ""),
        deliver: p.deliver !== false,
    };
    if (p.repeat) out.repeat = String(p.repeat);
    if (Number.isFinite(p.hour)) out.hour = Number(p.hour);
    if (Number.isFinite(p.minute)) out.minute = Number(p.minute);
    if (Number.isFinite(p.weekday)) out.weekday = Number(p.weekday);
    if (Number.isFinite(p.day)) out.day = Number(p.day);
    return JSON.stringify(out);
}

/** 本地日期 YYYY-MM-DD（不是 UTC——用户说「今天的简报」指的是他家墙上钟的今天）。 */
export function todayStr(d = new Date()): string {
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return t.toISOString().slice(0, 10);
}

/**
 * 拼这次的执行指令。
 * 五条要求都是踩过的坑：
 *   1 固定 taskId —— 不然它会新建一个文件夹，产出散成好几处
 *   2 日期进文件名 —— 否则每天覆盖同一个文件，做不到「保留一定量的数据」
 *   3 先 ls/read 上次的 —— 这是「定期」相对「一次性」的唯一增量价值
 *   4 不许反问 —— 没人在场，问了也没人答，只会白跑一轮
 *   5 用一两句自然的话收尾并报文件名 —— 这句话会被推给用户
 */
export function buildInstruction(
    task: { taskId: string; title: string; instruction: string; description?: string },
    dateStr: string,
): string {
    const what = String(task.instruction || task.description || "").trim();
    return [
        `现在是 ${dateStr}，你要执行一个定期任务：「${task.title}」。`,
        `这个任务每次要做的事：${what}`,
        "",
        "要求：",
        `1. 产出写进工作空间的这个任务文件夹，taskId 固定是 ${task.taskId}（不要新建别的任务文件夹）。`,
        `2. 文件名带上日期（今天是 ${dateStr}），这样每天的结果都留得住。`,
        `3. 动手前先用 workspace 的 ls 看一眼这个文件夹里有什么；如果有上一次的产出，read 一下——`,
        "   这次要接着上次的来（做对比、累计、或者只写新的部分），不要重复写一样的东西。",
        "4. 没人在旁边看着，所以**不要提问、不要等确认**，按你的判断直接做完。",
        "5. 做完用一两句自然的话说说你写了什么、放在哪个文件。别提工具名、别说「已成功执行」。",
    ].join("\n");
}

// ── 主进程注入点 ────────────────────────────────────────────────────

export type TaskRunner = (input: {
    taskId: string;
    title: string;
    instruction: string;
    /** 会话 ID：本机跑就是 workspace:<id>；主机替叶子跑是 net:<设备>:workspace:<id> */
    sessionId: string;
}) => Promise<{ ok: boolean; speech?: string; error?: string }>;

export type ResultPusher = (input: {
    uid: number;
    speech: string;
    sessionId: string;
    taskId: string;
    title: string;
}) => void;

let taskRunner: TaskRunner | null = null;
let resultPusher: ResultPusher | null = null;

export function setTaskRunner(runner: TaskRunner | null): void {
    taskRunner = runner;
}

export function setResultPusher(pusher: ResultPusher | null): void {
    resultPusher = pusher;
}

function pushResult(uid: number, speech: string, taskId: string, title: string): void {
    if (!resultPusher) return;
    try {
        resultPusher({ uid, speech, sessionId: sessionIdFor(taskId), taskId, title });
    } catch (e) {
        console.warn("[wsTask] 推送任务结果失败:", (e as Error)?.message || e);
    }
}

/**
 * 本地执行一次任务（主机侧、或本机既是主机时走这里）。
 * 记账与清理都在这里做，这样两端行为一致。
 */
export async function runLocally(input: {
    taskId: string;
    title: string;
    instruction: string;
    uid?: number;
    deliver?: boolean;
    /** 覆盖会话 ID：主机替叶子执行时传 net:<设备>:workspace:<id>，避免上下文串 */
    sessionId?: string;
}): Promise<{ ok: boolean; speech?: string; error?: string }> {
    const taskId = String(input.taskId || "").trim();
    if (!taskId) return { ok: false, error: "缺少 taskId" };
    if (!taskRunner) return { ok: false, error: "任务执行器还没就绪（应用可能还在启动）" };

    const uid = input.uid ?? 1;
    const startedAt = Date.now();
    try {
        // 先确保文件夹存在，并把 meta 里的最新标题拿到（标题可能被用户改过）。
        // title 为空时不要覆盖已有 meta —— ensureTask 的 patch.title 是「给了就改」，
        // 主机替叶子执行时拿不到标题（payload 里没有），传空串会把用户设的名字清掉。
        const patch = input.title ? { title: input.title } : {};
        workspace.ensureTask(taskId, patch);
        const meta = workspace.readTaskMeta(taskId);
        const title = meta.title || input.title || taskId;
        const dateStr = todayStr();
        const content = buildInstruction({ taskId, title, instruction: input.instruction }, dateStr);

        const res = await taskRunner({
            taskId,
            title,
            instruction: content,
            sessionId: input.sessionId || sessionIdFor(taskId),
        });

        if (!res || res.ok !== true) {
            const reason = (res && res.error) || "未知原因";
            console.warn(`[wsTask] 任务 ${taskId} 执行失败：${reason}`);
            return { ok: false, error: reason };
        }

        workspace.recordRun(taskId);
        // 清理是「顺手做好事」：失败不该让任务算失败（产出已经写完了）
        try {
            const pr = workspace.pruneTask(taskId);
            if (pr.deleted > 0) {
                console.log(`[wsTask] ${taskId} 清理了 ${pr.deleted} 个旧文件（${pr.freedBytes}B）`);
            }
        } catch (e) {
            console.warn(`[wsTask] ${taskId} 清理旧文件失败（已忽略）:`, (e as Error)?.message || e);
        }

        const speech = String(res.speech || "").trim();
        if (input.deliver !== false && speech) {
            pushResult(uid, speech, taskId, meta.title || input.title || taskId);
        }
        const cost = Date.now() - startedAt;
        console.log(`[wsTask] 任务 ${taskId} 执行完成（${cost}ms）`);
        return { ok: true, speech };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[wsTask] 任务 ${taskId} 异常：${reason}`);
        return { ok: false, error: reason };
    }
}

/**
 * 组网上行出口（由主进程注入）。
 * 桌面端不像核心版那样有 netBootstrap.uplinkChat——它统一走 NetManager：
 *   role === "host" → submitLocalPrompt（本机提交给自己的路由）
 *   否则            → relay（上行给主机）
 * 返回 null 表示组网不可用（未开启 / 未连接），调用方按「本机执行」处理。
 *
 * 约定：成功时 resolve 出主机的回复文本；失败返回 null。
 */
export type RelaySender = (input: {
    sessionId: string;
    content: string;
}) => Promise<{ speech: string } | null> | { speech: string } | null;

/** 本机当前是否处于叶子角色（组网可用且不是主机）。null = 组网未启用。 */
export type RoleProbe = () => "host" | "leaf" | null;

let relaySender: RelaySender | null = null;
let roleProbe: RoleProbe | null = null;

export function setRelaySender(sender: RelaySender | null): void {
    relaySender = sender;
}

export function setRoleProbe(probe: RoleProbe | null): void {
    roleProbe = probe;
}

/**
 * 触发一条 workspace_task job。返回 true 仅表示「job 可以顺延」，
 * 不代表这次真的跑成了 —— 调度器只关心别把 job 卡住。
 */
export async function fire(
    job: {
        jobId: string;
        uid: number;
        title: string;
        payload: string;
        dueAt: number;
    },
    _now = Date.now(),
): Promise<boolean> {
    const payload = parsePayload(job.payload);
    if (!payload || !payload.taskId) {
        console.warn(`[wsTask] job=${job.jobId} 的 payload 无法解析，跳过本次`);
        // 返回 true：payload 坏了就永远跑不了，卡成 pending 只会每 15s 报错一次
        return true;
    }
    const { taskId, instruction } = payload;
    const uid = job.uid ?? 1;

    try {
        const meta = workspace.readTaskMeta(taskId);
        const title = meta.title || job.title || taskId;

        // ── 叶子：转发给主机 ──
        // 用户 2026-11-19：「从机（叶子节点）的任务依旧转发给主机完成」。
        // 叶子没有模型凭证，所以这里把任务上行；产出由**主机**写进主机的
        // ~/KirariWorkspace，叶子只拿回结果。
        const role = roleProbe ? roleProbe() : null;
        if (role === "leaf" && relaySender) {
            const startedAt = Date.now();
            // 上行的是 JSON 载荷，不是拼好的文本：主机要按**主机自己的**日期和
            // meta 里的最新标题重建指令。传成品文本会把这两样冻结在叶子的时刻。
            const content = JSON.stringify({
                taskId: workspace.safeSegment(taskId, "taskId"),
                title,
                instruction,
            });
            let res: { speech: string } | null = null;
            try {
                res = await relaySender({ sessionId: sessionIdFor(taskId), content });
            } catch (e) {
                console.warn(`[wsTask] 叶子上行异常（taskId=${taskId}）:`, (e as Error)?.message || e);
                res = null;
            }
            if (!res) {
                // 关键：不 recordRun —— meta 不能声称跑过一次实际没发生的事。
                // 但仍返回 true：job 必须顺延，否则 15s 一次热重试打向一个连不上的主机。
                console.warn(`[wsTask] 叶子转发失败（taskId=${taskId}），本轮跳过，任务顺延`);
                return true;
            }
            console.log(
                `[wsTask] 叶子任务 ${taskId} 已由主机执行完成（${Date.now() - startedAt}ms，产出写在主机）`,
            );
            const speech = String(res.speech || "").trim();
            if (payload.deliver !== false && speech) {
                pushResult(uid, speech, taskId, title);
            }
            return true;
        }

        // ── 主机 / 单机：本地执行 ──
        await runLocally({ taskId, title, instruction, uid, deliver: payload.deliver });
        return true;
    } catch (e) {
        // 任何异常都不该让 job 卡在 pending（会 15s 一次热循环）
        console.warn(`[wsTask] 触发 job=${job.jobId} 异常：`, e instanceof Error ? e.message : e);
        return true;
    }
}
