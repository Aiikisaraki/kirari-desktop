import type { AvatarConfig, AvatarRenderer, AvatarState } from "./types";
import { getActiveRenderer, setActiveRenderer } from "./types";

// Live2D 渲染器 —— 当前为占位实现（路线已规划、后期接入 Cubism Web SDK）。
// 实现 AvatarRenderer 接口以保证框架一致性：切换 Live2D 形象时不会崩溃，
// 而是在 canvas 上提示"即将推出"，待后续把分层 PSD 素材绑成 model3.json 后填实。
export class Live2DRenderer implements AvatarRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;

  async load(_config: AvatarConfig): Promise<void> {
    // 后期：加载 model3.json + 贴图 + motions，初始化 Cubism Core
  }

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    canvas.width = 360;
    canvas.height = 480;
    this.ctx = canvas.getContext("2d");
    setActiveRenderer(this);
    this.drawPlaceholder();
  }

  setState(_state: AvatarState): void {
    // 占位：不驱动任何动作
    this.drawPlaceholder();
  }

  setScale(_scale: number): void {
    this.drawPlaceholder();
  }

  getStateDurations(): Partial<Record<AvatarState, number>> {
    return {};
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx = null;
    this.canvas = null;
    if (getActiveRenderer() === this) setActiveRenderer(null);
  }

  // 占位实现：Live2D 暂不做逐像素采样，整体按"实心"处理（不影响点穿逻辑，
  // 仅意味着 Live2D 形象仍会拦截整个窗口矩形，与旧行为一致）。
  hitTest(_x: number, _y: number): boolean {
    return true;
  }

  private drawPlaceholder(): void {
    if (!this.ctx || !this.canvas) return;
    const { width: w, height: h } = this.canvas;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = "rgba(255,255,255,0.04)";
    this.ctx.fillRect(0, 0, w, h);
    this.ctx.fillStyle = "rgba(120,120,140,0.9)";
    this.ctx.font = "14px system-ui, sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.fillText("Live2D 即将推出", w / 2, h / 2);
  }
}
