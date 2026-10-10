import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron";

export default defineConfig(({ mode }) => {
    // ── 组网密钥：三个来源，优先级从高到低 ──
    //   1) 进程环境变量（CI 的 GitHub Secret 就是走这条）
    //   2) 项目内 .env.local（本地开发，已 gitignore）
    //   3) 空 —— 组网功能整体禁用
    //
    // ⚠️ 必须用 loadEnv 显式读文件：vite 只会把 VITE_ 前缀的变量自动塞进
    //    import.meta.env，**不会**写进 process.env。所以直接读
    //    process.env.KIRARI_NET_SECRET 在本地永远是空的（CI 才对），
    //    症状是「本地打的包组网开不了，CI 打的能开」。
    //    第三个参数传空串 = 不限前缀，全读。
    const fileEnv = loadEnv(mode, process.cwd(), "");
    const netSecret = (process.env.KIRARI_NET_SECRET || fileEnv.KIRARI_NET_SECRET || "").trim();
    const netSecretOk = netSecret.length >= 16;
    const netSecretFrom = process.env.KIRARI_NET_SECRET ? "环境变量" : fileEnv.KIRARI_NET_SECRET ? ".env.local" : "未提供";

    // 构建时就把结论打印出来 —— 打包后不必再猜「这个包到底带没带密钥」。
    if (netSecretOk) {
        console.log(`\x1b[32m[组网]\x1b[0m 密钥已注入（来源：${netSecretFrom}，长度 ${netSecret.length}）→ 组网功能可用`);
    } else if (netSecret) {
        console.log(
            `\x1b[33m[组网]\x1b[0m 密钥太短（${netSecret.length} 位，至少要 16 位）→ 组网功能会被禁用`,
        );
    } else {
        console.log(
            `\x1b[33m[组网]\x1b[0m 未找到密钥 → 本次构建的组网功能是禁用的。\x1b[0m\n` +
                `        本地：在项目根建 .env.local 写一行 KIRARI_NET_SECRET=你的密钥（≥16 位）\n` +
                `        CI：在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 KIRARI_NET_SECRET`,
        );
    }

    return {
        server: {
            // 强制 IPv4 回环。Windows 上 localhost 常被解析为 IPv6 ::1，
            // 而绑定 ::1 会报 EACCES: permission denied，改用 127.0.0.1 规避。
            host: "127.0.0.1",
            // 端口 5173 落在 Windows(Hyper-V/WSL2) 的保留段 5101–5300 内，
            // 系统会拒绝绑定（EACCES，非端口占用）。改用 3000 避开保留段。
            // 若 3000 也被占，strictPort:false 会让 Vite 自动顺延到下一个可用端口。
            port: 3000,
            strictPort: false,
        },
        plugins: [
            vue(),
            electron([
                {
                    entry: "electron/main.ts",
                    // better-sqlite3 是原生模块：它的 .node 二进制无法被打包进 JS，
                    // 必须保持在 node_modules 里由运行时按路径加载（electron-builder 会把它
                    // 从 asar 中解包出来）。其余依赖照常内联。
                    vite: {
                        build: {
                            rollupOptions: {
                                external: ["better-sqlite3"],
                            },
                        },
                        define: {
                            // 用 define 而不是 import.meta.env —— 这个值只在主进程用，
                            // 渲染层不该看到；define 直接替换成字符串字面量，运行时不留
                            // 任何「去环境变量里读」的痕迹。
                            __KIRARI_NET_SECRET__: JSON.stringify(netSecret),
                        },
                    },
                    async onstart({ startup }) {
                        const env = { ...process.env };
                        delete env.ELECTRON_RUN_AS_NODE;
                        await startup(undefined, { env });
                    },
                },
                {
                    entry: "electron/preload.ts",
                },
            ]),
        ],
    };
});