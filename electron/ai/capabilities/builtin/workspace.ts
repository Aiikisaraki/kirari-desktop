// electron/ai/capabilities/builtin/workspace.ts
// 内置能力：workspace —— 她对自己工作空间（真实文件夹）的完整文件操作。与核心版对称。
//
// 用户 2026-11-19 原话：
//   「这个空间文件夹是一个独立的文件夹，放在用户目录下，下面再分为不同的任务
//     所属的文件夹」
//   「完整（含删除/新建目录）」——她拿到的是真 CRUD，不是只读。
//
// 因此路径安全全部下沉到 services/workspace 里做（逐段校验 + path.relative 复核），
// 这个文件只负责：参数校验、把异常转成人话、把结果整理成可读文本。
// 任何异常都返回 "error: ..." 而不是抛出——工具报错不该让整轮对话崩掉。
import { defineCapability, type Capability } from "kirari-agent";
import * as workspace from "../../services/workspace";

// 枚举内联：registry 用 eager glob 加载 builtin，顶层读外部数组容易拿到未初始化值。
const ACTION_ENUM = [
    "overview",
    "tasks",
    "ls",
    "read",
    "write",
    "append",
    "mkdir",
    "rm",
    "rm_task",
    "prune",
];

/** 这些文件框架在用，不许她删（删了任务就失联了）。 */
const RESERVED_FILES = ["meta.json"];

const capability: Capability = defineCapability({
    id: "workspace",
    name: "workspace",
    kind: "tool",
    scope: "builtin",
    description:
        "你的工作空间：一个真实文件夹，每个定期任务在里面有自己的子文件夹，用来保存产出。" +
        "action：" +
        "overview（空间在哪、几个任务、占多少——先看这个）、" +
        "tasks（列出所有任务文件夹和最近运行时间）、" +
        "ls（列某个任务里的文件，需 taskId，可给 path 进子目录）、" +
        "read（读文件，需 taskId + path）、" +
        "write（写文件，需 taskId + path + content；父目录会自动建）、" +
        "append（在文件末尾追加，需 taskId + path + content）、" +
        "mkdir（建子目录，需 taskId + path）、" +
        "rm（删单个文件或空目录，需 taskId + path）、" +
        "rm_task（删掉整个任务文件夹，需 taskId——不可恢复，先跟主人确认）、" +
        "prune（按保留策略清理旧产出，需 taskId；不给就清全部）。" +
        "什么时候用：主人让你「保存/记到文件/整理成一份东西」时写文件；" +
        "做定期任务时先 ls + read 看上次写了什么，再写今天的。" +
        "注意：写进这儿的东西会一直留着，跟你的记忆池是两回事——" +
        "记忆是你记得的事，工作空间是能翻到的文件。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ACTION_ENUM, description: "要执行的动作。" },
            taskId: {
                type: "string",
                description: "任务文件夹的 id（就是 tasks 里看到的那个名字）。除 overview/tasks/prune 外都必填。",
            },
            path: {
                type: "string",
                description: "任务文件夹内的相对路径，如 notes/2026-11-19.md。不要用绝对路径或 ..。",
            },
            content: { type: "string", description: "write/append 要写入的文本内容。" },
        },
        required: ["action"],
    },
    tags: ["builtin", "workspace", "files"],
});

function fail(e: unknown): string {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
}

