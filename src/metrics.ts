/**
 * OBS-02 — 进程内指标注册表（延迟 / 重试 / 成本）。
 *
 * 设计选择与 OBS-01 同款：**不引入 prom-client**。宿主的 `/metrics` 一直是
 * 手写文本（`ui/server.ts` 的 `prometheusMetrics()`），加一个依赖只会多一份
 * 与那段手写输出漂移的事实源。这里补的是它唯一缺的东西——直方图。
 *
 * 三条不变量：
 * - **序列可预注册**。`rate()` / `histogram_quantile()` 有首抓盲区：序列第一次
 *   出现时以非零值出生，两次抓取之间的那一波增量看不见（评审 2026-08-24 对
 *   5xx 序列的同一条结论）。凡是被告警引用的指标，标签组合必须在开机时就以 0 出生。
 * - **测不到就不记，不许补零**。TTFT 只在真的收到过流式增量时才落桶；
 *   不流式的 wire 上这条曲线是空的，而不是一条假的 0（"没有读数"与"读数为零"
 *   是两件事——台账的 `fallbackChain: null` 是同一条纪律）。
 * - **进程全局**。`src/loop.ts` 在 CLI 与 Web 两个宿主里都跑，指标必须与宿主
 *   解耦：loop 往全局注册表写，Web 的 `/metrics` 从全局注册表读。CLI 进程里
 *   没有 `/metrics` 端点，写进去只是无人读取，不是错误。
 */
import type { ModelClient } from "./types.js";

export type Labels = Record<string, string>;

/** 指标里的角色口径，与 `ui/server.ts` 的 `TOKEN_ROLES` 同一套词汇（跨指标可 join） */
export const METRIC_ROLES = ["execution", "verification", "planner", "vision"] as const;
export type MetricRole = (typeof METRIC_ROLES)[number];

