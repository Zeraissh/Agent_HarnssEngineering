/**
 * 事件批处理调度器（V-10）。
 *
 * 每条 SSE 事件立刻 reduce + 渲染一次，在事件密集时就是每秒几十次整页工作。
 * 攒到下一个节拍一次性折叠：reducer 每帧只拷贝一次数组，渲染每帧至多一次。
 *
 * 抽成模块而不是留在 index.html 的内联脚本里，是因为它有一个**实测踩到的坑**
 * 值得常驻回归：标签页隐藏时浏览器不触发 requestAnimationFrame。若只用 rAF，
 * 后台标签页的事件会在队列里无限堆积、界面永不更新——等审批的人一直等不到
 * 卡片出现，等于换个门重新制造了"审批悄悄消失"那类失效。
 */

/**
 * @param {(batches: Map<string, any[]>) => void} onFlush 收到一批事件时调用
 * @param {{
 *   raf?: (cb: () => void) => any,
 *   timer?: (cb: () => void, ms: number) => any,
 *   isHidden?: () => boolean,
 *   hiddenIntervalMs?: number,
 * }} [deps] 供测试注入；生产环境留空即用浏览器实现
 */
export function createBatcher(onFlush, deps = {}) {
  const raf =
    deps.raf ??
    (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
  const timer = deps.timer ?? ((cb, ms) => setTimeout(cb, ms));
  const isHidden =
    deps.isHidden ??
    (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const hiddenIntervalMs = deps.hiddenIntervalMs ?? 250;

  /** @type {Map<string, any[]>} */
  const queues = new Map();
  let scheduled = false;

  function flush() {
    scheduled = false;
    if (queues.size === 0) return;
    const batches = new Map(queues);
    queues.clear();
    onFlush(batches);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // 隐藏时 rAF 不会触发，必须退回定时器；节流放宽即可
    if (!isHidden() && raf) raf(flush);
    else timer(flush, isHidden() ? hiddenIntervalMs : 16);
  }

  return {
    /** 入队一条事件，并确保下一个节拍会折叠 */
    push(key, item) {
      let q = queues.get(key);
      if (!q) {
        q = [];
        queues.set(key, q);
      }
      q.push(item);
      schedule();
    },
    /** 立即折叠（切回前台时用，不必等下一个节拍） */
    flushNow: flush,
    /** 仅供测试与诊断 */
    pending() {
      let n = 0;
      for (const q of queues.values()) n += q.length;
      return n;
    },
  };
}
