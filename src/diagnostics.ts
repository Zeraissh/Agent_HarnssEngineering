/**
 * 缓存诊断：回答"这两次请求的缓存为什么没命中"。
 * 缓存是前缀匹配（tools → system → messages），本工具按同样顺序找出
 * 第一处分歧 —— 分歧点之后的一切缓存都会失效。
 */
import type { ModelRequest } from "./types.js";

export interface PrefixDivergence {
  /** none = 两次请求前缀完全一致（缓存未命中的原因不在请求体，查 TTL/模型/最小长度） */
  tier: "tools" | "system" | "messages" | "none";
  /** 分歧所在 tier 内的索引（tools/messages 为条目下标，system 为块下标） */
  index: number;
  detail: string;
}

export function diffRenderedRequests(a: ModelRequest, b: ModelRequest): PrefixDivergence {
  // tools 渲染在最前：任何差异使全部缓存失效
  const toolsMax = Math.max(a.tools.length, b.tools.length);
  for (let i = 0; i < toolsMax; i++) {
    const ta = a.tools[i];
    const tb = b.tools[i];
    if (JSON.stringify(ta) !== JSON.stringify(tb)) {
      return {
        tier: "tools",
        index: i,
        detail: `tools[${i}] 不一致（${ta?.name ?? "缺失"} vs ${tb?.name ?? "缺失"}）—— 工具增删/改序/改描述会使全部缓存失效`,
      };
    }
  }

  const sysMax = Math.max(a.system.length, b.system.length);
  for (let i = 0; i < sysMax; i++) {
    if (JSON.stringify(a.system[i]) !== JSON.stringify(b.system[i])) {
      const preview = firstDiffPreview(a.system[i]?.text ?? "", b.system[i]?.text ?? "");
      return {
        tier: "system",
        index: i,
        detail: `system[${i}] 不一致${preview} —— 检查是否有时间戳/会话 ID 等易变内容混入 system prompt`,
      };
    }
  }

  const msgMax = Math.max(a.messages.length, b.messages.length);
  for (let i = 0; i < msgMax; i++) {
    if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) {
      return {
        tier: "messages",
        index: i,
        detail: `messages[${i}] 不一致（role=${a.messages[i]?.role ?? "缺失"}/${b.messages[i]?.role ?? "缺失"}）—— 此前的前缀仍可命中，之后全部失效`,
      };
    }
  }

  return {
    tier: "none",
    index: -1,
    detail:
      "两次请求前缀完全一致。若仍未命中：检查是否换了模型（缓存按模型隔离）、是否超过 5 分钟 TTL、前缀是否短于该模型的最小可缓存长度",
  };
}

function firstDiffPreview(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const from = Math.max(0, i - 15);
      return `（首个差异在第 ${i} 字符附近："…${a.slice(from, i + 15)}…" vs "…${b.slice(from, i + 15)}…"）`;
    }
  }
  return a.length !== b.length ? `（长度不同：${a.length} vs ${b.length}）` : "";
}
