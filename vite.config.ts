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
