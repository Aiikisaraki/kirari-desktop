import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AvatarState } from '../pet/avatar/types'

// 可由对话情绪标签驱动播放的动画状态（先播该动作、再衔接 speak）。
// 即 AvatarState 去掉基础态与说话态：idle / blink / sleepy / speak。
export type PetEmotion = Exclude<AvatarState, 'idle' | 'blink' | 'sleepy' | 'speak'>

export type ChatMessage = {
  id: string
  author: 'user' | 'pet' | 'system'
  text: string
  timestamp: number
  // 对话回答携带的情绪/动作标签（来自后端 pet_response.emotion）。无则省略。
  // 取值见 PetEmotion：先播该动作、结束再衔接说话；不含基础态与说话态。
  emotion?: PetEmotion | null
  // 关联的图片 URL 或 base64 data URL（用户发送的图片、或 AI 返回的图片）。
  images?: string[]
}

export type ChatStateSnapshot = {
  sessionId: string
  connected: boolean
  lastError: string
  waitingForReply: boolean
  messages: ChatMessage[]
  bubbleMessage: string
  bubbleInteractive: boolean
}

// 聊天相关状态的唯一真相来源（进程内共享）。
// 注意：桌宠窗口与对话框是两个独立渲染进程，Pinia 不跨进程共享；
// “对话框是否打开”由主进程经 IPC（chat:open-changed）推入本 store。
export const useChatStore = defineStore('chat', () => {
  const connected = ref(false)
  const messages = ref<ChatMessage[]>([])
  const lastError = ref('')
  const waitingForReply = ref(false)
  const sessionId = ref('')
  const bubbleMessage = ref('')
  const bubbleInteractive = ref(false)

  // 未读消息数：仅当对话框未打开、且收到 pet 新消息时累加。
  const unreadCount = ref(0)
  // 对话框当前是否打开（由主进程 chat:open-changed 驱动）。
  const chatWindowOpen = ref(false)
  // 首帧快照只是历史回灌，不计入未读。
  const initialized = ref(false)

  function applyState(next: ChatStateSnapshot) {
    if (!initialized.value) {
      initialized.value = true
      connected.value = next.connected
      lastError.value = next.lastError
      waitingForReply.value = next.waitingForReply
      sessionId.value = next.sessionId
      messages.value = next.messages.map((m) => ({ ...m }))
      bubbleMessage.value = next.bubbleMessage
      bubbleInteractive.value = next.bubbleInteractive
      return
    }

    const prevLen = messages.value.length
    connected.value = next.connected
    lastError.value = next.lastError
    waitingForReply.value = next.waitingForReply
    sessionId.value = next.sessionId
    messages.value = next.messages.map((m) => ({ ...m }))
    bubbleMessage.value = next.bubbleMessage
    bubbleInteractive.value = next.bubbleInteractive

    const newLen = next.messages.length
    if (newLen > prevLen && !chatWindowOpen.value) {
      const added = next.messages.slice(prevLen)
      const petAdded = added.filter((m) => m.author === 'pet').length
      if (petAdded > 0) unreadCount.value += petAdded
    }
  }

  // 对话框打开/关闭。打开即视为已读，清零未读。
  function setChatWindowOpen(open: boolean) {
    chatWindowOpen.value = open
    if (open) unreadCount.value = 0
  }

  function resetUnread() {
    unreadCount.value = 0
  }

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
    initialized,
    applyState,
    setChatWindowOpen,
    resetUnread,
  }
})