/** 人工 / 排队等待的种类。固定枚举——标签基数不许由外部输入决定 */
export const WAIT_KINDS = ["approval", "question", "plan_gate", "resource"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function seriesKey(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((n) => `${n}=${labels[n] ?? ""}`).join("\u0000");
}

function labelText(labelNames: readonly string[], labels: Labels, extra?: [string, string]): string {
  const pairs = labelNames.map((n) => `${n}="${escapeLabelValue(labels[n] ?? "")}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length > 0 ? `{${pairs.join(",")}}` : "";
}

/** 浮点样本的文本形态：整数照原样，小数保 6 位有效（成本是 1e-6 量级） */
function sampleValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(9)));
}

export interface InstrumentConfig {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export interface HistogramConfig extends InstrumentConfig {
  /** 上界，秒。升序；`+Inf` 隐含，不用写 */
  buckets: readonly number[];
}

interface HistogramSeries {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];
  readonly labelNames: readonly string[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(cfg: HistogramConfig) {
    this.name = cfg.name;
    this.help = cfg.help;
    this.labelNames = cfg.labelNames ?? [];
    this.buckets = [...cfg.buckets].sort((a, b) => a - b);
  }

  private slot(labels: Labels): HistogramSeries {
    const key = seriesKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  /** 让这组标签以全 0 出生（首抓盲区）。已有观测时不动它 */
  preregister(labels: Labels): void {
    this.slot(labels);
  }

  /**
   * 落一个样本，单位秒。非有限值 / 负值一律丢弃——时钟回拨或未初始化的计时器
   * 会把 `NaN` 塞进 `_sum`，之后整条曲线永久报废（Prometheus 不会告诉你）。
   */
  observe(labels: Labels, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const s = this.slot(labels);
    s.count += 1;
    s.sum += seconds;
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]!) s.counts[i]! += 1;
    }
  }

  /** 测试用读数：没有这组标签返回 null（"没序列"与"零次观测"要分得开） */
  snapshot(labels: Labels = {}): { count: number; sum: number } | null {
    const s = this.series.get(seriesKey(this.labelNames, labels));
    return s ? { count: s.count, sum: s.sum } : null;
  }

  render(): string[] {
    if (this.series.size === 0) return [];
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const key of [...this.series.keys()].sort()) {
      const s = this.series.get(key)!;
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = s.counts[i]!;
        out.push(
          `${this.name}_bucket${labelText(this.labelNames, s.labels, ["le", String(this.buckets[i])])} ${cumulative}`,
        );
      }
      out.push(`${this.name}_bucket${labelText(this.labelNames, s.labels, ["le", "+Inf"])} ${s.count}`);
      out.push(`${this.name}_sum${labelText(this.labelNames, s.labels)} ${sampleValue(s.sum)}`);
      out.push(`${this.name}_count${labelText(this.labelNames, s.labels)} ${s.count}`);
    }
    return out;
  }

  reset(): void {
    this.series.clear();
  }
}

export class Counter {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(cfg: InstrumentConfig) {
    this.name = cfg.name;
    this.help = cfg.help;
    this.labelNames = cfg.labelNames ?? [];
  }

  private slot(labels: Labels): { labels: Labels; value: number } {
    const key = seriesKey(this.labelNames, labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, value: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  preregister(labels: Labels): void {
    this.slot(labels);
  }

  /** 计数器只增不减；负数与非有限值丢弃（同 Histogram 的理由） */
  inc(labels: Labels, delta = 1): void {
    if (!Number.isFinite(delta) || delta < 0) return;
    this.slot(labels).value += delta;
  }

  get(labels: Labels = {}): number | null {
    return this.series.get(seriesKey(this.labelNames, labels))?.value ?? null;
  }

  render(): string[] {
    if (this.series.size === 0) return [];
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const key of [...this.series.keys()].sort()) {
      const s = this.series.get(key)!;
      out.push(`${this.name}${labelText(this.labelNames, s.labels)} ${sampleValue(s.value)}`);
    }
    return out;
  }

  reset(): void {
    this.series.clear();
  }
}

export class MetricsRegistry {
  private readonly instruments: Array<Histogram | Counter> = [];

  histogram(cfg: HistogramConfig): Histogram {
    const h = new Histogram(cfg);
    this.instruments.push(h);
    return h;
  }

  counter(cfg: InstrumentConfig): Counter {
    const c = new Counter(cfg);
    this.instruments.push(c);
    return c;
  }

  /** 文本暴露格式的若干行（不含末尾换行；由 `/metrics` 组装者负责） */
  renderLines(): string[] {
    return this.instruments.flatMap((i) => i.render());
  }

  reset(): void {
    for (const i of this.instruments) i.reset();
  }
}

export const obsRegistry = new MetricsRegistry();

/**
 * TTFT——请求发出到**第一个流式增量**抵达。
 *
 * 桶按"人还愿意盯着看"的量级排：4 秒以内是快，30 秒以上要解释。
 */
export const modelTtftSeconds = obsRegistry.histogram({
  name: "agent_harness_model_ttft_seconds",
  help: "Time from model request send to first streamed delta (only recorded when the wire actually streams)",
  labelNames: ["role", "model"],
  buckets: [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120],
});

/**
 * 整次模型调用的墙钟。**成败都记**——"模型调用要多久"这个问题包含超时的那些次，
 * 把失败剔掉会让 p99 在端点变慢时反而变好看。失败的**次数**另有重试 / 错误计数器。
 */
export const modelCallSeconds = obsRegistry.histogram({
  name: "agent_harness_model_call_seconds",
  help: "Wall time of one model call, success or failure (retries inside the SDK are included)",
  labelNames: ["role", "model"],
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160, 320, 640],
});

/**
 * 工具执行时长（`tool_call` → `tool_result`）。
 *
 * **口径警告**：`ExecutedTool.durationMs` 从 `executeSingle` 进门算起，而审批门
 * 挂在它里面——需要人点"允许"的那次调用，这里量到的是「人的等待 + 真正执行」。
 * 要拆开就看 `agent_harness_wait_seconds{kind="approval"}`，两者相减即机器时间。
 * 不在这里悄悄扣掉：那需要改工具执行层的计时口径，而它同时是台账与界面的读数源。
 */
export const toolSeconds = obsRegistry.histogram({
  name: "agent_harness_tool_seconds",
  help: "Tool execution wall time from tool_call to tool_result (includes approval wait when the tool needed approval)",
  labelNames: ["tool"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
});

/** 人工 / 排队等待。桶按分钟量级排——这条曲线的问题从来不是毫秒 */
export const waitSeconds = obsRegistry.histogram({
  name: "agent_harness_wait_seconds",
  help: "Human or queue wait before a run can proceed (approval, clarifying question, plan gate, exclusive resource)",
  labelNames: ["kind"],
  buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600],
});

/**
 * 同轮瞬时重试次数，按错误类分。
 *
 * 与 `agent_harness_runs_finished_total{outcome="error"}` 不重复：那个是 run 级
 * 终局，这个是**轮内**自愈——端点抖动会在它上面先亮，而 run 仍然成功。
 */
export const modelRetriesTotal = obsRegistry.counter({
  name: "agent_harness_model_retries_total",
  help: "In-turn transient model retries by error class",
  labelNames: ["reason"],
});

/**
 * 终止性模型错误（重试耗尽 / 不可重试），按错误类分。
 * 与重试计数分开：一个是"抖了一下自己好了"，一个是"这一段死在这儿了"。
 */
export const modelErrorsTotal = obsRegistry.counter({
  name: "agent_harness_model_errors_total",
  help: "Terminal model errors by class (retries exhausted or non-retryable)",
  labelNames: ["reason"],
});

/**
 * USD 成本。**只有单价已登记时才累加**——未登记的模型不落这条曲线，
 * 也绝不按 0 计（按 0 计等于告诉运维"这个模型不花钱"，是最坏的一种假读数）。
 * 未登记的量走 `agent_harness_cost_unpriced_tokens_total`，两条并读才是全貌。
 */
export const costUsdTotal = obsRegistry.counter({
  name: "agent_harness_cost_usd_total",
  help: "Attributed USD spend for calls whose model has a registered price",
  labelNames: ["role", "provider", "model"],
});

/** 单价未登记而无法折算的 token 量（非 cache_read 口径，与日预算同） */
export const costUnpricedTokensTotal = obsRegistry.counter({
  name: "agent_harness_cost_unpriced_tokens_total",
  help: "Tokens that could not be priced because the model has no registered price",
  labelNames: ["role", "provider", "model"],
});

/** 测试用：全部 OBS-02 仪器归零（进程全局状态，跨用例会累加） */
export function resetObservabilityMetrics(): void {
  obsRegistry.reset();
}

// ── 观测入口（调用点读起来像句人话，也便于变异验证定位）────────────────

export function observeToolSeconds(tool: string, durationMs: number): void {
  toolSeconds.observe({ tool }, durationMs / 1000);
}

export function observeWaitSeconds(kind: WaitKind, durationMs: number): void {
  waitSeconds.observe({ kind }, durationMs / 1000);
}

export function countModelRetry(reason: string): void {
  modelRetriesTotal.inc({ reason });
}

export function countModelError(reason: string): void {
  modelErrorsTotal.inc({ reason });
}

/**
 * 开机预注册：被告警引用的序列必须在第一次事件之前就存在（首抓盲区）。
 * 只注册**确定会用到**的组合——把全模型全角色笛卡尔积铺开只会污染基数。
 */
export function preregisterObservability(roles: Array<{ role: MetricRole; model: string }>): void {
  for (const { role, model } of roles) {
    modelTtftSeconds.preregister({ role, model });
    modelCallSeconds.preregister({ role, model });
  }
  for (const kind of WAIT_KINDS) waitSeconds.preregister({ kind });
}

/**
 * 把任意 ModelClient 包成"顺手量 TTFT 与整次时长"的版本。
 *
 * 为什么是装饰器而不是改两个 wire 客户端：两条 wire（Anthropic 流 / OpenAI SSE）
 * 里 TTFT 的判据是同一件事——`onDelta` 第一次被调用。写在装饰器里，两条 wire
 * 自动都有，而且降级链、计量层换了顺序也不会漏。
 *
 * **自带 onDelta**：调用方没传时也要传我们自己的，否则 `AnthropicModelClient`
 * 的 `if (onDelta)` 会整个跳过订阅，TTFT 永远测不到。
 * 装饰器契约同 `meterModelClient`：三个参数原样透传，不许收窄。
 */
export function instrumentModelClient(
  client: ModelClient,
  ctx: { role: MetricRole; model: string; now?: () => number },
): ModelClient {
  const now = ctx.now ?? (() => Date.now());
  const labels = { role: ctx.role, model: ctx.model };
  return {
    send: async (req, onDelta, signal) => {
      const t0 = now();
      let firstDeltaAt: number | null = null;
      const observeDelta = (d: Parameters<NonNullable<typeof onDelta>>[0]): void => {
        // 只认第一次：每个 delta 都记就变成了"平均分片间隔"，不是 TTFT
        if (firstDeltaAt === null) firstDeltaAt = now();
        onDelta?.(d);
      };
      try {
        return await client.send(req, observeDelta, signal);
      } finally {
        modelCallSeconds.observe(labels, (now() - t0) / 1000);
        // 没流过就没有 TTFT。补一个 0 或补一个"整次时长"都是编数据
        if (firstDeltaAt !== null) modelTtftSeconds.observe(labels, (firstDeltaAt - t0) / 1000);
      }
    },
  };
}
