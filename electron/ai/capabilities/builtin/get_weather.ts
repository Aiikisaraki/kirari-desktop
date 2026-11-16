// 内置能力：get_weather（阶段 D，一个能力一个文件）。
import { defineCapability, type Capability } from "kirari-agent";
import { getWeather } from "../../tools";

const capability: Capability = defineCapability({
    id: "get_weather",
    name: "get_weather",
    kind: "tool",
    scope: "builtin",
    description: "查询指定地点的实时天气（温度、体感、湿度、风速、天气状况）。当用户问天气时使用。",
    parameters: {
        type: "object",
        properties: {
            location: { type: "string", description: "城市或地点名，如 北京、上海、Tokyo。" },
            units: { type: "string", enum: ["metric", "imperial"], description: "metric=摄氏度，imperial=华氏度。默认 metric。" },
        },
        required: ["location"],
    },
    tags: ["builtin", "preflight"],
});

async function dispatch(args: any): Promise<string> {
    return await getWeather(args || {});
}

export { capability, dispatch };
