<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatSocket } from '../../composables/useChatSocket'
import { usePetStore } from '../../stores/pet'
import { useAvatarStore } from '../../stores/avatar'
import type { PetEmotion } from '../../stores/chat'
import type { AvatarState } from '../../pet/avatar/types'
import type { BridgeIpcRenderer } from '../../types/electronBridge'
import PetAvatar from './PetAvatar.vue'
import PetBubble from './PetBubble.vue'
import PetQuickMenu from './PetQuickMenu.vue'
import { getActiveRenderer } from '../../pet/avatar/types'
// 本窗口会发出的频道（收窄成联合类型，写错频道名编译期就能发现）。
// 注意与下面 PetIpc 配套：全局桥是 string，这里只在本文件内收窄。
type DesktopPetSendChannel =
  | 'desktop-pet:drag-start'
  | 'desktop-pet:drag-move'
  | 'desktop-pet:drag-end'
  | 'desktop-pet:open-chat'
  | 'desktop-pet:show-context-menu'
  | 'desktop-pet:open-settings'
  | 'desktop-pet:hide'
  | 'desktop-pet:reset-position'
  | 'desktop-pet:set-ignore-mouse'
  | 'desktop-pet:diag'

type PetIpc = Omit<BridgeIpcRenderer, 'send'> & {
  send(channel: DesktopPetSendChannel, ...args: unknown[]): void
}

const petStore = usePetStore()
const avatarStore = useAvatarStore()
// 必须走 storeToRefs：pet store 是 setup store，直接解构拿到的是解包后的值
// （isVisible 是 boolean 而非 Ref），`isVisible.value` 恒为 undefined —— 气泡永远不显示。
const { isVisible, message } = storeToRefs(petStore)
const { setMessage } = petStore
const {
  bubbleMessage,
  bubbleInteractive,
  messages,
  unreadCount,
  connected,
  waitingForReply,
  lastError,
  chatWindowOpen,
} = useChatSocket()
const electron = window.require?.('electron')
const ipcRenderer = electron?.ipcRenderer as PetIpc | undefined

/* ===================== 状态机调度器 ===================== */
// 优先级分层（数值越大越"硬"，低优先级不能打断高优先级）：
//   drag(200) / drag_start(200) 拖拽：最高且不可打断 —— 拎在手里时任何动作都必须让位
//   speak(100) 说话
//   60  情绪类：happy / excited / surprised / sad / angry
//   50  交互类：wave / bow / nod / shake / head_tilt / attention / stretch
//   40  思考
//   30  害羞（抚摸）
//   20  睡眠三段链：sleep_start → sleepy → sleep_end
//   10  眨眼
//    0  待机
// 睡眠链虽然优先级低，但"被叫醒"要走 sleep_end 模板（见 wakeUp）；强事件
//（说话、连接断开、报错、新消息）按设计允许硬切，不必等起床动作播完。
const PRIORITY: Record<AvatarState, number> = {
  idle: 0,
  blink: 10,
  // 睡眠三段链：同层，互相之间由睡眠链逻辑（而非优先级）决定走向
  sleep_start: 20,
  sleepy: 20,
  sleep_end: 20,
  shy: 30,
  thinking: 40,
  wave: 50,
  bow: 50,
  nod: 50,
  shake: 50,
  head_tilt: 50,
  attention: 50,
  stretch: 50,
  happy: 60,
  excited: 60,
  surprised: 60,
  sad: 60,
  angry: 60,
  speak: 100,
  // drag_start 与 drag 同层：拖拽入场过渡不能被普通动作打断；
  // 两者之间由拖拽流程自身的计时器决定走向（见 enterDragState）。
  drag_start: 200,
  drag: 200,
}

// 一次性动作的真实时长来源是 frames.json（PetAvatar 加载后回填 durations）。
// 下表只是"回填完成之前"那一小段窗口期的安全网：数值与当前内置皮肤一致，
// 回填后一律以素材为准，因此不会与实际播放时长产生偏差。
const FALLBACK_DUR: Partial<Record<AvatarState, number>> = {
  blink: 200,
  nod: 1208,
  wave: 4167,
  bow: 5042,
  happy: 5042,
  sad: 5042,
  shake: 5042,
  shy: 5042,
  excited: 5042,
  surprised: 5042,
  thinking: 5042,
  head_tilt: 5042,
  angry: 5042,
  attention: 5042,
  stretch: 5042,
  drag_start: 5042,
  sleep_start: 5167,
  sleep_end: 5042,
}
function durationOf(s: AvatarState): number {
  return avatarStore.durations[s] ?? FALLBACK_DUR[s] ?? 0
}

