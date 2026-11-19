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
import * as workspace from "../services/workspace";

/** 最多列几个任务（再多就只说总数，让她用 tasks 动作自己看）。 */
export const MAX_TASKS_IN_PROMPT = 8;

export function buildWorkspaceBlock(): string {
    let o: ReturnType<typeof workspace.overview>;
    try {
        o = workspace.overview();
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
        "- 主人要你「定期做某件并留下结果」时，用 schedule_task 建定期任务；" +
            "只是「到点提醒一句」用 schedule_reminder。",
    );
    lines.push(
        "- 说到「记下来」时想清楚：进记忆池的是「你记得的事」，进工作空间的是「能翻到的文件」。" +
            "主人要文件就写文件，别只说记住了。",
    );
    return lines.join("\n");
}
