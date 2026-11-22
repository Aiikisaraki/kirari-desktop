# 设置界面重做规范（两端共用）

> 这份文档在桌宠端 `kirari-desktop` 和核心版 `kirari-core/web` 里是同一份。
> 两端设置页的**分组、顺序、标题、结构、控件**都按这里来；只有「核心版没有的功能」
> 允许不同（形象、开机自启、明暗等，见下面「已知差异」）。

## 1. 为什么重做

旧界面的问题不是"不好看"，是**没有统一的结构**：

- 同一件事有三种写法（`.settings-row` 行、`.field` 竖排、直接摆 input），
  导致同一页里字号、行距、控件高度都不一样；
- 样式散在 `settings.css`（50KB）+ 每个组件各自的 `<style scoped>` + 大量 `style="..."` 内联，
  改一处颜色要翻五个地方，还出现了引用不存在变量（`--primary-color`）的兜底色；
- 桌宠端用 emoji 当图标、核心版用线性 SVG，两端视觉语言分裂；
- 分类不清：11 个平铺条目没有分组，核心版还把"模型"叫"大脑"、"MCP"叫"工具服务"。

新结构只有三样东西：**分区导航**（4 组）→ **页头**（图标+标题+一句话）→ **卡片里的行**。

## 2. 信息架构（两端必须一致）

| 组 | 页 | id | 一句话（页头 desc） |
| --- | --- | --- | --- |
| 本机 | 外观 | `appearance` | 换一套界面配色。切换即时生效，只影响观感，不动任何数据。 |
| 本机 | 形象 | `avatar` | *仅桌宠端* 换一只桌宠。每个形象自带立绘与动作，换完立刻出现在桌面上。 |
| 身份 | 通用 | `general` | 她的名字，以及开机时要不要自动出现。 |
| 身份 | 个人 | `profile` | 聊天时代表你的那张头像。 |
| 身份 | 人格 | `persona` | 她是谁、怎么说话。换模型、换设备都不会变的那一层。 |
| 能力 | 模型 | `model` | 接哪家大模型，以及回答实时问题时的搜索渠道。 |
| 能力 | 技能 | `skill` | 给她加行为模板或可调用的工具。 |
| 能力 | 知识库 | `knowledge` | 你希望她记住的事实，以及可以实时去查的远程来源。 |
| 能力 | 工具服务 | `mcp` | 接入外部 MCP 服务，让她能读写文件、查资料、调接口。 |
| 连接 | 机器人 | `bot` | 接 QQ / OneBot，让她在聊天软件里也能回你。 |
| 连接 | 组网 | `sync` | 几台设备共用一个大脑：一台当主机，其余接进来。 |

命名统一：**模型**（不再叫"大脑"）、**工具服务**（MCP 只是它的协议）、**组网**。

分区表在 `settings/sections.ts|js`，导航和页头都从它取文案 —— 不要在组件里再写死一次标题。

## 3. 骨架分工

| 层 | 桌宠端 | 核心版 |
| --- | --- | --- |
| 壳（导航+页头+toast） | `settings/SettingsPage.vue` | `App.vue` |
| 导航 | `settings/SettingsNav.vue` | `settings/SettingsNav.vue` |
| 图标 | `settings/SettingsIcon.vue` | `settings/SettingsIcon.vue` |
| 样式 | `settings/kit.css` | `settings/kit.css` |
| 页面 | `settings/XxxSettings.vue`，**只输出卡片** | 同左 |

设置页 = `<section class="sk-page">` + 一或多张 `.sk-card`。
**页面里不写页头、不写 `<style>`、不写内联 `style="..."`。**

## 4. 组件用法（只允许这些）

```
骨架   .sk-page .sk-card .sk-card__head .sk-card__title .sk-card__desc
       .sk-card__body .sk-card__foot .sk-divider .sk-empty
行     .sk-row .sk-row__main .sk-row__title .sk-row__desc .sk-row__control
       .sk-row--stack（控件换行到下一排）
字段   .sk-field .sk-field__label .sk-field__hint .sk-grid
控件   .sk-input .sk-textarea .sk-select .sk-input--sm .sk-input--mono
       .sk-switch + .sk-switch__track / .sk-check / .sk-checks
按钮   .sk-btn [--primary|--ghost|--danger|--sm|--block|--icon] .sk-btn-row .sk-toolbar
选择   .sk-choices .sk-choice[.is-active] .sk-choice__text/__label/__sub/__check
       .sk-swatch--<themeId>  .sk-segmented + .sk-segmented__item
条目   .sk-items .sk-item[.is-active] .sk-item__main/__title/__meta/__ops
       .sk-editor .sk-editor__title .sk-editor__foot
反馈   .sk-badge [--brand|--ok|--warn|--danger|--mono] .sk-dot
       .sk-alert.sk-alert--error|--ok|--warn   .sk-note [--brand|--warn]
       .sk-hint .sk-hint--warn
其它   .sk-avatar .sk-media-row .sk-code .sk-code--inline .sk-mono .sk-muted .sk-clamp
```

规则：

1. **保存成功**：`emit("saved", "已保存")? ` → 壳统一弹 `.sk-toast`。页面里不再画"保存成功"。
2. **失败**：页面里画 `.sk-alert.sk-alert--error`，别用 alert/toast 组件（桌宠端那套 toast 没有宿主）。
3. **行 vs 字段**：一行一个开关/输入 → `.sk-row`；一段需要写很多的表单（人格、提示词）→ `.sk-field`。
4. **列表型**（模型/技能/知识/MCP/机器人/组网设备）统一 `.sk-items > .sk-item`，
   操作按钮一律 `.sk-btn.sk-btn--ghost.sk-btn--sm`，删除加 `.sk-btn--danger`。