// 皮肤"能力检测"：过渡态（drag_start / sleep_start / sleep_end）是可选的 ——
// 皮肤没有这些表时，调度器走"直连循环态"的降级路径，而不是切到一个缺素材的状态
// （那样 SpriteRenderer 会每帧刷 missing 告警并回退 idle）。
// durations 由 PetAvatar 在加载 frames.json 后回填，键集合 = manifest 状态集合
// （loop 状态值为 0，但仍占一个键）。加载完成前的短暂空窗期按"内置皮肤有全部过渡态"
// 处理，避免首帧拖拽误判为降级；这个窗口内用户几乎不可能完成一次拖拽。
function hasState(s: AvatarState): boolean {
  const d = avatarStore.durations
  if (d && Object.keys(d).length > 0) return s in d
  // 尚未回填：假定内置皮肤（含全部过渡态）
  return true
}

// 当前动画（一次性）播完回 idle 的统一计时器；loop 状态（speak/sleepy/idle/drag）不自动回 idle。
let actionTimer: ReturnType<typeof setTimeout> | null = null

// 一次性动作播完后去哪：默认回 idle。睡眠链把两端接起来 ——
// 入眠动作结束直接坐进 sleepy 循环，醒来动作结束回到 idle。
// 只有这两个状态需要"不回家"的下一站，其余全部回 idle，所以这张表刻意保持最小。
const CHAIN_NEXT: Partial<Record<AvatarState, AvatarState>> = {
  sleep_start: 'sleepy',
  sleep_end: 'idle',
}

// 请求切换状态，遵守优先级互斥。返回是否成功接管。
// force = 跳过优先级检查（仅用于"叫醒"这类必须能压过当前状态的反向切换）。
function requestState(s: AvatarState, opts: { force?: boolean } = {}): boolean {
  const cur = avatarStore.currentState
  if (!opts.force) {
    if (PRIORITY[s] < PRIORITY[cur]) return false
    // 拖拽中一切让位（PRIORITY 已保证，这里显式兜一层，避免将来调优先级时误放行）
    // drag_start / drag 都算"正在拖拽"，彼此之间的切换由拖拽流程自己管，不走这里。
    if ((cur === 'drag' || cur === 'drag_start') && s !== 'drag' && s !== 'drag_start') return false
  }
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  avatarStore.setState(s)
  const d = durationOf(s)
  if (d > 0) {
    actionTimer = setTimeout(() => {
      actionTimer = null
      // 期间被更高优先级抢走就不再改状态，避免踩掉别人
      if (avatarStore.currentState === s) {
        avatarStore.setState(CHAIN_NEXT[s] ?? 'idle')
      }
    }, d)
  }
  return true
}

/* ===================== 说话 / 情绪优先 ===================== */
// 收到 pet 新回复即触发：带 emotion 先播情绪动画再说话；否则直接说话。
// 触发源为「messages 新增 pet 消息」，与对话框是否打开无关——
// 旧逻辑依赖 unreadCount（只在对话框关闭时累加），导致开着对话框聊天不播动画。
let speakTimer: ReturnType<typeof setTimeout> | null = null
let primed = false // 跳过首帧历史回灌，避免加载历史消息时误播动画

// 说话的收尾：2.5s 后回 idle，并小概率接一个高兴。
// 抽出来是因为它有两条触发路径（正常说话 / 拖拽松手后恢复说话），
// 后者绕开了 requestState，必须自己把这段计时器补上，否则会永远停在说话循环里。
const SPEAK_TAIL_MS = 2500
function armSpeakTail() {
  if (speakTimer) clearTimeout(speakTimer)
  speakTimer = setTimeout(() => {
    if (avatarStore.currentState === 'speak') avatarStore.setState('idle')
    maybeHappy(0.12) // 一轮对话结束小概率高兴
  }, SPEAK_TAIL_MS)
}

function playSpeak() {
  // 只在真的接管成功后才挂收尾计时器：requestState 被挡掉时（比如正在 drag）
  // 挂上去只会凭空排出一次 maybeHappy，等于给一次没发生的说话配了个尾巴。
  if (requestState('speak')) armSpeakTail()
}

function playEmotionThenSpeak(emo: PetEmotion) {
  // 情绪没抢到（当前状态优先级更高，例如已经在说话）就别排"等它播完"的空档，
  // 否则会给一句本该立刻出现的回复硬加 5 秒等待。
  if (!requestState(emo)) {
    playSpeak()
    return
  }
  if (speakTimer) clearTimeout(speakTimer)
  // requestState 已经按 emotion 时长挂了回 idle 计时器，这里改挂"播完接说话"，
  // 必须先把上一个撤掉，否则两个计时器会同时开火。
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  const d = durationOf(emo) || 1500
  // 情绪/动作动画播完后衔接说话
  actionTimer = setTimeout(() => playSpeak(), d)
}

