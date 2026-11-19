// 内置能力：self_manage —— Kirari 管理自己创建的任务与提醒（增删改，与核心版对称）。
import { defineCapability, type Capability } from "kirari-agent";
import * as selfOps from "../../services/selfOps";

// 同 self_read：registry eager glob，避免顶层读 selfOps 的其它字段触发循环。
const ACTION_ENUM = ["create_reminder", "update_reminder", "cancel_reminder", "cancel_task"];

const capability: Capability = defineCapability({
    id: "self_manage",
    name: "self_manage",
    kind: "tool",
    scope: "builtin",
    description:
        "管理你自己创建的任务和提醒：补设提醒、改提醒时间/内容、取消（删除）重复或设错的提醒、取消任务。发现重复提醒或主人纠正时间时用它自我修补。action：create_reminder（需 title/text + dueAt 或 delayMs 二选一）、update_reminder（需 jobId + title/text/dueAt 中至少一项）、cancel_reminder（需 jobId）、cancel_task（需 taskId）。先用 self_read(reminders/tasks) 拿到 id 再操作。系统任务（每日简报等）不可改，只能操作本会话的提醒/任务。每次操作都记审计。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ACTION_ENUM, description: "要执行的管理动作。" },
            jobId: { type: "string", description: "update_reminder / cancel_reminder 的目标提醒 id。" },
            taskId: { type: "string", description: "cancel_task 的目标任务 id。" },
            title: { type: "string", description: "提醒标题。create_reminder 必填；update_reminder 可选。" },
            text: { type: "string", description: "提醒内容。create_reminder 必填；update_reminder 可选。" },
            dueAt: { type: "number", description: "绝对毫秒时间戳（create/update 与 delayMs 二选一）。" },
            delayMs: { type: "number", description: "相对当前多少毫秒后提醒（仅 create_reminder）。" },
        },
        required: ["action"],
    },
    tags: ["builtin", "introspection", "mutating"],
    timeoutMs: 10000,
    truncateChars: 4000,
});

async function dispatch(args: any, ctx: any = {}): Promise<string> {
    return selfOps.manage(args?.action, args || {}, {
        sessionId: ctx.sessionId,
        uid: ctx.uid,
        origin: ctx.origin,
        role: ctx.role,
        isOwner: ctx.isOwner,
    });
}

export { capability, dispatch };
