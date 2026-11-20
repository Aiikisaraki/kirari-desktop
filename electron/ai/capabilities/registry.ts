// electron/ai/capabilities/registry.ts
// 阶段 D：统一能力注册表（桌宠端侧）。与 kirari-core/src/capabilities/registry.js 对称。
//
// 纯逻辑契约来自共享包 kirari-agent；本文件只做「执行器与能力绑定 + 超时竞速」胶水。
// builtin 能力用 import.meta.glob 自动收集（新增一个 builtin 文件 = 零改其它文件）。

import {
    CapabilityRegistry,
    defineCapability,
    toOpenAITool,
    truncateResult,
    scopeKey,
    DEFAULT_CAPABILITY_TIMEOUT_MS,
    type Capability,
    type CapabilityInput,
} from "kirari-agent";
import * as toolRouting from "../services/toolRouting";

const registry = new CapabilityRegistry();
const executorById = new Map<string, (args: any, ctx: any) => Promise<any> | any>();
const connectionExecutors = new Map<string, Map<string, (args: any, ctx?: any) => Promise<any>>>();

let builtinLoaded = false;

type BuiltinModule = {
    capability: Capability;
    dispatch: (args: any, ctx: any) => Promise<any> | any;
};

/** 收集 builtin/*.ts（eager glob，vite/vitest 均支持）。 */
function loadBuiltin(): void {
    if (builtinLoaded) return;
    builtinLoaded = true;
    const modules = import.meta.glob<BuiltinModule>("./builtin/*.ts", { eager: true });
    for (const [file, mod] of Object.entries(modules)) {
        try {
            const cap = mod?.capability;
            if (!cap || typeof cap.id !== "string") {
                console.warn(`[capabilities] 跳过 ${file}：未导出合法 capability`);
                continue;
            }
            registry.register(cap);
            if (typeof mod.dispatch === "function") executorById.set(cap.id, mod.dispatch);
        } catch (e) {
            console.warn(`[capabilities] 加载 ${file} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/** 注册全局能力（核心版自执行的 MCP / 技能工具）。 */
export function registerGlobal(
    tools: Array<{
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        execute: (args: any) => Promise<any> | any;
        timeoutMs?: number;
        truncateChars?: number;
    }>,
): number {
    let n = 0;
    for (const t of Array.isArray(tools) ? tools : []) {
        if (!t || typeof t.name !== "string" || !t.name.trim() || typeof t.execute !== "function") continue;
        const id = t.name;
        const input: CapabilityInput = {
            id,
            name: t.name,
            kind: "tool",
            scope: "global",
            description: String(t.description || "").slice(0, 500) || id,
            ...(t.parameters ? { parameters: t.parameters } : {}),
            ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
            ...(t.truncateChars ? { truncateChars: t.truncateChars } : {}),
        };
        const cap = defineCapability(input);
        registry.register(cap);
        executorById.set(id, t.execute);
        n++;
    }
    return n;
}

/**
 * 按作用域注册前端托管工具（MCP/skill 由渲染进程/主进程执行）。
 * 与 core 对称：schema + 执行器都挂在 scopeId 上，三类调用方互不覆盖。
 * executor 形态 (name, args) => result（即 aiContext.invokeFrontendTool）。
 */
export function registerConnection(
    scopeId: string,
    tools: unknown,
    executor: (name: string, args: any) => Promise<any> | any,
): number {
    const key = String(scopeId || "anonymous");
    registry.unregisterScope(key);
    const nameExec = new Map<string, (args: any, ctx?: any) => Promise<any>>();
    for (const t of Array.isArray(tools) ? tools : []) {
        const fn = (t as any)?.function;
        if (!fn || typeof fn.name !== "string") continue;
        const name = fn.name;
        const id = `${key}::${name}`;
        let cap: Capability;
        try {
            cap = defineCapability({
                id,
                name,
                kind: "tool",
                scope: "connection",
                description: String(fn.description || "").slice(0, 500) || name,
                ...(fn.parameters ? { parameters: fn.parameters } : {}),
            });
        } catch {
            continue;
        }
        registry.registerFor(key, cap);
        if (typeof executor === "function") nameExec.set(name, (args, _ctx) => executor(name, args));
    }
    connectionExecutors.set(key, nameExec);
    return nameExec.size;
}

export function unregisterConnection(scopeId: string): void {
    const key = String(scopeId || "anonymous");
    registry.unregisterScope(key);
    connectionExecutors.delete(key);
}

export function listTools(scopeId: string, opts?: Parameters<CapabilityRegistry["list"]>[1]): any[] {
    loadBuiltin();
    return registry.list(String(scopeId || "anonymous"), opts).map(toOpenAITool);
}

export function has(scopeId: string, name: string): boolean {
    loadBuiltin();
    return registry.has(String(scopeId || "anonymous"), name);
}

export function resolve(scopeId: string, name: string): Capability | undefined {
    loadBuiltin();
    return registry.resolve(String(scopeId || "anonymous"), name);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`能力调用超时（${timeoutMs}ms）：${name}`)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export type DispatchResult = { content: string; isError: boolean; capability: Capability | null };

export async function dispatch(
    scopeId: string,
    name: string,
    args: any,
    ctx: any = {},
): Promise<DispatchResult> {
    loadBuiltin();

    // 阶段 5：先决定这次调用在哪台设备上执行。
    // 叶子请求 → 叶子自己；主机/QQ/网页端 → 主机自己；模型点名 → 那台设备。
    // 判定细节见 services/toolRouting.ts；普通单机安装下 decide 永远返回 local。
    let route: ReturnType<typeof toolRouting.decide> | null = null;
    try {
        route = toolRouting.decide(ctx, name);
    } catch (e) {
        console.warn("[capabilities] 工具路由判定失败（按本地执行）:", (e as Error)?.message || e);
        route = null;
    }
    if (route && route.target === "remote") {
        try {
            const remote = await toolRouting.runRemote(ctx, route, args || {});
            if (remote) {
                const prefix = route.note ? `[${route.note}]\n` : "";
                return { content: prefix + remote.content, isError: remote.isError, capability: null };
            }
            // 没有远程通道（未开组网 / 老版本）：落回本地执行
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: `error: 远程执行工具失败：${msg}`, isError: true, capability: null };
        }
    }
    // 前缀已剥掉设备名，本地执行要用真实工具名
    const realName = route && route.name ? route.name : name;

    const key = String(scopeId || "anonymous");
    const cap = registry.resolve(key, realName);
    if (!cap) {
        const miss = route && route.note ? `[${route.note}]\n` : "";
        return { content: `${miss}未知工具：${realName}`, isError: true, capability: null };
    }

    let executor: ((args: any, ctx?: any) => Promise<any> | any) | undefined;
    if (cap.scope === "connection") {
        executor =
            connectionExecutors.get(key)?.get(realName) ||
            (typeof ctx.invokeFrontendTool === "function"
                ? (a) => ctx.invokeFrontendTool(realName, a)
                : undefined);
    } else {
        executor = executorById.get(cap.id);
    }
    if (typeof executor !== "function")
        return { content: `error: 能力 ${realName} 无可用执行器`, isError: true, capability: cap };

    // 点名了却没找到设备时，即使这次在本地执行成功，也必须把
    // 「没找到那台设备」一起回给模型。否则模型会以为跑的是那台机器，
    // 实际跑的是主机 —— 这类串线是最难排查的一种错。
    const routeNote = route && route.note ? `[${route.note}]\n` : '';

    const timeoutMs = cap.timeoutMs || DEFAULT_CAPABILITY_TIMEOUT_MS;
    try {
        const raw = await withTimeout(Promise.resolve(executor(args || {}, ctx)), timeoutMs, realName);
        return {
            content: routeNote + truncateResult(String(raw), cap.truncateChars),
            isError: false,
            capability: cap,
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            content: routeNote + truncateResult(`error: ${msg}`, cap.truncateChars),
            isError: true,
            capability: cap,
        };
    }
}

export { scopeKey };
