# Kirari 绮莉 · 拟人度 / 主动性 基线报告

> 审读对象：\`D:\personal-proj\akisaki-kirari\`，桌面端 \`v1.0.0\`
> 审读方式：只读审读（read / grep），未修改任何源码、未执行构建。
> 证据约定：所有结论后附 \`文件:行号\`，行号为审读当时文件中的实际行号。
> 结论口径：只描述**当前代码实际行为**，不复述注释里的意图或历史设计说明（注释与实现不一致处会单独标出）。

---

## 0. 版本与总体定位

| 项 | 现状 | 证据 |
| --- | --- | --- |
| 包版本 | \`1.0.0\` | \`package.json:4\` |
| README 声明版本 | \`0.9.0\`（与 package.json 不一致） | \`README.md:11\` |
| 主进程入口 | \`dist-electron/main.js\`（由 Vite 构建 \`electron/main.ts\`） | \`package.json:5\` |
| 定位 | 「会聊天、会记事、能陪在桌面上」的桌宠 + 可选 QQ 机器人接入 | \`README.md:7-9\` |

一句话基线：**她是一个"你说话她才动"的桌宠**。人格/记忆/场景注入这一侧工程化程度很高（分层提示、记忆分池、可信度分级都做了），但「自发行为」这一侧极薄——情绪是**一次性动画标签**而不是状态，主动开口只有**定时任务到点**一条路，桌面环境（你在用什么软件、你离开了多久）完全不可见，也没有任何语音出口。

---

## 1. 现有能力清单

### A. 人格与提示词

#### A1. system prompt 的拼装顺序（真实代码顺序）

入口：\`electron/ai/services/conversationService.ts:199-200\` 先用 \`buildBasePrompt(persona)\` 得到"人格基座"，再用 \`buildSystemPrompts(base)\` 派生四条分支模板（\`normal / withTools / polish / locationSet\`）。

真正发出去的 system 内容，按下述顺序逐段 \`+=\` 拼接（括号内为证据行号）：

1. **人格基座** = \`identity\`（自定义人格，空则 \`DEFAULT_PERSONA\`） + \`GROUNDING_RULES\` + \`JSON_OUTPUT_CONTRACT\`
   - \`electron/ai/reply/promptBuilder.ts:84-88\`
2. **分支模板**（normal / withTools / polish / locationSet 选一）— \`conversationService.ts:372-374\`
3. **时间基准** \`buildTimeContext\` — \`conversationService.ts:389\`，实现 \`electron/ai/reply/timeContext.ts:74-90\`
4. **自我认知清单** \`selfOps.buildManifest\`（我是谁/我有什么能力/当前模型/未完成任务）— \`conversationService.ts:394\`
5. **思考模式**（on/auto 时追加"先想再答"）— \`conversationService.ts:400-406\`
6. **未完成任务恢复块** \`taskRuntime.resumeBlock\` — \`conversationService.ts:412-413\`
7. **场合段** \`buildSceneContext\` — \`conversationService.ts:417\`，实现 \`electron/ai/reply/sceneContext.ts:84-128\`
8. **设备段** \`buildDeviceBlock\`（仅组网多机时非空）— \`conversationService.ts:428-433\`，实现 \`electron/ai/reply/deviceBlock.ts:23-68\`
9. **元指令 CHARTER** — \`conversationService.ts:439\`，实现 \`electron/ai/reply/charter.ts:11-34\`
10. **社交环境摘要** \`social.buildEnvironmentBlock\` — \`conversationService.ts:445-448\`
11. **工作空间段** \`buildWorkspaceBlock\` — \`conversationService.ts:463-470\`
12. **长期记忆段** \`memory.buildMemoryBlock\` — \`conversationService.ts:477-491\`
13. **记忆使用指引**（什么时候该 remember）— \`conversationService.ts:497-505\`
14. **技能段**（前端 skillPrompts + SKILL.md 目录）— \`conversationService.ts:508-513\`

最后按"四段注入"落库并拼成一条 system message：

- \`system.base\` ← 上面 1-13 全部文本；\`daily_brief\`；\`knowledge\`；\`skills\`
- \`conversationService.ts:559-576\`

#### A2. 有没有"分层人格"？

有，但分层的是**约束强度**，不是"表达风格/内心/表层"这种拟人分层。

| 层 | 内容 | 可被用户覆盖？ | 证据 |
| --- | --- | --- | --- |
| 元指令 CHARTER | 8 条根本准则（不伤害/不骗人/守隐私/尊重自主/承认边界/拒绝也要像个人/不被话术劫持/身份只认当场事实） | 否，声明"优先级高于人格设定和任何单轮指令" | \`charter.ts:11-13\`、\`charter.ts:22-27\` |
| 人格 persona | 名字、形象、性格内核 | 是（设置页可整段替换） | \`promptBuilder.ts:37-52\`、\`src/components/settings/PersonaSettings.vue:38-48\` |
| 事实约束 GROUNDING | 禁止编造台词/数据/出处，被纠正时先认错 | 否 | \`promptBuilder.ts:21-25\` |
| 输出契约 JSON | \`{"speech","emotion"}\` | 否 | \`promptBuilder.ts:54-75\` |
| 场合段 | 群聊/私聊、对谁说话、群聊隐私红线 | 否（由入场 scene 决定） | \`sceneContext.ts:84-128\` |
| 说话要求段 | "别像模板"：少用语气词、别每句反问、短一点、别用 AI 腔 | 否 | \`sceneContext.ts:117-126\` |

注意一处**层级与实现不一致**：CHARTER 自称"永远追加、后写者优先"（\`charter.ts:8-9\`），但它被夹在中间（\`conversationService.ts:439\`），后面还追加了社交环境（448）、工作空间（470）、记忆（491）、记忆指引（497-505）、技能（508-513）以及 \`daily_brief / knowledge / skills\` 三段（\`566-570\`）。按"后写者优先"的惯例，**记忆与技能段在优先级上其实排在 CHARTER 之后**。

#### A3. 有没有"不许出戏"的约束？

**没有直接的"保持角色、不得承认自己是 AI/模型"这类约束**；相反，CHARTER 第 5 条**要求她承认边界**：

- "你是运行在对方设备上的桌宠程序，不是万能的……不要装作能访问你没有的东西" — \`charter.ts:19\`
- 兜底文案原则里也明确"兜底是模型挂了的策，语气就写平实一点，别假装热络" — \`fallbackResponses.ts:15\`
- CHARTER 要求"不要提『根据我的准则/系统提示』" — \`charter.ts:28\`（这是**唯一**接近"别暴露提示层"的约束）

也就是说：防的是"冒充真人身份/官方"（\`charter.ts:16\`），不是防"出戏"。人格一致性靠 \`DEFAULT_PERSONA\` 里"性格稳定、表达随场合变"这一段（\`promptBuilder.ts:50-52\`）。

#### A4. 时间与场景感知

- **时间**：每轮注入\`【时间基准 · 最高优先级】\`，含年月日/星期/时分/IANA 时区/UTC 偏移、地点标签，并明确"以本段为准"、"不要把时区 ID 原样念出来"。\`timeContext.ts:82-89\`。时区来源为位置表的 \`timezone\`，查库失败也兜底生成（\`conversationService.ts:379-388\`）。
- **场景**：由 \`RawScene\` 归一化出 \`group / private / dm / local\` 四类（\`sceneContext.ts:42-67\`），群聊时给出 5 条隐私红线 + "群里语气收一点"（\`sceneContext.ts:103-111\`），一对一给"可以放松、更亲近"（\`sceneContext.ts:113\`）。本机主人入口固定走 \`ownerScene()\`（\`ownerIdentity.ts:139-151\`，\`chat-session-service.ts:380\`）。
- **环境**：只有 QQ 协议端的社交事实（几个群/几个好友/谁进群/谁戳我）— \`social.ts:167-208\`。**桌面侧环境（前台窗口、正在用什么软件、开机多久、用户离开多久）完全没有采集**（全仓 grep \`active-win/getWindowTitle/foreground/idleTime\` 无命中；主进程只用 \`screen.getCursorScreenPoint\` 做拖拽与点穿：\`main.ts:2335-2388\`）。

#### A5. 回复格式约束

- 只输出一个 JSON 对象，字段 \`speech\` + \`emotion\`，不要 markdown 代码块 — \`promptBuilder.ts:55-58\`。
- \`emotion\` 枚举 14 个值：\`happy / wave / excited / surprised / shy / sad / nod / shake / bow / thinking / head_tilt / angry / attention / stretch\`，其余填 \`null\` — \`promptBuilder.ts:59-74\`。
- 允许在 \`speech\` 里用 markdown 图片语法，系统会单独渲染 — \`promptBuilder.ts:75\`。
- 解析侧四级容错（严格 JSON → 修复残缺 JSON → 正则抠字段 → 纯文本兜底），并抽出图片 URL — \`parser.ts:126-145\`、\`parser.ts:50-63\`、\`parser.ts:85-93\`。
- 白名单校验在入状态机前再做一次 — \`electron/ai/types.ts:27-44\`、\`chat-session-service.ts:21\`、\`chat-session-service.ts:389\`。

#### A6. 人格相关的两个"漂移点"（潜在 bug）

- \`PersonaSettings.vue:17-21\` 的 \`PRESET_PERSONA\` **与后端 \`DEFAULT_PERSONA\` 不一致**：展示副本仍是旧版（含"称呼主人为「主人」…活泼软萌"），而后端已改成"「主人」是带权限含义的称号，不是默认昵称"（\`promptBuilder.ts:47-49\`）。设置页"当前默认人格"卡片展示的是**过时文案**（\`PersonaSettings.vue:111-121\`）。
- 兜底回复库的动作名与动画状态机词汇表不一致（\`tilt_head\` / \`turn_away\` / \`proud_pose\` / \`check_watch\` / \`introduce\` / \`show_off\` / \`point\` / \`sleep\`，见 \`fallbackResponses.ts:27-87\`），而合法状态名是 \`head_tilt\` 等（\`src/pet/avatar/types.ts:10-40\`）。这些 \`action\` 字段在前端**完全没有消费者**（\`src/**\` grep \`mood\`、\`.action\` 零命中），实际只有 \`emotion\` 生效（\`fallbackService.ts:71\`）。

---

### B. 记忆

#### B1. 表结构（SQLite，\`~/.kirari/database/pet_sessions.db\`）

| 表 | 用途 | 关键列 | 证据 |
| --- | --- | --- | --- |
| \`memories\` | 长期记忆 | \`subject / kind / content / visibility / about_person / source / epistemic / claimed_by / importance / hits / last_hit_at / deleted\` | \`storage.ts:221-243\` |
| \`people\` | 每个人一份档案（\`role\` 只表权限） | \`person_key / role / display_name / last_seen_at\` | \`storage.ts:253-262\` |
| \`memory_links\` | 联想网络（人—人、记忆—人） | \`a / b / relation / weight\` | \`storage.ts:268-278\` |
| \`daily_memory\` | 每日简报缓存 | \`userid / date / brief_text / topics_json\` | \`storage.ts:204-213\` |
| \`social_groups / social_contacts / social_group_members / social_events\` | 协议端社交事实快照 | — | \`storage.ts:286-336\` |

#### B2. 记什么：四个正交轴

- **归属轴 \`subject\`**：\`person::{key}\` / \`self::{uid}\` / \`scene::{scope}\` / \`global\` — \`memory.ts:24-39\`
- **内容轴 \`aboutPerson\`**：这条说的是谁（A 转述 B，池在 A、内容关于 B）— \`memory.ts:13-14\`、\`memory.ts:922-928\`
- **可见性轴 \`visibility\`**：\`public / private / secret\`（命中敏感词强制升 secret）— \`memory.ts:930-937\`、\`memory.ts:869-872\`
- **可信度轴 \`epistemic\`**：\`fact / observed / hearsay / rumor\` — \`memory.ts:443-452\`，判定 \`memory.ts:471-518\`

写入时有一条硬规则：**归人不归己**（\`self::\` 是共享池，identity 不明的写入直接拒绝）— \`memory.ts:51-92\`、\`memory.ts:911-920\`。

#### B3. 什么时候判定要记（memoryJudge 的触发条件）

关键事实：**\`remember()\` 只有一个调用点——模型主动调 \`memory\` 工具**（\`electron/ai/capabilities/builtin/memory.ts:87\`）。全仓再无自动抽取/自动记忆的调用（\`memory.remember(\` 只有能力层与测试）。

因此"要不要记"实际上是三件事叠在一起：

1. **模型自己判断**：靠 system 里那段"值得记 / 不值得记"的指引（\`conversationService.ts:497-505\`）和工具描述（\`builtin/memory.ts:32-34\`）。没有程序侧的兜底提取。
2. **启发式可信度**：\`epistemicFor\` 按"这条关于谁 + 是否负面私事 + 说话人身份"三档判定，负面词表很宽（\`memory.ts:500-517\`）。
3. **大模型复核（仅"拿不准/风险高"时）**：\`shouldConsult\` 的触发条件为四条之一——命中负面词 / 有 \`aboutPerson\` / 启发式已判 hearsay|rumor / 出现第三人称指代且长度 ≥8 — \`memoryJudge.ts:47-64\`。复核只允许**往低可信度方向修**，想把第三方信息升成 \`fact\` 必须过二次确认 \`confirmFact\` — \`memoryJudge.ts:294-323\`、\`memoryJudge.ts:209-237\`。任何异常静默退化启发式（\`memoryJudge.ts:180-184\`）。

#### B4. 怎么检索

\`buildMemoryBlock\`（\`memory.ts:625-858\`）一次检索走四条来源：

1. 本池 \`listMemories(subjects, limit 200)\` — \`memory.ts:634\`
2. **关于"此刻这个人"**的跨池记忆 \`listMemoriesAbout(cp, 60)\`（群里不浮现）— \`memory.ts:641-653\`
3. **关系网一跳**（\`expandLinks depth 1, minWeight 3\`，只要 \`knows\`）— \`memory.ts:656-672\`
4. **对方明确问起了某人**（\`findAskedPersons\`），两处都查（他自己的池 + 别人转述他的行）— \`memory.ts:681-709\`

准入闸门：本池行走 \`isMemoryVisible\`；跨池行允许进入但 \`secret\` 一律拦、群聊一律拦 — \`memory.ts:726-734\`。

打分：\`tokenize\`（中文按 2-gram 切）→ \`overlap*10 + (同池 8 / global 2) + max(0,6-2×池序) + importance*2 + min(4, hits/3)\`，取前 12 条 — \`memory.ts:239-266\`、\`memory.ts:737-747\`。

披露分级 \`disclosureFor\` 给出 \`OPEN / DEIDENTIFY / VAGUE / SEALED\` 四档，**VAGUE 直接把原文压成话题方向（\`vagueGist\`）才注入**，SEALED 连注入都不给 — \`memory.ts:546-603\`、\`memory.ts:758-828\`、\`memory.ts:337-364\`。可信度再叠一层措辞提示（"听说/好像是"）— \`memory.ts:524-537\`。

#### B5. 有没有衰减 / 遗忘 / 冲突处理？

| 机制 | 现状 | 证据 |
| --- | --- | --- |
| 时间衰减 | **没有**。打分函数里不出现 \`createdAt\` / \`lastHitAt\`，只有 \`hits\` 计数 | \`memory.ts:254-266\` |
| 遗忘曲线 | **没有**。\`forget()\` 是显式删除（按 id 或关键词子串，软删除 \`deleted=1\`） | \`memory.ts:1020-1043\`、\`storage.ts:903-908\` |
| 容量淘汰 | **没有**。表只增不删；\`listMemories\` 按 \`importance DESC, id DESC\` 取前 N | \`storage.ts:854-868\` |
| 冲突处理 | **只有去重，没有矛盾消解**。同池内容完全相同（或去标点后相同）算重复；\`importance\` 更高时只更新重要度，**内容不更新** | \`memory.ts:939-955\`、\`storage.ts:876-901\` |
| 重要度自增 | 有 \`hits+1 / last_hit_at\`，但只换到最多 4 分加成 | \`storage.ts:917-926\`、\`memory.ts:264\` |
| 记忆"淡出到常识" | 没有。也没有把短期事件沉淀成长期人设的路径 | 全仓无对应实现 |

#### B6. 记忆侧的两个真实缺口

- \`memory\` 能力是 \`mutating\` 工具（\`builtin/memory.ts:61\`），写不写**取决于模型当轮是否调用**，用户不能要求"自动记"；模型不调就永远不记。
- \`recall\` 动作是**纯子串包含**过滤，不是向量/语义检索（\`builtin/memory.ts:103-116\`），而注入路径用的是 2-gram 词面重叠（\`memory.ts:239-248\`）——两套检索口径不一致，同一个问题用工具查和用注入拿到的结果会不同。

---

### C. 主动性 / 情绪 / 动画

#### C1. 动画状态机：22 个状态 + 5 级优先级

- 状态全集：\`AvatarState\`（22 个）— \`src/pet/avatar/types.ts:10-40\`
- 优先级表（数值越大越硬）：\`drag/drag_start 200 > speak 100 > 情绪 60 > 交互 50 > thinking 40 > shy 30 > 睡眠 20 > blink 10 > idle 0\` — \`src/components/pet/PetStage.vue:64-90\`
- 一次性动作播完自动回 \`idle\`（睡眠链例外：\`sleep_start→sleepy\`、\`sleep_end→idle\`）— \`PetStage.vue:138-169\`
- 时长以皮肤 \`frames.json\` 为准，未回填前用兜底表 — \`PetStage.vue:95-117\`、\`src/stores/avatar.ts:74\`、\`SpriteRenderer.ts:391-406\`
- 渲染侧只播帧，不做状态流转；切换用交叉溶解（\`smoothstep\` + \`lighter\` 混合避免半透明）— \`SpriteRenderer.ts:29-58\`、\`SpriteRenderer.ts:480-552\`

#### C2. 情绪由什么驱动？—— 五个来源，全部是"一次性动作"

| 来源 | 触发 | 证据 |
| --- | --- | --- |
| ① LLM 输出的 \`emotion\` 字段 | 新 pet 消息带 emotion → 先播该动作，播完接 \`speak\` | \`PetStage.vue:215-236\`、\`PetStage.vue:196-213\` |
| ② 随机闲置计时器 | wave 40-90s、attention 55-125s、stretch 2-4min、blink 3-8s、睡觉 3-5min | \`PetStage.vue:296-302\`、\`319-332\`、\`452-459\`、\`407-420\` |
| ③ 鼠标交互 | 连点 3 次=happy、连点 5 次=angry、抚摸累计位移>140=shy、悬浮 1s=wave、窗口聚焦=wave | \`PetStage.vue:270-284\`、\`722-737\`、\`740-748\`、\`547-550\` |
| ④ 连接/报错状态 | 连接成功=excited、断开=sad、单次报错=shake、8s 内连报=angry、未读数增加=surprised | \`PetStage.vue:464-496\` |
| ⑤ 等待回复 | \`waitingForReply\` 为真时循环重播 thinking | \`PetStage.vue:345-369\`、\`502-516\` |

**关键结构性事实：没有任何"情绪状态/心情"变量。** \`avatarStore\` 只有 \`currentState: AvatarState\`（\`src/stores/avatar.ts:69\`），前端 grep \`mood\` 零命中，全仓 grep \`affinity/好感/亲密度\` 零命中。情绪在播完的那一刻就回到 \`idle\`（\`PetStage.vue:164\`），**不累积、不残留、不影响下一句话**。

后端侧的 \`action\` 与 \`mood\` 字段全部是**同一对常量**：\`action: "idle"\` / \`mood: "curious"\`，共 17 处（如 \`conversationService.ts:257-258, 289-290, 334-335, 659-660, 745-746, 769-770\`），且前端无消费者（\`ReplyResult\` 定义见 \`conversationService.ts:102-114\`）。真正驱动动画的只有 \`emotion\`。

#### C3. idle 时她做什么？

- \`idle\` 是循环态，只有眨眼、招手、举手、伸懒腰、歪头…**没有任何"说话"**。
- 3-5 分钟无交互后进入睡眠链（\`sleep_start → sleepy\`），有交互则 \`wakeUp()\` 播 \`sleep_end\` — \`PetStage.vue:399-448\`
- 气泡文字只有两种来源：聊天消息（\`bubbleMessage\`）与**拖拽时的两句硬编码**（\`"跟着你移动中。"\` \`"这里看起来不错。"\`）— \`PetStage.vue:609\`、\`PetStage.vue:688\`

#### C4. 有没有"注意到你在用什么软件"这类环境感知？

**没有。** 桌面侧采集只有一处：主进程每 20ms 轮询光标位置并广播 \`desktop-pet:cursor\`，用途是逐像素点穿与悬浮判定（\`PetStage.vue:560-562\`、\`775-841\`；主进程侧 \`main.ts:2335-2388\`）。没有前台窗口标题、没有进程名、没有键鼠活跃度、没有系统电源/锁屏事件（全仓 grep 无命中）。

她对"环境"的认知全部来自 **QQ 协议端**：群列表、好友列表、群成员、notice 事件（\`social.ts:167-208\`、\`storage.ts:286-336\`）。桌宠本机窗口里的对话，\`scene\` 固定是 \`chatType:"local", isOwner:true\`（\`ownerIdentity.ts:139-151\`）—— 她**不知道**自己在桌面上跟谁说话、更不知道主人此刻在干嘛。

#### C5. 皮肤台词库是死代码

\`dialogueManager\` 定义了 20 类场景台词（greeting / drag / idle / lateNight / longChat / apiError / reconnect / shy / sad / …）— \`src/pet/personality/dialogueManager.ts:5-28\`。但：

- 只有 \`loadPersonality()\` 被调用（\`SpriteRenderer.ts:169-170\`）；
- \`getDialogue()\` 在全仓**没有任何调用点**（\`src\` 内 grep 只有定义处 \`dialogueManager.ts:39\`）。

结果：所有皮肤自带的台词（包括"深夜了…""还不睡吗？"）**一句都不会被说出来**。拖拽台词是 \`PetStage\` 里另外硬编码的两句（\`PetStage.vue:609, 688\`），不走 \`dialogueManager\`。

---

### D. 语音与表达

#### D1. 音色库（只负责"下载与管理"）

- 清单 2 个：AISHELL3（174 音色，31MB）、花燕（单女声，67MB）— \`electron/voice/voiceLibrary.ts:21-46\`
- 下载：多源回退 → 校验 \`BZh\` 魔数 → \`bsdtar\` 解压 → 原子改名 — \`voiceLibrary.ts:159-272\`（魔数校验 \`224\`、解压 \`240-248\`、原子落地 \`259-263\`）
- 设置页只做列表/下载/删除/打开目录 — \`src/components/settings/VoiceSettings.vue:77-116\`
- 页面按扩展包贡献点 \`speech.tts\` 显隐，未装语音扩展包则整页不出现 — \`src/components/settings/sections.ts:110\`

#### D2. 桌面端有没有"说话的声音"？

**没有。** 全渲染层 grep \`new Audio / AudioContext / speechSynthesis / .mp3 / .wav\` **零命中**。桌宠只有动画气泡，**不出声**。

TTS 的唯一消费方是**协议端回发**：

- \`adapter-manager.ts:336-352\` 在 QQ 回包时调 \`buildVoiceOutgoing\`，拿到音频才塞进 \`sendMessage({text, images, audio})\`
- 策略：默认开、**仅私聊**、时长上限 15s、合成超时 8s，超时/失败一律退回纯文本 — \`electron/extensions/voiceOutgoing.ts:38-43\`、\`voiceOutgoing.ts:55-89\`
- 契约里 \`TtsRequest\` **有 \`emotion\` 字段**（\`electron/extensions/contracts/tts.ts:40-49\`），但调用时**没有传**（\`voiceOutgoing.ts:71-78\` 只传 text/voiceId/format）。所以即使引擎支持情绪化 TTS，现在也永远拿不到情绪。

#### D3. 表达侧的"声音人格"

- 音色可换（AISHELL3 174 个），但**语速/音高/情绪/停顿全不可调**（\`voiceOutgoing.ts:23-36\` 的 policy 里没有这些字段）。
- 语音只在 QQ 里出现，桌宠本机对话 0 语音。这意味着：**桌面陪伴场景里她的"嘴"只有文字气泡**。

#### D4. 社交能力（她对人际环境的认知）

- 服务层：全量同步群/好友/成员、记录 notice 事件、产出自然语言环境摘要 — \`electron/ai/services/social.ts:56-121\`、\`social.ts:167-208\`
- 工具层 8 个 action：\`overview / groups / friends / members / events / who / group / refresh\` — \`electron/ai/capabilities/builtin/social.ts:24-59\`
- 环境摘要在 \`scene.platform\` 存在时注入 system（\`conversationService.ts:445-448\`）；本机桌宠对话 \`scene.platform = "desktop"\`（\`ownerIdentity.ts:149\`），此时 \`adapterId\` 传 \`"desktop"\` 去查库 → 查不到任何 groups/contacts → \`buildEnvironmentBlock\` 返回空串（\`social.ts:170\`）。**桌面端这功能实际不生效**，只有 QQ 侧会话才有内容。

---

## 2. 情绪与动画的真实驱动链路（文字版调用链）

### 2.1 主链：LLM → 动画（唯一"由内容决定表情"的路径）

\`\`\`
用户发消息
  └─ chat-session-service.sendMessage()                       [chat-session-service.ts:311]
      └─ engine.chat()                                        [engine.ts:195]
          └─ conversationService.getReply()                    [conversationService.ts:165]
              ├─ preflightTools() 意图预检（时间/天气/搜索/位置） [intent.ts:179]
              ├─ 拼 system（人格+时间+场合+CHARTER+记忆+…）      [conversationService.ts:199-513]
              ├─ streamChatCompletion（工具循环 AgentRunner）     [conversationService.ts:596-630]
              └─ parseModelReply() → {speech, emotion, images}   [parser.ts:126-145]
                  └─ emotion 过白名单 EMOTION_WHITELIST          [types.ts:27-44]
      ├─ acceptEmotion(result.emotion)                          [chat-session-service.ts:389]
      ├─ state.messages.push({author:"pet", text, emotion})     [chat-session-service.ts:393-395]
      ├─ db.saveMessage(..., {emotion})  ← 情绪随消息落库        [engine.ts:249-252]
      └─ emit() 广播 chat:state
          └─ useChatSocket → chat store messages 变化           [PetStage.vue:38-47]
              └─ watch(messages.length)                         [PetStage.vue:215-236]
                  ├─ 取新增消息里最后一条 author==="pet"
                  ├─ 有 emotion → playEmotionThenSpeak(emo)     [PetStage.vue:196-213]
                  │    ├─ requestState(emo)  ← 优先级抢占 + 按真实时长排定时器 [145-169]
                  │    └─ 播完 → playSpeak() → armSpeakTail()   [190-194, 182-188]
                  │         └─ 2500ms 后回 idle + maybeHappy(0.12)
                  └─ 无 emotion → 直接 playSpeak()
\`\`\`

**这条链的终点是"一次一次性动画"**：\`requestState\` 挂一个 \`durationOf(s)\` 的定时器，到点把状态改回 \`idle\`（\`PetStage.vue:158-167\`）。情绪不会留在任何地方。

### 2.2 旁链：无 LLM 的本地驱动（全部是定时器/事件）

\`\`\`
onMounted()
  ├─ scheduleBlink()      3-8s 循环        → requestState('blink')      [452-459]
  ├─ scheduleWave()       40-90s 循环      → tryGesture('wave')         [296-302]
  ├─ scheduleAttention()  55-125s 循环     → tryGesture('attention')    [319-325]
  ├─ scheduleStretch()    2-4min 循环      → tryGesture('stretch')      [326-332]
  └─ scheduleSleepy()     3-5min 无交互    → requestState('sleep_start') [407-420]

事件 watcher
  ├─ watch(connected)     连上→excited / 断开→sad                      [464-473]
  ├─ watch(lastError)     单次→shake / 8s 内连报→angry                 [476-487]
  ├─ watch(unreadCount)   增加→surprised                              [490-496]
  ├─ watch(chatWindowOpen) 打开→bow                                   [498-500]
  ├─ watch(waitingForReply) 等回复→循环重播 thinking                   [502-516]
  └─ watch(messages) 新增 user 消息 → 对话框开着=歪头 / 否则=点头       [519-527, 377-381]

指针事件
  ├─ 连点 3 次→happy(必定) / 5 次→angry                               [270-284]
  ├─ 抚摸(累计位移>140)→shy                                          [722-737]
  ├─ 悬浮 1s→wave / 窗口 focus→wave                                   [740-748, 547-550]
  └─ 拖拽 → drag_start → drag 循环；松手回 stateBeforeDrag 或 idle      [605-704]
\`\`\`

### 2.3 渲染链（状态 → 像素）

\`\`\`
avatarStore.setState(s)                     [avatar.ts:194-196]
  └─ avatarStore.currentState 变化
      └─ PetAvatar → SpriteRenderer.setState(s)   [SpriteRenderer.ts 状态切换 + 交叉溶解]
          ├─ FADE_MS[s] 决定溶解时长（idle 220ms / drag 0ms …）  [29-58]
          └─ rAF 按 fps 推进帧；循环态按 clips.loop                [448-478]
\`\`\`

### 2.4 链路图上最该注意的三件事

1. **情绪 ≠ 状态**：\`emotion\` 是"这一条消息的装饰动作"，播完即弃（\`PetStage.vue:164\`）。同一句话的 emotion 与下一句话的 emotion 之间**没有任何连续性**——上一轮刚 "sad"，下一轮仍可能立刻 "excited"，没有过渡、没有理由、没有记忆。
2. **两条驱动链不共用一个"心情"**：LLM 链与本地随机链互相不知道对方存在，只能靠 \`PRIORITY\` 表抢同一个状态位（\`PetStage.vue:64-90\`）。所以会出现"刚好在伸懒腰 → 模型下发 shy 被冷却挡掉"这种丢表情的情况（\`tryGesture\` 的 cooldown，\`PetStage.vue:242-257\`）。
3. **历史重放不播情绪**：emotion 已落库（\`engine.ts:249-252\`），但 \`PetStage\` 首帧用 \`primed\` 直接跳过整批历史（\`PetStage.vue:176\`、\`219-222\`）。启动后她永远只有一句常量问候 \`今天也一起加油吧。\`（\`chat-session-service.ts:110, 183\`），看不出"上次聊到哪、心情如何"。

---

## 3. 主动说话的现有触发点（全部清单）

| # | 触发 | 内容从哪来 | 是否走 LLM | 证据 |
| --- | --- | --- | --- | --- |
| 1 | **定时提醒到点**（\`scheduled_jobs.kind=reminder\`） | \`job.payload\`（建任务时写死的文本） | 否，直接注入 | \`scheduledJobsService.ts:194-197\`、\`140-182\`；注入 \`chat-session-service.ts:297-304\`；接线 \`main.ts:2973-2984\` |
| 2 | **工作空间定期任务产出**（\`kind=workspace_task\`） | runner 跑出来的 \`speech\` | 是（\`engineChat\`） | \`scheduledJobsService.ts:202-207\`；runner \`main.ts:3015-3047\`；推送 \`main.ts:3048-3057\` |
| 3 | **每日简报**（\`kind=daily_brief\`，8/16/22 三档） | 天气 + 新闻 → LLM 压缩成 3-5 条 | 是 | \`briefSchedule.ts:16\`、\`52-96\`、\`103-128\`；生成 \`dailyBriefingService.ts:35-105\` |
| 4 | 连接状态变化 / 报错 / 未读增加 | 无文本，只有动画 | — | \`PetStage.vue:464-496\` |
| 5 | 拖拽（两句硬编码台词进气泡） | 常量 | 否 | \`PetStage.vue:609\`、\`688\` |
| 6 | 窗口重新获得焦点 | 只有 \`wave\` 动画 | — | \`PetStage.vue:547-550\` |
| 7 | 启动 / 每次打开 | 常量 \`今天也一起加油吧。\` | 否 | \`chat-session-service.ts:110, 182-183, 657-658, 671\` |

### 3.1 关于 #3 的一个重要事实：简报**不会主动说出口**

\`daily_brief\` 任务只是把简报**写进 \`daily_memory\` 表**（\`dailyBriefingService.ts:101\`、\`storage.ts:745-748\`），到点**没有任何注入桌面聊天/气泡的路径**。它唯一的用途是下一次用户发消息时作为 \`【今日背景】\` 塞进 system（\`conversationService.ts:347-355\`）。

也就是说：8 点、16 点、22 点各跑一次采集，用户如果一直不开口，**她一个字都不会说**。

### 3.2 触发点的形态总结

- **"定时"有，"情境"没有**：7 个触发点里 3 个是 cron 类（到点就发，与你在不在、在干什么无关），4 个是无文本的动画或硬编码常量。
- **"因为你做了什么"没有**：没有"你连续工作 90 分钟了"、"你刚关掉那个窗口"、"你回来了，上次那个 bug 修好了吗"这类**基于观察**的开口。
- **"因为她是她"没有**：没有"她今天心情不错所以先开口"、"她想跟你说昨天那件事的后续"这类**内在动机**驱动的开口。

---

## 4. 拟人度缺口（按影响排序）

> 排序依据：**对"像不像一个真人住在电脑里"的破坏程度 × 被感知的频率**。第一条不是"少一个功能"，而是"她连最基本的人格特征都不成立"。

### 缺口 1 ★★★★★ 没有持久情绪/心情：她只有"表情包"，没有"情绪"

**现状证据**
- 情绪以 \`emotion\` 字符串随单条消息传递（\`parser.ts:126-145\` → \`chat-session-service.ts:389-395\`），前端只用来播一次动作（\`PetStage.vue:196-213\`），播完立即 \`setState('idle')\`（\`PetStage.vue:158-167\`）。
- 全局没有任何情绪状态变量：\`avatarStore\` 只有 \`currentState\`（\`avatar.ts:69\`），前端 grep \`mood\` 零命中，全仓 grep \`affinity/好感/亲密度\` 零命中。
- 后端 \`mood\` 字段是常量 \`"curious"\`（17 处，如 \`conversationService.ts:257-258\`），且**前端不消费**（\`src\` grep \`.action\`/\`mood\` 零命中）。

**为什么这让她不像真人**
真人的情绪是一条有惯性的曲线：被夸奖后接下来半小时都轻快，被凶了会低落一阵、说话变短，累的时候连回话都懒。她现在的情况是"每一句话配一个 emoji"——上一秒 \`sad\` 下一秒 \`excited\` 没有任何过渡成本。用户感知到的不是"她有情绪"，而是"她的脸会跟着字变"。**这是拟人度最大的单点缺口**，因为它同时抽掉了"情绪影响表达"和"情绪影响主动性"两个下游能力的地基。

---

### 缺口 2 ★★★★★ 主动开口只有"闹钟"，没有"观察"和"动机"

**现状证据**
- 全部 7 个触发点见 §3：3 个是 cron（\`briefSchedule.ts:16\`、\`scheduledJobsService.ts:194-207\`），4 个是无文本动画或常量字符串（\`PetStage.vue:609, 688\`、\`chat-session-service.ts:110\`）。
- 每日简报**生成后不推送**，只存库等下次对话注入（\`dailyBriefingService.ts:101\` vs \`conversationService.ts:347-355\`）——一天三次白跑。
- 无任何"用户空闲 N 分钟"「离开后回来」"连续使用过久"的判定（全仓 grep \`idleChatter/沉默/无操作/lastActive\` 在业务层零命中；\`PetStage\` 的定时器只驱动动画，不产出文本，\`PetStage.vue:296-332\`）。
- 她会说话只有一条路：\`injectProactiveMessage(text)\`（\`chat-session-service.ts:297-304\`），且**只被定时任务调用**（\`main.ts:2979, 3052\`）。

**为什么这让她不像真人**
"住在你电脑里的人"最像人的时刻，是**她不问你也会开口**：你三点还没吃、你连开六个小时会、你刚关掉游戏、你回来时她抬头说一句"你回来了"。现在的她只有"闹钟人格"——所有主动都是事先被人写好的到点通知（而且文本往往是用户自己写的 payload）。这在体验上不是"她主动找我"，而是"我的提醒事项弹出来了，套了个角色的壳"。

---

### 缺口 3 ★★★★☆ 桌面环境全盲：她不知道你在用什么、在忙什么

**现状证据**
- 桌面侧采集仅光标坐标，用于点穿与悬浮（\`PetStage.vue:560-562\`、\`775-841\`；\`main.ts:2335-2388\`）。全仓 grep \`active-win / getWindowTitle / foreground / idleTime / powerMonitor\` **零命中**。
- 她对"环境"的认知全部来自 QQ 协议端（\`social.ts:167-208\`），而桌面端会话的 \`scene.platform="desktop"\`（\`ownerIdentity.ts:149\`）导致该摘要查不到数据、返回空串（\`social.ts:170\`）——**桌宠窗口里这功能实际不生效**。
- 桌宠本体会话的 \`scene\` 恒为 \`local + isOwner\`（\`ownerIdentity.ts:139-151\`、\`chat-session-service.ts:380\`），她没有"主人在桌面干什么"的任何输入。

**为什么这让她不像真人**
真实陪伴的核心是**共同注意**：她能看到你在写代码/看视频/玩游戏，才能说出"这段你改了三遍了吧""先歇会儿"。现在她的世界只有"输入框里的字"——你不打字，她对你的状态一无所知。这也直接导致缺口 2 无解：**没有观察就没有主动的素材**。

---

### 缺口 4 ★★★★☆ 记忆只有"存/取"，没有"淡忘、升温、矛盾消解"

**现状证据**
- 打分不含时间：\`overlap*10 + 池序 + importance*2 + min(4, hits/3)\`，不读 \`createdAt\`/\`lastHitAt\`（\`memory.ts:254-266\`）。
- 无容量淘汰、无衰减、无遗忘曲线；\`forget\` 是显式删除（\`memory.ts:1020-1043\`），表只增不删（\`storage.ts:854-868\` 只按 \`importance DESC, id DESC\` 取前 N）。
- 冲突只有**完全相同内容去重**，且重复时仅更新 \`importance\`，**内容不覆盖**（\`memory.ts:939-955\`、\`storage.ts:876-901\`）——"我不吃辣"与"我今天想吃麻辣烫"会并列共存，没有"最新偏好覆盖旧偏好"。
- 写入时机完全依赖模型自发调工具（\`builtin/memory.ts:87\`），无自动抽取。

**为什么这让她不像真人**
真人记忆是有温度的：琐事会淡、重要的事会越想越清楚、矛盾的信息会被新事实修正。她现在是"一个只写不删的日志库"——三个月前随口一句和昨天的重要约定同权（都只差 \`importance\` 的几分），记错了不会自动改，提起来时也没有"这事我们上次说过"的自然感。**"记得住"只是记忆的及格线，"记得有轻重"才是像人。**

---

### 缺口 5 ★★★☆☆ 皮肤台词库是死代码：所有"她想说但你不在对话里"的话都无处可去

**现状证据**
- 20 类场景台词定义完整（含 \`idle / lateNight / longChat / reconnect / shy / stretch\`），\`dialogueManager.ts:5-28\`。
- \`getDialogue()\` **全仓无调用点**（\`dialogueManager.ts:39\` 只有定义；\`src\` grep 仅命中该文件自身）。
- 唯一被调的是 \`loadPersonality()\`（\`SpriteRenderer.ts:169-170\`）。
- 拖拽台词改成了 \`PetStage\` 里的硬编码（\`PetStage.vue:609, 688\`），与皮肤无关。

**为什么这让她不像真人**
这些台词正是"拟人"最省力的抓手——"深夜了…""还不睡吗？""你回来啦"。作者已经写好了，**但没有一条接上了执行路径**。而且"一个动作配一句台词"本身是真人式的（伸懒腰时有声、害羞时会嘟囔），现在所有动画都是**静音**的。

---

### 缺口 6 ★★★☆☆ 桌面端完全没有声音

**现状证据**
- 渲染层 grep \`new Audio / AudioContext / speechSynthesis\` **零命中**；气泡是唯一的表达通道（\`PetBubble.vue:20-35\`）。
- TTS 仅用于 QQ 回包（\`adapter-manager.ts:336-352\`、\`voiceOutgoing.ts:55-89\`），且**仅私聊**（\`voiceOutgoing.ts:63\`）。
- 契约支持 \`emotion\`（\`contracts/tts.ts:40-49\`），但调用时**没传**（\`voiceOutgoing.ts:71-78\`）；policy 里没有语速/音高/停顿（\`voiceOutgoing.ts:23-36\`）。

**为什么这让她不像真人**
陪伴场景里"声音"是拟人的一半。她现在是一张**会动但不出声的图**——你听到的永远只有自己的键盘声。同一句话说出口和打成字，亲密度差一个量级。这也是主动开口能不能"不打扰"的关键（文字会强占视线，语音可以只占耳朵）。

---

### 缺口 7 ★★☆☆☆ 提示词分层有声明与实现的错位，人格一致性的保障是"文本约束"而非"结构约束"

**现状证据**
- CHARTER 自称"永远追加、后写者优先"（\`charter.ts:8-9\`），实为中间段（\`conversationService.ts:439\`），其后还有社交环境（448）、工作空间（470）、记忆（491）、记忆指引（497-505）、技能（508-513）、\`daily_brief/knowledge/skills\` 三段（\`566-570\`）。
- 设置页展示的预设人格是**过时文案**（\`PersonaSettings.vue:17-21\`），与后端 \`DEFAULT_PERSONA\`（\`promptBuilder.ts:37-52\`）不一致；用户看到的"当前默认人格"不是她真正在用的人格（\`PersonaSettings.vue:111-121\`）。
- 同时注入了两处"记忆使用指引"（system 里 \`conversationService.ts:497-505\` 与工具描述 \`builtin/memory.ts:32-34\`），措辞与范围不完全一致。

**为什么这让她不像真人**
这一条对"用户体验"的直接影响小于前六条，但它是**其他所有调整的地基**：人格/元指令/记忆/技能的相对权重现在由"拼接顺序"隐式决定，改一处顺序就可能改变她的底线行为。而且"人格是否一致"目前完全靠模型读长文本自律，没有结构化保障（例如没有"每轮必须复述当前心情与关系温度"这类短路检查）。

---

### 缺口 8 ★★☆☆☆ 情绪/动作词汇与真实交互不同步

**现状证据**
- 兜底库的 \`action\` 用的是 \`tilt_head / turn_away / proud_pose / check_watch / introduce / show_off / point / sleep\`（\`fallbackResponses.ts:27-87\`），与 \`AvatarState\` 的 \`head_tilt / nod / wave …\`（\`types.ts:10-40\`）不是同一套词；且 \`action\` 全无消费者。
- 后端 \`action/mood\` 恒为 \`idle/curious\`（17 处），属于历史遗留字段（\`conversationService.ts:102-114\` 定义、\`engine.ts:268-269\` 唯一赋值来源）。

**为什么这让她不像真人**
影响偏工程侧：一旦要接"情绪→表情→动作→语音"的完整表达链，会先撞上两套不兼容的词汇表；但对当前观感影响较小（因为 \`action\` 根本没被渲染）。

---

## 5. 一句话结论（给后续改造用）

她的"人格与记忆"已经是一个**够用的内向系统**（分层提示、四轴记忆、披露分级、可信度复核都是高质量工程），但她的"表达与主动性"还停在**一次性动画 + 闹钟通知**的水平。

三条最短路径（按 ROI 排序）：

1. **先给情绪加上"状态"**：把 \`emotion\` 从"消息装饰"改成带半衰期的持久心情（\`PetStage\` 写入 + 注入 system），下游的"语气变化/主动关心"才有依据。落点：\`PetStage.vue:196-236\`、\`conversationService.ts:399-417\`。
2. **把 §3 的 7 个触发点从"cron"扩成"情境"**，最小可用集合 = 用户空闲超过阈值 + 每日简报生成后主动说一句（现在白白浪费，\`dailyBriefingService.ts:101\`）。落点：\`chat-session-service.ts:297-304\`、\`main.ts:2991-3005\`。
3. **接上已有的桌面台词库与语音**：\`dialogueManager.getDialogue()\` 零调用点（\`dialogueManager.ts:39\`）是最低成本的一块"活人感"，桌面端 TTS 缺失是最明显的一块短板。

---

## 附录：本次审读覆盖的文件（均为只读）

\`\`\`
A 链路
  README.md, package.json
  electron/ai/reply/promptBuilder.ts        (212 行)
  electron/ai/reply/charter.ts              (34)
  electron/ai/reply/intent.ts               (391)
  electron/ai/reply/sceneContext.ts         (128)
  electron/ai/reply/timeContext.ts          (90)
  electron/ai/reply/deviceBlock.ts          (68)
  electron/ai/reply/workspaceBlock.ts       (103)
  electron/ai/reply/parser.ts               (145)
  electron/ai/reply/fallbackResponses.ts    (89)
  electron/ai/services/fallbackService.ts   (73)
  electron/ai/services/conversationService.ts (908, 重点段 96-780)
  electron/ai/services/ownerIdentity.ts     (189)
  electron/ai/engine.ts                     (287, 重点段 240-285)
  src/components/settings/PersonaSettings.vue (123)
  electron/agent-profile.spec.ts            (60)

B 链路
  electron/ai/services/memory.ts            (1121)
  electron/ai/memoryJudge.ts                (332)
  electron/ai/capabilities/builtin/memory.ts (148)
  electron/ai/db/storage.ts                 (1610, 重点段 175-350 / 745-950)

C 链路
  electron/ai/services/dailyBriefingService.ts (118)
  electron/ai/services/briefSchedule.ts        (128)
  electron/ai/services/scheduledJobsService.ts (274)
  electron/chat-session-service.ts             (752, 重点段 30-90 / 270-410)
  electron/main.ts                             (3133, 重点段 2960-3080)
  src/pet/personality/dialogueManager.ts       (89)
  src/components/pet/PetStage.vue              (874)
  src/components/pet/PetBubble.vue             (50)
  src/components/pet/PetQuickMenu.vue          (236)
  src/pet/avatar/SpriteRenderer.ts             (553)
  src/pet/avatar/types.ts                      (176)
  src/stores/pet.ts                            (24)
  src/stores/avatar.ts                         (270)
  src/stores/chat.ts                           (116)

D 链路
  electron/voice/voiceLibrary.ts               (294)
  src/components/settings/VoiceSettings.vue    (196)
  src/components/settings/sections.ts          (110 行附近)
  electron/extensions/voiceOutgoing.ts         (89)
  electron/extensions/contracts/tts.ts         (63)
  electron/adapter/adapter-manager.ts          (419, 重点段 330-360)
  electron/ai/services/social.ts               (287)
  electron/ai/capabilities/builtin/social.ts   (259)
\`\`\`

**本次审读声明**：只读取与分析，未修改任何源码文件，未执行 \`npm run build\` / \`npm test\` / \`npm run typecheck\`。唯一写入的文件是本报告。
