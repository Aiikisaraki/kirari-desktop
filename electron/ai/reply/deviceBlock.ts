// electron/ai/reply/deviceBlock.ts
//
// 组网设备段：告诉模型「现在能操作哪些机器、怎么点名」。
// 与 kirari-core 的 src/services/reply/promptBuilder.js buildDeviceBlock 对称。
//
// 用户 2026-11-20 的规则：
//   「假如主机是在 QQ 或者本机聊天窗口（桌宠）或者网页端聊天窗口（核心），
//     默认情况下操作主机下的 mcp 和 skill。如果点明了某个叶子节点或者叶子节点的
//     别名，就操作那个叶子节点。如果请求来自某个叶子节点，那也默认操作自己这个
//     叶子节点。」
//
// 这段只让模型**知道**有这回事和点名的语法；"默认在哪跑"由 services/toolRouting
// 在服务端判定（不靠模型自觉），模型只在确实要换机器时才显式点名。

export type DeviceBrief = { deviceId: string; name: string; online: boolean };

/**
 * @param devices 可用叶子（主机视角）
 * @param selfDeviceId 本次请求来源设备（叶子自己提问时才有）
 * @param selfDeviceName 来源设备名
 * @returns 拼进 system 的段落；单机安装返回空串（不污染提示词）
 */
export function buildDeviceBlock({
    devices = [],
    selfDeviceId = "",
    selfDeviceName = "",
}: {
    devices?: DeviceBrief[];
    selfDeviceId?: string;
    selfDeviceName?: string;
} = {}): string {
    const list = Array.isArray(devices) ? devices : [];
    const fromLeaf = !!selfDeviceId;
    if (!list.length && !fromLeaf) return "";

    const lines: string[] = ["\n\n【设备与工具执行位置】"];
    if (fromLeaf) {
        lines.push(
            `这次请求来自「${selfDeviceName || selfDeviceId.slice(0, 8)}」这台设备。` +
                "你不特别说明时，MCP 与 skill 都在这台设备上执行（那是它自己的机器）。",
        );
    } else {
        lines.push(
            "这次请求来自主机本体（本机聊天窗口 / QQ / 网页端）。" +
                "你不特别说明时，MCP 与 skill 都在主机自己身上执行。",
        );
    }

    if (list.length) {
        const shown = list.map((d) => `- ${d.name}（${d.online ? "在线" : "离线"}）`).join("\n");
        lines.push(`\n组网里还有这些设备，可以把工具调用指到其中某一台：\n${shown}`);
        lines.push(
            "\n要指定设备时，把设备名或它的别名写在工具名前面，格式是：\n" +
                "  @device:<设备名> <原来的工具名>\n" +
                "例如想在那台机器的文件系统上读文件，就用 @device:书房的电脑 read_file；" +
                "设备名可以只写能唯一认出来的部分（比如「书房」），大小写无所谓。",
        );
        lines.push(
            "注意：" +
                "① 只在**确实需要换机器**时才加这个前缀；不加就在上面说的默认设备上执行。" +
                "② 如果我说了要某台机器但你没找到这台设备，工具结果里会明确告诉你没找到，" +
                "你要把这件事如实说出来，不要假装在别处查过。",
        );
    } else {
        lines.push("\n（当前没有其它在线设备，工具都在上面说的那台机器上执行。）");
    }
    return lines.join("");
}
