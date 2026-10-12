import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AvatarConfig, AvatarMeta, AvatarState, AvatarType } from "../pet/avatar/types";

// 兜底默认值：内置 Kirari 精灵皮肤。聊天头像由皮肤目录的 frames.json.chatAvatar 声明，
// 经 avatar:// 协议对外服务；主进程启动时扫描皮肤并写入真实头像到 config，覆盖此兜底。
const DEFAULT_AVATAR: AvatarConfig = {
  id: "custom-kirari",
  name: "Aki Kirari",
  author: "Aki",
  version: "1.0.0",
  type: "sprite",
  src: "avatar://kirari/frames.json",
};

// require('electron') 拿到的模块一定带 ipcRenderer，这里标成必选；
// 之前写成可选，导致每个 `w.require("electron").ipcRenderer.invoke(...)` 都报 TS2532。
type ElectronApi = {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
};

// 与 electron/preload.ts 暴露的 windowApi 保持一致（方法名缺一个就会报 TS2339）。
function getWindow() {
  return window as unknown as {
    windowApi?: {
      getAvatar?: () => Promise<unknown>;
      getCustomAvatars?: () => Promise<unknown>;
      setAvatar?: (cfg: AvatarConfig) => Promise<unknown>;
      importAvatarFolder?: () => Promise<unknown>;
      importAvatarZip?: () => Promise<unknown>;
      rescanAvatars?: () => Promise<unknown>;
      openAvatarsFolder?: () => Promise<void>;
      onAvatarChanged?: (cb: (payload: unknown) => void) => void;
    };
    require?: (mod: string) => ElectronApi;
  };
}

function normalizeConfig(v: unknown): AvatarConfig {
  if (
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).type &&
    typeof (v as Record<string, unknown>).src === "string"
  ) {
    const raw = v as Record<string, unknown>;
    return {
      id: typeof raw.id === "string" ? raw.id : DEFAULT_AVATAR.id,
      name: typeof raw.name === "string" ? raw.name : DEFAULT_AVATAR.name,
      author: typeof raw.author === "string" ? raw.author : undefined,
      version: typeof raw.version === "string" ? raw.version : undefined,
      type: raw.type as AvatarType,
      src: raw.src as string,
      chatAvatar: typeof raw.chatAvatar === "string" ? raw.chatAvatar : undefined,
      scale: typeof raw.scale === "number" ? raw.scale : undefined,
    };
  }
  return { ...DEFAULT_AVATAR };
}

