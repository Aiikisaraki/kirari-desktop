<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari" width="720">
</p>

# Kirari 绮莉 (kirari-desktop)

桌面宠物客户端：Electron + Vue 3 + Vite + TypeScript。

## 特性

- 模型配置可在安装向导或「设置」中填写，配置持久化于用户目录 `config.json`，直接编辑文件即生效。
- 默认使用免费大模型 API（chatanywhere），也可自由切换任意 OpenAI 兼容端点。
- 可作为 **QQ 机器人** 运行（通过内置 OneBot 适配器桥接）。
- 可接入 **MCP（Model Context Protocol）服务器**，把外部工具交给桌宠调用。

## 关联项目

- **[kirari-core](https://github.com/Aiikisaraki/kirari-core)（后端服务）**：本客户端通过 WebSocket（`ws://localhost:9089/ws`）与 HTTP（`http://localhost:9089`）对接后端；开发/集成模式下后端作为本地子进程随客户端启动，也可在设置中填写远端地址对接独立部署的后端。
- **OneBot 协议**：内置 OneBot 适配器（`electron/adapter/onebot-adapter.ts`），以正向 WebSocket（如 `ws://127.0.0.1:3001`）桥接 QQ 等平台消息，使桌宠可作为聊天机器人使用。
- **MCP 服务器**：设置中可配置任意 MCP（streamable-HTTP / stdio）服务器，其工具由客户端托管，并通过后端 WS 工具桥接（工具名前缀 `frontend__`）供模型调用。

## 引用的 API 与外部服务

| 用途 | 服务 / 端点 | 说明 |
| ---- | ----------- | ---- |
| 大模型对话（OpenAI 兼容） | 默认 `https://api.chatanywhere.tech/v1`（免费 Key 见 [chatanywhere/GPT_API_free](https://github.com/chatanywhere/GPT_API_free)） | 可在「模型设置」切换为任意 OpenAI 兼容端点（如智谱 GLM、通义千问、DeepSeek 等）；实际由后端 kirari-core 调用。 |
| 工具栏图标 | [MingCute](https://www.mingcute.com)（萌趣图标） | 聊天气泡工具栏图标来源，详见下方「资源版权」。 |

> 本项目仅把上述服务作为**可配置端点/素材来源**引用，不内置其任何专有内容；使用这些服务须遵守各自的服务条款，相关密钥由使用者自行提供并承担合规责任。

## 主要第三方依赖

运行时：`vue`、`pinia`、`electron`、`marked`（Markdown 渲染）、`dompurify`（HTML 净化）、`katex`（公式渲染）、`extract-zip`（形象压缩包解压）、`birpc` / `hookable` / `perfect-debounce` / `nostics`（开发工具链）。

构建/开发：`vite`、`@vitejs/plugin-vue`、`vite-plugin-electron`、`electron-builder`、`typescript`、`vue-tsc`。

以上依赖各自沿用其原始开源许可证（多为 MIT / ISC / Apache-2.0），通过 npm 安装，其许可证随包提供，使用即视为接受其条款。

## 开发

```bash
npm install
npm run dev          # 开发模式（前端 + 本地后端子进程）
```

## 打包（本地）

```bash
rm -rf release
npm run dist         # vite build + electron-builder，产出 release/*.exe
```

## 仓库结构

- 本仓库为**前端/客户端**（Electron 应用）。
- 后端服务见 [`kirari-core`](https://github.com/Aiikisaraki/kirari-core)。

## 许可证与资源版权

- **代码**：本项目以 **MIT 许可证** 发布，详见仓库根目录 [`LICENSE`](./LICENSE)。
- **第三方依赖**：运行时与构建依赖各自沿用其原始开源许可证（见上方「主要第三方依赖」），通过 npm 安装，其许可证随包提供。
- **图标（MingCute）**：聊天气泡工具栏图标使用 MingCute 图标库。MingCute 可免费用于个人与商业用途，请保留其署名，出处：<https://www.mingcute.com>。
- **形象与视觉素材（AI 生成 + 人工设计）**：`assets/kirari-banner.jpg`、`public/avatars/*`、`resources/official-avatars/*`、`build-resources/icons/*` 等角色形象与图标，由作者通过 AI 生成并结合人工设计、调校而成。关于 AI 生成内容的著作权，各地法律认定不一（部分地区要求具备人类创造性贡献方可构成作品）；作者就其中的人工设计、编排与后期处理主张权利，并在法律允许范围内按 MIT 许可证授权。如你另行分发这些素材，请留意 AI 生成内容的权属可能与代码不同，并自行留存生成过程记录。
- **外部服务**：本项目仅把第三方 API 作为可配置端点引用，不内置其专有内容；使用须遵守各自服务条款，密钥由使用者自行提供并承担合规责任。

---

> 🤖 **本项目由 AI 辅助创建并持续维护**。界面、交互逻辑与打包流程均在 AI 协作下设计与实现，欢迎反馈与共建。
