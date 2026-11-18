// 桌宠形象抽象层：把"播放什么状态"与"用什么技术渲染"彻底解耦。
// 状态机（idle/blink/speak/wave/happy/sleepy）只认 AvatarRenderer 接口，
// 不关心底层是精灵帧（SpriteRenderer）还是 Live2D（Live2DRenderer）。
// 这样即可在同一套框架下支持多种形象，并允许用户上传自定义精灵形象。

// 全部状态必须在皮肤 frames.json 里有对应精灵表 —— 渲染器不再对缺失状态做静默兜底
// （见 SpriteRenderer.setState 的 missing 告警分支）。新增状态时须同步：
//   1) 本联合类型 2) sprite sheets + frames.json 3) PetStage 的 PRIORITY / FALLBACK_DUR
//   4) 若允许模型下发，还要加进各处 PetEmotion 白名单。
export type AvatarState =
  // —— 基础态 ——
  | "idle" // 基础态：只含清醒段，循环
  | "blink" // 眨眼：从 idle 首帧闭合再睁眼，200ms 一次性
  | "speak" // 说话：循环
  | "sleepy" // 打瞌睡：循环（睡眠三段链的中段）
  // —— 情绪/动作动画 ——
  | "wave" // 招手
  | "happy" // 高兴跳跃
  | "bow" // 鞠躬
  | "excited" // 兴奋
  | "nod" // 点头
  | "sad" // 伤心
  | "shake" // 摇头
  | "shy" // 害羞
  | "surprised" // 惊讶
  | "thinking" // 思考
  | "head_tilt" // 歪头：互动类，回应"听你说话"
  | "angry" // 生气：叉腰闭眼憋气，模型下发 / 连续点击触发
  | "attention" // 举手示意"我在这里"：与 wave（你好/再见）语义不同
  | "stretch" // 伸懒腰打哈欠：清醒时的独立闲置动作（Q 版新素材，与 sleep_start 的入眠伸腰区分）
  // —— 睡眠三段链：sleep_start → sleepy(循环) → sleep_end ——
  // 三个状态都是**可选过渡态**：皮肤缺任一环时，调度器自动走"直连循环态"的降级路径：
  //   缺 sleep_start → 直接进 sleepy；缺 sleep_end → 从 sleepy 直接硬切 idle。
  | "sleep_start" // 入眠：起身伸懒腰后坐下，结尾接 sleepy
  | "sleep_end" // 苏醒：从睡眠坐姿站起，结尾接 idle
  // —— 拖拽 ——
  // drag_start 为**可选过渡态**：皮肤有则拎起时先播一次惊恐起身再接 drag 循环；
  // 没有则直接进 drag 循环（第 0 帧即"被拎起"姿势）。
  | "drag_start" // 被拎起的瞬间：惊恐脸红站起，接 drag 循环
  | "drag"; // 被拎起：循环，最高优先级且不可打断

export type AvatarType = "sprite" | "live2d" | "image";

// 单个动画片段（变体）定义：对应某一 state 下的一段精灵帧。
// 例如 happy 类型下可以有 happy1、happy2 两段，各自独立成一张 sheet。
export interface SpriteClipDef {
  sheet: string; // sheet 文件名，相对 frames.json 所在目录
  frameW: number;
  frameH: number;
  frames: number;
  fps: number;
}

// 单个动画类型（语义状态，如 idle/wave/happy）对应的定义：
// 可包含 1..N 个动画片段（变体）。loop 表示基础态（idle/speak/sleepy）是否循环播放。
export interface SpriteStateDef {
  loop: boolean;
  clips: SpriteClipDef[];
}

// 旧格式兼容：单个动画直接写成扁平结构 {sheet,frameW,frameH,frames,fps,loop}，
// 加载时会自动包成 clips:[...]（见 SpriteRenderer.normalizeState）。新格式为 {loop, clips:[...]}。
export type RawSpriteState = SpriteStateDef | (SpriteClipDef & { loop: boolean });

