// 内置能力：subagent（阶段 E，一个能力一个文件）。
// 把可独立拆分的子任务交给受限子代理执行：独立会话记录（sub::<uid>::<taskId>），
// 不污染主会话消息与 UI，只把结论作为工具结果回传。工具集剔除自身，禁止递归。
import { defineCapability, scopeKey, type Capability } from "kirari-agent";
import * as subagentRuntime from "../../services/subagentRuntime";

const capability: Capability = defineCapability({
    id: "subagent",
    name: "subagent",
    kind: "agent",
    scope: "builtin",
    description:
        "把一个可以独立完成的子任务交给子代理执行，返回它的结论。适合：需要多步查证/整理的独立任务（例如「分别查这三家公司的股价并对比」「帮我调研某个话题的关键事实」）。不要用于一句话就能回答的问题，也不要嵌套委派。",
    parameters: {
        type: "object",
        properties: {
            goal: {
                type: "string",
                description: "子任务的完整描述：目标、必要的约束与期望的输出形式。子代理看不到主对话，必须自包含。",
            },
        },
        required: ["goal"],
    },
    tags: ["builtin", "agent"],
    // 子代理内部是完整工具循环，需要比普通工具更长的预算；上限 120s 由共享包约束。
    timeoutMs: 120000,
    truncateChars: 4000,
});

async function dispatch(args: any, ctx: any = {}): Promise<string> {
    const scopeId = ctx.capScope || scopeKey("local", String(ctx.uid ?? "anon"));
    return await subagentRuntime.runSubagent({
        goal: args?.goal,
        ctx: { ...ctx, capScope: scopeId },
        scopeId,
    });
}

export { capability, dispatch };
