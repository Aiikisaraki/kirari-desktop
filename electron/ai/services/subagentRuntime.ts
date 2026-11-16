// electron/ai/services/subagentRuntime.ts
// 阶段 E：按需子 agent（桌宠端侧）。与核心版 subagentRuntime.js 对称。
//
// 设计要点：
//   1) 以「内置能力」形态暴露：模型调用 subagent(goal)，与其它工具同一条 dispatch 流水线。
//   2) 独立会话：子 agent 的事件写进 sub::<uid>::<taskId>，主会话只留一条 tool_result。
//      桌宠聊天 UI 只订阅主 sessionId，所以子代理天然不会出现在主会话里。
//   3) 不递归：工具集显式剔除 subagent 自身。
//   4) 有界：轮数取 profile 与 4 的较小值；结果交给 dispatch 统一截断。

import { AgentRunner, scopeKey, type AgentProfile } from "kirari-agent";
import { getAgentProfile } from "../../model-config";
import * as capabilities from "../capabilities/registry";
import { recorder } from "../events/recorder";
import { streamChatCompletion } from "../reply/streaming";
import type { AiContext } from "../aiContext";

export const SUBAGENT_NAME = "subagent";
const MAX_GOAL_CHARS = 2000;
export const MAX_SUBAGENT_ROUNDS = 4;

const SYSTEM_PROMPT =
    "你是桌宠 Kirari 的子代理，只负责完成主人交办的这一个子任务。\n" +
    "规则：\n" +
    "1. 专注、直接，不要寒暄，不要扮演人格，不要输出与子任务无关的内容。\n" +
    "2. 需要事实时先用工具查证，不要凭空编造。\n" +
    "3. 完成后用简洁的中文给出结果（要点式即可），这就是要回传给主代理的全部内容。";

export type SubagentCtx = {
    openai?: AiContext["openai"];
    model?: string;
    uid?: number;
    sessionId?: string;
    turnId?: string;
    origin?: "core" | "desktop";
    capScope?: string;
    searchProvider?: string;
    searchKey?: string;
    searchEndpoint?: string;
    invokeFrontendTool?: AiContext["invokeFrontendTool"];
};

function newTaskId(): string {
    return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 子 agent 可见的工具：当前 scope 的全部工具，剔除自身（防递归）。 */
function subagentTools(scope: string): any[] {
    return capabilities.listTools(scope).filter((t: any) => t?.function?.name !== SUBAGENT_NAME);
}

/**
 * 跑一个子任务，返回最终文本；失败一律返回 `error: ...`（与工具失败约定一致）。
 */
export async function runSubagent(args: { goal?: unknown; ctx?: SubagentCtx; scopeId?: string }): Promise<string> {
    const ctx = args.ctx || {};
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal) return "error: 子任务描述不能为空";
    if (goal.length > MAX_GOAL_CHARS) return `error: 子任务描述超过 ${MAX_GOAL_CHARS} 字符`;
    if (!ctx.openai || !ctx.model) return "error: 子 agent 缺少模型客户端（未配置大脑）";

    const scope = args.scopeId || ctx.capScope || scopeKey("local", String(ctx.uid ?? "anon"));
    const base: AgentProfile = getAgentProfile();
    const profile: AgentProfile = {
        ...base,
        maxRounds: Math.min(base.maxRounds || MAX_SUBAGENT_ROUNDS, MAX_SUBAGENT_ROUNDS),
    };
    const taskId = newTaskId();
    const sessionId = `sub::${ctx.uid ?? 1}::${taskId}`;
    const turnId = `t-${taskId}`;
    const origin = ctx.origin || "desktop";
    const tools = subagentTools(scope);

    const messages: any[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: goal },
    ];

    recorder.enqueue({
        origin,
        sessionId,
        turnId,
        type: "user_message",
        payload: { content: goal, subagent: true, parentSessionId: ctx.sessionId ?? null },
    });

    const runner = new AgentRunner<string>(profile);
    try {
        const finalText = await runner.run(async (round, r) => {
            recorder.enqueue({
                origin,
                sessionId,
                turnId,
                type: "request",
                payload: {
                    round,
                    callSite: "subagent",
                    params: { model: ctx.model, max_tokens: profile.maxTokens, toolsCount: tools.length },
                    messages: JSON.parse(JSON.stringify(messages)),
                },
            });

            const completion = await streamChatCompletion(ctx.openai!, {
                model: ctx.model,
                messages,
                tools: tools.length ? tools : undefined,
                tool_choice: tools.length ? "auto" : undefined,
                max_tokens: profile.maxTokens,
            });
            const msg: any = (completion as any)?.choices?.[0]?.message || { role: "assistant", content: "" };
            messages.push(msg);

            const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!toolCalls.length) {
                return { kind: "final", value: String(msg.content || "").trim() };
            }

            const ids = toolCalls.map((tc, i) => tc.id || `sub-call-${round}-${i}`);
            runner.note(ids);
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                const id = ids[i];
                const name = tc.function?.name || "";
                let toolArgs: Record<string, unknown> = {};
                try {
                    toolArgs = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
                } catch {
                    /* 参数解析失败交给 dispatch 报错 */
                }
                recorder.enqueue({
                    origin,
                    sessionId,
                    turnId,
                    type: "tool_call",
                    payload: { round, tool_call_id: id, name, args: toolArgs },
                });
                let result: string;
                try {
                    const dispatched = await capabilities.dispatch(scope, name, toolArgs, { ...ctx, capScope: scope });
                    result = dispatched.content;
                } catch (e) {
                    result = `error: ${e instanceof Error ? e.message : String(e)}`;
                }
                messages.push({ role: "tool", tool_call_id: id, content: String(result) });
                recorder.enqueue({
                    origin,
                    sessionId,
                    turnId,
                    type: "tool_result",
                    payload: {
                        round,
                        tool_call_id: id,
                        name,
                        content: String(result),
                        isError: String(result).startsWith("error:"),
                    },
                });
                r.settle(id);
            }
            return { kind: "tools", toolCallIds: ids };
        });

        const out = finalText || "（子代理没有产出内容）";
        recorder.enqueue({
            origin,
            sessionId,
            turnId,
            type: "assistant_message",
            payload: { content: out, source: "subagent" },
        });
        return out;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        recorder.enqueue({
            origin,
            sessionId,
            turnId,
            type: "assistant_message",
            payload: { content: `error: ${msg}`, source: "subagent", failed: true },
        });
        return `error: 子代理执行失败：${msg}`;
    }
}
