// electron/ai/services/selfOpsPolicy.ts
// 自我运维（self_ops）的权限策略：白名单 + 严格校验 + 审计。
// 与核心版 src/services/selfOpsPolicy.js 逐字对应，改一边必须同步改另一边。
//
// 红线：查询宽松、修改保守；凭证类（key/apiKey/endpoint/token/密码）一律只读不可写；
// 每次修改写审计日志；危险操作（删数据/任意代码）根本不提供接口。

import fs from "node:fs";
import path from "node:path";
import { homePath } from "../../kirari-home";

const AUDIT_FILE = path.join(homePath("logs"), "self-ops-audit.jsonl");

function intInRange(name: string, v: unknown, min: number, max: number): number {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
        throw new Error(`${name} 必须是整数，收到 ${JSON.stringify(v)}`);
    }
    if (v < min || v > max) throw new Error(`${name} 必须在 ${min}~${max} 之间，收到 ${v}`);
    return v;
}

type Rule = { describe: string; validate: (v: unknown) => unknown };

export const WRITABLE: Record<string, Rule> = {
    "persona.basePersona": {
        describe: "主人自定义人格（留空恢复预设，上限 4000 字）",
        validate(v) {
            if (typeof v !== "string") throw new Error("basePersona 必须是字符串");
            if (v.length > 4000) throw new Error("basePersona 超过 4000 字");
            return v;
        },
    },
    "agentProfile.maxRounds": { describe: "工具循环最大轮数（1~50）", validate: (v) => intInRange("maxRounds", v, 1, 50) },
    "agentProfile.webSearchCap": { describe: "普通模式联网搜索上限（0~1000，0=不限）", validate: (v) => intInRange("webSearchCap", v, 0, 1000) },
    "agentProfile.correctionWebSearchCap": { describe: "纠错模式联网搜索上限（0~1000，0=不限）", validate: (v) => intInRange("correctionWebSearchCap", v, 0, 1000) },
    "agentProfile.maxTokens": { describe: "单次回复 max_tokens（1~1000000）", validate: (v) => intInRange("maxTokens", v, 1, 1000000) },
    "agentProfile.timeoutFloorMs": { describe: "超时下限毫秒（1000~3600000）", validate: (v) => intInRange("timeoutFloorMs", v, 1000, 3600000) },
    "agentProfile.timeoutPerRoundMs": { describe: "每工具轮追加超时毫秒（0~600000）", validate: (v) => intInRange("timeoutPerRoundMs", v, 0, 600000) },
    "agentProfile.timeoutCapMs": { describe: "超时封顶毫秒（1000~7200000）", validate: (v) => intInRange("timeoutCapMs", v, 1000, 7200000) },
    "thinking.mode": {
        describe: "思考模式：off=直接答 / on=每次先列简要思路再答 / auto=仅复杂问题深入分析",
        validate(v) {
            if (typeof v !== "string" || !["off", "on", "auto"].includes(v)) {
                throw new Error("thinking.mode 必须是 off / on / auto 之一");
            }
            return v;
        },
    },
};

export function canWrite(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(WRITABLE, key);
}

export function validate(key: string, value: unknown): unknown {
    const rule = WRITABLE[key];
    if (!rule) throw new Error(`不允许自我修改字段「${key}」：它不在安全白名单内`);
    return rule.validate(value);
}

export function describeWritable(): { key: string; description: string }[] {
    return Object.entries(WRITABLE).map(([key, r]) => ({ key, description: r.describe }));
}

export interface AuditInput {
    action: string;
    key?: string | null;
    before?: unknown;
    after?: unknown;
    detail?: string | null;
    ok?: boolean;
    sessionId?: string | null;
    uid?: number | null;
    origin?: string | null;
}

export function audit(input: AuditInput): void {
    const rec = {
        at: new Date().toISOString(),
        action: input.action,
        key: input.key ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        detail: input.detail ?? null,
        ok: input.ok ?? true,
        sessionId: input.sessionId ?? null,
        uid: input.uid ?? null,
        origin: input.origin ?? "self_ops",
    };
    try {
        fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + "\n", "utf-8");
    } catch (e) {
        console.warn("[self-ops] 写审计日志失败（已忽略）:", (e as Error)?.message || e);
    }
}

export { AUDIT_FILE };
