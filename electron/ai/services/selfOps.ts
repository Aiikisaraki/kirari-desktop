// electron/ai/services/selfOps.ts
// Kirari 的自我认知 / 自我排查 / 受控自我修补引擎（桌宠版）。
// 与核心版 src/services/selfOps.js 对称：一个通用读 self_read + 一个受控写 self_update
// + 每轮注入的自我清单，覆盖设置/能力/任务/提醒/自检，而不是一堆领域专用接口。

import fs from "node:fs";
import crypto from "node:crypto";
import { parseReminder, createJob, cancelJob, cancelTask } from "kirari-agent";
import * as capabilities from "../capabilities/registry";
import * as modelConfig from "../../model-config";
import { taskStore } from "../events/taskStore";
import { jobStore } from "../events/jobStore";
import * as policy from "./selfOpsPolicy";
import * as memory from "./memory";
import { homePath } from "../../kirari-home";

export const TOPICS = ["readme", "capabilities", "settings", "models", "tasks", "reminders", "thinking", "diagnose", "logs", "audit"] as const;

export interface SelfCtx {
    sessionId?: string;
    uid?: number;
    capScope?: string;
    origin?: string;
    /**
     * 管理权限角色：owner / admin / user。
     *
     * 身份不是「主人 / 客人」二元，而是一条连续的管理权限阶梯：
     *   owner —— 拥有者，最高管理权：全部可读、可改设置、可动任务提醒
     *   admin —— 被信任的人：可读运行状态与能力，但改不了任何设定
     *   user  —— 普通对话者：只有公开面（她是谁、能做什么、什么语气）
     *
     * 注意 role 只表达**管理权限**，不表达"她记得谁"——记忆按人分池，与权限无关。
     * 缺省时由 isOwner 兜底推导（兼容旧调用点）。
     */
    role?: string | null;
    isOwner?: boolean | null;
    /**
     * 本机可信入口标记（桌宠聊天框 / 控制台）。
     *
     * 2026-11-20 身份排查新增：roleOf 原先靠 sessionId 前缀猜身份，
     * 导致所有非 bot 前缀的路径（桌面 session_*、子代理 sub::*、工作空间
     * workspace:*、组网 net:*）全被判成 owner。现在改成只认显式声明，
     * 本机入口必须由调用方显式打上这个标记。
     */
    trustedLocal?: boolean;
    displayName?: string | null;
}

