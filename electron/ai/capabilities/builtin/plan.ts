// 内置能力：plan（阶段 D，一个能力一个文件）。schema 复用 taskRuntime。
import { defineCapability, type Capability } from "kirari-agent";
import { PLAN_TOOL } from "../../services/taskSchemas";
import * as taskRuntime from "../../services/taskRuntime";

const spec = PLAN_TOOL.function;

const capability: Capability = defineCapability({
    id: "plan",
    name: "plan",
    kind: "tool",
    scope: "builtin",
    description: spec.description,
    parameters: spec.parameters,
    tags: ["builtin", "task"],
});

async function dispatch(args: any, ctx: any): Promise<string> {
    return await taskRuntime.handlePlan(args || {}, {
        sessionId: ctx.sessionId || "",
        turnId: ctx.turnId || "",
        uid: ctx.uid ?? 1,
        origin: "desktop",
    });
}

export { capability, dispatch };
