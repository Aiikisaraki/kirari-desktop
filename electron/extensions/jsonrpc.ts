// electron/extensions/jsonrpc.ts
//
// sidecar 的最小 JSON-RPC over stdio 实现（按行分隔的 JSON）。
//
// 为什么不引第三方库：这里只需要 request/response + 单向上报事件。
// 引一个 RPC 框架会把「扩展包边界」变成「框架边界」，以后想换传输也难。
//
// 健壮性要点（都是实际会踩到的）：
//   · stdout 必须**按行**解析 —— Node 会任意切包，不能假设一次 data 是一个完整 JSON
//   · sidecar 打日志只能走 stderr。这里遇到非 JSON 行只 warn 不炸，
//     避免一个 print 把整个扩展打挂
//   · 进程退出时让所有挂起请求立刻失败，否则 UI 会永远转圈

import type { ChildProcessWithoutNullStreams } from "child_process";

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

export class JsonRpcError extends Error {
    code: number | null;

    constructor(message: string, code: number | null = null) {
        super(message);
        this.name = "JsonRpcError";
        this.code = code;
    }
}

/** 扩展包主动抛给宿主的事件回调。 */
export type EventListener = (type: string, payload: unknown) => void;

export class JsonRpcClient {
    private seq = 0;
    private readonly pending = new Map<number, Pending>();
    private buffer = "";
    private closed = false;
    private readonly listeners = new Set<EventListener>();
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly defaultTimeoutMs: number;

    constructor(child: ChildProcessWithoutNullStreams, defaultTimeoutMs: number = 15000) {
        this.child = child;
        this.defaultTimeoutMs = defaultTimeoutMs;

        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => this.onData(chunk));
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => {
            const text = String(chunk).trimEnd();
            if (text) console.warn("[ext] " + text);
        });
        child.on("exit", (code, signal) =>
            this.failAll("扩展进程已退出 code=" + code + " signal=" + signal),
        );
        child.on("error", (err) => this.failAll("扩展进程启动失败：" + err.message));
    }

    get isClosed(): boolean {
        return this.closed;
    }

    onEvent(cb: EventListener): () => void {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    }

    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
        if (this.closed) return Promise.reject(new JsonRpcError("扩展进程不可用"));
        const id = ++this.seq;
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? null });
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new JsonRpcError("调用超时（" + method + "）"));
            }, timeoutMs ?? this.defaultTimeoutMs);
            this.pending.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                timer,
                method,
            });
            try {
                this.child.stdin.write(payload + "\n");
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new JsonRpcError("写入扩展进程失败：" + (err as Error).message));
            }
        });
    }

    notify(method: string, params?: unknown): void {
        if (this.closed) return;
        try {
            this.child.stdin.write(
                JSON.stringify({ jsonrpc: "2.0", method, params: params ?? null }) + "\n",
            );
        } catch {
            /* 进程已死，忽略 */
        }
    }

    dispose(): void {
        this.failAll("扩展进程已关闭");
        try {
            this.child.stdin.end();
            this.child.kill();
        } catch {
            /* 已退出 */
        }
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx = this.buffer.indexOf("\n");
        while (idx >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line) this.handleLine(line);
            idx = this.buffer.indexOf("\n");
        }
    }

    private handleLine(line: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
            // 扩展包往 stdout 打日志了：容忍，但提示它该走 stderr
            console.warn("[ext] 忽略非 JSON 输出（日志请写 stderr）: " + line.slice(0, 200));
            return;
        }

        if (typeof msg.id === "number") {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            clearTimeout(pending.timer);
            const err = msg.error as { message?: string; code?: number } | undefined;
            if (err) pending.reject(new JsonRpcError(err.message || "扩展返回错误", err.code ?? null));
            else pending.resolve(msg.result);
            return;
        }

        if (msg.method === "host.event") {
            const p = (msg.params || {}) as { type?: unknown; payload?: unknown };
            const type = typeof p.type === "string" ? p.type : "";
            for (const cb of this.listeners) {
                try {
                    cb(type, p.payload);
                } catch (e) {
                    console.warn("[ext] 事件处理失败：" + (e as Error).message);
                }
            }
        }
    }

    private failAll(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new JsonRpcError(reason + "（" + pending.method + "）"));
            this.pending.delete(id);
        }
    }
}
