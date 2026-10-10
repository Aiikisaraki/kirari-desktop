// 渲染进程拿到的 Electron IPC 桥（nodeIntegration 模式下 window.require('electron')）。
//
// 这个全局声明全项目只能有一份：此前 PetStage.vue 与 useChatSocket.ts 各自
// `declare global` 了一份 Window.require，两边类型不一致 → TS2717（同名属性
// 后续声明必须同类型），并且先声明的那份会赢，导致 PetStage 里的 ipcRenderer
// 被套上 useChatSocket 的窄 channel 联合类型，报出一串「channel 不在联合里」。
// 统一收敛到这里，各业务文件再按需收窄自己的 channel 联合。

export interface BridgeIpcRenderer {
    send(channel: string, ...args: unknown[]): void;
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: unknown[]) => void): void;
    off(channel: string, listener: (...args: unknown[]) => void): void;
}

declare global {
    interface Window {
        require?: (module: "electron") => { ipcRenderer: BridgeIpcRenderer };
    }
}
