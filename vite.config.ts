import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron";

export default defineConfig({
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
            // 组网密钥：构建期注入，编译进产物。
            //
            // 用 define 而不是 import.meta.env —— 这个值只在主进程用，
            // 渲染层不该看到；define 直接替换成字符串字面量，运行时不留
            // 任何「去环境变量里读」的痕迹。
            //
            // 取不到时注入空串，NET_ENABLED 为 false → 组网功能整体禁用。
            // 这样 fork 后自行构建的人，产物里不会带着别人的密钥，
            // 组网按钮也是灰的（见 electron/net/secure.ts）。
            //
            // CI 从 GitHub Secret 注入，本地用 .env.local（已 gitignore）。
            __KIRARI_NET_SECRET__: JSON.stringify(process.env.KIRARI_NET_SECRET || ""),
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
});
