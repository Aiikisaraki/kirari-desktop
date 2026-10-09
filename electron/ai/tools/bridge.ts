// electron/ai/tools/bridge.ts
// 前端托管工具桥：管理「内核请求 → 主进程（渲染层）执行 → 结果回传」的配对。
//
// 【与原实现的关键差异】
// 原 kirari-core/src/tools/bridge.js 靠 WebSocket 传输：内核发 tool_invoke 到前端，
// 等待前端回 tool_result，30 秒超时。迁入主进程后不再经过 WS，
// 改由主进程注入一个「调用函数」—— 前端托管工具（MCP server / skill 提供的工具）
// 本来就由 Electron 主进程执行，进程内直连省掉一次序列化与 30 秒挂起风险。

import type { ToolResultSink } from "../types";

/** 前端工具执行器：由主进程实现，负责真正跑 MCP 工具 / skill。 */
export type FrontendToolInvoker = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** 一次挂起的前端工具调用。 */
type PendingCall = {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

const FRONTEND_TOOL_TIMEOUT_MS = 30000;

/**
 * 创建前端工具桥。
 *
 * 进程内直连版：`invokeFrontendTool` 直接 await 主进程提供的执行器，
 * 不再发 WS 帧，也不再需要 call_id 配对表。超时保护保留，
 * 避免某个 MCP server 卡死把整轮对话拖住。
 */
export function createFrontendToolBridge(invoker: FrontendToolInvoker): {
    invokeFrontendTool: (name: string, args: Record<string, unknown>) => Promise<string>;
    /** 供 ToolResultSink 形态使用的句柄（当前进程内直连已无需，保留以兼容回调式实现）。 */
    sink: ToolResultSink;
} {
    async function invokeFrontendTool(
        name: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                invoker(name, args),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(`前端工具调用超时（${FRONTEND_TOOL_TIMEOUT_MS / 1000}s 未返回）：${name}`),
                            ),
                        FRONTEND_TOOL_TIMEOUT_MS,
                    );
                }),
            ]);
            // 统一转成字符串，与原实现的 content 归一化行为一致
            return typeof result === "string" ? result : JSON.stringify(result ?? "");
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // 进程内直连下 tool_result 无需回传（执行器已直接返回结果），
    // 此 sink 仅用于将来若引入多进程工具执行器时保持接口形状。
    const sink: ToolResultSink = () => {
        /* 进程内直连无需回传，no-op */
    };

    return { invokeFrontendTool, sink };
}

/**
 * 未注入执行器时的占位桥：任何调用都直接拒绝，让调用方回退到工具原始结果，
 * 而不是静默挂起 30 秒。
 */
export function createNullToolBridge(reason = "前端工具通道未就绪"): {
    invokeFrontendTool: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
    return {
        invokeFrontendTool: () => Promise.reject(new Error(reason)),
    };
}
