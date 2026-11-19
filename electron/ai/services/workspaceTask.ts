// electron/ai/services/workspaceTask.ts
// 工作空间定期任务的执行编排（desktop 侧）。与核心版 src/services/workspaceTask.js 对称。
//
// ── 为什么这个文件自己不碰模型 ───────────────────────────────────────
// 跟 briefSchedule 同一个理由：「调度」和「凭证/上下文」两件事分开。
// 真正生成回复需要一个已配置的 AiContext（读 model-config、建 openai client），
// 那是主进程的事；这里只负责组织指令、记账（recordRun）、按保留策略清理、
// 以及把结果推给界面。所以模型调用和执行结果投递都由主进程注入：
//   setTaskRunner()    —— 怎么用给定指令跑一轮模型
//   setResultPusher()  —— 结果怎么送到用户眼前（桌面这条腿）
//   setPlatformSender()—— 结果怎么发回原来的平台会话（QQ 这条腿）
//
// ── 叶子节点 ────────────────────────────────────────────────────────
// 用户 2026-11-19：「从机（叶子节点）的任务依旧转发给主机完成」。
// 叶子没有模型凭证，所以 fire() 里先问 roleProbe 自己是不是叶子：
//   是叶子 → relaySender 把 JSON 载荷上行给主机（产出写主机）
//   不是   → 本地 runner 执行
// 上行失败时**返回 true 但不记运行次数**：job 必须顺延（否则 15s 一次热重试），
// 但 meta 不能谎报「跑过了」。
//
// ── 会话 id 里带上 owner（2026-11-20）────────────────────────────
// 格式：`workspace:<owner>:<taskId>`，与核心版一致。
// 不带 owner 的话，主机只知道「要跑 taskId=X」，不知道 X 是谁的 —— 而工作空间
// 已按 owner 分层，缺 owner 就只能瞎猜或退化成公共目录，隔离白做。
//
// 老格式 `workspace:<taskId>` 继续能认：owner 缺失时由调用方决定
//（本地执行时按 payload.owner → sessionId → LEGACY_OWNER 三级兜底，
// 绝不回退成「公共目录」——那会让所有历史任务重新混在一起）。

import * as workspace from "./workspace";

/** 工作空间任务的会话 ID 前缀。叶子靠它让主机认出「这是任务，不是闲聊」。 */
export const SESSION_PREFIX = "workspace:";

/** 老格式（没有 owner 层）落盘时的归属名，一眼能看出是历史遗留。 */
export const LEGACY_OWNER = "_legacy";

export function sessionIdFor(owner: string, taskId: string): string {
    const ow = workspace.ownerDirName(owner);
    const id = workspace.safeSegment(taskId, "taskId");
    return `${SESSION_PREFIX}${ow}:${id}`;
}

export function isWorkspaceSession(sessionId: string): boolean {
    return typeof sessionId === "string" && sessionId.startsWith(SESSION_PREFIX);
}

/**
 * 从会话 id 里拆出 { owner, taskId }。
 * 两种格式都认：
 *   workspace:<owner>:<taskId>   → { owner, taskId }
 *   workspace:<taskId>           → { owner: '', taskId }（老格式，owner 待定）
 */
export function parseSessionId(sessionId: string): { owner: string; taskId: string } {
    if (!isWorkspaceSession(sessionId)) return { owner: "", taskId: "" };
    const rest = String(sessionId).slice(SESSION_PREFIX.length);
    const parts = rest.split(":");
    if (parts.length >= 2) return { owner: parts[0], taskId: parts.slice(1).join(":") };
    return { owner: "", taskId: rest };
}

/** 老调用点兼容：只取 taskId。 */
export function taskIdFromSession(sessionId: string): string {
    return parseSessionId(sessionId).taskId || "";
}

/** 老调用点兼容：只取 owner（可能是空串，表示老格式）。 */
export function ownerFromSession(sessionId: string): string {
    return parseSessionId(sessionId).owner || "";
}

