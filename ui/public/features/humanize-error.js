/**
 * 非 composer 条上的失败文案：状态码留在 HTTP 头，脸上只留一句人话。
 */

const HTTP_IN_TEXT = /\bHTTP\s*\d{3}\b/gi;

export function humanizeHttpFailure(status, fallback) {
  const n = Number(status);
  if (n === 429) return "前面还有人在交，请等几秒。";
  const raw = fallback == null ? "" : String(fallback).trim();
  const cleaned = raw
    .replace(HTTP_IN_TEXT, "")
    .replace(/领域包/g, "这类任务")
    .replace(/Mutation rate limit exceeded/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[（(]\s*[）)]/g, "")
    .trim();
  if (cleaned) return cleaned;
  if (n === 400) return "这次请求对不上，请改一下再试。";
  if (n === 404) return "找不到这项。";
  if (n === 409) return "现在还不能这样做。";
  return "没做成，请稍后再试。";
}
