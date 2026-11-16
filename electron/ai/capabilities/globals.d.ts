// vite 的 import.meta.glob 类型声明（主进程由 vite 打包，vitest 也支持）。
interface ImportMeta {
    glob<T = unknown>(
        pattern: string,
        options?: { eager?: boolean; import?: string },
    ): Record<string, T>;
}
