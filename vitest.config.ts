import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 测试配置单独一份，不复用 vite.config.ts —— 那份挂了 vite-plugin-electron，
// 跑 vitest 会顺带去启动 Electron 窗口、还会去读组网密钥打印提示，纯属自找麻烦。
export default defineConfig({
    plugins: [vue()],
    test: {
        // 默认渲染层环境。主进程（electron/ 下）的测试文件在文件头写
        // `// @vitest-environment node` 单独切过去。
        environment: "happy-dom",
        include: ["src/**/*.spec.ts", "electron/**/*.spec.ts"],
        restoreMocks: true,
        // 组网密钥。secure.ts 在**模块加载时**就算好 NET_ENABLED，测试里再
        // process.env 赋值已经晚了（import 会先执行），必须在这里给。
        // 这是测试专用密钥，不进产物（产物里的是 vite define 注入的那个）。
        env: {
            KIRARI_NET_SECRET: "kirari-integration-test-only-secret",
        },
        // 组网端到端要真起 WebSocket 走握手+加密，比普通单测慢。
        testTimeout: 15000,
    },
});
