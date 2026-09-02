// 皮肤专属台词管理器
import type { PersonalityDialogues } from '../avatar/types'

// 默认台词（兜底，当皮肤未定义 personality 时使用）
const DEFAULT_DIALOGUES: PersonalityDialogues = {
  greeting: ['你好~', '嗨！', '找我有事吗？'],
  drag: {
    start: ['移动中...', '跟着你走~'],
    end: ['就这里吧', '好了~']
  },
  idle: ['...', '嗯？', '在呢'],
  lateNight: ['深夜了...', '还不睡吗？'],
  apiError: ['出错了...', '稍等一下'],
  // 新增情绪场景默认台词
  shy: ['呀...', '有点不好意思...', '(脸红)'],
  sad: ['唔...', '有点难过...', '...'],
  surprised: ['诶？！', '吓一跳！', '怎么了？'],
  thinking: ['让我想想...', '嗯...', '思考中...'],
  excited: ['太好了！', '耶！', '好开心！'],
  // 新增交互场景默认台词
  stretch: ['呼~', '伸个懒腰~', '放松一下'],
  nod: ['嗯嗯', '好的', '明白了'],
  shake: ['不不不', '这个不行哦', '摇头~'],
  bow: ['失礼了', '请多指教', '鞠躬~']
}

class DialogueManager {
  private currentPersonality: PersonalityDialogues = DEFAULT_DIALOGUES

  // 加载皮肤的 personality 配置
  loadPersonality(personality?: PersonalityDialogues) {
    this.currentPersonality = personality || DEFAULT_DIALOGUES
  }

  // 从指定类别随机选择一条台词
  getDialogue(
    category: keyof PersonalityDialogues,
    subKey?: 'start' | 'end'
  ): string {
    const categoryData = this.currentPersonality[category]
    
    // onEquip 是对象，直接返回 text
    if (category === 'onEquip' && categoryData && typeof categoryData === 'object' && 'text' in categoryData) {
      return categoryData.text
    }
    
    // drag 是嵌套对象
    if (category === 'drag' && categoryData && typeof categoryData === 'object' && 'start' in categoryData) {
      const pool = subKey ? categoryData[subKey] : categoryData.start
      if (Array.isArray(pool) && pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)]
      }
    }
    
    // 其他类别都是字符串数组
    if (Array.isArray(categoryData) && categoryData.length > 0) {
      return categoryData[Math.floor(Math.random() * categoryData.length)]
    }
    
    // 兜底：返回默认台词
    const defaultCategory = DEFAULT_DIALOGUES[category]
    if (category === 'drag' && defaultCategory && typeof defaultCategory === 'object' && 'start' in defaultCategory) {
      const pool = subKey ? defaultCategory[subKey] : defaultCategory.start
      if (Array.isArray(pool) && pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)]
      }
    }
    if (Array.isArray(defaultCategory) && defaultCategory.length > 0) {
      return defaultCategory[Math.floor(Math.random() * defaultCategory.length)]
    }
    
    return '...'
  }

  // 获取换装反馈（包含台词和动画）
  getOnEquipReaction(): { text: string; emotion?: string } | null {
    const onEquip = this.currentPersonality.onEquip
    if (onEquip && typeof onEquip === 'object' && 'text' in onEquip) {
      return onEquip
    }
    return null
  }
}

export const dialogueManager = new DialogueManager()
export default dialogueManager
