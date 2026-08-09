// 统一「带超时」的 HTTP 请求封装。
// 此前项目里所有 fetch 都没有超时：后端端口能连但处理函数挂死、或网络处于半开连接时，
// 请求会无限挂起——表现就是前端一直转圈、按钮禁用、只能重启程序。
// 这里统一加 AbortController 超时，并把超时转成清晰的错误信息供上层提示。

export const DEFAULT_HTTP_TIMEOUT_MS = 12000;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`请求超时：后端在 ${Math.round(timeoutMs / 1000)} 秒内未回应`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
