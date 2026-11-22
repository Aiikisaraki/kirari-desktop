// electron/extensions/host.ts
//
// 扩展宿主：发现 → 加载 → 注册贡献 → 卸载。主程序只和这个类打交道。
//
// 边界感（决定了它故意不做什么）：
//   · 不解释任何业务贡献。service 交给 ServiceRegistry，capability 交给回调
//     （由 capabilities/registry 注册成模型工具），settings/channel 由各自的消费方取。
//   · 不做持久化决策：哪些包被启用属于上层设置，这里只认"现在该跑哪些"。
//   · 一个包坏掉不影响其它包，更不影响主程序启动。

import { discoverExtensions, type DiscoveredExtension } from "./manifest";
import { ExtensionRuntime, type RemoteCapability } from "./runtime";
import { ServiceRegistry } from "./services";
import type { Contribution, ExtensionManifest, HostHello } from "./types";

/** 能力回调：把扩展包贡献的工具交给宿主注册（由调用方决定注册到哪）。 */
export type CapabilityRegistrar = (
    packId: string,
    capability: RemoteCapability,
    invoke: (name: string, args: unknown) => Promise<unknown>,
) => void;

export interface ExtensionHostOptions {
    /** 扩展包根目录（userData 下；程序目录只读，不能放） */
    rootDir: string;
    userDataDir?: string;
    hostVersion: string;
    locale?: string;
    onCapabilities?: CapabilityRegistrar;
    /** 单个包失败不抛出，只记录；这个回调让上层能显示状态 */
    onError?: (packId: string, message: string) => void;
}

export interface ExtensionStatus {
    packId: string;
    name: string;
    version: string;
    dir: string;
    running: boolean;
    error: string;
    contributions: Contribution[];
    permissions: string[];
}

export class ExtensionHost {
    /** 服务注册表：没有包时是空的，get() 恒为 null */
    readonly services = new ServiceRegistry();

    private readonly opts: ExtensionHostOptions;
    private readonly runtimes = new Map<string, ExtensionRuntime>();
    private disposed = false;

    constructor(opts: ExtensionHostOptions) {
        this.opts = opts;
    }

    /** 扫描磁盘上的扩展包（不启动）。 */
    async scan(): Promise<DiscoveredExtension[]> {
        return discoverExtensions(this.opts.rootDir);
    }

    /** 启动全部可用的包（单个失败不影响其它）。 */
    async startAll(): Promise<ExtensionStatus[]> {
        const found = await this.scan();
        for (const item of found) {
            if (item.error) {
                this.opts.onError?.(item.manifest.id, item.error);
                continue;
            }
            try {
                await this.startPack(item);
            } catch (err) {
                this.opts.onError?.(
                    item.manifest.id,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        return this.status();
    }

    async startPack(item: DiscoveredExtension): Promise<void> {
        if (this.disposed) throw new Error("扩展宿主已关闭");
        const id = item.manifest.id;
        if (this.runtimes.has(id)) return;

        const hello: HostHello = {
            apiVersion: item.manifest.apiVersion,
            hostName: "kirari-desktop",
            hostVersion: this.opts.hostVersion,
            userDataDir: this.opts.userDataDir,
            locale: this.opts.locale,
        };
        const runtime = new ExtensionRuntime(item, { hello });
        this.runtimes.set(id, runtime);

        await runtime.ensureStarted();

        // 注册服务贡献
        for (const c of item.manifest.contributions) {
            if (c.type !== "service") continue;
            const prev = this.services.register({ id: c.id, title: c.title, packId: id }, runtime);
            if (prev) {
                console.warn("[ext] 服务 " + c.id + " 被 " + id + " 覆盖（原提供者 " + prev.packId + "）");
            }
        }

        // 能力贡献：清单里声明了 capability，就去问它要 schema 并交给宿主注册
        if (this.opts.onCapabilities && runtime.contributionsOf("capability").length > 0) {
            const caps = await runtime.listCapabilities();
            for (const cap of caps) {
                this.opts.onCapabilities(id, cap, (name, args) => runtime.callCapability(name, args));
            }
        }
    }

    async stopPack(packId: string): Promise<void> {
        const runtime = this.runtimes.get(packId);
        if (!runtime) return;
        this.runtimes.delete(packId);
        this.services.unregisterPack(packId);
        await runtime.dispose();
    }

    status(): ExtensionStatus[] {
        return [...this.runtimes.values()].map((rt) => ({
            packId: rt.packId,
            name: rt.manifest.name,
            version: rt.manifest.version,
            dir: rt.dir,
            running: rt.isRunning,
            error: rt.error,
            contributions: rt.manifest.contributions,
            permissions: rt.manifest.permissions || [],
        }));
    }

    /** 列出清单（不启动），给设置页"已安装但未启用"用 */
    async installed(): Promise<ExtensionManifest[]> {
        return (await this.scan()).map((d) => d.manifest);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await Promise.allSettled([...this.runtimes.values()].map((rt) => rt.dispose()));
        this.runtimes.clear();
    }
}

// ── 进程内单例 ─────────────────────────────────────────────────────────────
// 主程序里已有太多地方通过模块级单例拿依赖（memory / db / capabilities 都是），
// 这里跟随同一约定：宿主启动后挂到单例上，消费方用 getExtensionHost() 取。
// 没启动（绝大多数情况：用户没装任何扩展包）时返回 null，消费方直接走原路径。

let currentHost: ExtensionHost | null = null;

export function setExtensionHost(host: ExtensionHost | null): void {
    currentHost = host;
}

export function getExtensionHost(): ExtensionHost | null {
    return currentHost;
}

/** 便捷取服务：宿主没起来时同样返回 null。 */
export function getService<T extends object>(id: string): T | null {
    return currentHost ? currentHost.services.get<T>(id) : null;
}
