// 内置能力：self_update —— Kirari 的受控自我修补接口（与核心版对称）。
import { defineCapability, type Capability } from "kirari-agent";
import * as selfOps from "../../services/selfOps";
import * as policy from "../../services/selfOpsPolicy";

const writableList = policy.describeWritable().map((w) => `${w.key}（${w.description}）`).join("；");

const capability: Capability = defineCapability({
    id: "self_update",
    name: "self_update",
    kind: "tool",
    scope: "builtin",
    description:
        "在安全白名单内修改 Kirari 自己的设置，实现自我修补。只能改：" + writableList +
        "。凭证类（key/endpoint/token/密码）一律不可改。每次修改都会写审计日志，可先用 self_read(audit) 查看。不确定当前值时先 self_read(settings)。fields 是一个「字段路径→新值」对象。",
    parameters: {
        type: "object",
        properties: {
            fields: {
                type: "object",
                description: '要修改的字段对象，例如 {"thinking.mode":"on"}。键必须是白名单内的路径。',
                additionalProperties: true,
            },
            reason: { type: "string", description: "为什么要改（写入审计，便于主人事后查看）。" },
        },
        required: ["fields"],
    },
    tags: ["builtin", "introspection", "mutating"],
    timeoutMs: 10000,
    truncateChars: 4000,
});

async function dispatch(args: any, ctx: any = {}): Promise<string> {
    if (typeof args?.reason === "string" && args.reason.trim()) {
        policy.audit({ action: "self_update_reason", detail: args.reason.trim(), sessionId: ctx.sessionId, uid: ctx.uid, origin: ctx.origin });
    }
    return selfOps.update(args?.fields, {
        sessionId: ctx.sessionId,
        uid: ctx.uid,
        origin: ctx.origin,
        role: ctx.role,
        isOwner: ctx.isOwner,
    });
}

export { capability, dispatch };
