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
//
// ── 按人隔离（2026-11-20 用户原话）──────────────────────────────
//   「我今天把机器人转发给了我一个朋友，她是私聊我的机器人，建立了几个每日任务，
//     但是我怎么可以直接看到她的任务呢，就算是主人权限，也是优先说我有几个，
//     然后再说可能还有别人的，我确认了才能看别人的啊！！」
//
// 所以这个能力里 owner **不是模型能传的参数**：它只从 ctx（此刻在跟谁说话）解析。
// 模型无法通过编造 owner 去读别人的目录 —— 参数里根本没有这个入口。
//
// 主人要看别人的，必须两步：
//   ① 调 action=others（不带 confirm）→ 只回「还有 N 个人的任务，要不要看」
//   ② 用户明确说要 → 再调 action=others + confirm=true → 才真的列出
// 第 ② 步的 confirm 是模型照着用户的话填的，不是它自己决定的。
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
    "others",
];

/** 这些文件框架在用，不许她删（删了任务就失联了）。 */
const RESERVED_FILES = ["meta.json"];

/**
 * 解析「这个工作空间属于谁」。
 *
 * 只认 ctx，绝不看模型传的参数 —— 这是隔离的根，参数化就等于把钥匙给了模型。
 * 具体规则收敛在 services/workspace.resolveOwnerFromCtx 里，这里只是转发；
 * 建任务、提示词注入块都用同一份，避免三处判断漂移。
 */
function resolveOwner(ctx: any = {}): string {
    return workspace.resolveOwnerFromCtx(ctx);
}

