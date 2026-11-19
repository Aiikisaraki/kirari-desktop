// electron/ai/reply/workspaceBlock.ts
// 把「我有一个工作空间」这件事注入 system.base。与核心版对称。
//
// ── 为什么必须注入，而不是让她每次先调工具 ────────────────────────
// social 那层踩过的坑：能力摆在那儿，但她不知道自己有，被问「能看到几个群吗」
// 会答「我没有这个接口」。工作空间同理——不告诉她，用户说「把这份记下来」
// 她只会答「我记住了」（其实只进了记忆池，文件管理器里翻不到）。
//
// ── 为什么只报概览，不列文件 ──────────────────────────────────────
// 任务文件夹里的文件名会越积越多，全量列进提示词会挤占上下文，绝大多数跟当前
// 这轮对话无关。所以只给「在哪、几个任务、每个任务最近跑没跑」，要看具体文件
// 让她自己调 workspace 的 ls / read。
//
// ── 注入段数不变 ──────────────────────────────────────────────────
// 提示词注入器固定 4 段（system.base / daily_brief / knowledge / skills）。
// 这个块是追加到 system.base 文本里的，不新增段。
//
// ── 按人隔离（2026-11-20）────────────────────────────────────────
// 工作空间按 owner 分目录，这个注入块也必须只报**当前这个人的**任务。
// 否则朋友会从提示词里看到主人的任务名——比她自己调工具看到还糟，
// 因为那是「不问她就能知道」，连确认的机会都没有。
import * as workspace from "../services/workspace";

/** 最多列几个任务（再多就只说总数，让她用 tasks 动作自己看）。 */
export const MAX_TASKS_IN_PROMPT = 8;

/** 「此刻在跟谁说话」的最小上下文 —— 与能力层的 ctx 同一个来源。 */
export type WorkspaceBlockCtx = {
    sessionId?: string;
    uid?: number | string;
    counterpartId?: string;
    senderId?: string;
    role?: string | null;
    isGroup?: boolean;
};

/**
 * 解析注入块该用谁的工作空间。
 * 规则收敛在 services/workspace.resolveOwnerFromCtx，三处共用一份。
 */
export function resolveOwnerForBlock(ctx: WorkspaceBlockCtx = {}): string {
    try {
        return workspace.resolveOwnerFromCtx(ctx);
    } catch {
        return workspace.ownerDirName(workspace.LOCAL_OWNER);
    }
}

/**
 * 生成工作空间段。任何异常都返回 ""（注入失败不该影响正常回答）。
 * @param ctx 可选，「此刻在跟谁说话」。不给则按本机/控制台处理。
 */
export function buildWorkspaceBlock(ctx: WorkspaceBlockCtx = {}): string {
    let o: ReturnType<typeof workspace.overview>;
    try {
        const owner = resolveOwnerForBlock(ctx);
        o = workspace.overview(owner);
    } catch {
        return "";
    }

    const lines: string[] = [];
    lines.push("");
    lines.push("【你的工作空间 · 这些是事实】");
    lines.push(`- 你有一个真实的文件夹：${o.root}`);
    lines.push("- 每个定期任务在里面有一个自己的子文件夹，用来保存它的产出。");

    if (!o.exists) {
        lines.push("- 现在这个文件夹还没有创建，第一次写入时会自动建好。");
    } else if (!o.tasks) {
        lines.push("- 现在里面还没有任务文件夹。");
    } else {
        lines.push(
            `- 现有 ${o.tasks} 个任务文件夹，共 ${o.files} 个文件、约 ${(o.bytes / 1024).toFixed(1)}KB。`,
        );
        const shown = o.list.slice(0, MAX_TASKS_IN_PROMPT);
        for (const t of shown) {
            const last = t.lastRunAt ? `最近运行 ${t.lastRunAt}` : "还没运行过";
            lines.push(`  · ${t.taskId}「${t.title}」：${t.files} 个文件，${last}`);
        }
        if (o.list.length > shown.length) {
            lines.push(`  · （另有 ${o.list.length - shown.length} 个未列出）`);
        }
    }

    lines.push(
        "- 想看/写/整理里面的东西就用 workspace 能力（ls / read / write / append / mkdir / rm）。",
    );
    lines.push(
        "- ⚠️ 这个工作空间是**按人分开的**：这里列出的只是「此刻跟你说话的这个人的」任务。" +
            "别人的任务你看不到，就算你是主人也一样。要看别人的必须先问、得到明确同意才行" +
            "（workspace 的 others 动作）；没得到同意之前，连「有几个人的任务」都别主动说。",
    );
    lines.push(
        "- 用户要你「定期做某件并留下结果」时，用 schedule_task 建定期任务；" +
            "只是「到点提醒一句」用 schedule_reminder。",
    );
    lines.push(
        "- 说到「记下来」时想清楚：进记忆池的是「你记得的事」，进工作空间的是「能翻到的文件」。" +
            "用户要文件就写文件，别只说记住了。",
    );
    return lines.join("\n");
}