watch(
  () => messages.value.length,
  (next, prev) => {
    // 跳过首帧历史回灌
    if (!primed) {
      primed = true
      return
    }
    if (next <= prev) return
    // 仅当新增消息里包含 pet 发言才触发说话动画
    const added = messages.value.slice(prev)
    const lastPet = [...added].reverse().find((m) => m.author === 'pet')
    if (!lastPet) return
    const emo = lastPet.emotion
    if (emo) {
      // 携带情绪/动作标签 → 先播该动作，结束再衔接说话
      playEmotionThenSpeak(emo)
    } else {
      playSpeak()
    }
  },
)

/* ===================== 通用手势调度（统一收口） ===================== */
// 所有「一次性动作」的触发都走这里：优先级互斥 + 按状态冷却 + 可强制打断瞌睡。
// 替代原先散落在各 maybe* 里的重复冷却/占用判断，状态机更易维护与扩展。
const gestureCooldownUntil: Partial<Record<AvatarState, number>> = {}
function tryGesture(
  s: AvatarState,
  opts: { cooldown?: number; force?: boolean; skipIfSleepy?: boolean } = {},
): boolean {
  const { cooldown = 0, force = false, skipIfSleepy = true } = opts
  if (!force) {
    const now = Date.now()
    if (now < (gestureCooldownUntil[s] ?? 0)) return false
    // 轻动作不打断沉睡（保留趴桌观感）；情绪/事件类用 force 主动唤醒。
    // 睡眠链的三个状态都算"睡"，否则在入眠/起床动作中途插个小动作会把链条切断。
    if (skipIfSleepy && isAsleep()) return false
  }
  const ok = requestState(s)
  if (ok && cooldown > 0) gestureCooldownUntil[s] = Date.now() + cooldown
  return ok
}

/* ===================== 高兴跳跃 ===================== */
// 触发条件：连续点击桌宠 3 次 / 对话结束小概率 / 唤醒熟睡彩蛋。冷却 3 分钟。
const HAPPY_COOLDOWN = 3 * 60 * 1000

function maybeHappy(prob: number) {
  if (Math.random() < prob) tryGesture('happy', { cooldown: HAPPY_COOLDOWN })
}

// 连续轻点检测：2.5s 内累计 3 次点击（非拖拽）触发。
let tapCount = 0
let tapResetTimer: ReturnType<typeof setTimeout> | null = null
function handleTap() {
  tapCount += 1
  if (tapResetTimer) clearTimeout(tapResetTimer)
  tapResetTimer = setTimeout(() => {
    tapCount = 0
  }, 2500)
  if (tapCount >= 5) {
    // 连续狂点 5 次 = "别戳了" → 生气（必定尝试，仍受冷却限制）
    tapCount = 0
    tryGesture('angry', { cooldown: 15000 })
  } else if (tapCount === 3) {
    // 连点 3 次 = 高兴
    maybeHappy(1)
  }
}

/* ===================== 招手 ===================== */
// 随机 40~90s 触发；鼠标悬浮 1s 触发；窗口聚焦触发。冷却 90s。睡醒后才随机。
const WAVE_COOLDOWN = 90 * 1000
let waveTimer: ReturnType<typeof setTimeout> | null = null
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function maybeWave(force = false) {
  tryGesture('wave', { cooldown: WAVE_COOLDOWN, force })
}

function scheduleWave() {
  const delay = 40000 + Math.random() * 50000
  waveTimer = setTimeout(() => {
    maybeWave()
    scheduleWave()
  }, delay)
}

/* ===================== 举手示意 / 伸懒腰（随机闲置动作） ===================== */
// attention（举手"我在这里"）与 stretch（伸懒腰）都是新画风的闲置小动作，
// 本地随机触发 + 冷却，避免和 wave 挤在同一瞬。它们同时也由模型下发 emotion 驱动。
const ATTENTION_COOLDOWN = 75 * 1000
const STRETCH_COOLDOWN = 120 * 1000
let attentionTimer: ReturnType<typeof setTimeout> | null = null
let stretchTimer: ReturnType<typeof setTimeout> | null = null

function maybeAttention(force = false) {
  tryGesture('attention', { cooldown: ATTENTION_COOLDOWN, force })
}
function maybeStretch(force = false) {
  tryGesture('stretch', { cooldown: STRETCH_COOLDOWN, force })
}