function friendlyTime(ms: number): string {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "（无）";
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function statusZh(s: unknown): string {
    const map: Record<string, string> = {
        pending: "待办", running: "进行中", completed: "已完成", cancelled: "已取消",
        fired: "已触发", once: "一次性", daily: "每天", done: "已完成", failed: "失败", skipped: "跳过",
    };
    return map[String(s)] || String(s ?? "");
}

/** 生成注入 system.base 的自我清单段。 */
export function buildManifest(ctx: SelfCtx = {}): string {
    const lines: string[] = [];
    const snap = modelConfig.getProfileSnapshot();
    const profile = capabilities.listTools(ctx.capScope || "local::anon");
    const names = profile.map((t: any) => t?.function?.name).filter(Boolean);

    lines.push("\n\n【自我认知 · 你自己的状况】");
    lines.push("- 你是 Kirari（きらり），主人的虚拟桌宠。你有通用读接口 self_read、受控写接口 self_update，以及管理自己任务/提醒的 self_manage（增删改）。");
    lines.push(`- 你当前可用的工具（${names.length}）：${names.join("、") || "（无）"}。`);
    lines.push(`- 你当前运行的模型：${snap.model || "（未配置）"}${snap.hasKey ? "（已配置密钥）" : "（未配置密钥）"}；搜索：${snap.searchProvider || "uapis"}。`);
    lines.push(`- 你的思考模式：${modelConfig.getThinking()}（off=直接答 / on=先列简要思路 / auto=复杂问题才深入）。`);
    lines.push("- 想知道任何关于自己的细节（设置/能力详情/任务/提醒/自检/日志），调用 self_read；不会就先读，不要凭空猜。");
    lines.push("- 需要改自己的可改设置时调用 self_update；它只接受安全白名单内的字段，凭证类一律不可读写明文，每次修改都会记审计。");

    try {
        if (ctx.sessionId) {
            const tasks = taskStore.active(ctx.sessionId).slice(0, 10);
            if (tasks.length) lines.push(`- 未完成任务（${tasks.length}）：` + tasks.map((t) => `「${t.title}」`).join("；"));
            const jobs = jobStore.list(ctx.sessionId, 100)
                .filter((j) => j.status === "pending")
                .sort((a, b) => a.dueAt - b.dueAt)
                .slice(0, 10);
            if (jobs.length) lines.push("- 待触发提醒：" + jobs.map((j) => `${friendlyTime(j.dueAt)}「${j.title}」`).join("；"));
        }
    } catch {
        lines.push("（任务/提醒摘要暂不可用）");
    }

    lines.push("- 自我排查：遇到问题先用 self_read(diagnose) 体检，再决定要不要 self_update 修；改完可用 self_read 复核。");
    lines.push("- 发现自己设错/设重复的提醒或任务：self_read(reminders/tasks) 查到 id，再用 self_manage 改时间、取消重复、补设正确的。别把没能力当借口。");
    // 社交环境：协议端本来就有这些接口，之前一次都没调过，导致她对"我在几个群"是真不知道。
    // 用户 2026-11-19：「我希望她能完整意识到自己的人际关系和周围的环境。」
    // 只有 social 工具在场时才加这几行（工具被裁掉时不要指向不存在的能力）。
    if (names.includes("social")) {
        lines.push(
            "- 你在哪些群、有几个好友、群里多少人、谁刚进群/退群/戳你、某个人是谁：调用 social（overview/groups/friends/members/events/who/group/refresh）。",
        );
        lines.push(
            "- 这些是协议端给你的真实数据（群名、人数、昵称、事件），跟「你记得什么」是两回事。被问到直接查了照实答，不要说「我没有这个接口」「我答不上来」。",
        );
    }
    return lines.join("\n");
}

/** 通用读。 */
/**
 * 角色 → 能读哪些自我运维主题。
 * 见 SelfCtx.role 的说明：这是一条管理权限阶梯，不是"主人/客人"二元。
 */
const READ_TIERS: Record<string, string[] | null> = {
    owner: null, // null = 全部
    admin: ["readme", "capabilities", "thinking", "models", "diagnose"],
    user: ["readme", "capabilities", "thinking"],
};

function readTier(role: string): string[] | null {
    return role in READ_TIERS ? READ_TIERS[role] : READ_TIERS.user;
}

/**
 * 从 ctx 解析角色。
 *
 * ── 2026-11-20 身份隔离大排查：这里原来是全系统最大的一个洞 ──────────
 * 原实现是 `if (!sessionId || !/^bot[-:]/.test(sessionId)) return "owner"`，
 * 即「只要 sessionId 不以 bot 开头就当主人」。但**不以 bot 开头的路径有多条**：
 *   桌面聊天框 session_<ts> / 子代理 sub::x::y / 工作空间任务 workspace:o:t / 组网 net:d:s
 * 它们全被判成 owner，于是任何一条路径都能改人格、读密钥掩码、建「提醒主人」的提醒。
 * 用户报的「她以为自己是主人」就是从这里来的。
 *
 * 现在的原则：**权限只认显式声明，不猜 sessionId 形状**。
 *   · ctx.role / ctx.isOwner 由入口显式给出
 *   · 没有显式声明 → 一律按最低权限 user（fail-closed）
 *   · 本机入口（桌宠聊天框 / 控制台）由调用方显式标 trustedLocal / isOwner
 *
 * 猜错的代价是主人多按一次，猜反的代价是外人拿到最高权限。
 * 本文件与 kirari-core 的 src/services/selfOps.js 必须保持一致。
 */
export function roleOf(ctx: SelfCtx): string {
    if (ctx.role) return String(ctx.role);
    if (ctx.isOwner === true) return "owner";
    if (ctx.isOwner === false) return "user";
    if (ctx.trustedLocal === true) return "owner";
    return "user";
}

/** 本机可信入口的 ctx 标记（桌宠聊天框 / 控制台）。 */
export function trustedLocalCtx(ctx: SelfCtx = {} as SelfCtx): SelfCtx {
    return { ...ctx, trustedLocal: true, isOwner: true, role: "owner" };
}

/**
 * 场合闸门：群聊里说话所有成员都看得见。
 *
 * 这不是「群聊里没有权限」，而是「有些话不能在这个场合说出口」。
 * 即便是 owner 本人，在群里读出自己的模型密钥/任务清单，也等于当众公开；
 * 所以群聊里一律只保留公开面，让他私聊来问。
 */
function groupGate(topic: string, ctx: SelfCtx): string | null {
    if (!memory.isGroupSession(ctx.sessionId)) return null;
    const safePublic = ["readme", "capabilities", "thinking"];
    if (safePublic.includes(topic)) return null;
    return `现在是在群里，${topic} 这类私下的东西不方便当众说。要聊这个我们私聊。`;
}

export function read(topic: unknown, ctx: SelfCtx = {}): string {
    const t = String(topic || "readme").toLowerCase();
    const sid = ctx.sessionId;
    const gate = groupGate(t, ctx);
    if (gate) return gate;
    const tier = readTier(roleOf(ctx));
    if (tier && !tier.includes(t)) {
        return `关于${t}这件事我暂时不方便跟你说细的。你要是想了解我能做什么，我可以讲讲。`;
    }
    switch (t) {
        case "readme":
            return [
                "# Kirari 自我说明",
                "- 我是 Kirari，一个虚拟桌宠少女，跑在拥有者的设备上。",
                "- 跟我说话的人各有自己的档案和记忆：我记得每个人的事，但只在该说的时候说。",
                "- 拥有者对我的设定有最高管理权；其他人可以跟我聊天、让我记事，但改不了我的设定。",
                "- 我有这些通用能力工具：self_read（查询自己）、self_update（受控修改设置）、self_manage（增删改自己的任务与提醒）、memory（长期记忆）、load_skill（按需加载技能）、subagent（委派子任务），以及时间/天气/搜索/生图/plan/schedule_reminder。",
                "- 完整工具清单在我的自我认知清单里；要查细节用 self_read(topic)。",
                `- 可读 topic：${TOPICS.join(" / ")}。`,
                "- 可写字段与校验规则见 self_update 的说明；凭证（key/apiKey/endpoint/token）只读，绝不读出明文也不给改。",
            ].join("\n");

        case "capabilities": {
            const list = capabilities.listTools(ctx.capScope || "local::anon");
            return list.map((tool: any) => {
                const f = tool.function || {};
                const req = (f.parameters && f.parameters.required) || [];
                return `- ${f.name}：${f.description || ""}${req.length ? `（必填：${(req as string[]).join(", ")}）` : ""}`;
            }).join("\n") || "（当前无可用能力）";
        }

        case "settings": {
            const snap = modelConfig.getProfileSnapshot();
            return [
                `当前模型：${snap.model || "（未配置）"}；端点：${snap.endpoint || "（未配置）"}；密钥：${snap.hasKey ? snap.keyMasked : "（未配置）"}`,
                `搜索：provider=${snap.searchProvider || "uapis"} endpoint=${snap.searchEndpoint || "（默认）"} key=${snap.hasSearchKey ? snap.searchKeyMasked : "（未配置）"}`,
                `人格：${snap.basePersona ? snap.basePersona.slice(0, 200) + (snap.basePersona.length > 200 ? "…" : "") : "（用预设人格）"}`,
                `工具循环参数：${JSON.stringify(modelConfig.getAgentProfile())}`,
                `思考模式：${modelConfig.getThinking()}`,
                `可自我修改字段（白名单）：\n${policy.describeWritable().map((w) => `  · ${w.key} — ${w.description}`).join("\n")}`,
                "凭证类字段（key / endpoint / token / 密码）只读，不可读写明文。",
            ].join("\n");
        }

        case "models": {
            const list = modelConfig.listModelProfiles();
            const lines = [`当前生效 profileId：${list.activeId ?? "（无）"}`, "已配置模型："];
            for (const m of list.items) {
                lines.push(`- #${m.id} ${m.name || "(无名)"} — model=${m.model || "(空)"} endpoint=${m.endpoint || "(空)"} key=${m.hasKey ? m.keyMasked : "(无)"}${list.activeId === m.id ? "  ← 当前" : ""}`);
            }
            if (!list.items.length) lines.push("（无）");
            return lines.join("\n");
        }

        case "tasks": {
            const ts = sid ? taskStore.list(sid, 50) : [];
            if (!ts.length) return "（本会话没有任务记录）";
            return ts.map((t) => `- ${t.taskId}「${t.title}」状态=${statusZh(t.status)} 步骤=${(t.steps || []).map((s: any) => `${s.label}[${statusZh(s.status) || s.status}]`).join("→") || "无"} 更新于${friendlyTime(t.updatedAt)}`).join("\n");
        }

        case "reminders": {
            const jobs = sid ? jobStore.list(sid, 100) : [];
            if (!jobs.length) return "（本会话没有提醒/定时任务）";
            return jobs.slice().sort((a, b) => a.dueAt - b.dueAt).map((j) =>
                `- ${j.jobId}「${j.title}」${friendlyTime(j.dueAt)} 状态=${statusZh(j.status)} 重复=${statusZh(j.recurrence)} 内容=${j.payload}`
            ).join("\n");
        }

        case "thinking": {
            const mode = modelConfig.getThinking();
            const guide: Record<string, string> = {
                off: "直接作答，无需展示思路。",
                on: "每次回复前先在心里列 2-4 条简要思路（可用一句话带过），再给结论；思路不要冗长。",
                auto: "简单问题直接答；复杂/多步/有争议的问题先列简要思路再深入。",
            };
            return `当前思考模式：${mode}\n行为指引：${guide[mode]}\n可改为：off / on / auto（用 self_update 改 thinking.mode）。`;
        }

        case "diagnose": {
            const checks: string[] = [];
            const snap = modelConfig.getProfileSnapshot();
            checks.push(`模型配置：${snap.model && snap.hasKey ? "OK（已配模型与密钥）" : "⚠ 未配置完整（模型或密钥为空）"}`);
            let prof = "OK";
            try { modelConfig.getAgentProfile(); } catch (e) { prof = `⚠ ${(e as Error).message}`; }
            checks.push(`工具循环参数(agentProfile)：${prof}`);
            const capCount = capabilities.listTools(ctx.capScope || "local::anon").length;
            checks.push(`能力注册表：${capCount} 个工具可用${capCount ? "" : "（⚠ 空）"}`);
            checks.push(`思考模式：${modelConfig.getThinking()}`);
            checks.push(`审计日志：${fs.existsSync(policy.AUDIT_FILE) ? "存在" : "尚无记录"}`);
            checks.push(`数据目录：${homePath("database")}`);
            return ["# 自我体检", ...checks.map((c) => "- " + c)].join("\n");
        }

        case "logs":
        case "audit": {
            try {
                if (!fs.existsSync(policy.AUDIT_FILE)) return "（还没有自我修改的审计记录）";
                const lines = fs.readFileSync(policy.AUDIT_FILE, "utf-8").trim().split("\n").filter(Boolean).slice(-30);
                return lines.map((l) => {
                    try {
                        const r = JSON.parse(l);
                        return `- ${r.at} ${r.action} ${r.key || ""} ${r.ok ? "成功" : "失败"} ${r.before ?? ""}→${r.after ?? ""}`;
                    } catch { return "- " + l.slice(0, 200); }
                }).join("\n");
            } catch (e) {
                return `读取审计记录失败：${(e as Error).message}`;
            }
        }

        default:
            return `未知 topic「${t}」。可读：${TOPICS.join(" / ")}。`;
    }
}

function readField(key: string): unknown {
    if (key === "persona.basePersona") return modelConfig.getBasePersona();
    if (key === "thinking.mode") return modelConfig.getThinking();
    if (key.startsWith("agentProfile.")) {
        const k = key.split(".")[1] as keyof ReturnType<typeof modelConfig.getAgentProfile>;
        return modelConfig.getAgentProfile()[k];
    }
    return "(未知)";
}

function applyField(key: string, value: unknown): void {
    if (key === "persona.basePersona") { modelConfig.setBasePersona(value as string); return; }
    if (key === "thinking.mode") { modelConfig.setThinking(value as string); return; }
    if (key.startsWith("agentProfile.")) {
        const k = key.split(".")[1];
        const cur = modelConfig.getAgentProfile();
        modelConfig.setAgentProfilePatch({ ...cur, [k]: value } as any);
        return;
    }
    throw new Error(`不支持的字段 ${key}`);
}

/** 受控写：先全量校验，再写，逐项审计；agentProfile 结构失败整体回滚。 */
export function update(fields: unknown, ctx: SelfCtx = {}): string {
    // 改设置属于私下行为。群里不落笔改、也不回显改了什么（回显就是泄露），
    // 拥有者自己在群里提也一样——让他私聊说一句，一句话就好。
    if (memory.isGroupSession(ctx.sessionId)) {
        return "group: 现在在群里，改自己设置的事我们私聊说。你私下跟我说一句，我立刻改。";
    }
    // 管理权是分级的：只有 owner 能改她的设定。admin 可以看、可以问，
    // 但不能改——否则"被信任"就等于"被接管"了。
    if (roleOf(ctx) !== "owner") {
        return "noperm: 改设定这件事只有拥有者能做。你可以问我现在的状态，但改动得他点头。";
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        return "error: self_update 需要 fields 对象，例如 {\"thinking.mode\":\"on\"}";
    }
    const entries = Object.entries(fields as Record<string, unknown>);
    if (!entries.length) return "error: fields 为空，没有要修改的内容";

    const validated: [string, unknown][] = [];
    for (const [key, value] of entries) {
        try {
            validated.push([key, policy.validate(key, value)]);
        } catch (e) {
            policy.audit({ action: "self_update", key, ok: false, detail: (e as Error).message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `error: 字段「${key}」校验未通过：${(e as Error).message}（本次未做任何修改）`;
        }
    }

    const before: Record<string, unknown> = {};
    for (const [key] of validated) before[key] = readField(key);

    const results: string[] = [];
    for (const [key, value] of validated) {
        try {
            applyField(key, value);
            policy.audit({ action: "self_update", key, before: String(before[key]), after: String(value), ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            results.push(`✓ ${key} = ${JSON.stringify(value)}`);
        } catch (e) {
            policy.audit({ action: "self_update", key, before: String(before[key]), after: String(value), ok: false, detail: (e as Error).message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            results.push(`✗ ${key}：写入失败 ${(e as Error).message}`);
        }
    }

    if (validated.some(([k]) => k.startsWith("agentProfile."))) {
        try {
            modelConfig.getAgentProfile();
        } catch (e) {
            for (const [key] of validated) {
                if (key.startsWith("agentProfile.") && before[key] !== undefined) {
                    try { applyField(key, Number(before[key])); } catch { /* ignore */ }
                }
            }
            policy.audit({ action: "self_update_rollback", detail: (e as Error).message, ok: false, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `error: 工具循环参数整体校验失败，已回滚：${(e as Error).message}`;
        }
    }

    return `已按安全策略更新：\n${results.join("\n")}\n（每次修改都已记入审计日志。）`;
}

// ── 任务 / 提醒的增删改（与核心版对称）────────────────────────────────
// 「删」用取消（status=cancelled），保留历史；系统任务（daily_brief 等）不可碰；
// 严格按 sessionId 隔离；「建/改」复用共享包严格解析与 createJob。

function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export const MANAGE_ACTIONS = ["create_reminder", "update_reminder", "cancel_reminder", "cancel_task"] as const;

export function manage(action: unknown, args: any = {}, ctx: SelfCtx = {}): string {
    const a = String(action || "");
    if (!(MANAGE_ACTIONS as readonly string[]).includes(a)) {
        return `error: 未知 action「${a}」。可用：${MANAGE_ACTIONS.join(" / ")}`;
    }
    // 群里不操作提醒/任务：建了、改了、取消了都会在群里回显，等于把私下的安排公开。
    if (memory.isGroupSession(ctx.sessionId)) {
        return "group: 提醒和任务的事我们私聊弄，群里说一声就行，具体我来记。";
    }
    // 任务/提醒是拥有者的私人安排，只有他能改。别人可以让我记新的事，
    // 但不能动已经排好的东西。
    if (roleOf(ctx) !== "owner") {
        return "noperm: 提醒和任务是拥有者那边排的，我不能替他改。你要是想让我记点什么，直接跟我说。";
    }
    const now = Date.now();

    function ownedJob(): { job?: any; error?: string } {
        const job = jobStore.get(String(args.jobId ?? ""));
        if (!job) return { error: `找不到提醒「${args.jobId}」` };
        if (ctx.sessionId && job.sessionId !== ctx.sessionId) return { error: "该提醒不属于当前会话，不能操作" };
        if (job.kind !== "reminder") return { error: `「${job.title}」是系统任务（${job.kind}），不允许通过自我修补修改` };
        return { job };
    }

    try {
        if (a === "create_reminder") {
            const spec = parseReminder(args, now, "self_manage.create_reminder");
            const job = createJob({
                jobId: newId("job"),
                sessionId: ctx.sessionId || "",
                origin: (ctx.origin as any) || "self_ops",
                uid: ctx.uid ?? 1,
                kind: "reminder",
                title: spec.title,
                payload: spec.payload,
                dueAt: spec.dueAt,
                recurrence: "once",
                now,
            });
            jobStore.save(job as any, "job_created");
            policy.audit({ action: "create_reminder", key: job.jobId, after: `${job.title}@${job.dueAt}`, ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已补设提醒「${job.title}」，将在 ${friendlyTime(job.dueAt)} 提醒主人：${job.payload}（id=${job.jobId}）`;
        }

        if (a === "cancel_reminder") {
            const { job, error } = ownedJob();
            if (error || !job) {
                policy.audit({ action: "cancel_reminder", key: args.jobId, ok: false, detail: error, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: ${error}`;
            }
            if (job.status === "cancelled") return `提醒「${job.title}」已经是取消状态，无需重复操作。`;
            const cancelled = cancelJob(job, now);
            jobStore.save(cancelled as any, "job_cancelled");
            policy.audit({ action: "cancel_reminder", key: job.jobId, before: `${job.title}@${friendlyTime(job.dueAt)}/${job.status}`, after: "cancelled", ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已取消提醒「${job.title}」（原定 ${friendlyTime(job.dueAt)}）。它不会再触发了。`;
        }

        if (a === "update_reminder") {
            const { job, error } = ownedJob();
            if (error || !job) {
                policy.audit({ action: "update_reminder", key: args.jobId, ok: false, detail: error, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: ${error}`;
            }
            const patch: Record<string, unknown> = {};
            if (args.title !== undefined) {
                if (typeof args.title !== "string" || !args.title.trim()) throw new Error("title 必须是非空字符串");
                patch.title = args.title.trim().slice(0, 80);
            }
            if (args.text !== undefined) {
                if (typeof args.text !== "string" || !args.text.trim()) throw new Error("text 必须是非空字符串");
                patch.payload = args.text.slice(0, 2000);
            }
            if (args.dueAt !== undefined) {
                if (typeof args.dueAt !== "number" || !Number.isFinite(args.dueAt) || args.dueAt <= 0) {
                    throw new Error("dueAt 必须是合法的毫秒时间戳");
                }
                patch.dueAt = args.dueAt;
            }
            if (!Object.keys(patch).length) return "error: 没有要修改的字段（title / text / dueAt 至少给一个）";
            const next = { ...job, ...patch, status: "pending", updatedAt: now };
            jobStore.save(next as any, "job_created");
            policy.audit({ action: "update_reminder", key: job.jobId, before: `${job.title}@${friendlyTime(job.dueAt)}`, after: `${next.title}@${friendlyTime(next.dueAt)}`, ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已更新提醒「${next.title}」，现在设定为 ${friendlyTime(next.dueAt)}：${next.payload}`;
        }

        if (a === "cancel_task") {
            const task = taskStore.get(String(args.taskId ?? ""));
            if (!task) {
                policy.audit({ action: "cancel_task", key: args.taskId, ok: false, detail: "任务不存在", sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
                return `error: 找不到任务「${args.taskId}」`;
            }
            if (ctx.sessionId && task.sessionId !== ctx.sessionId) return "error: 该任务不属于当前会话，不能操作";
            const cancelled = cancelTask(task, now);
            taskStore.save(cancelled as any, "task_cancelled");
            policy.audit({ action: "cancel_task", key: task.taskId, before: `${task.title}/${task.status}`, after: "cancelled", ok: true, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
            return `已取消任务「${task.title}」。`;
        }
    } catch (e) {
        policy.audit({ action: a, ok: false, detail: (e as Error).message, sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
        return `error: ${(e as Error).message}`;
    }
    return `error: 未知 action`;
}
