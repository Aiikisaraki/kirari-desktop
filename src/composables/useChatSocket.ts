import { storeToRefs } from 'pinia'
import { useChatStore, type ChatStateSnapshot } from '../stores/chat'
import type { BridgeIpcRenderer } from '../types/electronBridge'

type DesktopPetChannel =
  | 'chat:send-message'
  | 'desktop-pet:drag-start'
  | 'desktop-pet:drag-move'
  | 'desktop-pet:drag-end'
  | 'desktop-pet:open-chat'
  | 'desktop-pet:show-context-menu'
  | 'desktop-pet:reset-position'
type DesktopPetInvokeChannel = 'chat:get-state'
type DesktopPetEventChannel = 'chat:state' | 'chat:open-changed'

type DesktopPetIpc = {
  send(channel: DesktopPetChannel, payload?: unknown): void
  invoke(channel: DesktopPetInvokeChannel): Promise<ChatStateSnapshot>
  on(channel: DesktopPetEventChannel, listener: (...args: unknown[]) => void): void
}

// Window.require 的全局声明统一在 src/types/electronBridge.ts，此处只做频道收窄。
const ipcRenderer = window.require?.('electron').ipcRenderer as
  | (Omit<BridgeIpcRenderer, 'send' | 'invoke'> & DesktopPetIpc)
  | undefined
let initialized = false

// 把主进程推送的状态桥接到 Pinia store；跨窗口的“对话框打开”也走这里。
function ensureInitialized() {
  if (initialized || !ipcRenderer) return

  const store = useChatStore()
  // 回调签名是 (...args: unknown[])，参数不能在这里收窄成具体类型，
  // 否则与 listener 的 unknown 形参逆变冲突（TS2345）。
  ipcRenderer.on('chat:state', (_event: unknown, nextState: unknown) => {
    store.applyState(nextState as ChatStateSnapshot)
  })
  ipcRenderer.on('chat:open-changed', (_event: unknown, open: unknown) => {
    store.setChatWindowOpen(open === true)
  })
  initialized = true
}

async function requestState() {
  const store = useChatStore()
  if (!ipcRenderer) {
    store.lastError = '桌宠 IPC 不可用'
    return
  }

  const nextState = await ipcRenderer.invoke('chat:get-state')
  store.applyState(nextState)
}

function sendMessage(content: string, images?: string[]) {
  const text = content.trim()
  const imgs = Array.isArray(images)
    ? images.filter((x) => typeof x === 'string' && x.trim())
    : []
  if (!text && imgs.length === 0) return
  if (!ipcRenderer) return

  // 经 IPC 把文本与（可选的）图片 base64 data URL 一并发给主进程 → 后端。
  ipcRenderer.send('chat:send-message', { text, images: imgs })
}

function openChat() {
  ipcRenderer?.send('desktop-pet:open-chat')
}

export function useChatSocket() {
  const store = useChatStore()
  ensureInitialized()
  void requestState()

  // storeToRefs 仅解包 state，函数保持原样返回。
  const {
    connected,
    messages,
    lastError,
    waitingForReply,
    sessionId,
    bubbleMessage,
    bubbleInteractive,
    unreadCount,
    chatWindowOpen,
  } = storeToRefs(store)

  return {
    connected,
    messages,
    lastError,
    waitingForReply,
    sessionId,
    bubbleMessage,
    bubbleInteractive,
    unreadCount,
    chatWindowOpen,
    requestState,
    sendMessage,
    openChat,
  }
}