function scheduleAttention() {
  const delay = 55000 + Math.random() * 70000 // 55~125s
  attentionTimer = setTimeout(() => {
    maybeAttention()
    scheduleAttention()
  }, delay)
}
function scheduleStretch() {
  const delay = (2 + Math.random() * 2) * 60 * 1000 // 2~4 分钟
  stretchTimer = setTimeout(() => {
    maybeStretch()
    scheduleStretch()
  }, delay)
}

/* ===================== 歪头（互动动作） ===================== */
// 素材只有 head_tilt 一张表，没有独立的"听你说"状态；这里用它承担"我在听"的语汇：
// 你在对话框里敲字/刚发完消息时歪一下头。冷却较长，避免每次打字都抽一下。
const HEAD_TILT_COOLDOWN = 20000
function maybeHeadTilt(force = false): boolean {
  return tryGesture('head_tilt', { cooldown: HEAD_TILT_COOLDOWN, force })
}

/* ===================== 思考（等待回复时持续） ===================== */
// waitingForReply 为真时循环重播 thinking（素材为一次性），制造"持续思考"观感；
// 回复到达或被更高优先级动作（说话）占用时自动让位。不走 requestState 的自动回 idle 计时。
let thinkingTimer: ReturnType<typeof setInterval> | null = null
let thinkingStartTimer: ReturnType<typeof setTimeout> | null = null
function startThinking() {
  if (isAsleep()) return // 睡着时不思考：等对方真发消息再由 speak 硬切
  if (PRIORITY['thinking'] < PRIORITY[avatarStore.currentState]) return
  avatarStore.setState('thinking')
  if (thinkingTimer) clearInterval(thinkingTimer)
  const period = Math.max((durationOf('thinking') || 4000) - 200, 1200)
  thinkingTimer = setInterval(() => {
    if (!waitingForReply.value) {
      stopThinking()
      return
    }
    if (PRIORITY['thinking'] >= PRIORITY[avatarStore.currentState]) {
      avatarStore.setState('thinking') // 重新从头播，形成持续思考
    }
  }, period)
}
function stopThinking() {
  if (thinkingTimer) {
    clearInterval(thinkingTimer)
    thinkingTimer = null
  }
  if (avatarStore.currentState === 'thinking') avatarStore.setState('idle')
}

/* ===================== 互动动作：点头 / 歪头 / 鞠躬 / 害羞 ===================== */
// - head_tilt：对话框开着、你当面说话时歪头（"在听呢"）
// - nod：对话框关着时远远听到你发消息，点一下头
// - bow：对话框打开时鞠躬问候
// - shy：光标在桌宠身上抚摸（移动）时害羞 —— 最强"互动感"
const SLEEP_SIDE_STATES: AvatarState[] = ['sleep_start', 'sleepy', 'sleep_end']
function onUserSpoke() {
  // 对话框开着 = 你在"当面"跟她说 → 歪头倾听；关着 = 远远传来一句 → 点头
  if (chatWindowOpen.value && maybeHeadTilt()) return
  tryGesture('nod', { cooldown: 1500 })
}
function onChatOpened() {
  tryGesture('bow', { force: true, skipIfSleepy: false })
}

/* ===================== 睡眠三段链 ===================== */
// 睡眠是唯一一条"多段连续"的动画链，不能交给 requestState 的“播完回 idle”计时器：
//   sleep_start  起身伸懒腰 → 坐下      （一次性，5167ms，收尾即趴下）
//     → sleepy   趴着睡的循环
//       → sleep_end  坐起 → 站直 → 站定  （一次性，5042ms，末帧即 idle 姿态）
//         → idle
// 关键约束：
//  - 入睡只在 idle 上发生，避免从说话/招手直接趴下。
//  - 惊醒必须走 sleep_end，不能硬切 idle —— sleep_end 首帧是"坐着睡"的姿式，与 sleepy
//    对齐；硬切 idle 会从趴着直接跳成站着。sleep_start / sleepy / sleep_end 三个状态
//    优先级相同、且不在 CHAIN_NEXT 之外的路径上互相跳，所以中断只会发生在链条两端。
//  - 强事件（说话 / 报错 / 新消息 / 连接变化）按设计允许硬切覆盖睡眠（force），此时不播
//    sleep_end —— 用户正在等一个反应，不能让 TA 先看 5 秒起床动画。
let sleepTimer: ReturnType<typeof setTimeout> | null = null
let wakeTimer: ReturnType<typeof setTimeout> | null = null