5. 不再用 emoji 当图标；需要图标时用 `<SettingsIcon name="…" />`。
6. 间距只用 2/6/8/10/12/14/16/18，字号只用 10.5/11/11.5/12/12.5/13/13.5/14.5/19。

## 5. 每页目标结构

### 外观 appearance
- desk：卡片「主题配色」→ `.sk-choices` 4 张主题卡 + 底部 `.sk-hint`。
- core：卡片「明暗」→ 3 张（浅色/深色/跟随系统，图标 sun/moon/auto）；卡片「配色」→ 4 张主题卡。

### 形象 avatar（仅桌宠端）
- 卡片「当前形象」：`.sk-row` 名称 + `.sk-select`。
- 卡片「管理形象」：`.sk-btn-row`（上传压缩包 / 打开形象文件夹）+ `.sk-alert--error` + `.sk-hint`。

### 通用 general
- 卡片（无标题）行：**备注名**（`.sk-input`；desk 失焦/回车保存，core 后面跟「保存」按钮）、
  **开机自启**（`.sk-switch`，仅 desk）。
- 底部 `.sk-note`：说明为什么没有另一半（desk 自带大脑 / core 是服务没有自启）。

### 个人 profile
- 卡片（无标题）：`.sk-media-row`（`.sk-avatar` 72px + 按钮组）+ `.sk-hint` + `.sk-alert--error`。

### 人格 persona
- 卡片「基础人格」：`.sk-field` 标签 + `.sk-textarea` + 字数 `.sk-hint`；
  `.sk-card__foot` 放「恢复默认」+「保存」。
- 卡片「当前默认人格」（仅 desk，有预设文案时）：`.sk-note` 里整段文字。

### 模型 model
- 卡片「模型」：`.sk-items` 每套一行（名字 + `.sk-badge--brand`「使用中」/ `.sk-badge--warn`「没填钥匙」，
  `.sk-item__meta` 型号、地址，`.sk-item__meta--mono` 钥匙掩码）；操作：设为当前 / 编辑 / 删除；
  末尾「+ 添加一套」，编辑态用 `.sk-editor`（名字、服务地址、型号、钥匙 → 保存/取消）。
- 卡片「联网搜索」：`.sk-choices` 选渠道（core 多一个「不用」）+ 对应凭证字段 + 「保存」。

### 技能 skill
- 卡片「技能」：`.sk-items` 每项（名字 + `.sk-badge`「行为模板」/「N 个工具」+ 描述）；
  右侧开关 + 编辑 / 删除；「+ 添加技能」；`.sk-editor` 内：名字、一句话说明、行为模板 textarea、
  启用 `.sk-check`、core 额外有工具列表编辑。

### 知识库 knowledge
- 卡片「本地知识」：`.sk-items`（标题 + 分类 badge + 内容 `.sk-clamp` + 标签）+ 编辑/删除；
  「+ 添加知识」；`.sk-editor`：标题、内容、分类、标签。
- 卡片「远程源」：`.sk-items`（名字 + 启用状态 + URL）+ 编辑/删除；「+ 添加远程源」；
  `.sk-editor`：名字、地址、类型、优先级、启用。

### 工具服务 mcp
- 卡片「工具服务」：`.sk-items`（名字 + `.sk-badge` 传输方式 + 端点 `.sk-item__meta--mono`），
  右侧开关 + 编辑 / 删除；「+ 添加工具服务」；`.sk-editor`：连接方式 `.sk-segmented`（HTTP / 本地命令）、
  名字、地址或命令+参数、启用；core 额外「测试连接」。

### 机器人 bot
- 卡片「机器人」：叶子只读提示 `.sk-alert--warn`；`.sk-items`（名字 + 协议 badge + 连接状态 badge +
  账号/地址 + 错误行 + 群消息设置行 + 主人绑定行）；操作：连接/断开（desk）或启用开关（core）+ 删除；
  「+ 添加机器人」；新增/编辑用 `.sk-editor`，协议类型明确使用 `.sk-select`，选定后显示对应凭证字段与群消息策略。
- 底部 `.sk-note`：群消息默认全关、白名单优先的安全说明。

### 组网 sync
- 卡片「组网总开关」：状态行 + 动作（`.sk-segmented` 或主按钮）+ 角色选择面板（`.sk-editor`）。
- 卡片「这台设备」：名字（可改）、设备号 `.sk-code--inline`、地址（主机时）。
- 卡片「当主机」：连接码（生成 / 展示 `.sk-code` / 复制 / 二维码）、有效期、已生成的码、已接入设备、统一哪些配置。
- 卡片「当叶子」：主机地址 + 状态 badge、待同步条数 + 立即同步、换主机、移除自己。
- 底部 `.sk-alert--warn`：额度/隐私说明。

## 6. 已知（允许）差异

| 项 | 桌宠端 | 核心版 | 原因 |
| --- | --- | --- | --- |
| 形象 | 有 | 无 | 核心版没有桌宠可换 |
| 开机自启 | 有 | 无 | 核心版是常驻服务，交给系统/容器 |
| 明暗 | 无 | 有 | 桌宠窗口是浮在桌面上的浅色玻璃壳，暂不做深色 |
| 搜索渠道「不用」 | 无 | 有 | 后端默认值不同 |
| 机器人连接方式 | 连接/断开按钮 | 启用开关 | 两端的连接模型不同 |

## 7. 验收

- 两端 `settings/kit.css` 除「平台适配层」外逐字一致。
- 设置页组件里搜不到：`style="`、`<style`、`emoji`、`settings-row`、`text-input`、`class="btn`。
- 桌宠端：`npm run typecheck` + `npm test` 通过。
- 核心版：`cd web && npm run build` 通过。
