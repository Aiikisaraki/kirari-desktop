import type {
    AvatarConfig,
    AvatarRenderer,
    AvatarState,
    SpriteClipDef,
    SpriteManifest,
    SpriteStateDef,
} from "./types";
import { getActiveRenderer, setActiveRenderer } from "./types";

// 基础态：任何一次性（非 loop）动作播完后都平滑回到这个站姿，
// 保证本段动画既能自循环也能与其他动作无缝衔接。
const BASE_STATE: AvatarState = "idle";

// 命中测试阈值：alpha 低于该值的像素视为"透明"，应透传点击给下方窗口。
// 取值偏小以保留抗锯齿边缘的点击；可按需调大让羽化边缘也点穿。
const ALPHA_THRESHOLD = 32;

// 把原始 state 定义归一化为 {loop, clips[]}。兼容两种写法：
//  - 新格式：显式 {loop, clips:[{sheet,frameW,frameH,frames,fps}, ...]}
//  - 旧扁平格式：{sheet,frameW,frameH,frames,fps,loop}（自动包成单 clip）
// 任一变体缺 sheet/尺寸非法则返回 null，加载时跳过该状态。
function normalizeState(raw: unknown): SpriteStateDef | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    // 新格式：显式 clips 数组
    if (Array.isArray(r.clips)) {
        const clips = (r.clips as unknown[]).map((c) => {
            const cc = c as Record<string, unknown>;
            return {
                sheet: String(cc.sheet ?? ""),
                frameW: Number(cc.frameW ?? 0),
                frameH: Number(cc.frameH ?? 0),
                frames: Number(cc.frames ?? 0),
                fps: Number(cc.fps ?? 0),
            } as SpriteClipDef;
        });
        if (clips.length === 0) return null;
        return { loop: r.loop === true, clips };
    }
    // 旧扁平格式
    if (typeof r.sheet === "string") {
        const clip: SpriteClipDef = {
            sheet: r.sheet,
            frameW: Number(r.frameW ?? 0),
            frameH: Number(r.frameH ?? 0),
            frames: Number(r.frames ?? 0),
            fps: Number(r.fps ?? 0),
        };
        if (!clip.sheet) return null;
        return { loop: r.loop === true, clips: [clip] };
    }
    return null;
}

