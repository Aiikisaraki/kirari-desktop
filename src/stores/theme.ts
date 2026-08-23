import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeName = "aurora-glass" | "pet-pink" | "mint-soft" | "lavender-mist";

export interface ThemeDef {
  id: ThemeName;
  label: string;
  sub: string;
}

// 主题 = 外观风格（配色/毛玻璃质感），与角色皮肤（形象）完全解耦。
// 「一套皮肤一个头像」的绑定在形象配置（AvatarConfig.chatAvatar）上，见 pet/avatar/builtins。
export const THEMES: ThemeDef[] = [
  { id: "aurora-glass", label: "极光玻璃", sub: "Aurora Glass" },
  { id: "pet-pink", label: "樱粉", sub: "Pet Pink" },
  { id: "mint-soft", label: "薄荷嫩芽", sub: "Mint Soft" },
  { id: "lavender-mist", label: "薰衣草晨雾", sub: "Lavender Mist" },
];

const DEFAULT_THEME: ThemeName = "aurora-glass";
const ALLOWED: ThemeName[] = ["aurora-glass", "pet-pink", "mint-soft", "lavender-mist"];

type ElectronApi = {
  ipcRenderer?: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
};

function getWindow() {
  return window as unknown as {
    windowApi?: {
      getTheme?: () => Promise<unknown>;
      setTheme?: (name: string) => Promise<unknown>;
      onThemeChanged?: (cb: (name: string) => void) => void;
    };
    require?: (mod: string) => ElectronApi;
  };
}

// 主题系统：两套主题（aurora-glass 默认、pet-pink 保留）通过 data-theme 切换。
// 持久化在主进程 pet-client.config.json；每个窗口加载 URL 注入 ?theme= 实现首帧无闪烁；
// 切换时主进程广播 theme:changed 同步所有已打开窗口。
export const useThemeStore = defineStore("theme", () => {
  const current = ref<ThemeName>(DEFAULT_THEME);
  const ready = ref(false);

  function normalize(value: unknown): ThemeName {
    return ALLOWED.includes(value as ThemeName) ? (value as ThemeName) : DEFAULT_THEME;
  }

  function apply(name: ThemeName) {
    document.documentElement.setAttribute("data-theme", name);
    current.value = name;
  }

  async function init() {
    const w = getWindow();

    // 1) 同步优先：主进程在加载 URL 里注入了 ?theme=，首帧即生效（无闪烁）
    const fromQuery = new URLSearchParams(window.location.search).get("theme");
    if (fromQuery) apply(normalize(fromQuery));

    // 2) 跨窗口同步：监听主进程广播的主题变更
    try {
      if (w.windowApi?.onThemeChanged) {
        w.windowApi.onThemeChanged((name: string) => apply(normalize(name)));
      } else if (w.require) {
        w.require("electron").ipcRenderer.on("theme:changed", (_e: unknown, name: unknown) =>
          apply(normalize(name))
        );
      }
    } catch {
      /* 控件不可用则忽略 */
    }

    // 3) 异步兜底：从主进程配置读取（覆盖 query 缺省的情况，如开发模式下的桌宠窗口）
    try {
      let saved: unknown = null;
      if (w.windowApi?.getTheme) saved = await w.windowApi.getTheme();
      else if (w.require) saved = await w.require("electron").ipcRenderer.invoke("theme:get");
      if (saved) apply(normalize(saved));
    } catch {
      /* 读取失败则用默认 */
    }

    ready.value = true;
  }

  async function setTheme(name: ThemeName) {
    apply(name);

    const w = getWindow();
    try {
      if (w.windowApi?.setTheme) await w.windowApi.setTheme(name);
      else if (w.require) await w.require("electron").ipcRenderer.invoke("theme:set", name);
    } catch {
      /* 持久化失败则忽略（本窗口已应用） */
    }
  }

  return { current, ready, init, setTheme, apply };
});
