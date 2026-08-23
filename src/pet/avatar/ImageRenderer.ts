import type { AvatarConfig, AvatarRenderer, AvatarState } from "./types";
import { getActiveRenderer, setActiveRenderer } from "./types";

// 静态图片渲染器：把单张图片作为桌宠形象绘制到 canvas 上。
// 适用于「一套皮肤对应一个头像」场景：主题切换时自动切到对应的静态头像。
const ALPHA_THRESHOLD = 32;
const MAX_CANVAS_SIZE = 512;

export class ImageRenderer implements AvatarRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private img: HTMLImageElement | null = null;
  private config: AvatarConfig | null = null;
  private scale = 1;

  async load(config: AvatarConfig): Promise<void> {
    this.config = config;
    if (typeof config.scale === "number" && config.scale > 0) {
      this.scale = config.scale;
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        this.img = img;
        resolve();
      };
      img.onerror = () => reject(new Error(`图片头像加载失败: ${config.src}`));
      img.src = config.src;
    });
  }

  mount(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });

    const img = this.img;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      // 按长边等比缩放到 MAX_CANVAS_SIZE 以内，保证命中测试精度同时不过度占用内存。
      const ratio = img.naturalWidth / img.naturalHeight;
      if (img.naturalWidth > img.naturalHeight) {
        canvas.width = Math.min(img.naturalWidth, MAX_CANVAS_SIZE);
        canvas.height = Math.round(canvas.width / ratio);
      } else {
        canvas.height = Math.min(img.naturalHeight, MAX_CANVAS_SIZE);
        canvas.width = Math.round(canvas.height * ratio);
      }
    } else {
      canvas.width = 360;
      canvas.height = 360;
    }

    setActiveRenderer(this);
    this.draw();
  }

  setState(_state: AvatarState): void {
    // 静态图片不驱动状态动画；未来可扩展为状态切换时做轻微缩放/位移。
    this.draw();
  }

  setScale(scale: number): void {
    this.scale = scale > 0 ? scale : 1;
    this.draw();
  }

  getStateDurations(): Partial<Record<AvatarState, number>> {
    return {};
  }

  destroy(): void {
    this.ctx = null;
    this.canvas = null;
    this.img = null;
    this.config = null;
    if (getActiveRenderer() === this) setActiveRenderer(null);
  }

  // 命中测试：透明区（含图片外的空白）透传点击，实心区拦截。
  hitTest(x: number, y: number): boolean {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return true;
    const w = canvas.width;
    const h = canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    try {
      const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      return data[3] >= ALPHA_THRESHOLD;
    } catch {
      return true;
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const img = this.img;
    if (!ctx || !canvas || !img) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // contain 模式：等比缩放并居中绘制，保持图片不变形。
    const scaleX = canvas.width / img.naturalWidth;
    const scaleY = canvas.height / img.naturalHeight;
    const baseScale = Math.min(scaleX, scaleY) * this.scale;

    const dw = img.naturalWidth * baseScale;
    const dh = img.naturalHeight * baseScale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.drawImage(img, dx, dy, dw, dh);
  }
}
