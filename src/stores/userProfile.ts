import { defineStore } from "pinia";
import { ref } from "vue";

// 用户（聊天中与桌宠对话的一方）自己的头像。
// 头像完全存储在本地（userData/user-avatar/，经 useravatar:// 协议加载），不上传任何服务器。
// 选中图片由主进程复制到本地并持久化到 pet-client.config.json。

type ElectronApi = {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
  };
};

function getWindow() {
  return window as unknown as {
    windowApi?: {
      getUserAvatar?: () => Promise<string | null>;
      pickUserAvatar?: () => Promise<string | null>;
      clearUserAvatar?: () => Promise<void>;
      onUserAvatarChanged?: (cb: (url: string | null) => void) => void;
    };
    require?: (mod: string) => ElectronApi;
  };
}

export const useUserProfileStore = defineStore("userProfile", () => {
  // 当前用户头像地址（useravatar://...），未设置时为 null（渲染层回退到渐变占位）。
  const avatar = ref<string | null>(null);
  const ready = ref(false);
  const lastError = ref("");

  async function init() {
    const w = getWindow();
    lastError.value = "";
    try {
      const v = w.windowApi?.getUserAvatar
        ? await w.windowApi.getUserAvatar()
        : w.require
          ? await w.require("electron").ipcRenderer.invoke("user-avatar:get")
          : null;
      avatar.value = (v as string) || null;
    } catch (e) {
      console.warn("[userProfile] 读取头像失败:", e);
      avatar.value = null;
    }
    ready.value = true;
  }

  // 选择图片：主进程弹文件框 → 复制到本地 → 持久化 → 返回协议地址。
  async function pickAvatar(): Promise<string | null> {
    const w = getWindow();
    lastError.value = "";
    try {
      const v = w.windowApi?.pickUserAvatar
        ? await w.windowApi.pickUserAvatar()
        : w.require
          ? await w.require("electron").ipcRenderer.invoke("user-avatar:pick")
          : null;
      const url = (v as string) || null;
      if (url) avatar.value = url;
      return url;
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : "设置头像失败";
      return null;
    }
  }

  // 移除头像：主进程删除本地文件并清除配置。
  async function clearAvatar(): Promise<void> {
    const w = getWindow();
    lastError.value = "";
    try {
      if (w.windowApi?.clearUserAvatar) await w.windowApi.clearUserAvatar();
      else if (w.require) await w.require("electron").ipcRenderer.invoke("user-avatar:clear");
      avatar.value = null;
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : "移除头像失败";
    }
  }

  // 跨窗口同步：主进程广播变更时实时更新（设置页改了，聊天窗口即时生效）。
  try {
    const w = getWindow();
    const handler = (url: string | null) => {
      avatar.value = url || null;
    };
    if (w.windowApi?.onUserAvatarChanged) {
      w.windowApi.onUserAvatarChanged(handler);
    } else if (w.require) {
      w.require("electron").ipcRenderer.on("user-avatar:changed", (_e: unknown, url: unknown) =>
        handler((url as string) || null),
      );
    }
  } catch {
    /* 订阅失败不影响初始读取 */
  }

  return { avatar, ready, lastError, init, pickAvatar, clearAvatar };
});
