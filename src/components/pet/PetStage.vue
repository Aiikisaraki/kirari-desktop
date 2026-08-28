<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatSocket } from '../../composables/useChatSocket'
import { usePetStore } from '../../stores/pet'
import { useAvatarStore } from '../../stores/avatar'
import type { PetEmotion } from '../../stores/chat'
import type { AvatarState } from '../../pet/avatar/types'
import PetAvatar from './PetAvatar.vue'
import PetBubble from './PetBubble.vue'
import PetQuickMenu from './PetQuickMenu.vue'
import { getActiveRenderer } from '../../pet/avatar/types'
type DesktopPetChannel =
  | 'desktop-pet:drag-start'
  | 'desktop-pet:drag-move'
  | 'desktop-pet:drag-end'
  | 'desktop-pet:open-chat'
  | 'desktop-pet:show-context-menu'
  | 'desktop-pet:open-settings'
  | 'desktop-pet:hide'
  | 'desktop-pet:set-ignore-mouse'

type DesktopPetIpc = {
  send(channel: DesktopPetChannel, ...args: unknown[]): void
  on(channel: string, listener: (...args: unknown[]) => void): void
  off(channel: string, listener: (...args: unknown[]) => void): void
}

type ElectronApi = {
  ipcRenderer: DesktopPetIpc
}

declare global {
  interface Window {
    require?: (module: 'electron') => ElectronApi
  }
}

const petStore = usePetStore()
const avatarStore = useAvatarStore()
const { isVisible, message, setMessage } = petStore
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
const ipcRenderer = electron?.ipcRenderer

/* ===================== 状态机调度器 ===================== */
// 优先级：说话 > 高兴 > 招手 > 瞌睡 > 眨眼 > 待机。
// 低优先级状态不能打断高优先级（豆包互斥规则）；瞌睡的打断走专门的 markActivity/wakeUp。
const PRIORITY: Record<AvatarState, number> = {
  idle: 0,
  blink: 10,
  stretch: 12, // 伸懒腰：轻量小动作，接近 idle
  thinking: 15, // 思考：轻度走神，不怎么打断
  sleepy: 20,
  nod: 30, // 点头
  shake: 30, // 摇头
  wave: 40, // 招手
  bow: 40, // 鞠躬
  shy: 50, // 害羞
  happy: 60, // 高兴
  sad: 60, // 伤心
  excited: 66, // 兴奋
  surprised: 66, // 惊讶（可打断 happy/sad）
  speak: 100, // 说话：最高优先级，可打断一切
}

// durations 由 PetAvatar 加载 frames.json 后回填；此处给一次性动画一个兜底估计。
const FALLBACK_DUR: Partial<Record<AvatarState, number>> = {
  blink: 11000,
  wave: 5200,
  happy: 5200,
}
function durationOf(s: AvatarState): number {
  return avatarStore.durations[s] ?? FALLBACK_DUR[s] ?? 0
}

// 当前动画（一次性）播完回 idle 的统一计时器；loop 状态（speak/sleepy/idle）不自动回 idle。
let actionTimer: ReturnType<typeof setTimeout> | null = null