// 形象系统：当前形象配置 + 当前播放状态 + 可选形象列表。
// 持久化在主进程 pet-client.config.json（avatar + customAvatars）；
// 切换时主进程广播 avatar:changed 同步所有已打开窗口（含 pet 窗口与设置窗口）。
export const useAvatarStore = defineStore("avatar", () => {
  const current = ref<AvatarConfig>({ ...DEFAULT_AVATAR });
  const currentState = ref<AvatarState>("idle");
  const ready = ref(false);
  const customAvatars = ref<AvatarMeta[]>([]);
  // 各状态动画时长（ms）：一次性动画为 frames/fps，loop 状态为 0（持续不自动结束）。
  // 由 PetAvatar 加载 frames.json 后回填，供调度器精确衔接"播完回 idle"。
  const durations = ref<Partial<Record<AvatarState, number>>>({});

  const list = computed<AvatarMeta[]>(() => [...customAvatars.value]);

  function isActive(meta: AvatarMeta): boolean {
    return current.value.type === meta.type && current.value.src === meta.src;
  }

  function apply(cfg: AvatarConfig) {
    current.value = cfg;
    currentState.value = "idle";
  }

  async function init() {
    const w = getWindow();

    // 1) 先读形象列表（确保后续校验时列表已就绪）。
    //    聊天窗口 nodeIntegration:true + contextIsolation:false → contextBridge 不生效，
    //    windowApi 是 undefined，必须走 ipcRenderer 兜底（否则列表读不到，当前形象被误判失效）。
    try {
      let custom: unknown = null;
      if (w.windowApi?.getCustomAvatars) {
        custom = await w.windowApi.getCustomAvatars();
      } else if (w.require) {
        custom = await w.require("electron").ipcRenderer.invoke("avatar:custom-get");
      }
      if (Array.isArray(custom)) customAvatars.value = custom as AvatarMeta[];
    } catch (e) {
      console.warn("[avatar] 读取形象列表失败:", e);
    }

    // 2) 再读持久化的当前形象（同样需要 ipcRenderer 兜底，理由同上——
    //    没有这一步，聊天窗口的当前形象永远停在无头像的默认值上，聊天页只能显示首字母）。
    try {
      let saved: unknown = null;
      if (w.windowApi?.getAvatar) {
        saved = await w.windowApi.getAvatar();
      } else if (w.require) {
        saved = await w.require("electron").ipcRenderer.invoke("avatar:get");
      }
      if (saved) {
        const cfg = normalizeConfig(saved);
        console.log("[avatar] init 读取当前形象:", cfg.id, cfg.name);
        apply(cfg);
      }
    } catch (e) {
      console.warn("[avatar] 读取当前形象失败:", e);
    }

    // 3) 校验当前形象是否仍在列表中：若持久化的 id 已失效（旧数据/皮肤被删），
    // 回退到默认形象或列表第一个，避免设置页下拉框显示空白。
    const allAvatars = list.value;
    const validIds = new Set(allAvatars.map((a) => a.id));
    // AvatarConfig.id 是可选的（老数据可能没有），查表前先兜底成空串。
    if (allAvatars.length > 0 && !validIds.has(current.value.id ?? "")) {
      const fallback =
        allAvatars.find((a) => a.id === DEFAULT_AVATAR.id) ||
        allAvatars[0] ||
        { ...DEFAULT_AVATAR };
      console.warn(
        "[avatar] 当前形象 id",
        current.value.id,
        "不在列表中，回退到:",
        fallback.id,
      );
      apply(fallback);
      try {
        await setAvatar(fallback);
      } catch {
        /* 持久化失败仅影响本次，本窗口已应用 */
      }
    }

    // 4) 跨窗口同步：监听主进程广播的形象变更（含 current + custom 列表）
    try {
      const handler = (payload: unknown) => {
        const p = payload as { current?: AvatarConfig; custom?: AvatarMeta[] };
        if (p?.current) {
          console.log("[avatar] 收到广播 current:", (p.current as AvatarConfig).id);
          apply(normalizeConfig(p.current));
        }
        if (Array.isArray(p?.custom)) customAvatars.value = p.custom;
      };
      if (w.windowApi?.onAvatarChanged) {
        w.windowApi.onAvatarChanged(handler);
      } else if (w.require) {
        w.require("electron").ipcRenderer.on("avatar:changed", handler);
      }
    } catch (e) {
      console.warn("[avatar] 订阅形象变更广播失败:", e);
    }

    ready.value = true;
  }

  async function setAvatar(cfg: AvatarConfig) {
    apply(cfg);
    const w = getWindow();
    // 净化：去掉 Vue Proxy 包装与不可序列化字段，确保能通过 Electron 结构化克隆。
    const plain: AvatarConfig = JSON.parse(JSON.stringify(cfg));
    console.log("[avatar] setAvatar 调用:", plain.id, plain.name);
    try {
      if (w.windowApi?.setAvatar) {
        await w.windowApi.setAvatar(plain);
        console.log("[avatar] setAvatar 持久化成功:", plain.id);
        return;
      }
      if (w.require) {
        await w.require("electron").ipcRenderer.invoke("avatar:set", plain);
        console.log("[avatar] setAvatar 持久化成功:", plain.id);
        return;
      }
      throw new Error("windowApi.setAvatar 不可用");
    } catch (e) {
      console.error("[avatar] setAvatar 持久化失败:", e);
      throw e;
    }
  }

  // 驱动播放状态（语义意图）。idle 为基础态，其他动作播完由渲染器自动回到 idle。
  function setState(s: AvatarState) {
    currentState.value = s;
  }

  // 由 PetAvatar 在加载 frames.json 后回填各状态动画时长（ms）。
  function setDurations(map: Partial<Record<AvatarState, number>>) {
    durations.value = map;
  }

  // 导入自定义精灵形象：弹出目录选择框 → 主进程复制并注册 → 返回 meta → 加入列表并切换。
  async function importAvatarFolder(): Promise<{ ok: boolean; message?: string }> {
    const w = getWindow();
    try {
      let r: unknown = null;
      if (w.windowApi?.importAvatarFolder) r = await w.windowApi.importAvatarFolder();
      else if (w.require) r = await w.require("electron").ipcRenderer.invoke("avatar:import-folder");
      const res = r as { ok: boolean; meta?: AvatarMeta; message?: string };
      if (res?.ok && res.meta) {
        customAvatars.value = [
          ...customAvatars.value.filter((a) => a.id !== res.meta!.id),
          res.meta,
        ];
        await setAvatar(res.meta);
        return { ok: true };
      }
      return { ok: false, message: res?.message || "导入失败" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "导入失败" };
    }
  }

  // 上传形象压缩包：选择 ZIP → 主进程解压到 userData/avatars/<包名>/ → 校验 → 注册并切换。
  async function importAvatarZip(): Promise<{ ok: boolean; message?: string }> {
    const w = getWindow();
    try {
      let r: unknown = null;
      if (w.windowApi?.importAvatarZip) r = await w.windowApi.importAvatarZip();
      else if (w.require) r = await w.require("electron").ipcRenderer.invoke("avatar:import-zip");
      const res = r as { ok: boolean; meta?: AvatarMeta; message?: string };
      if (res?.ok && res.meta) {
        customAvatars.value = [
          ...customAvatars.value.filter((a) => a.id !== res.meta!.id),
          res.meta,
        ];
        await setAvatar(res.meta);
        return { ok: true };
      }
      return { ok: false, message: res?.message || "上传失败" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "上传失败" };
    }
  }

  // 重新扫描 userData/avatars 目录：把用户直接丢进去的形象文件夹注册为可用形象。
  async function rescanAvatars(): Promise<void> {
    const w = getWindow();
    try {
      if (w.windowApi?.rescanAvatars) await w.windowApi.rescanAvatars();
      else if (w.require) await w.require("electron").ipcRenderer.invoke("avatar:rescan");
    } catch {
      /* 控件不可用则忽略 */
    }
  }

  // 打开形象目录，方便用户把自定义形象文件夹放进去。
  async function openAvatarsFolder(): Promise<void> {
    const w = getWindow();
    try {
      if (w.windowApi?.openAvatarsFolder) await w.windowApi.openAvatarsFolder();
      else if (w.require) await w.require("electron").ipcRenderer.invoke("avatar:open-folder");
    } catch {
      /* 控件不可用则忽略 */
    }
  }

  return { current, currentState, ready, customAvatars, durations, list, isActive, init, setAvatar, setState, setDurations, importAvatarFolder, importAvatarZip, rescanAvatars, openAvatarsFolder };
});
