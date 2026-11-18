import fs from "fs";
import path from "path";
import { homePath } from "./kirari-home";

// 主进程日志模块：劫持 console.*，使其同时落盘到 ~/.kirari/logs/app-YYYY-MM-DD.log。
// 这样打包后的 Electron 应用即使没有可见控制台，也能通过日志文件排查问题
// （尤其是后端子进程是否启动、监听哪个端口、报错内容）。保留原始输出以便 DevTools / 终端可见。
let logPath: string | null = null;
let patched = false;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function sink(level: string, args: unknown[]): void {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
  const line = `[${ts}] [${level}] ${args.map(fmt).join(" ")}\n`;
  const f = logPath;
  if (f) {
    try {
      fs.appendFileSync(f, line);
    } catch {
      // 写日志失败不影响主流程
    }
  }
}

function patchConsole(): void {
  if (patched) return;
  patched = true;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  c.log = (...a: unknown[]) => {
    orig.log(...a);
    sink("INFO", a);
  };
  c.info = (...a: unknown[]) => {
    orig.info(...a);
    sink("INFO", a);
  };
  c.warn = (...a: unknown[]) => {
    orig.warn(...a);
    sink("WARN", a);
  };
  c.error = (...a: unknown[]) => {
    orig.error(...a);
    sink("ERROR", a);
  };
}

// 在 app.whenReady() 中尽早调用，初始化日志文件并劫持 console。
// 返回日志文件路径（用于打印到启动横幅 / 托盘菜单打开）。
export function initAppLogger(): string | null {
  try {
    // 日志落数据根（~/.kirari/logs），与核心版同一处，排障时不用两头找。
    const dir = homePath("logs");
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    logPath = path.join(dir, `app-${date}.log`);
  } catch {
    logPath = null;
  }
  if (!patched) patchConsole();
  return logPath;
}

export function getLogPath(): string | null {
  return logPath;
}

// 是否处于调试模式：命令行 --debug 或环境变量 PET_DEBUG=1
export function isDebugMode(): boolean {
  return process.argv.includes("--debug") || process.env.PET_DEBUG === "1";
}
