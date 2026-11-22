// electron/extensions/services.ts
//
// 通用服务注册表：把扩展包申报的 service 做成"可调用对象"，宿主里谁需要谁去取。
//
// 关键约定：**取不到就是 null**。这样主程序里每个消费点都能写成
//     const tts = services.get<TtsService>("speech.tts");
//     if (!tts) return null;        // 没装扩展 → 走原来的路径
// 不装任何扩展包时，整条链路的行为和现在一模一样。
//
// 为什么用 Proxy 而不是为每个服务写一层适配：宿主不该知道"语音"是什么。
// 业务语义全在消费方的 TS 接口里（见 contracts/tts.ts），注册表只负责转发。

import type { ExtensionRuntime } from "./runtime";

/** 服务描述，给设置界面列"这个包提供了什么"。 */
export interface ServiceDescriptor {
    /** 如 speech.tts */
    id: string;
    title: string;
    packId: string;
}

interface ServiceEntry {
    descriptor: ServiceDescriptor;
    runtime: ExtensionRuntime;
}

/**
 * Proxy 上必须放行的属性名。
 * 尤其 then/catch/finally：如果哪天有人 await 了这个服务对象，返回函数会被当成
 * thenable 直接调用，报一个完全看不懂的错 —— 干脆返回 undefined。
 */
const RESERVED_PROPS = new Set([
    "then",
    "catch",
    "finally",
    "toJSON",
    "inspect",
    "constructor",
    "valueOf",
    "toString",
    Symbol.toStringTag as unknown as string,
]);

export class ServiceRegistry {
    private readonly entries = new Map<string, ServiceEntry>();

    /** 注册（后注册的覆盖先注册的，并返回被覆盖者，便于上层告警） */
    register(descriptor: ServiceDescriptor, runtime: ExtensionRuntime): ServiceDescriptor | null {
        const prev = this.entries.get(descriptor.id)?.descriptor ?? null;
        this.entries.set(descriptor.id, { descriptor, runtime });
        return prev;
    }

    unregisterPack(packId: string): void {
        for (const [id, entry] of this.entries) {
            if (entry.descriptor.packId === packId) this.entries.delete(id);
        }
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    list(): ServiceDescriptor[] {
        return [...this.entries.values()].map((e) => e.descriptor);
    }

    /**
     * 取一个服务。没有扩展提供时返回 null。
     *
     * 方法调用的参数约定：调用方传什么就作为 { args: [...] } 转发给 sidecar，
     * 由扩展包自己解释。这样宿主不需要为每个服务写 DTO。
     */
    get<T extends object>(id: string): T | null {
        const entry = this.entries.get(id);
        if (!entry) return null;
        const { runtime } = entry;
        return new Proxy({} as T, {
            get: (_target, prop) => {
                if (typeof prop !== "string") return undefined;
                if (RESERVED_PROPS.has(prop)) return undefined;
                if (prop === "packId") return entry.descriptor.packId;
                return (...args: unknown[]) => runtime.callService(id, prop, { args });
            },
        });
    }
}
