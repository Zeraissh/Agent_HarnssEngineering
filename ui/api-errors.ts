/**
 * 给浏览器看的准入失败文案。状态码留在 HTTP 头，正文不要再写 HTTP / 领域包 / Prototype。
 */

const HTTP_STATUS_IN_TEXT = /HTTP\s*[0-9]{3}/gi;

export function toBrowserApiError(raw: string): string {
  let text = String(raw ?? "");
  if (/mutation rate limit|rate limit exceeded/i.test(text)) {
    return "前面还有人在交，请等几秒。";
  }
  text = text.replace(HTTP_STATUS_IN_TEXT, "");
  text = text.replace(/\bHTTP\b/gi, "");
  text = text.replace(/领域包/g, "专用工具");
  text = text.replace(/Prototype/g, "原型");
  text = text.replace(/[ \t]{2,}/g, " ").replace(/^[：:\s,，]+|[：:\s,，]+$/g, "").trim();
  return text || "这次没发出去，请换个说法再试。";
}

export function sanitizeAdmissionPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...(payload as Record<string, unknown>) };
  if (typeof next.error === "string") next.error = toBrowserApiError(next.error);
  if (typeof next.message === "string") next.message = toBrowserApiError(next.message);
  return next;
}
