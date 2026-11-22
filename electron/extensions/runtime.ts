// electron/extensions/runtime.ts
//
// 一个扩展包 = 一个 sidecar 进程 + 一份清单。
// 这个类只干三件事：把进程拉起来、按通用动词转发调用、把它干净地收掉。
//
// 刻意不在这里做业务：它不认识 serviceId 的含义，也不知道 capability 干什么。
// 谁认识谁会去消费（services.ts / host.ts 的 onCapabilities 回调）。

import * as path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EXTENSION_METHODS, type Contribution, type ExtensionManifest, type HostHello } from "./types";
import { JsonRpcClient } from "./jsonrpc";
import type { DiscoveredExtension } from "./manifest";

/** 扩展包自己报上来的能力（含参数 schema），宿主据此注册成模型工具。 */
export interface RemoteCapability {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** 单次调用超时；不给就用包的默认值 */
    timeoutMs?: number;
}

export interface RuntimeEvent {
    type: string;
    payload?: unknown;
}

export interface RuntimeOptions {
    hello: HostHello;
    /** 拉起进程并完成握手的超时 */
    startTimeoutMs?: number;
    /** 事件回调（sidecar 主动上报） */
    onEvent?: (evt: RuntimeEvent) => void;
}

const DEFAULT_START_TIMEOUT = 10000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export class ExtensionRuntime {
    private readonly discovered: DiscoveredExtension;
    private readonly opts: RuntimeOptions;
    private client: JsonRpcClient | null = null;
    private starting: Promise<void> | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private lastError = "";

    constructor(discovered: DiscoveredExtension, opts: RuntimeOptions) {
        this.discovered = discovered;
        this.opts = opts;
    }

    get manifest(): ExtensionManifest {
        return this.discovered.manifest;
    }
    get packId(): string {
        return this.discovered.manifest.id;
    }
    get dir(): string {
        return this.discovered.dir;
    }
    get isRunning(): boolean {
        return !!this.client && !this.client.isClosed;
    }
    get error(): string {
        return this.lastError;
    }

    /** 该包申报的某类贡献 */
    contributionsOf(type: Contribution["type"]): Contribution[] {
        return this.manifest.contributions.filter((c) => c.type === type);
    }

    /** 拉起进程并握手（并发调用只会拉一次）。 */
    async ensureStarted(): Promise<void> {
        if (this.disposed) throw new Error("扩展包已卸载");
        if (this.isRunning) return;
        if (this.starting) return this.starting;
        this.starting = this.start().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    private async start(): Promise<void> {
        const m = this.manifest;
        if (!m.engine.command) throw new Error("扩展包清单缺少 engine.command");

        const commandPath = path.join(this.dir, m.engine.command);
        const env: NodeJS.ProcessEnv = { ...process.env, ...(m.engine.env || {}) };

        const child = spawn(commandPath, m.engine.args || [], {
            cwd: this.dir,
            env,
            windowsHide: true,
            stdio: "pipe",
        }) as ChildProcessWithoutNullStreams;

        const client = new JsonRpcClient(child, m.engine.requestTimeoutMs ?? 15000);
        client.onEvent((type, payload) => {
            try {
                this.opts.onEvent?.({ type, payload });
            } catch (e) {
                console.warn("[ext] 事件回调异常：" + (e as Error).message);
            }
        });
        this.client = client;

        try {
            await client.request(
                EXTENSION_METHODS.hello,
                this.opts.hello,
                this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT,
            );
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            client.dispose();
            this.client = null;
            throw new Error("扩展包启动失败（" + m.id + "）：" + this.lastError);
        }
        this.lastError = "";
        this.touch();
    }

    /**
     * 调用某个服务的方法。
     * 服务语义由宿主里的消费方解释，这里只保证"转发 + 超时 + 失败可读"。
     */
    async callService<T = unknown>(
        serviceId: string,
        method: string,
        params?: unknown,
        timeoutMs?: number,
    ): Promise<T> {
        const client = await this.ensureClient();
        this.touch();
        return client.request<T>(
            EXTENSION_METHODS.serviceCall,
            { serviceId, method, params: params ?? null },
            timeoutMs ?? this.manifest.engine.requestTimeoutMs,
        );
    }

    /** 调用某个能力（模型工具）。 */
    async callCapability<T = unknown>(name: string, args?: unknown, timeoutMs?: number): Promise<T> {
        const client = await this.ensureClient();
        this.touch();
        return client.request<T>(
            EXTENSION_METHODS.capabilityCall,
            { name, args: args ?? null },
            timeoutMs ?? this.manifest.engine.requestTimeoutMs,
        );
    }

    /** 拉取能力清单（含 schema），供宿主注册成模型工具。 */
    async listCapabilities(): Promise<RemoteCapability[]> {
        const client = await this.ensureClient();
        this.touch();
        const res = await client.request<{ capabilities?: RemoteCapability[] }>(
            EXTENSION_METHODS.capabilityList,
        );
        const list = Array.isArray(res?.capabilities) ? res.capabilities : [];
        return list.filter((c) => c && typeof c.name === "string" && c.name.trim());
    }

    /** 优雅退出：先请它自己收尾，再杀进程。 */
    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const client = this.client;
        this.client = null;
        if (!client) return;
        try {
            await client.request(EXTENSION_METHODS.dispose, null, 1500);
        } catch {
            /* 它不收尾也只能硬关 */
        } finally {
            client.dispose();
        }
    }

    private async ensureClient(): Promise<JsonRpcClient> {
        await this.ensureStarted();
        if (!this.client) throw new Error("扩展包未就绪（" + this.packId + "）");
        return this.client;
    }

    /** 空闲回收：长时间不用就收掉进程，下次调用自动拉起。 */
    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        const idle = this.manifest.engine.idleTimeoutMs ?? DEFAULT_IDLE_MS;
        this.idleTimer = setTimeout(() => {
            if (!this.isRunning) return;
            console.log("[ext] 空闲回收：" + this.packId);
            this.client?.dispose();
            this.client = null;
        }, idle);
        this.idleTimer.unref?.();
    }
}