const capability: Capability = defineCapability({
    id: "workspace",
    name: "workspace",
    kind: "tool",
    scope: "builtin",
    description:
        "你的工作空间：一个真实文件夹，每个定期任务在里面有自己的子文件夹，用来保存产出。" +
        "⚠️ 工作空间按人分开：你只能看到并操作**此刻正在跟你说话的那个人**的任务，看不到别人的。" +
        "action：" +
        "overview（空间在哪、几个任务、占多少——先看这个）、" +
        "tasks（列出当前这个人的任务文件夹和最近运行时间）、" +
        "ls（列某个任务里的文件，需 taskId，可给 path 进子目录）、" +
        "read（读文件，需 taskId + path）、" +
        "write（写文件，需 taskId + path + content；父目录会自动建）、" +
        "append（在文件末尾追加，需 taskId + path + content）、" +
        "mkdir（建子目录，需 taskId + path）、" +
        "rm（删单个文件或空目录，需 taskId + path）、" +
        "rm_task（删掉整个任务文件夹，需 taskId——不可恢复，先跟对方确认）、" +
        "prune（按保留策略清理旧产出，需 taskId；不给就清全部）、" +
        "others（只看别人有没有任务。不带 confirm 时只回答「有几个人的、要不要看」；" +
        "必须等用户明确说要之后，才能带 confirm=true 再调一次去看内容）。" +
        "什么时候用：用户让你「保存/记到文件/整理成一份东西」时写文件；" +
        "做定期任务时先 ls + read 看上次写了什么，再写今天的。" +
        "注意：写进这儿的东西会一直留着，跟你的记忆池是两回事——" +
        "记忆是你记得的事，工作空间是能翻到的文件。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ACTION_ENUM, description: "要执行的动作。" },
            taskId: {
                type: "string",
                description: "任务文件夹的 id（就是 tasks 里看到的那个名字）。除 overview/tasks/others 外都必填。",
            },
            path: {
                type: "string",
                description: "任务文件夹内的相对路径，如 notes/2026-11-19.md。不要用绝对路径或 ..。",
            },
            content: { type: "string", description: "write/append 要写入的文本内容。" },
            title: {
                type: "string",
                description: "建任务文件夹时的人类可读标题（存进 meta.json，文件夹名仍用 taskId）。",
            },
            confirm: {
                type: "boolean",
                description:
                    "只有 action=others 用。仅当用户已经明确表示「要看别人的任务」之后，才设为 true；" +
                    "用户没说就不要带这个参数。",
            },
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

/** 摘要一行：给 tasks / others / overview 共用。 */
function taskLine(t: workspace.TaskListItem): string {
    const last = t.lastRunAt ? `最近运行 ${t.lastRunAt}（共 ${t.runCount} 次）` : "还没运行过";
    return `- ${t.taskId}「${t.title}」：${t.files} 个文件 ${fmtSize(t.bytes)}，${last}`;
}

async function dispatch(args: any, ctx: any = {}): Promise<string> {
    const a = args || {};
    const action = String(a.action || "").trim().toLowerCase();
    if (!ACTION_ENUM.includes(action)) {
        return `error: 不认识的 action "${a.action}"，可用：${ACTION_ENUM.join(" / ")}`;
    }

    let owner: string;
    try {
        owner = resolveOwner(ctx);
    } catch (e) {
        return fail(e);
    }

    // ── others：看别人的任务，必须两步 ──
    if (action === "others") {
        try {
            // 统一走 selfOps.roleOf —— 全仓只留一个角色判定入口。
            // 原来这里直接读 ctx.role，而 self_read/self_manage 走 roleOf 兜底，
            // 造成「安全侧误伤主人（others 拒绝）、危险侧放行外人（settings 可读）」
            // 的判据分裂。身份判定必须只有一个真相源。
            //
            // 这里刻意用**函数内动态 import** 而不是顶层 import：
            // selfOps → capabilities/registry →（eager glob）builtin/workspace，
            // 顶层 import 会立刻构成循环，模块初始化顺序一变就拿到 undefined。
            // core 那边是 require()，同样是延迟加载，语义一致。
            const selfOps = await import("../../services/selfOps");
            const isOwner = selfOps.roleOf(ctx) === "owner";
            if (!isOwner) {
                // 连「有两三个别人」都不该泄露给普通用户 —— 那本身就是别人的信息。
                return "你的工作空间里只有你自己的任务，没有别的可看。";
            }
            const others = workspace.listOwners().filter((o) => o.owner !== owner);
            if (!others.length) return "除了你自己，没有别人在这里建过任务。";

            const brief = others.map((o) => `- ${o.owner}：${o.tasks} 个任务`).join("\n");
            const mine = workspace.listTasks(owner).length;

            if (a.confirm !== true) {
                // 第一次只报「有几个人的」，不给内容。等用户点头再调一次带 confirm。
                return (
                    `你自己有 ${mine} 个任务。` +
                    `\n另外还有 ${others.length} 个用户的 ${others.reduce((n, o) => n + o.tasks, 0)} 个任务：\n${brief}` +
                    "\n\n要看他们的具体内容吗？你说要，我再看。"
                );
            }

            // 第二次（用户已确认）：真的列出来
            const blocks = others.map((o) => {
                const lines = workspace.listTasks(o.owner).map(taskLine);
                return `【${o.owner}】${o.tasks} 个任务：\n${lines.join("\n")}`;
            });
            return `你自己有 ${mine} 个任务。\n\n${blocks.join("\n\n")}`;
        } catch (e) {
            return fail(e);
        }
    }

    // 空间概览：不需要 taskId
    if (action === "overview") {
        try {
            const o = workspace.overview(owner);
            const lines: string[] = [
                `工作空间位置：${o.root}`,
                `已存在：${o.exists ? "是" : "否（首次写入时会自动创建）"}`,
                `任务文件夹：${o.tasks} 个，共 ${o.files} 个文件、${fmtSize(o.bytes)}`,
            ];
            if (o.list.length) {
                lines.push("", "任务列表（最近运行在前）：");
                for (const t of o.list.slice(0, 20)) lines.push(`  ${taskLine(t)}`);
                if (o.list.length > 20) {
                    lines.push(`（还有 ${o.list.length - 20} 个未列出，用 tasks 看全部）`);
                }
            }
            return lines.join("\n");
        } catch (e) {
            return fail(e);
        }
    }

    if (action === "tasks") {
        try {
            const list = workspace.listTasks(owner);
            if (!list.length) return "你的工作空间里还没有任务文件夹。";
            return [`共 ${list.length} 个任务：`]
                .concat(
                    list.map((t) => {
                        const line = taskLine(t);
                        return t.title && t.title !== t.taskId ? `${line}\n  文件夹：${t.dir}` : line;
                    }),
                )
                .join("\n");
        } catch (e) {
            return fail(e);
        }
    }

    // 其余操作都要 taskId
    const taskId = a.taskId == null ? "" : String(a.taskId).trim();
    if (!taskId) return "error: 这个操作需要 taskId（任务文件夹名）。先用 tasks 看看有哪些。";
    const relPath = a.path == null ? "" : String(a.path);

    try {
        switch (action) {
            case "ls": {
                const entries = workspace.listFiles(owner, taskId, relPath);
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
                const text = workspace.readFile(owner, taskId, relPath);
                return `【${taskId}/${relPath}】\n${text}`;
            }

            case "write": {
                if (!relPath) return "error: write 需要 path（写到哪个文件）";
                const content = a.content == null ? "" : String(a.content);
                const bytes = workspace.writeFile(owner, taskId, relPath, content);
                // 写文件视为「这个任务今天动过」，顺便把 meta 建起来
                workspace.ensureTask(owner, taskId, { title: a.title });
                return `已写入 ${taskId}/${relPath}（${fmtSize(bytes)}）`;
            }

            case "append": {
                if (!relPath) return "error: append 需要 path（追加到哪个文件）";
                const content = a.content == null ? "" : String(a.content);
                // 复用 read + write 而不是 appendFileSync：这样大小上限、路径校验、
                // 父目录自动创建都走同一条代码路径，不会出现「追加能绕过检查」的洞。
                let prev = "";
                try {
                    prev = workspace.readFile(owner, taskId, relPath);
                } catch {
                    prev = ""; // 文件还不存在就当新建
                }
                const next = prev ? `${prev.replace(/\s*$/, "")}\n\n${content}` : content;
                const bytes = workspace.writeFile(owner, taskId, relPath, next);
                workspace.ensureTask(owner, taskId, { title: a.title });
                return `已追加到 ${taskId}/${relPath}（现在 ${fmtSize(bytes)}）`;
            }

            case "mkdir": {
                if (!relPath) return "error: mkdir 需要 path（要建的目录名）";
                const abs = workspace.mkdir(owner, taskId, relPath);
                workspace.ensureTask(owner, taskId, { title: a.title });
                return `已建目录：${abs}`;
            }

            case "rm": {
                if (!relPath) return "error: rm 需要 path（要删什么）。要删整个任务用 rm_task";
                const base = relPath.split(/[\\/]+/).filter(Boolean).pop() || "";
                if (RESERVED_FILES.includes(base)) {
                    return `error: ${base} 是框架文件，不能删（删了任务就失联了）`;
                }
                const r = workspace.remove(owner, taskId, relPath);
                if (!r.removed) return `${taskId}/${relPath} 本来就不存在。`;
                return `已删除 ${taskId}/${relPath}${r.dir ? "（目录）" : ""}`;
            }

            case "rm_task": {
                const meta = workspace.readTaskMeta(owner, taskId);
                const r = workspace.removeTask(owner, taskId);
                if (!r.removed) return `任务 ${taskId} 本来就不存在。`;
                return `已删除整个任务文件夹「${meta.title || taskId}」（${taskId}），里面的文件一起没了。`;
            }

            case "prune": {
                const meta = workspace.readTaskMeta(owner, taskId);
                const r = workspace.pruneTask(owner, taskId);
                const p = meta.retention;
                return (
                    `已按保留策略清理 ${taskId}：删掉 ${r.deleted} 个旧文件，释放 ${fmtSize(r.freedBytes)}。` +
                    `（当前策略：留 ${p.keepFiles} 个 / ${p.keepDays} 天 / ${fmtSize(p.keepBytes)}）`
                );
            }

            default:
                return `error: 不认识的 action "${action}"，可用：${ACTION_ENUM.join(" / ")}`;
        }
    } catch (e) {
        return fail(e);
    }
}

export { capability, dispatch, ACTION_ENUM, RESERVED_FILES, resolveOwner };
