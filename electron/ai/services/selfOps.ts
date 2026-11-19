// electron/ai/services/selfOps.ts
// Kirari 的自我认知 / 自我排查 / 受控自我修补引擎（桌宠版）。
// 与核心版 src/services/selfOps.js 对称：一个通用读 self_read + 一个受控写 self_update
// + 每轮注入的自我清单，覆盖设置/能力/任务/提醒/自检，而不是一堆领域专用接口。

import fs from "node:fs";
import * as capabilities from "../capabilities/registry";
import * as modelConfig from "../../model-config";
import { taskStore } from "../events/taskStore";
import { jobStore } from "../events/jobStore";
import * as policy from "./selfOpsPolicy";
import { homePath } from "../../kirari-home";

export const TOPICS = ["readme", "capabilities", "settings", "models", "tasks", "reminders", "thinking", "diagnose", "logs", "audit"] as const;

export interface SelfCtx {
    sessionId?: string;
    uid?: number;
    capScope?: string;
    origin?: string;
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
    lines.push("- 你是 Kirari（きらり），主人的虚拟桌宠。下面是一个通用读接口 self_read 与受控写接口 self_update。");
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
    return lines.join("\n");
}

/** 通用读。 */
export function read(topic: unknown, ctx: SelfCtx = {}): string {
    const t = String(topic || "readme").toLowerCase();
    const sid = ctx.sessionId;
    switch (t) {
        case "readme":
            return [
                "# Kirari 自我说明",
                "- 我是 Kirari，主人的虚拟桌宠少女。",
                "- 我有这些通用能力工具：self_read（查询自己）、self_update（受控修改）、load_skill（按需加载技能）、subagent（委派子任务），以及时间/天气/搜索/生图/plan/schedule_reminder。",
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
