// 内置能力：schedule_reminder（阶段 D，一个能力一个文件）。schema 复用 taskRuntime。
import { defineCapability, type Capability } from "kirari-agent";
import { REMINDER_TOOL } from "../../services/taskSchemas";
import * as taskRuntime from "../../services/taskRuntime";

const spec = REMINDER_TOOL.function;

const capability: Capability = defineCapability({
    id: "schedule_reminder",
    name: "schedule_reminder",
    kind: "tool",
    scope: "builtin",
    description: spec.description,
    parameters: spec.parameters,
    tags: ["builtin", "task"],
});

async function dispatch(args: any, ctx: any): Promise<string> {
    // 身份三元组必须透传：taskRuntime 要靠它决定「这条提醒归谁」（ownerKey）
    // 以及文案里该喊「主人」还是喊对方名字。
    // 2026-11-20 身份排查：以前这里只传 4 个字段，身份在能力层就断链了，
    // 于是所有提醒一律「提醒主人」、到点也没有归属依据。
    return await taskRuntime.handleScheduleReminder(args || {}, {
        sessionId: ctx.sessionId || "",
        turnId: ctx.turnId || "",
        uid: ctx.uid ?? 1,
        origin: "desktop",
        role: ctx.role ?? null,
        isOwner: ctx.isOwner ?? null,
        displayName: ctx.displayName ?? null,
        counterpartId: ctx.counterpartId ?? null,
        senderId: ctx.senderId ?? null,
        trustedLocal: ctx.trustedLocal === true,
    });
}

export { capability, dispatch };
