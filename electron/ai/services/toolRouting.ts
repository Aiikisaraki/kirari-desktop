// electron/ai/services/toolRouting.ts
//
// 「这次 MCP/skill 调用该在哪台机器上执行」的判定（桌宠端）。与 kirari-core
// 的 src/services/toolRouting.js 对称 —— 两端必须同一套语义，否则同一个问题
// 在桌宠和核心版上会给出不同答案。
//
// 判定优先级（用户 2026-11-20 的口述规则）：
//   1. 模型**明确点名**了某台设备（@device:xxx）→ 那台
//   2. 请求**来自某台叶子** → 那台叶子自己（「默认操作自己这个叶子节点」）
//   3. 主机本机 / QQ / 网页端 → 主机自己
//   4. 点名解析不出来 → 落回 2/3 的默认，但把「没找到那台设备」明确回给模型，
//      绝不静默换机器执行。
//
// 单独一层的原因见 core 版注释：registry 管「怎么执行」，这里管「在哪执行」。

/** 工具名里内嵌设备点名的结构化前缀。 */
const DEVICE_PREFIX_RE = /^\s*@device:([^\s:]+)\s*[:\s]\s*([\s\S]+)$/i;

export type DeviceRef = { deviceId: string; name: string; online: boolean };

export type RouteDecision = {
    target: "local" | "remote";
    /** 剥掉 @device: 前缀之后的真实工具名 */
    name: string;
    /** 判定依据，便于日志与排障 */
    source: "explicit" | "natural" | "from-leaf" | "host-default";
    deviceId?: string;
    deviceName?: string;
    /** 点名却没找到时的说明，会附在结果前面回给模型 */
    note?: string;
    explicitMiss?: boolean;
    /** 自然语言回退认出来的「设备参数键」，转发前要摘掉 */
    dropArgKeys?: string[];
};

/**
 * args 里可能用来点名设备的字段名。
 *
 * 模型有时不会用 @device: 前缀，而是把设备塞进参数里（{"device": "书房"}），
 * 这是它更自然的写法。这里认这几个名字，命中且**能解析出真实设备**才生效。
 */
const DEVICE_ARG_KEYS = [
    "device",
    "deviceid",
    "device_id",
    "devicename",
    "device_name",
    "machine",
    "machine_name",
    "node",
    "node_name",
    "target",
    "target_device",
    "设备",
    "设备名",
    "机器",
    "节点",
];

/**
 * 工具名前面挂了设备名、但漏了 @device: 标记的形态：
 *   「书房 read_file」「书房:read_file」「书房的电脑/read_file」
 * 只按「空白 / 冒号 / 斜杠 / 竖线 / @」切一刀，真实工具名里不会出现这些字符
 * （MCP 是 <server>__<tool>，技能是 skill__<id>__<tool>，都只用下划线）。
 */
const LOOSE_DEVICE_RE = /^\s*([^\s:：/／|@]{1,40})\s*[:：/／|@\s]\s*(\S[\s\S]*)$/u;

export type ToolCaps = {
    deviceId: string;
    mcpServers: string[];
    skills: string[];
    toolNames?: { name: string; source: "mcp" | "skill"; owner: string }[];
};

/** 组网访问器：由 main.ts 注入，避免本模块直接依赖 electron 的全局状态。 */
type NetAccess = {
    /** 主机侧成员列表（非主机会返回空数组） */
    members: () => DeviceRef[];
    /** 主机 → 叶子：远程执行一次工具 */
    callToolOnDevice?: (
        deviceId: string,
        name: string,
        args: unknown,
        opts?: { sessionId?: string; timeoutMs?: number },
    ) => Promise<{ ok: boolean; result?: string; error?: string; deviceId: string }>;
};

let netAccess: NetAccess | null = null;

/** 由 main.ts 在创建 NetManager 之后调用一次。 */
export function setToolRoutingNet(access: NetAccess | null): void {
    netAccess = access;
}

/** 解析工具名里内嵌的设备点名。没有前缀返回 null。 */
export function parseDevicePrefix(name: string): { deviceHint: string; name: string } | null {
    const m = DEVICE_PREFIX_RE.exec(String(name || ""));
    if (!m) return null;
    return { deviceHint: m[1].trim(), name: m[2].trim() };
}

/**
 * 把「设备提示」解析成真实 deviceId。
 * 支持完整/前缀 deviceId、设备名（完全 → 忽略大小写 → 包含）、去掉常见尾缀的别名。
 */
export function resolveDevice(hint: string): { deviceId: string; name: string } | null {
    const raw = String(hint || "").trim();
    if (!raw || !netAccess) return null;
    const members = netAccess.members() || [];
    if (!members.length) return null;
    const lower = raw.toLowerCase();

    const byId = members.find((m) => m.deviceId && m.deviceId.toLowerCase().startsWith(lower));
    if (byId) return { deviceId: byId.deviceId, name: byId.name || byId.deviceId.slice(0, 8) };

    const exact = members.find((m) => String(m.name || "") === raw);
    if (exact) return { deviceId: exact.deviceId, name: exact.name };

    const ci = members.find((m) => String(m.name || "").toLowerCase() === lower);
    if (ci) return { deviceId: ci.deviceId, name: ci.name };

    const partial = members.find((m) => String(m.name || "").toLowerCase().includes(lower));
    if (partial) return { deviceId: partial.deviceId, name: partial.name };

    // 别名：去掉「的电脑 / 的主机 / 节点」这类尾缀后再比一次
    for (const m of members) {
        const name = String(m.name || "").toLowerCase();
        if (!name) continue;
        const stripped = name.replace(/(的)?(电脑|笔记本|台式机|主机|节点|机器)$/u, "").trim();
        if (stripped && stripped === lower) return { deviceId: m.deviceId, name: m.name };
    }
    return null;
}