function fmtSize(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function dispatch(args: any, _ctx: any): Promise<string> {
    const a = args || {};
    const action = String(a.action || "").trim();
    const taskId = a.taskId == null ? "" : String(a.taskId);
    const relPath = a.path == null ? "" : String(a.path);

    // 需要 taskId 的动作统一先检查，报错要指明缺什么（她才知道下一步怎么补）
    const needsTask = ["ls", "read", "write", "append", "mkdir", "rm", "rm_task", "prune"];
    if (needsTask.includes(action) && !taskId) {
        if (action === "prune") {
            // prune 允许不带 taskId（清全部），下面单独处理
        } else {
            return `error: action=${action} 需要 taskId（先用 tasks 看有哪些任务）`;
        }
    }

    try {
        switch (action) {
            case "overview": {
                const o = workspace.overview();
                if (!o.exists) {
                    return `工作空间还没创建，第一次写入时会自动建好。位置会是：${o.root}`;
                }
                const lines = [`工作空间：${o.root}`, `任务 ${o.tasks} 个，文件 ${o.files} 个，共 ${fmtSize(o.bytes)}`];
                if (o.list.length) {
                    lines.push("任务列表（最近运行在前）：");
                    for (const t of o.list) {
                        const last = t.lastRunAt ? `最近运行 ${t.lastRunAt}（共 ${t.runCount} 次）` : "还没运行过";
                        lines.push(`  - ${t.taskId}「${t.title}」：${t.files} 个文件 ${fmtSize(t.bytes)}，${last}`);
                    }
                } else {
                    lines.push("还没有任务文件夹。");
                }
                return lines.join("\n");
            }

            case "tasks": {
                const list = workspace.listTasks();
                if (!list.length) return `还没有任务文件夹。空间位置：${workspace.rootDir()}`;
                const lines = [`共 ${list.length} 个任务：`];
                for (const t of list) {
                    const last = t.lastRunAt ? `最近运行 ${t.lastRunAt}（共 ${t.runCount} 次）` : "还没运行过";
                    lines.push(`- ${t.taskId}「${t.title}」：${t.files} 个文件 ${fmtSize(t.bytes)}，${last}`);
                    if (t.title && t.title !== t.taskId) lines.push(`  文件夹：${t.dir}`);
                }
                return lines.join("\n");
            }

            case "ls": {
                const entries = workspace.listFiles(taskId, relPath);
                const where = relPath ? `${taskId}/${relPath}` : taskId;
                if (!entries.length) return `${where} 是空的。`;
                const lines = [`${where}（${entries.length} 项）：`];
                for (const e of entries) {
                    lines.push(e.dir ? `- ${e.name}/` : `- ${e.name}  ${fmtSize(e.size)}  ${e.mtime}`);
                }
                if (entries.length >= workspace.LIMITS.listEntries) {
                    lines.push(`（只显示前 ${workspace.LIMITS.listEntries} 项，用 path 进子目录看更细）`);
                }
                return lines.join("\n");
            }

            case "read": {
                if (!relPath) return "error: read 需要 path（先用 ls 看有什么文件）";
                const text = workspace.readFile(taskId, relPath);
                return `【${taskId}/${relPath}】\n${text}`;
            }

            case "write": {
                if (!relPath) return "error: write 需要 path（写到哪个文件）";
                const content = a.content == null ? "" : String(a.content);
                const bytes = workspace.writeFile(taskId, relPath, content);
                return `已写入 ${taskId}/${relPath}（${fmtSize(bytes)}）`;
            }

            case "append": {
                if (!relPath) return "error: append 需要 path（追加到哪个文件）";
                const content = a.content == null ? "" : String(a.content);
                // 复用 read + write 而不是 appendFileSync：这样大小上限、路径校验、
                // 父目录自动创建都走同一条代码路径，不会出现「追加能绕过检查」的洞。
                let prev = "";
                try {
                    prev = workspace.readFile(taskId, relPath);
                } catch {
                    prev = ""; // 文件还不存在就当新建
                }
                const next = prev ? `${prev.replace(/\s*$/, "")}\n\n${content}` : content;
                const bytes = workspace.writeFile(taskId, relPath, next);
                return `已追加到 ${taskId}/${relPath}（现在 ${fmtSize(bytes)}）`;
            }

            case "mkdir": {
                if (!relPath) return "error: mkdir 需要 path（要建的目录名）";
                const abs = workspace.mkdir(taskId, relPath);
                return `已建目录：${abs}`;
            }

            case "rm": {
                if (!relPath) return "error: rm 需要 path（要删什么）。要删整个任务用 rm_task";
                const base = relPath.split(/[\\/]+/).filter(Boolean).pop() || "";
                if (RESERVED_FILES.includes(base)) {
                    return `error: ${base} 是框架文件，不能删（删了任务就失联了）`;
                }
                const r = workspace.remove(taskId, relPath);
                if (!r.removed) return `${taskId}/${relPath} 本来就不存在。`;
                return `已删除 ${taskId}/${relPath}${r.dir ? "（目录）" : ""}`;
            }

            case "rm_task": {
                const meta = workspace.readTaskMeta(taskId);
                const r = workspace.removeTask(taskId);
                if (!r.removed) return `任务 ${taskId} 本来就不存在。`;
                return `已删除整个任务文件夹「${meta.title || taskId}」（${taskId}），里面的文件一起没了。`;
            }

            case "prune": {
                if (taskId) {
                    const meta = workspace.readTaskMeta(taskId);
                    const r = workspace.pruneTask(taskId);
                    const p = meta.retention;
                    return `已按保留策略清理 ${taskId}：删掉 ${r.deleted} 个旧文件，释放 ${fmtSize(r.freedBytes)}。`
                        + `（当前策略：留 ${p.keepFiles} 个 / ${p.keepDays} 天 / ${fmtSize(p.keepBytes)}）`;
                }
                const r = workspace.pruneAll();
                return `已清理全部任务：删掉 ${r.deleted} 个旧文件，释放 ${fmtSize(r.freedBytes)}。`;
            }

            default:
                return `error: 不认识的 action "${action}"，可用：${ACTION_ENUM.join(" / ")}`;
        }
    } catch (e) {
        return fail(e);
    }
}

export { capability, dispatch };