// 是否处于睡眠链中的任意一段：只认状态，不做旁路记账，避免两处真相打架。
function isAsleep(): boolean {
  return SLEEP_SIDE_STATES.includes(avatarStore.currentState)
}

function scheduleSleepy() {
  if (sleepTimer) clearTimeout(sleepTimer)
  const delay = (3 + Math.random() * 2) * 60 * 1000 // 3~5 分钟
  sleepTimer = setTimeout(() => {
    sleepTimer = null
    if (avatarStore.currentState === 'idle') {
      // sleep_start 是可选过渡态：皮肤没有就直连 sleepy 循环（首帧即睡姿，硬切可接受）。
      // 有则播完自动接 sleepy（见 CHAIN_NEXT）。
      requestState(hasState('sleep_start') ? 'sleep_start' : 'sleepy')
    } else {
      scheduleSleepy() // 当前忙，稍后重试
    }
  }, delay)
}

// 叫醒：从入眠动作或睡眠循环切到起床动作；已在 sleep_end 时不做任何事（防重复触发）。
function wakeUp(): boolean {
  if (!isAsleep()) return false
  if (avatarStore.currentState === 'sleep_end') return false

  // sleep_end 是可选过渡态：皮肤没有就从 sleepy 直接硬切 idle（无起床动画）。
  if (!hasState('sleep_end')) {
    avatarStore.setState('idle')
    maybeHappy(0.12)
    return true
  }

  if (!requestState('sleep_end', { force: true })) return false
  gestureCooldownUntil['sleep_end'] = Date.now() + durationOf('sleep_end')
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => {
    wakeTimer = null
    // 起床动作播完后（此刻应已回到 idle）才有睡醒彩蛋
    if (avatarStore.currentState === 'idle') maybeHappy(0.12)
  }, durationOf('sleep_end') + 50)
  return true
}

function markActivity() {
  scheduleSleepy()
  wakeUp() // 有交互就叫醒；不在睡则直接返回 false
}

/* ===================== 眨眼（随机） ===================== */
// 仅空闲时插入，不打断瞌睡/说话等（优先级保证）。
let blinkTimer: ReturnType<typeof setTimeout> | null = null
function scheduleBlink() {
  const delay = 3000 + Math.random() * 5000
  blinkTimer = setTimeout(() => {
    requestState('blink')
    scheduleBlink()
  }, delay)
}

/* ===================== 事件驱动自动触发 ===================== */
// 把后端/连接状态映射到桌宠情绪，让它在无人操作时也"有反应"。
let wasConnected = connected.value
watch(connected, (c) => {
  if (c && !wasConnected) {
    // （重）连接成功：兴奋
    tryGesture('excited', { force: true, skipIfSleepy: false })
  } else if (!c && wasConnected) {
    // 断开连接：伤心
    tryGesture('sad', { force: true, skipIfSleepy: false })
  }
  wasConnected = c
})

let lastErrorAt = 0
watch(lastError, (err) => {
  if (err && err.trim()) {
    const now = Date.now()
    // 短时间内连续报错 = 接连碰壁 → 生气；单次出错仍是摇头。
    if (now - lastErrorAt < 8000) {
      tryGesture('angry', { force: true, skipIfSleepy: false, cooldown: 15000 })
    } else {
      tryGesture('shake', { force: true, skipIfSleepy: false, cooldown: 8000 })
    }
    lastErrorAt = now
  }
})

let lastUnread = unreadCount.value
watch(unreadCount, (n) => {
  if (n > lastUnread) {
    // 对话框关闭时收到新消息：惊讶（"你收到消息啦"）
    tryGesture('surprised', { force: true, skipIfSleepy: false, cooldown: 6000 })
  }
  lastUnread = n
})

watch(chatWindowOpen, (open) => {
  if (open) onChatOpened()
})

watch(waitingForReply, (w) => {
  if (w) {
    // 等点头回应播完再开始思考，避免动作打架
    const delay = (durationOf('nod') || 1000) + 200
    thinkingStartTimer = setTimeout(() => {
      if (waitingForReply.value) startThinking()
    }, delay)
  } else {
    if (thinkingStartTimer) {
      clearTimeout(thinkingStartTimer)
      thinkingStartTimer = null
    }
    stopThinking()
  }
})

// 你发消息 → 点头回应（与"收到 pet 回复播说话"互补）
watch(
  () => messages.value.length,
  (next, prev) => {
    if (!primed) return
    if (next <= prev) return
    const added = messages.value.slice(prev)
    if (added.some((m) => m.author === 'user')) onUserSpoke()
  },
)

