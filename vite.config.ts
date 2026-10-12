import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron";
import { createRequire } from "node:module";

// 渲染层要用 package.json 的版本号（设置页左下角）。构建期注入，永不手改。
const requirePkg = createRequire(import.meta.url);
const pkgVersion = requirePkg("./package.json").version;

// 组网密钥**不在这里注入**。
//
// 两端在网络里的地位完全一样，谁也不带密钥出厂：本机当主机时自己签一把，
// 当叶子时凭一张邀请码在配对那一刻领（enroll）。所以构建期没有任何密钥可注入 ——
// 同一个安装包发出去，是互不相通、也互不可见的若干个网。
// 想彻底禁掉组网能力的发行版，显式调 NetManager.setAutoProvisionSecret(false)。

export default defineConfig(() => {
    return {
        // 渲染层构建常量（主进程那份在 electron/ 里对应还有一份，互不相通）
        define: {
            __APP_VERSION__: JSON.stringify(pkgVersion),
        },
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