// 精灵帧渲染器：用 2D canvas 按 fps 切帧播放。
// 读取 frames.json（映射 state -> {sheet, frameW, frameH, frames, fps, loop}），
// 预加载各 state 的横向 sprite sheet 为 Image，rAF 驱动切帧。
export class SpriteRenderer implements AvatarRenderer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    // 归一化后的清单：每个语义状态对应 {loop, clips[]}（旧格式已包成单 clip）。
    private manifest: Record<string, SpriteStateDef> | null = null;
    // 每个状态对应一组图片，索引与 clips 对齐（支持一个状态多个变体）。
    private sheets: Record<string, (HTMLImageElement | null)[]> = {};
    private state: AvatarState = BASE_STATE;
    private baseStateName: AvatarState = BASE_STATE; // 实际基础态：idle 优先，缺失则取首个可用状态
    private clipIndex = 0; // 当前状态随机选中的变体下标
    private frame = 0;
    private acc = 0;
    private last = 0;
    private raf = 0;
    private running = false;
    private scale = 1;
    private baseDir = "";
    private configSrc = "";

    async load(config: AvatarConfig): Promise<void> {
        // ---- 加载 frames.json：先尝试 fetch（自定义协议），失败则走 IPC 兜底 ----
        let json: SpriteManifest;
        const isCustomProtocol =
            config.src.startsWith("pet://") ||
            config.src.startsWith("avatar://");

        if (isCustomProtocol) {
            // 自定义协议在打包后可能因 origin 安全策略导致 fetch 不可用，
            // 因此同时准备 fetch + IPC 双通道。
            json = await this.loadManifestWithFallback(config.src);
        } else {
            // 标准 HTTP/文件路径：直接 fetch（开发模式 Vite dev server）
            const res = await fetch(config.src);
            if (!res.ok)
                throw new Error(`加载 frames.json 失败: ${config.src}`);
            json = (await res.json()) as SpriteManifest;
        }

        this.configSrc = config.src;
        // sheet 相对 frames.json 所在目录解析
        const idx = config.src.lastIndexOf("/");
        this.baseDir = idx >= 0 ? config.src.slice(0, idx + 1) : "";

        // 归一化每个状态（兼容旧扁平格式），仅保留合法状态。
        // 跳过顶层保留字段 `type`（渲染类型声明，非动画状态）。
        this.manifest = {};
        for (const key of Object.keys(json)) {
            if (key === "type") continue;
            const norm = normalizeState(json[key]);
            if (norm && norm.clips.length > 0) this.manifest[key] = norm;
        }
        if (Object.keys(this.manifest).length === 0) {
            throw new Error(`frames.json 为空或格式无效: ${config.src}`);
        }
        // 实际基础态：优先 idle，否则取首个可用状态（保证播完能回到某个站姿）。
        this.baseStateName = this.manifest[BASE_STATE]
            ? BASE_STATE
            : (Object.keys(this.manifest)[0] as AvatarState);

        // 逐状态、逐变体加载精灵图（每个变体一张 sheet）。
        this.sheets = {};
        for (const key of Object.keys(this.manifest)) {
            const def = this.manifest[key];
            const arr: (HTMLImageElement | null)[] = [];
            await Promise.all(
                def.clips.map((clip, i) =>
                    this.loadImageWithFallback(
                        this.baseDir + clip.sheet,
                        key,
                    ).then((img) => {
                        arr[i] = img;
                    }),
                ),
            );
            this.sheets[key] = arr;
        }

        if (typeof config.scale === "number" && config.scale > 0)
            this.scale = config.scale;
    }

    /** 双通道加载 manifest：fetch 优先，失败则 IPC 兜底 */
    private async loadManifestWithFallback(
        src: string,
    ): Promise<SpriteManifest> {
        // 通道 1：fetch（自定义协议或 HTTP）
        try {
            const res = await fetch(src);
            if (res.ok) return (await res.json()) as SpriteManifest;
        } catch {
            // fetch 不可用（打包后 file:// origin 可能阻止跨协议 fetch），走通道 2
        }

        // 通道 2：IPC → 主进程读取 asar 内文件
        console.log("[sprite] fetch 失败，切换到 IPC 加载:", src);
        const relPath = src
            .replace(/^pet:\/\//, "")
            .replace(/^avatar:\/\//, "");
        const ipc = this.getIpc();
        if (!ipc)
            throw new Error("IPC 不可用且 fetch 也失败，无法加载精灵帧配置");

        const result = (await ipc.invoke("pet:read-asset", relPath)) as {
            ok: boolean;
            data?: SpriteManifest;
            error?: string;
        };
        if (!result?.ok || !result.data) {
            throw new Error(
                `IPC 加载精灵帧配置失败: ${result?.error || "未知错误"}`,
            );
        }
        return result.data;
    }

    /** 双通道加载图片：Image() 优先（支持自定义协议），失败则 IPC data URL 兜底 */
    private async loadImageWithFallback(
        src: string,
        stateLabel: string,
    ): Promise<HTMLImageElement | null> {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = async () => {
                // Image() 加载失败：尝试 IPC data URL 兜底
                console.log(
                    `[sprite] Image() 加载失败 (${stateLabel})，尝试 IPC 兜底:`,
                    src,
                );
                const ipc = this.getIpc();
                if (!ipc) {
                    resolve(null);
                    return;
                }

                try {
                    const relPath = src
                        .replace(/^pet:\/\//, "")
                        .replace(/^avatar:\/\//, "");
                    const result = (await ipc.invoke(
                        "pet:read-asset",
                        relPath,
                    )) as {
                        ok: boolean;
                        data?: string;
                        error?: string;
                    };
                    if (
                        result?.ok &&
                        typeof result.data === "string" &&
                        result.data.startsWith("data:")
                    ) {
                        const fallbackImg = new Image();
                        fallbackImg.onload = () => resolve(fallbackImg);
                        fallbackImg.onerror = () => resolve(null);
                        fallbackImg.src = result.data;
                    } else {
                        resolve(null);
                    }
                } catch {
                    resolve(null);
                }
            };
            img.src = src;
        });
    }

    /** 获取 ipcRenderer 实例（兼容 nodeIntegration 与 preload 两种模式） */
    private getIpc(): {
        invoke: (ch: string, ...args: unknown[]) => Promise<unknown>;
    } | null {
        try {
            const w = window as unknown as {
                require?: (m: string) => {
                    ipcRenderer: { invoke: (...a: unknown[]) => unknown };
                };
            };
            if (w.require) return w.require("electron").ipcRenderer;
            // 部分窗口通过 windowApi 暴露（preload 注入）
            const api = w as unknown as {
                electronApi?: {
                    ipcRenderer: { invoke: (...a: unknown[]) => unknown };
                };
            };
            if (api.electronApi) return api.electronApi.ipcRenderer;
        } catch {
            /* 不可用 */
        }
        return null;
    }

    mount(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { willReadFrequently: true });
        const base = this.manifest?.[this.baseStateName];
        if (base && base.clips[0]) {
            canvas.width = base.clips[0].frameW;
            canvas.height = base.clips[0].frameH;
        }
        setActiveRenderer(this);
        this.start();
        this.draw();
    }

    setState(state: AvatarState): void {
        if (!this.manifest) return;
        // 该形象没有此状态则用基础态兜底（如切换后缺少某动作的素材）
        const target: AvatarState = this.manifest[state]
            ? state
            : this.baseStateName;
        this.state = target;
        const def = this.manifest[target];
        // 多变体：随机选一段播放（每次触发都可能有不同表现，更生动）
        this.clipIndex =
            def.clips.length > 1
                ? Math.floor(Math.random() * def.clips.length)
                : 0;
        this.frame = 0;
        this.acc = 0;
    }

    setScale(scale: number): void {
        this.scale = scale > 0 ? scale : 1;
        this.draw();
    }

    // 返回各状态动画时长（ms）：一次性动画 = 所有变体中最长的 frames/fps，loop 状态 = 0。
    // 取最长以保证"播完回 idle"计时器不会提前截断较短的变体。供调度器精确衔接。
    getStateDurations(): Partial<Record<AvatarState, number>> {
        const map: Partial<Record<AvatarState, number>> = {};
        if (this.manifest) {
            (Object.keys(this.manifest) as AvatarState[]).forEach((s) => {
                const def = this.manifest![s];
                map[s] = def.loop
                    ? 0
                    : Math.max(
                          ...def.clips.map((c) =>
                              Math.round((c.frames / c.fps) * 1000),
                          ),
                      );
            });
        }
        return map;
    }

    destroy(): void {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.ctx = null;
        this.canvas = null;
        this.sheets = {};
        this.manifest = null;
        if (getActiveRenderer() === this) setActiveRenderer(null);
    }

    // 命中测试：画布内部像素坐标 (x, y) 处是否"实心"（alpha >= 阈值）。
    // 直接读取「正在显示的画布」(this.ctx / this.canvas) 的像素——这只画布一定每帧都被绘制，
    // 角色像素必然存在，比维护一份离屏掩膜画布可靠得多（掩膜没画上时整张透明会导致永久点穿）。
    // 跨域污染（如 pet:// 图源）时 getImageData 会抛错，catch 中保守返回 true（实心、可拖动），
    // 避免误把桌宠整块点穿；HTTP 同域图源不会污染，可正常逐像素判定。
    hitTest(x: number, y: number): boolean {
        const ctx = this.ctx;
        const canvas = this.canvas;
        if (!ctx || !canvas) return true;
        const w = canvas.width;
        const h = canvas.height;
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        try {
            const data = ctx.getImageData(
                Math.floor(x),
                Math.floor(y),
                1,
                1,
            ).data;
            return data[3] >= ALPHA_THRESHOLD;
        } catch {
            return true;
        }
    }

    private start(): void {
        if (this.running) return;
        this.running = true;
        this.last = performance.now();
        const tick = (now: number) => {
            if (!this.running) return;
            const def: SpriteStateDef | undefined = this.manifest?.[this.state];
            if (def) {
                const clip = def.clips[this.clipIndex];
                const dt = now - this.last;
                this.last = now;
                this.acc += dt;
                const frameDur = 1000 / clip.fps;
                let changed = false;
                while (this.acc >= frameDur) {
                    this.acc -= frameDur;
                    this.frame += 1;
                    changed = true;
                    if (this.frame >= clip.frames) {
                        if (def.loop) {
                            this.frame = 0;
                        } else {
                            // 一次性动作播完：平滑回到基础态
                            this.state = this.baseStateName;
                            this.frame = 0;
                            this.acc = 0;
                            break;
                        }
                    }
                }
                if (changed) this.draw();
            }
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    private draw(): void {
        if (!this.ctx || !this.canvas || !this.manifest) return;
        const def: SpriteStateDef | undefined = this.manifest[this.state];
        if (!def) return;
        const clip = def.clips[this.clipIndex];
        const img = this.sheets[this.state]?.[this.clipIndex] ?? null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (clip && img && img.complete && img.naturalWidth > 0) {
            const sx = this.frame * clip.frameW;
            this.ctx.drawImage(
                img,
                sx,
                0,
                clip.frameW,
                clip.frameH,
                0,
                0,
                clip.frameW,
                clip.frameH,
            );
        }
    }
}