// 请求切换状态，遵守优先级互斥。返回是否成功接管。
function requestState(s: AvatarState): boolean {
  const cur = avatarStore.currentState
  if (PRIORITY[s] < PRIORITY[cur]) return false
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  avatarStore.setState(s)
  const d = durationOf(s)
  if (d > 0) {
    actionTimer = setTimeout(() => {
      if (avatarStore.currentState === s) avatarStore.setState('idle')
      actionTimer = null
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

function playSpeak() {
  requestState('speak') // speak 优先级最高，可打断瞌睡/招手/高兴
  if (speakTimer) clearTimeout(speakTimer)
  speakTimer = setTimeout(() => {
    if (avatarStore.currentState === 'speak') avatarStore.setState('idle')
    maybeHappy(0.12) // 一轮对话结束小概率高兴
  }, 2500)
}

function playEmotionThenSpeak(emo: PetEmotion) {
  requestState(emo)
  if (speakTimer) clearTimeout(speakTimer)
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
    // 轻动作不打断沉睡（保留趴桌观感）；情绪/事件类用 force 主动唤醒
    if (skipIfSleepy && avatarStore.currentState === 'sleepy') return false
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
  if (tapCount >= 3) {
    tapCount = 0
    maybeHappy(1) // 必定尝试（仍受冷却限制）
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

/* ===================== 伸懒腰（环境动作） ===================== */
// 闲置时随机 2~4 分钟伸个懒腰，增加存在感；不打断思考/说话/沉睡。
let stretchTimer: ReturnType<typeof setTimeout> | null = null
function scheduleStretch() {
  const delay = 120000 + Math.random() * 120000
  stretchTimer = setTimeout(() => {
    tryGesture('stretch', { cooldown: 60000 })
    scheduleStretch()
  }, delay)
}

/* ===================== 思考（等待回复时持续） ===================== */
// waitingForReply 为真时循环重播 thinking（素材为一次性），制造"持续思考"观感；
// 回复到达或被更高优先级动作（说话）占用时自动让位。不走 requestState 的自动回 idle 计时。
let thinkingTimer: ReturnType<typeof setInterval> | null = null
let thinkingStartTimer: ReturnType<typeof setTimeout> | null = null
function startThinking() {
  if (avatarStore.currentState === 'sleepy') return
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

/* ===================== 互动动作：点头 / 鞠躬 / 害羞 ===================== */
// - nod：听到你发消息时点一下头回应
// - bow：对话框打开时鞠躬问候
// - shy：光标在桌宠身上抚摸（移动）时害羞 —— 最强"互动感"
function onUserSpoke() {
  tryGesture('nod', { cooldown: 1500 })
}
function onChatOpened() {
  tryGesture('bow', { force: true, skipIfSleepy: false })
}

/* ===================== 打瞌睡 ===================== */
// 闲置 3~5 分钟无交互进入；任意交互立即打断回 idle（并小概率惊喜跳跃）。
let sleepTimer: ReturnType<typeof setTimeout> | null = null
let lastActivity = Date.now()

function scheduleSleepy() {
  if (sleepTimer) clearTimeout(sleepTimer)
  const delay = (3 + Math.random() * 2) * 60 * 1000 // 3~5 分钟
  sleepTimer = setTimeout(() => {
    if (avatarStore.currentState === 'idle') {
      requestState('sleepy')
    } else {
      scheduleSleepy() // 当前忙，稍后重试
    }
  }, delay)
}

function markActivity() {
  lastActivity = Date.now()
  scheduleSleepy()
  if (avatarStore.currentState === 'sleepy') {
    avatarStore.setState('idle') // 惊醒
    maybeHappy(0.12) // 唤醒彩蛋
  }
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

watch(lastError, (err) => {
  if (err && err.trim()) {
    // 聊天出错 / 无法满足：摇头
    tryGesture('shake', { force: true, skipIfSleepy: false, cooldown: 8000 })
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
  if (hoverTimer) clearTimeout(hoverTimer)
  if (stretchTimer) clearTimeout(stretchTimer)
  if (thinkingTimer) clearInterval(thinkingTimer)
  if (thinkingStartTimer) clearTimeout(thinkingStartTimer)
  if (sleepTimer) clearTimeout(sleepTimer)
  if (blinkTimer) clearTimeout(blinkTimer)
  if (tapResetTimer) clearTimeout(tapResetTimer)
  ipcRenderer?.off('desktop-pet:cursor', onCursorPos)
  window.removeEventListener('focus', onFocus)
})

/* ===================== 拖拽 / 点击 ===================== */
let pointerMoved = false

function startDrag(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return

  isDragging.value = true
  pointerMoved = false
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  ipcRenderer?.send('desktop-pet:drag-start')
  setMessage('跟着你移动中。')
  markActivity()
  window.addEventListener('pointermove', drag)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
  window.addEventListener('blur', stopDrag)
}

function drag() {
  if (!isDragging.value) return
  pointerMoved = true
  ipcRenderer?.send('desktop-pet:drag-move')
}

function stopDrag() {
  if (!isDragging.value) return

  isDragging.value = false
  ipcRenderer?.send('desktop-pet:drag-end')
  setMessage('这里看起来不错。')
  if (!pointerMoved) handleTap() // 没有拖动 = 一次轻点
  window.removeEventListener('pointermove', drag)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
  window.removeEventListener('blur', stopDrag)
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
function onCursorPos(_e: unknown, pt: { x: number; y: number }) {
  evaluateClickThrough(pt.x, pt.y)
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