/* ===================== 生命周期 ===================== */
const isDragging = ref(false)
const isBubbleDismissed = ref(false)
const displayMessage = computed(() => (isDragging.value ? message.value : bubbleMessage.value || message.value))
const displayInteractive = computed(() => !isDragging.value && bubbleInteractive.value)
const shouldShowBubble = computed(
  () => isVisible.value && (isDragging.value || (!isBubbleDismissed.value && unreadCount.value > 0)),
)

watch(
  () => messages.value.length,
  (nextLength, previousLength) => {
    if (nextLength > previousLength) {
      isBubbleDismissed.value = false
    }
  },
)

function onFocus() {
  markActivity()
  maybeWave(true) // 窗口切到前台主动招手
}

onMounted(() => {
  avatarStore.init()
  scheduleBlink()
  scheduleWave()
  scheduleAttention()
  scheduleStretch()
  scheduleSleepy()
  window.addEventListener('focus', onFocus)
  // 主进程每 20ms 轮询一次光标位置并广播到本窗口；这里注册接收器做判定。
  // 不依赖渲染进程能否读取 screen / 能否接收鼠标事件，彻底规避死锁。
  ipcRenderer?.on('desktop-pet:cursor', onCursorPos)
  // 上报视口尺寸 / dpr 供主进程诊断坐标空间（见 main.ts 的 [renderer-diag]）。
  ipcRenderer?.send('desktop-pet:diag', {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  })
})

onBeforeUnmount(() => {
  if (actionTimer) clearTimeout(actionTimer)
  if (speakTimer) clearTimeout(speakTimer)
  if (waveTimer) clearTimeout(waveTimer)
  if (attentionTimer) clearTimeout(attentionTimer)
  if (stretchTimer) clearTimeout(stretchTimer)
  if (dragStartTimer) clearTimeout(dragStartTimer)
  if (hoverTimer) clearTimeout(hoverTimer)
  if (thinkingTimer) clearInterval(thinkingTimer)
  if (thinkingStartTimer) clearTimeout(thinkingStartTimer)
  if (sleepTimer) clearTimeout(sleepTimer)
  if (wakeTimer) clearTimeout(wakeTimer)
  if (blinkTimer) clearTimeout(blinkTimer)
  if (tapResetTimer) clearTimeout(tapResetTimer)
  ipcRenderer?.off('desktop-pet:cursor', onCursorPos)
  window.removeEventListener('focus', onFocus)
})

/* ===================== 拖拽 / 点击 ===================== */
let pointerMoved = false
// 拖拽前正在播的状态。松手后回到它（若它本身是一次性动作且已被打断，就回 idle）。
let stateBeforeDrag: AvatarState | null = null
// 是否已真正进入 drag 表现。pointerdown 只是"预备"，要等指针真的挪动才切 drag ——
// 否则一次轻点也会先闪一帧"被拎起来"的姿势再跳去 handleTap 的表情。
let dragStateEntered = false

// 过渡态播完接 drag 循环的计时器（皮肤有 drag_start 时才用）。
let dragStartTimer: ReturnType<typeof setTimeout> | null = null

// 从 pointerdown 过渡到真正的拖拽：切 drag 循环态 + 冒出台词。
// 过渡态 drag_start 是**可选**的：
//  - 皮肤有 drag_start → 先播一次"被拎起"的惊恐起身，播完接 drag 循环；
//    松手（stopDrag）可随时打断，不会卡在过渡里。
//  - 皮肤没有 → 直接进 drag 循环（素材 frame 0 就是"被拎起"姿势，硬切入场不闪）。
function enterDragState() {
  if (dragStateEntered) return
  dragStateEntered = true
  stateBeforeDrag = avatarStore.currentState
  setMessage('跟着你移动中。')
  // 清掉一次性动作的收尾计时器，否则它到点会把当前状态顶成 idle
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  // 拖拽期间不喂闲置/睡眠计时器（startDrag 已处理），这里只需管过渡计时。
  if (hasState('drag_start')) {
    avatarStore.setState('drag_start')
    if (dragStartTimer) clearTimeout(dragStartTimer)
    dragStartTimer = setTimeout(() => {
      dragStartTimer = null
      // 松手可能已把状态改掉，只有仍在过渡态时才接循环
      if (dragStateEntered && avatarStore.currentState === 'drag_start') {
        avatarStore.setState('drag')
      }
    }, durationOf('drag_start'))
  } else {
    avatarStore.setState('drag')
  }
}

