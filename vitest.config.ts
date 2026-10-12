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
        // 组网密钥不再需要在这里注入：组网实现已搬到独立包 kirari-net，
        // 密钥也改成显式注入（桌面端在 main.ts 启动时调 initNetSecret()），
        // 不再依赖「env 必须早于模块加载」那种时序技巧。
        // 组网层的测试跟着代码一起搬到了 kirari-net（那边自有 npm test）。
        testTimeout: 15000,
    },
});
