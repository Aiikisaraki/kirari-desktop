<p align="center">
  <img src="./assets/kirari-banner.jpg" alt="Kirari 绮莉" width="720">
</p>

# Kirari 绮莉

> 让一个会聊天、会记事、能陪在桌面上的小伙伴，安静地住进你的电脑。

Kirari 是以桌面宠物为主体的机器人项目。它优先保证桌面陪伴体验，同时提供 AI 对话、记忆、知识库、换肤、工具调用，以及可选的 OneBot / QQ 消息接入能力。

当前客户端版本：`0.7.2`

## 能做什么

- **桌面陪伴**：透明无边框窗口、可拖动、逐像素点穿、多种动画状态和多套形象。
- **AI 对话**：支持文本和图片消息，可连接任意 OpenAI 兼容服务。
- **记忆与知识库**：保存对话上下文，支持公用知识源和私人知识库。
- **个性化形象**：支持官方皮肤、自定义形象包、聊天头像和情绪动画。
- **工具扩展**：可配置外部工具服务，让 Kirari 在对话中调用天气、搜索或其他工具。
- **机器人接入**：内置 OneBot 适配器，可桥接 QQ 等消息平台；这是桌宠能力的可选扩展，不影响桌面端单独使用。

## 安装与版本选择

推荐从 [Releases](https://github.com/Aiikisaraki/kirari-desktop/releases) 下载 Windows 安装包：

| 版本 | 适合谁 | 特点 |
| --- | --- | --- |
| 纯前端版 | 已有独立后端的用户 | 安装包小，连接远程 `kirari-core` |
| 整合版 | 想开箱即用的用户 | 客户端内置后端，本地模式自动启动 |
| 全功能版 | 需要在本地部署或连接远程服务的用户 | 安装时可选择使用本地后端或远程后端 |

本地模式会在启动时自动选择可用端口，并由客户端把连接地址传给内置后端。不要把 `9089` 当作桌面端永远固定使用的端口。

## 从源码运行

### 前端开发

```bash
npm install
npm run dev
```

`npm run dev` 启动 Vite 前端开发服务。开发本地后端时，请在另一个终端进入 [`kirari-core`](https://github.com/Aiikisaraki/kirari-core) 仓库并单独启动后端。开发端口以终端输出为准，端口被占用时 Vite 会自动顺延。

### Windows 本地打包

以下命令在 Windows Git Bash 中执行：

```bash
rm -rf release
npm run dist:integrated
```

常用打包命令：

```bash
npm run dist:frontend   # 纯前端版
npm run dist:integrated # 前后端整合版
npm run dist:full       # 全功能版
npm run dist:all        # 一次构建三种版本
```

后端运行时和依赖会在打包前由脚本准备，后端源码以 `kirari-core` 仓库为准。不要直接修改 `build-resources/pet-api-bundle` 或其他构建产物，它们会在下一次打包时重新生成。

### 官方形象资源

官方形象的二进制资源使用 Git LFS 管理。首次获取源码后请确保已安装 Git LFS，并执行：

```bash
git lfs install
git lfs pull
```

如果只拿到了几 KB 的文本指针而不是图片，说明 LFS 资源尚未拉取完整，打包前应先修复。

修改 Electron 主进程代码（例如 `electron/main.ts`、后端启动器或 IPC 相关文件）后，需要完整重启开发进程；Vite 热更新只覆盖渲染层。

## 项目关系

- [`kirari-desktop`](https://github.com/Aiikisaraki/kirari-desktop)：本仓库，桌面宠物客户端。
- [`kirari-core`](https://github.com/Aiikisaraki/kirari-core)：对话、记忆、知识库、账户和工具服务。
- [OneBot](https://onebot.dev/)：可选的消息平台协议接入层。

客户端与后端的通信由桌面主进程统一管理。远程部署时，在设置中填写后端地址；本地模式则由客户端负责拉起并连接内置后端。

## 配置说明

首次启动后，可在设置中填写模型服务地址、模型名称和密钥。客户端会把配置保存在用户目录，不要把包含密钥的配置文件提交到 Git。

模型服务需兼容 OpenAI API 格式。默认端点仅作为示例和初始配置来源，实际可用性、费用、地区限制和服务条款以对应服务商为准。

## 已知边界

- 项目当前以 Windows 桌面端为主要发布目标；源码层面保留跨平台 Electron 结构。
- OneBot / QQ 接入适合熟悉消息平台配置的用户，具体反向连接地址和鉴权方式取决于所使用的 OneBot 实现。
- 外部模型、搜索、天气和其他数据服务可能有速率限制或临时不可用，服务异常时部分对话会进入降级处理。
- 当前仓库没有完整的自动化测试套件，发布前应至少验证启动、拖动、点穿、聊天、换肤和打包安装流程。

## 许可证与资源

- 代码采用 [MIT License](./LICENSE)。
- MingCute 图标来自 <https://www.mingcute.com>，请遵守其许可证和署名要求。
- 角色形象、横幅和其他视觉素材包含 AI 生成与人工设计、编排、调校内容。素材权利可能与代码权利不同，二次分发时请自行确认相关授权和当地法律要求。
- 使用的第三方模型、接口、数据源和工具服务均须遵守其服务条款，密钥和使用责任由使用者自行承担。

## 参与开发

欢迎提交 Issue 和 Pull Request。提交前请先确认改动属于客户端还是 `kirari-core`，并尽量保持桌宠的拖动、点穿、动画、换肤和安装包稳定性。

后端接口细节请查看 [`kirari-core/PORTREADME.md`](https://github.com/Aiikisaraki/kirari-core/blob/main/PORTREADME.md)。