// 皮肤专属台词库定义
export interface PersonalityDialogues {
  greeting?: string[]
  drag?: {
    start?: string[]
    end?: string[]
  }
  idle?: string[]
  lateNight?: string[]
  longChat?: string[]
  apiError?: string[]
  reconnect?: string[]
  // 新增情绪场景
  shy?: string[]           // 害羞时台词
  sad?: string[]           // 难过时台词
  surprised?: string[]     // 惊讶时台词
  thinking?: string[]      // 思考中台词
  excited?: string[]       // 兴奋时台词
  angry?: string[]         // 生气时台词
  attention?: string[]     // 举手示意时台词
  stretch?: string[]       // 伸懒腰时台词
  // 新增交互场景
  head_tilt?: string[]     // 歪头（"在听你说"）时台词，键名与状态名一致
  nod?: string[]          // 点头确认时台词
  shake?: string[]        // 摇头拒绝时台词
  bow?: string[]          // 鞠躬时台词
  onEquip?: {
    text: string
    emotion?: AvatarState
  }
}

// 皮肤配置文件（frames.json）结构：
// 顶层可选 `type` 声明该皮肤用什么渲染器（sprite / live2d / image），缺省回退为 sprite（向后兼容）。
// 顶层可选 `name`（显示名，缺省回退文件夹名）、`author`（作者）、`version`（版本号）。
// 顶层可选 `chatAvatar`（聊天头像图文件名，相对皮肤文件夹）——「一套皮肤一个头像」。
// 顶层可选 `personality`（台词库）——跟随皮肤包分发的专属台词。
// 其余顶层键为动画状态（idle/blink/...），值为状态定义。
export type SpriteManifest = Record<string, RawSpriteState> & {
  type?: AvatarType;
  name?: string;
  author?: string;
  version?: string;
  chatAvatar?: string;
  personality?: PersonalityDialogues;
};

export interface AvatarConfig {
  type: AvatarType;
  // sprite: frames.json 的 URL（如 /pet/frames.json 或 avatar://<id>/frames.json）
  // live2d: model3.json 的 URL
  // image: 静态图片的 URL
  src: string;
  // 这套皮肤对应的聊天头像图（聊天窗口头部与消息流里显示的小头像）。
  // 由皮肤的 frames.json 顶层 "chatAvatar" 字段声明（皮肤目录内的图片文件名），
  // 运行时经 avatar://<皮肤目录>/<文件名> 协议对外服务；换皮肤即换头像。
  chatAvatar?: string;
  scale?: number;
  // 仅用于列表展示 / 持久化（以下字段不参与渲染）
  id?: string;
  name?: string;
  author?: string;
  version?: string;
  builtin?: boolean;
}

// 形象元信息（用于设置面板的列表与切换）
export interface AvatarMeta extends AvatarConfig {
  id: string;
  name: string;
  builtin?: boolean;
}

export interface AvatarRenderer {
  // 加载素材（sheet 或 model3.json 或静态图片）
  load(config: AvatarConfig): Promise<void>;
  // 挂载到 canvas 并开始播放
  mount(canvas: HTMLCanvasElement): void;
  // 切换到指定状态（语义意图，由实现内部映射）
  setState(state: AvatarState): void;
  // 缩放
  setScale(scale: number): void;
  // 卸载（切换形象时调用）
  destroy(): void;
  // 命中测试：画布内部像素坐标 (x, y) 处是否"实心"（alpha >= 阈值）。
  // 用于桌宠逐像素点穿：透明区透传点击给下方窗口，实心区才可拖动/交互。
  hitTest(x: number, y: number): boolean;
  // 返回各状态动画时长；无动画的渲染器返回空对象。
  getStateDurations(): Partial<Record<AvatarState, number>>;
}

// 当前正在渲染的实例（供 PetStage 命中测试使用，避免跨组件传递实例）。
let activeRenderer: AvatarRenderer | null = null;
export function setActiveRenderer(renderer: AvatarRenderer | null): void {
  activeRenderer = renderer;
}
export function getActiveRenderer(): AvatarRenderer | null {
  return activeRenderer;
}

import { SpriteRenderer } from "./SpriteRenderer";
import { Live2DRenderer } from "./Live2DRenderer";
import { ImageRenderer } from "./ImageRenderer";

// 渲染器工厂：根据类型实例化对应实现。live2d 当前为占位（留空），
// 返回 null 时调用方应保持上一个可用形象。
export function createRenderer(type: AvatarType): AvatarRenderer | null {
  if (type === "sprite") return new SpriteRenderer();
  if (type === "live2d") return new Live2DRenderer();
  if (type === "image") return new ImageRenderer();
  return null;
}
