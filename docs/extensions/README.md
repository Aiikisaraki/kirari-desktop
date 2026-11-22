# 外部扩展包（extension pack）接口

> 目标：把「外接能力」做成一层插槽。语音只是第一个使用者；以后加本地 ASR、
> 翻译、画图引擎、新的协议通道，都走同一套契约，**宿主本体不再改动**。

## 1. 一条硬规则：不装扩展包 = 行为完全不变

宿主里所有消费点都必须写成"取不到就走原路"：

    const tts = getTtsService();      // 没有扩展包时是 null
    if (!tts) return null;            // 走原来的纯文本路径

这条规则由 \`voiceOutgoing.spec\` 与 \`extensions.spec\` 守着：
- \`ServiceRegistry.get()\` 空表时返回 \`null\`
- \`buildVoiceOutgoing()\` 在没有任何 TTS 服务时**同步**返回 \`null\`

所以主程序里接线只有一处 await，没有分支判断，也不会因为扩展包缺失而多等。

## 2. 为什么扩展包是独立进程

| 理由 | 说明 |
| --- | --- |
| 依赖冲突 | onnxruntime / torch / ffmpeg 与 Electron 的 ABI 不兼容 |
| 打包约束 | 安装包内是只读 asar，模型必须放 userData |
| 崩溃隔离 | 语音引擎吃满内存不该把桌宠一起带走 |
| 独立升级 | 语音迭代频率远高于本体 |

## 3. 目录与清单

    <userData>/extensions/<pack-id>/
      manifest.json
      bin/server.cjs        ← engine.command 指向它
      models/...            ← 大模型放这里，按需下载

\`manifest.json\`：

    {
      "id": "com.example.local-tts",
      "name": "本地语音合成",
      "version": "1.0.0",
      "apiVersion": 1,
      "description": "离线 TTS，可选音色",
      "engine": {
        "runtime": "sidecar",
        "protocol": "jsonrpc-stdio@1",
        "command": "bin/server.cjs",
        "args": [],
        "requestTimeoutMs": 20000,
        "idleTimeoutMs": 300000
      },
      "contributions": [
        { "type": "service", "id": "speech.tts", "title": "语音合成" }
      ],
      "permissions": ["filesystem:models"],
      "resources": { "minRamMb": 512, "gpuRecommended": false }
    }

校验规则（\`manifest.ts\`）：
- \`id\`：反向域名小写；\`version\`：semver；\`apiVersion\` 不得高于宿主
- \`engine.command\`：**只允许包内相对路径**，绝对路径与 \`..\` 直接拒绝
- \`engine.env\`：会过滤 \`PATH\` / \`NODE_OPTIONS\` / \`ELECTRON_*\` 等危险键
- \`permissions\`：白名单为 network / filesystem:models / filesystem:data / microphone / camera
- 不认识的 \`contributions[].type\` **忽略**，不因此拒绝整包

## 4. 四类贡献

| type | 谁消费 | 用途 |
| --- | --- | --- |
| \`service\` | 宿主里的对应消费方（如 \`contracts/tts.ts\`） | 提供可调用的能力服务 |
| \`capability\` | \`capabilities/registry\` | 直接变成模型可调用的工具 |
| \`settings\` | 设置界面 | 扩展包自己的配置项 |
| \`channel\` | adapter 层 | 新的对端接入方式 |

## 5. 协议：宿主只认两个动词

宿主 → 扩展包（stdio 上的按行 JSON-RPC）：

| method | params | 返回 |
| --- | --- | --- |
| \`host.hello\` | \`{ apiVersion, hostName, hostVersion, userDataDir?, locale? }\` | 任意（忽略） |
| \`host.ping\` | \`null\` | 任意 |
| \`host.dispose\` | \`null\` | 任意 |
| \`service.call\` | \`{ serviceId, method, params: { args: [...] } }\` | 方法返回值 |
| \`capability.call\` | \`{ name, args }\` | 工具结果 |
| \`capability.list\` | \`null\` | \`{ capabilities: [{ name, description?, parameters? }] }\` |

扩展包 → 宿主：

    {"jsonrpc":"2.0","method":"host.event","params":{"type":"speech.tts.progress","payload":{...}}}

**日志必须写 stderr。** 往 stdout 打日志会被宿主当作非法 JSON 丢弃并告警。

## 6. 语音服务契约（第一个使用者）

服务 id：\`speech.tts\`

| method | params.args | 返回 |
| --- | --- | --- |
| \`listVoices\` | \`[]\` | \`{ voices: [{ id, label, language?, styles?, previewUrl? }] }\` |
| \`synthesize\` | \`[{ text, voiceId?, format?, sampleRate?, speed?, emotion? }]\` | \`{ dataUrl, format, durationMs }\` |

\`dataUrl\` 用 \`data:audio/mpeg;base64,...\`：与现有图片内联约定一致，宿主不需要文件落地。

## 7. 最小 sidecar 示例

    // bin/server.cjs
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const req = JSON.parse(line);
      const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      if (req.method === "host.hello") return reply({ ok: true });
      if (req.method === "service.call") {
        const { serviceId, method, params } = req.params;
        if (serviceId === "speech.tts" && method === "listVoices") return reply({ voices: [{ id: "default", label: "默认音色" }] });
        if (serviceId === "speech.tts" && method === "synthesize") {
          // 这里换成真实合成；返回 base64
          return reply({ dataUrl: "data:audio/mpeg;base64,", format: "mp3", durationMs: 1200 });
        }
      }
      reply(null);
    });

## 8. 边界：现阶段不做

- 不做插件市场/自动更新（先人工放置目录）
- 不做签名校验（下一步：manifest 里加 \`sha256\` + 可选的 ed25519 签名）
- 不支持 in-process 扩展（强制 sidecar，避免 ABI 与崩溃耦合）
