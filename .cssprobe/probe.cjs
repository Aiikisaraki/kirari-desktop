// 无头 Electron 渲染探针：渲染真实 DOM 结构 + 真实 settings.css，
// 截图 + dump computed style。用途：不依赖用户截图，自己验证 CSS 选择器是否命中。
//
// 沙盒适配踩坑记录：
//  1. 环境有 ELECTRON_RUN_AS_NODE=1 → 必须 `env -u ELECTRON_RUN_AS_NODE` 启动
//  2. 渲染/GPU 子进程被沙盒杀 → 必须 --no-sandbox（single-process 会崩，别用）
//  3. file:// 加载被拦 → 改 about:blank + document.write，CSS 由 Node 读文件内联
//  4. 重复导航 about:blank 会 reject → catch 忽略
//  5. 多次 new BrowserWindow + destroy 不稳 → 单窗口 setContentSize 切换视口
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const OUT = __dirname;
const ROOT = path.resolve(__dirname, "..");

const css = [
  path.join(ROOT, "src/style.css"),
  path.join(ROOT, "src/components/settings/settings.css"),
]
  .map((p) => fs.readFileSync(p, "utf8"))
  .join("\n");

const body = fs.readFileSync(path.join(__dirname, "harness.html"), "utf8");

const buildHtml = (mode) =>
  body
    .replace(/<link[^>]*stylesheet[^>]*>/g, "")
    .replace("/*__CSS__*/", css)
    .replace("__MODE__", mode);

const CASES = [
  { name: "desktop", width: 980, height: 900, mode: "desktop" },
  { name: "mobile", width: 600, height: 1000, mode: "mobile" },
];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const log = (...a) => console.error("[probe]", ...a);

async function run() {
  const win = new BrowserWindow({
    width: CASES[0].width,
    height: CASES[0].height,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadURL("about:blank").catch(() => {});

  const report = {};
  for (const c of CASES) {
    log("case", c.name);
    win.setContentSize(c.width, c.height);
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(
      `document.open();document.write(${JSON.stringify(buildHtml(c.mode))});document.close();true;`,
    );
    await new Promise((r) => setTimeout(r, 800));
    report[c.name] = await win.webContents.executeJavaScript("window.__probe()");
    log("  probed, capturing...");
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${c.name}.png`), img.toPNG());
    log("  saved", `${c.name}.png`);
  }

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("PROBE_OK");
  win.destroy();
  app.quit();
}

app.whenReady().then(() =>
  run().catch((e) => {
    console.error("PROBE_ERROR", e);
    app.exit(1);
  }),
);
