# 让绮莉更像真人 —— 改造方案 v1

> 参照对象：[surfcore](https://github.com/Mieksido/surfcore)（QQ 机器人 / AI 陪伴项目，机制成熟、迭代了半年多）
> 本文只谈一件事：**怎么把她从「你说话她才动」变成「她自己在过日子，顺便跟你过日子」**。
> 现状证据见 [research/kirari-baseline.md](research/kirari-baseline.md)（每条带 `文件:行号`），
> surfcore 机制拆解见 [research/surfcore-realism.md](research/surfcore-realism.md)。

---

## 0. 三句话结论

1. **她缺的不是"更多表情"，是"心里有事"。** 现在 `emotion` 是单条消息的装饰，播完即回 `idle`（`PetStage.vue:158-167`）——她有脸，但没有心情。
2. **surfcore 真正值钱的只有一件事：目的机制。** 它把「注意到什么 → 想要什么 → 这个念头有多可信 → 该不该现在说 → 说完之后对方怎么看」拆成可解释、可单测的规则，最后才交给模型写成一句人话。**主动性不是随机开口，是有动机、有闸门、会学习。**
3. **桌面宠物比 QQ 机器人更适合这套东西**（你就在她旁边、她能看见你在干什么），但**打扰成本高一个量级**——所以移植时必须加"专注模式/安静时段/每日上限"这一层，surfcore 也是踩过坑才加上去的。

---

## 1. 诊断：她现在为什么不像真人

对照 baseline 的八个缺口，归成三个层次 —— 缺的是**地基**，不是装修：

| 层 | 现状 | 后果 |
| --- | --- | --- |
| **内在状态** | 无。`avatarStore` 只有 `currentState`（`avatar.ts:69`）；后端 `mood` 恒为常量 `curious`（`conversationService.ts:257`） | 上一秒 sad、下一秒 excited 零成本；同一句问候在凌晨和早上一个味道 |
| **动机** | 无。7 个主动触发点里 3 个是 cron、4 个是无文本动画或硬编码常量（baseline §3） | 所有"主动"都是用户自己写好的到点提醒套了个角色壳 |
| **观察** | 无。桌面侧只采光标坐标（`main.ts:2335-2388`） | 没有观察 → 动机没有素材 → 上面两层都补不上 |

再叠一个**表达层**的浪费：20 类场景台词库写好了但 `getDialogue()` **零调用点**（`dialogueManager.ts:39`）；每日简报 8/16/22 各跑一次采集，生成后**只写库不推送**（`dailyBriefingService.ts:101`），你不开口她就一个字不说。

---

## 2. surfcore 凭什么像真人（只抄这四件）

### 2.1 内在状态：9 维驱动 + 衰减 + 情绪评价

`src/purpose-engine.js` 维护一个 `drives` 向量（玩/装/学/陪/关心/分享/自我/创作/体验），
随时间向默认值**指数衰减（半衰期 8 小时）**；「多久没和主人说话」会实时把"陪"推高；真说出口了对应需求 ×0.45。

情绪不是一个分类器，而是四件事的函数：**是否关于我 / 是否关于主人 / 你多久没出现 / 这件事的正负与唤醒度**。
所以 `lonely` 只在「关系内容 + 主人确实 6h+ 没出现」时出现——它的文档里明确写着这是红线：
> 情绪不会被伪造：`lonely` 只在「关系内容 + 主人确实很久没出现」时出现，不是每次主动搭话都硬写「想你了」。

**这一条正是我们最该抄的东西**：情绪必须是状态的函数，不是模型的自由发挥。

### 2.2 目的机制：注意力 → 需求 → 目标假设（带置信度）→ 情绪 → 行动

这是全项目最核心的一层，链路是：

```
素材 → 需求亲和（词表打分）→ 注意力分数（需求·驱动 + 自我相关 + 主人相关 + 情绪 + 未解决 + 重复 + 新鲜 + 时间衰减）
     → 目标假设 { owner, need, topic, confidence, value, urgency, risk, action, status }
     → 选一个（价值×0.4 + 紧迫×0.35 + 置信×0.25 − 风险×0.2 − 刚说过的打折）
     → 拼提示词（给候选方向，允许改写/换/跳过）
     → 模型写成一句人话
     → 回执（sent / silent / failed）→ 记账 → 下一枪
```

三个细节值得逐字抄：

| 机制 | 具体做法 | 为什么重要 |
| --- | --- | --- |
| **归属规则** | 群友聊游戏先记成别人的目标；**同一话题重复 ≥3 次 / 直接点她 / 过去有同类兴趣**才升级成"我也有点想试" | 防止"看了一条视频就变成她的执念" |
| **置信度公式** | `0.15 + 0.22×自我相关 + 0.20×重复度 + 0.10×语气 + 0.10×来源可信度 + 0.08×驱动` | 一条视频约 0.45（只能"问问"），主人直接说的计划 0.78（优先） |
| **风险约束** | 装/买/花钱 risk 0.55~0.85 → **只能 `ask`（问能不能）**，不允许自动执行 | 高风险的事必须留给人拍板 |
| **反馈学习** | 下一轮扫主人的回复：正面 → confirmed/+0.15；负面 → rejected/−0.25 且不再提；两次没回音 → 每 24h −0.08，低于 0.15 自动 expired | 这是"她会记得你不喜欢这个话题"的工程实现 |
| **加权抽签** | 不是取最大分，而是按权重抽签：`0.55 + 置信×0.7 + 价值×0.35 − 风险×0.25`，再乘驱动、需求轮换、去重 | 取最大值＝行为完全可预测（永远挑同一个）。抽签才像"同样几个念头，今天说这个明天说那个" |
| **需求轮换** | 连续两次同一需求 ×0.65；最近三次出现过 ×0.72；同一个 goalId 说过就 ×0.35 | 防人设被聊成单曲循环（连续三天问"你今天累不累"） |
| **排程细节** | 间隔区间随机；停机后**只补一枪**；算出来的点撞安静时段就推到结束后 + 0~20 分钟抖动 | 人不会按整点周期找人，也不能攒一堆补发 |

排程闸门（顺序刻意从"绝对"到"软"）：开关 → 专注模式 → 安静时段 → 每日上限 → 主人是否刚说过话 → 到点没到点 → 有没有素材。
**为什么不用 setTimeout**：桥接重启/系统时钟跳变会让一次性长定时器失效（他们的早安问候因此丢过一次），
所以 `nextFireAt` 落盘，tick 每次重算"现在该不该出发"，重启不补发。

### 2.3 记忆卡：衰减 + 分节注入 + 隐私分池

记忆按「重要度 × 时间衰减」压成一张卡，分小节注入（私聊/群聊/桌宠各有自己的小节，预算紧张时按优先级保留），
并且**钉住项（锚点/初次相遇）不衰减**。这是"记得有轻重"而不是"只写不删"。
（我们的记忆四轴已经很强——归属/内容/可见性/可信度，见 baseline §B2——缺的只有**时间维度**。）

### 2.4 说话节奏：闭嘴也是一项能力

`conversation-closure.js` + `action-planner.js` + `turn-guard.js` 三件套解决"什么时候该停"：
收尾是幂等的（重复 close 直接返回已关闭）、发送失败不许假装成功、开了新话题就不许再收尾。
**真人感的另一半是"不话痨"**——而这恰恰是桌宠最容易翻车的地方（她就住在你屏幕上）。

---

## 3. 移植取舍：QQ 机器人 ≠ 桌面宠物

| 维度 | surfcore（QQ） | 桌宠（我们） | 结论 |
| --- | --- | --- | --- |
| 对话者 | 主人 + 群友 + 陌生人 | 只有本机主人（+`bot-*` 会话） | 素材源只需"你和她之间"，砍掉群聊/社会证明维度 |
| 打扰成本 | 一条 QQ 消息 | **占着屏幕正中间的一张脸** | 闸门必须更严：专注模式 + 每日上限 + 安静时段 默认全开 |
| 表达通道 | 文本 / 语音 | 文本 + **22 个动画状态** + 气泡 +（缺）语音 | 情绪可以直接映射到 `AvatarState`，这是 QQ 机器人没有的优势 |
| 观察能力 | 只能看聊天记录 | **能看到前台窗口、空闲时长、开机多久** | 这是桌宠的杀手锏，也是当前最大空白（baseline 缺口 3） |
| 主动性来源 | 素材（QQ/B站）+ 目的机制 | 素材（对话/记忆/日程/**桌面观察**）+ 目的机制 | 结构一样，素材换一套 |

一条原则：**不做"假装真人"**。CHARTER 已经要求她承认自己是桌宠程序（`charter.ts:19`），这条不改。
拟人度指的是"有连续的内在状态、有动机、会记得、会收敛"，不是"骗你说她是人"。

---

## 4. 改造方案（按 ROI 排序）

### P0-1 · 给情绪加上状态（地基）

**做什么**：新增持久化的 `PresenceState`（驱动向量 / 心情 / 亲密度 / 你说过话的时间 / 目标 / 观察账本），
每轮对话读写；`emotion` 不再"播完即弃"，而是写入状态并带半衰期。

**落点**
- 新模块：`electron/ai/presence/`（已实现，见 §5）
- 注入：`conversationService.ts:399-417` 附近，把 `buildPresenceBlock()` 追加进 system（和 `buildTimeContext` 同一层）
- 写入：`engine.ts:249-252`（消息落库处）旁边调 `recordUserTurn()`
- 表现：`PetStage.vue:196-213` 的 `playEmotionThenSpeak` 之后，情绪结束后**回落到"当前心情对应的 idle 变体"**，而不是无条件 `idle`

**验收**：连续对话 5 轮后，`~/.kirari/presence/<uid>.json` 里 `drives/mood` 有变化；同一句话在"刚被夸"和"刚被凶"两种状态下回复长度/语气不同（人工看 3 组样本）。

### P0-2 · 目的机制：她主动开口（核心）

**做什么**：把 `presence/planOutreach()` 接到现有调度器上，产出"她主动说的一句话"推给气泡（可选 TTS）。

**为什么能直接接**：`scheduledJobsService` 已经有 15 秒扫描 + 落盘的 job + 两条送达腿
（`deliverDesktop` / `deliverPlatform`，`scheduledJobsService.ts:184-257`），**不需要新写定时器**。
新增一个 job kind `presence_tick`（recurrence `daily`，一天一枪，tick 内部自己算 `nextFireAt`），
到点后跑 `planOutreach` → 若 fire 则调模型（一次轻量 completion，不走完整 agent 回合）→ `injectProactiveMessage(text)`（`chat-session-service.ts:297-304` 已有）。

**关键闸门（全部默认开）**
| 闸门 | 默认值 | 说明 |
| --- | --- | --- |
| `focus`（专注模式） | false，但右键菜单/托盘**必须有开关** | 打开后自动搭话全停，手动聊天照常 |
| 安静时段 | 23:30–08:00 | |
| 两枪间隔 | 2.5–5h 区间随机 | 与 surfcore 调过的一致，别自己重调一遍 |
| 每日上限 | 4 次 | |
| 主人刚说过话 | 30min 内不插嘴 | |
| 素材不足 | 不硬找话（输出 SKIP 也算成功） | |

**验收**：一天内主动开口 ≤4 次且都在窗口内；"为什么没开口"能在日志里读到明确理由（`plan.reason`）。

### P1-1 · 桌面观察（素材源）

**做什么**：主进程加一个低频采集器（`powerMonitor.getSystemIdleTime()` + 前台窗口标题/进程名，30s 一次，**只在内存留聚合值**），
产出"你连续写代码 92 分钟 / 你在看视频 / 你离开 25 分钟刚回来"这类**状态**，喂给 `planOutreach` 当素材。

**红线（必须先拍板）**
- 只存**聚合结果**（`code:92min`、`away:25min`），不落前台窗口标题原文；
- 不采集键盘内容、不截屏；
- 在设置里明确可见、可关。

**为什么排 P1**：它是 P0-2 的素材放大器，但不做 P0-2 就毫无意义；而它涉及隐私决策，需要你点头。

### P1-2 · 说话节奏（不话痨）

**做什么**：三条小规则，全部是提示词 + 解析层的事：
1. **回复长度跟状态走**：`energy<=0.25`（深夜）或 `mood=sad` → 上限 30 字；默认上限 120 字（现在没有上限约束）；
2. **允许短回**：给模型一个"嗯。""好。"的合法出口，并要求"没事时不要反问"；
3. **拟人延迟**：气泡前加 0.6–2.4s 的"思考延迟"（按回复长度与 `thinking` 动画时长算），不要秒回。

### P2-1 · 记忆的"清晰度"（比单纯的时间衰减更值钱）

surfcore 不是给记忆简单减分，而是算一个**清晰度档位**（`memory-card.js:1596-1619`）：
`vivid / clear / fuzzy / trace / forgotten` 五档，**每天最多降一档**，被重新提起会回升；
钉住项与"最初 30 天"免疫；模糊条目写进提示词时**直接标注「（细节记不清了）」**。

为什么这个设计更高明：它把**「记不清」变成一个可以被表演出来的合法状态**，从而堵住编造 ——
记不清就承认记不清，而不是硬圆一个细节。这也正好补上我们 GROUNDING 规则里"不确定就说不确定"缺的落地手段。

对齐我们这边：
1. `memories` 打分加时间项与 `last_hit_at` 刷新（现在打分完全不看时间，`memory.ts:254-266`）；
2. 新增 `clarity` **派生字段**（读时计算，不迁移表结构），按五档 + 每日降一档；
3. `buildMemoryBlock` 对 fuzzy 条目加"（细节记不清了）"，并在记忆段头尾加"真的记不清就说记不清，不要编"；
4. 让新偏好覆盖旧偏好（现在重复写入只更新 `importance`，内容不覆盖，`memory.ts:939-955`）。

### P2-2 · 把已经写好的东西接上

- `dialogueManager.getDialogue()`：动作播完时配一句台词（伸懒腰有声、被拖动会嘟囔）；夜间用 `lateNight` 池。
- 每日简报生成后**主动说一句**（现在只写库，白白浪费三次采集）。
- 桌面端 TTS：复用已有的 `contracts/tts.ts` 契约 + `voiceOutgoing.ts` 的策略，补一个渲染层播放器。

---

## 5. 已经落地的原型（本次交付）

`electron/ai/presence/` —— 纯逻辑内核，**零 I/O、零 import、零副作用**（照抄 surfcore `purpose-engine.js` 的红线），
所以能在 vitest 里完整覆盖，也不会把 db/electron 拖进单测：

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `PresenceState` / `Drives` / `GoalHypothesis` / `PresenceConfig` / 情绪→动画映射 `EMOTION_TO_AVATAR` |
| `mood.ts` | 驱动衰减（半衰期 8h）、需求词表、极性/唤醒度、生理节律 `energyAt`、`appraise()` 情绪评价、人格卡→驱动先验 |
| `purpose.ts` | 素材打分 `mineSeeds` → 目标假设 `formGoals` → 选择 `pickGoal` → 闸门 `planOutreach` → 记账 `commitOutreach` → 反馈学习 `reconcileReplies` → 提示词 `buildOutreachPrompt` |
| `presenceBlock.ts` | `buildPresenceBlock()`：注入 system 的「此刻的你」；`summarizePresence()`：设置页一行摘要 |
| `presence.spec.ts` | 34 条单测全部通过（衰减/需求/情绪/安静时段/归属/去重/闸门/抽签/轮换/记账/反馈/提示词） |

已验证：`npx vitest run electron/ai/presence/presence.spec.ts` → 34 passed；
`npx tsc --noEmit -p tsconfig.electron.json` → 0 error。

**它现在没有接线**——这是刻意的：内核先独立正确，接线是一次独立的小改动（见 §6），
避免"逻辑没验证就往 140KB 的 `main.ts` 里塞"。

### 5.1 跑一天模拟，抓出来的五个真 bug

写完之后用「固定时钟 + 一天七次 tick」的模拟跑了一遍（07:30 主人说"早，昨晚改bug改到三点，头好痛"，
9/11/13/15/18/21/23 点各 tick 一次，每次她开口后主人回一句）。**模拟比单测更早暴露问题**：

| # | 现象 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 「我好累」被判成**正向** → 情绪 `content` 而不是 `worried` | 极性词表收裸「好」，而中文「好累/好烦/好难」全是负面 | 去掉裸「好」，补「累/加班/痛/难受」 |
| 2 | 「头好痛」被判成 `learn`（因为句子里有 bug），念头成了"想弄明白头好痛" | 主导需求取的是词表命中顺序里的第一个维度 | 补 care 词（痛/难受/不舒服），主导需求取最高分 |
| 3 | 念头写成「想问问主人『早，昨晚改bug改到三点』的事」 | 主题直接取句首 18 字 | 按标点切句，挑**最贴合主导需求**那句，剥填充词与悬空虚词，压到 12 字 |
| 4 | 被主人明确拒绝的话题，下一轮又冒出来 | 每轮 goal 都是新造的（id 带时间戳），拒绝只记在当轮 goal 对象上等于没记 | 拒绝写进**观察账本**（`negative`），一周内不再采这条种子 |
| 5 | 驱动棘轮式漂移（夜里 `rest` 冲到 84%） | 记账时把 `effectiveDrives`（含"多久没见你"的浮动加成）写回了盘 | 落盘只写**衰减基线**，浮动加成永远现算 |

第 5 条尤其值得记：**"状态"和"状态的读数"必须分开** —— 把读数写回状态，任何随时间漂移的量都会失控。

单测还抓到一个更隐蔽的：`[].every(...) === true`（真空真），导致"需求轮换"的折价对**一次都没说过**的情况也生效。已加长度判断并钉在测试里。

---

## 6. 接线清单（~~下一步就能做~~ 第 1、2 刀已于 2026-11-24 落地，实际改动如下）

> 实际落地与原清单的差异：
> 状态没有落 `~/.kirari/presence/<uid>.json`，改用 **settings_kv 单键 JSON**
> （better-sqlite3 事务写入天然原子，还省了自管目录）；job kind 强转收在
> `presenceJobKind()` 一个函数里；job 顺延统一由 `scanOnce` 收口
> （tick 里不双写 job，否则 lastFiredAt 会丢）。

**已完成的改动**（全部通过：electron tsc 0 error / vue-tsc 0 error / 339 条测试全绿）：

| # | 文件 | 实际改动 |
| --- | --- | --- |
| 1 | `electron/ai/presence/stateStore.ts`（新） | settings_kv 读写 + 坏档自愈（解析失败重置而非抛错） |
| 2 | `electron/ai/presence/presenceHooks.ts`（新） | `isOwnerLocalSession`（身份门控）+ `recordUserTurn`/`appraiseReply` 转接 + `idleVariantFor` |
| 3 | `electron/ai/presence/presenceIO.ts`（新） | 对话主流程侧的只读门面 |
| 4 | `electron/ai/engine.ts` | 主人消息入库后 `recordUserTurn`；回复入库后 `appraiseReply`；均以 `isOwnerLocalSession` 门控 |
| 5 | `electron/ai/services/conversationService.ts` | system 注入「此刻的你」（场合段之后）；同样门控 |
| 6 | `electron/ai/presence/presenceSchedule.ts`（新） | `ensureJob` / `tickPresence` / runner 契约 / 简报素材读取 / 防热循环兜底 |
| 7 | `electron/ai/services/scheduledJobsService.ts` | `presence_tick` 分支 + **dueAt 覆盖段**（fireJob 的 +24h 会被 nextFireAt 修正；过去时推到安静时段结束，防每分钟热循环） |
| 8 | `electron/main.ts` | runner 注入（轻量模型调用，`SKIP` 短路；`injectProactiveMessage(speech, "wave")`）+ `presenceFocus` 配置 + `ensureJob()` |
| 9 | `electron/ai/services/dailyBriefingService.ts` | 加 `readTodayBrief()` 纯读函数（调度器不建 AiContext） |
| 10 | `electron/chat-session-service.ts` | snapshot 带 `presenceMood`（`computePresenceMood`，同样门控） |
| 11 | `src/stores/chat.ts` + `src/components/pet/PetStage.vue` | `moodIdleVariant()`：情绪/说话播完回落到"心情对应变体"（校验皮肤有该状态 + 不打断睡眠/拖拽） |

**身份与分别记忆的保住方式**（用户 2026-11-24 明确要求）：
记忆四池（person/self/scene/global）与披露分级**一行未动**；
在场感的**写入与注入都被 `isOwnerLocalSession` 门控**——
`bot-*`（QQ）、relay（组网）、带冒号的任务会话（workspace:/brief:）一律不写不注入，
客人的话不进主人的亲密度，主人的时间戳不会漏进朋友的会话。边界有单测钉住
（`身份边界：只有主人的本机会话才写在场感状态`）。

**还没做**（原清单 6-8 项）：桌面 TTS（P2-2）、桌面观察（P1-1，待拍板隐私红线）。

### 6.1 第 3 刀（2026-11-24 同日落地）：说话节奏 + 台词库 + 专注模式 + 状态面板

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `electron/ai/presence/presenceBlock.ts` | 新增 `buildPaceBlock()`：深夜/心情低落 → 40 字硬上限 + 短回许可（"嗯。""好。"是合法回复）；正常 → 软上限防小作文 |
| 2 | `conversationService.ts` | 节奏块随「此刻的你」一起注入（同一门控） |
| 3 | `src/components/pet/PetStage.vue` | **拟人延迟**：pet 消息到达后 400ms 起步、每 20 字 +120ms、封顶 1.6s 才播动画——等待期 thinking 正在播，观感是"想了一下才回答"，不再秒回 |
| 4 | `PetStage.vue` | **台词库接线**（`getDialogue` 此前零调用点）：入眠前嘟囔一句（深夜用 lateNight 池）、被叫醒说早安（greeting 池）、拖拽起止台词换成皮肤可覆盖的 drag.start/end 池 |
| 5 | `electron/main.ts` + `preload.ts` | `presence:get-status` / `presence:set-focus` 两个 IPC + 右键菜单加「专注模式（不主动打扰）」项（写 `presenceFocus` 并广播 `presence:focus-changed`） |
| 6 | `PetStage.vue` | 收到专注广播 → 立刻收回待显示气泡（她刚要开口就被按住了） |
| 7 | `GeneralSettings.vue` | 「她的状态」卡片：心情摘要 + 今日开口次数 + 专注模式开关（设置页与右键菜单是同一个开关，两处同步） |

验收对应 §8：可解释（状态面板）、有节制（次数可见 + 一键专注）、不翻车（339 条测试全绿、双 tsconfig 0 error）。

| # | 文件 | 改动 | 风险 |
| --- | --- | --- | --- |
| 1 | `electron/ai/presence/stateStore.ts`（新） | 状态读写 `~/.kirari/presence/<uid>.json`，原子写 + 默认值 | 低 |
| 2 | `electron/ai/services/conversationService.ts` | system 末尾追加 `buildPresenceBlock(...)`；`getReply` 前后各读写一次状态 | 低（只加一段字符串） |
| 3 | `electron/ai/engine.ts` | 消息落库处调 `recordUserTurn()`；模型回完调一次 `appraise` 更新 mood | 低 |
| 4 | `electron/ai/services/presenceSchedule.ts`（新） | 注册 `presence_tick` job（复用 `briefSchedule` 的写法）+ 注入 `presenceRunner` | 中（新 job kind，需在 `scheduledJobsService.scanOnce` 加一个分支） |
| 5 | `electron/main.ts` | 注入 runner：读素材（记忆/简报/日程/pending）→ `planOutreach` → 调模型 → `injectProactiveMessage` | 中 |
| 6 | `src/components/pet/PetStage.vue` | 情绪播完回落到"心情对应变体"；加"主动搭话"标签气泡；加思考延迟 | 低 |
| 7 | `src/components/pet/PetQuickMenu.vue` + 托盘 | 加「专注模式（不主动打扰）」勾选项 | 低 |
| 8 | 设置页新增「她的状态」 | 展示 `summarizePresence()` + 今日已开口次数 + 上次动机（调试用，也让她变得可解释） | 低 |

回归要求：`npm test`（现有 100 条用例）全绿 + `npm run typecheck` 三个 tsconfig 全绿 + 手动过一遍拖动/点穿/动画/安装包。

---

## 7. 不做的事

- **不做"假装真人"**：不改 CHARTER 里"你是桌宠程序"的边界。
- **不做情感操纵**：不因为她"想你"就制造愧疚感；`lonely` 只在真实陪伴缺口下出现（已写进单测）。
- **不做无上限的主动打扰**：默认就带每日上限与安静时段，且一键可关。
- **不落前台窗口标题原文**：只留聚合状态（除非你要求更多）。

---

## 8. 验收：怎么判断"更像真人了"

1. **可解释**：任何一次她主动开口，日志里能读出"她因为什么、觉得多可信、为什么选这个而不是那个、为什么是现在"。
2. **有节制**：连续 3 天，主动开口次数 ≤4/天，且没有一次落在安静时段或专注模式里。
3. **会记住反馈**：被她问过而你回"别问这个"的话题，一周内不再出现。
4. **有惯性**：同一句话在"刚被夸"和"刚被凶"两种状态下的回复明显不同（人工看样本）。
5. **不翻车**：`npm test` 100 条 + 新增单测全绿；拖动/点穿/动画/打包四项手测通过。

---

## 9. 建议的推进顺序

1. **第 1 刀（1 天）**：P0-1 情绪状态化 —— 只做"注入 + 写入 + 表现回落"，不做主动搭话。风险最低，立刻能感觉到"她今天心情不好"。
2. **第 2 刀（2 天）**：P0-2 目的机制接线 —— 先把"每日简报生成后主动说一句"当第一个素材源（零新采集，白捡）。
3. **第 3 刀（1 天）**：P1-2 说话节奏 + P2-2 台词库接线 —— 便宜、观感提升大。
4. **第 4 刀（待拍板）**：P1-1 桌面观察 —— 需要先定隐私红线。
5. **第 5 刀**：P2-1 记忆清晰度、桌面 TTS、P1-1 桌面观察（待拍板）。