function startDrag(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return

  isDragging.value = true
  pointerMoved = false
  dragStateEntered = false
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  ipcRenderer?.send('desktop-pet:drag-start')
  // 拖拽期间不喂闲置计时器也不叫醒：拎在手里本来就该是清醒的，
  // 而 markActivity() 会在睡着时切到 sleep_end，和下面这行抢状态。
  if (isAsleep()) wakeUp()
  if (wakeTimer) {
    // 起床彩蛋的计时器此刻已无意义（主角不再回 idle 而是 drag），直接撤掉
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  scheduleSleepy()

  window.addEventListener('pointermove', drag)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
  window.addEventListener('blur', stopDrag)
}

function drag() {
  if (!isDragging.value) return
  // 先切 drag 态再上报移动：主进程按"窗口起点 + 光标位移"算位置，
  // 这里多等一帧只会让画面比窗口慢半拍。
  enterDragState()
  pointerMoved = true
  ipcRenderer?.send('desktop-pet:drag-move')
}

function stopDrag() {
  if (!isDragging.value) return

  isDragging.value = false
  // 过渡计时器必须撤掉：松手后它若再触发，会把 idle/drag 之外的状态改回 drag
  if (dragStartTimer) {
    clearTimeout(dragStartTimer)
    dragStartTimer = null
  }
  ipcRenderer?.send('desktop-pet:drag-end')
  window.removeEventListener('pointermove', drag)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
  window.removeEventListener('blur', stopDrag)

  if (!pointerMoved) {
    // 没有拖动 = 一次轻点：全程没进过 drag 态，也没说过拖拽台词
    handleTap()
    return
  }

  setMessage('这里看起来不错。')
  // 退出 drag：回到"拎起来之前那个还值得继续的表现"。
  // 不在这里走 requestState —— drag 优先级最高，用普通通道请求任何状态都会被自己挡住
  // （playSpeak 里的 requestState('speak') 会直接返回 false，所以不能调它）。
  // 只有 speak 值得恢复：它是唯一"跨越拖拽仍然语义成立"的循环态（对话还在进行），
  // 且恢复时必须自己补上回 idle 的计时器（armSpeakTail），否则会永远停在说话循环里。
  // 其余情况一律回 idle：一次性动作已经过时，睡眠链被拎起来本就该醒（startDrag 已叫醒）。
  const back = stateBeforeDrag
  stateBeforeDrag = null
  dragStateEntered = false
  if (back === 'speak') {
    avatarStore.setState('speak')
    armSpeakTail()
  } else {
    avatarStore.setState('idle')
  }
}

/* ===================== 抚摸 → 害羞 ===================== */
// 光标在桌宠身体范围内移动（不拖拽）视为"抚摸"，累计位移达标即害羞。
// 抚摸属于真实交互，会顺带唤醒沉睡中的桌宠（markActivity）。
let strokeX = 0
let strokeY = 0
let strokeAccum = 0
function onPetEnter() {
  strokeX = 0
  strokeY = 0
  strokeAccum = 0
}
function onPetLeave() {
  strokeX = 0
  strokeY = 0
  strokeAccum = 0
}
function onPetMove(e: PointerEvent) {
  if (isDragging.value) return
  markActivity()
  if (strokeX === 0 && strokeY === 0) {
    strokeX = e.clientX
    strokeY = e.clientY
    return
  }
  strokeAccum += Math.hypot(e.clientX - strokeX, e.clientY - strokeY)
  strokeX = e.clientX
  strokeY = e.clientY
  if (strokeAccum > 140) {
    strokeAccum = 0
    tryGesture('shy', { cooldown: 5000 }) // 抚摸够久 → 害羞
  }
}

const hovering = ref(false)
watch(hovering, (now) => {
  if (now) {
    markActivity()
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => maybeWave(), 1000) // 悬浮 1s 招手
  } else if (hoverTimer) {
    clearTimeout(hoverTimer)
  }
})

function dismissBubble() {
  isBubbleDismissed.value = true
}

function openChat() {
  isBubbleDismissed.value = true
  ipcRenderer?.send('desktop-pet:open-chat')
}

function openSettings() {
  ipcRenderer?.send('desktop-pet:open-settings')
}

function hidePet() {
  ipcRenderer?.send('desktop-pet:hide')
}

function resetPosition() {
  ipcRenderer?.send('desktop-pet:reset-position')
}

function showContextMenu() {
  ipcRenderer?.send('desktop-pet:show-context-menu')
}