/**
 * 自然语言回退：模型没用 @device: 前缀，但用别的方式点明了设备。
 *
 * ⚠️ 与结构化前缀的关键差别：**只认命中的，不报失配**。
 * 这里拿到的东西未必真是设备名（比如某个工具自己的 `host` 参数），
 * 误判会把本该在本机跑的调用劫持到别的机器上 —— 那是与「静默跨机」
 * 同样严重、方向相反的错误。所以解析不出来就安静地返回 null。
 */
export function detectNaturalDevice(
    rawName: string,
    args?: unknown,
): { deviceId: string; deviceName: string; name: string; dropArgKeys: string[] } | null {
    if (!(netAccess?.members() || []).length) return null;

    // (a) 参数里点名：{"device": "书房"} / {"设备": "书房的电脑"}
    if (args && typeof args === "object" && !Array.isArray(args)) {
        const rec = args as Record<string, unknown>;
        for (const key of Object.keys(rec)) {
            if (!DEVICE_ARG_KEYS.includes(String(key).toLowerCase())) continue;
            const raw = rec[key];
            if (typeof raw !== "string" || !raw.trim()) continue;
            const hit = resolveDevice(raw);
            if (hit) {
                return {
                    deviceId: hit.deviceId,
                    deviceName: hit.name,
                    name: String(rawName || ""),
                    // 这个字段是给路由看的，转发给叶子的工具时要去掉：
                    // MCP 工具的参数按 schema 校验，多一个未知键会直接报错。
                    dropArgKeys: [key],
                };
            }
        }
    }

    // (b) 工具名前面挂了设备名但漏了标记：「书房 read_file」
    const m = LOOSE_DEVICE_RE.exec(String(rawName || ""));
    if (m) {
        const hit = resolveDevice(m[1]);
        if (hit) {
            return {
                deviceId: hit.deviceId,
                deviceName: hit.name,
                name: m[2].trim(),
                dropArgKeys: [],
            };
        }
    }
    return null;
}

/**
 * 本次调用最终在哪台设备上执行。
 *
 * @param ctx dispatch 传下来的上下文（含 sourceDeviceId）
 * @param rawName 模型给的原始工具名，可能带 @device: 前缀
 * @param args 模型给的参数（自然语言回退要查里面有没有点名）
 */
export function decide(ctx: any, rawName: string, args?: unknown): RouteDecision {
    const sourceDeviceId = ctx && ctx.sourceDeviceId ? String(ctx.sourceDeviceId) : "";
    const out: RouteDecision = {
        target: "local",
        name: String(rawName || ""),
        source: "host-default",
    };

    // 规则 1：模型点名
    const parsed = parseDevicePrefix(rawName);
    if (parsed) {
        const hit = resolveDevice(parsed.deviceHint);
        out.name = parsed.name;
        out.source = "explicit";
        if (hit) {
            out.target = "remote";
            out.deviceId = hit.deviceId;
            out.deviceName = hit.name;
            return out;
        }
        const list =
            (netAccess?.members() || [])
                .map((m) => `${m.name}（${m.deviceId.slice(0, 8)}${m.online ? "" : "，离线"}）`)
                .join("、") || "无";
        out.note = `没找到设备「${parsed.deviceHint}」。可用设备：${list}`;
        out.explicitMiss = true;
    }

    // 规则 1b：自然语言回退（没写 @device:，但用别的写法点明了设备）
    // 只在确实解析到一台真设备时才改路由；解析不出来就当作没点名。
    if (!parsed) {
        const nat = detectNaturalDevice(rawName, args);
        if (nat) {
            out.target = "remote";
            out.deviceId = nat.deviceId;
            out.deviceName = nat.deviceName;
            out.name = nat.name;
            out.source = "natural";
            if (nat.dropArgKeys.length) out.dropArgKeys = nat.dropArgKeys;
            return out;
        }
    }

    // 规则 2：请求来自叶子 → 那台叶子自己
    if (sourceDeviceId) {
        out.target = "remote";
        out.deviceId = sourceDeviceId;
        const m = (netAccess?.members() || []).find((x) => x.deviceId === sourceDeviceId);
        out.deviceName = m ? m.name : sourceDeviceId.slice(0, 8);
        if (!out.explicitMiss) out.source = "from-leaf";
        return out;
    }

    // 规则 3：主机本机 / QQ / 网页端 → 主机自己
    return out;
}

/** 列出所有叶子节点（「在主机上可以列出所有叶子节点」）。 */
export function listDevices(): DeviceRef[] {
    return netAccess?.members() || [];
}

/**
 * 远程执行一次工具调用，结果整理成 registry 期望的形状。
 * 返回 null 表示没法远程执行（未开组网 / 不是主机），调用方应以本地执行兜底。
 */
export async function runRemote(
    ctx: any,
    target: RouteDecision,
    args: unknown,
): Promise<{ content: string; isError: boolean } | null> {
    const call = netAccess?.callToolOnDevice;
    if (!call || !target?.deviceId) return null;
    const out = await call(target.deviceId, target.name, args, { sessionId: ctx?.sessionId });
    if (!out) return null;
    if (out.ok) return { content: String(out.result == null ? "" : out.result), isError: false };
    return { content: `error: ${out.error || "远程执行失败"}`, isError: true };
}