export type TaskPayload = {
    taskId: string;
    /** 这个任务属于谁。老 job 没有这个字段，所以是可选的。 */
    owner?: string;
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
        const out: TaskPayload = {
            taskId: String(o.taskId || ""),
            instruction: String(o.instruction || ""),
            deliver: o.deliver !== false,
            repeat: o.repeat ? String(o.repeat) : undefined,
            hour: Number.isFinite(o.hour) ? Number(o.hour) : undefined,
            minute: Number.isFinite(o.minute) ? Number(o.minute) : undefined,
            weekday: Number.isFinite(o.weekday) ? Number(o.weekday) : undefined,
            day: Number.isFinite(o.day) ? Number(o.day) : undefined,
        };
        // owner 必须进 payload：调度器到点时手上只有 job 行，没有原始对话上下文。
        // 不存下来的话，「这是谁的任务」就永久丢了 —— 而工作空间是按 owner 分层的。
        if (o.owner) out.owner = String(o.owner);
        return out;
    } catch {
        return null;
    }
}

export function buildPayload(p: {
    taskId: string;
    owner?: string;
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
    if (p.owner) out.owner = String(p.owner);
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
 *   1 固定 taskId + owner —— 不然它会新建一个文件夹，或者写进别人的目录
 *   2 日期进文件名 —— 否则每天覆盖同一个文件，做不到「保留一定量的数据」
 *   3 先 ls/read 上次的 —— 这是「定期」相对「一次性」的唯一增量价值
 *   4 不许反问 —— 没人在场，问了也没人答，只会白跑一轮
 *   5 用自然的话收尾 —— 这句话会被推给用户
 */
export function buildInstruction(
    task: {
        taskId: string;
        title: string;
        instruction: string;
        description?: string;
        owner?: string;
    },
    dateStr: string,
): string {
    const what = String(task.instruction || task.description || "").trim();
    const lines = [
        "【定期任务 · 无人值守执行】",
        `现在是 ${dateStr}，你要执行一个定期任务：「${task.title}」。`,
        `这个任务每次要做的事：${what}`,
    ];
    // owner 只在她确实知道时才说：老 payload 可能没有，硬编一个 "_legacy" 进提示词
    // 反而会让她把产出写到历史遗留目录里。
    if (task.owner) {
        lines.push(`这个任务属于 owner=${task.owner}，写文件时必须用同一个 owner，不要写进别人的目录。`);
    }
    lines.push("");
    lines.push("要求：");
    lines.push(
        `1. 产出写进工作空间的这个任务文件夹，taskId 固定是 ${task.taskId}（不要新建别的任务文件夹）。`,
    );
    lines.push(`2. 文件名带上日期（今天是 ${dateStr}），这样每天的结果都留得住。`);
    lines.push(
        "3. 动手前先用 workspace 的 ls 看一眼这个文件夹里有什么；如果有上一次的产出，read 一下——",
    );
    lines.push("   这次要接着上次的来（做对比、累计、或者只写新的部分），不要重复写一样的东西。");
    lines.push("4. 没人在旁边看着，所以**不要提问、不要等确认**，按你的判断直接做完。");
    lines.push("5. 做完用一两句自然的话说说你写了什么、放在哪个文件。别提工具名、别说「已成功执行」。");
    return lines.join("\n");
}

// ── 主进程注入点 ────────────────────────────────────────────────────

export type TaskRunner = (input: {
    owner: string;
    taskId: string;
    title: string;
    instruction: string;
    /** 会话 ID：带 owner 和 workspace: 前缀（见本文件头）。 */
    sessionId: string;
}) => Promise<{ ok: boolean; speech?: string; error?: string }>;

/**
 * 结果推送（桌面这条腿）。
 * @returns 是否真的送到了（false/void 都算没送到，与核心版 pushProactiveMessage 的
 *          返回值语义一致：连接数为 0 就是没送到）。
 */
export type ResultPusher = (input: {
    uid: number;
    owner: string;
    speech: string;
    sessionId: string;
    taskId: string;
    title: string;
}) => boolean | void;

/**
 * 平台回发（QQ 这条腿）。与核心版 botManager.pushToUserSession 同语义：
 * sessionId 不是 `bot-<adapterId>-<conversationKey>` 时直接返回 false。
 */
export type PlatformSender = (input: { sessionId: string; text: string }) => boolean | void;

let taskRunner: TaskRunner | null = null;
let resultPusher: ResultPusher | null = null;
let platformSender: PlatformSender | null = null;

export function setTaskRunner(runner: TaskRunner | null): void {
    taskRunner = runner;
}

export function setResultPusher(pusher: ResultPusher | null): void {
    resultPusher = pusher;
}

export function setPlatformSender(sender: PlatformSender | null): void {
    platformSender = sender;
}

/**
 * 本地执行一次任务（主机侧、或本机既是主机时走这里）。
 * 记账与清理都在这里做；**送达不在这里**——统一由 fire() 走 deliverResult，
 * 这样「跑成功但没送到用户手上」也能被如实记录下来（核心版同结构）。
 */
export async function runLocally(input: {
    owner: string;
    taskId: string;
    title: string;
    instruction: string;
    uid?: number;
    /** 保留字段：与实际送达无关，送达统一在 fire() 里做。 */
    deliver?: boolean;
    /** 覆盖会话 ID：主机替叶子执行时传带设备命名空间的 workspace:<owner>:<taskId>。 */
    sessionId?: string;
}): Promise<{ ok: boolean; speech?: string; error?: string }> {
    const taskId = String(input.taskId || "").trim();
    if (!taskId) return { ok: false, error: "缺少 taskId" };
    if (!taskRunner) return { ok: false, error: "任务执行器还没就绪（应用可能还在启动）" };

    const startedAt = Date.now();
    let ow: string;
    let id: string;
    try {
        ow = workspace.ownerDirName(input.owner);
        id = workspace.safeSegment(taskId, "taskId");
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    try {
        // 先确保文件夹存在，并把 meta 里的最新标题拿到（标题可能被用户改过）。
        // title 为空时不要覆盖已有 meta —— ensureTask 的 patch.title 是「给了就改」，
        // 主机替叶子执行时拿不到标题（payload 里没有），传空串会把用户设的名字清掉。
        workspace.ensureTask(ow, id, input.title ? { title: input.title } : {});
        const meta = workspace.readTaskMeta(ow, id) || ({} as workspace.TaskMeta);
        const title = meta.title || input.title || id;
        const dateStr = todayStr();
        const content = buildInstruction(
            {
                taskId: id,
                title,
                instruction: input.instruction,
                description: meta.description || "",
                owner: ow,
            },
            dateStr,
        );

        const res = await taskRunner({
            owner: ow,
            taskId: id,
            title,
            instruction: content,
            sessionId: input.sessionId || sessionIdFor(ow, id),
        });

        if (!res || res.ok !== true) {
            const reason = (res && res.error) || "未知原因";
            console.warn(`[wsTask] 任务 ${ow}/${id} 执行失败：${reason}`);
            return { ok: false, error: reason };
        }

        workspace.recordRun(ow, id);
        // 清理是「顺手做好事」：失败不该让任务算失败（产出已经写完了）
        try {
            const pr = workspace.pruneTask(ow, id);
            if (pr.deleted > 0) {
                console.log(`[wsTask] ${ow}/${id} 清理了 ${pr.deleted} 个旧文件（${pr.freedBytes}B）`);
            }
        } catch (e) {
            console.warn(`[wsTask] ${ow}/${id} 清理旧文件失败（已忽略）:`, (e as Error)?.message || e);
        }

        const speech = String(res.speech || "").trim();
        const cost = Date.now() - startedAt;
        console.log(`[wsTask] 任务 ${ow}/${id} 执行完成（${cost}ms）`);
        return { ok: true, speech };
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[wsTask] 任务 ${ow}/${id} 异常：${reason}`);
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
 * 把任务结果送到用户手上，返回各通道的送达数。
 *
 * ⚠️ 这里是 2026-11-20「7 点没收到提醒」的核心：
 * 原先只 injectProactiveMessage（桌面界面）。但任务往往是**在 QQ 里建的**，
 * 到点时桌面可能压根没开 —— 消息就这么静默丢了，job 却已经标成 fired。
 *
 * 所以两条腿都走：能发 QQ 就发 QQ（用户在哪建的就在哪收到），
 * 再推一次桌面（顺便让桌宠说出来）。两边都没有才算真没送达。
 */
export function deliverResult(
    job: { uid: number; sessionId?: string },
    owner: string,
    taskId: string,
    speech: string,
): { sentDesktop: number; sentPlatform: number } {
    let sentDesktop = 0;
    let sentPlatform = 0;
    const sessionId = job.sessionId || sessionIdFor(owner, taskId);

    // ① 桌面
    if (resultPusher) {
        try {
            sentDesktop = resultPusher({
                uid: job.uid ?? 1,
                owner,
                speech,
                sessionId,
                taskId,
                title: taskId,
            })
                ? 1
                : 0;
        } catch (e) {
            console.warn("[wsTask] 推送桌面失败（已忽略）:", (e as Error)?.message || e);
        }
    }

    // ② 原会话所在平台。sessionId 是 `bot-<adapterId>-<conversationKey>` 才发得出去；
    //    桌面本地会话（纯 uuid）没有平台通道，只能靠 ①。
    if (platformSender) {
        try {
            if (platformSender({ sessionId, text: speech })) sentPlatform = 1;
        } catch (e) {
            console.warn("[wsTask] 回发平台消息失败（已忽略）:", (e as Error)?.message || e);
        }
    }

    if (!sentDesktop && !sentPlatform) {
        // 这个 warn 是刻意留的：以前这种情况完全静默，出了问题只能靠猜。
        console.warn(
            `[wsTask] ⚠️ ${owner}/${taskId} 的结果没有送达任何地方`
                + `（桌面没收到、sessionId=${sessionId} 也不是平台会话）。内容：${speech.slice(0, 60)}`,
        );
    } else {
        console.log(
            `[wsTask] ${owner}/${taskId} 结果送达：桌面 ${sentDesktop ? 1 : 0} 个、平台 ${sentPlatform ? 1 : 0} 条`,
        );
    }
    return { sentDesktop, sentPlatform };
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
        sessionId?: string;
    },
    _now = Date.now(),
): Promise<boolean> {
    const payload = parsePayload(job.payload);
    if (!payload || !payload.taskId) {
        console.warn(`[wsTask] job=${job.jobId} 的 payload 无法解析，跳过本次`);
        // 返回 true：payload 坏了就永远跑不了，卡成 pending 只会每 15s 报错一次
        return true;
    }
    const taskId = payload.taskId;
    const instruction = payload.instruction || "";
    const uid = job.uid ?? 1;
    const deliver = payload.deliver !== false;

    // owner 三级兜底，顺序有讲究：
    //   1) payload.owner —— 建任务时就存下来的，最准
    //   2) job.sessionId 里的 owner —— 老格式没有 payload.owner 时退而求其次
    //   3) LEGACY_OWNER —— 都没有。宁可落到 _legacy 目录，也**不能**回退成「公共目录」：
    //      那会让所有历史任务重新混在一起，隔离白做。
    let owner = payload.owner || ownerFromSession(job.sessionId || "") || "";
    if (!owner) owner = LEGACY_OWNER;

    try {
        const meta = workspace.readTaskMeta(owner, taskId) || ({} as workspace.TaskMeta);
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
            // sessionId 用 workspace:<owner>:<taskId>，主机据此认出这是谁的任务。
            const safeId = workspace.safeSegment(taskId, "taskId");
            const content = JSON.stringify({ owner, taskId: safeId, title, instruction });
            let res: { speech: string } | null = null;
            try {
                res = await relaySender({ sessionId: sessionIdFor(owner, safeId), content });
            } catch (e) {
                console.warn(`[wsTask] 叶子上行异常（${owner}/${taskId}）:`, (e as Error)?.message || e);
                res = null;
            }
            if (!res) {
                // 但仍返回 true：job 必须顺延，否则 15s 一次热重试打向一个连不上的主机。
                // 但**不记运行次数**：任务其实没跑成，meta 里不该多一次。
                console.warn(`[wsTask] 叶子转发失败（${owner}/${taskId}），本轮跳过，任务顺延`);
                return true;
            }
            console.log(
                `[wsTask] 叶子任务 ${owner}/${taskId} 已由主机执行完成（${Date.now() - startedAt}ms，产出写在主机）`,
            );
            const speech = String(res.speech || "").trim();
            if (deliver && speech) deliverResult(job, owner, taskId, speech);
            return true;
        }

        // ── 主机 / 单机：本地执行 ──
        const result = await runLocally({ owner, taskId, title, instruction, uid, sessionId: job.sessionId });
        if (deliver && result.ok) {
            deliverResult(job, owner, taskId, result.speech || `「${title}」跑完了。`);
        }
        return true;
    } catch (e) {
        // 任何异常都不该让 job 卡在 pending（会 15s 一次热循环）
        console.warn(`[wsTask] 触发 job=${job.jobId} 异常：`, e instanceof Error ? e.message : e);
        return true;
    }
}