/* ===================== 逐像素点穿 ===================== */
// 主进程每 20ms 轮询一次光标位置（主进程 screen 模块可用，渲染进程不可用），
// 把相对桌宠窗口的视口坐标通过 desktop-pet:cursor 广播过来；onCursorPos 据此判定：
// 透明像素 → setIgnoreMouseEvents(true) 把点击透传给下方窗口；
// 实心像素 → 关闭穿透，使拖拽/点击正常作用到桌宠。
// 用主进程轮询而非渲染进程读 electron.screen，规避了「渲染进程拿不到 screen」导致
// 轮询失效、窗口永远不点穿（完全挡住后方点击）的问题。
let lastIgnore: boolean | null = null

// 气泡 / 悬浮菜单 / 按钮等交互控件永远按"实心"处理，保证它们可点击。
function isInteractiveEl(el: Element | null): boolean {
  if (!el) return false
  return !!el.closest('.pet-bubble, .quick-fab, .quick-item, button, a, input, textarea, select')
}

function evaluateClickThrough(clientX: number, clientY: number) {
  if (!ipcRenderer) return
  // 提前取到画布 / 渲染器 / 布局，命中测试与诊断日志共用同一份计算结果。
  const canvas = document.querySelector(".pet-canvas") as HTMLCanvasElement | null
  const r = getActiveRenderer()
  const rect = canvas ? canvas.getBoundingClientRect() : null
  let lx = 0
  let ly = 0
  let solid = true
  if (r && canvas && rect && rect.width > 0 && rect.height > 0) {
    lx = ((clientX - rect.left) / rect.width) * canvas.width
    ly = ((clientY - rect.top) / rect.height) * canvas.height
    solid = r.hitTest(lx, ly)
  }

  let wantIgnore = false
  // 拖拽中：强制实心（不穿透），否则拖到角色透明部位会中断拖拽
  if (isDragging.value) {
    wantIgnore = false
  }
  // 落在交互 UI（气泡 / 悬浮菜单 / 按钮）上 → 实心
  else if (isInteractiveEl(document.elementFromPoint(clientX, clientY))) {
    wantIgnore = false
  }
  // 其余：按画布像素 alpha 判定（映射光标到 canvas 内部像素坐标，直接读显示画布）。
  // 注意：不再用 isVisible store 控制整窗点穿——桌宠隐藏由主进程 win.hide() 负责，
  // 渲染侧若误判可见性（如 isVisible 因持久化/初始化为 false 而实际窗口仍显示）
  // 会把正常桌宠永久点穿，导致"完全点不到"。
  else {
    wantIgnore = !solid
  }
  // 悬浮态改为「光标是否落在桌宠窗口矩形内」驱动：只要光标还在本无边框窗口内
  // （含角色透明留白区），就视为悬浮并展示右下角快捷菜单。
  // 这样即便光标停在角色透明区（窗口已点穿、OS 焦点已离开桌宠），小球仍保持显示，
  // 用户才能把光标挪过去点中；只有光标真正移出窗口矩形时才隐藏。
  // 注意：点穿(wantIgnore) 与悬浮态已解耦——点穿仍按角色像素 alpha 判定（透明区可点后方窗口），
  // 小球能否点中由下方 isInteractiveEl 分支兜底：光标落在小球/菜单上即强制不点穿。
  const inWindow = clientX >= 0 && clientX <= window.innerWidth && clientY >= 0 && clientY <= window.innerHeight
  hovering.value = inWindow

  if (lastIgnore !== wantIgnore) {
    ipcRenderer.send("desktop-pet:set-ignore-mouse", wantIgnore)
    lastIgnore = wantIgnore
  }
}

// 接收主进程广播的光标位置（已是相对桌宠窗口的视口坐标，与 getBoundingClientRect 同坐标系）。
// listener 形参是 unknown，这里不能收窄（逆变会报 TS2345），内部再做类型断言。
function onCursorPos(_e: unknown, pt: unknown) {
  const p = pt as { x: number; y: number }
  evaluateClickThrough(p.x, p.y)
}
</script>

<template>
  <section
    class="pet-stage"
    :class="{ 'is-dragging': isDragging }"
  >
    <PetBubble
      :message="displayMessage"
      :visible="shouldShowBubble"
      :interactive="displayInteractive"
      @open-chat="openChat"
      @dismiss="dismissBubble"
    />
    <div
      class="pet-body"
      @pointerdown="startDrag"
      @pointerenter="onPetEnter"
      @pointerleave="onPetLeave"
      @pointermove="onPetMove"
      @contextmenu.prevent="showContextMenu"
    >
      <PetAvatar :visible="isVisible" />
    </div>
    <PetQuickMenu
      :hover="hovering"
      @open-chat="openChat"
      @open-settings="openSettings"
      @hide-pet="hidePet"
      @reset-position="resetPosition"
    />
  </section>
</template>
