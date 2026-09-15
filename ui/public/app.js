import { createBatcher } from "./core/batch.js";
import { diffKeyed, signature } from "./core/diff.js";
import { extractLocalPathRef, isLocalPathCandidate, renderMarkdown, renderMarkdownInline } from "./core/markdown.js";
import { artifactRendererKind, parseBrowserUrl } from "./features/artifact-canvas.js";
import {
  patchList,
  appendOnly,
  setText,
  setAttr,
  setClass,
  keepScrollAnchored,
  withFocusPreserved,
} from "./dom/patch.js";
import { formatWorkdirTriggerLabel, parseWorkdirExtrasAttr } from "./features/workdir-picker.js";

// 桶文件转出：现有 import 路径（测试与控制器都从 /app.js 取）保持不变
export { createBatcher, diffKeyed, signature, patchList, appendOnly, setText, setAttr, setClass, keepScrollAnchored, withFocusPreserved };

/**
 * Harness Web UI — 纯函数 reducer + DOM 渲染层。
 *
 * 架构：
 *   reduceEvent(state, sseEvent) → 纯函数，把 SSE 事件流折叠为渲染模型。
 *   DOM 渲染函数惰性引用 window/document，可被 vitest node 环境 import。
 *
 * 导出：
 *   - reduceEvent / createInitialState / markApprovalResolved / expirePendingApprovals
 *   - deriveOverview / deriveLogEntries / toggleEntryCollapsed: 阶段二纯模型
 *   - deriveRunListItems / filterRunsByStatus: R-08 列表元数据与筛选
 *   - renderRunList / renderRunDetail / renderEmptyState: DOM 渲染（浏览器端）
 */

// ---------------------------------------------------------------
// 类型（JSDoc 注释，运行时即对象形状契约）
// ---------------------------------------------------------------

/**
 * @typedef {{
 *   runId: string,
 *   task: string,
 *   status: "running"|"done",
 *   archived: boolean,
 *   verify: boolean,
 *   timeline: TimelineEntry[],
 *   verifierTimeline: TimelineEntry[],
 *   autoAllow: {name:string,inputHash:string|null,inputScope:"exact-input"|"legacy-tool",grantId?:string,boundRunId?:string,expiresAt?:number,maxUses?:number,usedUses?:number,status:"active"|"expired"|"invalidated"|"exhausted"|"not-inherited"|"legacy"}[],
 *   pendingApprovals: PendingApproval[],
 *   verdict: VerdictModel|null,
 *   usage: UsageModel|null,
 *   error: string|null,
 *   stopReason: string|null,
 *   completion: {status:string,summary:string,artifacts:string[],verification:string[],assumptions:string[],blockers:string[]}|null,
 *   runBudget: {maxTurns?:number,maxTokens?:number,usedTurns:number,usedTokens:number}|null,
 *   lineage: {parentRunId:string,rootRunId:string,boundary:string,inheritedBudget:object|null,reset:string[]}|null,
 *   lastSeq: number,
 *   runEnd: {outcome:string, mainStopReason?:string, finishedAt:number}|null
 * }} RunState
 *
 * @typedef {{
 *   seq: number,
 *   source: string,
 *   type: string,
 *   turn?: number,
 *   name?: string,
 *   toolUseId?: string,
 *   input?: unknown,
 *   resultContent?: string,
 *   resultIsError?: boolean,
 *   durationMs?: number,
 *   text?: string,
 *   attempt?: number,
 *   reason?: string,
 *   action?: string,
 *   detail?: string,
 *   extraTurns?: number,
 *   droppedBlocks?: number
 *   ledgerEntries?: number
 *   summaryApplied?: boolean
 *   collapsedTurns?: number
 *   reactive?: boolean
 * }} TimelineEntry
 *
 * @typedef {TimelineEntry & {collapsed: boolean}} LogEntry
 *
 * @typedef {{
 *   toolUseId: string,
 *   name: string,
 *   input: unknown,
 *   status: "pending"|"allowed"|"denied"|"expired",
 *   reason?: string,
 *   decidedAt?: number,
 *   requestSeq?: number,
 *   approvalId?: string,
 *   source?: string,
 *   grantPolicy?: {maxScope:"once"|"exact-input",maxTtlMs:number,maxUses:number}
 * }} PendingApproval
 *
 * @typedef {{
 *   passed: boolean,
 *   summary: string,
 *   issues: string[],
 *   unverified: string[],
 *   advisory: string[]
 * }} VerdictModel
 *
 * @typedef {{
 *   turns: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheHitRatio: number
 * }} UsageModel
 *
 * @typedef {{
 *   finalStatus: string,
 *   resultSummary: string|null,
 *   completion: object|null,
 *   verdict: VerdictModel|null,
 *   actionItems: {pendingApprovals: PendingApproval[], unverifiedItems: string[], blockers:string[]},
 *   resolvedApprovals: PendingApproval[],
 *   usage: UsageModel|null
 * }} OverviewModel
 *
 * @typedef {{
 *   status: string,
 *   startTime: number,
 *   duration: number|null,
 *   verdictConclusion: string|null
 * }} RunListItemMeta
 */

// ---------------------------------------------------------------
// 纯函数：createInitialState
// ---------------------------------------------------------------

/** @returns {RunState} */
export function createInitialState(runId, task, verify, metadata = {}) {
  return {
    runId,
    task,
    status: "running",
    verify,
    archived: Boolean(metadata.archived),
    createdAt: Number.isFinite(Number(metadata.createdAt)) ? Number(metadata.createdAt) : undefined,
    timeline: [],
    verifierTimeline: [],
    /** 本次对话内精确输入放行规则（见 deriveAssemblyBar 的 autoAllow 那一格） */
    autoAllow: [],
    pendingApprovals: [],
    verdict: null,
    usage: null,
    error: null,
    stopReason: null,
    completion: null,
    runBudget: null,
    /** 归档检查点派生边界；null = 本 run 不是跨宿主恢复出来的子级。 */
    lineage: null,
    lastSeq: -1,
    runEnd: null,
    /** 逐轮 token（来自 usage 事件）——上下文水位与成本的唯一来源 */
    usageByTurn: [],
    /** 逐轮核查裁决（来自 verification 事件），末轮之外的也保留 */
    verifications: [],
    /** toolUseId → 工具名。tool_result 事件本身不带 name，只能靠 tool_call 回填 */
    toolNames: {},
    /**
     * 本次运行的实际装配（V-24）。pack 可逐 run 覆盖，而 /api/harness 是进程级
     * 快照——两者不一致时以这个为准，否则 Tools 面会展示另一个包的边界。
     */
    runConfig: null,
    /** V-27 编排：计划、调度结果、降级告警 */
    plan: null,
    planResult: null,
    planReplan: null,
    planWarnings: [],
    /**
     * 计划确认门（backlog §5.1）。null = 本 run 没开门。
     * status: pending 等签字 | approved | rejected | expired（run 收尾时未应答）
     */
    planApproval: null,
    // §5.2 需求澄清：当前挂起的提问（null = 没有）+ 已决记录（审计）
    question: null,
    questionLog: [],
    /**
     * 下一步提议（不挡对话）。null = 没有。
     * status: pending | accepted | declined
     */
    handoff: null,
    /** V-28：已进行的对话轮数（第 1 轮 = 建 run 时那次提交） */
    conversationTurn: 1,
    /** 执行者 update_progress 整表；null = 还没拆过步 */
    progressItems: null,
    /**
     * 信息队列·排队中的消息（来自 message_queued / message_queue_updated 事件重放）。
     * composer 上方的 chips 唯一数据源；插队（steer）不可撤，不进这里。
     */
    queuedMessages: [],
    /** write_file 等调用前的 before 镜像，回退对话框用来数「能还原几份」 */
    fileRewindSnapshots: [],
    rewindFrom: null,
  };
}

// ---------------------------------------------------------------
// 纯函数：stopReason 分档 (V-04)
// ---------------------------------------------------------------

/**
 * 把六种终止原因分档为 {色调, 人话标签, 补救提示}。
 *
 * 为什么值得单独一个函数：此前前端只判 `error`，其余五值一律显示绿色"已完成"。
 * 而 max_turns 与 error 恰是「verifier 救不了」的两类——执行根本没跑完，
 * 核查通过也不代表任务做完。界面必须直说，否则是在报喜不报忧。
 * 分档口径对齐 CLI（src/cli.ts 的 completed=绿 / max_tokens=黄 / 其余=红）。
 *
 * @param {string|null|undefined} stopReason
 * @returns {{tone:"ok"|"warn"|"bad", label:string, hint:string|null}}
 */
export function classifyStopReason(stopReason) {
  switch (stopReason) {
    case "completed":
      return { tone: "ok", label: "已完成", hint: null };
    case "max_tokens":
      return {
        tone: "warn",
        label: "输出被截断",
        hint: "单次响应达到上限，产物可能不完整；可提高 AGENT_MAX_TOKENS 后重跑",
      };
    case "max_turns":
      return {
        tone: "bad",
        label: "撞轮次护栏",
        hint: "执行未自然结束，核查救不了这一类——即使核查通过也不代表任务做完",
      };
    case "partial":
      return {
        tone: "warn",
        label: "部分完成",
        hint: "已有可用交付，但仍有未完成项；请查看结构化阻塞清单",
      };
    case "blocked":
      return {
        tone: "warn",
        label: "等待外部条件",
        hint: "执行者已明确列出无法自行解除的阻塞条件",
      };
    case "incomplete":
      return {
        tone: "bad",
        label: "未能结构化收口",
        hint: "模型多次结束生成却没有提交有效完成状态，不能按成功处理",
      };
    case "stalled":
      return {
        tone: "bad",
        label: "重复空转已停止",
        hint: "连续获得相同工具观察，换策略后仍无进展，宿主已停止继续烧轮次",
      };
    /**
     * 人主动叫停：判 warn 不判 bad。把委托方自己的决定画成"异常终止"
     * 是对他说谎（与 plan_rejected 同一条纪律）。
     */
    case "aborted":
      return {
        tone: "warn",
        label: "已停止",
        hint: "这次运行由你主动停止；已完成的工具调用与写入不会回滚。",
      };
    case "budget_exhausted":
      return {
        tone: "warn",
        label: "token 预算耗尽",
        hint: "谱系额度用完了，不是崩溃。已写入的产物还在——直接在下面接着说下一句，发送时会自动续一段跑道",
      };
    case "refusal":
      return { tone: "bad", label: "模型拒答", hint: "模型拒绝继续，换一种说法再试" };
    case "plan_rejected":
      // 不是失败，是决定——所以 warn 不是 bad，文案也不说"终止/异常"
      return {
        tone: "warn",
        label: "计划未获批准",
        hint: "计划确认门被否决，一个子任务都没有发射——没有任何副作用",
      };
    case "plan_gate_expired":
      return {
        tone: "warn",
        label: "计划门未应答",
        hint: "运行收尾时确认门仍在等待，未执行任何子任务",
      };
    case "error":
      return { tone: "bad", label: "异常终止", hint: "宿主级失败，核查不会运行" };
    case null:
    case undefined:
      return { tone: "ok", label: "运行中", hint: null };
    default:
      return { tone: "warn", label: String(stopReason), hint: null };
  }
}

/**
 * 交付呈现面。stopReason 仍是事实（没签字就是 incomplete）；
 * 有落盘产物时不要把收尾条画成空跑红失败。
 *
 * @param {string|null|undefined} stopReason
 * @param {Array<{path?: string}|string>|null|undefined} artifacts
 * @returns {{kind:string, tone:"ok"|"warn"|"bad", label:string, hint:string|null, placeholder?:string}}
 */
export function deliveryFace(stopReason, artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const hasArtifacts = list.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    return Boolean(item && String(item.path ?? "").trim());
  });
  if (stopReason === "incomplete" && hasArtifacts) {
    return {
      kind: "unsigned",
      tone: "warn",
      label: "页面已写出，模型没签字",
      hint: "这一轮已经停了，产物在右侧",
      placeholder: "接着改已有页面…",
    };
  }
  const cls = classifyStopReason(stopReason);
  return {
    kind: stopReason == null ? "running" : String(stopReason),
    tone: cls.tone,
    label: cls.label,
    hint: cls.hint,
  };
}

/**
 * 读屏 / 通知用的收尾句：停就是停，完成就是完成，否决不是停止。
 * @param {{ stopReason?: string|null, status?: string, task?: string, timeline?: any[] }|null|undefined} state
 */
export function runEndAnnouncement(state) {
  const reason = state?.stopReason
    ?? (state?.status === "done" ? "completed" : null);
  const task = String(state?.task ?? "").trim();
  const tail = task ? `：${task}` : "";
  if (reason === "aborted") return `已停止${tail}`;
  if (reason === "plan_rejected") return `计划未获批准${tail}`;
  if (reason === "plan_gate_expired") return `计划门未应答${tail}`;
  if (reason === "completed") return `运行已完成${tail}`;
  const artifacts = Array.isArray(state?.timeline) ? deriveArtifacts(state) : [];
  const face = deliveryFace(reason, artifacts);
  if (face.label === "运行中") return `运行已完成${tail}`;
  return `${face.label}${tail}`;
}

/**
 * 提交失败优先用人话。不拼 HTTP 状态码，也不把「领域包」甩到脸上。
 * @param {unknown} body
 * @param {number} [status]
 */
export function humanizeSubmitError(body, status) {
  const raw = typeof body === "string"
    ? body.trim()
    : body && typeof body === "object" && typeof /** @type {{error?: unknown}} */ (body).error === "string"
      ? String(/** @type {{error: string}} */ (body).error).trim()
      : "";
  const cleaned = raw
    .replace(/领域包/g, "这类任务")
    .replace(/\bHTTP\s*\d{3}\b/gi, "")
    .replace(/提交失败（\s*）/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (status === 429 || /rate limit|Mutation rate/i.test(cleaned) || /rate limit|Mutation rate/i.test(raw)) {
    return "前面还有人在交，请等几秒。";
  }
  if (cleaned) return cleaned;
  if (status === 409) return "这次发不出去，请换种说法再试。";
  if (status === 400) return "这次请求对不上，请改一下再发。";
  return "发送失败，请稍后再试。";
}

/** composer 以外的条：删除 / 上传 / 停止 等失败，不报 HTTP 状态码。 */
export function humanizeActionFailure(action, status, bodyError) {
  if (status === 429) return "前面还有人在交，请等几秒。";
  const fromBody = bodyError
    ? humanizeSubmitError({ error: String(bodyError) }, status)
    : "";
  if (fromBody && fromBody !== "发送失败，请稍后再试。") return fromBody;
  const verb = String(action ?? "这次").replace(/失败$/, "");
  if (status === 400) return `${verb}没做成，请改一下再试。`;
  if (status === 404) return `${verb}找不到这项。`;
  if (status === 409) return `${verb}现在还不能这样做。`;
  return `${verb}没做成，请稍后再试。`;
}

/**
 * 批准卡主文案：说要新建/改哪个文件，不把工具名 + JSON 当第一眼。
 * @param {string|null|undefined} name
 * @param {unknown} input
 */
export function describeApprovalAction(name, input) {
  const tool = String(name ?? "").replace(/^.*__/, "").trim();
  let obj = {};
  if (input && typeof input === "object") obj = /** @type {Record<string, unknown>} */ (input);
  else if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch { /* 非 JSON 入参当没有路径 */ }
  }
  const path = String(obj.path ?? obj.file_path ?? "").trim();
  const base = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const content = typeof obj.content === "string" ? obj.content : "";
  const first = content.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const preview = first.length > 40 ? `${first.slice(0, 40)}…` : first;
  if (tool === "write_file") {
    if (base && preview) return `要新建或改 ${base}，写入「${preview}」`;
    if (base) return `要新建或改 ${base}`;
  }
  if (tool === "edit_file") return base ? `要改 ${base}` : "要改一个文件";
  if (tool === "bash" && typeof obj.command === "string" && obj.command.trim()) {
    const cmd = obj.command.replace(/\s+/g, " ").trim();
    return `要运行：${cmd.length > 72 ? `${cmd.slice(0, 72)}…` : cmd}`;
  }
  if (base) return `要用工具处理 ${base}`;
  return tool ? `要使用 ${tool}` : "要执行一项操作";
}

// ---------------------------------------------------------------
// 纯函数：reduceEvent
// ---------------------------------------------------------------

/**
 * 恢复策略投影（run_config.recovery / harness.recovery 同形）。
 * 三字段缺一就整体 null——半份策略比没有更糟（会显示"续跑 8 轮"却不知道
 * 停滞窗是多少）；sources 缺省全 "default"，armed 缺省按 true（旧宿主没这个字段
 * 时完成门是默认开的）。
 * @returns {{armed:boolean,progressExtensionTurns:number,stagnationWindow:number,maxStagnationRecoveries:number,sources:Record<string,string>}|null}
 */
export function normalizeRecoveryConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fields = ["progressExtensionTurns", "stagnationWindow", "maxStagnationRecoveries"];
  const out = {};
  for (const f of fields) {
    if (typeof raw[f] !== "number" || !Number.isFinite(raw[f])) return null;
    out[f] = raw[f];
  }
  const sources = {};
  for (const f of fields) {
    const s = raw.sources && typeof raw.sources === "object" ? raw.sources[f] : undefined;
    sources[f] = s === "env" || s === "pack" ? s : "default";
  }
  return { armed: raw.armed !== false, ...out, sources };
}

/** 窗口来源四值 / 预算来源四值——宿主之外的字符串一律归 unknown / null，不让界面替宿主编来源 */
const CONTEXT_WINDOW_SOURCES = new Set(["env", "learned", "registry", "unknown"]);
const CONTEXT_BUDGET_SOURCES = new Set(["run", "env", "pack", "window", "default"]);

/** 工作区 git 投影：不带 remote URL。absent / 形状不对 → null（条上不画）。 */
export function normalizeWorkspaceGit(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.present !== true) return { present: false };
  const github = raw.github && typeof raw.github === "object" && raw.github.owner && raw.github.repo
    ? { owner: String(raw.github.owner), repo: String(raw.github.repo) }
    : null;
  return {
    present: true,
    root: raw.root ? String(raw.root) : undefined,
    branch: raw.branch == null ? null : String(raw.branch),
    detached: raw.detached === true,
    dirty: raw.dirty === true,
    github,
    branches: Array.isArray(raw.branches) ? raw.branches.map(String) : [],
  };
}

/** composer / 装配条共用的短标签：`main` / `main *` / `detached abc123`。无仓库 → null。 */
export function formatWorkspaceGitChip(git, opts = {}) {
  if (!git || git.present !== true) return null;
  const head = git.detached ? `detached ${git.branch || "HEAD"}` : (git.branch || "HEAD");
  const dirty = git.dirty ? " *" : "";
  if (opts.withRepo && git.github?.owner && git.github.repo) {
    return `${head}${dirty} · ${git.github.owner}/${git.github.repo}`;
  }
  return `${head}${dirty}`;
}

/**
 * `/api/harness` 的 notify 投影。只认 kind + armed，剥掉 webhook/url/token。
 * 缺席或非对象 → null（旧宿主）。
 * @param {object|null|undefined} raw
 * @returns {{kind:"feishu"|"webhook", armed:boolean}|null}
 */
export function normalizeNotifySnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "webhook" ? "webhook" : "feishu";
  return { kind, armed: Boolean(raw.armed) };
}

/**
 * 上下文窗口 / 预算投影（run_config.context / harness.context 同形，MEM-01 窗口 / 预算分离）。
 *
 * 窗口是**事实**（端点在多大处拒收；null = 未知，界面必须写"窗口未知"而不是画 0），
 * 预算是**策略**（在多大处压缩，就是 guardrails.contextTokenLimit 那个数）。两者此前是一个数，
 * 于是 150k 在 1M 的模型上压了三个月没人看见——三段水位条（已用 / 预算 / 窗口）的数字全部
 * 从这里取，不从 usage 反推。budget 缺就整体 null（没有预算就画不出任何一段）。
 * @returns {{window:number|null, windowSource:string, budget:number, budgetSource:string|null,
 *   requestedBudget:number, maxBudget:number|null, maxTokens:number|null, clamped:boolean, warning:string|null}|null}
 */
export function normalizeContextConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const budget = num(raw.budget);
  if (budget === null) return null;
  return {
    window: num(raw.window),
    windowSource: CONTEXT_WINDOW_SOURCES.has(raw.windowSource) ? raw.windowSource : "unknown",
    budget,
    budgetSource: CONTEXT_BUDGET_SOURCES.has(raw.budgetSource) ? raw.budgetSource : null,
    requestedBudget: num(raw.requestedBudget) ?? budget,
    maxBudget: num(raw.maxBudget),
    maxTokens: num(raw.maxTokens),
    clamped: raw.clamped === true,
    warning: typeof raw.warning === "string" && raw.warning ? raw.warning : null,
  };
}

/**
 * 把一条 SSE 事件折叠进渲染模型。
 * @param {RunState} state
 * @param {{seq:number, source:string, event:Record<string,unknown>}} sseEvent
 * @returns {RunState}
 */
/** 消息时间：事件自带 at，否则用 SSE 信封 ts。 */
export function eventAt(sseEvent) {
  const fromEvent = Number(sseEvent?.event?.at);
  if (Number.isFinite(fromEvent)) return fromEvent;
  const fromTs = Number(sseEvent?.ts);
  if (Number.isFinite(fromTs)) return fromTs;
  return undefined;
}

function stampAt(entry, sseEvent) {
  const at = eventAt(sseEvent);
  return at == null ? entry : { ...entry, at };
}

export function reduceEvent(state, sseEvent) {
  const { seq, source, event } = sseEvent;
  const type = /** @type {string} */ (event.type);

  // text_delta / thinking_delta 不进 state——它们走 `event: delta` 命名通道、
  // 不占 seq、不进服务端事件缓冲（V-15），重连重放时根本不存在；进了 state
  // 就会打破"同批事件重放两次状态深相等"。逐字显示由控制器单独持有缓冲、
  // 作为 renderRunDetail 的 liveText / liveThinking 入参喂进对话与直播条。
  // 这条分支守的是"万一它混进了 durable 流也不改状态"。
  if (type === "text_delta" || type === "thinking_delta") return state;

  // ---- 路由 ----
  if (type === "verdict") {
    return applyVerdict(state, event);
  }
  if (type === "done") {
    return applySegmentDone(state, event, source);
  }
  if (type === "run_end") {
    return applyRunEnd(state, event);
  }
  if (type === "approval_request") {
    return applyApproval(state, seq, source, event);
  }
  if (type === "approval_resolved") {
    const next = applyApprovalResolved(state, event);
    /**
     * 放行规则也从权威事件里长出来。当前事件必须带 exact-input/hash；旧档案
     * 可能只有 scope，保留成 legacy 审计标记，但不会把它说成当前精确规则。
     */
    if (event.scope !== "run" && event.scope !== "conversation") return next;
    const name = String(event.name ?? "");
    if (!name) return next;
    const exact =
      event.scope === "run" &&
      event.inputScope === "exact-input" &&
      typeof event.inputHash === "string" &&
      typeof event.grantId === "string" &&
      event.boundRunId === state.runId &&
      Number.isFinite(Number(event.expiresAt));
    const rule = {
      name,
      inputHash: exact ? String(event.inputHash) : null,
      inputScope: exact ? "exact-input" : "legacy-tool",
      status: exact ? "active" : "legacy",
      ...(exact
        ? {
            grantId: String(event.grantId),
            boundRunId: String(event.boundRunId),
            expiresAt: Number(event.expiresAt),
            maxUses: Number(event.maxUses ?? 0),
            usedUses: Number(event.usedUses ?? 0),
          }
        : {}),
    };
    const index = next.autoAllow.findIndex(
      (item) =>
        (rule.grantId && item.grantId === rule.grantId) ||
        (!rule.grantId && item.name === rule.name && item.inputHash === rule.inputHash && item.inputScope === rule.inputScope),
    );
    if (index < 0) return { ...next, autoAllow: [...next.autoAllow, rule] };
    const autoAllow = [...next.autoAllow];
    autoAllow[index] = { ...autoAllow[index], ...rule };
    return { ...next, autoAllow };
  }
  if (
    type === "approval_grant_expired" ||
    type === "approval_grant_invalidated" ||
    type === "approval_grant_exhausted" ||
    type === "approval_grant_not_inherited"
  ) {
    const status = type === "approval_grant_expired"
      ? "expired"
      : type === "approval_grant_exhausted"
        ? "exhausted"
        : type === "approval_grant_not_inherited"
          ? "not-inherited"
          : "invalidated";
    const grantId = String(event.grantId ?? "");
    const index = state.autoAllow.findIndex((item) => grantId && item.grantId === grantId);
    const record = {
      name: String(event.name ?? "unknown"),
      inputHash: typeof event.inputHash === "string" ? String(event.inputHash) : null,
      inputScope: event.inputScope === "exact-input" ? "exact-input" : "legacy-tool",
      grantId: grantId || undefined,
      boundRunId: typeof event.boundRunId === "string" ? String(event.boundRunId) : undefined,
      expiresAt: Number.isFinite(Number(event.expiresAt)) ? Number(event.expiresAt) : undefined,
      status,
    };
    const autoAllow = [...state.autoAllow];
    if (index >= 0) autoAllow[index] = { ...autoAllow[index], ...record };
    else autoAllow.push(record);
    return {
      ...state,
      autoAllow,
      timeline: [...state.timeline, buildTimelineEntry(seq, source, type, event)],
    };
  }
  if (type === "approval_expired") {
    return applyApprovalExpired(state, event);
  }
  if (type === "run_forked") {
    const entry = buildTimelineEntry(seq, source, type, event);
    return {
      ...state,
      lineage: {
        parentRunId: String(event.parentRunId ?? ""),
        rootRunId: String(event.rootRunId ?? event.parentRunId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
        kind: "fork",
        ...(typeof event.priorRecap === "string" && event.priorRecap
          ? { priorRecap: event.priorRecap }
          : {}),
        ...(Number(
          event.checkpoint && typeof event.checkpoint === "object"
            ? /** @type {any} */ (event.checkpoint).conversationTurn
            : event.priorTurns,
        ) > 0
          ? {
              priorTurns: Number(
                event.checkpoint && typeof event.checkpoint === "object"
                  ? /** @type {any} */ (event.checkpoint).conversationTurn
                  : event.priorTurns,
              ),
            }
          : {}),
      },
      timeline: [...state.timeline, entry],
    };
  }
  if (type === "run_resumed") {
    const entry = buildTimelineEntry(seq, source, type, event);
    return {
      ...state,
      status: "running",
      runEnd: null,
      stopReason: null,
      error: null,
      lineage: {
        parentRunId: String(event.runId ?? ""),
        rootRunId: String(event.rootRunId ?? event.runId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
        kind: "same-run",
      },
      timeline: [...state.timeline, entry],
    };
  }
  if (type === "user_message") {
    // 追加的这句话既是会话内容，也标志 run 从终态回到运行中——
    // 状态由事件本身驱动，客户端不必另写一套特判。
    // 会话中心化：核查是逐轮选项，事件带本轮的 verify——reducer 的 `state.verify`
    // 从此是"当前这一轮核查不核查"，applySegmentDone 的单段快路径靠它判 done 是不是
    // run 终止。不接这个字段，第 1 轮没核查、第 2 轮核查的 run 会在执行者 done 时被
    // 判成结束，控制器随即关流，verifier 段与 run_end 全部收不到（V-01 那条缝的第三个现身）
    return {
      ...state,
      status: "running",
      runEnd: null,
      stopReason: null,
      error: null,
      ...(typeof event.verify === "boolean" ? { verify: event.verify } : {}),
      conversationTurn: Number(event.turn ?? state.conversationTurn + 1),
      timeline: [
        ...state.timeline,
        {
          seq, source, type: "user_message",
          text: String(event.text ?? ""),
          turn: Number(event.turn ?? 0),
          ...(typeof event.verify === "boolean" ? { verify: event.verify } : {}),
          // 这一轮接的是什么：history / plan-summary / fresh（旧事件没有，缺省不显示）
          ...(typeof event.continues === "string" ? { continues: event.continues } : {}),
          ...(event.executorSwitched === true ? { executorSwitched: true } : {}),
          ...(eventAt(sseEvent) != null ? { at: eventAt(sseEvent) } : {}),
        },
      ],
    };
  }
  if (type === "plan") {
    return {
      ...state,
      plan: {
        concurrency: Number(event.concurrency ?? 1),
        concurrencyMode: String(event.concurrencyMode ?? "fixed"),
        plannerMs: Number(event.plannerMs ?? 0),
        // 白名单投影：description / acceptance 是签字位正文，漏字段界面只剩标题。
        subtasks: (Array.isArray(event.subtasks) ? event.subtasks : []).map((raw) => {
          const t = raw && typeof raw === "object" ? raw : {};
          return {
            id: String(t.id ?? ""),
            title: String(t.title ?? ""),
            pack: t.pack == null || t.pack === "" ? null : String(t.pack),
            description: typeof t.description === "string" ? t.description : "",
            acceptance: Array.isArray(t.acceptance) ? t.acceptance.map(String) : [],
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
            resources: Array.isArray(t.resources) ? t.resources.map(String) : [],
          };
        }),
        // 门开着时这份计划还在等签字，界面不能显得像已经在跑
        gated: Boolean(event.gated),
      },
    };
  }
  // ---- 信息队列（运行中插队 / 排队）。三条都是 durable 合成事件，重连重放即复原 ----
  if (type === "message_queued") {
    const mode = event.mode === "steer" ? "steer" : "queue";
    const text = String(event.text ?? "");
    return {
      ...state,
      // 排队消息进 chips（可取消）；插队不进——它可能下一瞬就注入正史，不可撤
      queuedMessages: mode === "queue" && text ? [...state.queuedMessages, text] : state.queuedMessages,
      timeline: [...state.timeline, { seq, source, type: "message_queued", mode, text }],
    };
  }
  if (type === "message_queue_updated") {
    // 整表替换是队列终态的唯一权威（取消 / 自动续跑成功后的清空 / 被拒后的还原），
    // 比逐条增删幂等——重放两遍长出同一份状态
    const sendError = typeof event.sendError === "string" ? event.sendError : null;
    return {
      ...state,
      queuedMessages: Array.isArray(event.pending) ? event.pending.map(String) : [],
      timeline: sendError
        ? [...state.timeline, { seq, source, type: "message_queue_updated", sendError }]
        : state.timeline,
    };
  }
  if (type === "steering") {
    // loop 把插队指令并入正史时发射；事件位置 = 指令生效位置（下一轮模型调用之前）。
    // 画成带「插队指令」标注的用户气泡，与普通追加指令区分（渲染分支认 type）
    return {
      ...state,
      timeline: [...state.timeline, { seq, source, type: "steering", text: String(event.text ?? "") }],
    };
  }
  // ---- 计划确认门（§5.1）。三条事件都是 durable 合成事件，重连重放即复原 ----
  if (type === "plan_approval_request") {
    return { ...state, planApproval: { status: "pending", seq, at: Number(event.at ?? 0) } };
  }
  if (type === "plan_approval_resolved") {
    return {
      ...state,
      planApproval: {
        status: event.decision === "approve" ? "approved" : "rejected",
        seq: Number(event.requestSeq ?? seq),
        at: Number(event.at ?? 0),
        actor: String(event.actor ?? "user"),
      },
    };
  }
  if (type === "plan_approval_expired") {
    // 只有仍在 pending 时才转过期：已签过的决策是审计记录，不能被覆盖
    if (state.planApproval && state.planApproval.status !== "pending") return state;
    return {
      ...state,
      planApproval: { status: "expired", seq: Number(event.requestSeq ?? seq), at: 0 },
    };
  }
  // ---- 需求澄清（§5.2）。三条事件同计划门：durable 合成事件，重连重放即复原 ----
  if (type === "user_question_request") {
    return {
      ...state,
      question: {
        status: "pending",
        id: String(event.id ?? seq),
        seq,
        // 一次打断一组问题（决定 6）
        questions: (Array.isArray(event.questions) ? event.questions : []).map((q) => {
          const options = Array.isArray(q.options) ? q.options.map(String) : [];
          // 推荐徽标是结构化字段，不是选项文字的一部分——非法值静默丢弃（同工具侧口径）
          const rec = q.recommended;
          const ok = typeof rec === "number" && Number.isInteger(rec) && rec >= 1 && rec <= options.length;
          return {
            question: String(q.question ?? ""),
            options,
            fallback: String(q.fallback ?? ""),
            ...(ok ? { recommended: rec } : {}),
          };
        }),
        at: Number(event.at ?? 0),
      },
    };
  }
  if (type === "user_question_resolved") {
    const answered = {
      status: event.skipped ? "skipped" : "answered",
      id: String(event.id ?? ""),
      seq: Number(event.requestSeq ?? seq),
      questions: state.question ? state.question.questions : [],
      answers: Array.isArray(event.answers)
        ? event.answers.map((a) => (a === null || a === undefined ? null : String(a)))
        : [],
      at: Number(event.at ?? 0),
    };
    return { ...state, question: null, questionLog: [...state.questionLog, answered] };
  }
  if (type === "user_question_expired") {
    // 只有仍挂起时才转过期：已答过的是审计记录，不能被覆盖（同计划门口径）
    if (!state.question || state.question.status !== "pending") return state;
    return {
      ...state,
      question: null,
      questionLog: [...state.questionLog, { ...state.question, status: "expired", answers: [] }],
    };
  }
  if (type === "handoff_proposal") {
    return {
      ...state,
      handoff: {
        status: "pending",
        id: String(event.id ?? seq),
        handoffId: String(event.handoffId ?? ""),
        summary: String(event.summary ?? ""),
        label: String(event.label ?? "按这个根因改固件，再上板复测"),
        declineLabel: String(event.declineLabel ?? "先不用"),
        seq,
        at: Number(event.at ?? 0),
      },
    };
  }
  if (type === "handoff_resolved") {
    if (!state.handoff) return state;
    return {
      ...state,
      handoff: {
        ...state.handoff,
        status: event.decision === "accept" ? "accepted" : "declined",
        seq: Number(event.requestSeq ?? seq),
        at: Number(event.at ?? 0),
        ...(typeof event.childRunId === "string" ? { childRunId: String(event.childRunId) } : {}),
      },
    };
  }
  // 9.8 段级续跑：整段因瞬时错误死掉后带着正史接着跑。必须显式呈现——
  // 否则宿主看到一个 done(error) 之后又冒出一堆事件，完全读不懂
  if (type === "segment_resume") {
    return {
      ...state,
      // 段死了又续上：状态回到运行中，清掉那条已经不成立的错误
      status: "running",
      error: null,
      stopReason: null,
      completion: null,
      timeline: [
        ...state.timeline,
        {
          seq, source, type: "segment_resume",
          attempt: Number(event.attempt ?? 1),
          reason: String(event.reason ?? ""),
          priorTurns: Number(event.priorTurns ?? 0),
        },
      ],
    };
  }
  if (type === "plan_result") {
    return { ...state, planResult: { ...event, type: undefined } };
  }
  if (type === "plan_replan") {
    return {
      ...state,
      planReplan: {
        kept: Array.isArray(event.kept) ? event.kept.map(String) : [],
        added: Array.isArray(event.added) ? event.added.map(String) : [],
        dropped: Array.isArray(event.dropped) ? event.dropped.map(String) : [],
        changed: Array.isArray(event.changed) ? event.changed.map(String) : [],
        reason: String(event.reason ?? ""),
      },
      timeline: [
        ...state.timeline,
        {
          seq,
          source,
          type: "plan_replan",
          kept: Array.isArray(event.kept) ? event.kept.map(String) : [],
          added: Array.isArray(event.added) ? event.added.map(String) : [],
          dropped: Array.isArray(event.dropped) ? event.dropped.map(String) : [],
          changed: Array.isArray(event.changed) ? event.changed.map(String) : [],
          reason: String(event.reason ?? ""),
        },
      ],
    };
  }
  if (type === "plan_resume") {
    return {
      ...state,
      planResume: {
        kept: Array.isArray(event.kept) ? event.kept.map(String) : [],
        remaining: Array.isArray(event.remaining) ? event.remaining.map(String) : [],
        reason: String(event.reason ?? ""),
      },
      timeline: [
        ...state.timeline,
        {
          seq,
          source,
          type: "plan_resume",
          kept: Array.isArray(event.kept) ? event.kept.map(String) : [],
          remaining: Array.isArray(event.remaining) ? event.remaining.map(String) : [],
          reason: String(event.reason ?? ""),
        },
      ],
    };
  }
  if (type === "spawn_start" || type === "spawn_done") {
    return {
      ...state,
      timeline: [
        ...state.timeline,
        {
          seq,
          source,
          type,
          title: String(event.title ?? ""),
          ...(event.runId ? { runId: String(event.runId) } : {}),
          ...(type === "spawn_done"
            ? {
                passed: event.passed === true,
                summary: String(event.summary ?? ""),
                ...(event.error ? { error: String(event.error) } : {}),
                ...(typeof event.turns === "number" ? { turns: event.turns } : {}),
              }
            : {}),
        },
      ],
    };
  }
  if (type === "campaign_child") {
    return {
      ...state,
      timeline: [
        ...state.timeline,
        {
          seq,
          source,
          type: "campaign_child",
          runId: String(event.runId ?? ""),
          title: String(event.title ?? ""),
          status: String(event.status ?? "running"),
        },
      ],
    };
  }
  if (type === "plan_warning") {
    return {
      ...state,
      planWarnings: [...state.planWarnings, { subtaskId: event.subtaskId, message: event.message }],
    };
  }
  if (type === "run_config") {
    return {
      ...state,
      runConfig: {
        pack: event.pack ?? null,
        workdir: event.workdir ?? null,
        executionIsolation: event.executionIsolation ?? null,
        roleModels: event.roleModels ?? null,
        effort: event.effort ?? null,
        effortApplies: Boolean(event.effortApplies),
        rubricSource: event.rubricSource ?? null,
        // 核查预算逐 run 可不同（9.1：领域包用 verify.maxTurns 覆盖）。
        // 这个分支是逐字段白名单投影——**新字段不在这里列出就会被静默丢弃**，
        // 本轮已是第三次踩到（api_retry.backoffMs、这里）。加字段必查这三处：
        // reduceEvent 的投影分支、派生函数、渲染分支。
        verifierBudgetTurns: event.verifierBudgetTurns ?? null,
        verifierBudgetSource: event.verifierBudgetSource ?? null,
        plannerBudgetTurns: event.plannerBudgetTurns ?? null,
        plannerBudgetSource: event.plannerBudgetSource ?? null,
        // 恢复策略（领域包可声明）：三字段 + 逐字段来源 + armed。armed 必须保真——
        // 完成门关着时 loop 根本不读这些数，界面若只显示数字就是在说谎
        recovery: normalizeRecoveryConfig(event.recovery),
        // 核查白名单的**生效值**与来源：无包运行拿通用缺省（委托方批准的例外），
        // 只读 pack.verify.readOnlyCommands 会把它画成"白名单 0 · 核查饥饿"
        verifierReadOnlyCommands: Array.isArray(event.verifierReadOnlyCommands)
          ? event.verifierReadOnlyCommands.map(String)
          : null,
        verifierReadOnlySource: event.verifierReadOnlySource ? String(event.verifierReadOnlySource) : null,
        // MODEL-01a：null = 没配这条防线，[] 与它不是一回事，别用 ?? [] 抹平
        fallbackChain: Array.isArray(event.fallbackChain) ? event.fallbackChain.map(String) : null,
        fallbackChains: event.fallbackChains && typeof event.fallbackChains === "object"
          ? {
              executor: Array.isArray(event.fallbackChains.executor) ? event.fallbackChains.executor.map(String) : null,
              verifier: Array.isArray(event.fallbackChains.verifier) ? event.fallbackChains.verifier.map(String) : null,
              planner: Array.isArray(event.fallbackChains.planner) ? event.fallbackChains.planner.map(String) : null,
              vision: Array.isArray(event.fallbackChains.vision) ? event.fallbackChains.vision.map(String) : null,
            }
          : null,
        fallbackScope: event.fallbackScope ? String(event.fallbackScope) : null,
        fallbackRouting: event.fallbackRouting ? String(event.fallbackRouting) : null,
        compatSource: event.compatSource ? String(event.compatSource) : null,
        // MODEL-01 残余：链健康只读面——新字段不列出会被白名单投影静默丢弃
        endpointHealth: Array.isArray(event.endpointHealth)
          ? event.endpointHealth.map((row) => ({
              model: String(row?.model ?? ""),
              healthy: row?.healthy !== false,
              circuit: String(row?.circuit ?? "closed"),
              ...(row?.latencyMs != null && Number.isFinite(Number(row.latencyMs))
                ? { latencyMs: Number(row.latencyMs) }
                : {}),
              ...(row?.reason ? { reason: String(row.reason) } : {}),
            })).filter((row) => row.model)
          : null,
        supportsVision:
          event.supportsVision === true || event.supportsVision === false
            ? event.supportsVision
            : null,
        describeImageBacking:
          event.describeImageBacking === "executor"
          || event.describeImageBacking === "vision-role"
          || event.describeImageBacking === "none"
            ? event.describeImageBacking
            : null,
        guardrails: event.guardrails ?? null,
        // 上下文窗口（事实）/ 预算（策略）各带来源（MEM-01 窗口 / 预算分离）——三段水位条的唯一数据源
        context: normalizeContextConfig(event.context),
        tools: Array.isArray(event.tools) ? event.tools : [],
        permission: event.permission && typeof event.permission === "object"
          ? {
              mode: event.permission.mode == null ? null : String(event.permission.mode),
              approvalDefault: event.permission.approvalDefault === "auto" ? "auto" : "ask",
              planMode: event.permission.planMode === true,
              planGate: event.permission.planGate === true,
              autoYes: event.permission.autoYes === true,
            }
          : null,
        packRoute: event.packRoute && typeof event.packRoute === "object"
          ? {
              pack: event.packRoute.pack == null ? null : String(event.packRoute.pack),
              reason: String(event.packRoute.reason ?? ""),
            }
          : null,
        // 设计模式门面：mode + designRoute 必须进白名单，否则装配条静默丢弃
        mode: event.mode == null ? null : String(event.mode),
        designRoute: event.designRoute && typeof event.designRoute === "object"
          ? {
              id: event.designRoute.id == null ? null : String(event.designRoute.id),
              reason: String(event.designRoute.reason ?? ""),
              seed: String(event.designRoute.seed ?? "blank"),
              kind: String(event.designRoute.kind ?? ""),
              bundle: event.designRoute.bundle == null ? null : String(event.designRoute.bundle),
              extraSeeds: Array.isArray(event.designRoute.extraSeeds)
                ? event.designRoute.extraSeeds.map(String)
                : [],
            }
          : null,
        // 逐 run 只读根 / 可写根。不列出就会静默丢弃。
        readRoots: Array.isArray(event.readRoots) ? event.readRoots.map(String) : null,
        writeRoots: Array.isArray(event.writeRoots) ? event.writeRoots.map(String) : [],
        extraWorkdirs: Array.isArray(event.extraWorkdirs) ? event.extraWorkdirs.map(String) : [],
        projectId: event.projectId == null || event.projectId === "" ? null : String(event.projectId),
        campaignId: event.campaignId == null || event.campaignId === "" ? null : String(event.campaignId),
        campaignRole: event.campaignRole === "director" || event.campaignRole === "child"
          ? event.campaignRole
          : null,
        // docs/09 §4.2：null = 未武装，与空对象不是一回事
        hooks: event.hooks && typeof event.hooks === "object"
          ? {
              timeoutMs: Number(event.hooks.timeoutMs ?? 0),
              events: Array.isArray(event.hooks.events) ? event.hooks.events.map(String) : [],
            }
          : null,
        // docs/09 §4.7：null = 本 run 没加载任何 AGENT.md。guidance 必须保住。
        agentMd: event.agentMd && typeof event.agentMd === "object" && Array.isArray(event.agentMd.files)
          ? {
              files: event.agentMd.files.map((f) => ({
                path: String(f?.path ?? ""),
                layer: String(f?.layer ?? "project"),
                chars: Number(f?.chars ?? 0),
                truncated: f?.truncated === true,
              })).filter((f) => f.path),
              chars: Number(event.agentMd.chars ?? 0),
              truncated: event.agentMd.truncated === true,
              maxChars: Number(event.agentMd.maxChars ?? 0),
              guidance: true,
            }
          : null,
        // 工作区 git 身份：跟 workdir 走。不列出就会被白名单投影静默丢弃。
        workspaceGit: normalizeWorkspaceGit(event.workspaceGit),
        // 点名引用：不列进白名单就会静默丢弃，对话里看不见引用了谁/哪些文件
        cited: Array.isArray(event.cited)
          ? event.cited.map((c) => ({
              runId: String(c?.runId ?? ""),
              title: String(c?.title ?? ""),
              artifacts: Array.isArray(c?.artifacts) ? c.artifacts.map(String) : [],
              ...(c?.workdirLabel ? { workdirLabel: String(c.workdirLabel) } : {}),
            })).filter((c) => c.runId)
          : null,
      },
    };
  }
  if (type === "usage") {
    return applyUsage(state, event);
  }
  if (type === "progress") {
    // 整表替换；不进时间线——右栏 Progress 是唯一呈现面，进日志只会吵
    const items = Array.isArray(event.items)
      ? event.items.map((it) => ({
          id: String(it?.id ?? ""),
          title: String(it?.title ?? ""),
          status: ["pending", "running", "done", "skipped"].includes(it?.status)
            ? it.status
            : "pending",
        })).filter((it) => it.id && it.title)
      : [];
    return { ...state, progressItems: items };
  }
  if (type === "verification") {
    return applyVerification(state, seq, event);
  }
  if (type === "file_rewind_snapshot") {
    const snap = {
      seq,
      toolUseId: String(event.toolUseId ?? ""),
      tool: String(event.tool ?? ""),
      path: String(event.path ?? ""),
      existed: event.existed === true,
      bytes: Number(event.bytes ?? 0),
      ...(event.skipped ? { skipped: String(event.skipped) } : {}),
    };
    const entry = stampAt(buildTimelineEntry(seq, source, type, event), sseEvent);
    return {
      ...state,
      fileRewindSnapshots: [...(state.fileRewindSnapshots ?? []), snap],
      timeline: [...state.timeline, entry],
    };
  }
  if (type === "conversation_rewound") {
    const entry = stampAt(buildTimelineEntry(seq, source, type, event), sseEvent);
    return {
      ...state,
      rewindFrom: {
        parentRunId: String(event.parentRunId ?? ""),
        seq: Number(event.seq ?? -1),
        revertFiles: event.revertFiles === true,
      },
      timeline: [...state.timeline, entry],
    };
  }

  // 其余事件进入时间线
  const entry = stampAt(buildTimelineEntry(seq, source, type, event), sseEvent);
  const isVerifier = isVerifierSource(source);

  // V-12：tool_result 事件不带工具名（src/loop.ts 只发 toolUseId），日志里就成了
  // "toolu_01AbC... 成功"。靠 tool_call 记下的映射回填。
  let toolNames = state.toolNames;
  if (type === "tool_call" && entry.toolUseId) {
    toolNames = { ...toolNames, [entry.toolUseId]: entry.name };
  } else if (type === "tool_result" && entry.toolUseId && toolNames[entry.toolUseId]) {
    entry.name = toolNames[entry.toolUseId];
  }

  return {
    ...state,
    toolNames,
    timeline: isVerifier ? state.timeline : [...state.timeline, entry],
    verifierTimeline: isVerifier ? [...state.verifierTimeline, entry] : state.verifierTimeline,
  };
}

/**
 * 逐轮 token（V-09）。
 *
 * 此前这类事件落进 default 分支，被渲染成一条图标「•」、动作名「usage」、
 * 详情空白的噪声行——每轮一条。而它是**唯一**能提前算出"上下文快满了"的信号：
 * ContextManager 就是拿 input+cacheW+cacheR 对上限判是否要压缩的。
 * @returns {RunState}
 */
function applyUsage(state, event) {
  const u = /** @type {any} */ (event.usage) ?? {};
  const bd = event.breakdown && typeof event.breakdown === "object" ? event.breakdown : null;
  return {
    ...state,
    usageByTurn: [
      ...state.usageByTurn,
      {
        turn: Number(event.turn ?? state.usageByTurn.length + 1),
        input: Number(u.input_tokens ?? 0),
        cacheCreation: Number(u.cache_creation_input_tokens ?? 0),
        cacheRead: Number(u.cache_read_input_tokens ?? 0),
        output: Number(u.output_tokens ?? 0),
        ...(bd
          ? {
              breakdown: {
                system: Number(bd.system ?? 0),
                toolsBuiltin: Number(bd.toolsBuiltin ?? 0),
                toolsMcp: Number(bd.toolsMcp ?? 0),
                memory: Number(bd.memory ?? 0),
                summarized: Number(bd.summarized ?? 0),
                conversation: Number(bd.conversation ?? 0),
                unallocated: Number(bd.unallocated ?? 0),
                estimated: true,
              },
            }
          : {}),
      },
    ],
  };
}

/** 逐轮核查裁决（V-08）：中间轮的 issues 就是"为什么要返工"。@returns {RunState} */
function applyVerification(state, seq, event) {
  const raw = /** @type {any} */ (event.verdict) ?? {};
  return {
    ...state,
    verifications: [
      ...state.verifications,
      {
        round: Number(event.round ?? state.verifications.length),
        // 会话中心化：裁决只对它核查的那一轮负责——轮号与事件序号一起带走，
        // 对话里才能把它放回它出炉的位置、并标明判的是第几轮
        judgedTurn: Number.isFinite(Number(event.judgedTurn)) && event.judgedTurn !== undefined
          ? Number(event.judgedTurn)
          : null,
        seq: typeof seq === "number" ? seq : null,
        // 裁决获得路径（第五次提醒：这是逐字段白名单投影，不列出就静默丢弃）
        recovery: event.recovery ? String(event.recovery) : null,
        verdict: {
          passed: Boolean(raw.passed),
          summary: String(raw.summary ?? ""),
          issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
          unverified: Array.isArray(raw.unverified) ? raw.unverified.map(String) : [],
          advisory: Array.isArray(raw.advisory) ? raw.advisory.map(String) : [],
        },
        usage: event.usage ?? null,
      },
    ],
  };
}

/**
 * 上下文水位（V-09）。
 *
 * 口径要害：
 *   · 窗口占用 lastInputTokens = input + cacheW + cacheR（模型看见多少）
 *   · 压缩判据 lastFreshTokens = input + cacheW（**不含 cache_read**，与
 *     ContextManager / turnTokenCost 同口径）。cache_read 是重读已缓存前缀，
 *     算进 150k 预算会让「下一轮将压缩」在缓存命中后变成假警报。
 *   · 都是**最近一轮**赋值，不是全 run 累计。
 *
 * @param {RunState} state
 * @param {number|null} contextTokenLimit
 * @returns {{lastInputTokens:number, lastFreshTokens:number, limit:number|null, ratio:number|null,
 *   watermark:number, split:{input:number,cacheCreation:number,cacheRead:number},
 *   cumulative:{input:number,cacheCreation:number,cacheRead:number,output:number},
 *   cacheHitRatio:number}}
 */
export function deriveContextUsage(state, contextTokenLimit) {
  const last = state.usageByTurn[state.usageByTurn.length - 1];
  const split = last
    ? { input: last.input, cacheCreation: last.cacheCreation, cacheRead: last.cacheRead }
    : { input: 0, cacheCreation: 0, cacheRead: 0 };
  const lastInputTokens = split.input + split.cacheCreation + split.cacheRead;
  const lastFreshTokens = split.input + split.cacheCreation;

  const cumulative = state.usageByTurn.reduce(
    (a, t) => ({
      input: a.input + t.input,
      cacheCreation: a.cacheCreation + t.cacheCreation,
      cacheRead: a.cacheRead + t.cacheRead,
      output: a.output + t.output,
    }),
    { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
  );

  const denom = cumulative.input + cumulative.cacheCreation + cumulative.cacheRead;
  return {
    lastInputTokens,
    lastFreshTokens,
    limit: contextTokenLimit ?? null,
    ratio: contextTokenLimit ? lastFreshTokens / contextTokenLimit : null,
    watermark: 0.8,
    split,
    cumulative,
    cacheHitRatio: denom > 0 ? cumulative.cacheRead / denom : 0,
  };
}

/**
 * 批量折叠一批事件——控制器的真实入口。
 *
 * 相比逐条 reduceEvent 有两点不同，都是必要的：
 * ① 幂等：seq ≤ lastSeq 的事件直接丢弃。SSE 断线重连会带 Last-Event-ID 续传，
 *    但服务端可能全量重放（或客户端重复订阅），没有这道闸门就会出现重复的
 *    时间线条目与重复的审批卡。
 * ② 一批只做一次数组拷贝的语义边界，供渲染层按批重绘（消 O(n²)）。
 *
 * reduceEvent 保持"单事件、不设闸门"的旧语义：既有测试用固定 seq=0 构造事件流，
 * 在那里加闸门会把第二条以后的事件全丢掉。真实路径一律走本函数。
 *
 * @param {RunState} state
 * @param {{seq:number, source:string, event:Record<string,unknown>}[]} sseEvents
 * @returns {RunState}
 */
export function reduceEvents(state, sseEvents) {
  let next = state;
  for (const e of annotateResolvedApprovals(sseEvents)) {
    if (typeof e.seq === "number" && e.seq <= next.lastSeq) continue;
    next = reduceEvent(next, e);
    if (typeof e.seq === "number" && e.seq > next.lastSeq) {
      next = { ...next, lastSeq: e.seq };
    }
  }
  return next;
}

/**
 * 同一批里已经有对应的 approval_resolved / expired 时，把 request 标成
 * autoResolved。切对话重放、或自动放行的 request+resolved 分两帧到达前，
 * 都不应先画出一张「待你决定」再闪没。
 *
 * requestSeq 对得上优先；对不上时若该 toolUseId 只有一条已决，也认——
 * 旧档案 / 缺字段的 expired 帧否则会留下一张点不掉的幽灵卡。
 */
export function annotateResolvedApprovals(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return queue ?? [];
  const resolved = new Map();
  const byTool = new Map();
  for (const item of queue) {
    const ev = item?.event;
    if (!ev || (ev.type !== "approval_resolved" && ev.type !== "approval_expired")) continue;
    const toolUseId = String(ev.toolUseId ?? "");
    if (!toolUseId) continue;
    const requestSeq = Number(ev.requestSeq);
    if (Number.isFinite(requestSeq)) resolved.set(`${toolUseId}#${requestSeq}`, ev);
    else {
      // 旧档案缺 requestSeq：仅在该 toolUseId 唯一时兜底，避免返工轮复用 id 串卡。
      const list = byTool.get(toolUseId) ?? [];
      list.push(ev);
      byTool.set(toolUseId, list);
    }
  }
  if (resolved.size === 0 && byTool.size === 0) return queue;
  let changed = false;
  const next = queue.map((item) => {
    const ev = item?.event;
    if (!ev || ev.type !== "approval_request" || ev.autoResolved === true) return item;
    const toolUseId = String(ev.toolUseId ?? "");
    const exact = resolved.get(`${toolUseId}#${item.seq}`);
    const fallback = byTool.get(toolUseId);
    const hit = exact ?? (fallback?.length === 1 ? fallback[0] : undefined);
    if (!hit) return item;
    changed = true;
    return {
      ...item,
      event: {
        ...ev,
        autoResolved: true,
        decision: hit.type === "approval_expired" ? "deny" : (hit.decision ?? "allow"),
        actor: hit.actor,
        ...(hit.type === "approval_expired" ? { expired: true } : {}),
      },
    };
  });
  return changed ? next : queue;
}

/**
 * 还没对上 resolved/expired 的 approval_request 先扣下。
 * 跨 rAF 的自动放行、以及 replay 超时切批，都靠这一层避免先画待决卡。
 */
export function partitionSettledApprovals(queue) {
  const annotated = annotateResolvedApprovals(queue);
  /** @type {any[]} */
  const ready = [];
  /** @type {any[]} */
  const hold = [];
  for (const item of annotated) {
    const ev = item?.event;
    if (ev?.type === "approval_request" && ev.autoResolved !== true) hold.push(item);
    else ready.push(item);
  }
  return { ready, hold };
}

/** 真人闸门才亮卡；配对窗口刻意短，免得真审批被挡住。 */
export const APPROVAL_SETTLE_MS = 160;

/**
 * 跨批扣住未配对的 approval_request。
 * `force` 或超过 settleMs 才放行——那才是真的要人点的卡。
 */
export function createApprovalSettleGate(opts = {}) {
  const settleMs = Number.isFinite(opts.settleMs) ? Number(opts.settleMs) : APPROVAL_SETTLE_MS;
  /** @type {Map<string, { items: any[], since: number }>} */
  const byRun = new Map();
  return {
    /**
     * @param {string} runId
     * @param {any[]} queue
     * @param {{ now?: number, force?: boolean }} [t]
     */
    ingest(runId, queue, t = {}) {
      const now = Number.isFinite(t.now) ? Number(t.now) : Date.now();
      const prev = byRun.get(runId);
      const { ready, hold } = partitionSettledApprovals([...(prev?.items ?? []), ...(queue ?? [])]);
      if (hold.length === 0) {
        byRun.delete(runId);
        return { ready, hold: [], settleInMs: null };
      }
      const since = prev?.items?.length ? prev.since : now;
      if (t.force === true || now - since >= settleMs) {
        byRun.delete(runId);
        return { ready: [...ready, ...hold], hold: [], settleInMs: null };
      }
      byRun.set(runId, { items: hold, since });
      return { ready, hold, settleInMs: Math.max(0, settleMs - (now - since)) };
    },
    pending(runId) {
      return byRun.get(runId)?.items ?? [];
    },
    clear(runId) {
      byRun.delete(runId);
    },
  };
}

/**
 * 首订 EventSource 时先攒历史帧，等 replay_done（或超时）再一次交给 batcher。
 * 切会话重放若按 rAF 切开，审批卡会先待决再消失。
 */
export function createReplayGate() {
  let released = false;
  /** @type {any[]} */
  const held = [];
  return {
    get released() {
      return released;
    },
    /**
     * @param {any} item
     * @returns {any[] | null} 已放行则把这条立刻交出去；仍在攒则 null
     */
    hold(item) {
      if (released) return [item];
      held.push(item);
      return null;
    },
    /** @returns {any[]} */
    release() {
      if (released) return [];
      released = true;
      return held.splice(0, held.length);
    },
    /** 超时放行前：还在攒着未配对的审批就再等 replay_done，避免先画幽灵卡。 */
    hasUnpairedApprovalRequest() {
      return partitionSettledApprovals(held).hold.length > 0;
    },
  };
}

/** 来源是否属于 verifier（放开为字符串后要兼容 "s1/verifier" 这类编排来源） */
function isVerifierSource(source) {
  return source === "verifier" || (typeof source === "string" && source.endsWith("/verifier"));
}

/** planner/verifier 都在内部自答；宿主不得再挂一张「待你决定」。 */
export function isInternallyResolvedApprovalSource(source) {
  const s = String(source ?? "");
  return s === "verifier" || s.endsWith("/verifier") || s === "planner" || s.endsWith("/planner");
}

/** 已收工的 run 不能再有活人闸门——残留 pending 就是切会话时的幽灵卡。 */
export function runHasClosed(state) {
  return Boolean(state?.status === "done" || state?.archived || state?.runEnd);
}

/**
 * 主坞真正该亮的待决审批。已结束 / 子代理 / 内部自答一律不算。
 * @param {RunState} state
 */
export function visiblePendingApprovals(state) {
  if (!state || runHasClosed(state)) return [];
  return (state.pendingApprovals ?? []).filter(
    (a) =>
      a.status === "pending" &&
      !isChildAgentSource(a.source) &&
      !isInternallyResolvedApprovalSource(a.source),
  );
}

const PARENT_EVENT_SOURCES = new Set(["main", "rework", "planner", "verifier", "host", "model"]);

/**
 * 并行子代理的聚合键。
 *   spawn/查寄存器  → 一条 spawn 支线
 *   s1/main、s1/verifier → 编排子任务 s1
 * 主对话只认 main/rework/planner/verifier/host，其余都进「子代理工作中」。
 */
export function childAgentKey(source) {
  const s = String(source ?? "");
  if (!s) return null;
  if (s.startsWith("spawn/")) return s;
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  const head = s.slice(0, slash);
  if (PARENT_EVENT_SOURCES.has(head)) return null;
  return head;
}

export function isChildAgentSource(source) {
  return childAgentKey(source) != null;
}

/**
 * 直播思考/正文只跟执行者。规划者/核查者的增量不抢主对话。
 * 编排子任务的执行者是 `s1/main`，spawn 支线是 `spawn/…`——只认 `main`
 * 会让计划模式下整段 Thinking 消失（增量在，界面没有）。
 */
export function isLiveDeltaSource(source) {
  const s = String(source ?? "");
  if (s === "main" || s === "rework") return true;
  if (s === "planner" || s === "verifier") return false;
  if (s.endsWith("/planner") || s.endsWith("/verifier")) return false;
  if (s.endsWith("/main")) return true;
  if (s.startsWith("spawn/")) return true;
  return false;
}

export function spawnAgentId(title) {
  return `spawn/${String(title ?? "").slice(0, 40)}`;
}

/** 导演条：campaign_child + 带 runId 的 spawn 事件。 */
export function deriveCampaignChildren(state) {
  const byId = new Map();
  for (const e of state?.timeline ?? []) {
    if (e.type === "campaign_child" && e.runId) {
      byId.set(String(e.runId), {
        runId: String(e.runId),
        title: String(e.title ?? ""),
        status: String(e.status ?? "running"),
      });
    }
    if ((e.type === "spawn_start" || e.type === "spawn_done") && e.runId) {
      const prev = byId.get(String(e.runId)) ?? {
        runId: String(e.runId),
        title: String(e.title ?? ""),
        status: "running",
      };
      if (e.type === "spawn_done") prev.status = e.passed === true ? "done" : "error";
      if (e.title) prev.title = String(e.title);
      byId.set(String(e.runId), prev);
    }
  }
  return [...byId.values()];
}

/**
 * 从时间线收出当前 run 的子代理列表（编排子任务 + spawn 支线）。
 * 没开跑的计划节点不进这里——计划卡已经有它们。
 */
export function deriveChildAgents(state) {
  const byId = new Map();
  const ensure = (id, extras = {}) => {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: extras.title || String(id).replace(/^spawn\//, ""),
        kind: extras.kind || (String(id).startsWith("spawn/") ? "spawn" : "plan"),
        status: extras.status || "running",
        pendingApprovals: 0,
        lastText: "",
        peek: "",
        seq: extras.seq ?? 0,
        started: extras.started === true,
      });
    }
    const row = byId.get(id);
    if (extras.title && !row.title) row.title = extras.title;
    if (Number.isFinite(extras.seq) && (row.seq === 0 || extras.seq < row.seq)) row.seq = extras.seq;
    if (extras.started) row.started = true;
    return row;
  };

  for (const t of state?.plan?.subtasks ?? []) {
    if (t?.id) ensure(String(t.id), { title: String(t.title ?? t.id), kind: "plan", status: "pending", started: false });
  }

  for (const e of state?.timeline ?? []) {
    if (e.type === "spawn_start") {
      const id = spawnAgentId(e.title);
      const a = ensure(id, { title: String(e.title ?? ""), kind: "spawn", seq: e.seq, started: true });
      a.status = "running";
      if (e.runId) a.runId = String(e.runId);
      continue;
    }
    if (e.type === "spawn_done") {
      const id = spawnAgentId(e.title);
      const a = ensure(id, { title: String(e.title ?? ""), kind: "spawn", seq: e.seq, started: true });
      a.status = e.passed === true ? "done" : "error";
      a.lastText = String(e.summary || e.error || "");
      if (e.runId) a.runId = String(e.runId);
      continue;
    }
    const key = childAgentKey(e.source);
    if (!key) continue;
    const planTitle = (state?.plan?.subtasks ?? []).find((t) => t.id === key)?.title;
    const a = ensure(key, {
      title: planTitle || key,
      kind: key.startsWith("spawn/") ? "spawn" : "plan",
      seq: e.seq,
      started: true,
    });
    // 计划先把节点写成 pending；子任务一开始干活必须翻成 running，
    // 否则主对话卡一直显示「等待」，动态效果也挂不上。
    if (a.status === "pending") a.status = "running";
    if (e.type === "assistant_text") {
      const text = String(e.text ?? "").trim();
      if (text) a.lastText = text;
    }
    if (e.type === "tool_call") a.peek = String(e.name ?? "");
    if (e.type === "done") {
      const reason = String(e.stopReason ?? "");
      a.status = reason === "error" || reason === "aborted" ? "error" : "done";
    }
  }

  for (const st of state?.planResult?.steps ?? []) {
    const id = String(st?.id ?? "");
    if (!id) continue;
    const planTitle = (state?.plan?.subtasks ?? []).find((t) => t.id === id)?.title;
    const a = ensure(id, { title: planTitle || id, kind: "plan", started: true });
    a.status = st.passed === false ? "error" : "done";
  }

  if (state.status === "done") {
    for (const a of byId.values()) {
      if (a.status === "running") a.status = "done";
    }
  }

  for (const a of state?.pendingApprovals ?? []) {
    if (a.status !== "pending") continue;
    const key = childAgentKey(a.source);
    if (!key) continue;
    const agent = byId.get(key);
    if (agent) agent.pendingApprovals += 1;
  }

  return [...byId.values()].filter((a) => a.started || a.pendingApprovals > 0);
}

// ---------------------------------------------------------------
// 内部纯 helper
// ---------------------------------------------------------------

/** @returns {TimelineEntry} */
function buildTimelineEntry(seq, source, type, event) {
  const base = { seq, source, type };
  switch (type) {
    case "turn_start":
      return { ...base, turn: /** @type {number} */ (event.turn) };
    case "tool_call":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        name: /** @type {string} */ (event.name),
        input: event.input,
      };
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
    case "tool_failed":
    case "tool_aborted":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        name: /** @type {string} */ (event.name),
        idempotencyKey: String(event.idempotencyKey ?? ""),
        ...(typeof event.inputHash === "string" ? { inputHash: event.inputHash } : {}),
        ...(event.skipped === true ? { skipped: true } : {}),
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      };
    case "mid_tool_replay":
      return {
        ...base,
        runId: String(event.runId ?? ""),
        items: Array.isArray(event.items)
          ? event.items.map((item) => ({
              action: String(item?.action ?? ""),
              toolUseId: String(item?.toolUseId ?? ""),
              name: String(item?.name ?? ""),
            }))
          : [],
      };
    case "tool_result":
      return {
        ...base,
        toolUseId: /** @type {string} */ (event.toolUseId),
        resultContent: event.result && typeof event.result === "object" ? /** @type {string} */ (/** @type {any} */ (event.result).content) : "",
        resultIsError: event.result && typeof event.result === "object" ? Boolean(/** @type {any} */ (event.result).isError) : false,
        durationMs: /** @type {number} */ (event.durationMs),
      };
    case "assistant_text":
      return {
        ...base,
        text: /** @type {string} */ (event.text),
        ...(Number.isFinite(Number(event.at)) ? { at: Number(event.at) } : {}),
      };
    case "assistant_thinking":
      // 逐字段白名单投影：新字段不列出就静默丢弃（本轮第四次踩到这条）
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        text: /** @type {string} */ (event.text ?? ""),
        redacted: Boolean(event.redacted),
      };
    case "api_retry":
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        attempt: /** @type {number} */ (event.attempt),
        reason: /** @type {string} */ (event.reason),
        // 抖动上线后同一 attempt 的等待不再是定值；旧 run 没有这个字段，
        // 只在存在时带上（渲染层据此决定显不显示，不能显示 undefined）
        ...(typeof event.backoffMs === "number" ? { backoffMs: event.backoffMs } : {}),
      };
    case "model_call_start":
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        attempt: /** @type {number} */ (event.attempt),
      };
    case "model_call_end":
      return {
        ...base,
        turn: /** @type {number} */ (event.turn),
        attempt: /** @type {number} */ (event.attempt),
        status: event.status === "ok" ? "ok" : "error",
        durationMs: /** @type {number} */ (event.durationMs),
      };
    // MODEL-01a 端点降级。逐字段白名单投影：不在这里列出的字段静默消失，
    // 而"少显示一行"在界面上看不出来（host-lags 那条纪律的第 N 次现身）
    case "model_fallback":
      return {
        ...base,
        from: String(event.from ?? ""),
        to: String(event.to ?? ""),
        reason: String(event.reason ?? ""),
        turn: Number(event.turn ?? 0),
        ...(event.role ? { role: String(event.role) } : {}),
        ...(event.routing ? { routing: String(event.routing) } : {}),
      };
    case "recovery_decision":
      return {
        ...base,
        reason: String(event.reason ?? ""),
        action: String(event.action ?? ""),
        detail: String(event.detail ?? ""),
        ...(typeof event.extraTurns === "number" ? { extraTurns: event.extraTurns } : {}),
      };
    case "file_rewind_snapshot":
      return {
        ...base,
        toolUseId: String(event.toolUseId ?? ""),
        tool: String(event.tool ?? ""),
        path: String(event.path ?? ""),
        existed: event.existed === true,
        bytes: Number(event.bytes ?? 0),
        ...(event.skipped ? { skipped: String(event.skipped) } : {}),
      };
    case "conversation_rewound":
      return {
        ...base,
        parentRunId: String(event.parentRunId ?? ""),
        rewindSeq: Number(event.seq ?? -1),
        revertFiles: event.revertFiles === true,
        restored: Array.isArray(event.restored) ? event.restored.map(String) : [],
        deleted: Array.isArray(event.deleted) ? event.deleted.map(String) : [],
        gitRestored: Array.isArray(event.gitRestored) ? event.gitRestored.map(String) : [],
        skipped: Array.isArray(event.skipped) ? event.skipped : [],
      };
    case "run_forked":
      return {
        ...base,
        parentRunId: String(event.parentRunId ?? ""),
        rootRunId: String(event.rootRunId ?? event.parentRunId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
      };
    case "run_resumed":
      return {
        ...base,
        runId: String(event.runId ?? ""),
        rootRunId: String(event.rootRunId ?? event.runId ?? ""),
        boundary: String(event.boundary ?? ""),
        inheritedBudget: event.checkpoint && typeof event.checkpoint === "object"
          ? /** @type {any} */ (event.checkpoint).runBudget ?? null
          : null,
        segmentIndex:
          event.checkpoint && typeof event.checkpoint === "object"
            ? /** @type {any} */ (event.checkpoint).segmentIndex ?? null
            : null,
        reset: Array.isArray(event.reset) ? event.reset.map(String) : [],
      };
    case "compaction":
      return {
        ...base,
        droppedBlocks: /** @type {number} */ (event.droppedBlocks),
        ledgerEntries:
          typeof event.ledgerEntries === "number" ? /** @type {number} */ (event.ledgerEntries) : undefined,
        summaryApplied: event.summaryApplied === true,
        // Phase C：折叠了几轮旧对话（正文不可恢复）、是不是撞了端点 400 才压的
        collapsedTurns: typeof event.collapsedTurns === "number" ? event.collapsedTurns : 0,
        reactive: event.reactive === true,
      };
    case "hook":
      return {
        ...base,
        hook: String(event.hook ?? ""),
        outcome: String(event.outcome ?? ""),
        ...(event.tool ? { tool: String(event.tool) } : {}),
        ...(event.toolUseId ? { toolUseId: String(event.toolUseId) } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        timedOut: event.timedOut === true,
        ...(event.detail ? { detail: String(event.detail) } : {}),
      };
    default:
      return base;
  }
}

/** @returns {RunState} */
function applyApproval(state, seq, source, event) {
  const toolUseId = /** @type {string} */ (event.toolUseId);
  const name = /** @type {string} */ (event.name);
  const input = event.input;

  const entry = { seq, source, type: "approval_request", toolUseId, name, input };
  if (Array.isArray(event.resolvedTargets)) {
    entry.resolvedTargets = event.resolvedTargets;
  }

  // planner/verifier 在 drain 里自答 deny，事件只作审计。进待决坞就是幽灵卡。
  if (isInternallyResolvedApprovalSource(source)) {
    if (isVerifierSource(source)) {
      return {
        ...state,
        verifierTimeline: [...state.verifierTimeline, entry],
      };
    }
    return {
      ...state,
      timeline: [...state.timeline, entry],
    };
  }

  // main/rework 审批：进时间线 + 挂起审批列表。
  // requestSeq 是这张卡的身份：返工轮会复用同一个 toolUseId，只有请求序号
  // 能区分"这是第几轮的那次审批"——否则一次点击会改写历史卡（V-03）。
  const autoResolved = event.autoResolved === true;
  const status = autoResolved
    ? (event.expired === true ? "expired" : event.decision === "deny" ? "denied" : "allowed")
    : "pending";
  return {
    ...state,
    timeline: [...state.timeline, entry],
    pendingApprovals: [
      ...state.pendingApprovals,
      {
        toolUseId,
        name,
        input,
        status,
        requestSeq: seq,
        approvalId: `${toolUseId}#${seq}`,
        source,
        ...(autoResolved && event.actor ? { actor: String(event.actor) } : {}),
        ...(Array.isArray(event.resolvedTargets) ? { resolvedTargets: event.resolvedTargets } : {}),
        ...(event.grantPolicy && typeof event.grantPolicy === "object"
          ? { grantPolicy: event.grantPolicy }
          : {}),
      },
    ],
  };
}

/**
 * 服务端宣告的审批决策（V-02）。
 * 决策此前只写在浏览器内存里，刷新即失真——现在以服务端事件为准，
 * 任意客户端重放同一事件流都得到同一份审计记录。
 * @returns {RunState}
 */
function applyApprovalResolved(state, event) {
  const requestSeq = /** @type {number} */ (event.requestSeq);
  const toolUseId = /** @type {string} */ (event.toolUseId);
  const status = event.decision === "allow" ? "allowed" : "denied";
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      matchesApproval(a, requestSeq, toolUseId)
        ? {
            ...a,
            status,
            ...(event.reason ? { reason: String(event.reason) } : {}),
            decidedAt: Number(event.at ?? Date.now()),
            actor: event.actor ? String(event.actor) : undefined,
          }
        : a,
    ),
  };
}

/** 服务端宣告的审批过期（run 结束时逐条发出）。@returns {RunState} */
function applyApprovalExpired(state, event) {
  const requestSeq = /** @type {number} */ (event.requestSeq);
  const toolUseId = /** @type {string} */ (event.toolUseId);
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      matchesApproval(a, requestSeq, toolUseId) && a.status === "pending"
        ? { ...a, status: /** @type {"expired"} */ ("expired") }
        : a,
    ),
  };
}

/** 优先按 requestSeq 精确匹配；缺该字段时退回 toolUseId（兼容旧事件流重放） */
function matchesApproval(approval, requestSeq, toolUseId) {
  if (typeof requestSeq === "number" && typeof approval.requestSeq === "number") {
    return approval.requestSeq === requestSeq;
  }
  return approval.toolUseId === toolUseId;
}

/** @returns {RunState} */
function applyVerdict(state, event) {
  const raw = /** @type {any} */ (event.verdict);
  return {
    ...state,
    verdict: {
      passed: Boolean(raw.passed),
      summary: String(raw.summary ?? ""),
      issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
      unverified: Array.isArray(raw.unverified) ? raw.unverified.map(String) : [],
      advisory: Array.isArray(raw.advisory) ? raw.advisory.map(String) : [],
      // 末轮裁决判的是第几轮对话（会话中心化）；旧事件流没有这个字段
      ...(Number.isFinite(Number(event.judgedTurn)) && event.judgedTurn !== undefined
        ? { judgedTurn: Number(event.judgedTurn) }
        : {}),
    },
  };
}

/**
 * 段终止（V-01 的核心修复点）。
 *
 * `done` 宣告的是**一段**执行结束，不是整个 run 结束。核查模式下
 * `runVerified` 会把主轮的 done 也转发出来，此后还有 verifier 段、可能还有
 * 返工段。旧实现在这里直接把 run 置为 done 并把挂起审批全部作废，导致
 * 返工轮的审批卡不再渲染操作按钮 → respond 永不被调用 → 循环永久 await。
 *
 * 现在：只记录段的终止原因与用量；run 级收敛交给 run_end。
 * 唯一例外是非核查运行——它按协议只有一段，其 done 即 run 终止，
 * 这条快路径同时保住了既有测试的语义。
 *
 * @returns {RunState}
 */
/** done.completion 逐字段投影：blockers 不列出就会在对话面蒸发。 */
function projectCompletion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    status: String(raw.status ?? ""),
    summary: String(raw.summary ?? ""),
    artifacts: list(raw.artifacts),
    verification: list(raw.verification),
    assumptions: list(raw.assumptions),
    blockers: list(raw.blockers),
  };
}

function applySegmentDone(state, event, source = "main") {
  const usage = event.usage && typeof event.usage === "object" ? /** @type {any} */ (event.usage) : null;
  const stopReason = /** @type {string} */ (event.stopReason);
  const errorMessage =
    event.error && typeof event.error === "object"
      ? String(/** @type {any} */ (event.error).message ?? "")
      : "";
  const completion = projectCompletion(event.completion);

  const next = {
    ...state,
    stopReason,
    ...(completion ? { completion } : {}),
    ...(event.runBudget && typeof event.runBudget === "object"
      ? { runBudget: { ...event.runBudget } }
      : {}),
    // 服务端此前把 error 整条丢掉，前端只能写死一句话；现在有真实消息就用真实的
    error: stopReason === "error" ? errorMessage || "运行异常终止" : null,
    usage: usage
      ? {
          turns: Number(usage.turns ?? 0),
          inputTokens: Number(usage.inputTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          cacheHitRatio: Number(usage.cacheHitRatio ?? 0),
        }
      : state.usage,
  };

  /**
   * 单段运行的快路径：非核查模式下不会再有后续段，done 即终止。
   *
   * **必须限定 source === "main"**（真机实测抓到的缺陷）：编排模式下 planner
   * 自己那一轮也发 `done(completed)`，各子任务发 `sN/main` 的 done。不限定来源，
   * 客户端会在 planner 一结束就判定整个 run 结束——控制器随即 `es.close()`，
   * 之后的 plan / plan_result / 子任务进度 / run_end 全部收不到，界面停在
   * "已完成"并把 planner 的 JSON 当成执行者报告展示。
   *
   * 这就是 V-01 那条「段终止 ≠ run 终止」，当时在事件层修过（`done` 只记段，
   * run 级收敛由 `run_end` 宣告），reducer 侧这个快路径漏掉了同一条。
   * 触发条件是 mode=plan 且未勾核查——而那正是选了"计划编排"后的默认组合。
   */
  if (!state.verify && source === "main") {
    return { ...next, status: "done", pendingApprovals: expireAll(next.pendingApprovals) };
  }
  return next;
}

/**
 * run 级终止（服务端 run_end，恒为最后一条 durable 事件）。
 * 幂等——单段快路径可能已经收敛过一次。
 * @returns {RunState}
 */
function applyRunEnd(state, event) {
  const mainStopReason = event.mainStopReason ? String(event.mainStopReason) : state.stopReason;
  return {
    ...state,
    status: "done",
    stopReason: mainStopReason,
    error:
      mainStopReason === "error" ? state.error || "运行异常终止" : state.error,
    pendingApprovals: expireAll(state.pendingApprovals),
    planApproval: state.planApproval?.status === "pending"
      ? { ...state.planApproval, status: "expired" }
      : state.planApproval,
    // 末轮之前若未收到 verification 事件（如旧事件流重放），用 run_end 里的补齐
    verifications:
      state.verifications.length > 0 || !Array.isArray(event.verifications)
        ? state.verifications
        : /** @type {any[]} */ (event.verifications).map((v, i) => ({
            round: Number(v.round ?? i),
            judgedTurn: Number.isFinite(Number(v.judgedTurn)) && v.judgedTurn !== undefined
              ? Number(v.judgedTurn)
              : null,
            seq: null,
            verdict: v.verdict,
            usage: v.usage ?? null,
          })),
    runEnd: {
      outcome: String(event.outcome ?? "completed"),
      ...(mainStopReason ? { mainStopReason } : {}),
      finishedAt: Number(event.finishedAt ?? Date.now()),
      ...(event.finalPassed !== undefined ? { finalPassed: Boolean(event.finalPassed) } : {}),
      ...(event.reworks !== undefined ? { reworks: Number(event.reworks) } : {}),
      // V-07：成本口径。executionUsage 含被否掉的中间轮，是唯一正确的执行成本；
      // verificationUsage 是核查侧开销，两者分列不混。
      ...(event.executionUsage ? { executionUsage: event.executionUsage } : {}),
      ...(event.verificationUsage ? { verificationUsage: event.verificationUsage } : {}),
      // OBS-02 成本。逐字段白名单投影（第 N 次提醒：不列出就静默丢弃），
      // 每个字段都要——只取 usd 的话，"为什么没有数字"就永远说不出口
      ...(event.cost && typeof event.cost === "object"
        ? {
            cost: {
              usd:
                typeof /** @type {any} */ (event.cost).usd === "number"
                  ? Number(/** @type {any} */ (event.cost).usd)
                  : null,
              byRole: /** @type {any} */ (event.cost).byRole ?? {},
              unpricedRoles: Array.isArray(/** @type {any} */ (event.cost).unpricedRoles)
                ? /** @type {any} */ (event.cost).unpricedRoles.map(String)
                : [],
              unpricedTokens: Number(/** @type {any} */ (event.cost).unpricedTokens ?? 0),
              reason: String(/** @type {any} */ (event.cost).reason ?? "unknown"),
              pack: /** @type {any} */ (event.cost).pack
                ? String(/** @type {any} */ (event.cost).pack)
                : null,
            },
          }
        : {}),
    },
  };
}

/**
 * 成本文案（OBS-02）。
 *
 * 一条纪律：**算不出来就说算不出来，绝不显示 $0.00**。未登记单价的模型
 * 显示 0 元，在账单来之前都长得像"这个模型不花钱"。三种"没有数字"的原因
 * 分开说——运维要能一眼分出该去登记单价、还是价表本身坏了。
 * @returns {{text: string, title: string, known: boolean}|null}
 */
export function deriveCostFace(state) {
  const cost = state.runEnd && state.runEnd.cost;
  if (!cost) return null;
  const packSuffix = cost.pack ? `（${cost.pack}）` : "";
  if (typeof cost.usd === "number") {
    const text = cost.usd < 0.01 ? `$${cost.usd.toFixed(4)}` : `$${cost.usd.toFixed(2)}`;
    const roles = Object.entries(cost.byRole || {})
      .map(([role, v]) => `${role} $${Number(v).toFixed(4)}`)
      .join("｜");
    return { text: `成本${packSuffix}：${text}`, title: roles || "按角色明细不可用", known: true };
  }
  const why =
    cost.reason === "price_table_error"
      ? "单价表读取失败，本次不折算"
      : cost.reason === "no_usage"
        ? "本次没有模型调用记账"
        : `单价未登记：${(cost.unpricedRoles || []).join("、") || "未知角色"}`;
  return {
    text: `成本${packSuffix}：${why}`,
    title:
      cost.unpricedTokens > 0
        ? `${cost.unpricedTokens} token 没折算成钱——登记单价（AGENT_PRICE_TABLE）后即可`
        : why,
    known: false,
  };
}

/** stopReason 色调 → 状态徽章 class */
function toneClass(tone) {
  if (tone === "bad") return "status--error";
  if (tone === "warn") return "status--warn";
  return "status--done";
}

function expireAll(approvals) {
  return approvals.map((a) =>
    a.status === "pending" ? { ...a, status: /** @type {"expired"} */ ("expired") } : a,
  );
}

// ---------------------------------------------------------------
// v2 R4：四决定因素派生层 (V-17)
//
// 组织原则来自 docs/01-philosophy.md:5-12——模型能力固定时，agent 表现的
// 差异全部落在 Loop / Tools / Context / Verification 四处。所以控制台首屏
// 呈现的是这四个面的当前状态，日志退为它们的下钻内容，而不是反过来。
// 全部是纯函数，可在 node 环境直测。
// ---------------------------------------------------------------

/** verifier 输出无法解析时的哨兵（与 src/verifier.ts:303 逐字一致） */
export const VERDICT_PARSE_FAIL = "verifier 输出无法解析为 JSON 裁决";

/** 写类工具：会改变外部世界的那些，用于识别"零写入返工" */
const WRITE_TOOLS = new Set(["write_file", "write_pptx", "memory_write", "bash"]);

/** 能从入参直接读出产物路径的写类工具。bash 不在其中——见 deriveArtifacts 的说明 */
const ARTIFACT_TOOLS = new Set(["write_file", "write_pptx", "edit_file", "memory_write"]);

/** source → 角色。前缀式来源（"s1/main"）为并行编排预留 */
function segmentRole(source) {
  if (source === "planner") return "planner";
  if (isVerifierSource(source)) return "verifier";
  const tail = typeof source === "string" && source.includes("/")
    ? source.slice(source.lastIndexOf("/") + 1)
    : source;
  return tail === "rework" ? "rework" : "main";
}

/**
 * 把时间线切成段：main → verifier → rework → verifier …
 *
 * 存在的理由：此前日志把三种来源按 seq 混排，标题写着"Agent 执行"却混着核查
 * 条目，"第 1 轮"出现四次而看不出属于哪一段（V-11）。CLI 有明确的黄色
 * `↺ 核查未通过，开始返工…` 分界（src/cli.ts:449），Web 一直没有。
 *
 * @param {RunState} state
 * @returns {{index:number, source:string, role:string, round:number, startSeq:number, endSeq:number, entries:TimelineEntry[]}[]}
 */
export function deriveSegments(state) {
  const all = [...state.timeline, ...state.verifierTimeline].sort((a, b) => a.seq - b.seq);
  const segments = [];
  let current = null;
  const roundOf = { main: 0, rework: 0, verifier: 0 };

  for (const entry of all) {
    if (!current || current.source !== entry.source) {
      const role = segmentRole(entry.source);
      const round = role === "main" ? 0 : roundOf[role]++ + (role === "rework" ? 1 : 0);
      current = {
        index: segments.length,
        source: entry.source,
        role,
        round,
        startSeq: entry.seq,
        endSeq: entry.seq,
        entries: [],
      };
      segments.push(current);
    }
    current.endSeq = entry.seq;
    current.entries.push(entry);
  }
  return segments;
}

/**
 * Progress 面：执行者清单 +（若有）编排子任务。两套并列不互相覆盖。
 * @param {RunState} state
 * @param {ReturnType<typeof derivePlanFace>} plan
 * @param {{ hasSessionFiles?: boolean }} [extras]
 */
export function deriveProgressFace(state, plan, extras) {
  const items = Array.isArray(state.progressItems) ? state.progressItems : null;
  const settled = state?.status === "done";
  const hasSessionFiles = Boolean(extras?.hasSessionFiles);
  return {
    items,
    // 右栏已经有落盘文件时再写「等待拆步…」就是和产物条对着干。
    waiting: settled || hasSessionFiles ? false : (!items || items.length === 0),
    doneCount: items ? items.filter((i) => i.status === "done").length : 0,
    total: items ? items.length : 0,
    plan,
    settled,
    hasSessionFiles,
  };
}

/**
 * 编排面（V-27）：依赖图、每个子任务的状态与耗时、并行收益。
 *
 * 依赖图按**层**呈现而不是画自由图：层 = 依赖深度，同层意味着互不依赖、
 * 可并发。这正是并行调度真正在做的决策，也是"为什么能省时间"的解释。
 * 手写图布局既贵又不会更清楚。
 *
 * 返回 null 表示这次运行不是编排模式——调用方据此决定要不要渲染这一块。
 */
export function derivePlanFace(state) {
  const plan = state.plan;
  if (!plan) return null;

  const subs = plan.subtasks;
  const byId = new Map(subs.map((t) => [t.id, t]));
  const result = state.planResult;
  const stepById = new Map((result?.steps ?? []).map((st) => [st.id, st]));
  const skipped = new Set((result?.skipped ?? []).map((x) => x.id));

  // 哪些子任务已经开跑：来源形如 "s1/main"，前缀即子任务 id
  const started = new Set();
  for (const e of [...state.timeline, ...state.verifierTimeline]) {
    const src = String(e.source ?? "");
    if (src.includes("/")) started.add(src.slice(0, src.indexOf("/")));
  }

  const statusOf = (id) => {
    const st = stepById.get(id);
    if (st) return st.passed ? "passed" : "failed";
    if (skipped.has(id)) return "skipped";
    if (started.has(id)) return "running";
    return "pending";
  };

  // 依赖深度 = 层号。带记忆的深度优先，环在服务端已 fail-closed 挡掉，
  // 这里仍留一道访问标记防御——前端不该因为一份脏数据栈溢出
  const depth = new Map();
  const computing = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (computing.has(id)) return 0;
    computing.add(id);
    const t = byId.get(id);
    const deps = Array.isArray(t?.dependsOn) ? t.dependsOn : [];
    const d = !t || deps.length === 0
      ? 0
      : Math.max(...deps.map((p) => depthOf(p) + 1));
    computing.delete(id);
    depth.set(id, d);
    return d;
  };

  const nodes = subs.map((t) => ({
    ...t,
    description: typeof t.description === "string" ? t.description : "",
    acceptance: Array.isArray(t.acceptance) ? t.acceptance.map(String) : [],
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    depth: depthOf(t.id),
    status: statusOf(t.id),
    durationMs: stepById.get(t.id)?.durationMs ?? null,
    reworks: stepById.get(t.id)?.reworks ?? null,
    verdict: stepById.get(t.id)?.verdict ?? null,
  }));

  const layers = [];
  for (const n of nodes) {
    (layers[n.depth] ??= []).push(n);
  }

  const maxDuration = Math.max(1, ...nodes.map((n) => n.durationMs ?? 0));
  return {
    concurrency: plan.concurrency,
    concurrencyMode: plan.concurrencyMode,
    plannerMs: plan.plannerMs,
    nodes,
    layers: layers.map((l) => l ?? []),
    // 层宽 = 理论最大并发；与实际并行度并列显示才看得出调度有没有吃满
    parallelWidth: Math.max(1, ...layers.map((l) => (l ?? []).length)),
    maxDuration,
    timing: result?.timing ?? null,
    completed: result?.completed ?? null,
    planned: result ? result.planned !== false : null,
    plannerRaw: result?.plannerRaw ?? null,
    // B0：区分"胡言乱语"与"探索没来得及收口"——两者的返工策略完全不同
    plannerRecovery: result?.plannerRecovery ?? null,
    plannerFailure: result?.plannerFailure ?? null,
    warnings: state.planWarnings,
    skipped: result?.skipped ?? [],
    // 计划确认门的审计记录（§5.1）。挂起态归 ActionRail（那是"需你现在决定"
    // 的地方）；已决/过期归这里——它是这份计划的历史，不是待办事项。
    // 两处不重复展示同一条，口径同 V-16。
    gate: state.planApproval ?? null,
  };
}

/**
 * Loop 面：轮次水位、六值终止、返工裁决序列。
 * @param {RunState} state
 * @param {object|null} harness `/api/harness` 快照
 */
export function deriveLoopFace(state, harness) {
  const isRunning = state.status === "running";
  // 逐 run 装配优先于进程级快照——用户选了别的包时，护栏也跟着换
  const rc = state.runConfig;
  const maxTurns = rc?.guardrails?.maxTurns ?? harness?.guardrails?.maxTurns ?? null;

  // 轮次取执行侧（main/rework）的最大 turn_start——核查轮预算独立，不该混进来
  let turn = 0;
  for (const e of state.timeline) {
    // planner 是只读拆解，预算与执行者解耦，不并入轮次水位
    if (e.source === "planner") continue;
    if (e.type === "turn_start" && typeof e.turn === "number" && e.turn > turn) turn = e.turn;
  }

  const segments = deriveSegments(state);
  const verdictOf = (round) => state.verifications.find((v) => v.round === round)?.verdict ?? null;
  let verifierSeen = 0;
  const chain = segments.map((s) => {
    if (s.role !== "verifier") return { role: s.role, round: s.round, passed: null };
    const v = verdictOf(verifierSeen++);
    return { role: "verifier", round: s.round, passed: v ? Boolean(v.passed) : null };
  });

  return {
    isRunning,
    turn,
    maxTurns,
    ratio: maxTurns ? Math.min(turn / maxTurns, 1) : null,
    nearLimit: Boolean(maxTurns && turn / maxTurns >= 0.8),
    stopReason: isRunning ? null : deliveryFace(state.stopReason, deriveArtifacts(state)),
    chain,
    reworks: state.runEnd?.reworks ?? segments.filter((s) => s.role === "rework").length,
    retries: state.timeline.filter((e) => e.type === "api_retry"),
    // 端点降级与同轮重试分开计：一个是"同一家再试一次"，一个是"换了一家"，
    // 混成一个数字就再也答不出"这次运行到底是谁应答的"
    fallbacks: state.timeline.filter((e) => e.type === "model_fallback"),
    effort: rc?.effort ?? harness?.effort ?? null,
    effortApplies: Boolean(rc ? rc.effortApplies : harness?.effortApplies),
    // 恢复策略：逐 run 优先于进程级快照（编排下各子任务的包可声明不同的续跑额度）。
    // 与它管着的那几条 recovery_decision 放在同一个面上——策略与它的触发记录并排
    recovery: rc?.recovery ?? normalizeRecoveryConfig(harness?.recovery) ?? null,
    recoveryDecisions: state.timeline.filter((e) => e.type === "recovery_decision"),
    hooks: rc?.hooks ?? null,
    hookEvents: state.timeline.filter((e) => e.type === "hook"),
  };
}

/**
 * 恢复策略一行文案（Loop 卡 / 状态条共用）。
 * armed=false 时明说"关"——数字照配着但 loop 不读它们，把它画成"续跑 8 轮"就是谎话。
 * 来源只在**非默认**时标注：全默认时"（默认）"一个词就够，逐字段标三遍是噪声。
 */
export function describeRecoveryPolicy(recovery) {
  if (!recovery) return null;
  if (!recovery.armed) return "恢复：关（完成门关闭，到轮数上限即停）";
  const src = (f) => (recovery.sources?.[f] === "env" ? "·env" : recovery.sources?.[f] === "pack" ? "·包" : "");
  const allDefault = ["progressExtensionTurns", "stagnationWindow", "maxStagnationRecoveries"]
    .every((f) => !src(f));
  return (
    `恢复：续跑 ${recovery.progressExtensionTurns} 轮${src("progressExtensionTurns")}` +
    ` · 停滞窗 ${recovery.stagnationWindow}${src("stagnationWindow")}` +
    ` · 换策略 ${recovery.maxStagnationRecoveries} 次${src("maxStagnationRecoveries")}` +
    (allDefault ? "（默认）" : "")
  );
}

/**
 * 卡住空转要当场看得见，不能只进台账。
 * 最近一条 stagnation / end_turn_without_completion 之后还没有工具或正文，才算仍在空转。
 */
export function deriveSpinState(state) {
  if (state.status !== "running") return null;
  const timeline = state.timeline ?? [];
  let last = -1;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].type === "recovery_decision") {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const ev = timeline[last];
  const stall = ev.reason === "end_turn_without_completion" || ev.reason === "stagnation";
  if (!stall) return null;
  const after = timeline.slice(last + 1);
  if (after.some((e) => e.type === "tool_call" || e.type === "assistant_text" || e.type === "done")) {
    return null;
  }
  return {
    reason: ev.reason,
    action: ev.action,
    detail: String(ev.detail ?? ""),
    label: "空转 · 可停止",
  };
}

function costTokensOfTurn(row) {
  return Number(row?.input ?? 0) + Number(row?.output ?? 0) + Number(row?.cacheCreation ?? 0);
}

/**
 * 烧起来之前的预警：接近轮次/token 预算，或本轮已经很贵。
 * 不是新账单。运行结束后改由 deriveCostFace 报账。
 */
export function deriveCostWarning(state, harness) {
  if (state.status !== "running") return null;
  const loop = deriveLoopFace(state, harness);
  const g = state.runConfig?.guardrails ?? harness?.guardrails ?? null;
  const maxTokens = typeof g?.maxTokens === "number" && g.maxTokens > 0 ? g.maxTokens : null;
  const bits = [];
  if (loop.nearLimit && loop.maxTurns) {
    bits.push(`轮次已用 ${loop.turn}/${loop.maxTurns}`);
  }
  const used = (state.usageByTurn ?? []).reduce((n, row) => n + costTokensOfTurn(row), 0);
  const last = (state.usageByTurn ?? []).at(-1);
  const lastTokens = last ? costTokensOfTurn(last) : 0;
  if (maxTokens && used / maxTokens >= 0.8) {
    bits.push(`token 已用约 ${used}/${maxTokens}`);
  }
  const expensiveFloor = maxTokens ? Math.max(32_000, maxTokens * 0.2) : 32_000;
  if (lastTokens >= expensiveFloor) {
    bits.push(`本轮已经很贵（约 ${lastTokens}）`);
  }
  if (!bits.length) return null;
  return {
    label: `成本预警 · ${bits[0]}`,
    detail: `${bits.join(" · ")}。还没用尽，但下一轮会继续烧。`,
  };
}

/**
 * Context 面 = 水位口径 + 压缩事件。
 *
 * 水位分子是**最近一轮输入**而不是全 run 累计：ContextManager.noteUsage 是
 * 赋值不是累加（src/context.ts:56-61），按累计画会得到"永远即将压缩却永不
 * 压缩"的假警报。压缩单独成一个不可逆语域——被置换的 tool_result 原文
 * 永不可恢复，那不是又一条普通警告。
 */
export function deriveContextFace(state, harness) {
  /**
   * 窗口 / 预算（MEM-01 分离）：逐 run 的 run_config.context 优先于进程级 harness.context；
   * 两处都没有（旧宿主）才退回 guardrails.contextTokenLimit——那时窗口一律未知。
   * 预算就是水位分母：**分母不变**，只是从今起知道它离窗口有多远。
   */
  const contextCfg =
    normalizeContextConfig(state.runConfig?.context) ?? normalizeContextConfig(harness?.context) ?? null;
  const limit =
    contextCfg?.budget ??
    state.runConfig?.guardrails?.contextTokenLimit ??
    harness?.guardrails?.contextTokenLimit ??
    null;
  const usage = deriveContextUsage(state, limit);
  const watermark = harness?.compactWatermark ?? usage.watermark;
  const window = contextCfg?.window ?? null;
  const windowRatio = window ? usage.lastInputTokens / window : null;
  /**
   * 三段水位条的几何：总长 = 窗口（已知）或预算（未知，此时没有窗口段）。
   * 三段各自的占比与"下一轮将压缩"档位一起算好，渲染层只画不算。
   */
  const total = window ?? limit;
  const share = (n) => (total ? Math.min(1, Math.max(0, n / total)) : null);
  const compactNextTurn = usage.ratio !== null && usage.ratio >= watermark;
  const compactions = [...state.timeline, ...state.verifierTimeline]
    .filter((e) => e.type === "compaction")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: e.seq,
      source: e.source,
      droppedBlocks: e.droppedBlocks ?? 0,
      ledgerEntries: e.ledgerEntries ?? 0,
      summaryApplied: e.summaryApplied === true,
      collapsedTurns: e.collapsedTurns ?? 0,
      reactive: e.reactive === true,
    }));

  return {
    ...usage,
    watermark,
    nearWatermark: compactNextTurn,
    /** 档位："下一轮将压缩"= 最近一轮输入 ≥ 预算 × 水位；compaction 判据取的就是这个数 */
    compactNextTurn,
    // ---- 窗口（事实）与预算（策略）分开报；window=null 就是"窗口未知"，不编数 ----
    window,
    windowSource: contextCfg?.windowSource ?? "unknown",
    budget: limit,
    budgetSource: contextCfg?.budgetSource ?? null,
    requestedBudget: contextCfg?.requestedBudget ?? limit,
    maxBudget: contextCfg?.maxBudget ?? null,
    maxTokens: contextCfg?.maxTokens ?? null,
    clamped: contextCfg?.clamped === true,
    clampWarning: contextCfg?.warning ?? null,
    windowRatio,
    /** 三段条：used / budget / window 各占总长的比例（窗口未知时 window 为 null、总长 = 预算） */
    strip: total
      ? {
          total,
          used: share(usage.lastInputTokens),
          budget: limit ? share(limit) : null,
          window: window ? 1 : null,
          threshold: limit ? share(limit * watermark) : null,
        }
      : null,
    compactions,
    droppedBlocks: compactions.reduce((n, c) => n + c.droppedBlocks, 0),
    ledgerEntries: compactions.reduce((n, c) => n + (c.ledgerEntries ?? 0), 0),
    summaryAppliedCount: compactions.reduce((n, c) => n + (c.summaryApplied ? 1 : 0), 0),
    // Phase C：旧轮折叠总数与反应式（撞 400 后）压缩次数——两者都比"置换了几个块"更该被看见
    collapsedTurns: compactions.reduce((n, c) => n + (c.collapsedTurns ?? 0), 0),
    reactiveCount: compactions.reduce((n, c) => n + (c.reactive ? 1 : 0), 0),
    perTurn: state.usageByTurn,
    /** 最近一轮的分项估算（若有）；缺省 null = 旧宿主/未发 breakdown */
    breakdown: (() => {
      const last = state.usageByTurn[state.usageByTurn.length - 1];
      return last?.breakdown ?? null;
    })(),
    agentMd: state.runConfig?.agentMd ?? null,
  };
}

/**
 * Tools 面：本次运行模型能做什么、实际做了什么、边界在哪。
 *
 * "改道"是 P5「错误进上下文，不炸循环」的可视化证据：工具失败之后模型换了
 * 工具或换了参数继续走，而不是循环崩掉。
 */
export function deriveToolsFace(state, harness) {
  const all = [...state.timeline, ...state.verifierTimeline].sort((a, b) => a.seq - b.seq);
  const stats = new Map();
  const bump = (name, key) => {
    if (!name) return;
    const s = stats.get(name) ?? { calls: 0, errors: 0 };
    s[key] += 1;
    stats.set(name, s);
  };

  const reroutes = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.type === "tool_call") bump(e.name, "calls");
    if (e.type === "tool_result") {
      const name = state.toolNames[e.toolUseId] ?? null;
      if (e.resultIsError) {
        bump(name, "errors");
        // 紧随其后的下一次工具调用即"改道"
        const next = all.slice(i + 1).find((x) => x.type === "tool_call");
        if (next) {
          reroutes.push({
            errorSeq: e.seq,
            failedTool: name,
            nextSeq: next.seq,
            nextTool: next.name,
            switched: next.name !== name,
          });
        }
      }
    }
  }

  const rc = state.runConfig;
  const declared = rc?.tools ?? harness?.tools ?? [];
  const tools = declared.map((t) => ({
    ...t,
    calls: stats.get(t.name)?.calls ?? 0,
    errors: stats.get(t.name)?.errors ?? 0,
  }));
  // 声明面之外被真实调用过的（MCP 未接入时可能出现），照实列出而不是隐藏
  for (const [name, s] of stats) {
    if (!declared.some((t) => t.name === name)) {
      tools.push({ name, permission: null, origin: "unknown", calls: s.calls, errors: s.errors });
    }
  }

  return {
    pack: rc?.pack ?? harness?.pack ?? null,
    shell: harness?.shell ?? null,
    executionIsolation: rc?.executionIsolation ?? harness?.executionIsolation ?? null,
    // 逐 run 可换工作目录，Tools 面必须报本 run 真正用的那个
    workdir: rc?.workdir ?? harness?.workdir ?? null,
    projectId: rc?.projectId ?? null,
    campaignId: rc?.campaignId ?? null,
    campaignRole: rc?.campaignRole ?? null,
    roleModels: rc?.roleModels ?? null,
    readRoots: Array.isArray(rc?.readRoots) ? rc.readRoots : (harness?.readRoots ?? []),
    writeRoots: Array.isArray(rc?.writeRoots)
      ? rc.writeRoots
      : (Array.isArray(rc?.extraWorkdirs) ? rc.extraWorkdirs : []),
    // 运行历史的真实落点是进程级装配（不逐 run 变），只来自宿主快照
    history: harness?.history ?? null,
    mcp: harness?.mcp ?? null,
    notify: normalizeNotifySnapshot(harness?.notify),
    guardrails: rc?.guardrails ?? harness?.guardrails ?? null,
    // 窗口 / 预算（MEM-01）：逐 run 优先，进程级快照兜底；旧宿主两处都没有 = null（不显示这一行）
    context: normalizeContextConfig(rc?.context) ?? normalizeContextConfig(harness?.context) ?? null,
    tools,
    totalCalls: [...stats.values()].reduce((n, s) => n + s.calls, 0),
    totalErrors: [...stats.values()].reduce((n, s) => n + s.errors, 0),
    denials: state.pendingApprovals
      .filter((a) => a.status === "denied")
      .map((a) => ({ name: a.name, reason: a.reason ?? null })),
    reroutes,
  };
}

/**
 * 核查白名单的生效值与来源：逐 run 的 run_config 优先于进程级 `/api/harness`；两者都没报
 * （旧宿主）→ commands=null，调用方回落到 pack.verify.readOnlyCommands。
 * @returns {{commands: string[]|null, source: string|null}}
 */
function resolveEffectiveWhitelist(state, harness) {
  const rc = state.runConfig;
  if (rc && Array.isArray(rc.verifierReadOnlyCommands)) {
    return { commands: rc.verifierReadOnlyCommands, source: rc.verifierReadOnlySource ?? null };
  }
  if (harness && Array.isArray(harness.verifierReadOnlyCommands)) {
    return { commands: harness.verifierReadOnlyCommands.map(String), source: harness.verifierReadOnlySource ?? null };
  }
  return { commands: null, source: null };
}

/** 白名单来源的短标签（状态条 / Verification 面共用；pack 与未知不标——那是常态） */
export function whitelistSourceLabel(source) {
  if (source === "default") return "通用默认";
  if (source === "env") return "env";
  if (source === "none") return "包未声明";
  return "";
}

/**
 * Verification 面：三值裁决 + 三类饥饿告警。
 *
 * `pass_with_notes` 是刻意独立的一态：CLI 对 passed=true 但 issues 非空会
 * 降级为黄色 `⚠`（src/cli.ts:276），Web 此前一律红色。项目有两个真实案例
 * 是"通过但备注里藏着真 bug"，这一态不能被绿色吞掉。
 */
export function deriveVerificationFace(state, harness) {
  const v = state.verdict;
  const badge = !v
    ? "pending"
    : v.passed && v.issues.length > 0
      ? "pass_with_notes"
      : v.passed
        ? "pass"
        : "fail";

  const segments = deriveSegments(state);
  const runPack = state.runConfig?.pack ?? harness?.pack;
  // 生效白名单优先于包声明：无包运行拿的是通用缺省（run_config 报出来的才是核查者手里那份）
  const effective = resolveEffectiveWhitelist(state, harness);
  const whitelist = effective.commands ?? runPack?.verify?.readOnlyCommands ?? [];

  // ① 白名单饥饿：verifier 没有可用的只读命令，却确实撞上了审批门——案例 #4 的形态。
  //    注意判据不能看 pendingApprovals：verifier 的审批由 harness 内部自答，
  //    压根不进那个列表（applyApproval 直接把它扔进 verifierTimeline）。
  const verifierDenied = state.verifierTimeline.some((e) => e.type === "approval_request");
  // ② 空返工：被否触发的返工段里一次写类调用都没有，纯粹在重证明已为真的东西
  const emptyRework = segments
    .filter((s) => s.role === "rework")
    .filter((s) => !s.entries.some((e) => e.type === "tool_call" && WRITE_TOOLS.has(e.name)))
    .map((s) => s.round);
  // ③ 解析失败型：fail-closed 的第一种误伤形态
  const parseFail = Boolean(v && !v.passed && v.issues[0] === VERDICT_PARSE_FAIL);

  return {
    badge,
    verdict: v,
    rounds: state.verifications,
    finalPassed: state.runEnd?.finalPassed ?? (v ? v.passed : null),
    whitelist,
    // pack = 包声明；default = 无包通用缺省；env = AGENT_VERIFY_READONLY_COMMANDS；none = 包沉默；null = 旧宿主没报
    whitelistSource: effective.source,
    rubricSource: state.runConfig?.rubricSource ?? runPack?.verify?.rubricSource ?? null,
    // 逐 run 的 run_config 优先于进程级快照：编排下各子任务的包不同，
    // 核查预算也不同（9.1），读进程级会显示另一个包的数
    budgetTurns: state.runConfig?.verifierBudgetTurns ?? harness?.verifierBudgetTurns ?? null,
    budgetSource: state.runConfig?.verifierBudgetSource ?? harness?.verifierBudgetSource ?? null,
    starvation: {
      noWhitelist: whitelist.length === 0 && verifierDenied,
      emptyRework,
      parseFail,
    },
  };
}

// ================================================================
// 统一输入框（composer）：新建任务与追加指令共用同一个框
// ================================================================

/** 工作目录的末段名。空路径不猜。 */
export function composerFolderName(path) {
  const raw = String(path ?? "").trim().replace(/[\\/]+$/, "");
  if (!raw) return "";
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** 发送快捷键写在 title，不占 placeholder。 */
export const COMPOSER_SEND_HINT = "Enter 发送，Shift+Enter 换行";

/**
 * 新建对话的 placeholder：框上已经选了目录，就不要再写「问任何问题」。
 * 设计模式问稿，不问仓库文件夹名——否则会看见「要「Agent_Design」做什么…」。
 *
 * @param {string|null|undefined} workdir
 * @param {{ designMode?: boolean, designTitle?: string|null }} [opts]
 */
export function newRunPlaceholder(workdir, opts) {
  const title = String(opts?.designTitle ?? "").trim();
  if (opts?.designMode && title) return `要「${title}」做什么…`;
  return "说要做什么…";
}

/**
 * 一个框、四个模式。模式**只由"当前选中哪个运行"派生**。
 *
 * 为什么合并（委托方原话："追加指令和下方的输入框不能公用吗 为啥要分开"）：
 * 分开纯粹是实现遗留——底栏打 `POST /api/runs`（新建），详情里那个打
 * `POST /api/runs/:id/messages`（续跑）。对用户来说它们长得一样、位置也挨着，
 * 没有理由是两个框。
 *
 * 为什么模式由选中态派生、而不是加一个"新建/追加"切换器：切换器是第四个概念，
 * 要持久化、要和选中态同步，还会造出"切换器说新建、详情页却显示着某个运行"
 * 这种自相矛盾态。侧栏本来就有「+ 新建对话」，它天然就是"切回新建"的开关。
 *
 * **这笔交易的代价要认下来**：点开一个运行只是想读它，底栏却已经变成
 * "追加到这个运行"。所以模式必须**处处可见**——按钮文案、placeholder、
 * 说明行、`data-mode` 四处同时变，绝不静默。
 *
 * @param {{
 *   info?: {status?: string, canContinue?: boolean, continuationMode?: string, continuationBlockReason?: string|null, mode?: string, verify?: boolean, workdir?: string, runId?: string, archived?: boolean}|null,
 *   localStatus?: string|null,   // 本地 SSE 观测到的状态；见下方"默认值不是观测"
 *   submitting?: boolean,        // 提交在飞：服务端还没回、列表也还没更新
 *   stopping?: boolean,          // 人已经按了停止，等当前这一步收口
 *   error?: string|null,
 *   workdir?: string|null,       // 新建态：当前选中的工作目录（不在 info 里）
 *   draft?: string|null,         // 输入框当前草稿：运行中有字 → 立即插入，空 → 停止
 *   designMode?: boolean,        // 设计模式新建：placeholder 用稿名，不用文件夹名
 *   designTitle?: string|null,   // 当前样例 / 注册表标题
 *   planMode?: boolean,          // 新建勾了计划编排：核查勾改不了子任务核查
 *   delivery?: {kind?: string, placeholder?: string, hint?: string}|null,
 * }} input
 */
export function deriveComposerMode({ info, localStatus, submitting, error, stopping, workdir, draft, designMode, designTitle, planMode, delivery } = {}) {
  // runPlanned 成文仍走 runVerified。勾选只约束单轮对话，计划子任务默认仍核查。
  const planVerifiesSubtasks = Boolean(planMode) || (info?.mode === "plan" && info?.status === "running");
  const verifyLabelNew = planVerifiesSubtasks
    ? "独立核查（计划编排默认仍核查子任务）"
    : "独立核查";
  const verifyLabelTurn = planVerifiesSubtasks
    ? "本轮独立核查（计划编排默认仍核查子任务）"
    : "本轮独立核查";
  const base = {
    runId: info?.runId ?? null,
    workdir: info?.workdir ?? workdir ?? null,
    // 已打开的对话：路径是那场会话的圈禁根，输入栏只展示、不能改。
    // 开新对话才用下拉选目录——跟 Cursor「切聊天 = 切到该聊天的工作区」同构。
    workdirLocked: Boolean(info),
    error: error ?? null,
    optionsEnabled: true,
    canExtendBudget: false,
    budgetExhausted: false,
    effort: info?.effort ?? null,
    /**
     * 独立核查开关的逐模式契约（会话中心化：核查是**每一轮**的选项）。
     * 新建：用户自己的选择，不动；追加：缺省沿用该 run 上一轮的设置（defaultChecked），
     * 由 patchComposer 在**切到这个 run 时**套一次；运行中/提交中：禁用。
     */
    verifyToggle: { enabled: true, defaultChecked: null, label: verifyLabelNew },
  };

  // 提交在飞：服务端在 json(res) **之前**就广播了 run_created，于是列表先一步
  // 刷新、syncComposer 跟着跑一遍，按钮会被重新算成"可点"——用户第二下就建了
  // 第二个 run（新建路径没有 409 兜着）。所以 in-flight 必须是模式的一部分，
  // 不能用命令式的 btn.disabled=true 去和 patchComposer 抢同一个属性。
  if (submitting) {
    return {
      ...base,
      mode: "submitting",
      kind: null,
      buttonLabel: "提交中…",
      labelText: "发送",
      placeholder: "",
      note: "",
      canSubmit: false,
      optionsEnabled: false,
      verifyToggle: { ...base.verifyToggle, enabled: false },
    };
  }

  if (!info) {
    return {
      ...base,
      mode: "new",
      kind: "new",
      buttonLabel: "发送",
      labelText: "发送",
      placeholder: newRunPlaceholder(base.workdir, { designMode, designTitle }),
      note: "",
      canSubmit: true,
    };
  }

  /**
   * "在跑"以**服务端列表**为准，本地状态只能把它往"结束"方向推，不能往
   * "在跑"方向推。
   *
   * 原因：`createInitialState` 把 status 初始化成 `"running"`——那是默认值，
   * **不是一次观测**。若拿它当"在跑"的证据，从侧栏点开一个早已结束的运行会
   * 走出 append → running → append 的抖动，中间还挂一句"运行进行中"的假话。
   * 反过来，本地已经收到 run_end 而列表还没刷新时，本地那一侧是真观测，
   * 应当立刻生效——所以是单向的。
   */
  const running = info.status === "running" && localStatus !== "done";
  if (running) {
    /**
     * 按过停止之后按钮必须立刻变，不能还写「停止」。
     * abort 只保证不再往下走，当前这一步（在飞的模型请求 / 工具）要等它自己
     * 结束——看起来像没点上，就是因为这里没有中间态。
     */
    if (stopping) {
      return {
        ...base,
        mode: "running",
        kind: null,
        buttonLabel: "正在停止…",
        labelText: "发送",
        placeholder: "正在停止…",
        note: "已发出停止，正在收尾。已完成的写入不会回滚。",
        canSubmit: false,
        optionsEnabled: false,
        verifyToggle: { ...base.verifyToggle, enabled: false },
      };
    }
    const hasDraft = Boolean(String(draft ?? "").trim());
    return {
      ...base,
      mode: "running",
      kind: hasDraft ? "steer" : "stop",
      /**
       * 有草稿 = 立即插入（下一轮模型调用前注入正史）；空框 = 停止。
       * 不要再并排两个「插队 / 排队」键——发送本身就是插入。
       */
      buttonLabel: hasDraft ? "立即插入" : "停止",
      labelText: "发送",
      placeholder: "运行进行中，直接发送会立即插入…",
      note: "",
      canSubmit: true,
      optionsEnabled: true,
      verifyToggle: { ...base.verifyToggle, enabled: true },
    };
  }

  if (info.canContinue) {
    // 追加轮的核查开关：缺省沿用该 run 上一轮的设置，可逐轮改（会话中心化）
    const verifyToggle = { enabled: true, defaultChecked: Boolean(info.verify), label: verifyLabelTurn };
    const unsignedFollow = delivery?.kind === "unsigned";
    const followPlaceholder = unsignedFollow
      ? String(delivery.placeholder ?? "接着改已有页面…")
      : "接着说…";
    const unsignedNote = unsignedFollow
      ? String(delivery.hint ?? "这一轮已经停了，产物在右侧")
      : "";
    if (info.continuationMode === "same-run") {
      return {
        ...base,
        mode: "same-run",
        kind: "append",
        buttonLabel: "继续对话",
        labelText: "追加指令",
        placeholder: followPlaceholder,
        note: unsignedNote,
        canSubmit: true,
        optionsEnabled: true,
        verifyToggle,
      };
    }
    if (info.continuationMode === "restore-gate") {
      return {
        ...base,
        mode: "restore-gate",
        kind: "append",
        buttonLabel: "继续对话",
        labelText: "追加指令",
        placeholder: followPlaceholder,
        note: "计划还在确认门上。发送后回到门上批准，不会假装已经跑过子任务。",
        canSubmit: true,
        optionsEnabled: true,
        verifyToggle,
      };
    }
    if (info.continuationMode === "reopen") {
      return {
        ...base,
        mode: "reopen",
        kind: "append",
        buttonLabel: "继续对话",
        labelText: "追加指令",
        placeholder: followPlaceholder,
        note: "没有可热续的检查点。发送会从任务正文重开一轮，不重放飞行中的工具。",
        canSubmit: true,
        optionsEnabled: true,
        verifyToggle,
      };
    }
    if (info.continuationMode === "fork") {
      return {
        ...base,
        mode: "fork",
        kind: "append",
        buttonLabel: "继续对话",
        labelText: "追加指令",
        placeholder: followPlaceholder,
        note: unsignedNote,
        canSubmit: true,
        optionsEnabled: true,
        verifyToggle,
      };
    }
    return {
      ...base,
      mode: "append",
      kind: "append",
      buttonLabel: "继续对话",
      labelText: "追加指令",
      placeholder: followPlaceholder,
      note: unsignedNote,
      canSubmit: true,
      optionsEnabled: true,
      verifyToggle,
    };
  }

  /**
   * 选中了对话却暂时续不上（归档边界等）。仍按追加发出去，让 409 把原因
   * 写进错误行——绝不把发送变成「新建一次运行」。要另开只能点左侧「+」。
   */
  return {
    ...base,
    mode: "blocked",
    kind: "append",
    buttonLabel: "继续对话",
    labelText: "追加指令",
    placeholder: "接着说…",
    note: "",
    canSubmit: true,
    optionsEnabled: true,
    verifyToggle: { enabled: true, defaultChecked: Boolean(info.verify), label: verifyLabelTurn },
    budgetExhausted: Boolean(info.budgetExhausted || info.canExtendBudget),
    canExtendBudget: Boolean(info.canExtendBudget),
  };
}

/**
 * 不能追加的原因（V-28：不能只是"没有输入框"，要说为什么）。
 *
 * 会话中心化之后这里只剩两类：服务端按当前边界算出的阻断理由（活 run 唯一的是
 * 执行谱系预算耗尽——文案里带 env 名与提法；归档还有包不存在 / 目录越权），
 * 以及"服务端没给理由"的兜底。核查 / 编排 / 执行失败**不再是**理由：
 * 旧文案「追加会绕过已出具的裁决」「没有续跑入口」「没有可续跑的会话正史」已退役，
 * 裁决现在带轮号留在对话里、只对它核查的那一轮负责。
 */
function blockedReason(info) {
  if (info.continuationBlockReason) {
    return `${info.archived ? "这是只读归档，当前不能派生续跑：" : ""}${info.continuationBlockReason}。`;
  }
  if (info.archived) {
    return "这是只读归档，当前不能派生续跑（服务端未给出原因）。";
  }
  return "这次运行当前不能追加（服务端未给出原因）。";
}

/**
 * 追加一轮的网络载荷（纯函数，与 buildNewRunRequest 同规格）。
 * verify 是**本轮**的核查开关；未给时不发字段，服务端沿用该 run 上一轮的设置。
 * autoApprove 也必须显式带上——归档派生 / 续跑是新的执行，不继承父 run 的活权限。
 * 勾着「自动放行」却不发这个字段，界面看起来开着、服务端仍会逐条问。
 * planMode / multiAgent 只用于把**单轮对话**升级成编排；完成态计划追问
 * 不要从常驻「计划」旋钮带上这两项——那会误开 planner。
 */
export function buildFollowUpRequest({
  text, verify, autoApprove, planMode, multiAgent, effort,
  workdir, extraWorkdirs, projectId, pack, autoPack, permissionMode, rubric,
  citedRunIds,
} = {}) {
  const extras = Array.isArray(extraWorkdirs)
    ? [...new Set(extraWorkdirs.map(String).filter((p) => p && p !== workdir))]
    : [];
  const trimmedRubric = String(rubric ?? "").trim();
  return {
    text: String(text ?? ""),
    ...(typeof verify === "boolean" ? { verify } : {}),
    ...(typeof autoApprove === "boolean" ? { autoApprove } : {}),
    ...(planMode === true ? { planMode: true } : {}),
    ...(multiAgent === true ? { multiAgent: true } : {}),
    ...(effort ? { effort } : {}),
    ...(workdir ? { workdir } : {}),
    ...(extras.length ? { extraWorkdirs: extras } : {}),
    ...(projectId ? { projectId: String(projectId) } : {}),
    ...(typeof pack === "string" ? { pack } : {}),
    ...(autoPack === true ? { autoPack: true } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(trimmedRubric ? { rubric: trimmedRubric } : {}),
    ...(Array.isArray(citedRunIds) && citedRunIds.filter(Boolean).length
      ? { citedRunIds: [...new Set(citedRunIds.map(String).filter(Boolean))] }
      : {}),
  };
}

/**
 * 提交意图。纯函数——路由决策与 DOM、网络无关，所以它可测。
 * @returns {{kind:"new"|"append"|"stop"|"steer", runId:string|null, text:string}|null} null = 不该提交
 */
export function composerSubmitPlan(mode, rawText) {
  if (!mode || !mode.canSubmit || !mode.kind) return null;
  // 停止不需要文本——空框点发送才是叫停
  if (mode.kind === "stop") return { kind: "stop", runId: mode.runId, text: "" };
  const text = String(rawText ?? "").trim();
  if (!text) return mode.kind === "steer" ? { kind: "stop", runId: mode.runId, text: "" } : null;
  return { kind: mode.kind, runId: mode.runId, text };
}

/**
 * 计划编排的主场是跨领域交接 / 长管线（findings 发现 10：单领域上 planned 是纯开销）。
 * 日常对话、单点小修不该先跑 planner。只在信号够时建议切回普通模式，拿不准不说话。
 * 不自动改旋钮——建议不是拦截。
 *
 * @returns {{reason:"standing"|"casual"|"small-fix", message:string}|null}
 */
export function suggestPlainModeInsteadOfPlan(task, opts = {}) {
  if (opts.planMode !== true) return null;
  if (opts.kind != null && opts.kind !== "new") return null;
  const text = String(task ?? "").replace(/\s+/g, " ").trim();
  if (looksLikePlanWorthyTask(text)) return null;
  if (!text) {
    return {
      reason: "standing",
      message: "计划编排适合跨领域或长管线。日常对话、小修建议改用普通模式。",
    };
  }
  if (looksLikeCasualChatTask(text)) {
    return {
      reason: "casual",
      message: "这更像日常对话。计划编排会先拆一轮再动手，建议改用普通模式。",
    };
  }
  if (looksLikeSmallFixTask(text)) {
    return {
      reason: "small-fix",
      message: "这更像单点小修。单领域任务上编排是纯开销，建议改用普通模式。",
    };
  }
  return null;
}

const PLAN_WORTHY_TASK_RE = /子任务|并行编排|跨(?:领域|包|目录)|拆成|拆解|计划确认|烧录|原理图|\bpcb\b|网表|验收标准|多领域|并且还要|然后再做|同时交付/i;
const CASUAL_CHAT_EXACT_RE = /^(你好|您好|嗨|哈喽|在吗|在么|在不在|hello|hi|hey|thanks|thank you|谢谢|早安|晚安|早|嗯+|好的|ok|okay)[!！?？。.~～]*$/i;
const SMALL_FIX_TASK_RE = /修(?:一)?下|修个|改(?:一)?下|改个|小\s*bug|typo|拼写|错字|漏了个|少了个|对齐一下|改个颜色|改个文案/i;

function looksLikePlanWorthyTask(text) {
  if (!text) return false;
  if (text.length > 280) return true;
  if (PLAN_WORTHY_TASK_RE.test(text)) return true;
  const steps = text.match(/\d+[.)、]\s+\S+/g);
  return Boolean(steps && steps.length >= 2);
}

function looksLikeCasualChatTask(text) {
  if (SMALL_FIX_TASK_RE.test(text)) return false;
  if (/\d+[.)、]/.test(text)) return false;
  if (CASUAL_CHAT_EXACT_RE.test(text)) return true;
  if (text.length <= 24 && /[?？]$/.test(text) && !taskLooksLikeWorkPath(text)) return true;
  if (text.length <= 16 && !taskLooksLikeWorkPath(text) && !/(实现|重构|设计|交付|验收|编写|撰写|修复)/.test(text)) {
    return true;
  }
  return false;
}

function looksLikeSmallFixTask(text) {
  if (text.length > 140) return false;
  return SMALL_FIX_TASK_RE.test(text);
}

function taskLooksLikeWorkPath(text) {
  return /[\\/]|\.\w{1,5}\b/.test(text);
}

/**
 * D3 权限三档对照表（事实源：`src/permission-mode.ts`）。
 * 前端只捆既有旋钮；装配条必须显示展开后的开关值。
 */
export const PERMISSION_MODE_TABLE = Object.freeze({
  manual: Object.freeze({
    approvalDefault: "ask",
    planMode: false,
    planGate: false,
    autoYes: false,
  }),
  plan: Object.freeze({
    approvalDefault: "ask",
    planMode: true,
    planGate: true,
    autoYes: false,
  }),
  auto: Object.freeze({
    approvalDefault: "auto",
    planMode: false,
    planGate: false,
    autoYes: true,
  }),
});

export function permissionModeSwitches(mode) {
  const key = String(mode ?? "manual");
  const row = PERMISSION_MODE_TABLE[key] ?? PERMISSION_MODE_TABLE.manual;
  return { mode: PERMISSION_MODE_TABLE[key] ? key : "manual", ...row };
}

/**
 * 从展开开关反推档位；对不上任何预设 → null（自定义组合，界面照实说）。
 */
export function matchPermissionMode(switches) {
  const approvalDefault = switches?.approvalDefault === "auto" ? "auto" : "ask";
  const planMode = Boolean(switches?.planMode);
  const planGate = Boolean(switches?.planGate);
  const autoYes = Boolean(switches?.autoYes);
  for (const mode of Object.keys(PERMISSION_MODE_TABLE)) {
    const row = PERMISSION_MODE_TABLE[mode];
    if (
      row.approvalDefault === approvalDefault
      && row.planMode === planMode
      && row.planGate === planGate
      && row.autoYes === autoYes
    ) {
      return mode;
    }
  }
  return null;
}

/**
 * 装配条 / composer 一行人话：现在在哪一档，会不会自动放行危险动作。
 * 与 `src/permission-mode.ts` 的 describePermissionStance 同文案。
 */
export function describePermissionStance(mode, switches) {
  const auto = switches?.autoYes === true;
  const danger = auto
    ? "ask 级会自动放行；deny / 圈禁 / 硬拒仍拦住"
    : "危险动作会先问你，不会自动放行";
  if (mode === "manual") return `手动 · ${danger}`;
  if (mode === "plan") return `计划 · 先出计划再动手；${danger}`;
  if (mode === "auto") return `自动 · ${danger}`;
  return `自定义 · ${danger}`;
}

/**
 * 新建运行的网络载荷。保持为纯函数，避免某个 UI 开关只在特定分支里“看起来接上”。
 * `askUser` 是执行方式，不是 plan 专属能力：single 任务遇到地点、环境或交付边界
 * 不明确时同样需要先问人。
 * `permissionMode` 只填没写明的旋钮；显式 planMode / planGate / autoApprove 优先。
 * 计划编排与自动放行是正交的——选了 plan 档不得把自动放行盖掉。
 */
export function buildNewRunRequest({
  task,
  verify = false,
  pack,
  effort,
  rubric,
  mode = "single",
  concurrency,
  planGate,
  planMode,
  multiAgent = false,
  lineageBudget = false,
  dailyBudget = true,
  askUser = true,
  autoApprove,
  workdir,
  useVerifierModel = true,
  usePlannerModel = true,
  contextTokenLimit,
  autoPack = false,
  permissionMode,
  extraWorkdirs,
  projectId,
  designId,
  designTab,
  designTemplate,
  designFilePack,
  citedRunIds,
  workspace,
} = {}) {
  const trimmedRubric = String(rubric ?? "").trim();
  // 逐 run 上下文预算：空 / 非数字不传（沿用 env > 包 > 默认）；填了就原样交给宿主校验区间——
  // 不在浏览器里夹紧，越界该 400 报区间，静默夹紧就是界面说谎
  const budget = contextTokenLimit === undefined || contextTokenLimit === null || String(contextTokenLimit).trim() === ""
    ? undefined
    : Number(contextTokenLimit);
  const preset =
    permissionMode && PERMISSION_MODE_TABLE[permissionMode]
      ? permissionModeSwitches(permissionMode)
      : null;
  const effectivePlanMode = planMode !== undefined
    ? Boolean(planMode)
    : (preset ? preset.planMode : planMode);
  const effectivePlanGate = planGate !== undefined
    ? Boolean(planGate)
    : (preset ? preset.planGate : planGate);
  const effectiveAutoApprove = autoApprove !== undefined
    ? Boolean(autoApprove)
    : (preset ? (preset.autoYes || preset.approvalDefault === "auto") : false);
  // 正交旋钮：计划模式 = 确认门；多 agent = DAG 并行。任一为真即编排。
  // 兼容旧契约：只传 mode=plan 且未显式 planGate:false → 仍开确认门。
  const wantPlanGate =
    effectivePlanMode === true ||
    effectivePlanGate === true ||
    (mode === "plan" && effectivePlanGate !== false && effectivePlanMode === undefined);
  const wantMulti = multiAgent === true;
  const orchestrate = mode === "plan" || wantPlanGate || wantMulti;
  const wantDesign = mode === "design" && !orchestrate;
  const workspaceFace = workspace === "office" || workspace === "code"
    ? workspace
    : wantDesign ? "office" : "code";
  const effectiveConcurrency =
    concurrency !== undefined && concurrency !== null && concurrency !== ""
      ? concurrency
      : wantMulti
        ? "auto"
        : orchestrate
          ? 1
          : undefined;
  return {
    task: String(task ?? ""),
    verify: Boolean(verify),
    ...(pack && !autoPack && !wantDesign ? { pack } : {}),
    ...(autoPack && !wantDesign ? { autoPack: true } : {}),
    ...(effort ? { effort } : {}),
    ...(trimmedRubric ? { rubric: trimmedRubric } : {}),
    ...(budget !== undefined && Number.isFinite(budget) ? { contextTokenLimit: budget } : {}),
    ...(preset ? { permissionMode: preset.mode } : {}),
    ...(orchestrate
      ? {
          mode: "plan",
          ...(effectiveConcurrency !== undefined ? { concurrency: effectiveConcurrency } : {}),
          ...(wantPlanGate ? { planGate: true } : {}),
          ...(wantMulti ? { multiAgent: true } : {}),
        }
      : wantDesign
        ? {
            mode: "design",
            ...(designId ? { designId: String(designId) } : {}),
            ...(designTab ? { designTab: String(designTab) } : {}),
            ...(designTemplate ? { designTemplate: String(designTemplate) } : {}),
            ...(designFilePack ? { designFilePack: String(designFilePack) } : {}),
          }
        : {}),
    ...(lineageBudget === false ? { lineageBudget: false } : {}),
    ...(dailyBudget === false ? { dailyBudget: false } : {}),
    ...(askUser ? { askUser: true } : {}),
    ...(effectiveAutoApprove ? { autoApprove: true } : {}),
    ...(workdir ? { workdir } : {}),
    ...(Array.isArray(extraWorkdirs) && extraWorkdirs.filter((p) => p && p !== workdir).length
      ? { extraWorkdirs: [...new Set(extraWorkdirs.map(String).filter((p) => p && p !== workdir))] }
      : {}),
    ...(projectId ? { projectId: String(projectId) } : {}),
    // 与宿主既有契约一致：角色模型默认启用，只有显式关闭才传 false。
    ...(!useVerifierModel ? { useVerifierModel: false } : {}),
    ...(!usePlannerModel ? { usePlannerModel: false } : {}),
    ...(Array.isArray(citedRunIds) && citedRunIds.filter(Boolean).length
      ? { citedRunIds: [...new Set(citedRunIds.map(String).filter(Boolean))] }
      : {}),
    workspace: workspaceFace,
  };
}

/** 逐 run 预算控件的区间下限（与 src/context-window.ts MIN_CONTEXT_TOKEN_LIMIT 同值；宿主 400 是最终裁判） */
export const CONTEXT_BUDGET_INPUT_MIN = 32_000;
/** 窗口未知时的理智上限（同 CONTEXT_TOKEN_LIMIT_HARD_CAP） */
export const CONTEXT_BUDGET_INPUT_HARD_CAP = 2_000_000;
/** 超过它就给成本忠告（同 CONTEXT_BUDGET_ADVISORY_ABOVE）——忠告不是阻断，无人值守默认不弹任何确认 */
export const CONTEXT_BUDGET_ADVISORY_ABOVE = 200_000;

/**
 * 提交表单里"上下文预算"控件的派生（纯函数，控制器只搬结果）。
 *
 * - 区间 [32k, maxBudget]；窗口未知时上限取硬顶并在提示里说明——不能把"不知道"画成一个数。
 * - 忠告档：填的预算 > 200k 时说"每轮成本与时延随上下文线性增长，预计 ~X token/轮"，
 *   X 就是预算本身——那是**上界**（真实每轮输入 ≤ 预算，且缓存命中部分便宜得多），文案里如实写"上界"。
 * - `outOfRange` 只做提示，不阻断提交：宿主会 400 并报区间，两边口径同一处。
 * @param {object|null} ctx  /api/harness 的 context 投影（normalizeContextConfig 之后）
 * @param {unknown} raw      输入框当前值
 */
export function deriveContextBudgetKnob(ctx, raw) {
  const min = CONTEXT_BUDGET_INPUT_MIN;
  const max = ctx?.maxBudget ?? CONTEXT_BUDGET_INPUT_HARD_CAP;
  const fmtK = (n) => `${Math.floor(n / 1000).toLocaleString("en-US")}k`;
  const windowText = ctx?.window
    ? `窗口 ${fmtK(ctx.window)}（${contextSourceLabel(ctx.windowSource)}）`
    : "窗口未知";
  const rangeText = ctx?.maxBudget
    ? `可用 ${fmtK(min)}..${fmtK(max)}（上限 = 窗口 − maxTokens${ctx.maxTokens ? ` ${fmtK(ctx.maxTokens)}` : ""} − 边际）`
    : `可用 ${fmtK(min)}..${fmtK(max)}（窗口未知，上限取硬顶）`;
  const text = String(raw ?? "").trim();
  const value = text === "" ? null : Number(text);
  const valid = value !== null && Number.isInteger(value);
  const outOfRange = valid && (value < min || value > max);
  const advisory =
    valid && !outOfRange && value > CONTEXT_BUDGET_ADVISORY_ABOVE
      ? `每轮成本与时延随上下文线性增长，预计最多 ~${value.toLocaleString("en-US")} token/轮（上界：真实每轮输入 ≤ 预算，缓存命中部分更便宜）`
      : null;
  const placeholder = ctx?.budget ? `${ctx.budget}（${contextSourceLabel(ctx.budgetSource)}${ctx.clamped ? "，已夹紧" : ""}）` : "150000（默认）";
  return {
    min,
    max,
    value: valid ? value : null,
    outOfRange,
    advisory,
    placeholder,
    hint: `${windowText} · ${rangeText}${outOfRange ? " · 越界，宿主会拒绝" : ""}`,
  };
}

/**
 * 把 archived follow-up 的 HTTP 响应并入列表。纯函数的目的不是“少写几行 DOM”，
 * 而是锁住两个竞态不变量：父归档绝不改成 running；生命周期 SSE 若已把极短的
 * 子 run 推到 done，较旧的 HTTP running 快照不能让它倒退。
 *
 * @returns {{targetRunId:string, summary:object, runs:object[]}|null} null = 同 run 续跑
 */
export function mergeForkedFollowUp(runList, parentRunId, payload, feedback, now = Date.now()) {
  const targetRunId = typeof payload?.runId === "string" ? payload.runId : parentRunId;
  if (targetRunId === parentRunId) return null;

  const existingIndex = runList.findIndex((run) => run.runId === targetRunId);
  const existing = existingIndex >= 0 ? runList[existingIndex] : null;
  const parent = runList.find((run) => run.runId === parentRunId);
  const incoming = payload?.run && typeof payload.run === "object"
    ? payload.run
    : {
        runId: targetRunId,
        task: parent?.task ?? feedback,
        status: "running",
        verify: false,
        createdAt: now,
        finishedAt: null,
        continuedFrom: parentRunId,
      };
  const summary = existing?.status === "done"
    ? { ...incoming, ...existing }
    : { ...(existing ?? {}), ...incoming };
  const runs = [...runList];
  if (existingIndex >= 0) runs[existingIndex] = summary;
  else runs.unshift(summary);
  return { targetRunId, summary, runs };
}

/**
 * 把模式应用到底栏 DOM。**这里一行 addEventListener 都没有**——
 * 监听只在启动时由 `bindComposer` 绑一次。合并把输入框从"每次重建"变成
 * "永久存在"，重复绑定从不可能变成一步之遥，所以用职责切分把它堵死。
 */
export function patchComposer(mode, root = document) {
  const q = (sel) => root.querySelector(sel);
  const form = q("#submit-form");
  const btn = q("#submit-btn");
  const btnLabel = q("#submit-btn-label");
  const btnIcon = btn?.querySelector?.("i");
  const input = q("#task-input");
  const label = q('label[for="task-input"]');
  const modeLabel = q("#composer-mode-label");
  const note = q("#composer-note");
  const err = q("#submit-error");

  if (form) setAttr(form, "data-mode", mode.mode);
  if (btn) {
    setText(btnLabel ?? btn, mode.buttonLabel);
    setAttr(btn, "disabled", mode.canSubmit ? null : "");
  }
  if (btnIcon) {
    const stopping = mode.mode === "running" && !mode.canSubmit;
    const icon = stopping || mode.mode === "submitting"
      ? "ph-spinner-gap"
      : mode.kind === "steer"
        ? "ph-arrow-up"
        : mode.mode === "running"
          ? "ph-stop"
          : "ph-arrow-up";
    btnIcon.className = `ph ${icon}${stopping || mode.mode === "submitting" ? " is-spinning" : ""}`;
    setAttr(btn, "aria-busy", stopping ? "true" : null);
  }
  // 旧的「插队重想 / 排队等待」已退役：发送即插入，闪电在胶囊上方。
  for (const actionBtn of [q("#steer-btn"), q("#queue-btn")]) {
    if (actionBtn) setAttr(actionBtn, "hidden", "");
  }
  if (modeLabel) {
    const text = {
      new: "新建对话",
      append: "当前对话",
      fork: "当前对话",
      "same-run": "当前对话",
      running: "当前对话",
      submitting: "当前对话",
      blocked: "当前对话",
      "new-blocked": "当前对话",
    }[mode.mode] ?? "当前对话";
    setText(modeLabel, text);
  }
  if (label) setText(label, mode.labelText);
  if (input) {
    setAttr(input, "placeholder", mode.placeholder);
    setAttr(input, "title", COMPOSER_SEND_HINT);
    // 说明行不是 live region，靠 aria-describedby 在聚焦输入框时被读到——
    // disabled 的按钮不可聚焦，读屏用户否则无从得知它为什么是死的
    setAttr(input, "aria-describedby", mode.note ? "composer-note" : null);
  }
  if (note) {
    setText(note, mode.note);
    setAttr(note, "hidden", mode.note ? null : "");
  }
  const budgetRow = q("#budget-extend-row");
  if (budgetRow) {
    setAttr(budgetRow, "hidden", mode.canExtendBudget ? null : "");
  }
  if (err) {
    // 错误文本写进内层 span：外层容器带着常驻的关闭按钮（#submit-error-close），
    // 对整个 #submit-error 塞 textContent 会把那颗按钮一起抹掉。
    // 找不到内层节点（测试里的精简骨架）时退回直接写容器。
    const errText = err.querySelector?.(".inline-error-text") ?? err;
    setText(errText, mode.error ?? "");
    setAttr(err, "hidden", mode.error ? null : "");
  }

  /**
   * 装配项（独立核查 / 装配面板里的每一项）跟着模式禁用，**但不隐藏**——
   * 沿用本仓已有的纪律（见 index.html 并行度那处注释）：让"这个旋钮属于哪个
   * 模式"这件事本身可见。
   *
   * 三条刻意的例外：
   * ① 不动 `#run-knobs.hidden`：面板开合是用户状态、只有点击处理器一个写入方。
   *    让后台事件（run 收尾 → loadRuns → syncComposer）去强行折叠它，会把焦点
   *    正在 `#rubric-input` 里的用户直接踢回 body。
   * ② 不改 checkbox 的 checked：避免 sync 把用户刚拨的开关拨回去。
   * ③ 装配项（模型 / 领域包 / 权限 / 计划 / 多 agent / 思考强度 / 评分表）
   *    追加与运行中都可选；工作目录除外——它跟对话绑定，见下方 workdirLocked。
   *    提交中 / 正在停止仍锁。
   * ④ `#auto-approve-toggle` 不进这张禁用表：放行是活开关，运行中改了要立刻 post。
   */
  const knobs = [
    ...(q("#composer-scopebar")
      ? [...q("#composer-scopebar").querySelectorAll("input, select, #workdir-trigger, #executor-model-trigger")]
          .filter((el) => el.id !== "workdir-trigger" && el.id !== "workdir-select")
      : []),
    ...(q("#effort-select") ? [q("#effort-select")] : []),
    ...(q("#run-knobs") ? q("#run-knobs").querySelectorAll("input, select, textarea, button") : []),
  ].filter((el) => el && el.id !== "auto-approve-toggle");
  const persistIds = new Set(["plan-mode-toggle", "multi-agent-toggle", "effort-select"]);
  const persistOpen = mode.kind === "append" || mode.kind === "steer" || mode.kind === "stop";
  const active = root.activeElement ?? document.activeElement;
  for (const el of knobs) {
    const fixed = el.getAttribute?.("data-fixed") === "true";
    const persist = persistOpen && persistIds.has(el.id);
    setAttr(el, "disabled", (mode.optionsEnabled || persist) && !fixed ? null : "");
  }
  // 禁用一个正被聚焦的控件会让焦点掉回 body（后续按键全丢）。把它交还给输入框。
  const activeLocked = active && knobs.includes(active) && !persistIds.has(active.id);
  if (!mode.optionsEnabled && activeLocked && input?.focus) input.focus();

  /**
   * 独立核查开关单独走（会话中心化：核查是每一轮的选项，追加轮它**进请求体**）。
   * 缺省值只在**切到另一个 run 的追加模式时**套一次（data-verify-run 记着已经套过
   * 哪个 run），之后由用户随意改——每次 syncComposer 都重套会把用户刚拨的开关拨回去。
   * 回到新建模式时清掉记号，下次再选中同一个 run 会重新套它上一轮的设置。
   */
  const verify = q("#verify-toggle");
  const toggle = mode.verifyToggle ?? { enabled: mode.optionsEnabled, defaultChecked: null, label: "独立核查" };
  if (verify) {
    setAttr(verify, "disabled", toggle.enabled ? null : "");
    if (mode.kind === "append" && mode.runId && toggle.defaultChecked !== null) {
      if (form?.dataset.verifyRun !== mode.runId) {
        verify.checked = Boolean(toggle.defaultChecked);
        if (form) form.dataset.verifyRun = mode.runId;
      }
    } else if (mode.kind === "new" && form?.dataset.verifyRun) {
      delete form.dataset.verifyRun;
    }
    const caption = verify.closest?.("label")?.querySelector?.("span");
    if (caption) setText(caption, toggle.label);
    if (!toggle.enabled && active === verify && input?.focus) input.focus();
  }

  const autoPack = q("#auto-pack-toggle");
  const packEl = q("#pack-select");
  if (packEl && autoPack?.checked) setAttr(packEl, "disabled", "");

  const effort = q("#effort-select");
  if (effort) {
    if (mode.kind === "append" && mode.runId) {
      if (form?.dataset.effortRun !== mode.runId) {
        const fromRun = typeof mode.effort === "string" ? mode.effort : "";
        if (fromRun && [...effort.options].some((o) => o.value === fromRun)) {
          effort.value = fromRun;
        }
        if (form) form.dataset.effortRun = mode.runId;
      }
    } else if (mode.kind === "new" && form?.dataset.effortRun) {
      delete form.dataset.effortRun;
    }
  }

  const workdirEl = q("#workdir-select");
  const workdirTrigger = q("#workdir-trigger");
  const workdirField = q("#workdir-combobox");
  if (workdirEl instanceof HTMLSelectElement) {
    const locked = mode.workdirLocked === true;
    if (locked && mode.workdir) {
      if (![...workdirEl.options].some((o) => o.value === mode.workdir)) {
        const opt = workdirEl.ownerDocument.createElement("option");
        opt.value = mode.workdir;
        opt.textContent = mode.workdir;
        opt.title = mode.workdir;
        workdirEl.insertBefore(opt, workdirEl.firstChild);
      }
      workdirEl.value = mode.workdir;
      workdirEl.title = mode.workdir;
      workdirEl.dataset.extras = "[]";
      if (form) form.dataset.workdirRun = String(mode.runId ?? "");
    } else if (!locked && form?.dataset.workdirRun) {
      delete form.dataset.workdirRun;
    }
    const triggerText = q("#workdir-trigger-text");
    if (triggerText) {
      const extras = locked ? [] : parseWorkdirExtrasAttr(workdirEl.dataset.extras);
      triggerText.textContent = formatWorkdirTriggerLabel(workdirEl.value || mode.workdir, extras);
    }
    setAttr(workdirEl, "disabled", locked ? "" : null);
    if (workdirTrigger) {
      setAttr(workdirTrigger, "disabled", locked ? "" : null);
      workdirTrigger.title = locked
        ? `本对话的工作目录：${mode.workdir ?? workdirEl.value}（开新对话时可另选）`
        : (workdirEl.value || "选择目录");
    }
    if (workdirField) setClass(workdirField, "scope-field--locked", locked);
  }
}

/**
 * 排队消息 chips（信息队列）。数据从事件重放长出（state.queuedMessages），
 * 这里只画：每条一个 chip，带 ✕ 取消（DELETE /api/runs/:id/queue，body {index}）。
 * 纯函数返回 HTML 字符串；事件绑定在控制器（index.html）用事件委托挂一次。
 * @param {unknown} queuedMessages
 * @returns {string} 空串 = 没有排队消息（调用方据此隐藏容器）
 */
export function renderQueueChips(queuedMessages, opts = {}) {
  const items = Array.isArray(queuedMessages) ? queuedMessages.map(String).filter((t) => t.trim()) : [];
  const insertNow = opts.insertNow === true;
  if (!items.length && !insertNow) return "";
  const insertBtn = insertNow
    ? `<button type="button" class="insert-now-btn" data-insert-now="1" title="立即插入当前输入，下一轮模型调用前生效">` +
      `<i class="ph ph-lightning" aria-hidden="true"></i><span>立即插入</span></button>`
    : "";
  const chips = items.length
    ? `<span class="queue-chips-label">排队中</span>` +
      items
        .map((text, i) => {
          const face = paintConversationUserText(text);
          const painted = face.display || face.stub || stripHostEditScopeChrome(text) || text;
          return (
            `<span class="queue-chip" title="${esc(painted)}">` +
            `<span class="queue-chip-text">${esc(truncate(painted, 40))}</span>` +
            `<button type="button" class="queue-chip-insert" data-steer-index="${i}" aria-label="立即插入这条">` +
            `<i class="ph ph-lightning" aria-hidden="true"></i></button>` +
            `<button type="button" class="queue-chip-cancel" data-index="${i}" aria-label="取消这条排队消息">✕</button>` +
            `</span>`
          );
        })
        .join("")
    : "";
  return insertBtn + chips;
}

/**
 * 传输层断了，还是服务端正常收流了？
 *
 * 委托方截图里，一个状态是**已完成**的运行顶上挂着「连接中断，正在重连…」。
 * 根因是 EventSource 这一层**分辨不了**这两件事：服务端推完 run_end 就
 * `res.end()`，浏览器收到 FIN 派发的同样是 `error`、readyState 同样是
 * CONNECTING。而 run_end 那条 message 还在 batcher 队列里（一帧之后才 flush），
 * 所以顺序被结构性地固定成"先 error 挂横幅、后 flush 才 close"——前端永远
 * 抢不到前面。**必现，不是竞态。**
 *
 * 既然传输层分不了，就用 harness 事实去分：两边任一说这个 run 已经结束，
 * 就不是断线。（从侧栏点开一条历史运行同样走这条路——那时本地状态还是
 * `createInitialState` 的默认 "running"，只有服务端列表说得出真话。）
 */
export function shouldShowReconnecting({ info, localStatus } = {}) {
  if (localStatus === "done") return false;
  if (info && info.status === "done") return false;
  return true;
}

/**
 * 需要人介入的事项——ActionRail 的唯一数据源。
 *
 * unverified 只在这里出现一次；裁决卡里的同一批是详情下钻，不是第二份清单
 * （V-16：此前概览的"裁决卡"与"需介入事项"把它列了两遍）。
 */
export function deriveActionState(state) {
  const pendingAll = runHasClosed(state)
    ? []
    : state.pendingApprovals.filter((a) => a.status === "pending");
  const pending = pendingAll.filter(
    (a) => !isChildAgentSource(a.source) && !isInternallyResolvedApprovalSource(a.source),
  );
  const childPending = pendingAll.filter((a) => isChildAgentSource(a.source));
  const unverified = state.verdict ? state.verdict.unverified : [];
  // 计划确认门（§5.1）：签字位也是"需你决定"，而且是最靠前的那一件——
  // 它挂起时一个子任务都还没发射，此刻的决定成本最低
  const planPending = !runHasClosed(state) && state.planApproval?.status === "pending";
  /**
   * §5.2 提问同属"需你现在决定"，而且是**阻塞式**的——执行协程正吊在
   * ask_user 的 execute 里等这一下。不进 needsAttention 就等于整个运行卡死
   * 而界面上什么都没有（V-01/V-05 那一族）。
   */
  const questionPending = state.question?.status === "pending";
  const handoffPending = state.handoff?.status === "pending";
  const blockers = Array.isArray(state.completion?.blockers) ? state.completion.blockers : [];
  return {
    pendingApprovals: pending,
    childApprovalCount: childPending.length,
    unverifiedItems: unverified,
    planApproval: state.planApproval ?? null,
    awaitingPlan: planPending,
    question: state.question ?? null,
    awaitingQuestion: questionPending,
    handoff: state.handoff ?? null,
    awaitingHandoff: handoffPending,
    blockers,
    needsAttention:
      planPending ||
      questionPending ||
      handoffPending ||
      pending.length > 0 ||
      childPending.length > 0 ||
      blockers.length > 0,
  };
}

// ---------------------------------------------------------------
// 阶段二 新增：概览模型 (R-03)
// ---------------------------------------------------------------

/**
 * 从 RunState 派生出概览模型——无需展开日志即可判断任务成败与下一步。
 * @param {RunState} state
 * @returns {OverviewModel}
 */
export function deriveOverview(state) {
  // 结果摘要：时间线中最后一条 assistant_text
  const lastAssistant = [...state.timeline].reverse().find(
    (e) => e.type === "assistant_text" && !isChildAgentSource(e.source),
  );

  // 待介入事项：子代理的审批挂在子代理卡片上，不进主坞清单
  const pendingApprovals = visiblePendingApprovals(state);
  // 已处理审批（allow/deny/expired）：保留为只读记录，不得静默丢失
  const resolvedApprovals = state.pendingApprovals.filter(
    (a) => a.status !== "pending",
  );
  const unverifiedItems = state.verdict ? state.verdict.unverified : [];
  const blockers = Array.isArray(state.completion?.blockers) ? state.completion.blockers : [];

  return {
    finalStatus: state.error ? "error" : state.status,
    resultSummary: state.completion?.summary ?? (lastAssistant ? lastAssistant.text ?? null : null),
    completion: state.completion,
    verdict: state.verdict,
    actionItems: {
      pendingApprovals,
      unverifiedItems,
      blockers,
    },
    resolvedApprovals,
    usage: state.usage,
  };
}

// ---------------------------------------------------------------
// 阶段二 新增：日志分层 (R-04)
// ---------------------------------------------------------------

/**
 * 合并主 timeline 与核查 timeline，为每条添加折叠状态。
 * 规则：
 *   - 成功 tool_result、tool_call、turn_start、assistant_text → collapsed=true
 *   - 失败 tool_result (resultIsError)、approval_request、api_retry、compaction → collapsed=false
 * @param {RunState} state
 * @returns {LogEntry[]}
 */
export function deriveLogEntries(state) {
  const all = [...state.timeline, ...state.verifierTimeline].sort(
    (a, b) => a.seq - b.seq,
  );
  return all.map((e) => ({
    ...e,
    // V-12：tool_result 事件本身不带 name（src/loop.ts:259-264），此前界面直接
    // 显示 `toolu_01AbC… 成功`。在派生层按 toolUseId 回填，渲染层不必知道这件事。
    ...(e.type === "tool_result" && !e.name && state.toolNames[e.toolUseId]
      ? { name: state.toolNames[e.toolUseId] }
      : {}),
    collapsed: defaultCollapsed(e),
  }));
}

/**
 * 判断单条时间线条目默认是否折叠。
 * @param {TimelineEntry} entry
 * @returns {boolean}
 */
function defaultCollapsed(entry) {
  // 失败结果 → 展开
  if (entry.type === "tool_result" && entry.resultIsError) return false;
  // 审批请求 → 展开
  if (entry.type === "approval_request") return false;
  // API 重试 → 展开
  if (entry.type === "api_retry") return false;
  if (entry.type === "model_call_end" && entry.status === "error") return false;
  // 换端点 → 展开：这一行解释了后面所有轮次是谁应答的，折起来等于藏了变量
  if (entry.type === "model_fallback") return false;
  if (entry.type === "segment_resume") return false;
  if (entry.type === "recovery_decision") return false;
  if (entry.type === "run_forked") return false;
  if (entry.type === "run_resumed") return false;
  if (entry.type === "plan_resume") return false;
  // 上下文压缩 → 展开
  if (entry.type === "compaction") return false;
  if (entry.type === "hook" && (entry.outcome === "block" || entry.outcome === "error")) return false;
  // 信息队列：人发出的插队/排队指令 → 展开（这是"我做了什么"，折起来等于藏了变量）
  if (entry.type === "steering" || entry.type === "message_queued") return false;
  // 其余（turn_start、tool_call、成功 tool_result、assistant_text）→ 折叠
  return true;
}

/**
 * 切换指定 seq 日志条目的折叠状态。
 * @param {LogEntry[]} entries
 * @param {number} seq
 * @returns {LogEntry[]}
 */
export function toggleEntryCollapsed(entries, seq) {
  return entries.map((e) =>
    e.seq === seq ? { ...e, collapsed: !e.collapsed } : e,
  );
}

/**
 * 把"用户手动展开/折叠过哪些条"的覆盖表贴到派生条目上。
 * 覆盖表里没有的条，走 deriveLogEntries 给的默认（成功折叠、异常展开）。
 */
export function applyCollapseOverrides(entries, overrides) {
  if (!overrides || overrides.size === 0) return entries;
  return entries.map((e) => (overrides.has(e.seq) ? { ...e, collapsed: overrides.get(e.seq) } : e));
}

/**
 * 点一下之后，这一条的覆盖值该写成什么。
 *
 * **必须先把默认值算进来再翻**。宿主此前直接对覆盖表取反，而表里没有这一条时
 * 取反得到 true——可多数条目（tool_call、成功的 tool_result、assistant_text、
 * turn_start）默认就是 `collapsed: true`。于是**第一次点击把 true 写成 true**：
 * 状态没变、DOM 早退、屏幕上一点反应都没有，要点第二下才展开。
 * AC-04 说的"两次操作可达原始详情"实际是三次，且第一次零反馈。
 *
 * 这个 bug 能活下来，是因为宿主自己另写了一套 toggle，而被测的
 * `toggleEntryCollapsed` **全仓零调用**——测试测的是产品不用的那份实现。
 * 所以这里把"算默认 → 翻转"整条做成纯函数，宿主只许调它。
 *
 * @returns {boolean|null} 该写进覆盖表的值；seq 不存在时返回 null
 */
export function nextCollapseOverride(entries, overrides, seq) {
  const hit = toggleEntryCollapsed(applyCollapseOverrides(entries, overrides), seq).find(
    (e) => e.seq === seq,
  );
  return hit ? hit.collapsed : null;
}

// ---------------------------------------------------------------
// 阶段二 新增：运行列表元数据与筛选 (R-08)
// ---------------------------------------------------------------

const NEWLINE_RE = /\r?\n/;
const ATTACH_RE = /^附件[：:]/;
const ATTACH_CAPTURE_RE = /^附件[：:]\s*(.+)$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const PATH_SEP_RE = /[\\/]/;
const HEADING_RE = /^#{1,6}\s*/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const QUOTE_RE = /^(?:&gt;|>)\s*/;
const SPACES_RE = /\s+/g;

/** 截断到 max 字并补省略号；刚好放得下就不补 */
function clip(text, max) {
  const t = String(text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 从 runs 列表和 runStates 派生每条运行的列表展示元数据。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {Map<string, RunState>} runStates
 * @returns {Map<string, RunListItemMeta>}
 */
/**
 * 会话标题：从任务文本里**算**一个短标题出来。
 *
 * 侧栏此前直接铺任务原文，一条几百字的任务描述会占掉三四行、还看不出是什么
 * （委托方截图里第一条就是 `附件：uploads/65a53cbdab081af8413977836a52f10b.jpg…`）。
 *
 * **为什么不让模型生成标题**：那是每次运行多付一次调用，而任务的第一句
 * 本来就是人自己写的概括。花钱买一个它已经知道的答案，不合算——
 * 真需要更好的标题时，人可以自己改第一句。
 *
 * 只上传附件、没写文字时特殊处理：拿文件名当标题，
 * 因为 `附件：uploads/<32 位哈希>.jpg` 里唯一有信息量的就是那个扩展名与前几位。
 */
export function titleSourceText(task) {
  const painted = paintConversationUserText(task);
  const source = painted.display || painted.stub || stripHostEditScopeChrome(task);
  const lines = source.split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !ATTACH_RE.test(l)) ?? "";
}

/**
 * 存盘标题必须能对上用户原话。模型润色常把「给仓库 UI 设计标题」
 * 收成方案名（「流光·智能仓储中枢」），侧栏就变成交付物。
 */
export function titleReflectsTask(title, task) {
  const t = String(title ?? "").trim();
  const source = titleSourceText(task);
  if (!t || !source) return false;
  const src = source.toLocaleLowerCase();
  const compact = t.replace(/[\s"'「」『』“”·\-_|]/g, "").toLocaleLowerCase();
  if (!compact) return false;
  if (src.includes(compact) || compact.includes(src.slice(0, Math.min(8, src.length)))) return true;
  const hay = new Set(titleContentPieces(source));
  return titleContentPieces(t).some((p) => hay.has(p) || src.includes(p));
}

function titleContentPieces(text) {
  const s = String(text ?? "").toLocaleLowerCase();
  const out = [];
  for (const w of s.match(/[a-z]{2,}/g) ?? []) out.push(w);
  const cjk = [...s.replace(/[^\u4e00-\u9fff]/g, "")];
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]);
  return out;
}

export function resolveDisplayedTitle(stored, task, max = 24) {
  const t = String(stored ?? "").trim();
  if (t && titleReflectsTask(t, task)) return clip(t, max);
  return deriveRunTitle(task, max);
}

/** 页内眉标：FATHOM · RUN + runId 前 6 位大写（去连字符）。 */
/**
 * 浏览器标签与桌面窗框同一套：首页 `FATHOM`，对话 `FATHOM · 对话`，
 * 设置 / 指挥中心 / 产物 / 定时任务 / 消耗同款。不要写「FATHOM 控制台」。
 */
export const DOCUMENT_TAB_LABELS = Object.freeze({
  home: null,
  run: "对话",
  settings: "设置",
  schedules: "定时任务",
  board: "指挥中心",
  artifacts: "产物",
  artifact: "产物",
  usage: "消耗",
});

export function documentTabTitle(kind) {
  const label = DOCUMENT_TAB_LABELS[kind];
  return label ? `FATHOM · ${label}` : "FATHOM";
}

export function applyDocumentTabTitle(kind, doc = typeof document !== "undefined" ? document : null) {
  const title = documentTabTitle(kind);
  if (!doc) return title;
  if (doc.title !== title) doc.title = title;
  const h1 = doc.querySelector?.("header.sr-only h1");
  if (h1 && h1.textContent !== title) h1.textContent = title;
  return title;
}

export function formatRunKicker(runId) {
  const raw = String(runId ?? "").replace(/-/g, "");
  const short = raw.slice(0, 6).toUpperCase() || "------";
  return `FATHOM · RUN ${short}`;
}

const PLUMB_KICKER_SVG =
  '<svg class="fathom-plumb" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">' +
  '<line class="fathom-line" x1="13" y1="3" x2="13" y2="16" stroke-width="2.6"/>' +
  '<circle class="fathom-bob" cx="13" cy="19" r="2.2"/>' +
  "</svg>";

export function deriveRunTitle(task, max = 24) {
  const raw = String(task ?? "").trim();
  if (!raw) return "未命名任务";

  const lines = raw.split(NEWLINE_RE).map((l) => l.trim()).filter(Boolean);
  // 优先取第一条**不是附件行**的内容——附件是补充材料，不是任务本身
  const meaningful = titleSourceText(raw);
  if (!meaningful) {
    const m = ATTACH_CAPTURE_RE.exec(lines[0] ?? "");
    const file = (m?.[1] ?? "").split(PATH_SEP_RE).pop() ?? "";
    return file ? `附件 ${clip(file, max)}` : "附件";
  }

  // 去掉 Markdown 的行首记法：标题/列表/引用符号本身不是标题内容
  const cleaned = meaningful
    .replace(HEADING_RE, "")
    .replace(BULLET_RE, "")
    .replace(ORDERED_RE, "")
    .replace(QUOTE_RE, "")
    .replace(SPACES_RE, " ")
    .trim();
  return clip(cleaned, max) || "未命名任务";
}

/**
 * 一轮收尾后的短摘要：取执行者最后一段正文的首句。
 *
 * 不另开模型——标题已经用任务第一句（见 deriveRunTitle），摘要只是把
 * 「这一轮最后说了什么」压成侧栏能扫的一行。续跑 fort 后子 run 只带
 * 最后一轮对话，没有这行的话上一轮交付看起来像消失了。
 */
export function deriveConversationRecap(state, max = 72) {
  const lines = [];
  for (const e of state.timeline ?? []) {
    if (e.type !== "assistant_text") continue;
    if (segmentRole(e.source) === "verifier" || segmentRole(e.source) === "planner") continue;
    const text = String(e.text ?? "").trim();
    if (text) lines.push(text);
  }
  const last = lines.at(-1) || String(state.verdict?.summary ?? "").trim();
  return last ? clip(firstSentence(last), max) : "";
}

/** 沿 continuedFrom 走到这场对话最初那一头 */
export function conversationRootId(runs, runId) {
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  let cur = runId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node?.continuedFrom) return cur;
    cur = node.continuedFrom;
  }
  return runId;
}

/** 一场对话谱系上的全部 runId（祖先 + 子孙），删对话时整条走 */
export function conversationChainIds(runs, runId) {
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  const ids = new Set();
  let cur = runId;
  while (cur && !ids.has(cur)) {
    ids.add(cur);
    cur = byId.get(cur)?.continuedFrom;
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of runs ?? []) {
      if (r.continuedFrom && ids.has(r.continuedFrom) && !ids.has(r.runId)) {
        ids.add(r.runId);
        grew = true;
      }
    }
  }
  return [...ids];
}

/** 侧栏标题永远用根任务，不跟最后一句追问走 */
export function deriveThreadTitle(runs, runId, max = 24) {
  const rootId = conversationRootId(runs, runId);
  const root = (runs ?? []).find((r) => r.runId === rootId);
  const tip = (runs ?? []).find((r) => r.runId === runId);
  return resolveDisplayedTitle(root?.title || tip?.title, root?.task ?? tip?.task, max);
}

function firstSentence(text) {
  const cleaned = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const cut = cleaned.split(/(?<=[。！？.!?])\s+/)[0] ?? cleaned;
  return cut.trim();
}

/** 路径是否像一张可预览的图片（按扩展名，不读魔数） */
export function isImagePath(p) {
  return IMAGE_EXT_RE.test(String(p ?? "").split(/[?#]/)[0] ?? "");
}

const DOC_EXT_RE = /\.(md|txt|pdf|docx?|rtf|csv|rst|adoc)$/i;
const WEB_EXT_RE = /\.(html?|css|scss|less|jsx?|mjs|cjs)$/i;
const FILE_GROUPS = [
  { id: "image", label: "图片", icon: "ph-image" },
  { id: "website", label: "网站", icon: "ph-globe" },
  { id: "document", label: "文档", icon: "ph-file-text" },
  { id: "other", label: "其他", icon: "ph-file" },
];

/** 对话里默认露出的产物数；多出来的进「显示全部」。 */
export const ARTIFACT_PREVIEW_LIMIT = 5;

const ARTIFACT_ENTRY_RE = /^(index|home|main|app|default)\.html?$/i;
const ARTIFACT_PREVIEW_NAME_RE = /preview|screenshot|hero|cover|poster|thumb/i;
const ARTIFACT_README_RE = /^readme(\.|$)/i;
const ARTIFACT_SUPPORT_RE = /\.(css|scss|less|js|mjs|cjs)$/i;

/**
 * 从任务原文猜用户最想要的交付类型。做网站就先抬 html 入口，而不是一堆 css。
 */
export function inferArtifactIntent(task, files = []) {
  const t = String(task ?? "");
  if (/网站|网页|站点|主页|homepage|landing|website|web\b|\.html/i.test(t)) return "website";
  if (/海报|封面|图片|插画|图标|banner|illustration/i.test(t)) return "image";
  if (/文档|说明书|报告|readme|设计说明|markdown/i.test(t)) return "document";
  const counts = { website: 0, image: 0, document: 0, other: 0 };
  for (const f of files) counts[classifySessionFile(f?.path)] += 1;
  if (counts.website >= 2 && counts.website >= counts.image && counts.website >= counts.document) {
    return "website";
  }
  return "general";
}

/**
 * 从 finish_task.artifacts 的自由文本条目里提取真实路径（可能零个或多个）。
 *
 * 背景（委托方实证）：模型把注释写进了同一条目——
 *   "ad7793_board.kicad_pcb(回填 AD7793 终板,铺铜+缝合+mitre,DRC parity 0)"
 *   "memory: ad7793-pinout.md / kicad-host-kit-lessons.md"
 *   "gerber/(Gerber 8 层 + 钻孔 .drl)"
 * 整条字符串被当成文件路径，产物卡点了必报 Artifact not found。
 *
 * 提取规则，按序执行：
 *   ① 剥 `memory:` 这类标签前缀——要求 ≥2 个字符 + 冒号后空白，
 *      Windows 盘符（`D:\…`、`C:/…`）天然不满足，不会误剥；
 *   ② 反复剥尾部成对括号注释（中英括号皆可；未闭合的括号不动，
 *      文件名里真有括号也不误伤）；
 *   ③ 按**带空格的** " / " 拆并列路径——裸 "/" 是路径分隔符，拆不得；
 *   ④ 去首尾空白，空段丢弃。
 * 展示层清洗，不回写事件流——审计面一字不动。
 */
export function extractArtifactPaths(entry) {
  let s = String(entry ?? "").trim();
  if (!s) return [];
  s = s.replace(/^[A-Za-z][\w-]+:\s+/, "");
  const out = [];
  for (const seg of s.split(/\s+\/\s+/)) {
    let p = seg.trim();
    for (;;) {
      const stripped = p.replace(/\s*[（(][^（）()]*[)）]\s*$/, "");
      if (stripped === p) break;
      p = stripped.trim();
    }
    if (p) out.push(p);
  }
  return out;
}

function declaredArtifactIndex(declared, path) {
  const norm = (p) => String(p ?? "").replace(/\\/g, "/").trim();
  const target = norm(path);
  const base = fileBasename(target).toLowerCase();
  const list = (declared ?? []).map(norm).filter(Boolean);
  let at = list.findIndex((p) => p === target);
  if (at < 0) at = list.findIndex((p) => fileBasename(p).toLowerCase() === base);
  return at;
}

/** 越高越该露在前 5 个。声明交付 > 站点入口 > 任务意图匹配 > 配图/文档。 */
export function scoreDeliveryArtifact(file, { task = "", declared = [], files = [] } = {}) {
  const path = String(file?.path ?? "").replace(/\\/g, "/");
  const base = fileBasename(path);
  const group = classifySessionFile(path);
  const intent = inferArtifactIntent(task, files.length ? files : [file]);
  let w = 0;
  const declaredAt = declaredArtifactIndex(declared, path);
  if (declaredAt >= 0) w += 1000 - Math.min(declaredAt, 99);
  if (ARTIFACT_ENTRY_RE.test(base)) w += 500;
  if (intent === "website" && group === "website") w += 300;
  if (intent === "website" && ARTIFACT_ENTRY_RE.test(base)) w += 200;
  if (intent === "image" && group === "image") w += 300;
  if (intent === "document" && group === "document") w += 300;
  if (ARTIFACT_README_RE.test(base)) w += 80;
  if (ARTIFACT_PREVIEW_NAME_RE.test(base) && group === "image") w += 160;
  if (group === "website") w += 50;
  if (group === "image") w += 40;
  if (group === "document") w += 20;
  if (ARTIFACT_SUPPORT_RE.test(base)) w -= 80;
  if (/node_modules|[\\/](\.git|dist|build)[\\/]|\.map$/i.test(path)) w -= 400;
  return w;
}

export function rankDeliveryArtifacts(files, { task = "", declared = [] } = {}) {
  const list = (files ?? []).filter((f) => f && f.path && f.kind !== "upload");
  return [...list].sort((a, b) => {
    const diff = scoreDeliveryArtifact(b, { task, declared, files: list })
      - scoreDeliveryArtifact(a, { task, declared, files: list });
    if (diff !== 0) return diff;
    return String(a.path).localeCompare(String(b.path));
  });
}

/** 产物按扩展名归类；空类不渲染。 */
export function classifySessionFile(path) {
  const clean = String(path ?? "").split(/[?#]/)[0] ?? "";
  if (IMAGE_EXT_RE.test(clean)) return "image";
  if (WEB_EXT_RE.test(clean)) return "website";
  if (DOC_EXT_RE.test(clean)) return "document";
  return "other";
}

function fileBasename(path) {
  const s = String(path ?? "").replace(/\\/g, "/");
  return s.split("/").pop() || s;
}

const ARTIFACT_NOISE_RE =
  /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)|(?:^|[\\/])\.polish-artifacts(?:[\\/]|$)/i;
const ARTIFACT_HELPER_RE =
  /(?:^|[\\/])(?:capture|jpgsize|parse-[\w-]+|run-layout-check|verify-[\w-]+)\.(?:mjs|cjs|js)$/i;

/** 核查脚本、临时目录、依赖树——不是这场对话要交付的东西 */
export function isNoiseArtifact(path) {
  const p = String(path ?? "").replace(/\\/g, "/");
  return ARTIFACT_NOISE_RE.test(p) || ARTIFACT_HELPER_RE.test(p);
}

/** 卡片标题：太长就留末两段，避免把整条绝对路径铺满。 */
export function fileShortPath(path) {
  const s = String(path ?? "").replace(/\\/g, "/");
  const parts = s.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || fileBasename(path);
  return parts.slice(-2).join("/");
}

/** Cowork 式副标题：图片 / 网站 / 表格 / 代码 / 文档 / 文件 */
export function artifactKindLabel(path) {
  const clean = String(path ?? "").split(/[?#]/)[0] ?? "";
  if (IMAGE_EXT_RE.test(clean)) return "图片";
  if (/\.html?$/i.test(clean)) return "网站";
  if (/\.(csv|tsv|xlsx?)$/i.test(clean)) return "表格";
  if (/\.(css|scss|less|jsx?|mjs|cjs|tsx?|py|c|cpp|h|rs|go|java)$/i.test(clean)) return "代码";
  if (DOC_EXT_RE.test(clean)) return "文档";
  return "文件";
}

function artifactKindIcon(label) {
  switch (label) {
    case "图片": return "ph-image";
    case "网站": return "ph-globe";
    case "表格": return "ph-table";
    case "代码": return "ph-code";
    case "文档": return "ph-file-text";
    default: return "ph-file";
  }
}

/**
 * 宿主曾把画布当前页写成 [改稿范围]/[改范围] 贴进续跑正文（只改那一页）。
 * 默认 UI 不再注入；历史正史里还可能带着这行，画气泡/排队 chip/侧栏标题时剥掉，用户原话留下。
 */
export function stripHostEditScopeChrome(text) {
  return String(text ?? "")
    .replace(/\[改稿范围\][^\n]*/g, "")
    .replace(/\[改范围\][^\n]*/g, "")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** finish_task 回执；续跑时可能焊在下一句人话前面。只在画气泡时剥，正史不动。 */
export const TERMINAL_TOOL_ACK_DISPLAY = "已收到，交付完成。";
const TERMINAL_TOOL_ACK_SPLIT_RE = /已收到，交付完成。?/g;
const HUGE_DOCUMENT_CHARS = 20_000;
const HTML_DOCUMENT_FOLD_CHARS = 512;

export function looksLikeHtmlDocument(text) {
  const t = String(text ?? "").trim();
  return /^<!DOCTYPE\s+html\b/i.test(t) || /^<html[\s>]/i.test(t);
}

/** 整份 HTML / 超大 write_file 体——对话里只能留一行摘要。 */
export function looksLikeHugeDocumentBody(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length >= HUGE_DOCUMENT_CHARS) return true;
  return looksLikeHtmlDocument(t) && t.length >= HTML_DOCUMENT_FOLD_CHARS;
}

/**
 * 工具回执（不是人说的话）。只认行首/整段形态，避免误伤「Progress updated 了吗」。
 */
export function isToolReceiptText(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/^已收到，交付完成。?$/.test(t)) return true;
  if (/^未执行：本轮已通过终结工具交付/.test(t)) return true;
  if (/^终结工具入参不符合交付契约/.test(t)) return true;
  if (/^Progress updated\s*\(\d+\)/.test(t)) return true;
  if (/^\[execution boundary=/.test(t)) return true;
  if (/^Wrote \d+ bytes\b/.test(t)) return true;
  if (/^Refused:/.test(t)) return true;
  if (/^Command exited with\s+\d+/.test(t)) return true;
  if (/^Legacy execution boundary/.test(t)) return true;
  return false;
}

function isToolReceiptLeadLine(line) {
  const t = String(line ?? "").trim();
  return !t || isToolReceiptText(t);
}

function conversationLooksHuman(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (looksLikeHugeDocumentBody(t) || looksLikeHtmlDocument(t)) return false;
  if (isToolReceiptText(t)) return false;
  return true;
}

/**
 * 续跑把 tool_result / 「已收到，交付完成」焊进人话时，对话面只留人话。
 * 模型仍看得到原串（事件 / messages 不改）。
 */
export function peelHostToolReceipts(text) {
  let t = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  if (TERMINAL_TOOL_ACK_SPLIT_RE.test(t)) {
    TERMINAL_TOOL_ACK_SPLIT_RE.lastIndex = 0;
    const chunks = t.split(TERMINAL_TOOL_ACK_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
    const human = [...chunks].reverse().find((c) => conversationLooksHuman(c));
    t = human ?? chunks.filter((c) => conversationLooksHuman(c)).join("\n\n").trim();
  }
  const lines = t.split("\n");
  let start = 0;
  while (start < lines.length && isToolReceiptLeadLine(lines[start])) start++;
  t = lines.slice(start).join("\n").trim();
  return conversationLooksHuman(t) ? t : "";
}

export function foldedDocumentStub(text, opts = {}) {
  const raw = String(text ?? "");
  const path = typeof opts.path === "string" ? opts.path : "";
  const name = path ? String(path).split(/[/\\]/).pop() : "";
  const kb = Math.max(1, Math.round(raw.length / 1024));
  const html = looksLikeHtmlDocument(raw);
  const written = opts.written === true || String(opts.tool ?? "") === "write_file";
  if (name && written) return `已写入 ${name}（约 ${kb}KB）`;
  if (html) return name ? `已折叠 ${name}（约 ${kb}KB）` : "工具读回了一份 HTML，已折叠";
  if (name) return `已折叠 ${name}（约 ${kb}KB）`;
  return `长内容已折叠（约 ${kb}KB）`;
}

function toolBodyCandidate(input, result) {
  const fromInput = input && typeof input === "object"
    ? String(input.content ?? input.contents ?? input.body ?? "")
    : "";
  const fromResult = String(result ?? "");
  if (looksLikeHugeDocumentBody(fromInput) || looksLikeHtmlDocument(fromInput)) return fromInput;
  if (looksLikeHugeDocumentBody(fromResult) || looksLikeHtmlDocument(fromResult)) return fromResult;
  return fromResult || fromInput;
}

function toolPathHint(input) {
  if (!input || typeof input !== "object") return "";
  return String(input.path ?? input.file_path ?? "").trim();
}

/**
 * 用户气泡的展示层：剥页锁 / 工具回执 / 焊上的终结回执，巨文档改成一行摘要。
 * `it.text` 仍是原文，不改事件、不改正史。
 *
 * @returns {{kind:"text"|"document"|"receipt", display:string, stub:string}}
 */
export function paintConversationUserText(text) {
  const { displayBody } = splitUserMessageAttachments(text);
  const stripped = stripHostEditScopeChrome(displayBody);
  const peeled = peelHostToolReceipts(stripped);
  if (peeled) {
    if (looksLikeHugeDocumentBody(peeled) || looksLikeHtmlDocument(peeled)) {
      return { kind: "document", display: "", stub: foldedDocumentStub(peeled) };
    }
    return { kind: "text", display: peeled, stub: "" };
  }
  const raw = stripped || String(text ?? "").trim();
  if (looksLikeHugeDocumentBody(raw) || looksLikeHtmlDocument(raw)) {
    const path = toolPathHint({ path: raw.match(/index\.html/i) ? "index.html" : "" });
    return { kind: "document", display: "", stub: foldedDocumentStub(raw, { path }) };
  }
  if (isToolReceiptText(raw) || !raw) {
    return { kind: "receipt", display: "", stub: "工具回执，已折叠" };
  }
  return { kind: "text", display: "", stub: "" };
}

export function foldConversationBody(text, opts = {}) {
  const t = String(text ?? "");
  if (!looksLikeHugeDocumentBody(t) && !looksLikeHtmlDocument(t)) return null;
  return {
    stub: foldedDocumentStub(t, opts),
    detailsHtml: renderFoldedDocument(t, "展开全文"),
  };
}

function renderFoldedDocument(text, summary) {
  return (
    `<details class="chat-aside chat-doc-fold">` +
    `<summary>${esc(summary)}</summary>` +
    `<pre class="chat-doc-fold-body">${esc(truncate(String(text ?? ""), 12000))}</pre>` +
    `</details>`
  );
}

function renderFoldedToolReceiptChip(stub, raw) {
  return (
    `<details class="chat-aside chat-tool-receipt">` +
    `<summary>工具 · ${esc(stub)}</summary>` +
    `<pre class="chat-doc-fold-body">${esc(truncate(String(raw ?? ""), 4000))}</pre>` +
    `</details>`
  );
}

/**
 * 从用户消息里拆出正文与附件行。`body` 仍含附件行（模型看到的原文）；
 * `displayBody` 去掉附件行，给气泡右侧正文用——左侧已经有预览和「附件：」标注。
 */
export function splitUserMessageAttachments(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  /** @type {string[]} */
  const attachments = [];
  /** @type {string[]} */
  const body = [];
  /** @type {string[]} */
  const display = [];
  for (const line of lines) {
    const m = line.match(ATTACH_CAPTURE_RE);
    if (m) {
      attachments.push(m[1].trim());
      body.push(line);
    } else {
      body.push(line);
      display.push(line);
    }
  }
  return {
    body: body.join("\n"),
    displayBody: display.join("\n").trim(),
    attachments,
  };
}

/**
 * 会话侧栏 / 产物清单共用的文件列表：用户附件 + 工具写出的产物。
 */
export function deriveSessionFiles(state) {
  /** @type {Map<string, {path:string, kind:string, seq:number}>} */
  const byPath = new Map();
  for (const e of state.timeline ?? []) {
    if (e.type !== "user_message") continue;
    const { attachments } = splitUserMessageAttachments(e.text ?? "");
    for (const path of attachments) {
      if (!path || byPath.has(path)) continue;
      byPath.set(path, { path, kind: "upload", seq: e.seq ?? 0 });
    }
  }
  for (const a of deriveArtifacts(state)) {
    if (byPath.has(a.path)) continue;
    byPath.set(a.path, { path: a.path, kind: "artifact", seq: a.seq });
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 一场对话谱系上的全部产物。续跑 fort 后子 run 时间线只有最后一轮，
 * 父级写出的 html/图片不在当前事件流里——侧栏要沿 continuedFrom 拼回来。
 */
export function deriveThreadFiles(runs, runStates, tipId) {
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  const ids = [];
  const seen = new Set();
  let cur = tipId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    ids.unshift(cur);
    cur = byId.get(cur)?.continuedFrom;
  }
  const byPath = new Map();
  for (const id of ids) {
    const st = runStates instanceof Map ? runStates.get(id) : null;
    if (!st) continue;
    for (const f of deriveSessionFiles(st)) {
      byPath.set(f.path, f);
    }
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

export function deriveRunListItems(runs, runStates, unread) {
  /** @type {Map<string, RunListItemMeta>} */
  const map = new Map();
  for (const r of runs) {
    const state = runStates.get(r.runId);
    const duration = r.finishedAt ? r.finishedAt - r.createdAt : null;
    let verdictConclusion = null;
    if (state && state.verdict) {
      verdictConclusion = state.verdict.passed ? "passed" : "failed";
    } else if (state && state.verify && state.status !== "done") {
      verdictConclusion = "pending";
    }
    map.set(r.runId, {
      status: r.status,
      startTime: r.createdAt,
      duration,
      verdictConclusion,
      /**
       * 跑完了但你还没看过。
       *
       * 取代那条横贯整屏的「■ 已完成」——"这次结束了"是**列表**该说的事
       * （你可能同时开着好几个运行、正在别处忙），不是详情页该占一整行去说的事。
       * 判据由宿主维护：run 收尾时若它不是当前选中的那个就记上，选中即清。
       */
      unread: Boolean(unread && unread.has(r.runId)),
      recap: state ? deriveConversationRecap(state) : String(r.recap ?? ""),
    });
  }
  return map;
}

/**
 * 按状态筛选运行列表。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {Map<string, RunState>} states
 * @param {"all"|"running"|"done"|"failed"} filter
 * @returns {typeof runs}
 */
export function filterRunsByStatus(runs, states, filter) {
  if (filter === "all") return runs;
  return runs.filter((r) => {
    if (filter === "running") return r.status === "running";
    if (filter === "done") {
      // "已完成"：status=done 且（无核查 或 核查通过）
      const s = states.get(r.runId);
      if (r.status !== "done") return false;
      if (s && s.verdict && !s.verdict.passed) return false;
      return true;
    }
    if (filter === "failed") {
      const s = states.get(r.runId);
      return !!(s && s.verdict && !s.verdict.passed);
    }
    return true;
  });
}

/**
 * 按任务描述搜索运行。
 *
 * 只匹配 task 字段：runId 是 UUID，用户不会记；状态已有独立筛选器。
 * 大小写与首尾空白无关；空查询原样返回，不做任何过滤。
 * @param {{runId:string, task:string}[]} runs
 * @param {string} query
 */
export function filterRunsByQuery(runs, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => String(r.task ?? "").toLowerCase().includes(q));
}

/** 工作目录比较：正反斜杠与尾部分隔符无关。 */
export function sameWorkdirPath(a, b) {
  const norm = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * 欢迎页默认工作目录。有上次选择就用它；宿主 cwd 是产品仓且白名单里另有
 * scratch 时，不要默默落在源码树。不改 /api/harness.workdir（测试仍认启动 cwd）。
 */
export function pickWelcomeWorkdir({
  visible,
  keep,
  snapWorkdir,
  hostWorkdirIsHarness,
  hasPref,
} = {}) {
  const list = Array.isArray(visible) ? visible.filter(Boolean) : [];
  if (!list.length) return "";
  const keepHit = keep && list.find((d) => sameWorkdirPath(d, keep));
  if (keepHit) return keepHit;
  if (hostWorkdirIsHarness && !hasPref) {
    const scratch = list.find((d) => !sameWorkdirPath(d, snapWorkdir));
    if (scratch) return scratch;
  }
  return list.find((d) => sameWorkdirPath(d, snapWorkdir)) ?? list[0];
}

/**
 * 侧栏会话可见性。
 *
 * 旧谓词（会把多目录项目看空）：`sameWorkdirPath(run.workdir, composerWorkdir)`。
 * 选项目会把作曲栏 cwd 设成 primaryWorkdir，于是兄弟目录的对话全部消失。
 *
 * 新谓词：
 *   - 「全部项目」：不过滤
 *   - 选了项目：`run.projectId === project.id`，或（无/同 projectId 且
 *     workdir 落在该项目 workdirs，正反斜杠/尾斜杠无关）
 *   - 未入项剩目录：仍只按作曲栏路径（旧行为）
 * 空 workdir 不过滤（还没选目录时不要把列表藏空）。
 * 第 4 参可选——旧调用（2–3 个参数）保持按路径过滤。
 */
export function filterRunsByComposerWorkdir(runs, workdir, allProjects = false, project = null) {
  if (allProjects) return runs;
  if (project && (project.id || (Array.isArray(project.workdirs) && project.workdirs.length))) {
    return runs.filter((r) => runBelongsToProject(r, project));
  }
  const cur = String(workdir ?? "").trim();
  if (!cur) return runs;
  return runs.filter((r) => sameWorkdirPath(r.workdir, cur));
}

export function runBelongsToProject(run, project) {
  if (!project) return false;
  const runProject = String(run?.projectId ?? "").trim();
  const want = String(project.id ?? "").trim();
  if (runProject && want) {
    if (runProject === want) return true;
    return false;
  }
  const members = Array.isArray(project.workdirs) ? project.workdirs : [];
  return members.some((dir) => sameWorkdirPath(run?.workdir, dir));
}

/** 作曲栏 cwd：当前已是成员则保留，否则退回 primary。不拿 primary 当可见性过滤。 */
export function composerCwdForProject(project, currentWorkdir) {
  const current = String(currentWorkdir ?? "").trim();
  if (!project) return current;
  const members = Array.isArray(project.workdirs) ? project.workdirs : [];
  if (current && members.some((dir) => sameWorkdirPath(dir, current))) return current;
  return String(project.primaryWorkdir ?? current);
}

/** 侧栏分组：入项的 run 跟项目走；剩目录仍按路径末段。 */
export function findProjectForRun(run, projects) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return null;
  if (run?.projectId) {
    const hit = list.find((p) => p.id === run.projectId);
    if (hit) return hit;
  }
  if (run?.workdir) {
    return list.find((p) => (p.workdirs ?? []).some((dir) => sameWorkdirPath(dir, run.workdir))) ?? null;
  }
  return null;
}

/** 办公脸：显式 workspace，或旧档案 packName=design。其余归编码。只给新建默认 pack，不藏列表。 */
export function runBelongsToOffice(run) {
  if (run?.workspace === "office") return true;
  if (run?.workspace === "code") return false;
  return run?.packName === "design"
    || run?.mode === "design"
    || run?.facade === "design"
    || Boolean(run?.designRoute);
}

/**
 * 侧栏 membership：只认选中的项目实体。勾选的 extra 目录是下次 run 的
 * 读写范围，不合成「看得见谁」的过滤器。
 */
export function composerListMembership(project, _workdir, _extras = []) {
  if (project && (project.id || (Array.isArray(project.workdirs) && project.workdirs.length))) {
    return project;
  }
  return null;
}

/** 目录落在哪张脸：该路径上的 run 全是办公→office，全是编码→code；空或混用→两边都可见。 */
export function inferWorkdirFace(workdir, runs) {
  let office = 0;
  let code = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!sameWorkdirPath(run?.workdir, workdir)) continue;
    if (runBelongsToOffice(run)) office += 1;
    else code += 1;
  }
  if (office && !code) return "office";
  if (code && !office) return "code";
  return null;
}

export function workdirVisibleOnFace(workdir, face, runs) {
  const inferred = inferWorkdirFace(workdir, runs);
  if (!inferred) return true;
  const wantOffice = face === "office" || face === "work";
  return wantOffice ? inferred === "office" : inferred === "code";
}

/** Work 只留办公对话，Code 只留编码对话。 */
export function filterRunsByWorkspaceFace(runs, face) {
  const list = Array.isArray(runs) ? runs : [];
  const wantOffice = face === "office" || face === "work";
  return list.filter((r) => (wantOffice ? runBelongsToOffice(r) : !runBelongsToOffice(r)));
}

// ---------------------------------------------------------------
// 阶段二 新增：日志条目默认展开/折叠状态查询
// ---------------------------------------------------------------

/**
 * 查询摘要卡默认折叠状态——导出供渲染层和测试使用。
 * @param {TimelineEntry} entry
 * @returns {boolean}
 */
export function isEntryCollapsedByDefault(entry) {
  return defaultCollapsed(entry);
}

// ---------------------------------------------------------------
// 渲染辅助：标记审批已处理（由 DOM 层在 POST 应答成功后调用）
// ---------------------------------------------------------------

/**
 * 标记审批卡为已处理（allow/deny 应答后）。
 * @param {RunState} state
 * @param {string} toolUseId
 * @param {"allowed"|"denied"} decision
 * @param {string} [reason]
 * @returns {RunState}
 */
export function markApprovalResolved(state, ref, decision, reason) {
  // V-03：旧实现按 toolUseId 全量匹配，返工轮复用同一 id 时一次点击会连历史卡
  // 一起改写。改为：带 `#seq` 走精确匹配；裸 id 只命中最新的那张挂起卡。
  const target = findApprovalIndex(state.pendingApprovals, ref);
  if (target < 0) return state;
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a, i) =>
      i === target ? { ...a, status: decision, reason, decidedAt: Date.now() } : a,
    ),
  };
}

/** 解析审批引用（approvalId 或裸 toolUseId）到下标；裸 id 取最新的挂起项 */
function findApprovalIndex(approvals, ref) {
  if (typeof ref === "string" && ref.includes("#")) {
    return approvals.findIndex((a) => a.approvalId === ref);
  }
  let best = -1;
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i];
    if (a.toolUseId !== ref) continue;
    if (best < 0 || a.status === "pending") best = i;
  }
  return best;
}

/**
 * 将 run 中所有 pending 审批转为 expired（run 结束/出错时由前端主动同步调用）。
 * @param {RunState} state
 * @returns {RunState}
 */
export function expirePendingApprovals(state) {
  return {
    ...state,
    pendingApprovals: state.pendingApprovals.map((a) =>
      a.status === "pending" ? { ...a, status: /** @type {"expired"} */ ("expired") } : a,
    ),
  };
}

// ---------------------------------------------------------------
// DOM 渲染（仅浏览器环境调用——惰性引用 window/document）
// ---------------------------------------------------------------

/**
 * 渲染运行列表侧栏。
 * @param {{runId:string, task:string, status:string, verify:boolean, createdAt:number, finishedAt:number|null}[]} runs
 * @param {string|null} selectedRunId
 * @param {(runId:string)=>void} onSelect
 * @param {Map<string, import('./app.js').RunListItemMeta>} [metaMap]
 */
export const WORKDIR_GROUP_COLLAPSE_KEY = "agent.ui.pref.collapsedWorkdirs";

export function readCollapsedWorkdirGroups(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(WORKDIR_GROUP_COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function toggleCollapsedWorkdirGroup(key, storage = globalThis.localStorage) {
  const next = readCollapsedWorkdirGroups(storage);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  try {
    storage?.setItem?.(WORKDIR_GROUP_COLLAPSE_KEY, JSON.stringify([...next]));
  } catch { /* ignore */ }
  return next;
}

export function renderRunList(runs, selectedRunId, onSelect, metaMap, onDelete, groupState) {
  const listEl = document.getElementById("run-list");
  if (!listEl) return;
  if (runs.length === 0) {
    // 空态不得挂 role=listbox：listbox 必须含 option 子项（aria-required-children），
    // 空壳 listbox 是 critical 违规。role 与内容同生共死。
    listEl.removeAttribute("role");
    listEl.removeAttribute("aria-label");
    listEl.innerHTML = '<div class="run-list-empty">尚无运行。</div>';
    return;
  }
  // 有 option 子项时才挂 listbox 身份
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "项目与对话");
  // 空态留下的占位节点不属于 patchList 管辖，先清掉
  const placeholder = listEl.querySelector(".run-list-empty");
  if (placeholder) placeholder.remove();

  // V-32/R6：始终按工作目录分组。此前只有一个目录时自动摊平，但这会让
  // 同一套侧栏在「一个项目」与「两个项目」之间突然变结构，也把最重要的
  // 工具圈禁边界藏掉。项目 → 对话现在是稳定的信息架构，不随数量漂移。
  const groups = groupRunsByWorkdir(runs, groupState?.projects);

  // 分组时用 listbox > group > option（ARIA 1.2 允许的结构）。
  patchList(listEl, groups, {
    key: (g) => g.key,
    create: (g) => {
      const box = document.createElement("div");
      box.className = "run-group";
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", g.label);
      box.innerHTML =
        '<div class="run-group-label">' +
        '<span class="run-group-identity"><i class="ph ph-caret-down run-group-caret" aria-hidden="true"></i><i class="ph ph-folder-simple" aria-hidden="true"></i><span class="run-group-name"></span></span>' +
        '<span class="run-group-actions">' +
        '<button type="button" class="run-group-artifacts" hidden aria-label="查看产物">' +
        '<i class="ph ph-folder-open" aria-hidden="true"></i></button>' +
        '<span class="run-group-count"></span>' +
        "</span></div><div class=\"run-group-items\"></div>";
      const toggle = box.querySelector(".run-group-label");
      toggle?.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".run-group-artifacts")) return;
        event.preventDefault();
        event.stopPropagation();
        groupState?.onToggle?.(g.key);
      });
      const artifactsBtn = box.querySelector(".run-group-artifacts");
      artifactsBtn?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = box.getAttribute("data-project-id");
        if (id) groupState?.onOpenArtifacts?.(id);
      });
      patchRunGroupHeader(box, g, groupState);
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect, onDelete);
      return box;
    },
    update: (box, g) => {
      patchRunGroupHeader(box, g, groupState);
      patchRunItems(box.querySelector(".run-group-items"), g.runs, metaMap, selectedRunId, onSelect, onDelete);
    },
  });
}

function patchRunGroupHeader(box, group, groupState) {
  const collapsed = groupState?.collapsed;
  const label = box.querySelector(".run-group-label");
  const isCollapsed = Boolean(collapsed?.has(group.key));
  setText(box.querySelector(".run-group-name"), group.label);
  setText(box.querySelector(".run-group-count"), String(group.runs.length));
  setAttr(label, "title", group.key === "(default)" ? "默认工作目录" : group.key);
  setClass(box, "run-group--collapsed", isCollapsed);
  const caret = box.querySelector(".run-group-caret");
  if (caret) caret.className = `ph ${isCollapsed ? "ph-caret-right" : "ph-caret-down"} run-group-caret`;
  const projectId = String(group.key ?? "").startsWith("project:") ? String(group.key).slice("project:".length) : "";
  setAttr(box, "data-project-id", projectId || null);
  const artifactsBtn = box.querySelector(".run-group-artifacts");
  if (artifactsBtn) {
    artifactsBtn.hidden = !projectId || typeof groupState?.onOpenArtifacts !== "function";
  }
}

/**
 * 按工作目录分组。workdir 是工具的写入圈禁边界——"这段工作触碰的范围"，
 * 所以它是这个 harness 自己长出来的分组键，而不是从别家侧栏照搬的层级。
 * 分组前后保持原有顺序（服务端已按 createdAt 降序）。
 * @returns {{key:string,label:string,runs:any[]}[]}
 */
/**
 * 一条对话谱系在侧栏只露当前这一头。父归档被续跑接走之后再占一行，
 * 看起来像「又新开了对话」。
 */
/**
 * 进行中看板 → composer 门禁 chip。status 为 null 时藏起来，不占位。
 * @param {{ nextGate?: string, waiting?: string[], summary?: string }|null|undefined} status
 * @returns {{ hidden: boolean, label: string }}
 */
export function formatGateChip(status) {
  if (!status || typeof status !== "object") return { hidden: true, label: "" };
  const gate = String(status.nextGate ?? "").trim();
  const waiting = Array.isArray(status.waiting)
    ? status.waiting.map((w) => String(w ?? "").trim()).filter(Boolean)
    : [];
  if (!gate && waiting.length === 0) return { hidden: true, label: "" };
  const parts = [];
  if (gate) parts.push(`下一门：${gate}`);
  if (waiting.length) parts.push(`${waiting.length} 人在等`);
  return { hidden: false, label: parts.join(" · ") };
}

/** 把门禁 chip 画到已有按钮上。hidden 时清空文案，避免占位。 */
export function paintGateChip(el, status) {
  if (!el) return formatGateChip(status);
  const face = formatGateChip(status);
  el.hidden = face.hidden;
  el.textContent = face.hidden ? "" : face.label;
  return face;
}

/**
 * 引用芯片文案：有目录标签就带上，避免同名产物混在一起。
 * @param {{ title?: string, task?: string, runId?: string, workdirLabel?: string }} ref
 */
export function formatCiteChip(ref) {
  const name = String(ref?.title || ref?.task || ref?.runId || "").trim() || String(ref?.runId ?? "");
  const label = String(ref?.workdirLabel ?? "").trim();
  return label ? `${name} · ${label}` : name;
}

/**
 * run_config.cited → 对话里的引用卡。没有引用返回 null。
 * @param {unknown} cited
 * @returns {{ kind: "cite", refs: { runId: string, title: string, artifacts: string[], workdirLabel?: string }[] }|null}
 */
export function deriveCitedChat(cited) {
  if (!Array.isArray(cited) || cited.length === 0) return null;
  const refs = cited.map((c) => ({
    runId: String(c?.runId ?? ""),
    title: String(c?.title ?? ""),
    artifacts: Array.isArray(c?.artifacts) ? c.artifacts.map(String).filter(Boolean) : [],
    ...(c?.workdirLabel ? { workdirLabel: String(c.workdirLabel) } : {}),
  })).filter((c) => c.runId);
  if (!refs.length) return null;
  return { kind: "cite", refs };
}

/**
 * 输入框末尾的 `@` 才开文件补全。`#` `/` `$` 不吃。引用会话走按钮，不占 `@`。
 * @returns {{ start: number, query: string, kind: "file" } | null}
 */
export function composerCiteTrigger(text) {
  const raw = String(text ?? "");
  const m = raw.match(/(^|[\s])@([^\s@]*)$/);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: raw.length - query.length - 1, query, kind: "file" };
}

export function buildWorkspaceFilesUrl(workdir, query) {
  const q = new URLSearchParams();
  if (workdir) q.set("workdir", workdir);
  if (query) q.set("q", query);
  return `/api/workspace/files?${q}`;
}

/**
 * `@` 后缀 / 过滤框：在已返回的结果上再按文件名筛一层。
 * 服务端带 q= 时已按文件名深搜；这里是本地即时反馈，不是整棵 IDE 树。
 */
export function filterWorkspaceFileEntries(files, query) {
  const list = Array.isArray(files) ? files : [];
  const raw = String(query ?? "").trim().replace(/\\/g, "/");
  if (!raw) return list;
  const prefix = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const needle = prefix.toLowerCase();
  if (!needle) return list;
  return list.filter((f) => {
    const name = String(f?.name ?? "").toLowerCase();
    const rel = String(f?.relative ?? "").replace(/\\/g, "/").toLowerCase();
    return name.includes(needle) || rel.includes(needle);
  });
}

/**
 * 同 workdir 可见会话，给 composer @ 点名用。
 * 不猜邻居：workdir 对不上的一律不进。
 */
export function sameWorkdirCiteRuns(runs, workdir) {
  return visibleConversationRuns(filterRunsByComposerWorkdir(runs, workdir, false));
}

/** 领域包下拉：consult 写清「查资料」，不把包从名单里搬走。 */
export function packOptionLabel(pack) {
  const name = String(pack?.name ?? "").trim();
  if (!name) return "";
  if (name === "consult" || pack?.groundedConsult === true) return `${name} · 查资料`;
  return name;
}

/**
 * 对话里的出处表：从答文链接和 fetch_url / web_search 收来。
 * 模型已经写成「来源 / 该页说的 / 链接」时也再抄一份，方便看见和导出。
 */
export function deriveChatSources(state) {
  const rows = [];
  const seen = new Set();
  const add = (url, title, quote) => {
    const href = String(url ?? "").replace(/[),.]+$/, "").trim();
    if (!/^https?:\/\//i.test(href) || seen.has(href)) return;
    seen.add(href);
    rows.push({
      url: href,
      title: String(title ?? "").trim(),
      quote: String(quote ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  };
  const fromText = (text) => {
    const s = String(text ?? "");
    const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = md.exec(s))) add(m[2], m[1], "");
    const bare = /https?:\/\/[^\s)\]>'"]+/gi;
    while ((m = bare.exec(s))) add(m[0], "", "");
  };
  for (const e of state?.timeline ?? []) {
    if (e.type === "assistant_text") fromText(e.text);
    if (e.type === "tool_call" && (e.name === "fetch_url" || e.name === "web_search")) {
      const input = e.input && typeof e.input === "object" ? e.input : {};
      add(input.url || input.href, input.query || input.title || "", "");
    }
    if (e.type === "tool_result" && !e.resultIsError) {
      const raw = e.result;
      fromText(typeof raw === "string"
        ? raw
        : (raw && typeof raw === "object" ? String(raw.content ?? raw.text ?? raw.result ?? "") : ""));
    }
  }
  return rows;
}

export function formatSourceExport(rows) {
  const lines = ["来源\t该页说的\t链接"];
  for (const r of rows ?? []) {
    lines.push([r.title || "", r.quote || "", r.url || ""].join("\t"));
  }
  return lines.join("\n");
}

/** 计划门上改过的短句。只收有改动的子任务。 */
export function collectPlanGateEdits(root, nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const edits = [];
  if (!root) return edits;
  for (const n of list) {
    const id = String(n?.id ?? "");
    if (!id) continue;
    const titleEl = root.querySelector(`[data-plan-edit="title"][data-plan-id="${id}"]`);
    const descEl = root.querySelector(`[data-plan-edit="description"][data-plan-id="${id}"]`);
    const title = titleEl ? String(titleEl.value ?? "").trim() : String(n.title ?? "");
    const description = descEl ? String(descEl.value ?? "").trim() : String(n.description ?? "");
    const origTitle = String(n.title ?? "");
    const origDesc = String(n.description ?? "");
    if (title !== origTitle || description !== origDesc) {
      edits.push({ id, title, description });
    }
  }
  return edits;
}

export function filterCiteCandidates(candidates, query) {
  const q = String(query ?? "").trim().toLowerCase();
  const list = Array.isArray(candidates) ? candidates : [];
  if (!q) return list;
  return list.filter((c) => {
    const title = String(c?.title ?? "").toLowerCase();
    const task = String(c?.task ?? "").toLowerCase();
    return title.includes(q) || task.includes(q);
  });
}

export function visibleConversationRuns(runs) {
  const superseded = new Set();
  for (const r of runs) {
    if (r.continuedFrom) superseded.add(r.continuedFrom);
  }
  return runs.filter((r) => !superseded.has(r.runId));
}

/** 沿 continuedFrom 走到谱系最新的那一头 */
export function conversationTipId(runs, runId) {
  if (!runId) return runId;
  let tip = runId;
  for (let i = 0; i < runs.length; i++) {
    const child = runs.find((r) => r.continuedFrom === tip);
    if (!child) break;
    tip = child.runId;
  }
  return tip;
}

export function groupRunsByWorkdir(runs, projects = []) {
  const byKey = new Map();
  const labels = new Map();
  for (const r of visibleConversationRuns(runs)) {
    const project = findProjectForRun(r, projects);
    const dir = r.workdir ?? "";
    const key = project ? `project:${project.id}` : (dir || "(default)");
    const label = project
      ? project.name
      : dir
        ? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
        : "（默认工作目录）";
    if (!byKey.has(key)) {
      byKey.set(key, []);
      labels.set(key, label);
    }
    byKey.get(key).push(r);
  }
  return [...byKey.entries()].map(([key, list]) => ({
    key,
    // 标签只取末段：完整绝对路径在窄侧栏里会挤掉一切，完整值在 Tools 面有
    // 两种分隔符都要切：这个宿主主要跑在 Windows 上（反斜杠），但路径也可能
    // 是 posix 风格。只切 `/` 的话 Windows 路径切不开，组名会变成整条绝对路径
    label: labels.get(key),
    runs: list,
  }));
}

function patchRunItems(host, runs, metaMap, selectedRunId, onSelect, onDelete) {
  patchList(host, runs, {
    key: (r) => r.runId,
    create: (r) => {
      const el = document.createElement("div");
      el.className = "run-item";
      el.setAttribute("role", "option");
      el.setAttribute("tabindex", "0");
      el.setAttribute("data-run-id", r.runId);
      el.innerHTML =
        '<div class="run-item-status">' +
        // 未读星：跑完了但还没看过。放在状态行最前，扫一眼列表就知道哪条有新结果
        '<span class="run-item-unread" hidden aria-label="已完成，尚未查看"><i class="ph ph-sparkle" aria-hidden="true"></i></span>' +
        '<span class="verify-badge" hidden>核查</span>' +
        '<span class="host-badge" hidden>CLI</span>' +
        '<span class="run-item-state-label"></span>' +
        "</div>" +
        '<div class="run-item-task"></div>' +
        '<div class="run-item-recap" hidden></div>' +
        '<div class="run-item-meta">' +
        '<span class="run-item-turns"></span>' +
        '<span class="run-item-time"></span>' +
        '<span class="run-item-duration"></span>' +
        "</div>" +
        '<button type="button" class="run-item-delete" hidden aria-label="删除对话" title="删除对话">' +
        '<i class="ph ph-trash" aria-hidden="true"></i></button>';
      el.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest(".run-item-delete")) return;
        onSelect(r.runId);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(r.runId);
        }
      });
      const del = el.querySelector(".run-item-delete");
      if (del) {
        del.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete?.(r.runId);
        });
      }
      updateRunItem(el, r, metaMap, selectedRunId, onDelete);
      return el;
    },
    update: (el, r) => updateRunItem(el, r, metaMap, selectedRunId, onDelete),
  });
}

/** 就地更新一个运行项的可变部分（不碰节点本身） */
function updateRunItem(el, r, metaMap, selectedRunId, onDelete) {
  const meta = metaMap ? metaMap.get(r.runId) : null;
  const isSelected = r.runId === selectedRunId;

  setClass(el, "run-item--selected", isSelected);
  setAttr(el, "aria-selected", String(isSelected));

  // 未读星只在"没被选中 且 标记未读"时亮——选中即视为看过
  const unreadEl = el.querySelector(".run-item-unread");
  setAttr(unreadEl, "hidden", meta && meta.unread && !isSelected ? null : "");
  setClass(el, "run-item--unread", Boolean(meta && meta.unread && !isSelected));

  const verifyBadge = el.querySelector(".verify-badge");
  setAttr(verifyBadge, "hidden", r.verify ? null : "");

  const hostBadge = el.querySelector(".host-badge");
  setAttr(hostBadge, "hidden", r.host === "cli" ? null : "");

  const verdictEl = el.querySelector(".run-item-verdict");
  if (verdictEl) setAttr(verdictEl, "hidden", "");

  const del = el.querySelector(".run-item-delete");
  setAttr(del, "hidden", r.status === "running" || !onDelete ? "" : null);

  const stateLabel = el.querySelector(".run-item-state-label");
  setText(stateLabel, r.status === "running" ? "运行中" : "已完成");
  setClass(stateLabel, "thinking-shimmer", r.status === "running");
  setClass(el, "run-item--running", r.status === "running");
  // 标题是算出来的短句；完整任务原文挂 title，鼠标停一下就能看全
  setText(el.querySelector(".run-item-task"), resolveDisplayedTitle(r.title, r.task));
  setAttr(el.querySelector(".run-item-task"), "title", r.task);
  const recap = String(meta?.recap || r.recap || "").trim();
  const recapEl = el.querySelector(".run-item-recap");
  if (recapEl) {
    setAttr(recapEl, "hidden", recap ? null : "");
    setText(recapEl, recap);
    setAttr(recapEl, "title", recap || null);
  }
  setText(el.querySelector(".run-item-turns"), `${Math.max(1, Number(r.conversationTurn ?? 1))} 轮`);
  setText(el.querySelector(".run-item-time"), meta ? formatTimeShort(meta.startTime) : "");
  setText(
    el.querySelector(".run-item-duration"),
    meta && meta.duration != null ? formatDuration(meta.duration) : "",
  );
}

/**
 * 渲染单个 run 的详情视图（R-03 四层标签结构）。
 * @param {RunState} state
 * @param {{
 *   onAllow?:(toolUseId:string)=>void,
 *   onDenyReason?:(toolUseId:string,reason:string)=>void,
 *   showBack?:boolean,
 *   onBack?:()=>void,
 *   activeTab?:string,
 *   logEntries?:LogEntry[],
 *   onToggleEntry?:(seq:number)=>void,
 *   onReveal?:(path:string)=>void,
 *   onOpenCanvas?:(path:string)=>void,
 *   onPreviewPath?:(path:string)=>void,
 *   onOpenBrowser?:(url:string)=>void,
 *   inspectPaths?:(paths:string[])=>Promise<any[]>
 * }} callbacks
 */
export function renderRunDetail(state, callbacks) {
  const mainEl = document.getElementById("main-area");
  if (!mainEl) return;

  const activeTab = normalizeTab(callbacks.activeTab);
  const logEntries = callbacks.logEntries || deriveLogEntries(state);
  const overview = deriveOverview(state);
  const harness = callbacks.harness ?? null;

  const isRunning = state.status === "running";

  // V-17：四决定因素派生一次，各分区共用
  const faces = {
    loop: deriveLoopFace(state, harness),
    context: deriveContextFace(state, harness),
    tools: deriveToolsFace(state, harness),
    verification: deriveVerificationFace(state, harness),
    action: deriveActionState(state),
    plan: derivePlanFace(state),
  };
  faces.progress = deriveProgressFace(state, faces.plan, {
    hasSessionFiles: deriveSessionFiles(state).length > 0,
  });

  // V-10：骨架建一次，之后逐区补丁。此前每条 SSE 事件重建整页 innerHTML——
  // 实测拒绝理由输入框的字被清空、日志滚动归零、长运行退化成 O(n²)。
  const parts = ensureDetailSkeleton(mainEl, state, callbacks);

  patchDetailHeader(parts, state, isRunning, faces);
  patchAssemblyBar(parts, state, callbacks.harness);
  /**
   * 「需你决定」现在钉在滚动容器【之外】（#action-dock），它变高变矮只会改变
   * 滚动容器的高度，不会平移容器里的内容——所以**不再需要任何滚动补偿**。
   * 此前为它写过一个视口锚定补偿函数，那是在给布局问题打补丁：补偿方向还得
   * 分"变高别动、变矮才补"两种情形，判反一次就把刚冒出来的待办推出视野。
   * 布局改对之后这段逻辑连同它的测试一起删掉了——**根因修掉，补丁就是负债**。
   */
  patchUserQuestion(parts, faces, callbacks);
  patchPlanGate(parts, state, faces, callbacks);
  patchHandoffRail(parts, state, faces, callbacks);
  patchApprovalRail(parts, state, isRunning, callbacks);
  patchUnverifiedRail(parts, faces, callbacks);
  patchLiveStrip(parts, state, isRunning, callbacks.liveText ?? "", callbacks.liveThinking ?? "", harness);
  patchCampaignStrip(parts, state, callbacks);
  patchConversation(
    parts,
    state,
    { text: callbacks.liveText, thinking: callbacks.liveThinking },
    callbacks,
  );
  patchAgentOverlay(parts, state, callbacks, {
    text: callbacks.liveText,
    thinking: callbacks.liveThinking,
  });
  patchChildApprovalHint(parts, state, callbacks);
  patchDetailRail(parts, state, faces, callbacks);
  patchOutcomeCard(parts, state, overview, faces, callbacks);
  patchFactorGrid(parts, faces, activeTab, callbacks);
  patchTabContent(parts, state, activeTab, overview, logEntries, callbacks, faces);
  patchUsageFooter(parts, state);
}

/** L3 下钻标签集合。overview 是历史别名——旧链接落到 Loop 面 */
const DETAIL_TABS = ["loop", "context", "tools", "verify"];

export function normalizeTab(tab) {
  if (tab === "log" || tab === "overview" || !tab) return "loop";
  return DETAIL_TABS.includes(tab) ? tab : "loop";
}

/**
 * 建立（或复用）详情页骨架，返回各分区容器的引用。
 *
 * 重建条件只有三个：换了 run、窄屏返回栏的有无变了、容器被外部整体替换过
 * （renderEmptyState 会这么干，测试里的 beforeEach 也会）。
 * 其余情况一律复用——这正是输入值与焦点得以存活的根据。
 */
/**
 * 「需你决定」的固定坞：钉在输入框正上方、**在滚动容器之外**。
 *
 * 为什么搬出来（委托方建议 + 实测）：它原本在滚动区顶部，于是
 *   ① 内容一长它就被推走，得靠滚动补偿去追——补偿方向还容易搞反；
 *   ② 用户往下看日志时，新冒出来的待办完全在视野之外。
 * 钉住之后这两件事一起消失，且不再需要任何滚动补偿。
 *
 * 骨架只建一次（内容切换靠补丁），所以这里判空即返回既有节点。
 */
function ensureActionDock() {
  const dock = document.getElementById("action-dock");
  if (!dock) return { actionRail: null, userQuestion: null, planGate: null, handoff: null, approvals: null, approvalsDone: null, childApprovalHint: null, unverified: null };
  if (!dock.querySelector(".action-rail")) {
    dock.innerHTML =
      '<div class="action-rail" hidden>' +
      // 提问排在最前：它是**阻塞式**的，执行协程此刻正吊在 ask_user 里等答复
      '<div class="user-question" hidden></div>' +
      // 签字位排在审批卡之前：它挂起时一个子任务都还没发射，此刻决定成本最低
      '<div class="plan-gate" hidden></div>' +
      // 下一步提议：不挡对话，输入框照常用
      '<div class="handoff-rail" hidden></div>' +
      '<div class="approval-cards" hidden></div>' +
      // 已处理的折叠成一行，不与待处理的混排
      '<div class="approval-cards-done" hidden></div>' +
      '<button type="button" class="child-approval-hint" hidden></button>' +
      '<div class="unverified-rail" hidden></div>' +
      "</div>";
  } else if (!dock.querySelector(".child-approval-hint")) {
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "child-approval-hint";
    hint.hidden = true;
    const after = dock.querySelector(".approval-cards-done");
    if (after) after.after(hint);
    else dock.querySelector(".action-rail")?.appendChild(hint);
  }
  if (!dock.querySelector(".handoff-rail")) {
    const gate = dock.querySelector(".plan-gate");
    const el = document.createElement("div");
    el.className = "handoff-rail";
    el.hidden = true;
    if (gate) gate.after(el);
    else dock.querySelector(".action-rail")?.appendChild(el);
  }
  return {
    dock,
    actionRail: dock.querySelector(".action-rail"),
    userQuestion: dock.querySelector(".user-question"),
    planGate: dock.querySelector(".plan-gate"),
    handoff: dock.querySelector(".handoff-rail"),
    approvals: dock.querySelector(".approval-cards"),
    approvalsDone: dock.querySelector(".approval-cards-done"),
    childApprovalHint: dock.querySelector(".child-approval-hint"),
    unverified: dock.querySelector(".unverified-rail"),
  };
}

function ensureDetailSkeleton(mainEl, state, callbacks) {
  const showBack = Boolean(callbacks.showBack && callbacks.onBack);
  const intact = mainEl.__parts
    && mainEl.querySelector(".detail-layout")
    && mainEl.querySelector(".chat-title")
    && mainEl.querySelector("#agent-overlay")
    && !mainEl.querySelector(".detail-header")
    && !mainEl.querySelector(".chat-process-bar");
  if (intact && mainEl.__runId === state.runId && mainEl.__showBack === showBack) {
    // 圆环在提交栏，骨架复用时也要刷新引用（测试/热切换骨架可能重写过 form）
    const ring = document.getElementById("ctx-ring");
    mainEl.__parts.ctxRing = ring;
    mainEl.__parts.ctxRingArc = ring?.querySelector(".ctx-ring-arc") ?? null;
    mainEl.__parts.ctxUsagePanel = document.getElementById("ctx-usage-panel");
    if (!mainEl.querySelector(".campaign-strip")) {
      const stack = mainEl.querySelector(".conversation-stack");
      const conv = mainEl.querySelector(".conversation");
      if (stack && conv) {
        const strip = document.createElement("div");
        strip.className = "campaign-strip";
        strip.hidden = true;
        stack.insertBefore(strip, conv);
      }
    }
    mainEl.__parts.campaignStrip = mainEl.querySelector(".campaign-strip");
    return mainEl.__parts;
  }

  // 对话是主干。顶栏：眉标（FATHOM · RUN）+ 标题；返回列表藏在标题点击里（窄屏）。
  // 上下文圆环钉在 #submit-form 右下角（index.html），不占对话顶栏。
  const chatHead =
    '<span class="chat-head">' +
    `<span class="dh-kicker">${PLUMB_KICKER_SVG}<span class="dh-kicker-text"></span></span>` +
    '<span class="chat-title" id="chat-title"></span>' +
    "</span>";
  mainEl.innerHTML =
    '<div class="back-bar">' +
    (showBack
      ? '<button type="button" class="btn back-btn" id="back-to-list-btn" aria-label="返回对话列表"><span class="back-chevron" aria-hidden="true">←</span> ' +
        chatHead +
        "</button>"
      : chatHead) +
    "</div>" +
    '<h2 class="sr-only">本次对话</h2>' +
    // 兼容旧选择器：隐藏的文字水位仍挂着，归档/测试可读
    '<button type="button" class="ctx-gauge" hidden aria-live="polite">' +
    '<span class="ctx-gauge-value"></span>' +
    '<span class="ctx-gauge-compactions" hidden></span>' +
    "</button>" +
    '<div class="live-strip" hidden aria-live="polite"></div>' +
    /**
     * **对话是主干**（委托方："还是希望做成对话框的形式，对于用惯了其它 agent
     * 的人来说过于难用"）。
     *
     * 此前首屏是仪表盘（四因子卡 + 下钻面），对话只是 Loop 面里的一个子视图，
     * 而且只有段结束落盘后才有内容——等于把最像"用 agent"的那件事藏在两层之下。
     * 现在反过来：对话铺在主干，工具调用 / 思考 / 审批痕迹 / 裁决**按发生时刻
     * 就地织进这条流**；仪表盘退成默认收起的抽屉。
     *
     * 这不是把特色藏起来——恰恰相反：别家把 agent 的内部收进一个转圈图标，
     * 我们把它按时间顺序织进对话里。低切换成本与"明显不同"在这个形态下不冲突。
     */
    /**
     * 对话与**右栏**并排。右栏常驻 Progress（执行者拆步清单 + 可选编排子任务），
     * 产物文件也落这里。无步骤时显示「等待拆步…」而不是整栏消失。
     */
    '<div class="detail-layout">' +
    '<div class="conversation-stack">' +
    '<div class="campaign-strip" hidden></div>' +
    '<div class="conversation" id="conversation"></div>' +
    '<div class="agent-overlay" id="agent-overlay" hidden></div>' +
    "</div>" +
    '<aside class="detail-rail" id="detail-rail" aria-label="会话侧栏">' +
    '<button type="button" class="rail-toggle" id="rail-toggle" aria-expanded="true" aria-controls="rail-body">Progress ⟩</button>' +
    '<div class="rail-body" id="rail-body">' +
    '<div class="progress-panel"></div>' +
    '<div class="artifacts" hidden></div>' +
    '<div class="plan-board" hidden></div>' +
    "</div>" +
    "</aside>" +
    "</div>" +
    // 结果卡排在对话之后：它是这次运行的收尾，不是开场白
    '<div class="outcome-card"></div>' +
    '<div class="usage-footer" hidden></div>' +
    // 仪表盘抽屉：四因子卡仍是标签栏，只是不再占首屏。委托方："Loop 不用显示，留档即可"
    '<details class="detail-drawer" id="detail-drawer" hidden>' +
    '<summary class="drawer-summary">运行详情：Loop / 上下文 / 工具 / 核查</summary>' +
    '<div class="factor-grid" role="tablist" aria-label="四决定因素"></div>' +
    '<div class="tab-content" id="tab-content" role="tabpanel" tabindex="0"></div>' +
    "</details>";

  if (showBack) {
    mainEl.querySelector("#back-to-list-btn").addEventListener("click", callbacks.onBack);
  }
  bindThinkingPref(mainEl.querySelector(".conversation"));
  const railToggle = mainEl.querySelector("#rail-toggle");
  if (railToggle) {
    railToggle.addEventListener("click", () => {
      const rail = mainEl.querySelector(".detail-rail");
      const open = !rail.classList.contains("detail-rail--collapsed");
      rail.classList.toggle("detail-rail--collapsed", open);
      railToggle.setAttribute("aria-expanded", String(!open));
      railToggle.textContent = open ? "⟨ Progress" : "Progress ⟩";
    });
  }

  const ctxRing = document.getElementById("ctx-ring");
  const parts = {
    root: mainEl,
    task: null,
    statusBadge: null,
    verifyBadge: null,
    ctxGauge: mainEl.querySelector(".ctx-gauge"),
    // 圆环在提交栏（跨详情页复用），不随 main 骨架重建
    ctxRing,
    ctxRingArc: ctxRing?.querySelector(".ctx-ring-arc") ?? null,
    ctxUsagePanel: document.getElementById("ctx-usage-panel"),
    hint: null,
    assembly: null,
    assemblyWhy: null,
    // 「需你决定」在滚动容器之外（#action-dock，钉在输入框上方）——
    // 它不随内容滚走，新审批出现在哪都看得见（委托方建议的结构解法）
    ...ensureActionDock(),
    liveStrip: mainEl.querySelector(".live-strip"),
    campaignStrip: mainEl.querySelector(".campaign-strip"),
    conversation: mainEl.querySelector(".conversation"),
    agentOverlay: mainEl.querySelector("#agent-overlay"),
    rail: mainEl.querySelector(".detail-rail"),
    railBoard: mainEl.querySelector(".detail-rail .plan-board"),
    progressPanel: mainEl.querySelector(".detail-rail .progress-panel"),
    artifacts: mainEl.querySelector(".detail-rail .artifacts"),
    drawer: mainEl.querySelector(".detail-drawer"),
    outcome: mainEl.querySelector(".outcome-card"),
    factorGrid: mainEl.querySelector(".factor-grid"),
    tabContent: mainEl.querySelector(".tab-content"),
    usage: mainEl.querySelector(".usage-footer"),
    sig: {},
  };
  mainEl.__parts = parts;
  mainEl.__runId = state.runId;
  mainEl.__showBack = showBack;
  return parts;
}

function patchDetailHeader(parts, state, isRunning, faces) {
  const title = deriveRunTitle(state.task, 40);
  const titleEl = parts.root.querySelector(".chat-title");
  if (titleEl) setText(titleEl, title);
  const kickerEl = parts.root.querySelector(".dh-kicker-text");
  if (kickerEl) setText(kickerEl, formatRunKicker(state.runId));
  const backBtn = parts.root.querySelector("#back-to-list-btn");
  if (backBtn) setAttr(backBtn, "aria-label", `返回列表：${title}`);
  patchContextGauge(parts, faces.context);
}

/**
 * 渲染装配条。每一项是一个按钮，点开在下方展开那句"为什么这样设计"。
 *
 * 用按钮而不是 `title` 提示：`title` 触屏上根本出不来、键盘也够不着，
 * 而这条恰恰是给"第一次用、想知道这跟别家有什么不同"的人看的。
 */
function patchAssemblyBar(parts, state, harness) {
  const host = parts.assembly;
  if (!host) return;
  const items = deriveAssemblyBar(state, harness);
  setAttr(host, "hidden", items.length > 0 ? null : "");
  const sig = signature(items.map((i) => `${i.key}:${i.chip}`));
  if (parts.sig.assembly !== sig) {
    parts.sig.assembly = sig;
    host.innerHTML = items
      .map(
        (i) =>
          `<button type="button" class="assembly-chip" data-why="${esc(i.key)}" aria-expanded="false" title="${esc(i.chip)}">${esc(i.chip)}</button>`,
      )
      .join('<span class="assembly-sep">·</span>');
  }

  if (host.__whyBound) return;
  host.__whyBound = true;
  host.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("[data-why]") : null;
    if (!btn) return;
    const key = btn.getAttribute("data-why");
    const cur = deriveAssemblyBar(state, harness).find((i) => i.key === key);
    const box = parts.assemblyWhy;
    const already = btn.getAttribute("aria-expanded") === "true";
    for (const b of host.querySelectorAll("[data-why]")) b.setAttribute("aria-expanded", "false");
    if (already || !cur) {
      setAttr(box, "hidden", "");
      return;
    }
    btn.setAttribute("aria-expanded", "true");
    setAttr(box, "hidden", null);
    box.innerHTML = `<strong>${esc(cur.chip)}</strong> ${renderMarkdownInline(cur.why)}`;
  });
}

/**
 * 流式显示的**匀速放行**。
 *
 * 委托方："有时候会卡住然后突然冒一长串，就是有点像卡顿的样子。"
 * 量了一轮，**不是我们渲染慢**（长任务观测器录到 0 条长任务），
 * 是**上游本来就是一阵一阵来的**：一次 230 条增量里，多数在同一毫秒内到达，
 * 而相邻两批之间最长静默 943ms。兼容端点按块推流，不是逐字推。
 *
 * 所以修不在"更快地画"，而在**别把到达节奏当成显示节奏**：
 * 把已到达但还没显示的部分当成一个缓冲，按帧匀速放出去。
 * 一次 300 字的突进因此摊成约 350ms 的平滑推进，而不是一帧糊上去。
 *
 * 三条边界：
 *   ① **积压越多放得越快**——否则长文会越拖越远，最后停笔了字还在慢慢爬；
 *   ② 有个下限速度，免得零星几个字挤牙膏；
 *   ③ 一轮结束（`done`）时**立刻全放**——收尾必须是准的，
 *      不能让人对着一段还没吐完的文字以为模型还在写。
 *
 * @param {{arrived:number, revealed:number, dtMs:number, done?:boolean}} m
 * @returns {number} 这一帧该显示到第几个字
 */
export function paceReveal(m) {
  const arrived = Math.max(0, m.arrived | 0);
  // 上游文本变短 = 换了一轮（liveText 被清过），显示位置跟着回落
  let revealed = Math.min(Math.max(0, m.revealed | 0), arrived);
  if (m.done) return arrived;
  const backlog = arrived - revealed;
  if (backlog <= 0) return revealed;
  /**
   * **剩不多了就一次放完。**
   *
   * 速度取自积压量，所以这是指数衰减——越接近追平走得越慢，尾巴能拖很久。
   * 初版没有这个收尾闸，一次 300 字的突进 350ms 只走到 200 字，
   * 剩下那截慢慢爬，正是我要修的"字还在爬"本身。**是被自己写的那条测试
   * 当场抓出来的**（断言 350ms 追平，实测 200/300）。
   */
  if (backlog <= REVEAL_SNAP) return arrived;
  const cps = Math.max(REVEAL_MIN_CPS, backlog / REVEAL_DRAIN_SEC);
  const step = Math.ceil((cps * Math.max(0, m.dtMs)) / 1000);
  return Math.min(arrived, revealed + Math.max(1, step));
}

/**
 * 匀速放行的**窗口换算**：全局"该显示到第几个字"→ 当前缓冲里该切几个字。
 *
 * 历史（2026-08-15）：思考流到约 2000 字冻住——`revealed` 绝对计数去 slice
 * 当时的 LIVE_TEXT_CAP 滑动窗口，撞上限后 arrived/revealed 双双钉死。
 * 修法一：另记单调累计字数 + 本函数换算窗口偏移。
 * 修法二（2026-09-04）：**取消截尾**——直播缓冲即全文，日常 `bufferLength === total`，
 * 本函数退化为普通放行上限；公式仍保留，防以后再加回上限时冻屏。
 *
 * 提成纯函数放在 app.js，是因为原来那段逻辑住在 index.html——**没有任何测试
 * 够得着它**（本仓库那条"核心可测、壳不可测的分界线就是缺陷分布线"的活标本）。
 * 挪进来是结构性修复，不是补丁。
 *
 * @param {{revealed:number, precedingTotal:number, total:number, bufferLength:number}} m
 *   revealed       全局已放行字数（paceReveal 的产物）
 *   precedingTotal 排在本段之前的那些段的累计字数（思考在前、正文在后）
 *   total          本段**累计**到达字数（单调）
 *   bufferLength   本段当前缓冲长度
 * @returns {number} 该从缓冲头部切多少个字
 */
export function revealedWindow(m) {
  const bufferLength = Math.max(0, m.bufferLength | 0);
  const total = Math.max(0, m.total | 0);
  // 已经被挤出缓冲的字数：它们早就该显示了，不该再占放行额度
  const dropped = Math.max(0, total - bufferLength);
  const budget = (m.revealed | 0) - Math.max(0, m.precedingTotal | 0) - dropped;
  return Math.max(0, Math.min(bufferLength, budget));
}

/** 积压排空的时间常数。指数衰减，配合下面的收尾闸才能真的追平 */
const REVEAL_DRAIN_SEC = 0.12;
/** 速度下限：零星几个字别挤牙膏 */
const REVEAL_MIN_CPS = 40;
/** 收尾闸：剩这么多字就一次放完，不留一条慢慢爬的尾巴 */
const REVEAL_SNAP = 12;

/**
 * 直播增量缓冲的折叠（纯函数——index.html 里那层壳测试够不着，
 * 这类"少清一次就鬼畜"的逻辑必须住在测试够得着的地方）。
 *
 * 每条 delta 按到达顺序折叠进 acc：
 *   - thinking：追加进思考缓冲，累计 think 字数；
 *   - text：追加进正文缓冲，同时**思考让位**（正文一开始流，思考就是想完了——
 *     缓冲清空、累计归零，否则正文的放行额度会被早已不显示的思考永久占住）；
 *   - reset：同一轮即将重流（断流重试 api_retry / 换端点 model_fallback，
 *     服务端在 durable 事件落流之前于 delta 通道广播的瞬态帧）。失败那次尝试
 *     流出的半截文字整体作废——没有它，重流的全文会接在半截后面，直播条
 *     看起来就是同一段文字"鬼畜地一直生成"（委托方截图实证，机制刻画见
 *     test/loop.test.ts「断流重试」一条）。
 *
 * @param {{ text:string, thinking:string, thinkTotal:number, textTotal:number }} acc
 * @param {{ kind:"text"|"thinking"|"reset", text?:string }} chunk
 * @returns {{ text:string, thinking:string, thinkTotal:number, textTotal:number, reset:boolean }}
 *   reset=true 表示这一路折叠里出现过 reset——调用方据此重置放行计数器。
 */
export function foldLiveDelta(acc, chunk) {
  if (chunk?.kind === "reset") {
    return { text: "", thinking: "", thinkTotal: 0, textTotal: 0, reset: true };
  }
  if (chunk?.kind === "thinking" && typeof chunk.text === "string" && chunk.text !== "") {
    return {
      ...acc,
      thinking: acc.thinking + chunk.text,
      thinkTotal: acc.thinkTotal + chunk.text.length,
      reset: false,
    };
  }
  if (chunk?.kind === "text" && typeof chunk.text === "string" && chunk.text !== "") {
    return {
      text: acc.text + chunk.text,
      thinking: "",
      thinkTotal: 0,
      textTotal: acc.textTotal + chunk.text.length,
      reset: false,
    };
  }
  return { ...acc, reset: false };
}

/**
 * 两个跳转箭头该不该出现。
 *
 * 委托方要的是两件不同的事：
 *   · **↓ 回到底部**——流式时人往上翻过之后，得有一步回到"正在写"的地方；
 *   · **↑ 回到四决定因素**——点开下钻抽屉、往下读进去之后，
 *     四张卡已经滚出视野，没有箭头就只能一路滚回去。
 *
 * 抽成纯函数是因为这两条判据都只是算术，而 jsdom 里量不到真实布局——
 * 放在渲染函数里就等于没法测（本轮反复吃过这个亏）。
 *
 * @param {{scrollTop:number, scrollHeight:number, clientHeight:number,
 *          anchorTop:number|null, drawerOpen:boolean}} m 已量好的几何量
 */
export function deriveScrollNav(m, threshold = 80) {
  const distanceToBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
  // 内容还没长到需要滚动时，两个箭头都是噪声
  const scrollable = m.scrollHeight - m.clientHeight > threshold;
  return {
    showBottom: scrollable && distanceToBottom > threshold,
    /**
     * ↑ 只在**抽屉开着且四张卡已经滚出视野**时出现。
     * 抽屉没开时上面就是对话，往上翻是读历史，不该被一个"回到顶部"催着走。
     */
    showTop: Boolean(m.drawerOpen) && m.anchorTop !== null && m.anchorTop < 0,
  };
}

/**
 * 装配状态条：**显示的是这次运行的真实装配，点开才是那句设计思想**。
 *
 * 委托方问的是"能不能在某处以状态栏的形式显示我们 harness 的哲学设计思想"。
 * 直接滚动展示理念的状态栏，本质是标语——而本项目一贯反对标语（findings 全篇
 * 的写法都是"判据 + 出处"，不是主张）。所以把它翻过来：
 *
 *   条上是 `opus-5 · ts-coding · 40轮/64k · 核查开 · 写入圈禁 D:\proj`，
 *   点「核查开」才弹出那句"为什么这个 harness 要有独立核查者"。
 *
 * **哲学通过它管着的那个真实数字被看见**，而不是通过一句悬空的话。
 * 一个副作用是它没法说谎：数字来自 run_config，装配变了条上就变，
 * 说明文字不会和现实脱节——而一条写死的标语会。
 *
 * 每一项的 `why` 都必须落在**具体后果**上（不这样会发生什么），
 * 且能追到 docs 里的出处。写不出后果的项，就不该占状态条的位置。
 */
export function deriveAssemblyBar(state, harness) {
  const cfg = state.runConfig ?? {};
  const g = cfg.guardrails ?? harness?.guardrails ?? null;
  const pack = cfg.pack ?? harness?.pack ?? null;
  const items = [];

  const push = (key, chip, why) => {
    if (chip) items.push({ key, chip, why });
  };

  // 执行模型：换模型是最容易被忘记的变量，而它解释掉大半的行为差异
  push(
    "model",
    harness?.model ?? null,
    "执行者用的模型。手写循环不绑定某一家：Anthropic 原生与 OpenAI wire 两条协议走同一个循环，" +
      "所以模型是**可对照的实验变量**而不是一次重写——发现 15~17 的拆分方差对照（换更强的 planner 纹丝不动，" +
      "改成结构化拆分协议才做到 5/5 零方差）就是靠这一点做出来的。这一格是记录，不是旋钮。",
  );

  // 设计模式：门面芯片必须看得见匹配结果，不能只改后端
  const designRoute = cfg.designRoute && typeof cfg.designRoute === "object" ? cfg.designRoute : null;
  if (cfg.campaignId || cfg.campaignRole === "director") {
    const role = cfg.campaignRole === "director" ? "导演" : cfg.campaignRole === "child" ? "子对话" : "战役";
    push(
      "campaign",
      `战役 · ${role}`,
      "导演是薄看板：不产制品，用 spawn_task 开子对话。子对话是可进入的独立 StoredRun。规格+幻灯不拆战役。",
    );
  }

  if (cfg.mode === "design" || designRoute) {
    const bundle = designRoute?.bundle === "spec-plus-deck";
    const extra = Array.isArray(designRoute?.extraSeeds) ? designRoute.extraSeeds.filter(Boolean) : [];
    const seedBits = [designRoute?.seed, ...extra].filter(Boolean);
    const uniqueSeeds = [...new Set(seedBits)];
    const idPart = bundle ? "规格+幻灯" : (designRoute?.id || "未指定类型");
    const seedPart = uniqueSeeds.length ? ` · ${uniqueSeeds.join(" + ")}` : "";
    push(
      "design",
      `设计模式 · ${idPart}${seedPart}`,
      (designRoute?.reason ? `${designRoute.reason}。` : "") +
        (bundle
          ? "这是命名路径「规格 + 幻灯」，不是通用多命中拆分。"
          : "设计模式是门面：后端包仍是 design（除非点了已安装文件包），制品类型来自注册表。" +
            "自动路由给不出唯一类型时不猜测，回到页签 chip。"),
    );
  }

  // 领域包：本项目最独特的装配单位
  const routed = cfg.packRoute && typeof cfg.packRoute === "object" ? cfg.packRoute : null;
  const packName = pack?.name ?? null;
  push(
    "pack",
    packName
      ? (routed ? `${packName} · 自动` : packName)
      : routed
        ? "无领域包 · 自动"
        : "无领域包",
    (routed ? `本次由自动路由选定${routed.reason ? `（${routed.reason}）` : ""}。` : "") +
      "领域包一次装配三样东西：系统提示、工具面、以及**核查者的只读白名单与预算**。" +
      "分开配的后果案例 #4 实证过——核查者没有可用的只读命令，会在 22 轮里反复重新证明已经为真的事（核查饥饿），" +
      "烧光预算却什么也没查出来。",
  );

  // D3：装配条展开真实开关——模式名不得替代它们
  const perm = cfg.permission && typeof cfg.permission === "object" ? cfg.permission : null;
  if (perm) {
    const stance = describePermissionStance(perm.mode ?? null, perm);
    const bits = [
      `审批缺省 ${perm.approvalDefault === "auto" ? "auto" : "ask"}`,
      perm.planMode ? "计划编排开" : "计划编排关",
      perm.planGate ? "确认门开" : "确认门关",
      perm.autoYes ? "autoYes 开" : "autoYes 关",
    ];
    push(
      "permission",
      stance,
      `本 run 真实开关：${bits.join(" · ")}。D3 三档只是预设（manual/plan/auto）；` +
        "`permission: deny`、圈禁与 SSRF 硬拒不受三档与 --yes 影响——见 docs/permission-modes.md。",
    );
  }

  const costWarn = deriveCostWarning(state, harness);
  if (costWarn) {
    push(
      "costWarn",
      costWarn.label,
      `${costWarn.detail} 撞上限核查也救不了。`,
    );
  }

  // 护栏：轮数与 token 是硬边界，撞上了核查救不了
  // maxTokens 未设时**不写它**：`?? 0` 会渲成「0k」，那是在说"上限为零"——
  // 一个没设过的护栏被画成最严格的护栏，正是这条状态条最该避免的那种谎话
  const tokenPart = g && g.maxTokens ? ` / ${Math.round(g.maxTokens / 1000)}k` : "";
  push(
    "guardrails",
    g && g.maxTurns ? `${g.maxTurns} 轮${tokenPart}` : null,
    "单次运行的硬边界，由**宿主**执行：轮数/预算检查发生在每次模型调用之前，触发时不再发请求、" +
      "直接以对应的 stopReason 收尾。撞上它与「做完了」是两回事——即使裁决 passed 也不代表任务做完，" +
      "所以终止原因是**一组具名值**而不是成败两值，撞边界时界面会直说「核查救不了这一类」。",
  );

  /**
   * 上下文：预算（策略）与窗口（事实）并排。这一格此前不存在——于是 150k 预算在 1M 窗口的模型上
   * 压了三个月没人看见。窗口未知就写"窗口未知"，不编一个数。
   */
  const ctxCfg = normalizeContextConfig(cfg.context) ?? normalizeContextConfig(harness?.context) ?? null;
  push(
    "context",
    ctxCfg
      ? `上下文 ${Math.round(ctxCfg.budget / 1000)}k${ctxCfg.clamped ? "↓" : ""} / ${ctxCfg.window ? `窗口 ${Math.round(ctxCfg.window / 1000)}k` : "窗口未知"}`
      : null,
    "压缩水位是**策略**（最近一轮输入超过它的 80% 就压缩），窗口是**事实**（端点在多大处拒收；来源 " +
      `${ctxCfg ? contextSourceLabel(ctxCfg.windowSource) : "未知"}）。水位默认跟可用窗口走（窗口 − maxTokens − 边际）` +
      `${ctxCfg?.clamped ? `（本次由 ${Math.round(ctxCfg.requestedBudget / 1000)}k 夹到 ${Math.round(ctxCfg.budget / 1000)}k）` : ""}。` +
      "想提前压缩再填 AGENT_CONTEXT_LIMIT 或本次覆盖。日消耗封顶是另一道闸，跟这里无关。" +
      "窗口未知才回落 150k；撞一次 400 之后端点会说出窗口，下一次运行就按它算。",
  );

  // 核查：三值裁决 + 独立上下文，这是与别家最明显的分野
  /**
   * 白名单条数上条，**且 0 要显眼**。
   *
   * 这几条决定核查者是"能亲手重跑 vitest/tsc 的验证者"还是"只能读文件猜的观察者"。
   * 案例 #4 就是空白名单：verifier 的 bash 全被拒，22 轮返工、零写入，
   * 而四道门禁的地面真值早已全绿——把"查不了"错判成"没做对"，
   * 那是 fail-closed 三种误伤里代价最高的一种。所以它不适用"空就不显示"。
   */
  // 生效白名单（无包运行 = 通用缺省）优先于包声明；来源非包时标出来——"白名单 13"若不说是通用缺省，
  // 人会以为是自己配的
  const wlEff = resolveEffectiveWhitelist(state, harness);
  const wl = wlEff.commands ?? (cfg.pack ?? harness?.pack)?.verify?.readOnlyCommands ?? [];
  const wlSrc = whitelistSourceLabel(wlEff.source);
  const wlPart = state.verify ? `·白名单 ${wl.length}${wlSrc ? `(${wlSrc})` : ""}` : "";
  push(
    "verify",
    state.verify ? `核查开${cfg.verifierBudgetTurns ? ` ${cfg.verifierBudgetTurns} 轮` : ""}${wlPart}` : "核查关",
    "开启后由**另一个上下文**独立复核，不是让执行者自己说自己对（它看得见自己的推理，天然会为结论辩护）。" +
      "裁决分三值：passed / unverified / advisory——「没验成」和「不合格」是两件事，压成一个布尔值会让前者被当成后者。" +
      "白名单是核查者的取证手段：案例 #4 里它为空，verifier 的 bash 全被拒，22 轮返工零写入，而地面真值早已全绿。",
  );

  // 工作目录：工具的写入圈禁根
  push(
    "workdir",
    cfg.workdir ? shortPath(cfg.workdir) : null,
    "工具的写入圈禁根。路径校验在**宿主**这一侧做，不靠提示词让模型自觉——" +
      "模型给出的路径是不可信输入，`..` 逃逸与工作区外的绝对路径一律在执行前被拒。",
  );

  // 仓库/分支是工作区事实，换包不消失。没检出就不占格子。
  push(
    "git",
    formatWorkspaceGitChip(cfg.workspaceGit, { withRepo: true }),
    "当前工作目录的 git 身份（分支与 GitHub owner/repo）。它跟目录走，不是领域包能力——" +
      "换 ts-coding / design / 无包都还在；stm32-debug 不叠远端 GitHub 工具，但本地分支照样看得见。",
  );

  // RUN-01 Phase 2：同 run 恢复痕迹（来自 run_resumed 事件，重放可复原）
  if (state.lineage?.kind === "same-run") {
    push(
      "durable",
      "同 run 热恢复",
      "本会话从 state.json 的 interrupted 相 + 已提交检查点在同一 runId 上续跑；" +
        "未恢复 active grant / 原 AbortController；SAFE-06 toolTx 从 state 种子化（同 key 不重复 commit）；" +
        "若正史末条悬空 tool_use，loop 按 mid-tool 计划幂等重放 / bash fail-closed。",
    );
  }

  /**
   * 识图能力。**没配就明说没配**——委托方遇到的正是这一条：
   * 传了图进去，模型很诚实地回"我看不到图片"，但界面上完全看不出
   * "是这套装配里没有这个工具"，只能从模型的道歉里推。
   *
   * 顺带说明 harness 在这件事上的判断：视觉模型没配时，`describe_image`
   * **根本不进工具面**，而不是摆一个一调用就报错的工具——
   * 给模型一个用不了的工具，它会反复尝试并把失败归咎于自己。
   */
  /**
   * 两处数据源形状**不一样**，都得认：
   *   · `run_config.roleModels.vision` 是 `string|null`（本 run 实际用的）；
   *   · `/api/harness` 的是 `{configured:boolean, model?}`（进程级配置）。
   * 直接 `harness.roleModels.vision ? …` 会永远为真——未配时它是
   * `{configured:false}`，一个真值对象。**那会让这一格恰好在它唯一有用的
   * 场景下说反话**，所以判据只认名字与 configured。
   */
  const visionRun = cfg.roleModels?.vision ?? null;
  const visionCfg = harness?.roleModels?.vision ?? null;
  const visionName =
    (typeof visionRun === "string" && visionRun) ||
    (visionCfg && visionCfg.configured ? visionCfg.model ?? "已配" : null);
  // supportsVision=false：端点配了但探针拒图 → 工具已卸，条上不能再说"识图 xxx"
  const supportsVision =
    cfg.supportsVision !== undefined && cfg.supportsVision !== null
      ? cfg.supportsVision
      : harness?.supportsVision;
  const imageBacking = cfg.describeImageBacking ?? harness?.describeImageBacking ?? null;
  const visionUnconfiguredWhy =
    "没配视觉模型（`AGENT_VISION_MODEL`），所以 `describe_image` **根本不进工具面**——" +
    "而不是摆一个一调用就报错的工具。给模型一个用不了的工具，它会反复尝试并把失败归咎于自己；" +
    "工具面必须与真实能力一致，这是工具运行时地板那条纪律。";
  let visionChip;
  let visionWhy;
  if (imageBacking === "executor") {
    visionChip = "识图 执行者";
    visionWhy =
      "执行者自己能看图，`describe_image` 走执行模型，不另引识图角色。" +
      "磁盘上的图不会自动进对话，所以工具仍在；只是不再 wrap / 计量 / 写进本 run 的独立识图模型。";
  } else if (imageBacking === "none") {
    visionChip = "识图 未配";
    visionWhy = visionUnconfiguredWhy;
  } else {
    visionChip =
      visionName && supportsVision === false
        ? "识图 不可用"
        : visionName
          ? `识图 ${visionName}`
          : "识图 未配";
    visionWhy =
      visionName && supportsVision === false
        ? "配了视觉模型，但能力探针（AGENT_MODEL_PROBE=1）判定端点不接受图像——" +
          "`describe_image` 已不进工具面（与没配同纪律）。"
        : visionName
        ? "执行者看不见图，才引用独立识图角色。`describe_image` 在工具面上；" +
          "执行者自己能看图时不会走到这一格。"
        : visionUnconfiguredWhy;
  }
  push("vision", visionChip, visionWhy);

  const imageRun = cfg.roleModels?.image ?? null;
  const imageCfg = harness?.roleModels?.image ?? null;
  const imageName =
    (typeof imageRun === "string" && imageRun) ||
    (imageCfg && imageCfg.configured ? imageCfg.model ?? "已配" : null);
  push(
    "image",
    imageName ? `生图 ${imageName}` : "生图 未配",
    imageName
      ? "配了生图模型，`generate_image` 才在工具面上。走独立 Images API，与执行者解耦——" +
        "执行模型不必自己会画图。"
      : "没配生图模型（`AGENT_IMAGE_MODEL`），所以 `generate_image` **根本不进工具面**——" +
        "而不是摆一个一调用就报错的工具。",
  );

  /**
   * 办公出站门禁。只在 armed 时上条——未开是常态，摆「未开」是噪声。
   * 快照若误带 webhook 字段，normalize 会剥掉，芯片与 why 都不许出现地址。
   */
  const notifySnap = normalizeNotifySnapshot(harness?.notify);
  push(
    "notify",
    notifySnap?.armed ? (notifySnap.kind === "webhook" ? "门禁通知已开" : "飞书门禁通知已开") : null,
    "看板（project_status）写入或清除时向办公软件出站推一门卡片。" +
      "Webhook 只活在服务端，`/api/harness` 只报 kind 与 armed，不下发地址。",
  );

  /**
   * 端点降级链（MODEL-01a）。**只在配了的时候上条**——与识图那一格相反：
   * 识图未配时要明说，因为"模型说它看不到图"这个现象需要解释；降级未配是
   * 绝大多数机器的常态，摆一格"未配"只是噪声。
   *
   * 配了就必须写清**覆盖范围**：链只包主执行者。若把它读成"整台宿主都保了底"，
   * 核查者所在端点挂掉时会得到一个完全意料之外的失败。
   */
  const chainCfg = cfg.fallbackChain ?? harness?.fallbackChain ?? null;
  const chainsCfg = cfg.fallbackChains ?? harness?.fallbackChains ?? null;
  const scopeCfg = cfg.fallbackScope ?? harness?.fallbackScope ?? null;
  const routingCfg = cfg.fallbackRouting ?? harness?.fallbackRouting ?? null;
  if (Array.isArray(chainCfg) && chainCfg.length > 1) {
    const fellBack = (state.timeline ?? []).some((e) => e.type === "model_fallback");
    const roleBits = [];
    if (chainsCfg?.verifier?.length > 1) roleBits.push(`核查 ${chainsCfg.verifier.join("→")}`);
    if (chainsCfg?.planner?.length > 1) roleBits.push(`规划 ${chainsCfg.planner.join("→")}`);
    if (chainsCfg?.vision?.length > 1) roleBits.push(`视觉 ${chainsCfg.vision.join("→")}`);
    const scopeLabel =
      scopeCfg === "roles" ? "多角色" : "主执行者";
    const routingLabel =
      routingCfg === "prefer_healthy"
        ? "·偏好健康"
        : routingCfg === "prefer_cheap"
          ? "·偏好廉价"
          : "";
    push(
      "fallback",
      `降级链 ${chainCfg.join(" → ")}${fellBack ? "·已降级" : ""}${routingLabel}`,
      `${scopeLabel}端点降级：瞬时错误（网络/超时/429/5xx）耗尽后换下一家再试，各端点按身份共享熔断器。` +
        (scopeCfg === "roles"
          ? `角色可自配 AGENT_<ROLE>_FALLBACK_* 或 inherit。${roleBits.length ? ` 已装配：${roleBits.join("；")}。` : ""}`
          : "角色默认不进执行者链——要保底须显式配置或 inherit。") +
        " 认证失败、400 一律原样上抛。prefer_healthy 只是粘性探针证据上的排序 stub；" +
        "prefer_cheap 只按定价表单价排备用端点——都不是延迟+成本多目标路由。",
    );
  }

  /**
   * 链健康只读面（MODEL-01）。有探针/熔断证据才上条——全是 unprobed+closed
   * 时摆一格只是噪声。不改路由，只让委托方看见粘性健康位与熔断态。
   */
  const healthRows = cfg.endpointHealth ?? harness?.endpointHealth ?? null;
  if (Array.isArray(healthRows) && healthRows.length > 0) {
    const interesting = healthRows.filter(
      (row) => row.healthy === false || row.circuit !== "closed" || row.reason && row.reason !== "unprobed",
    );
    if (interesting.length > 0 || healthRows.some((row) => row.reason && row.reason !== "unprobed")) {
      const bits = healthRows.map((row) => {
        const tags = [];
        if (row.healthy === false) tags.push("不健康");
        if (row.circuit && row.circuit !== "closed") tags.push(`熔断:${row.circuit}`);
        if (row.latencyMs != null) tags.push(`${row.latencyMs}ms`);
        return tags.length ? `${row.model}(${tags.join(",")})` : row.model;
      });
      push(
        "endpointHealth",
        `端点健康 ${bits.join(" · ")}`,
        "粘性探针与熔断器的只读快照。prefer_healthy 会读健康位；本条本身不改路由顺序。",
      );
    }
  }

  /** 精确输入 grant 必须可见：active 与历史审计不能混成一个状态。 */
  const rules = state.autoAllow ?? [];
  if (rules.length > 0) {
    const now = Date.now();
    const activeRules = rules.filter(
      (rule) =>
        !state.archived &&
        rule?.status === "active" &&
        rule.inputScope === "exact-input" &&
        rule.inputHash &&
        Number(rule.expiresAt) > now &&
        Number(rule.usedUses ?? 0) < Number(rule.maxUses ?? 0),
    );
    const historicalRules = rules.filter((rule) => !activeRules.includes(rule));
    const labels = activeRules.map((rule) => {
      const shortHash = String(rule.inputHash).replace(/^sha256:/, "").slice(0, 8);
      const remaining = Math.max(0, Number(rule.maxUses ?? 0) - Number(rule.usedUses ?? 0));
      return `${rule.name}#${shortHash}·余${remaining}`;
    });
    if (historicalRules.length) labels.push(`历史记录 ${historicalRules.length}`);
    push(
      "autoAllow",
      activeRules.length ? `精确放行 ${labels.join("·")}` : `授权审计 ${labels.join("·")}`,
      "active grant 只在**同一 runId、同一工具定义、完全相同的参数**下生效，并受固定 TTL 与次数限制；" +
        "command、path、device 任一参数变化都会重新询问。完整 main checkpoint 会保存审计快照，但 archive continuation " +
        "会创建新 run，因此只显示 not-inherited，绝不恢复执行权。旧版或过期记录仅作历史审计。",
    );
  }

  // 编排：计划确认门是"零副作用时刻"的唯一入口
  if (state.plan) {
    // planner 预算不再是写死的 12（B0）：报数字必须带来源，口径同核查预算
    const pb = cfg.plannerBudgetTurns ?? harness?.plannerBudgetTurns ?? null;
    const pbSrc = cfg.plannerBudgetSource ?? harness?.plannerBudgetSource ?? null;
    push(
      "plan",
      `编排 ${state.plan.subtasks?.length ?? 0} 步${pb ? `·planner ${pb} 轮` : ""}`,
      "planner 先拆解成带依赖的子任务再调度，互不依赖的并发跑。" +
        "配套的计划确认门挂在**第一个子任务发射之前**——那是整场运行里唯一一个否决它零副作用的时刻，过了就有东西被改了。" +
        (pb
          ? `探索预算 ${pb} 轮（来源：${pbSrc === "env" ? "env 显式覆盖" : pbSrc === "pack" ? "领域包声明" : "默认值"}），与执行者护栏解耦；撞满会续跑一小段只许写计划的收口，仍无计划才 fail-closed。`
          : ""),
    );
  }

  return items;
}

/** 长路径只留尾部两级：状态条是一行，完整值挂 title */
function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(p) : `…${parts.slice(-2).join("/")}`;
}

/**
 * 上下文圆环（常驻）+ 点击展开分项面板。
 * 不再跳转已隐藏的 Context 抽屉——面板就在圆环旁。
 */
function patchContextGauge(parts, ctx) {
  const ring = parts.ctxRing;
  const arc = parts.ctxRingArc;
  const panel = parts.ctxUsagePanel;
  if (!ring || !arc) return;

  if (!ctx || ctx.lastInputTokens === 0) {
    setAttr(ring, "hidden", "");
    if (panel) setAttr(panel, "hidden", "");
    if (parts.ctxGauge) setAttr(parts.ctxGauge, "hidden", "");
    return;
  }
  setAttr(ring, "hidden", null);

  const denom = ctx.window ?? ctx.limit;
  const ratio = denom ? Math.min(1, Math.max(0, ctx.lastInputTokens / denom)) : 0;
  const pct = denom ? Math.round(ratio * 100) : null;
  // 圆周约 97.4（r=15.5）；用百分比 dash 更直观
  const C = 2 * Math.PI * 15.5;
  const filled = ratio * C;
  setAttr(arc, "stroke-dasharray", `${filled.toFixed(2)} ${C.toFixed(2)}`);
  const tone = ctx.compactions.length > 0 ? "irreversible" : ctx.nearWatermark ? "warn" : "ok";
  ring.className = `ctx-ring ctx-ring--${tone}`;

  const label =
    pct === null
      ? `上下文 ${formatTokens(ctx.lastInputTokens)}`
      : `上下文 ${pct}%（${formatTokens(ctx.lastInputTokens)} / ${formatTokens(denom)}）`;
  setAttr(ring, "aria-label", label);
  setAttr(ring, "title", label);

  // ---- 页头水位表（.ctx-gauge）：正常水位不占顶栏——越过压缩水位、或已经
  // 发生过压缩（不可逆语域），才出现。它是入口不是死数字：点击跳 Context 面。
  const gauge = parts.ctxGauge;
  if (gauge) {
    const compacted = Boolean(ctx && ctx.compactions.length > 0);
    const over = Boolean(ctx && ctx.compactNextTurn);
    if (!ctx || ctx.lastInputTokens === 0 || (!over && !compacted)) {
      setAttr(gauge, "hidden", "");
    } else {
      setAttr(gauge, "hidden", null);
      const tone = compacted ? "irreversible" : "warn";
      gauge.className = `ctx-gauge ctx-gauge--${tone}`;
      const pct = ctx.ratio !== null && ctx.ratio !== undefined ? Math.round(ctx.ratio * 100) : null;
      const windowPct =
        ctx.window && ctx.windowRatio !== null && ctx.windowRatio !== undefined
          ? Math.round(ctx.windowRatio * 100)
          : null;
      // 统一图标 + 百分比报水位，不用文本方块模拟图形
      let html = '<i class="ph ph-gauge" aria-hidden="true"></i>';
      html += `<span class="ctx-gauge-value">${pct !== null ? `${pct}%` : formatTokens(ctx.lastInputTokens)}</span>`;
      if (windowPct !== null) html += `<span class="ctx-gauge-window">窗口 ${windowPct}%</span>`;
      if (over) html += '<span class="ctx-gauge-warn-text">下一轮将压缩</span>';
      if (compacted) html += `<span class="ctx-gauge-compactions">压缩 ${ctx.compactions.length}</span>`;
      gauge.innerHTML = html;

      // 全口径名称：分子（最近一轮输入）/ 分母（预算=压缩策略）/ 窗口（事实，未知要明说）
      const nameParts = [`最近一轮输入 ${formatTokens(ctx.lastInputTokens)}`];
      if (pct !== null) nameParts.push(`占预算 ${formatTokens(ctx.limit)} 的 ${pct}%`);
      else nameParts.push("未配置上限");
      nameParts.push(
        ctx.window
          ? `窗口 ${(ctx.window / 1000).toFixed(1)}k（${ctx.windowSource}）占 ${windowPct}%`
          : "窗口未知",
      );
      if (over) nameParts.push("下一轮将压缩");
      if (compacted) {
        nameParts.push(
          `已发生 ${ctx.compactions.length} 次压缩：置换了 ${ctx.droppedBlocks} 个 tool_result 块，结构化账本保留摘要`,
        );
      }
      setAttr(gauge, "aria-label", nameParts.join("；"));

      if (!gauge.__bound) {
        gauge.__bound = true;
        gauge.addEventListener("click", () => {
          document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab: "context" } }));
        });
      }
    }
  }

  if (!ring.__bound) {
    ring.__bound = true;
    ring.addEventListener("click", () => {
      if (!panel) return;
      const open = panel.hasAttribute("hidden");
      setAttr(panel, "hidden", open ? null : "");
      setAttr(ring, "aria-expanded", open ? "true" : "false");
      if (open) renderContextUsagePanel(panel, ctx);
    });
  }
  // 面板已开时随用量刷新
  if (panel && !panel.hasAttribute("hidden")) {
    renderContextUsagePanel(panel, ctx);
  }
}

/**
 * 分项条的分母：有窗口就用窗口。缺窗口才退回已用量（那时只能看构成，不能看空余）。
 * 错成「永远用已用量」会把 11% Full 画成满条。
 */
export function contextUsageBarScale(usedTokens, windowTokens) {
  const used = Number(usedTokens);
  const window = Number(windowTokens);
  if (Number.isFinite(window) && window > 0) return window;
  return Number.isFinite(used) && used > 0 ? used : 1;
}

/** 单个分项相对分母的百分比。0 与非法值不占宽。 */
export function contextUsageSegmentPct(tokens, scale) {
  const n = Number(tokens);
  const s = Number(scale);
  if (!(n > 0) || !(s > 0)) return 0;
  return (n / s) * 100;
}

const CONTEXT_BREAKDOWN_LEGEND = [
  { key: "system", label: "System prompt", color: "#8b8b8b" },
  { key: "toolsBuiltin", label: "Tool definitions", color: "#6b5b95" },
  { key: "toolsMcp", label: "MCP & dynamic tools", color: "#c06c84" },
  { key: "memory", label: "Memory", color: "#88b04b" },
  { key: "summarized", label: "Summarized conversation", color: "#e07a5f" },
  { key: "conversation", label: "Conversation", color: "#f2a65a" },
  { key: "unallocated", label: "Unallocated (estimate)", color: "#555" },
];

function renderContextUsagePanel(host, ctx) {
  const denom = ctx.window ?? ctx.limit;
  const pct = denom ? Math.round(Math.min(100, (ctx.lastInputTokens / denom) * 100)) : null;
  const bd = ctx.breakdown;
  let html = '<div class="ctx-usage-head">';
  html += "<strong>Context Usage</strong>";
  html += `<button type="button" class="ctx-usage-close" aria-label="关闭">×</button>`;
  html += "</div>";
  html += '<div class="ctx-usage-summary">';
  html += `<span>${pct === null ? "—" : `${pct}% Full`}</span>`;
  html += `<span>~${formatTokens(ctx.lastInputTokens)}${denom ? ` / ${formatTokens(denom)}` : ""} Tokens</span>`;
  html += "</div>";

  if (bd) {
    const parts = CONTEXT_BREAKDOWN_LEGEND
      .map((row) => ({ ...row, tokens: Number(bd[row.key] ?? 0) }))
      .filter((row) => row.key === "unallocated" || row.tokens > 0);
    // 条相对窗口占宽，不是相对已用量。118k / 1048k 只能涂 ~11%，其余留给底色。
    const used = parts.reduce((n, r) => n + Math.max(0, r.tokens), 0);
    const scale = contextUsageBarScale(used, denom);
    html += '<div class="ctx-usage-bar" role="img" aria-label="上下文分项">';
    for (const row of parts) {
      if (row.tokens <= 0) continue;
      const w = contextUsageSegmentPct(row.tokens, scale);
      html += `<span style="width:${w}%;background:${row.color}" title="${esc(row.label)}"></span>`;
    }
    html += "</div>";
    html += '<ul class="ctx-usage-legend">';
    for (const row of parts) {
      html +=
        `<li><span class="ctx-swatch" style="background:${row.color}"></span>` +
        `<span>${esc(row.label)}</span>` +
        `<span class="ctx-usage-n">${formatTokens(row.tokens)}</span></li>`;
    }
    html += "</ul>";
    html += '<p class="ctx-usage-note">分项为字符估算，Unallocated = API 实测 − 估算合计</p>';
  } else {
    html += '<p class="ctx-usage-note">本轮尚无分项估算（等待模型返回用量）</p>';
  }
  host.innerHTML = html;
  const close = host.querySelector(".ctx-usage-close");
  if (close) {
    close.addEventListener("click", () => {
      setAttr(host, "hidden", "");
      const ring = host.parentElement?.querySelector(".ctx-ring");
      if (ring) setAttr(ring, "aria-expanded", "false");
    });
  }
}

/**
 * 待复核项（⋯ unverified）。
 *
 * 只在这里出现一次。V-16：此前概览的"裁决卡"与"需介入事项"把同一批列了两遍，
 * 用户以为有两组待办。裁决卡里的那份现在是下钻详情，不是第二份清单。
 */
/**
 * 计划确认门（§5.1）——"一人公司"路线里的签字位。
 *
 * 挂起时计划已经产出、但一个子任务都还没发射，所以否决是零副作用的。
 * 决策做出后不隐藏，转成只读的审计记录留在原地——与审批卡同款口径（V-02）：
 * "我到底批没批、什么时候批的"必须刷新后还看得见。
 */
/**
 * §5.2 提问卡。与计划门同款口径：**阻塞式交互必须可见且可键盘操作**——
 * 看不见就等于运行卡死了而界面上什么都没有。
 *
 * 三个出口都给（选项 / 自由输入 / 让它自己定），因为决定 4 说得很清楚：
 * 不答不是错误。把「让它自己定」做成一个明确的按钮，而不是逼人关窗口，
 * 是同一条纪律——委托方的选择要有地方表达。
 */
function patchUserQuestion(parts, faces, callbacks) {
  if (!parts.userQuestion) return;
  const q = faces.action.question;
  if (!q || q.status !== "pending") {
    setAttr(parts.userQuestion, "hidden", "");
    parts.sig.userQuestion = null;
    parts.userQuestion.innerHTML = "";
    return;
  }
  const sig = signature([
    q.id,
    q.questions.map((x) => `${x.question}${x.options.join("|")}#${x.recommended ?? ""}`).join("§"),
  ]);
  if (parts.sig.userQuestion === sig) return;
  parts.sig.userQuestion = sig;
  setAttr(parts.userQuestion, "hidden", null);

  const n = q.questions.length;
  /**
   * 一屏答完（决定 6）。每题一组选项 + 一个自由输入，底部**一个**提交按钮——
   * 三个正交的问题分三轮问是三次打断，一屏答完是一次。
   * 选项用 radio 而不是按钮：选了要能看出选了哪个，还要能改主意。
   */
  const blocks = q.questions
    .map((item, i) => {
      const opts = item.options
        .map((o, j) => {
          // 推荐是结构化徽标，不是选项文字的一部分——radio 的 value 保持干净文字，
          // 回传给模型的答案才永远不带「（推荐）」这类装饰词
          const badge =
            item.recommended === j + 1 ? '<span class="question-badge">推荐</span>' : "";
          return (
            `<label class="question-opt"><input type="radio" name="q-${i}" value="${esc(o)}" />` +
            `<span>${esc(o)}</span>${badge}</label>`
          );
        })
        .join("");
      return (
        `<fieldset class="question-item">` +
        `<legend class="question-legend">${n > 1 ? `${i + 1}. ` : ""}${esc(item.question)}</legend>` +
        `<div class="question-options">${opts}</div>` +
        `<label class="question-free-label" for="q-free-${i}">或自己写</label>` +
        `<input id="q-free-${i}" class="question-free" data-free="${i}" type="text" placeholder="不在上面的答案" />` +
        `<p class="rail-note">不答这题就按：${esc(item.fallback)}</p>` +
        `</fieldset>`
      );
    })
    .join("");

  parts.userQuestion.innerHTML =
    '<div class="question-card">' +
    `<h3 class="rail-title">◆ 有 ${n} 个问题需要你定</h3>` +
    blocks +
    '<div class="question-actions">' +
    '<button class="btn btn--allow" data-action="send">提交答复</button>' +
    '<button class="btn" data-action="skip">都让它自己定</button>' +
    "</div></div>";

  const collect = () =>
    q.questions.map((_, i) => {
      const free = parts.userQuestion.querySelector(`[data-free="${i}"]`);
      if (free && free.value.trim()) return free.value.trim();
      const picked = parts.userQuestion.querySelector(`input[name="q-${i}"]:checked`);
      return picked ? picked.value : null;
    });

  parts.userQuestion
    .querySelector("[data-action='send']")
    .addEventListener("click", () => {
      const answers = collect();
      // 一题都没答就等同"都让它自己定"——不让它变成一次无效往返
      callbacks.onAnswer?.(answers.some((a) => a !== null) ? answers : null);
    });
  parts.userQuestion
    .querySelector("[data-action='skip']")
    .addEventListener("click", () => callbacks.onAnswer?.(null));
}

function patchPlanGate(parts, state, faces, callbacks) {
  const gate = faces.action.planApproval;
  if (!gate) {
    setAttr(parts.planGate, "hidden", "");
    parts.sig.planGate = null;
    parts.planGate.innerHTML = "";
    return;
  }
  // 已决/过期/整场已停不留在 rail 上——停≠否决，但都不能再钉着「批准并开跑」。
  if (gate.status !== "pending" || runHasClosed(state)) {
    setAttr(parts.planGate, "hidden", "");
    parts.sig.planGate = null;
    parts.planGate.innerHTML = "";
    return;
  }

  const plan = derivePlanFace(state);
  const count = plan?.nodes?.length ?? state.plan?.subtasks?.length ?? 0;
  const reviewSig = (plan?.nodes ?? []).map((n) =>
    `${n.id}:${n.title}:${n.description}:${(n.acceptance ?? []).join("|")}:${(n.dependsOn ?? []).join(",")}`,
  ).join(";");
  const sig = signature(["pending", count, reviewSig]);
  if (parts.sig.planGate === sig) return;
  parts.sig.planGate = sig;
  setAttr(parts.planGate, "hidden", null);

  const review = plan ? renderPlanReviewHtml(plan, { revealAcceptance: true, editable: true }) : "";
  parts.planGate.innerHTML =
    '<div class="plan-gate-card">' +
    '<h3 class="rail-title">◈ 计划待你签字</h3>' +
    `<p class="plan-gate-body">计划已拆出 <strong>${count}</strong> 个子任务。` +
    "下面每条短句都能改；批准时会带上你改过的字。批准后才会发射第一个子任务；此刻否决没有任何副作用。</p>" +
    (review
      ? `<div class="plan-gate-review" tabindex="0">${review}</div>`
      : "") +
    '<div class="plan-gate-actions">' +
    '<button class="btn btn--allow" data-action="approve">批准并开跑</button>' +
    '<button class="btn btn--deny" data-action="reject">否决（中止本次运行）</button>' +
    "</div></div>";
  parts.planGate
    .querySelector("[data-action='approve']")
    .addEventListener("click", () => {
      const edits = collectPlanGateEdits(parts.planGate, plan?.nodes);
      callbacks.onPlanDecision?.("approve", edits.length ? { edits } : undefined);
    });
  parts.planGate
    .querySelector("[data-action='reject']")
    .addEventListener("click", () => callbacks.onPlanDecision?.("reject"));
}

function patchHandoffRail(parts, state, faces, callbacks) {
  if (!parts.handoff) return;
  const offer = faces.action.handoff;
  if (!offer || offer.status !== "pending") {
    setAttr(parts.handoff, "hidden", "");
    parts.sig.handoff = null;
    parts.handoff.innerHTML = "";
    return;
  }
  const running = state.status === "running";
  const sig = signature(["pending", offer.id, offer.summary, offer.label, running]);
  if (parts.sig.handoff === sig) return;
  parts.sig.handoff = sig;
  setAttr(parts.handoff, "hidden", null);

  const acceptDisabled = running
    ? " disabled aria-disabled=\"true\""
    : "";
  const hint = running
    ? '<p class="rail-note">对话继续。等这次调试结束再换段。</p>'
    : '<p class="rail-note">对话不暂停。点了才开下一场；先不用就收起这张卡。</p>';

  parts.handoff.innerHTML =
    '<div class="handoff-card">' +
    '<h3 class="rail-title">要不要接着做？</h3>' +
    `<p class="handoff-summary">${esc(offer.summary)}</p>` +
    hint +
    '<div class="handoff-actions">' +
    `<button class="btn btn--allow" data-action="accept"${acceptDisabled}>${esc(offer.label)}</button>` +
    `<button class="btn" data-action="decline">${esc(offer.declineLabel)}</button>` +
    "</div></div>";
  parts.handoff
    .querySelector("[data-action='accept']")
    ?.addEventListener("click", () => {
      if (state.status === "running") return;
      callbacks.onHandoffDecision?.("accept");
    });
  parts.handoff
    .querySelector("[data-action='decline']")
    ?.addEventListener("click", () => callbacks.onHandoffDecision?.("decline"));
}

function patchUnverifiedRail(parts, faces, callbacks = {}) {
  const leftover =
    faces.action.awaitingPlan ||
    faces.action.awaitingQuestion ||
    faces.action.awaitingHandoff ||
    (faces.action.pendingApprovals?.length ?? 0) > 0 ||
    (faces.action.childApprovalCount ?? 0) > 0 ||
    (faces.action.blockers?.length ?? 0) > 0;
  setAttr(parts.actionRail, "hidden", leftover ? null : "");
  if (parts.dock) setAttr(parts.dock, "hidden", leftover ? null : "");
  // 待复核只留在对话末尾的裁决卡里，坞上不再占一条横幅。
  if (parts.unverified) {
    setAttr(parts.unverified, "hidden", "");
    parts.unverified.innerHTML = "";
  }
}

/**
 * 直播条：运行中显示【正在流入的文本】，其次是最近一次工具调用，再次是最后一句输出。
 *
 * liveText 是逐字增量（`event: delta` 命名通道）。它**不在 RunState 里**，
 * 由控制器单独持有并作为参数传入——delta 不占 seq、不进事件缓冲（V-15），
 * 重放时根本不存在；塞进 state 会打破 reducer 的"同批事件重放两次状态深相等"。
 *
 * 优先级把 liveText 放第一：它描述的是【此刻正在发生】的事，而 tool_call /
 * assistant_text 都是已经发生完的。控制器在 turn_start / tool_call / done
 * 时清空缓冲，所以文本阶段一结束就自动让位给工具标签。
 */
function paintLiveStripLabel(parts, label, flags = {}) {
  const sig = signature([label, flags.stall ? "stall" : "", flags.cost ? "cost" : "", flags.think ? "think" : ""]);
  if (parts.sig.live === sig) return;
  parts.sig.live = sig;
  setAttr(parts.liveStrip, "hidden", null);
  setClass(parts.liveStrip, "live-strip--stall", Boolean(flags.stall));
  setClass(parts.liveStrip, "live-strip--cost", Boolean(!flags.stall && flags.cost));
  parts.liveStrip.innerHTML = '<span class="live-text thinking-shimmer"></span>';
  setText(parts.liveStrip.querySelector(".live-text"), label);
  if (flags.title) setAttr(parts.liveStrip, "title", flags.title);
}

function patchLiveStrip(parts, state, isRunning, liveText = "", liveThinking = "", harness = null) {
  if (!isRunning) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  const streaming = String(liveText ?? "").trim();
  const thinking = String(liveThinking ?? "").trim();
  const recent = [...state.timeline].reverse();
  const call = recent.find((e) => e.type === "tool_call");
  const text = recent.find((e) => e.type === "assistant_text");
  /**
   * 正文已经在对话里逐字流，直播条让位（V-16）。
   * 思考块默认折叠，thinking_delta 必须跟到这一条，否则人只看见「正在想…」。
   */
  if (streaming) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  if (thinking) {
    paintLiveStripLabel(parts, liveStripThinkingLabel(thinking), { think: true });
    return;
  }
  const results = new Set(
    (state.timeline ?? []).filter((e) => e.type === "tool_result").map((e) => e.toolUseId),
  );
  const toolLive = (state.timeline ?? []).some((e) => e.type === "tool_call" && !results.has(e.toolUseId));
  // 进行中的工具由对话里那条滑动高亮承担，这里不再叠第二份「正在 bash」
  if (toolLive || call) {
    setAttr(parts.liveStrip, "hidden", "");
    parts.sig.live = null;
    return;
  }
  const spin = deriveSpinState(state);
  const costWarn = deriveCostWarning(state, harness);
  const thinkingNow = Boolean(latestExecutorThinkingText(state, lastUserMessageSeq(state)));
  const label = spin
    ? spin.label
    : costWarn
      ? costWarn.label
      : thinkingNow && !text
        ? "正在想…"
        : text
          ? String(text.text ?? "").slice(0, 80)
          : "等待模型响应…";

  paintLiveStripLabel(parts, label, {
    stall: Boolean(spin),
    cost: Boolean(!spin && costWarn),
    title: spin?.detail || costWarn?.detail || "",
  });
}

/**
 * 取尾部 n 字（流式文本要看的是最新写出来的那截，不是开头）。
 * 换行折成空格：直播条是单行，原样塞进去会把布局撑开。
 */
export function tailOf(s, n) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `…${flat.slice(flat.length - n)}`;
}

/** 思考增量跟到直播条。对话里的 Thinking 默认折叠，正文才在对话里逐字流。 */
export function liveStripThinkingLabel(thinking) {
  const body = tailOf(thinking, 72);
  return body ? `正在想… ${body}` : "正在想…";
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const first = Object.values(input)[0];
  const s = typeof first === "string" ? first : JSON.stringify(first ?? "");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * 审批栏（V-10 的关键分区）。
 *
 * 用 patchList 按 approvalId 键控：已存在的卡片节点永不重建，于是里面的
 * 拒绝理由输入框连同光标位置一起活下来。直播中的 run 几百毫秒一个事件，
 * 旧实现下这个输入框根本没法用。
 */
function bindApprovalActions(root, callbacks) {
  if (!root) return;
  root.__approvalCallbacks = callbacks;
  if (root.__approvalBound) return;
  root.__approvalBound = true;
  root.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("[data-action]");
    if (!btn || !root.contains(btn)) return;
    const card = btn.closest("[data-approval-id]");
    const id = card?.getAttribute("data-approval-id");
    if (!id) return;
    const cb = root.__approvalCallbacks ?? {};
    const action = btn.getAttribute("data-action");
    const reason = card.querySelector(".deny-reason")?.value?.trim() ?? "";
    if (action === "allow") cb.onAllow?.(id);
    else if (action === "allow-always") cb.onAllowAlways?.(id, card.getAttribute("data-tool-name"));
    else if (action === "deny") cb.onDenyReason?.(id, reason);
  });
}

function patchApprovalRail(parts, state, isRunning, callbacks) {
  /**
   * **只有待处理的进 rail**（委托方反馈）。
   *
   * 此前这里渲染 `state.pendingApprovals` 全量——那个数组同时装着已决的，
   * 于是长运行下审批卡无限堆叠、已处理与未处理混在一起，既难读又难操作。
   * 已决的本来就在概览「审批记录」里有留档，留在 rail 上是同一条在两处
   * 重复展示（V-16 修过的同一个毛病），而 rail 的语义是"需你现在决定"。
   *
   * 但也不能点完就凭空消失——那样人不确定自己那一下有没有生效。
   * 折中：已决的折叠成一行摘要留在 rail 底部，展开是紧凑列表而不是完整卡片。
   */
  bindApprovalActions(parts.approvals ?? parts.actionRail, callbacks);
  const list = visiblePendingApprovals(state);
  patchResolvedSummary(parts);

  setAttr(parts.approvals, "hidden", list.length > 0 ? null : "");
  if (list.length === 0) {
    patchList(parts.approvals, [], { key: (a) => a.approvalId || a.toolUseId, create: () => document.createElement("div") });
    return;
  }

  patchList(parts.approvals, list, {
    key: (a) => a.approvalId || a.toolUseId,
    create: (a) => {
      const card = document.createElement("div");
      card.className = "approval-card";
      card.setAttribute("data-approval-id", a.approvalId || a.toolUseId);
      card.innerHTML =
        '<div class="approval-card-header">' +
        '<span class="approval-tool-name"></span>' +
        '<span class="approval-result" hidden></span>' +
        "</div>" +
        '<p class="approval-summary"></p>' +
        '<details class="approval-details">' +
        "<summary>详情</summary>" +
        '<pre class="approval-input"></pre>' +
        '<button type="button" class="btn btn--allow-always" data-action="allow-always">短期允许相同参数</button>' +
        "</details>" +
        '<div class="approval-resolved" hidden></div>' +
        '<div class="approval-actions" hidden>' +
        '<button type="button" class="btn btn--allow" data-action="allow">允许</button>' +
        '<button type="button" class="btn btn--deny" data-action="deny">拒绝</button>' +
        '<input class="deny-reason" placeholder="拒绝理由（可选）" />' +
        "</div>" +
        '<div class="approval-meta" hidden></div>' +
        '<div class="approval-reason" hidden></div>';

      const cardId = a.approvalId || a.toolUseId;
      const input = card.querySelector(".deny-reason");
      input.setAttribute("data-fk", `approval:${cardId}:reason`);
      updateApprovalCard(card, a, isRunning);
      return card;
    },
    update: (card, a) => updateApprovalCard(card, a, isRunning),
  });
}

/**
 * 已处理审批不再占输入框上方一行。
 * 委托方：「已处理 N 项」本身没有下一步，留着只挡对话。
 */
function patchResolvedSummary(parts) {
  const host = parts.approvalsDone;
  if (!host) return;
  setAttr(host, "hidden", "");
  if (host.innerHTML) host.innerHTML = "";
  parts.sig.approvalsDone = null;
}

function updateApprovalCard(card, a, isRunning) {
  const isPending = a.status === "pending";
  /**
   * 这是**兜底**，不是主闸——说清楚免得高估它。
   *
   * 唯一的调用路径 `patchApprovalRail` 已经把列表过滤成 pending-only，
   * 所以这里 `isPending` 恒真；变异测试（改成 `operable = true`）不会让任何
   * 一条测试变红。真正在守 R-01 的是三处：reducer 在 run_end/error 上把
   * pending 收敛成 expired、rail 的 pending-only 过滤、服务端两路 409。
   * 留着它是防"reducer 漏掉某条终止路径"，不是防用户。
   */
  const operable = isPending && isRunning;
  const resolved = !isPending;

  setClass(card, "approval-card--resolved", resolved);
  card.setAttribute("data-tool-name", a.name ?? "");
  const human = describeApprovalAction(a.name, a.input);
  setText(card.querySelector(".approval-tool-name"), human);
  setText(card.querySelector(".approval-summary"), human);

  const resultEl = card.querySelector(".approval-result");
  if (resolved) {
    const label = a.status === "allowed" ? "已允许" : a.status === "denied" ? "已拒绝" : "已过期";
    const mod = a.status === "allowed" ? "allow" : a.status === "denied" ? "deny" : "expired";
    setAttr(resultEl, "hidden", null);
    setText(resultEl, label);
    resultEl.className = `approval-result approval-result--${mod}`;
  } else {
    setAttr(resultEl, "hidden", "");
  }

  setText(card.querySelector(".approval-input"), formatInput(a.input));
  const resolvedEl = card.querySelector(".approval-resolved");
  const targets = Array.isArray(a.resolvedTargets) ? a.resolvedTargets : [];
  if (targets.length > 0) {
    const warn = targets.some((t) => t && (t.diverges || t.error));
    setAttr(resolvedEl, "hidden", null);
    setClass(resolvedEl, "approval-resolved--warn", warn);
    resolvedEl.innerHTML = targets
      .map((t) => {
        if (!t) return "";
        if (t.error) {
          return `<strong>真实目标不可用</strong>（${esc(t.field)}=${esc(t.requested)}）：${esc(t.error)}`;
        }
        const real = t.real ?? t.lexical ?? t.requested;
        return (
          `<strong>请求 → 真实</strong>（${esc(t.field)}）：` +
          `<code>${esc(t.requested)}</code> → <code>${esc(real)}</code>`
        );
      })
      .join("<br>");
  } else {
    setAttr(resolvedEl, "hidden", "");
    setClass(resolvedEl, "approval-resolved--warn", false);
    resolvedEl.innerHTML = "";
  }
  card.querySelector(".deny-reason").setAttribute(
    "aria-label",
    `拒绝 ${a.name} 的理由（可选）`,
  );

  // 只切显隐，不重建——输入框节点必须原地存活
  setAttr(card.querySelector(".approval-actions"), "hidden", operable ? null : "");
  const reusable = a.grantPolicy?.maxScope === "exact-input";
  const reusableButton = card.querySelector("[data-action='allow-always']");
  setAttr(reusableButton, "hidden", operable && reusable ? null : "");
  if (reusable) {
    setAttr(
      reusableButton,
      "title",
      `最多复用 ${Number(a.grantPolicy.maxUses ?? 0)} 次，最长 ${Math.round(Number(a.grantPolicy.maxTtlMs ?? 0) / 60000)} 分钟`,
    );
  } else {
    setAttr(reusableButton, "title", "该工具策略只允许单次审批");
  }

  const metaEl = card.querySelector(".approval-meta");
  setAttr(metaEl, "hidden", resolved && a.decidedAt ? null : "");
  if (resolved && a.decidedAt) setText(metaEl, formatTime(a.decidedAt));

  const reasonEl = card.querySelector(".approval-reason");
  setAttr(reasonEl, "hidden", resolved && a.reason ? null : "");
  if (resolved && a.reason) setText(reasonEl, `理由：${a.reason}`);
}

/**
 * 结果卡：恒在、恒展开。
 *
 * 排序刻意把核查结论放在执行者报告之前——委托方 §6 的要求是"无需展开日志
 * 即可判断结果"，而执行者的自述与核查者的裁决不是一回事，后者才是结论。
 */
function pathWithoutLineRef(value) {
  const raw = String(value ?? "").trim();
  return extractLocalPathRef(raw)?.path ?? raw.replace(/:\d+(?::\d+)?$/, "");
}

function pathBasename(value) {
  const clean = pathWithoutLineRef(value).replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
}

function joinDisplayedPath(dir, file) {
  const clean = String(dir ?? "").replace(/[\\/]+$/, "");
  const separator = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
  return `${clean}${separator}${file}`;
}

/**
 * 给每个显示值列出按优先级排列的实际探测路径。
 *
 * 裸文件名本身信息不足：截图里的 `index.html` 实际位于同一句已经提到的
 * `threejs-fps-game/` 下。这里先用已确认产物的唯一 basename，再试同消息目录，
 * 最后才试工作目录根；只有服务端 stat 成功的那一项会真正变成链接。
 */
export function buildLocalPathProbePlan(labels, artifactPaths = []) {
  const uniqueLabels = [...new Set((labels ?? []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  const directories = uniqueLabels
    .map(pathWithoutLineRef)
    .filter((v) => /[\\/]$/.test(v));
  const artifacts = [...new Set((artifactPaths ?? []).map((v) => String(v ?? "").trim()).filter(Boolean))];

  const entries = uniqueLabels.map((label) => {
    const target = pathWithoutLineRef(label);
    const choices = [];
    const hasSeparator = /[\\/]/.test(target);
    const isDirectory = /[\\/]$/.test(target);
    if (!hasSeparator && !isDirectory) {
      const byBasename = artifacts.filter(
        (path) => pathBasename(path).toLocaleLowerCase() === target.toLocaleLowerCase(),
      );
      if (byBasename.length === 1) choices.push(byBasename[0]);
      for (const dir of directories) choices.push(joinDisplayedPath(dir, target));
    }
    choices.push(target);
    const deduped = [...new Map(choices.map((v) => [v.toLocaleLowerCase(), v])).values()];
    return { label, choices: deduped };
  });
  return {
    entries,
    probes: [...new Map(entries.flatMap((e) => e.choices).map((v) => [v.toLocaleLowerCase(), v])).values()],
  };
}

function makePathIcon(name) {
  const icon = document.createElement("i");
  icon.className = `ph ph-${name}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function decorateLocalPathCode(code, hit, runId, callbacks) {
  if (!code?.parentNode || !hit?.path || !hit?.kind) return;
  const shell = document.createElement("span");
  shell.className = `local-path-ref local-path-ref--${hit.kind}`;
  code.classList.add("local-path-code");
  code.removeAttribute("data-local-path");
  code.setAttribute("data-path-state", "linked");

  if (hit.kind === "file") {
    const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(hit.path)}`;
    const link = document.createElement("a");
    link.className = "local-path-link";
    link.href = href;
    link.rel = "noopener noreferrer";
    link.dataset.previewPath = hit.path;
    link.title = `在右侧预览：${hit.path}`;
    code.parentNode.insertBefore(shell, code);
    link.append(code, makePathIcon("arrow-square-out"));
    shell.append(link);

    // 眼睛与文件名同一条路：都进右侧画布。二进制不给钮（画布也只能画降级卡）。
    if ((typeof callbacks?.onOpenCanvas === "function" || typeof callbacks?.onPreviewPath === "function")
      && artifactRendererKind(hit.path) !== "binary") {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "local-path-preview";
      preview.dataset.pathPreview = hit.path;
      preview.title = "在右侧预览";
      preview.setAttribute("aria-label", `预览 ${hit.path}`);
      preview.append(makePathIcon("eye"));
      shell.append(preview);
    }

    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "local-path-folder";
    reveal.dataset.pathReveal = hit.path;
    reveal.title = "在文件夹中显示";
    reveal.setAttribute("aria-label", `在文件夹中显示 ${hit.path}`);
    reveal.append(makePathIcon("folder-open"));
    shell.append(reveal);
    return;
  }

  const open = document.createElement("button");
  open.type = "button";
  open.className = "local-path-link local-path-link--directory";
  open.dataset.pathReveal = hit.path;
  open.title = `打开文件夹：${hit.path}`;
  open.setAttribute("aria-label", `打开文件夹 ${hit.path}`);
  code.parentNode.insertBefore(shell, code);
  open.append(code, makePathIcon("folder-open"));
  shell.append(open);
}

function bindLocalPathActions(host, callbacks) {
  if (!host) return;
  host.__pathReveal = callbacks?.onReveal;
  host.__pathPreview = callbacks?.onPreviewPath;
  host.__pathCanvas = callbacks?.onOpenCanvas;
  if (host.__pathActionBound) return;
  host.__pathActionBound = true;
  host.addEventListener("click", (event) => {
    if (stayInPageForPreviewClick(event, host.__pathCanvas ?? host.__pathPreview)) return;
    const target = event.target instanceof Element
      ? event.target.closest("[data-path-reveal]")
      : null;
    if (!target) return;
    event.preventDefault();
    host.__pathReveal?.(target.getAttribute("data-path-reveal"));
  });
}

async function hydrateLocalPathLinks(host, state, callbacks) {
  if (!host || typeof callbacks?.inspectPaths !== "function") return;
  bindLocalPathActions(host, callbacks);
  const nodes = [...host.querySelectorAll('code[data-local-path]:not([data-path-state])')];
  if (nodes.length === 0) return;
  for (const node of nodes) node.setAttribute("data-path-state", "checking");

  const labels = nodes.map((node) => node.getAttribute("data-local-path") ?? "");
  const artifactPaths = deriveArtifacts(state).map((artifact) => artifact.path);
  const plan = buildLocalPathProbePlan(labels, artifactPaths);
  let inspected = [];
  try {
    inspected = await callbacks.inspectPaths(plan.probes.slice(0, 64));
  } catch {
    // 路径链接是渐进增强：宿主不可达时正文仍完整可读
  }
  const byInput = new Map(
    (Array.isArray(inspected) ? inspected : [])
      .filter((item) => item?.exists && item?.input)
      .map((item) => [String(item.input).toLocaleLowerCase(), item]),
  );
  const choiceByLabel = new Map(
    plan.entries.map((entry) => [
      entry.label,
      entry.choices.map((choice) => byInput.get(choice.toLocaleLowerCase())).find(Boolean) ?? null,
    ]),
  );

  for (const node of nodes) {
    if (!host.contains(node) || node.getAttribute("data-path-state") !== "checking") continue;
    const label = node.getAttribute("data-local-path") ?? "";
    const hit = choiceByLabel.get(label);
    if (hit) decorateLocalPathCode(node, hit, state.runId, callbacks);
    else node.setAttribute("data-path-state", "plain");
  }
}

/**
 * 产物卡的 stat 验证：卡片按声明/工具记录先画出来，再异步确认文件还在不在。
 *
 * 模型声明的产物可能从未落盘（或被后来的步骤删掉）。验证不过的卡**直接拿掉**——
 * 虚线「未找到」卡夹在真文件中间比没有更突兀，点了也只会再弹一次 404。
 * 与 hydrateLocalPathLinks 同一份 inspectPaths 渐进增强：宿主不可达时卡片
 * 维持原样可点，不会因为一次网络抖动把真文件藏掉。
 */
function bindArtifactCardPath(node, resolved, runId) {
  if (!node || !resolved) return;
  node.setAttribute("data-artifact-path", resolved);
  const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(resolved)}`;
  for (const a of node.querySelectorAll("a")) {
    const old = a.getAttribute("href") ?? "";
    if (!old.includes("/artifact")) continue;
    a.setAttribute("href", old.includes("download=1") ? `${href}&download=1` : href);
    if (a.classList.contains("artifact-name") || a.classList.contains("chat-artifact-name")) {
      a.title = resolved;
      a.textContent = fileShortPath(resolved);
    }
  }
  for (const el of node.querySelectorAll("[data-canvas-open]")) el.setAttribute("data-canvas-open", resolved);
  for (const el of node.querySelectorAll("[data-reveal]")) el.setAttribute("data-reveal", resolved);
}

async function hydrateArtifactCards(host, state, callbacks) {
  if (!host || typeof callbacks?.inspectPaths !== "function") return;
  const nodes = [...host.querySelectorAll("[data-artifact-path]:not([data-artifact-state])")];
  if (nodes.length === 0) return;
  for (const node of nodes) node.setAttribute("data-artifact-state", "checking");
  const labels = [...new Set(nodes.map((n) => n.getAttribute("data-artifact-path") ?? "").filter(Boolean))];
  const known = [];
  if (state?.timeline) known.push(...deriveArtifacts(state).map((a) => a.path));
  for (const f of state?.files ?? []) if (f?.path) known.push(f.path);
  for (const f of callbacks?.previewFiles ?? []) if (f?.path) known.push(f.path);
  for (const f of callbacks?.threadFiles ?? []) if (f?.path) known.push(f.path);
  const plan = buildLocalPathProbePlan(labels, known);
  let inspected = [];
  try {
    inspected = await callbacks.inspectPaths(plan.probes.slice(0, 64));
  } catch {
    for (const node of nodes) node.removeAttribute("data-artifact-state");
    return;
  }
  const byInput = new Map(
    (Array.isArray(inspected) ? inspected : [])
      .filter((item) => item && item.input)
      .map((item) => [String(item.input).toLocaleLowerCase(), item]),
  );
  const choiceByLabel = new Map(
    plan.entries.map((entry) => [
      entry.label,
      entry.choices.map((choice) => byInput.get(choice.toLocaleLowerCase())).find((item) => item?.exists) ?? null,
    ]),
  );
  for (const node of nodes) {
    if (!host.contains(node) || node.getAttribute("data-artifact-state") !== "checking") continue;
    const path = node.getAttribute("data-artifact-path") ?? "";
    const hit = choiceByLabel.get(path) ?? byInput.get(path.toLocaleLowerCase());
    if (hit && hit.exists) {
      bindArtifactCardPath(node, hit.path || path, state?.runId ?? "");
      node.setAttribute("data-artifact-state", "ok");
      continue;
    }
    dismissMissingArtifactCard(node);
  }
  if (host && !host.querySelector("[data-artifact-path]")) {
    const rail = host.closest(".artifacts") ?? (host.classList.contains("artifacts") ? host : null);
    if (rail) rail.setAttribute("hidden", "");
  }
}

/** 没落盘的声明从清单里摘掉，并改分组计数；整组空了就一并拿掉。 */
function dismissMissingArtifactCard(node) {
  if (!node) return;
  const section = node.closest(".rail-section");
  const chatGroup = node.closest(".chat-artifacts");
  const rest = node.closest(".chat-artifacts-rest");
  node.remove();
  if (section) {
    const remaining = section.querySelectorAll("[data-artifact-path]").length;
    const peek = section.querySelector(".rail-section-title .aside-peek");
    if (peek) peek.textContent = String(remaining);
    if (remaining === 0) section.remove();
  }
  if (rest && !rest.querySelector("[data-artifact-path]")) rest.remove();
  if (chatGroup && !chatGroup.querySelector("[data-artifact-path]")) chatGroup.remove();
}

/**
 * 对话主干的补丁。
 *
 * 签名只看 `lastSeq` 与条目数：事件流单调追加，这两个数不变就没有新内容。
 * 与日志面同款——重画整段对话会打断正在展开的 details 与用户的滚动位置。
 */
function campaignChildStatusLabel(status) {
  if (status === "running") return "工作中";
  if (status === "done") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "error") return "未完成";
  if (status === "pending") return "等待";
  return String(status ?? "");
}

function patchCampaignStrip(parts, state, callbacks) {
  const host = parts.campaignStrip;
  if (!host) return;
  const children = deriveCampaignChildren(state);
  const show = children.length > 0;
  setAttr(host, "hidden", show ? null : "");
  if (!show) {
    host.innerHTML = "";
    host.__bound = false;
    return;
  }
  let html =
    '<div class="campaign-strip-head">子对话</div><ul class="campaign-chip-list">';
  for (const c of children) {
    const cancel = c.status === "running"
      ? `<button type="button" class="campaign-chip-cancel" data-cancel-child="${esc(c.runId)}">取消</button>`
      : "";
    html +=
      `<li class="campaign-chip campaign-chip--${esc(c.status)}">` +
      `<span class="campaign-chip-title">${esc(c.title || "子对话")}</span>` +
      `<span class="campaign-chip-status">${esc(campaignChildStatusLabel(c.status))}</span>` +
      `<button type="button" class="campaign-chip-enter" data-open-run="${esc(c.runId)}">进入</button>` +
      cancel +
      `</li>`;
  }
  html += "</ul>";
  host.innerHTML = html;
  host.__campaignCallbacks = callbacks;
  if (!host.__bound) {
    host.__bound = true;
    host.addEventListener("click", (e) => {
      const cb = host.__campaignCallbacks ?? {};
      const open = e.target instanceof Element ? e.target.closest("[data-open-run]") : null;
      if (open) {
        cb.onOpenRun?.(open.getAttribute("data-open-run"));
        return;
      }
      const cancelBtn = e.target instanceof Element ? e.target.closest("[data-cancel-child]") : null;
      if (cancelBtn) {
        cb.onCancelCampaignChild?.(cancelBtn.getAttribute("data-cancel-child"));
      }
    });
  }
}

function patchConversation(parts, state, live, callbacks) {
  const host = parts.conversation;
  if (!host) return;
  bindThinkingPref(host);
  const items = (callbacks?.runs && callbacks?.runStates)
    ? deriveThreadChatItems(callbacks.runs, callbacks.runStates, state.runId, live, {
        threadFiles: callbacks.threadFiles,
      })
    : deriveChatItems(state, live, {
        threadFiles: callbacks?.threadFiles,
      });

  if (items.length === 0) {
    host.__patchNodes = undefined;
    host.innerHTML =
      state.status === "running"
        ? '<p class="empty-note">刚开始，还没有内容。</p>'
        : '<p class="empty-note">这次运行没有产生对话内容。</p>';
    return;
  }
  const empty = host.querySelector(".empty-note");
  if (empty) empty.remove();

  /**
   * **键控补丁，不是整段重画。**
   *
   * 初版这里是一句 `innerHTML = renderChatStream(...)`。流式一开，签名每来一个
   * 字就变一次，于是整段对话每秒重建几十遍——后果是**用户点开的思考过程当场
   * 被关上**（`<details open>` 随节点一起没了），滚动位置也一起归零。
   * 委托方那句"点开思考过程就应该永远显示"，缺的正是这一层。
   *
   * 这也正是本仓 V-10 早就定下的纪律（已存在 key 的节点永不重建，只更新），
   * 我在把对话搬成主干时把它漏掉了。
   */
  /**
   * **贴底跟随**：人在底部就跟着新内容往下走，人往上翻了就别动他
   * （委托方："在流式的情况下在最底部的时候应该一直往下移动，
   *  然后不在最底部的时候就不往下移动"）。
   *
   * 这是 GitHub Actions / 各家日志面板的标准行为，本仓的 `keepScrollAnchored`
   * 早就实现了它，只是**日志面在用、对话没接**——而流式恰恰全在对话里，
   * 于是"正在写"的那一段每次都长在视野之外。
   */
  const scroller = host.closest(".content-area") || host;
  keepScrollAnchored(scroller, () => {
  patchList(host, items, {
    key: (it) => it.key,
    create: (it) => {
      const node = document.createElement("div");
      node.className = "chat-item";
      node.__sig = chatItemSig(it);
      node.innerHTML = renderChatItem(it, thinkingPrefOpen());
      return node;
    },
    update: (node, it) => {
      const sig = chatItemSig(it);
      if (node.__sig === sig) return;
      const group = node.querySelector("details.chat-tool-group");
      const wasOpen = Boolean(group?.open);
      node.__sig = sig;
      // 流式那条**就地改文本**，绝不重建：它每来一个字就走一次这里，
      // 重建等于把用户刚点开的 details 一秒关上几十遍
      if (it.kind === "live" && updateLiveNode(node, it)) return;
      node.innerHTML = renderChatItem(it, thinkingPrefOpen());
      if (wasOpen) {
        const next = node.querySelector("details.chat-tool-group");
        if (next) next.open = true;
      }
    },
  });
  });
  // 对话内产物卡的「在文件夹中显示」与「打开」（T10 画布）——与右栏同一委托
  host.__chatCallbacks = callbacks;
  if (!host.__revealBound) {
    host.__revealBound = true;
    host.addEventListener("click", (e) => {
      const cb = host.__chatCallbacks ?? {};
      if (stayInPageForPreviewClick(e, cb.onOpenCanvas ?? cb.onPreviewPath)) return;
      const ext = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (ext && isPlainLeftClick(e) && typeof cb.onOpenBrowser === "function") {
        const href = parseBrowserUrl(ext.getAttribute("href") || ext.href);
        if (href) {
          try {
            if (new URL(href).origin !== location.origin) {
              e.preventDefault();
              cb.onOpenBrowser(href);
              return;
            }
          } catch { /* 非法网址按普通链接 */ }
        }
      }
      const openRun = e.target instanceof Element ? e.target.closest("[data-open-run]") : null;
      if (openRun) {
        cb.onOpenRun?.(openRun.getAttribute("data-open-run"));
        return;
      }
      const agentBtn = e.target instanceof Element ? e.target.closest("[data-agent-id]") : null;
      if (agentBtn) {
        const id = agentBtn.getAttribute("data-agent-id");
        if (id) cb.onOpenAgent?.(id);
        return;
      }
      const actionBtn = e.target instanceof Element ? e.target.closest("[data-chat-action]") : null;
      if (actionBtn) {
        const action = actionBtn.getAttribute("data-chat-action");
        const runId = actionBtn.getAttribute("data-run-id") || state.runId;
        const seqRaw = actionBtn.getAttribute("data-seq");
        const seq = seqRaw === "" || seqRaw == null ? null : Number(seqRaw);
        const itemNode = actionBtn.closest(".chat-item");
        if (action === "copy") {
          cb.onCopyChat?.(chatTextFromNode(itemNode));
          return;
        }
        if (action === "export-sources") {
          const table = actionBtn.closest(".chat-sources")?.querySelector("tbody");
          const rows = [...(table?.querySelectorAll("tr") ?? [])].map((tr) => {
            const cells = [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim());
            return { title: cells[0] || "", quote: cells[1] || "", url: cells[2] || "" };
          });
          cb.onCopyChat?.(formatSourceExport(rows));
          return;
        }
        if (action === "fork") {
          cb.onForkChat?.(runId);
          return;
        }
        if (action === "rewind") {
          cb.onRewindChat?.(runId, Number.isFinite(seq) ? seq : -1);
          return;
        }
        if ((action === "up" || action === "down") && runId != null && Number.isFinite(seq)) {
          const prev = readChatRating(runId, seq);
          if (prev === action) return;
          const next = writeChatRating(runId, seq, action);
          if (next !== action) return;
          const bar = actionBtn.closest(".chat-msg-actions");
          if (bar) {
            for (const btn of bar.querySelectorAll("[data-chat-action=up], [data-chat-action=down]")) {
              const on = btn.getAttribute("data-chat-action") === next;
              btn.classList.toggle("is-on", on);
              btn.setAttribute("aria-pressed", on ? "true" : "false");
            }
          }
          cb.onRateChat?.(runId, seq, next, chatTextFromNode(itemNode));
          return;
        }
      }
      const btn = e.target instanceof Element ? e.target.closest("[data-reveal]") : null;
      if (btn) cb.onReveal?.(btn.getAttribute("data-reveal"));
    });
  }
  void hydrateLocalPathLinks(host, state, callbacks);
  void hydrateArtifactCards(host, state, callbacks);
}

function patchChildApprovalHint(parts, state, callbacks) {
  const hint = parts.childApprovalHint;
  if (!hint) return;
  const agents = deriveChildAgents(state).filter((a) => a.pendingApprovals > 0);
  if (agents.length === 0) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  const n = agents.reduce((sum, a) => sum + a.pendingApprovals, 0);
  hint.hidden = false;
  hint.setAttribute("data-agent-id", agents[0].id);
  hint.textContent = agents.length === 1
    ? `子代理待批准：${agents[0].title}`
    : `${agents.length} 个子代理共 ${n} 项待批准`;
  if (!hint.__bound) {
    hint.__bound = true;
    hint.addEventListener("click", () => {
      const id = hint.getAttribute("data-agent-id");
      if (id) callbacks?.onOpenAgent?.(id);
    });
  }
}

function patchAgentOverlay(parts, state, callbacks, live = null) {
  const host = parts.agentOverlay;
  if (!host) return;
  const agentId = typeof callbacks.selectedAgentId === "string" ? callbacks.selectedAgentId : "";
  if (!agentId) {
    host.hidden = true;
    host.innerHTML = "";
    host.__agentId = "";
    return;
  }
  const agents = deriveChildAgents(state);
  const agent = agents.find((a) => a.id === agentId);
  const title = agent?.title || agentId.replace(/^spawn\//, "");
  const running = agent?.status === "running";
  const items = deriveChatItems(state, running ? live : null, { agentId });
  const pending = (state.pendingApprovals ?? []).filter(
    (a) => a.status === "pending" && childAgentKey(a.source) === agentId,
  );
  host.hidden = false;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-label", `子代理 ${title}`);
  const liveSig = running
    ? `${String(live?.text ?? "").length}:${String(live?.thinking ?? "").length}`
    : "0";
  const sig = `${items.length}:${pending.length}:${items.at(-1)?.key ?? ""}:${liveSig}`;
  if (host.__agentId !== agentId || host.__sig !== sig) {
    host.__agentId = agentId;
    host.__sig = sig;
    let html =
      `<div class="agent-overlay-head">` +
      `<button type="button" class="agent-overlay-back" data-agent-back>返回主对话</button>` +
      `<strong class="agent-overlay-title">${esc(title)}</strong>` +
      `<span class="agent-overlay-meta${running ? " thinking-shimmer" : ""}">${esc(running ? "工作中" : agent?.status === "error" ? "未完成" : "已完成")}</span>` +
      `</div><div class="agent-overlay-chat">`;
    html += items.map((it) => `<div class="chat-item">${renderChatItem(it, thinkingPrefOpen())}</div>`).join("");
    html += "</div>";
    if (pending.length > 0) {
      html += `<div class="agent-overlay-approvals" role="region" aria-label="子代理审批">`;
      for (const a of pending) {
        html +=
          `<div class="approval-card" data-approval-id="${esc(a.approvalId || a.toolUseId)}" data-tool-name="${esc(a.name ?? "")}">` +
          `<div class="approval-card-header"><span class="approval-tool-name">${esc(describeApprovalAction(a.name, a.input))}</span></div>` +
          `<p class="approval-summary">${esc(describeApprovalAction(a.name, a.input))}</p>` +
          `<details class="approval-details"><summary>详情</summary>` +
          `<pre class="approval-input">${esc(typeof a.input === "string" ? a.input : JSON.stringify(a.input ?? {}, null, 2))}</pre>` +
          `<button type="button" class="btn btn--allow-always" data-action="allow-always">短期允许相同参数</button>` +
          `</details>` +
          `<div class="approval-actions">` +
          `<button type="button" class="btn btn--allow" data-action="allow">允许</button>` +
          `<button type="button" class="btn btn--deny" data-action="deny">拒绝</button>` +
          `<input class="deny-reason" placeholder="拒绝理由（可选）" />` +
          `</div></div>`;
      }
      html += "</div>";
    }
    host.innerHTML = html;
  }
  if (!host.__bound) {
    host.__bound = true;
    host.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest("[data-agent-back]")) {
        callbacks?.onCloseAgent?.();
      }
    });
    bindApprovalActions(host, callbacks);
  }
  host.__approvalCallbacks = callbacks;
}

/**
 * 就地更新流式条目。
 *
 * **必须继续走 Markdown**（`renderLiveText`），绝不能 `setText` 冲成纯文本——
 * 否则流式阶段是白板字、落定瞬间才排版，正是委托方说的"不像 Claude"。
 * 只改 `.chat-live-text` 的 innerHTML 与字数，不动外层 `<details>`，于是 open 态保住。
 *
 * @returns {boolean} 是否已就地更新完毕
 */
export function updateLiveNode(node, it) {
  const wantThinking = Boolean(String(it.thinking ?? "").trim()) || Boolean(it.waiting);
  const wantText = Boolean(String(it.text ?? "").trim());
  const thinkEl = node.querySelector("details.chat-thinking--live");
  const textEl = node.querySelector(".chat-msg--live");
  // 结构与需求不一致 = 有新块要出现，只能重建一次
  if (wantThinking !== Boolean(thinkEl) || wantText !== Boolean(textEl)) return false;

  if (thinkEl) {
    const body = thinkEl.querySelector(".chat-live-thinking");
    if (body) body.innerHTML = renderMarkdown(it.thinking);
  }
  if (textEl) {
    const body = textEl.querySelector(".chat-live-text");
    if (body) body.innerHTML = renderLiveText(it.text);
  }
  return true;
}

/** 一条对话条目的可变部分——只有它变了才重建那一条 */
function chatItemSig(it) {
  switch (it.kind) {
    case "live":
      return `live:text:${(it.text ?? "").length}:think:${(it.thinking ?? "").length}`;
    case "activity":
      return `activity:${it.name}:${it.peek ?? ""}`;
    case "notice":
      return `notice:${it.tone}:${it.text}:${it.peek ?? ""}:${it.live ? 1 : 0}`;
    case "tools":
      return `tools:${(it.tools ?? []).map((t) => `${t.toolUseId}:${t.status}:${t.gated ? 1 : 0}:${(t.result ?? "").length}`).join("|")}`;
    case "tool":
      return `tool:${it.status}:${it.gated ? 1 : 0}:${it.durationMs ?? ""}:${(it.result ?? "").length}`;
    case "verdict":
      return `verdict:${JSON.stringify(it.verdict)}`;
    case "artifacts":
      return `artifacts:${(it.files ?? []).map((f) => f.path).join("|")}`;
    case "blocked":
      return `blocked:${(it.conditions ?? []).join("|")}:${it.summary ?? ""}`;
    case "plan":
      return `plan:${it.folded ? 1 : 0}:${(it.plan?.nodes ?? []).map((n) => `${n.id}:${n.status}`).join("|")}`;
    case "agents":
      return `agents:${it.folded ? 1 : 0}:${(it.agents ?? []).map((a) => `${a.id}:${a.status}:${a.pendingApprovals}:${(a.lastText ?? "").length}:${a.peek ?? ""}`).join("|")}`;
    case "text":
      return `text:${(it.text ?? "").length}:${it.at ?? ""}:${it.showActions ? 1 : 0}:${readChatRating(it.runId, it.seq)}:${(it.verification ?? []).length}:${(it.assumptions ?? []).length}`;
    default:
      return `${it.kind}:${(it.text ?? "").length}:${it.at ?? ""}:${it.showActions ? 1 : 0}:${it.kind === "text" ? readChatRating(it.runId, it.seq) : ""}`;
  }
}

/**
 * "思考过程展开与否"是**用户的偏好**，不是每条消息各自的状态。
 *
 * 委托方的原话是"点开的时候就永远显示流式的思考过程，再点一次关闭就不看"——
 * 也就是说这个开关一次设定、后续每一轮都照办。逐条记的话，每来一轮新思考
 * 又是收起的，等于每轮都要再点一次。存进 localStorage，跨会话也保持。
 */
const THINKING_PREF_KEY = "agent-ui-thinking-open";
/** 主对话是否展开工具/段分界。默认关：过程进直播条与详情，终局像总结。 */
const CHAT_PROCESS_PREF_KEY = "agent-ui-chat-show-process";

function thinkingPrefOpen() {
  try {
    return localStorage.getItem(THINKING_PREF_KEY) === "1";
  } catch {
    return false; // 隐私模式下读不到就按收起处理，不影响主流程
  }
}

const CHAT_PROCESS_MODES = ["off", "auto", "on"];

/** @returns {"off"|"auto"|"on"} */
export function chatProcessPref() {
  try {
    const raw = localStorage.getItem(CHAT_PROCESS_PREF_KEY);
    if (raw === "1" || raw === "on") return "on";
    if (raw === "0" || raw === "off") return "off";
    if (raw === "auto") return "auto";
    return "auto";
  } catch {
    return "auto";
  }
}

/** @param {"off"|"auto"|"on"} mode */
export function setChatProcessPref(mode) {
  const next = CHAT_PROCESS_MODES.includes(mode) ? mode : "auto";
  try {
    localStorage.setItem(CHAT_PROCESS_PREF_KEY, next);
  } catch {
    /* ignore */
  }
}

/** 旧布尔口径：只有「全部」为 true。未设偏好时默认自动，因此这里是 false。 */
export function chatShowProcessPref() {
  return chatProcessPref() === "on";
}

/** @param {boolean} on */
export function setChatShowProcessPref(on) {
  setChatProcessPref(on ? "on" : "off");
}

/**
 * @param {{showProcess?: boolean|"off"|"auto"|"on"}} [opts]
 * @returns {"off"|"auto"|"on"}
 */
export function resolveChatProcessMode(opts = {}) {
  const raw = opts.showProcess;
  if (raw === true || raw === "on") return "on";
  if (raw === false || raw === "off") return "off";
  if (raw === "auto") return "auto";
  return chatProcessPref();
}

/** @param {"off"|"auto"|"on"} mode */
export function chatProcessHint(mode) {
  if (mode === "on") return "每一次工具调用都留下；完整过程也在下方「运行详情」";
  if (mode === "off") return "只看问答；运行中一条「正在…」。完整过程在下方「运行详情」";
  return "进行中和出错的才进对话；放行过的成功调用不占位置";
}

function toolVisibleInProcessMode(mode, item) {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return item.status === "running" || item.status === "error";
}

/**
 * 对话顶栏：工具过程 隐藏 / 自动 / 全部。条在 conversation 外，避免 patchList / empty innerHTML 冲掉。
 */
function bindChatProcessToggle(root, onChange) {
  const layout = root?.closest?.(".detail-layout") ?? root?.parentElement;
  const host = layout?.querySelector?.(".chat-process-bar") ?? null;
  if (!host) return;
  // 骨架只建一次，事件流后到。回调必须每次换成「当前 state」，
  // 否则切档会拿第一次渲染的空对话把正文冲掉。
  host.__processOnChange = onChange;
  if (host.__processToggleBound) return;
  host.__processToggleBound = true;
  const radios = host.querySelectorAll('input[name="chat-process"]');
  if (!radios.length) return;
  const hint = host.querySelector("#chat-process-hint");
  const apply = (mode) => {
    for (const radio of radios) radio.checked = radio.value === mode;
    if (hint) hint.textContent = chatProcessHint(mode);
  };
  apply(chatProcessPref());
  host.addEventListener("change", (e) => {
    const target = e.target;
    if (!target || target.name !== "chat-process") return;
    setChatProcessPref(target.value);
    apply(target.value);
    host.__processOnChange?.();
  });
}

/**
 * 展开/收起思考块时记住偏好。
 * 用**事件委托**绑在对话容器上（`toggle` 事件不冒泡，所以监听 summary 的 click），
 * 这样键控补丁重建条目时不会漏绑、也不会重复绑。
 */
function bindThinkingPref(host) {
  if (!host || host.__thinkingBound) return;
  host.__thinkingBound = true;
  host.addEventListener("click", (e) => {
    const summary = e.target instanceof Element ? e.target.closest("summary") : null;
    const details = summary && summary.parentElement;
    if (!details || !details.classList.contains("chat-thinking")) return;
    // click 先于浏览器切换 open，所以这里取反才是切换后的值
    try {
      localStorage.setItem(THINKING_PREF_KEY, details.open ? "0" : "1");
    } catch {
      // 写不进去也不影响本次展开，静默
    }
  });
}

/**
 * 右栏：常驻 Progress（清单 + 可选编排子任务）+ 产物文件。
 */
function patchDetailRail(parts, state, faces, callbacks) {
  if (!parts.rail) return;
  const plan = faces.plan;
  const progress = faces.progress;
  const files = Array.isArray(callbacks.previewFiles) && callbacks.previewFiles.length
    ? callbacks.previewFiles
    : Array.isArray(callbacks.threadFiles) && callbacks.threadFiles.length
      ? callbacks.threadFiles
      : deriveSessionFiles(state);
  const showFiles = files.length > 0;
  // 右栏只在有内容时占位：编排子任务、产物文件、或执行者拆步清单。
  // 三者皆空时整条收起——空着一条「等待拆步…」的侧栏是在占位说谎。
  const hasProgress = Boolean(progress && Array.isArray(progress.items) && progress.items.length > 0);
  const showRail = Boolean(plan) || showFiles || hasProgress;
  setAttr(parts.rail, "hidden", showRail ? null : "");
  if (!showRail) return;
  const toggle = parts.root?.querySelector("#rail-toggle");
  if (toggle && !parts.rail.classList.contains("detail-rail--collapsed")) {
    toggle.textContent = "Progress ⟩";
  }
  patchProgressPanel(parts, progress, { hasSessionFiles: showFiles });
  // 编排细节：对话里已有分层卡；右栏 plan-board 作 Progress 下钻（层号 / 耗时条）
  if (plan) patchPlanBoard(parts, parts.railBoard, plan);
  else {
    setAttr(parts.railBoard, "hidden", "");
    if (parts.railBoard) parts.railBoard.innerHTML = "";
    parts.sig.plan = null;
  }
  patchArtifacts(parts, showFiles ? files : [], state.runId, callbacks);
}

/** Progress 卡：Cursor 风格勾选清单 + 编排子任务摘要 */
function patchProgressPanel(parts, progress, extras) {
  const host = parts.progressPanel;
  if (!host || !progress) return;
  const hasFiles = Boolean(extras?.hasSessionFiles || progress.hasSessionFiles);
  const showWaiting = Boolean(progress.waiting && !progress.plan && !hasFiles);
  const hasItems = Boolean(progress.items && progress.items.length > 0);
  const hasPlan = Boolean(progress.plan);
  const planSig = progress.plan
    ? progress.plan.nodes.map((n) => `${n.id}:${n.status}`).join(",")
    : "";
  const itemSig = progress.items
    ? progress.items.map((i) => `${i.id}:${i.status}`).join(",")
    : "null";
  const sig = signature([
    itemSig,
    planSig,
    showWaiting ? "waiting" : "",
    progress.settled ? "settled" : "",
    hasFiles ? "files" : "",
  ]);
  if (parts.sig.progress === sig) return;
  parts.sig.progress = sig;

  if (!showWaiting && !hasItems && !hasPlan) {
    host.innerHTML = "";
    setAttr(host, "hidden", "");
    return;
  }
  setAttr(host, "hidden", null);

  let html =
    '<details class="progress-card" open>' +
    '<summary class="progress-card-summary">Progress</summary>';

  if (showWaiting) {
    html += '<p class="progress-waiting">等待拆步…</p>';
  }

  if (progress.items && progress.items.length > 0) {
    html += '<ul class="progress-list" role="list">';
    for (const it of progress.items) {
      const done = it.status === "done";
      const running = !progress.settled && it.status === "running";
      const skipped = it.status === "skipped";
      const cls =
        "progress-item" +
        (done ? " progress-item--done" : "") +
        (running ? " progress-item--running" : "") +
        (skipped ? " progress-item--skipped" : "");
      const mark = done ? "✓" : running ? "●" : skipped ? "–" : "○";
      html +=
        `<li class="${cls}">` +
        `<span class="progress-mark" aria-hidden="true">${mark}</span>` +
        `<span class="progress-title${running ? " thinking-shimmer" : ""}">${esc(it.title)}</span>` +
        "</li>";
    }
    html += "</ul>";
  }

  if (progress.plan) {
    const p = progress.plan;
    html += '<div class="progress-plan">';
    html += `<p class="progress-plan-meta">编排 · 并行度 ${p.concurrency}` +
      `${p.concurrencyMode === "auto" ? "（auto）" : ""} · ${p.nodes.length} 步</p>`;
    html += '<ul class="progress-list progress-list--plan" role="list">';
    for (const n of p.nodes) {
      const done = n.status === "passed";
      const failed = n.status === "failed";
      const running = !progress.settled && n.status === "running";
      const skipped = n.status === "skipped";
      const cls =
        "progress-item" +
        (done ? " progress-item--done" : "") +
        (failed ? " progress-item--failed" : "") +
        (running ? " progress-item--running" : "") +
        (skipped ? " progress-item--skipped" : "");
      const mark = done ? "✓" : failed ? "✗" : running ? "●" : skipped ? "–" : "○";
      html +=
        `<li class="${cls}">` +
        `<span class="progress-mark" aria-hidden="true">${mark}</span>` +
        `<span class="progress-title${running ? " thinking-shimmer" : ""}">${esc(n.title || n.id)}</span>` +
        "</li>";
    }
    html += "</ul></div>";
  }

  html += "</details>";
  host.innerHTML = html;
}

/**
 * 产物清单。
 *
 * 「预览」走页内坞（stayInPageForPreviewClick），不 `window.location` 到 `file://`。
 * 「下载」走宿主的 `/api/runs/:id/artifact`——浏览器一律拦截
 * http 页面跳 `file://`，所以本地文件必须由宿主取给它。
 * 「在文件夹中显示」是**从网页请求启动本机进程**，圈禁在服务端（同一套
 * resolveInWorkdir），这里只负责把路径原样交上去。
 */
function patchArtifacts(parts, files, runId, callbacks) {
  const host = parts.artifacts;
  if (!host) return;
  setAttr(host, "hidden", files.length > 0 ? null : "");
  const sig = signature(files.map((f) => `${f.path}:${f.writes}`));
  if (parts.sig.artifacts === sig) return;
  parts.sig.artifacts = sig;

  const groups = FILE_GROUPS
    .map((g) => ({ ...g, files: files.filter((f) => classifySessionFile(f.path) === g.id) }))
    .filter((g) => g.files.length > 0);
  const renderFile = (f) => {
    const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(f.path)}`;
    const kind = f.kind === "upload" ? "附件" : "产物";
    const times = (f.writes ?? 0) > 1 ? `改 ${f.writes} 次` : kind;
    const image = isImagePath(f.path);
    const thumb = image
      ? `<a class="artifact-thumb-link" href="${esc(href)}" data-canvas-open="${esc(f.path)}" title="${esc(f.path)}">` +
        `<img class="artifact-thumb" src="${esc(href)}" alt="${esc(fileBasename(f.path))}" loading="lazy" /></a>`
      : "";
    return (
      `<div class="artifact${image ? " artifact--image" : ""}" data-artifact-path="${esc(f.path)}">` +
      thumb +
      '<div class="artifact-body">' +
      `<a class="artifact-name" href="${esc(href)}" data-canvas-open="${esc(f.path)}" title="${esc(f.path)}">${esc(fileShortPath(f.path))}</a>` +
      `<div class="artifact-actions">` +
      `<span class="aside-peek">${esc(times)}</span>` +
      `<button type="button" class="artifact-btn" data-canvas-open="${esc(f.path)}">预览</button>` +
      `<a class="artifact-btn" href="${esc(href)}&download=1">下载</a>` +
      `<button type="button" class="artifact-btn" data-reveal="${esc(f.path)}">在文件夹中显示</button>` +
      "</div></div></div>"
    );
  };
  host.innerHTML = groups
    .map((g) => (
      `<details class="rail-section" open>` +
      `<summary class="rail-section-title"><i class="ph ${g.icon}" aria-hidden="true"></i> ${esc(g.label)} <span class="aside-peek">${g.files.length}</span></summary>` +
      g.files.map(renderFile).join("") +
      "</details>"
    ))
    .join("");

  // 事件委托：清单每次重画，逐个绑会漏也会重
  if (!host.__revealBound) {
    host.__revealBound = true;
    host.addEventListener("click", (e) => {
      if (stayInPageForPreviewClick(e, callbacks.onOpenCanvas ?? callbacks.onPreviewPath)) return;
      const btn = e.target instanceof Element ? e.target.closest("[data-reveal]") : null;
      if (btn) callbacks.onReveal?.(btn.getAttribute("data-reveal"));
    });
  }
  // 右栏产物卡同样做 stat 验证——声明了但没落盘的，从清单拿掉
  void hydrateArtifactCards(host, { runId, files }, callbacks);
}

function patchOutcomeCard(parts, state, overview, faces, callbacks = {}) {
  const v = faces.verification;
  const loop = faces.loop;
  const summary = overview.resultSummary;
  const sig = signature([
    state.status, state.stopReason, state.error, v.badge,
    v.verdict ? JSON.stringify(v.verdict) : "", loop.reworks, summary,
  ]);
  if (parts.sig.outcome === sig) return;
  parts.sig.outcome = sig;

  /**
   * **对话成为主干之后，这张卡里三样东西变成了重复展示**（V-16 的老问题换了个现场）：
   *   · 「执行者报告」= 最后一条 assistant 文本 = 对话里的最后一条消息；
   *   · 裁决徽章 / summary / issues = 对话末尾那张 `.chat-verdict`；
   *   · 「运行中，尚无最终结果。」——运行中本来就在对话里逐条长出来，这句纯噪声。
   * 委托方直接指了第三样：「这个框框可以不用了」。
   *
   * 于是收缩成**一条收尾条**，只保留对话里没有的那件事：**这次是怎么结束的**
   * （六值终止原因 + 它的补救提示 + 错误原文 + 返工轮数）。运行中整条隐藏。
   */
  if (state.status === "running") {
    setAttr(parts.outcome, "hidden", "");
    parts.outcome.className = "outcome-card";
    parts.outcome.innerHTML = "";
    return;
  }
  setAttr(parts.outcome, "hidden", null);

  const cls = deliveryFace(state.stopReason, deriveArtifacts(state));
  const rework = loop.reworks > 0
    ? `<span class="outcome-note">返工 ${loop.reworks} 轮后${v.verdict && v.verdict.passed ? "通过" : "仍未过"}</span>`
    : "";

  /**
   * **正常收尾什么都不显示。**（委托方："这个可以不用了……过于占空间了"）
   *
   * 一条横贯整屏、只写着「■ 已完成」的条，说的是读对话就能知道的事——
   * 对话到此为止本身就是"完成了"。占一整行去讲一句废话，是在跟真正有话说的
   * 那几种收尾抢版面。
   *
   * 反过来，**非正常收尾必须留着**：撞轮数上限、撞 token、出错、被否决——
   * 这几种对话里看不出来（对话只是"停了"），而且各有各的下一步。
   * 返工过的也留：那是"通过之前失败过几次"，不说就丢了。
   * 判据一句话：**只在有话要说的时候占位。**
   */
  const quiet = cls.tone === "ok" && !cls.hint && !state.error && loop.reworks === 0;
  if (quiet) {
    setAttr(parts.outcome, "hidden", "");
    parts.outcome.className = "outcome-card";
    parts.outcome.innerHTML = "";
    return;
  }

  const reason = state.error || cls.hint || "";
  parts.outcome.className = `outcome-card outcome-card--slim outcome-card--${cls.tone}`;
  parts.outcome.innerHTML =
    `<div class="outcome-line outcome-line--${cls.tone}">${esc(cls.label)}${
      reason ? ` · ${esc(reason)}` : ""
    }${rework}</div>` +
    `<button type="button" class="outcome-continue" data-outcome-continue aria-label="继续对话" title="继续对话">` +
    `<i class="ph ph-arrow-right" aria-hidden="true"></i></button>`;
  const btn = parts.outcome.querySelector("[data-outcome-continue]");
  if (btn && !btn.__bound) {
    btn.__bound = true;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      callbacks.onContinue?.();
    });
  }
}

function verdictBadgeLabel(badge) {
  return {
    pass: "✔ 核查通过",
    pass_with_notes: "✔ 通过（有备注）",
    fail: "✘ 核查未通过",
    pending: "⋯ 尚未核查",
  }[badge] ?? "⋯ 尚未核查";
}

/**
 * 四决定因素网格 (V-17)。
 *
 * 异常面自动加权并排到首位——用户第一眼该看到的是"哪一面出了问题"，
 * 而不是四张长得一样的卡片。
 */
function patchFactorGrid(parts, faces, activeTab, callbacks) {
  const cards = buildFactorCards(faces);
  const sig = signature([
    JSON.stringify(cards.map((c) => [c.id, c.abnormal, c.lines.join("~")])),
    activeTab,
  ]);
  if (parts.sig.factors === sig) return;
  parts.sig.factors = sig;

  patchList(parts.factorGrid, cards, {
    key: (c) => c.id,
    create: (c) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "factor-card";
      el.id = `tab-${c.id}`;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-controls", "tab-content");
      el.setAttribute("data-factor", c.id);
      el.setAttribute("data-tab", c.id);
      el.innerHTML =
        '<span class="factor-title"></span><span class="factor-lines"></span>';
      el.addEventListener("click", () => switchToFace(c.id));
      // roving tabindex 下 Tab 只进当前项，组内移动靠方向键——没有这段，
      // 未选中的面就彻底不可键盘到达（比不做 roving 更糟）
      el.addEventListener("keydown", (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        const all = [...parts.factorGrid.querySelectorAll('[role="tab"]')];
        const idx = all.indexOf(el);
        let next = -1;
        if (key === "ArrowRight" || key === "ArrowDown") next = (idx + 1) % all.length;
        else if (key === "ArrowLeft" || key === "ArrowUp") next = (idx - 1 + all.length) % all.length;
        else if (key === "Home") next = 0;
        else if (key === "End") next = all.length - 1;
        if (next < 0) return;
        e.preventDefault();
        switchToFace(all[next].getAttribute("data-tab"));
      });
      updateFactorCard(el, c, activeTab);
      return el;
    },
    update: (el, c) => updateFactorCard(el, c, activeTab),
  });

  setAttr(parts.tabContent, "aria-labelledby", `tab-${activeTab}`);
}

function switchToFace(tab) {
  if (tab) document.dispatchEvent(new CustomEvent("tab-switch", { detail: { tab } }));
}

function updateFactorCard(el, c, activeTab) {
  const isActive = c.id === activeTab;
  setClass(el, "factor-card--abnormal", c.abnormal);
  setClass(el, "factor-card--active", isActive);
  setAttr(el, "aria-selected", String(isActive));
  setAttr(el, "tabindex", isActive ? "0" : "-1");
  setText(el.querySelector(".factor-title"), c.title);
  // 名称里带上"当前查看"，屏幕阅读器才知道这一张既是摘要也是当前选中的面
  setAttr(el, "aria-label", `${c.title}：${c.lines.join("，")}${isActive ? "。当前查看" : "。查看详情"}`);
  el.querySelector(".factor-lines").innerHTML = c.lines
    .map((l) => `<span class="factor-line">${esc(l)}</span>`)
    .join("");
}

/** 四张卡的内容与异常判定，纯函数——可直测 */
export function buildFactorCards(faces) {
  const { loop, context, tools, verification: v } = faces;

  const loopLines = [];
  loopLines.push(loop.maxTurns ? `${loop.turn}/${loop.maxTurns} 轮` : `${loop.turn} 轮`);
  if (loop.stopReason) loopLines.push(`■ ${loop.stopReason.label}`);
  if (loop.reworks > 0) loopLines.push(`↺ 返工 ${loop.reworks} 轮`);
  if (loop.retries.length > 0) loopLines.push(`⟳ 重试 ${loop.retries.length} 次已自愈`);
  if (loop.effort) loopLines.push(`思考强度 ${loop.effort}${loop.effortApplies ? "" : "（compat 下不发送）"}`);
  // 恢复策略与它的触发记录并排：配了几轮续跑、这次到底触发了几次
  const recoveryLine = describeRecoveryPolicy(loop.recovery);
  if (recoveryLine) loopLines.push(recoveryLine);
  if ((loop.recoveryDecisions?.length ?? 0) > 0) {
    const stalling = (loop.recoveryDecisions ?? []).some(
      (e) => e.reason === "end_turn_without_completion" || e.reason === "stagnation",
    );
    loopLines.push(stalling ? "⚠ 空转 · 可停止" : `⤷ 恢复决策 ${loop.recoveryDecisions.length} 次`);
  }
  if (loop.hooks) {
    const fired = loop.hookEvents?.length ?? 0;
    const blocked = (loop.hookEvents ?? []).filter((e) => e.outcome === "block").length;
    const errors = (loop.hookEvents ?? []).filter((e) => e.outcome === "error").length;
    loopLines.push(
      `hooks：${fired} 次` +
        (blocked ? ` · 阻断 ${blocked}` : "") +
        (errors ? ` · 错误 ${errors}` : ""),
    );
  }

  const ctxLines = [];
  if (context.limit) {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)} / ${formatTokens(context.limit)}`);
  } else {
    ctxLines.push(`本轮输入 ${formatTokens(context.lastInputTokens)}`);
  }
  ctxLines.push(`缓存命中 ${(context.cacheHitRatio * 100).toFixed(0)}%`);
  if (context.compactions.length > 0) {
    ctxLines.push(
      `⚠ 压缩 ${context.compactions.length} 次 · 置换 ${context.droppedBlocks} 块原文` +
        ((context.collapsedTurns ?? 0) > 0 ? ` · 折叠 ${context.collapsedTurns} 轮旧对话` : "") +
        ((context.reactiveCount ?? 0) > 0 ? ` · 撞 400 后反应式 ${context.reactiveCount} 次` : "") +
        ` · 账本 ${context.ledgerEntries ?? 0} 条` +
        ((context.summaryAppliedCount ?? 0) > 0
          ? ` · LLM 摘要 ${context.summaryAppliedCount} 次`
          : ""),
    );
  }
  if (context.agentMd) {
    ctxLines.push(
      `AGENT.md ${context.agentMd.files.length} 个文件 · ${context.agentMd.chars}/${context.agentMd.maxChars}` +
        (context.agentMd.truncated ? " · 已截断" : "") +
        " · 指导不是执行",
    );
  }

  const toolLines = [];
  toolLines.push(tools.pack?.name ? `包 ${tools.pack.name}` : "无领域包");
  toolLines.push(`${tools.tools.length} 个工具 · 调用 ${tools.totalCalls} 次`);
  if (tools.totalErrors > 0) toolLines.push(`✗ 失败 ${tools.totalErrors} 次`);
  if (tools.denials.length > 0) toolLines.push(`⊘ 被拒 ${tools.denials.length} 次`);
  if (tools.writeRoots?.length > 0) toolLines.push(`可写根 ${tools.writeRoots.length} 个`);
  {
    const writeSet = new Set(tools.writeRoots ?? []);
    const readonlyOnly = (tools.readRoots ?? []).filter((root) => !writeSet.has(root));
    if (readonlyOnly.length > 0) toolLines.push(`只读根 ${readonlyOnly.length} 个`);
  }
  if (tools.executionIsolation) {
    const state = tools.executionIsolation.effectiveState;
    toolLines.push(
      state === "partial"
        ? "隔离：部分（仅 bash）"
        : state === "report-only"
          ? "⚠ 隔离：仅报告，宿主直跑"
          : state === "direct"
            ? "⚠ 隔离：关闭，宿主直跑"
            : "✗ 隔离：required 不可用",
    );
  }

  const vLines = [verdictBadgeLabel(v.badge)];
  if (v.verdict) {
    const bits = [];
    if (v.verdict.unverified.length) bits.push(`⋯ ${v.verdict.unverified.length}`);
    if (v.verdict.advisory.length) bits.push(`◈ ${v.verdict.advisory.length}`);
    if (bits.length) vLines.push(bits.join(" · "));
  }
  if (v.starvation.noWhitelist) vLines.push("⚠ verifier 无白名单（核查饥饿）");
  if (v.starvation.emptyRework.length > 0) vLines.push("⚠ 返工零写入（疑似核查饥饿）");
  if (v.starvation.parseFail) vLines.push("⚠ 裁决解析失败（fail-closed 误伤）");

  const cards = [
    {
      id: "loop", title: "Loop 循环", lines: loopLines,
      abnormal: Boolean(loop.stopReason && loop.stopReason.tone !== "ok") || loop.nearLimit
        || (loop.recoveryDecisions ?? []).some(
          (e) => e.reason === "end_turn_without_completion" || e.reason === "stagnation",
        ),
    },
    {
      id: "context", title: "Context 上下文", lines: ctxLines,
      abnormal: context.compactions.length > 0 || context.nearWatermark,
    },
    {
      id: "tools", title: "Tools 工具", lines: toolLines,
      abnormal:
        tools.totalErrors > 0 || tools.denials.length > 0 ||
        ["direct", "report-only", "failed"].includes(tools.executionIsolation?.effectiveState),
    },
    {
      id: "verify", title: "Verification 核查", lines: vLines,
      abnormal:
        v.badge === "fail" || v.badge === "pass_with_notes" ||
        (v.verdict?.unverified.length ?? 0) > 0 ||
        v.starvation.noWhitelist || v.starvation.parseFail ||
        v.starvation.emptyRework.length > 0,
    },
  ];

  // 异常面排到首位（稳定排序：同为异常/正常者保持声明顺序）
  return [...cards.filter((c) => c.abnormal), ...cards.filter((c) => !c.abnormal)];
}

// patchTabNav 已移除：四张因子卡直接充当 tablist（见 patchFactorGrid）。
// 此前卡片下面另起一行同名标签，两排四个一模一样的词，是纯粹的重复导航；
// 更要命的是两者的成员还不一致——卡片恒为四张，而标签栏在没有核查记录时
// 只渲染三个，于是点第四张卡会切到一个根本不存在的标签，tabpanel 的
// aria-labelledby 随之指向空引用（悬空引用，屏幕阅读器报不出面板名）。

function patchTabContent(parts, state, activeTab, overview, logEntries, callbacks, faces) {
  const container = parts.tabContent;

  // 换标签页时内容形态完全不同，直接重建；同一标签内走各自的增量策略
  if (container.__tab !== activeTab) {
    container.innerHTML = "";
    container.__patchNodes = undefined;
    container.__tab = activeTab;
    parts.sig.tabBody = null;
    // 对话视图的签名也要一起作废。漏掉它的后果是：切走再切回 Loop 面时
    // 对话主干在抽屉之外、不随标签重建；这里保留清签名是防御性的
    parts.sig.chat = null;
    if (activeTab === "loop") {
      /**
       * V-23 原本在这里放"事件流 / 对话"两种读法的切换。
       * **对话已经升为主干**（在抽屉外、常驻、实时），这里只剩事件流——
       * 同一件事有两个入口，用户就得先决定"该看哪个"，那正是委托方说的难用。
       * 事件流留在这里的定位随之收窄：逐工具、逐结果的**取证视图**。
       */
      container.innerHTML =
        // 计划盘已搬到右栏（子任务是"谁在做什么"，属于进度不属于取证）
        '<h3 class="overview-section-title">执行事件流</h3>' +
        '<div class="rework-chain"></div>' +
        '<div class="log-entries"></div>';
      container.__logHost = container.querySelector(".log-entries");
    }
  }

  if (activeTab === "loop") {
    patchReworkChain(container.querySelector(".rework-chain"), faces.loop);
    patchLoopView(parts, container, state, logEntries, callbacks);
    return;
  }

  // context / tools / verify：无输入控件、无滚动锚点，签名变了整体重绘即可
  const sig =
    activeTab === "context"
      ? signature([
          faces.context.lastInputTokens, faces.context.limit,
          faces.context.compactions.length, faces.context.droppedBlocks,
          faces.context.ledgerEntries ?? 0, faces.context.perTurn.length,
          faces.context.collapsedTurns ?? 0, faces.context.reactiveCount ?? 0,
        ])
      : activeTab === "tools"
        ? signature([
            faces.tools.totalCalls, faces.tools.totalErrors,
            faces.tools.tools.length, faces.tools.denials.length,
            faces.tools.reroutes.length, faces.tools.pack?.name ?? "",
            faces.tools.projectId ?? "", faces.tools.campaignId ?? "", faces.tools.workdir ?? "",
          ])
        : signature([
            state.verifierTimeline.length,
            state.verdict ? JSON.stringify(state.verdict) : "",
            faces.verification.rounds.length,
            JSON.stringify(faces.verification.starvation),
          ]);
  if (parts.sig.tabBody === sig) return;
  parts.sig.tabBody = sig;

  container.innerHTML =
    activeTab === "context"
      ? renderContextTab(faces.context)
      : activeTab === "tools"
        ? renderToolsTab(faces.tools)
        : renderVerifyTab(state, faces.verification);
}

/** 返工裁决序列：main ─■─▶ verifier ✘ ─↺─▶ rework ─■─▶ verifier ✔ */
function patchReworkChain(host, loop) {
  if (!host) return;
  if (loop.chain.length <= 1) {
    host.innerHTML = "";
    setAttr(host, "hidden", "");
    return;
  }
  setAttr(host, "hidden", null);
  const roleLabel = { main: "主轮", rework: "返工", verifier: "核查" };
  host.innerHTML = foldChain(loop.chain)
    .map((c) => {
      const mark = c.role === "verifier" ? (c.passed === null ? "⋯" : c.passed ? "✔" : "✘") : "■";
      const tone = c.role === "verifier" ? (c.passed === null ? "pending" : c.passed ? "ok" : "bad") : "neutral";
      const label = c.role === "rework" ? `↺ ${roleLabel[c.role]}` : roleLabel[c.role];
      const round = c.role === "main" ? "" : ` ${c.round}`;
      const times = c.count > 1 ? ` ×${c.count}` : "";
      return `<span class="chain-node chain-node--${tone}">${mark} ${esc(label)}${round}${times}</span>`;
    })
    .join('<span class="chain-arrow">▸</span>');
}

/**
 * 连续的主轮折叠成一个带计数的节点。
 *
 * 这条链要表达的是"执行 → 核查 → 返工"的**交替结构**。多轮对话下会出现
 * 二十几个连着的 main 段，逐个画出来就是一排一模一样的「■ 主轮」——
 * 委托方截图里那一行占满整屏却零信息量。计数版既保住了结构，也说清了有多少轮。
 *
 * 只折叠 main：核查与返工每一次都是独立事件，合并会把"返工了三次"抹平成一个。
 */
export function foldChain(chain) {
  const out = [];
  for (const c of chain ?? []) {
    const last = out[out.length - 1];
    if (last && last.role === c.role && c.role === "main") last.count += 1;
    else out.push({ ...c, count: 1 });
  }
  return out;
}

/** Tools 面 MCP 行：已连 / 跳过 / 失败都照实说，不把「没 token」写成「未连接」。 */
export function formatMcpServersLine(mcp) {
  if (!mcp) return "";
  const servers = mcp.servers ?? [];
  if (!servers.length) return mcp.configured ? "已配置但未连接" : "未配置";
  return servers.map((s) => {
    const count = s.toolCount != null ? `，${s.toolCount} 工具` : s.tools != null ? `，${s.tools} 工具` : "";
    const why = s.reason ? `：${s.reason}` : "";
    return `${s.name}（${s.status ?? "unknown"}${count}${why}）`;
  }).join("；");
}

/** 窗口来源的人话（数字必须带来源，否则无从判断"这是不是我要的那个值"） */
export function contextSourceLabel(source) {
  switch (source) {
    case "env": return "env";
    case "learned": return "撞 400 学到";
    case "registry": return "登记表";
    case "run": return "本次指定";
    case "pack": return "领域包";
    case "window": return "跟窗口";
    case "default": return "默认";
    default: return "未知";
  }
}

/**
 * 三段上下文水位条（MEM-01 窗口 / 预算分离）：已用 / 预算 / 窗口。
 *
 * 总长 = 窗口（已知）或预算（未知，此时**没有窗口段**——画一段"未知"等于编一个数）。
 * 预算段内画压缩水位刻度；已用段越过刻度即"下一轮将压缩"。三段的比例由 deriveContextFace 算好。
 * 纯字符串渲染，jsdom 与 node 都能断言。
 */
export function renderContextStrip(ctx) {
  const s = ctx.strip;
  if (!s || !ctx.limit) return "";
  const pctOf = (x) => `${Math.round((x ?? 0) * 1000) / 10}%`;
  const usedPct = Math.round((ctx.ratio ?? 0) * 100);
  const windowText = ctx.window
    ? `窗口 ${formatTokens(ctx.window)}（${contextSourceLabel(ctx.windowSource)}）`
    : "窗口未知";
  const budgetText = `预算 ${formatTokens(ctx.limit)}（${contextSourceLabel(ctx.budgetSource)}${ctx.clamped ? `，由 ${formatTokens(ctx.requestedBudget)} 夹紧` : ""}）`;
  const label = `上下文：已用 ${formatTokens(ctx.lastInputTokens)}（预算的 ${usedPct}%）· ${budgetText} · ${windowText}`;
  let html = `<div class="ctx-strip${ctx.window ? "" : " ctx-strip--no-window"}${ctx.compactNextTurn ? " ctx-strip--compact-next" : ""}" role="img" aria-label="${esc(label)}">`;
  if (ctx.window) html += '<div class="ctx-strip-seg ctx-strip-seg--window" style="width:100%"></div>';
  html += `<div class="ctx-strip-seg ctx-strip-seg--budget" style="width:${pctOf(s.budget)}"></div>`;
  html += `<div class="ctx-strip-seg ctx-strip-seg--used" style="width:${pctOf(s.used)}"></div>`;
  if (s.threshold !== null) html += `<div class="ctx-strip-threshold" style="left:${pctOf(s.threshold)}"></div>`;
  html += "</div>";
  html += '<ul class="ctx-strip-legend">';
  html += `<li class="ctx-strip-legend-item ctx-strip-legend-item--used">已用 ${formatTokens(ctx.lastInputTokens)}<span class="ctx-strip-legend-sub">最近一轮输入</span></li>`;
  html += `<li class="ctx-strip-legend-item ctx-strip-legend-item--budget">${esc(budgetText)}<span class="ctx-strip-legend-sub">压缩水位 ${Math.round(ctx.watermark * 100)}%</span></li>`;
  html += `<li class="ctx-strip-legend-item ctx-strip-legend-item--window">${esc(windowText)}${ctx.window && ctx.windowRatio !== null ? `<span class="ctx-strip-legend-sub">已用占窗口 ${Math.round(ctx.windowRatio * 100)}%</span>` : ""}</li>`;
  html += "</ul>";
  return html;
}

/** Context 面下钻：逐轮 token 与压缩点 */
function renderContextTab(ctx) {
  let html = '<h3 class="overview-section-title">上下文水位</h3>';

  if (ctx.limit) {
    const pct = Math.round((ctx.ratio ?? 0) * 100);
    html += renderContextStrip(ctx);
    // 档位提示：越过水位就直说"下一轮将压缩"——compaction 判据取的正是这一轮的读数
    if (ctx.compactNextTurn) {
      html += `<p class="meter-hint meter-hint--warn" role="status">下一轮将压缩：最近一轮输入已达预算的 ${pct}%（水位 ${Math.round(ctx.watermark * 100)}%）。压缩不可逆——被置换的 tool_result 只剩首行摘录。</p>`;
    }
    if (ctx.clamped && ctx.clampWarning) {
      html += `<p class="meter-hint meter-hint--clamped">${esc(ctx.clampWarning)}</p>`;
    }
    html += `<p class="meter-note">最近一轮输入 ${formatTokens(ctx.lastInputTokens)} / 预算 ${formatTokens(ctx.limit)}（${pct}%），超过 ${Math.round(ctx.watermark * 100)}% 触发压缩。<strong>口径是最近一轮，不是全程累计</strong>——压缩判据取的就是单轮输入。` +
      (ctx.window
        ? `压缩水位跟窗口走：窗口 ${formatTokens(ctx.window)} 来自${contextSourceLabel(ctx.windowSource)}${ctx.maxBudget ? `，可用上限 ${formatTokens(ctx.maxBudget)}（窗口 − maxTokens ${formatTokens(ctx.maxTokens ?? 0)} − 边际）` : ""}。显式覆盖才会提前压缩。`
        : "窗口未知：登记表里没有这个模型、也还没撞过 400；撞到一次端点会说出窗口，下一次运行就按它算上限。") +
      "</p>";
  } else {
    html += `<p class="meter-note">最近一轮输入 ${formatTokens(ctx.lastInputTokens)}（未配置上限，无法给出水位）。</p>`;
  }

  html += '<h3 class="overview-section-title">Token 三分（全程累计）</h3>';
  const c = ctx.cumulative;
  const total = c.input + c.cacheCreation + c.cacheRead;
  if (total > 0) {
    const seg = (n, cls, label) =>
      n > 0 ? `<span class="token-seg token-seg--${cls}" style="flex:${n}" title="${label} ${formatTokens(n)}"></span>` : "";
    html += '<div class="token-bar">';
    html += seg(c.input, "uncached", "未缓存输入");
    html += seg(c.cacheCreation, "cache-write", "缓存写入");
    html += seg(c.cacheRead, "cache-read", "缓存读取");
    html += "</div>";
    html += '<ul class="token-legend">';
    html += `<li><span class="token-dot token-dot--uncached"></span>未缓存 ${formatTokens(c.input)}</li>`;
    html += `<li><span class="token-dot token-dot--cache-write"></span>缓存写入 ${formatTokens(c.cacheCreation)}</li>`;
    html += `<li><span class="token-dot token-dot--cache-read"></span>缓存读取 ${formatTokens(c.cacheRead)}</li>`;
    html += `<li>命中率 ${(ctx.cacheHitRatio * 100).toFixed(0)}%</li>`;
    html += "</ul>";
  } else {
    html += '<p class="empty-note">尚无 token 计量。</p>';
  }

  if (ctx.compactions.length > 0) {
    // V-19：不可逆自成语域。被置换的 tool_result 原文永不可恢复，
    // 这不是"又一条黄色警告"，混在一起会让人对它脱敏。
    html += '<div class="callout callout--irreversible">';
    html += `<strong>⚠ 上下文压缩 ${ctx.compactions.length} 次，置换 ${ctx.droppedBlocks} 个 tool_result 原文` +
      ((ctx.collapsedTurns ?? 0) > 0 ? `，折叠 ${ctx.collapsedTurns} 轮旧对话` : "") +
      "</strong>";
    html +=
      "<p>tool_result 原文不可恢复，模型如需全文须重跑工具。" +
      ((ctx.collapsedTurns ?? 0) > 0
        ? "被折叠的旧轮只剩一行摘要（assistant 正文首句 / 工具调用 / 结果首行），正文同样不可恢复。"
        : "") +
      ((ctx.reactiveCount ?? 0) > 0
        ? `其中 ${ctx.reactiveCount} 次是端点返回上下文超长 400 后的反应式硬压缩（保护窗收到 2），随即重发了同一轮。`
        : "") +
      `结构化账本已保留 ${ctx.ledgerEntries ?? 0} 条约束/决策/失败/证据/副作用摘要` +
      ((ctx.summaryAppliedCount ?? 0) > 0
        ? `（其中 ${ctx.summaryAppliedCount} 次合并了可选 LLM 摘要）`
        : "") +
      "。</p>";
    html += "</div>";
  }

  if (ctx.perTurn.length > 0) {
    html += '<h3 class="overview-section-title">逐轮明细</h3>';
    html += '<div class="table-scroll"><table class="usage-table">';
    html += "<thead><tr><th>轮</th><th>未缓存</th><th>缓存写</th><th>缓存读</th><th>输出</th></tr></thead><tbody>";
    for (const t of ctx.perTurn) {
      html += `<tr><td>${t.turn}</td><td>${formatTokens(t.input)}</td><td>${formatTokens(t.cacheCreation)}</td><td>${formatTokens(t.cacheRead)}</td><td>${formatTokens(t.output)}</td></tr>`;
    }
    html += "</tbody></table></div>";
  }
  return html;
}

/** Tools 面下钻：工具面、边界、改道证据 */
function renderToolsTab(tools) {
  let html = '<h3 class="overview-section-title">工具面</h3>';

  if (tools.tools.length === 0) {
    html += '<p class="empty-note">未获取到工具清单（宿主快照不可用）。</p>';
  } else {
    html += '<ul class="tool-chips">';
    for (const t of tools.tools) {
      const perm = t.permission ? `<span class="chip-perm chip-perm--${t.permission}">${t.permission}</span>` : "";
      const count = t.calls > 0 ? `<span class="chip-count">${t.calls} 次</span>` : "";
      const err = t.errors > 0 ? `<span class="chip-err">${t.errors} 失败</span>` : "";
      html += `<li class="tool-chip${t.errors > 0 ? " tool-chip--err" : ""}"><span class="chip-name">${esc(t.name)}</span>${perm}${count}${err}</li>`;
    }
    html += "</ul>";
  }

  html += '<h3 class="overview-section-title">运行边界</h3><dl class="boundary-list">';
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  if (tools.pack) {
    html += row("领域包", tools.pack.name ? `${tools.pack.name} — ${tools.pack.description ?? ""}` : "（无）");
    html += row("核查模式", tools.pack.verify?.mode ?? "（无）");
    const wl = tools.pack.verify?.readOnlyCommands ?? [];
    html += row("核查只读白名单", wl.length ? wl.join("、") : "（空——verifier 只能读文件，无法亲手重跑门禁）");
    if (tools.pack.resources?.length) html += row("独占资源", tools.pack.resources.join("、"));
  }
  if (tools.shell) html += row("bash 运行时", tools.shell);
  if (tools.executionIsolation) {
    const e = tools.executionIsolation;
    const label = e.effectiveState === "partial"
      ? "部分隔离（当前只覆盖 bash，SAFE-05 尚未完成）"
      : e.effectiveState === "report-only"
        ? "仅能力报告；命令仍以宿主身份执行，未隔离"
        : e.effectiveState === "direct"
          ? "隔离关闭；命令以宿主身份执行"
          : "required 后端不可用；命令拒绝执行";
    html += row(
      "Agent 命令隔离",
      `${label} · backend ${e.resolvedBackend ?? "none"} · probe ${e.probe?.state ?? "unknown"}`,
    );
    html += row("隔离策略摘要", `fs: ${e.filesystem} · net: ${e.network} · identity: ${e.identity} · resources: ${e.resources}`);
  }
  if (tools.projectId) html += row("项目", tools.projectId);
  if (tools.campaignId) {
    const role = tools.campaignRole === "director" ? "导演" : tools.campaignRole === "child" ? "子对话" : "";
    html += row("战役", role ? `${tools.campaignId} · ${role}` : tools.campaignId);
  }
  if (tools.workdir) html += row("工作目录", tools.workdir);
  if (tools.roleModels) {
    // 报的是本 run 实际用了什么模型跑哪个角色——配了但这次没启用要看得出来
    const rm = tools.roleModels;
    html += row("执行者模型", rm.executor ?? "—");
    html += row("核查者模型", rm.verifier ?? "（与执行者同一个）");
    html += row("planner 模型", rm.planner ?? "（与执行者同一个）");
    // 没配视觉模型时说清"看不了图"，而不是不提——执行者不知道自己缺这个能力
    html += row("视觉模型", rm.vision ?? "（未配置：本次运行看不了图）");
    html += row("生图模型", rm.image ?? "（未配置：本次运行不能生图）");
  }
  html += row("可写根", tools.writeRoots?.length ? tools.writeRoots.join("；") : "（无）");
  {
    const writeSet = new Set(tools.writeRoots ?? []);
    const readonlyOnly = (tools.readRoots ?? []).filter((root) => !writeSet.has(root));
    html += row("只读根", readonlyOnly.length ? readonlyOnly.join("；") : "（无）");
  }
  if (tools.history) {
    // 报实际落点：重启后能不能接着这场对话，取决于档案存在哪、留几个
    html += row(
      "运行历史",
      tools.history.enabled ? `${tools.history.dir}（保留最近 ${tools.history.keep} 个）` : "（未落盘：重启后无法回看或派生）",
    );
  }
  if (tools.guardrails) {
    const g = tools.guardrails;
    html += row("护栏", `maxTurns ${g.maxTurns ?? "—"} · maxTokens ${g.maxTokens ?? "—"} · 上下文预算 ${g.contextTokenLimit ?? "—"}`);
  }
  if (tools.context) {
    // 预算与窗口分开报（MEM-01）：预算带来源与夹紧原值，窗口带来源或明说未知
    const c = tools.context;
    html += row(
      "上下文窗口 / 预算",
      `预算 ${c.budget}（${contextSourceLabel(c.budgetSource)}${c.clamped ? `，由 ${c.requestedBudget} 夹紧` : ""}）· ` +
        (c.window ? `窗口 ${c.window}（${contextSourceLabel(c.windowSource)}）· 上限 ${c.maxBudget ?? "—"}` : "窗口未知"),
    );
  }
  if (tools.mcp) {
    html += row("MCP", formatMcpServersLine(tools.mcp));
  }
  html += "</dl>";

  if (tools.denials.length > 0) {
    html += '<h3 class="overview-section-title">被拒记录</h3><ul class="deny-list">';
    for (const d of tools.denials) {
      html += `<li><code>${esc(d.name)}</code>${d.reason ? `：${esc(d.reason)}` : "（未填理由）"}</li>`;
    }
    html += "</ul>";
    html += '<p class="rail-note">拒绝理由会原样回传给模型——deny 消息本身就是能力边界说明书。</p>';
  }

  const switched = tools.reroutes.filter((r) => r.switched);
  if (switched.length > 0) {
    // P5「错误进上下文，不炸循环」的可视化证据
    html += '<h3 class="overview-section-title">失败后的改道</h3><ul class="reroute-list">';
    for (const r of switched) {
      html += `<li><code>${esc(r.failedTool ?? "?")}</code> 失败 <span class="reroute-arrow">↳</span> 改用 <code>${esc(r.nextTool)}</code></li>`;
    }
    html += "</ul>";
    html += '<p class="rail-note">工具失败是常态路径：错误进上下文、循环不中断，模型自行改道。</p>';
  }
  return html;
}

/**
 * 日志面板：只追加，从不重排已渲染的条目。
 *
 * 两个后果都是实测过的痛点：① 展开/折叠状态与滚动位置天然保持；
 * ② 单次代价降到 O(新增条数)，长运行不再是 O(n²)。
 * 滚动跟随沿用 GitHub Actions 的规矩——贴底才跟，用户往上翻时不拽回去。
 */
function patchLogPanel(container, logEntries, callbacks, state) {
  const host = container.__logHost;
  if (!host) return;

  if (logEntries.length === 0) {
    if (!container.querySelector(".log-empty")) {
      const empty = document.createElement("div");
      empty.className = "log-empty";
      empty.textContent = "暂无日志记录。";
      host.appendChild(empty);
    }
    return;
  }
  const empty = container.querySelector(".log-empty");
  if (empty) empty.remove();

  // V-11：段首插入来源分界。此前三种来源按 seq 混排，标题写着"Agent 执行"
  // 却混着核查条目，"第 1 轮"出现四次而看不出属于哪一段。
  // CLI 一直有黄色 `↺ 核查未通过，开始返工…`（src/cli.ts:449），Web 没有。
  const boundaries = new Map();
  if (state) {
    for (const s of deriveSegments(state)) {
      if (s.index > 0) boundaries.set(s.startSeq, s);
    }
  }

  const scroller = host.closest(".content-area") || host;
  keepScrollAnchored(scroller, () => {
    appendOnly(host, logEntries, {
      key: (e) => String(e.seq),
      create: (e) => {
        const wrap = document.createElement("div");
        const boundary = boundaries.get(e.seq);
        wrap.innerHTML = (boundary ? renderSegmentBoundary(boundary) : "") + renderLogEntry(e);
        // 有分界时把两个节点包进一个容器，保持 appendOnly 的"一 key 一节点"契约
        let node;
        if (boundary) {
          node = document.createElement("div");
          node.className = "log-group";
          while (wrap.firstChild) node.appendChild(wrap.firstChild);
        } else {
          node = wrap.firstElementChild;
        }
        node.querySelector(".log-entry-header")?.addEventListener("click", () => {
          callbacks.onToggleEntry?.(Number(e.seq));
        });
        return node;
      },
      // 折叠状态是唯一会变的部分：重建内容但保留外层节点，
      // 这样滚动锚点与 patchNodes 映射都不受影响
      update: (node, e) => {
        const target = node.classList.contains("log-group")
          ? node.querySelector(".log-entry")
          : node;
        if (!target) return;
        const wasCollapsed = target.classList.contains("log-entry--collapsed");
        if (wasCollapsed === Boolean(e.collapsed)) return;
        const wrap = document.createElement("div");
        wrap.innerHTML = renderLogEntry(e);
        const fresh = wrap.firstElementChild;
        target.className = fresh.className;
        target.innerHTML = fresh.innerHTML;
        target.querySelector(".log-entry-header")?.addEventListener("click", () => {
          callbacks.onToggleEntry?.(Number(e.seq));
        });
      },
    });
  });
  // 工具日志同样走“语法候选 → 宿主 workdir/stat 确认 → 再升级为链接”的
  // 渐进增强链。这里不能只靠 renderLogEntry 直接造 href：历史 run 的 workdir
  // 可能不同，且日志正文是模型/工具输入，未经确认的路径只能继续当普通代码。
  if (state) void hydrateLocalPathLinks(host, state, callbacks);
}

/** 编排面板：依赖分层 + 甘特 + 并行收益（V-27） */
function patchPlanBoard(parts, host, plan) {
  if (!host) return;
  if (!plan) {
    setAttr(host, "hidden", "");
    host.innerHTML = "";
    parts.sig.plan = null;
    return;
  }
  setAttr(host, "hidden", null);
  const sig = signature([
    plan.nodes.map((n) => `${n.id}:${n.status}:${n.durationMs ?? ""}`).join(","),
    plan.timing ? JSON.stringify(plan.timing) : "",
    plan.warnings.length,
    plan.gate ? `${plan.gate.status}:${plan.gate.at}` : "",
  ]);
  if (parts.sig.plan === sig) return;
  parts.sig.plan = sig;

  let html = '<h3 class="overview-section-title">编排计划</h3>';

  // 批准本身不是信息：计划已经在跑/跑完，再占一块「已批准 + 时间」是噪声。
  // 否决 / 过期才要说——否则看起来像「没结果」。
  if (plan.gate && (plan.gate.status === "rejected" || plan.gate.status === "expired")) {
    const g = plan.gate;
    const label = g.status === "rejected" ? "✗ 计划被否决" : "⋯ 计划门未应答";
    const detail = g.status === "expired"
      ? "运行收尾时确认门仍在等待，未执行任何子任务。"
      : `由委托方否决${g.at ? ` · ${new Date(g.at).toLocaleString()}` : ""}——一个子任务都没有发射。`;
    html += `<div class="callout callout--warn"><strong>${esc(label)}</strong><p>${esc(detail)}</p></div>`;
  }

  if (plan.planned === false) {
    // fail-closed：planner 产不出可解析计划时一个子任务都不执行。
    // 这不是"没结果"，是一个明确的结论，必须说清。
    // B0 的过程摘要必须一并给出：「胡言乱语」与「探索没来得及收口」
    // 在原始输出片段上长得一模一样，返工策略却完全不同。
    html += '<div class="callout callout--bad"><strong>planner 未能产出可解析计划</strong>' +
      "<p>整份计划作废，没有执行任何子任务（fail-closed）。下面是 planner 的原始输出片段。</p>" +
      (plan.plannerFailure ? `<p>${esc(plan.plannerFailure)}</p>` : "") +
      (plan.plannerRaw ? `<pre class="chat-body">${esc(plan.plannerRaw)}</pre>` : "") +
      "</div>";
    host.innerHTML = html;
    return;
  }

  html += '<p class="plan-meta">';
  html += `并行度 ${plan.concurrency}${plan.concurrencyMode === "auto" ? "（auto）" : ""}`;
  html += ` · 层宽 ${plan.parallelWidth}`;
  html += ` · ${plan.nodes.length} 个子任务`;
  if (plan.plannerMs) html += ` · 拆解耗时 ${formatDuration(plan.plannerMs)}`;
  html += "</p>";

  for (const w of plan.warnings) {
    html += `<div class="callout callout--warn"><strong>⚠ ${esc(w.subtaskId)}</strong><p>${esc(w.message)}</p></div>`;
  }

  // 依赖分层：同层 = 互不依赖 = 可并发。这正是调度器在做的决策
  html += renderPlanReviewHtml(plan);

  if (plan.timing) {
    const t = plan.timing;
    // 口径写全：子任务阶段墙钟排除 planner，"节省"是相对串行全序和而言
    html += '<dl class="boundary-list plan-timing">';
    html += `<dt>全程</dt><dd>${formatDuration(t.totalMs)}</dd>`;
    html += `<dt>拆解</dt><dd>${formatDuration(t.plannerMs)}</dd>`;
    html += `<dt>子任务阶段墙钟</dt><dd>${formatDuration(t.subtaskWallMs)}（排除拆解）</dd>`;
    html += `<dt>子任务合计</dt><dd>${formatDuration(t.stepSumMs)}（各步耗时之和 = 串行基线）</dd>`;
    html += `<dt>并行节省</dt><dd>${formatDuration(t.savedMs)}${
      t.stepSumMs > 0 ? `（${((t.savedMs / t.stepSumMs) * 100).toFixed(0)}%）` : ""
    }</dd>`;
    html += "</dl>";
    html += '<p class="rail-note">并行买的是时间不是 token：token 成本是结构性的，不随并行度下降。</p>';
  }

  if (plan.skipped.length > 0) {
    html += `<div class="callout callout--warn"><strong>${plan.skipped.length} 个子任务未执行</strong>` +
      "<p>某一步核查未通过后调度停止发射新任务（在飞的照常跑完）——整体已败，续跑只是烧 token。</p><ul>" +
      plan.skipped.map((x) => `<li><code>${esc(x.id)}</code> ${esc(x.title)}</li>`).join("") +
      "</ul></div>";
  }
  host.innerHTML = html;
}

/** @returns {string} */
function renderAgentsCard(agents) {
  const list = agents ?? [];
  const running = list.filter((a) => a.status === "running").length;
  const pending = list.reduce((n, a) => n + (Number(a.pendingApprovals) || 0), 0);
  const title = running > 0
    ? (running === 1 ? "子代理工作中" : `${running} 个子代理工作中`)
    : "子代理";
  let html =
    `<div class="chat-agents${running > 0 ? " chat-agents--busy" : ""}" role="group" aria-label="${esc(title)}">` +
    `<div class="chat-agents-head"><strong class="chat-agents-title${running > 0 ? " thinking-shimmer" : ""}">${esc(title)}</strong>` +
    (pending > 0 ? `<span class="chat-agents-pending">需批准 ${pending}</span>` : "") +
    `</div><ul class="chat-agents-list">`;
  for (const a of list) {
    const status = a.status === "running" ? "工作中" : a.status === "error" ? "未完成" : a.status === "pending" ? "等待" : "已完成";
    const peek = String(a.lastText || a.peek || "").replace(/\s+/g, " ").trim();
    html +=
      `<li class="chat-agent-row">` +
      `<button type="button" class="chat-agent chat-agent--${esc(a.status)}" data-agent-id="${esc(a.id)}">` +
      `<span class="chat-agent-mark" aria-hidden="true"></span>` +
      `<span class="chat-agent-copy">` +
      `<span class="chat-agent-title">${esc(a.title)}</span>` +
      `<span class="chat-agent-meta">${esc(status)}${a.pendingApprovals > 0 ? " · 需批准" : ""}</span>` +
      (peek ? `<span class="chat-agent-peek">${esc(truncate(peek, 80))}</span>` : "") +
      `</span></button>` +
      (a.runId
        ? `<button type="button" class="chat-agent-enter" data-open-run="${esc(a.runId)}">进入子对话</button>`
        : "") +
      `</li>`;
  }
  html += "</ul></div>";
  return html;
}

function renderPlanNode(n, maxDuration, opts = {}) {
  const mark = { passed: "✔", failed: "✘", skipped: "－", running: "●", pending: "○" }[n.status];
  const pct = n.durationMs ? Math.max(2, Math.round((n.durationMs / maxDuration) * 100)) : 0;
  const openable = n.status !== "pending";
  const revealAcceptance = opts.revealAcceptance === true;
  const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
  const brief = String(n.description ?? "").trim();
  const acceptance = Array.isArray(n.acceptance) ? n.acceptance : [];
  let html = `<div class="plan-node plan-node--${n.status}${openable ? " plan-node--openable" : ""}">`;
  // 可点的是标题行，不是整张卡：卡里还有 <details>，套 role=button 会 nested-interactive。
  const editable = opts.editable === true;
  html += `<div class="plan-node-head"${openable && !editable ? ` data-agent-id="${esc(n.id)}" role="button" tabindex="0"` : ""}><span class="plan-node-mark">${mark}</span>`;
  html += `<code class="plan-node-id">${esc(n.id)}</code> `;
  html += editable
    ? `<input class="plan-node-title-edit" data-plan-edit="title" data-plan-id="${esc(n.id)}" value="${esc(n.title)}" aria-label="改短句 ${esc(n.id)}" />`
    : `<span class="plan-node-title">${esc(n.title)}</span>`;
  html += "</div>";
  html += '<div class="plan-node-meta">';
  if (n.pack) html += `<span class="chip-perm">包 ${esc(n.pack)}</span>`;
  if (deps.length) html += `<span>⇐ ${esc(deps.join(", "))}</span>`;
  // 独占资源要显眼：同标签强制串行，是"为什么这两个没并发"的唯一解释
  if (n.resources?.length) html += `<span class="plan-node-res">⊘ 独占 ${esc(n.resources.join("、"))}</span>`;
  if (n.reworks) html += `<span>↺ 返工 ${n.reworks} 轮</span>`;
  if (n.durationMs != null) html += `<span>${formatDuration(n.durationMs)}</span>`;
  html += "</div>";
  if (pct > 0) html += `<div class="plan-bar"><div class="plan-bar-fill" style="width:${pct}%"></div></div>`;
  if (editable) {
    html += `<input class="plan-node-brief-edit" data-plan-edit="description" data-plan-id="${esc(n.id)}" value="${esc(brief)}" aria-label="改说明 ${esc(n.id)}" placeholder="这一步要做什么（可改）" />`;
  } else if (brief) {
    html += `<p class="plan-node-brief">${esc(brief)}</p>`;
  }
  if (acceptance.length) {
    const list = `<ul class="plan-acceptance">${acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
    html += revealAcceptance
      ? `<div class="plan-node-checks"><span class="plan-node-checks-label">验收 ${acceptance.length} 条</span>${list}</div>`
      : `<details class="chat-aside"><summary>验收 ${acceptance.length} 条</summary>${list}</details>`;
  }
  html += "</div>";
  return html;
}

/**
 * 计划分层图（签字位 / 对话卡 / 右栏共用）。
 * revealAcceptance：确认门上验收必须摊开，不能再藏进「详见 Plan 面」。
 */
export function renderPlanReviewHtml(plan, opts = {}) {
  if (!plan || !Array.isArray(plan.layers) || plan.layers.length === 0) return "";
  const revealAcceptance = opts.revealAcceptance === true;
  let html = `<ol class="plan-layers${opts.className ? ` ${opts.className}` : ""}">`;
  plan.layers.forEach((layer, i) => {
    const nodes = Array.isArray(layer) ? layer : [];
    html += `<li class="plan-layer"><span class="plan-layer-label">第 ${i + 1} 层${
      nodes.length > 1 ? `（${nodes.length} 个可并发）` : ""
    }</span>`;
    html += '<div class="plan-nodes">';
    for (const n of nodes) html += renderPlanNode(n, plan.maxDuration, { revealAcceptance, editable: opts.editable === true });
    html += "</div></li>";
  });
  html += "</ol>";
  return html;
}

/** Loop 面的两种读法之间切换 */
function patchLoopView(parts, container, state, logEntries, callbacks) {
  // 对话升为主干之后这里只剩事件流一种读法（取证视图）
  patchLogPanel(container, logEntries, callbacks, state);
}

/**
 * 从**事件流**派生对话条目——对话主干的数据源。
 *
 * 为什么用事件而不是 transcript（委托方："还是希望做成对话框的形式"）：
 * transcript 只在**每一段结束时**才落盘，于是"对话"在运行过程中根本是空的，
 * 只能退回去看事件流——那正是它没法当主干的原因。而事件流里其实什么都有：
 * `assistant_text` 全文、`assistant_thinking` 全文、`tool_call` 的完整入参、
 * `tool_result` 的完整返回（`ui/server.ts` 的 default 分支原样透传）。
 * 换成事件之后对话**天然实时**，且顺手消掉了两件麻烦事：按需拉 transcript 的
 * 时序，以及续跑返回累计正史带来的逐段去重（V-28 那套前缀比对）——
 * 事件流本来就不重复。
 *
 * 产物是纯数据，渲染在 `renderChatStream`。这样"对话该长什么样"可以在
 * node 里直测，不必依赖 DOM。
 *
 * @returns {{kind:string,[k:string]:any}[]}
 */
/** 主对话滤掉了子代理事件；没有 live 时把当前执行者最后一段思考捞回来。 */
function latestExecutorThinkingText(state, afterSeq) {
  let source = "";
  const parts = [];
  for (const e of state?.timeline ?? []) {
    if (e.type !== "assistant_thinking") continue;
    if (!(e.seq > afterSeq)) continue;
    const role = segmentRole(e.source);
    if (role === "planner" || role === "verifier") continue;
    const text = String(e.text ?? "").trim();
    if (!text) continue;
    if (e.source !== source) {
      source = e.source;
      parts.length = 0;
    }
    parts.push(text);
  }
  return parts.join("\n\n");
}

function overlayAgentRunning(state, agentId) {
  return deriveChildAgents(state).some((a) => a.id === agentId && a.status === "running");
}

/** 追问之后、或计划已收官：骨架收成一行，不再每轮摊开。 */
function conversationChromeFolded(state, face, agents) {
  const livePlan = (face?.nodes ?? []).some((n) => n.status === "running" || n.status === "pending");
  const liveAgent = (agents ?? []).some((a) => a.status === "running");
  if (livePlan || liveAgent) return false;
  const followUp = lastUserMessageSeq(state);
  if (Number.isFinite(followUp) && followUp >= 0) return true;
  return state.status !== "running";
}

function lastUserMessageSeq(state) {
  let seq = Number.NEGATIVE_INFINITY;
  for (const e of state?.timeline ?? []) {
    if (e.type === "user_message") seq = e.seq;
  }
  return seq;
}

function lastUserItemIndex(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") return i;
  }
  return -1;
}

/**
 * 追问进行中：历史轮按收官形态折叠，当前轮（最后一条用户话之后）原样留下。
 * 第一轮还在跑时 last user 就是开场任务，整段都不折。
 */
export function collapsePriorTurns(items) {
  const at = lastUserItemIndex(items);
  if (at <= 0) return items;
  return [...collapseFinishedChat(items.slice(0, at)), ...items.slice(at)];
}

/** 从根到当前这一头的 runId（含 tip） */
export function ancestorRunIds(runs, tipId) {
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  const ids = [];
  const seen = new Set();
  let cur = tipId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    ids.unshift(cur);
    cur = byId.get(cur)?.continuedFrom;
  }
  return ids;
}

/**
 * 回退快照已经带着裁过的前缀。再往前拼父 run，会把裁掉的后半段又贴回来。
 */
export function ancestorRunIdsForChat(runs, tipId) {
  const ids = ancestorRunIds(runs, tipId);
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  const cut = ids.findIndex((id) => byId.get(id)?.rewindFrom);
  return cut > 0 ? ids.slice(cut) : ids;
}

/**
 * 可重复的交付条目指纹。用户话不去重——同一句追问也可能是新一轮。
 * 正文 / 思考 / 产物 / 裁决按内容认：谱系里整段克隆的子 run 会把同一段
 * 答案再贴一遍，这是「重复答案」的根。
 */
export function chatRepeatKey(it) {
  if (!it || typeof it !== "object") return null;
  const compact = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  if (it.kind === "text") {
    const body = compact(it.text);
    return body ? `text:${body}` : null;
  }
  if (it.kind === "thinking") {
    const body = compact(it.text);
    return body ? `thinking:${body}` : null;
  }
  if (it.kind === "artifacts") {
    const paths = (it.files ?? [])
      .map((f) => String(f?.path ?? "").replace(/\\/g, "/"))
      .filter(Boolean)
      .sort();
    return paths.length ? `artifacts:${paths.join("|")}` : null;
  }
  if (it.kind === "verdict") {
    return `verdict:${it.round ?? ""}:${JSON.stringify(it.verdict ?? null)}`;
  }
  return null;
}

function chatItemRicher(next, prev) {
  if (next.fromCompletion && !prev.fromCompletion) return true;
  if (!next.fromCompletion && prev.fromCompletion) return false;
  const extra = (it) =>
    (Array.isArray(it.verification) ? it.verification.length : 0)
    + (Array.isArray(it.assumptions) ? it.assumptions.length : 0)
    + (Array.isArray(it.files) ? it.files.length : 0);
  return extra(next) > extra(prev);
}

/** 同一段交付只留一份；有折叠块 / 产物更多的那份优先。 */
export function collapseRepeatChatItems(items) {
  const list = items ?? [];
  const keep = new Map();
  list.forEach((it, i) => {
    const fp = chatRepeatKey(it);
    if (!fp) return;
    const prev = keep.get(fp);
    if (prev === undefined || chatItemRicher(it, list[prev])) keep.set(fp, i);
  });
  return list.filter((it, i) => {
    const fp = chatRepeatKey(it);
    return !fp || keep.get(fp) === i;
  });
}

/**
 * 一场对话谱系拼成一条聊天：祖先 run 一律收官形态，只有当前这一头可以直播。
 * 续跑 fort 后子 run 时间线只有最后一轮——不拼的话，更早的轮次要么消失，
 * 要么还停在当初展开的过程视图里。
 */
export function deriveThreadChatItems(runs, runStates, tipId, live, opts = {}) {
  const ids = ancestorRunIdsForChat(runs, tipId);
  const loaded = ids
    .map((id) => ({ id, state: runStates instanceof Map ? runStates.get(id) : null }))
    .filter((row) => row.state);
  if (loaded.length <= 1) {
    const st = loaded[0]?.state
      ?? (runStates instanceof Map ? runStates.get(tipId) : null);
    return st ? deriveChatItems(st, live, opts) : [];
  }
  const out = [];
  for (let i = 0; i < loaded.length; i++) {
    const { id, state: raw } = loaded[i];
    const isTip = id === tipId;
    const part = deriveChatItems(
      isTip ? raw : { ...raw, status: "done" },
      isTip ? live : null,
      {},
    );
    const skipLead = i > 0;
    for (const it of part) {
      if (skipLead && it.kind === "user" && it.seq === -1) continue;
      if (skipLead && it.kind === "recap") continue;
      // 编排计划 / 子代理是整场对话一份骨架，不能每个续跑 run 再贴一张。
      if (skipLead && (it.kind === "plan" || it.kind === "agents")) continue;
      out.push({
        ...it,
        key: (it.kind === "live" || it.kind === "activity")
          ? it.key
          : `${id}:${it.key}`,
      });
    }
  }
  return collapseRepeatChatItems(out);
}

function applyDeliveryKeepingCurrentTurn(items, state, files, running) {
  if (!running) return applyStructuredDelivery(items, state, files);
  const at = lastUserItemIndex(items);
  // 第一轮 last user 就是开场任务（index 0）：收官卡属于这一轮，不能跳过。
  if (at <= 0) return applyStructuredDelivery(items, state, files);
  return [
    ...applyStructuredDelivery(items.slice(0, at), state, files),
    ...items.slice(at),
  ];
}

export function deriveChatItems(state, live, opts = {}) {
  // 产品默认：连续工具收成一组，摘要一行、点开看细节。
  // showProcess:true / "on" 仍展开成逐条 tool（单测锁合成/放行标记用）。
  const flatTools = opts.showProcess === true || opts.showProcess === "on";
  const hideTools = opts.showProcess === false || opts.showProcess === "off";
  const showBoundaries = flatTools;
  const trackTools = !hideTools;
  const agentId = typeof opts.agentId === "string" && opts.agentId ? opts.agentId : null;
  const items = [];
  /**
   * 开场白：**任务本身就是第一条用户消息**。
   * 它不在事件流里（它是 run 的入参，不是事件），所以要显式补上。
   * 点开某个子代理时，主任务换成这条支线的标题——那才是它的对话。
   */
  if (agentId) {
    const agents = deriveChildAgents(state);
    const agent = agents.find((a) => a.id === agentId);
    items.push({
      kind: "user",
      text: agent?.title || agentId.replace(/^spawn\//, ""),
      seq: -1,
      runId: state.runId ?? null,
    });
  } else if (state.task) {
    const taskAt = pickTaskAt(state);
    items.push({
      kind: "user",
      text: state.task,
      seq: -1,
      runId: state.runId ?? null,
      ...(taskAt != null ? { at: taskAt } : {}),
    });
  }
  if (!agentId) {
    const cited = deriveCitedChat(state.runConfig?.cited);
    if (cited) items.push({ ...cited, seq: -0.8 });
  }
  const priorRecap = agentId ? "" : String(state.lineage?.priorRecap ?? "").trim();
  if (priorRecap) {
    const priorTurns = Number(state.lineage?.priorTurns ?? 0);
    items.push({
      kind: "recap",
      text: priorRecap,
      turns: priorTurns > 0 ? priorTurns : 0,
      seq: -0.5,
    });
  }
  /** toolUseId → 该工具行在 items 里的下标，tool_result 回来时就地补上结果 */
  const callAt = new Map();
  let lastSource = null;
  /** 收起过程时：最近一次工具调用，用于「正在做…」活动条 */
  let latestTool = null;
  /** 最近一条追问；比它更晚的思考才算「这一轮」，进行中只走 live。 */
  const followUpSeq = lastUserMessageSeq(state);

  const all = [...(state.timeline ?? []), ...(state.verifierTimeline ?? [])].sort(
    (a, b) => a.seq - b.seq,
  );
  for (const e of all) {
    if (agentId) {
      if (childAgentKey(e.source) !== agentId) continue;
    } else if (isChildAgentSource(e.source)) {
      continue;
    }
    if (showBoundaries && e.source !== lastSource && CHAT_SOURCED.has(e.type)) {
      items.push({ kind: "boundary", source: e.source, role: segmentRole(e.source), seq: e.seq });
      lastSource = e.source;
    } else if (e.source !== lastSource && CHAT_SOURCED.has(e.type)) {
      lastSource = e.source;
    }
    switch (e.type) {
      case "user_message": {
        // 纯工具回执不占用户气泡；焊在人话前面的回执仍留条目，画的时候再剥。
        if (paintConversationUserText(e.text).kind === "receipt") break;
        items.push({
          kind: "user", text: e.text, seq: e.seq, runId: state.runId ?? null,
          ...(e.turn ? { turn: e.turn } : {}),
          ...(typeof e.verify === "boolean" ? { verify: e.verify } : {}),
          ...(e.continues ? { continues: e.continues } : {}),
          ...(e.executorSwitched ? { executorSwitched: true } : {}),
          ...(Number.isFinite(e.at) ? { at: e.at } : {}),
        });
        break;
      }
      case "steering":
        // 插队指令：用户气泡 + 「插队指令」标注（renderChatItem 认 steering 位）
        if (String(e.text ?? "").trim() && paintConversationUserText(e.text).kind !== "receipt") {
          items.push({
            kind: "user",
            text: e.text,
            seq: e.seq,
            runId: state.runId ?? null,
            steering: true,
            ...(Number.isFinite(e.at) ? { at: e.at } : {}),
          });
        }
        break;
      case "message_queued":
        // 轻提示行：排队的会说"结束后自动发送"，插队的会说"下一轮前生效"
        items.push({
          kind: "notice",
          tone: "queue",
          text: e.mode === "steer"
            ? "插队指令已受理，将在下一轮模型调用前生效"
            : "已排队 · 本轮结束后自动发送",
          peek: truncate(String(e.text ?? ""), 72),
          seq: e.seq,
        });
        break;
      case "message_queue_updated":
        // 队列增减由 chips 呈现；只有"自动续跑被拒"值得在对话里留一行
        if (e.sendError) {
          items.push({
            kind: "notice",
            tone: "queue",
            text: `排队消息未能自动发出：${e.sendError}`,
            seq: e.seq,
          });
        }
        break;
      case "assistant_thinking": {
        // 有 live 思考时，当前轮落定块不重复占位；没有 live 时必须看见——
        // 编排子任务的增量来源不是 main，以前会整段 Thinking 消失。
        // 规划者 / 核查者不进主对话。
        const liveThinkingNow = String(live?.thinking ?? "").trim();
        if (state.status === "running" && e.seq > followUpSeq && liveThinkingNow) break;
        const role = segmentRole(e.source);
        if (role === "verifier" || role === "planner") break;
        const text = String(e.text ?? "");
        const redacted = Boolean(e.redacted);
        if (!text.trim() && !redacted) break;
        const liveTurn = state.status === "running" && e.seq > followUpSeq;
        const last = items[items.length - 1];
        if (last?.kind === "thinking" && last.role === role && !last.redacted && !redacted) {
          items[items.length - 1] = {
            ...last,
            text: [last.text, text].filter(Boolean).join("\n\n"),
            seq: e.seq,
            live: Boolean(last.live || liveTurn),
          };
        } else {
          items.push({ kind: "thinking", text, seq: e.seq, role, redacted, live: liveTurn });
        }
        break;
      }
      case "assistant_text": {
        const text = String(e.text ?? "").trim();
        if (!text) break;
        const role = segmentRole(e.source);
        // 正式 plan 事件已到时，契约 JSON 改由下方 plan 卡承载（带执行态），
        // 不再在对话里再堆一面墙。
        if (state.plan && role === "planner" && isPlanShapedAssistantText(text)) break;
        items.push({
          kind: "text",
          text: e.text,
          seq: e.seq,
          role,
          runId: state.runId ?? null,
          ...(Number.isFinite(e.at) ? { at: e.at } : {}),
        });
        break;
      }
      case "tool_call":
        latestTool = { name: e.name, input: e.input, toolUseId: e.toolUseId, status: "running", seq: e.seq };
        if (!trackTools) break;
        callAt.set(e.toolUseId, items.length);
        items.push({
          kind: "tool", name: e.name, input: e.input, toolUseId: e.toolUseId,
          status: "running", result: null, isError: false, durationMs: null, seq: e.seq,
        });
        break;
      case "tool_result": {
        if (latestTool && latestTool.toolUseId === e.toolUseId) {
          latestTool = {
            ...latestTool,
            status: e.resultIsError ? "error" : "ok",
            result: e.resultContent ?? "",
            isError: Boolean(e.resultIsError),
            durationMs: e.durationMs ?? null,
          };
        }
        if (!trackTools) break;
        const at = callAt.get(e.toolUseId);
        if (at === undefined) break;
        items[at] = {
          ...items[at],
          status: e.resultIsError ? "error" : "ok",
          result: e.resultContent ?? "",
          isError: Boolean(e.resultIsError),
          durationMs: e.durationMs ?? null,
        };
        break;
      }
      case "approval_request": {
        if (!trackTools) break;
        const at = callAt.get(e.toolUseId);
        if (at !== undefined) items[at] = { ...items[at], gated: true };
        else items.push({ kind: "gate", name: e.name, seq: e.seq });
        break;
      }
      case "recovery_decision": {
        const stall = e.reason === "end_turn_without_completion" || e.reason === "stagnation";
        items.push({
          kind: "notice",
          tone: stall ? "stall" : "recovery",
          text: stall ? "空转 · 可停止" : "恢复决策",
          peek: String(e.detail ?? ""),
          live: state.status === "running" && stall,
          seq: e.seq,
        });
        break;
      }
      case "compaction":
        items.push({
          kind: "notice",
          tone: "compact",
          text: e.reactive ? "上下文过长，已压缩" : "上下文已压缩",
          peek: e.droppedBlocks ? `置换 ${e.droppedBlocks} 块` : "",
          live: state.status === "running",
          seq: e.seq,
        });
        break;
      case "run_forked":
      case "segment_resume":
        // 接续是宿主内部事件，不是对话。Cursor / GPT 不会在中间插一条「已接续」。
        break;
      default:
        break;
    }
  }

  // 编排计划 / 子代理：整场对话只贴开场任务后面一份。
  // 追问或收官后收成一行，避免每一轮都再占一屏。
  if (!agentId && !opts.omitConversationChrome) {
    const face = state.plan ? derivePlanFace(state) : null;
    const agents = deriveChildAgents(state);
    const folded = conversationChromeFolded(state, face, agents);
    const openAt = items.findIndex((it) => it.kind === "user" && it.seq === -1);
    const userAt = openAt >= 0 ? openAt : items.findIndex((it) => it.kind === "user");
    const insertAt = userAt >= 0 ? userAt + 1 : 0;
    if (face?.nodes?.length) {
      items.splice(insertAt, 0, { kind: "plan", plan: face, seq: null, folded });
    }
    if (agents.length > 0) {
      const after = items.findIndex((it) => it.kind === "plan");
      items.splice(after >= 0 ? after + 1 : insertAt, 0, {
        kind: "agents",
        agents,
        seq: Math.min(...agents.map((a) => Number(a.seq) || 0)),
        folded,
      });
    }
  }

  const verdictItems = (agentId ? [] : (state.verifications ?? [])).map((v) => ({
    kind: "verdict",
    round: v.round,
    judgedTurn: v.judgedTurn ?? null,
    verdict: v.verdict,
    recovery: v.recovery ?? null,
    seq: typeof v.seq === "number" ? v.seq : null,
  }));
  const placed = verdictItems.filter((v) => v.seq !== null);
  if (placed.length > 0) {
    for (const v of placed) {
      const at = items.findIndex((it) => typeof it.seq === "number" && it.seq > v.seq);
      if (at < 0) items.push(v);
      else items.splice(at, 0, v);
    }
  }
  for (const v of verdictItems.filter((v) => v.seq === null)) items.push(v);

  const liveText = String(live?.text ?? "");
  const liveThinking = String(live?.thinking ?? "");
  const streaming = Boolean(liveText.trim() || liveThinking.trim());
  const overlayRunning = Boolean(agentId && overlayAgentRunning(state, agentId));
  if (state.status === "running" && streaming && (!agentId || overlayRunning)) {
    items.push({ kind: "live", text: liveText, thinking: liveThinking, role: "main" });
  } else if (!agentId && state.status === "running" && !items.some((it) => it.kind === "thinking")) {
    const fallback = latestExecutorThinkingText(state, followUpSeq);
    if (fallback) {
      items.push({ kind: "thinking", text: fallback, live: true, role: "main" });
    } else if (latestTool?.status !== "running" && !deriveChildAgents(state).some((a) => a.status === "running")) {
      items.push({ kind: "live", text: "", thinking: "", waiting: true, role: "main" });
    }
  } else if (overlayRunning && !streaming && !items.some((it) => it.kind === "thinking") && latestTool?.status !== "running") {
    items.push({ kind: "live", text: "", thinking: "", waiting: true, role: "main" });
  }
  if (!agentId && hideTools && state.status === "running" && latestTool?.status === "running") {
    items.push({
      kind: "activity",
      name: latestTool.name,
      peek: toolPeek(latestTool.name, latestTool.input),
      seq: latestTool.seq,
    });
  }

  let keyed = (!flatTools && !hideTools) ? collapseToolGroups(items) : items;
  keyed = collapseLiveStatus(keyed, {
    running: state.status === "running",
    streaming,
  });
  keyed = foldThinkingPerTurn(keyed);
  if (state.status === "running") {
    // 追问把 run 拉回 running 时，历史轮必须仍是收官形态，不能把工具摊回来。
    keyed = collapsePriorTurns(keyed);
  } else if (!flatTools) {
    keyed = collapseFinishedChat(keyed);
  }
  // 收官：finish_task 结构化交付优先；否则退回「最后正文 + 写出文件」推断。
  // 追问进行中也要把上一轮产物卡留在历史轮里。
  const files = Array.isArray(opts.threadFiles) && opts.threadFiles.length
    ? opts.threadFiles
    : deriveSessionFiles(state);
  if (!agentId) {
    keyed = applyDeliveryKeepingCurrentTurn(keyed, state, files, state.status === "running");
    keyed = applyBlockedCard(keyed, state);
    const sourceRows = deriveChatSources(state);
    if (sourceRows.length) {
      keyed.push({ kind: "sources", rows: sourceRows, seq: Number.MAX_SAFE_INTEGER });
    }
  }
  for (const it of keyed) {
    it.key =
      it.kind === "live" ? "live"
      : it.kind === "activity" ? "activity"
      : it.kind === "notice" ? ("notice:" + (it.seq ?? "x"))
      : it.kind === "run-next" ? "run-next"
      : it.kind === "tools" ? ("tools:" + (it.tools?.[0]?.toolUseId ?? it.seq ?? "x"))
      : it.kind === "verdict" ? ("verdict:" + (it.judgedTurn ?? "x") + ":" + it.round)
      : it.kind === "artifacts" ? "artifacts"
      : it.kind === "blocked" ? "blocked"
      : it.kind === "sources" ? "sources"
      : it.kind === "plan" ? "plan"
      : it.kind === "agents" ? "agents"
      : it.kind === "tool" ? ("tool:" + (it.toolUseId ?? it.seq ?? "x"))
      : (it.kind + ":" + (it.seq ?? "x"));
  }
  keyed = collapseRepeatChatItems(keyed);
  markSettledTurnActions(keyed, state.status === "running");
  return keyed;
}

/**
 * 操作条只挂在**已经收官的一轮**上：该轮用户话 + 最后一段执行者正文。
 * 思考、工具、中间进度句、以及还在跑的当前轮都不挂——那是过程，不是一轮对话。
 */
export function markSettledTurnActions(items, running) {
  const list = items ?? [];
  for (const it of list) it.showActions = false;
  const bounds = [];
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind === "user" && i > 0) {
      bounds.push([start, i - 1]);
      start = i;
    }
  }
  bounds.push([start, list.length - 1]);
  for (let t = 0; t < bounds.length; t++) {
    if (running && t === bounds.length - 1) continue;
    const [from, to] = bounds[t];
    if (list[from]?.kind === "user") list[from].showActions = true;
    for (let i = to; i > from; i--) {
      if (list[i].kind === "text" && list[i].role !== "verifier" && list[i].role !== "planner") {
        list[i].showActions = true;
        break;
      }
    }
  }
  return list;
}

/** assistant_text 是否已是可解析的计划契约（用于去重） */
function isPlanShapedAssistantText(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("{")) return false;
  try {
    return looksLikePlanPayload(JSON.parse(t));
  } catch {
    return false;
  }
}

/**
 * Thinking / 工具 / 压缩只留一个直播状态。压缩不是对话正文，结束后也不留条。
 */
export function collapseLiveStatus(items, { running, streaming } = {}) {
  const notices = items.filter((it) => it.kind === "notice");
  const rest = items.filter((it) => it.kind !== "notice");
  if (!running) return rest;
  const toolLive = rest.some((it) => {
    if (it.kind === "tools") return (it.tools ?? []).some((t) => t.status === "running");
    if (it.kind === "tool") return it.status === "running";
    return it.kind === "activity";
  });
  if (streaming || toolLive) return rest;
  const latest = notices.at(-1);
  return latest ? [...rest, latest] : rest;
}

function mergeThinkingItems(thinkings) {
  if (!thinkings.length) return null;
  const first = thinkings[0];
  if (thinkings.length === 1) return first;
  return {
    ...first,
    text: thinkings.map((t) => t.text).filter(Boolean).join("\n\n"),
    redacted: thinkings.some((t) => t.redacted),
    live: thinkings.some((t) => t.live),
    seq: thinkings.at(-1).seq,
  };
}

/**
 * 一轮对话只留一条 Thinking，贴在该轮最后一段执行者正文前面。
 * 规划者 / 核查者的思考丢掉。对标 Cursor：过程中的多次思考不叠罗汉。
 */
export function foldThinkingPerTurn(items) {
  const out = [];
  let thinkings = [];
  let buffer = [];
  const flushTurn = () => {
    const think = mergeThinkingItems(thinkings);
    thinkings = [];
    let lastTextAt = -1;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].kind === "text" && buffer[i].role !== "verifier" && buffer[i].role !== "planner") {
        lastTextAt = i;
        break;
      }
    }
    if (think && lastTextAt >= 0) {
      out.push(...buffer.slice(0, lastTextAt), think, ...buffer.slice(lastTextAt));
    } else if (think) {
      out.push(think, ...buffer);
    } else {
      out.push(...buffer);
    }
    buffer = [];
  };
  for (const it of items) {
    if (it.kind === "thinking") {
      if (it.role !== "verifier" && it.role !== "planner") thinkings.push(it);
      continue;
    }
    if (it.kind === "user" || it.kind === "verdict" || it.kind === "recap") {
      flushTurn();
      out.push(it);
      continue;
    }
    buffer.push(it);
  }
  flushTurn();
  return out;
}

/**
 * 收官后只留用户话 + 每轮最后一段**执行者**正文 + 裁决。
 * 中间进度句和工具过程收起。
 *
 * 核查者 / 规划者的 assistant_text 不进终局正文——裁决卡已经承载核查结论，
 * 若把 `[verifier] passed=…` 当成「最后一段助手正文」，会把真正的交付总结盖掉
 * （用户截图里只剩那一行核查文案、没有产物说明，正是这个形状）。
 */
export function collapseFinishedChat(items) {
  const out = [];
  let texts = [];
  let thinkings = [];
  const flush = () => {
    if (thinkings.length) {
      const first = thinkings[0];
      out.push(
        thinkings.length === 1
          ? first
          : {
              ...first,
              text: thinkings.map((t) => t.text).filter(Boolean).join("\n\n"),
              redacted: thinkings.some((t) => t.redacted),
              seq: thinkings.at(-1).seq,
            },
      );
      thinkings = [];
    }
    if (texts.length) {
      const preferred =
        [...texts].reverse().find((t) => t.role !== "verifier" && t.role !== "planner") ?? null;
      if (preferred) out.push(preferred);
    }
    texts = [];
  };
  for (const it of items) {
    if (it.kind === "text") {
      texts.push(it);
      continue;
    }
    if (it.kind === "thinking") {
      if (it.role === "verifier" || it.role === "planner") continue;
      thinkings.push(it);
      continue;
    }
    if (it.kind === "tools" || it.kind === "tool" || it.kind === "notice" || it.kind === "activity" || it.kind === "gate") {
      continue;
    }
    // 编排计划卡在收官后仍保留——它是交付骨架，不是过程噪声
    flush();
    out.push(it);
  }
  flush();
  return out;
}

/**
 * 把产物卡插到终局对话里：总结正文之后、裁决卡之前。
 * 对标 Cowork「总结文案 + 交付文件卡片」那一块。
 */
export function weaveDeliveryArtifacts(items, files, runId) {
  const deliverables = (files ?? []).filter((f) => f && f.path && f.kind !== "upload");
  if (deliverables.length === 0) return items;
  const art = {
    kind: "artifacts",
    files: deliverables,
    runId: runId ?? null,
    seq: null,
    key: "artifacts",
  };
  const out = [...items].filter((it) => it.kind !== "artifacts");
  const verdictAt = out.findIndex((it) => it.kind === "verdict");
  if (verdictAt < 0) out.push(art);
  else out.splice(verdictAt, 0, art);
  return out;
}

const COMPLETION_STATUS_LABEL = {
  completed: "已完成",
  partial: "部分完成",
  blocked: "已阻塞",
};

const FOLLOWUP_BLOCKED_RE =
  /缺少|等待|被拒|无法继续|需要(你|委托方|人工)|证书|权限|denied|missing|waiting|blocked|无权限|审批未过/i;
const FOLLOWUP_UNFINISHED_RE =
  /下一(回|轮)|尚未开始|未开始|未启动|未布线|拟|待执行|Phase\s*\d|remaining|next (turn|round)|not started|planned/i;

/**
 * finish_task 只有一个 blockers 桶，模型会把「下一回合再做」和「卡死」塞一起。
 * 界面必须拆开，否则委托方分不清后台还在不在跑。
 */
export function classifyCompletionFollowUp(text, status) {
  const item = String(text ?? "");
  const unfinishedHit = FOLLOWUP_UNFINISHED_RE.test(item);
  const blockedHit = FOLLOWUP_BLOCKED_RE.test(item);
  if (unfinishedHit && !blockedHit) return "unfinished";
  if (blockedHit && !unfinishedHit) return "blocked";
  if (unfinishedHit && blockedHit) {
    return /下一(回|轮)|拟|planned|next (turn|round)/i.test(item) ? "unfinished" : "blocked";
  }
  return status === "blocked" ? "blocked" : "unfinished";
}

export function splitCompletionFollowUps(completion) {
  const status = String(completion?.status ?? "");
  const unfinished = [];
  const blocked = [];
  for (const raw of Array.isArray(completion?.blockers) ? completion.blockers : []) {
    const item = String(raw);
    if (classifyCompletionFollowUp(item, status) === "blocked") blocked.push(item);
    else unfinished.push(item);
  }
  return { unfinished, blocked };
}

/**
 * 收官之后还在不在跑、会不会自动续聊。没有明确后续段时不要许诺「自动回到对话」——
 * finish_task 只结束这一段执行者；核查/返工/编排子任务/活着的 spawn 才会自动接着走。
 */
export function deriveRunFollowUp(state) {
  const plan = state?.plan ? derivePlanFace(state) : null;
  const runningNodes = (plan?.nodes ?? []).filter((n) => n.status === "running");
  const pendingNodes = (plan?.nodes ?? []).filter((n) => n.status === "pending");
  const failed = (plan?.nodes ?? []).some((n) => n.status === "failed");
  const skipped = (plan?.nodes ?? []).some((n) => n.status === "skipped");
  const spawnStarts = (state?.timeline ?? []).filter((e) => e.type === "spawn_start");
  const spawnDones = (state?.timeline ?? []).filter((e) => e.type === "spawn_done").length;
  const liveSpawns = Math.max(0, spawnStarts.length - spawnDones);
  const sourced = [...(state?.timeline ?? []), ...(state?.verifierTimeline ?? [])]
    .filter((e) => CHAT_SOURCED.has(e.type))
    .at(-1);
  const lastRole = sourced ? segmentRole(sourced.source) : "main";
  const running = state?.status === "running";
  const hasCompletion = Boolean(state?.completion && typeof state.completion === "object");

  if (!running) {
    return {
      live: false,
      autoContinue: false,
      title: "本轮已结束",
      text: "后台没有任务在跑，对话也不会自动继续。要接着做未完成项，再发一条即可。",
    };
  }
  if (lastRole === "verifier") {
    return {
      live: true,
      autoContinue: true,
      title: "核查还在跑",
      text: "结束后会自动给出裁决；未通过会自动返工，不必再发消息。",
    };
  }
  if (lastRole === "rework") {
    return {
      live: true,
      autoContinue: true,
      title: "返工还在跑",
      text: "结束后会自动回到对话，不必再发消息。",
    };
  }
  if (liveSpawns > 0) {
    const title = spawnStarts[spawnStarts.length - 1]?.title;
    return {
      live: true,
      autoContinue: true,
      title: title ? `支线还在跑：${title}` : "支线还在跑",
      text: "支线结束后结论会回到本对话，不必再发消息。",
    };
  }
  if (runningNodes.length > 0) {
    const names = runningNodes.map((n) => n.title || n.id).join("、");
    if (failed || skipped) {
      return {
        live: true,
        autoContinue: false,
        title: `还有任务在跑：${names}`,
        text: "这一步会跑完，但编排不会自动开下一回合。要接着做未完成项，需再发一条。",
      };
    }
    return {
      live: true,
      autoContinue: true,
      title: `还有任务在跑：${names}`,
      text: pendingNodes.length > 0
        ? "跑完后会自动进入下一步，不必再发消息。"
        : "跑完后会自动收尾，不必再发消息。",
    };
  }
  if (pendingNodes.length > 0) {
    if (failed || skipped) {
      return {
        live: true,
        autoContinue: false,
        title: "编排已停下",
        text: "还有未发射的子任务，但编排不会自动继续。要接着做，需再发一条。",
      };
    }
    return {
      live: true,
      autoContinue: true,
      title: "下一步即将开始",
      text: "调度器正在发射下一子任务，不必再发消息。",
    };
  }
  // 已 finish_task、本轮勾了核查，但核查段事件还没进流——短窗口，别写成含糊的「任务仍在进行」
  if (hasCompletion && state.verify) {
    return {
      live: true,
      autoContinue: true,
      title: "核查即将开始",
      text: "执行者已收官；核查结束后会自动给出裁决，不必再发消息。",
    };
  }
  // 已收官但本地仍显示 running（多半在等 run_end）——不许诺「自动续聊」
  if (hasCompletion) {
    return {
      live: true,
      autoContinue: false,
      title: "正在收尾",
      text: "完成声明已提交，正在写入结束状态。若有未完成项，结束后需再发一条才会继续。",
    };
  }
  return {
    live: true,
    autoContinue: true,
    title: "任务仍在进行",
    text: "模型还在推进；有结果后会回到对话。",
  };
}

/** finish_task 摘要 → 对话正文（验证 / 假设 / 未完成 / 阻塞分开，产物走卡片）。 */
export function formatCompletionChatText(completion) {
  if (!completion || typeof completion !== "object") return "";
  const summary = String(completion.summary ?? "").trim();
  if (!summary) return "";
  const status = String(completion.status ?? "");
  const lines = [];
  if (status && status !== "completed") {
    lines.push(`**${COMPLETION_STATUS_LABEL[status] ?? status}**`, "");
  }
  lines.push(summary);
  const { unfinished, blocked } = splitCompletionFollowUps(completion);
  const pushGroup = (title, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    lines.push("", `**${title}**`);
    for (const item of arr) lines.push(`- ${String(item)}`);
  };
  // 验证 / 假设与前提改走折叠块，不摊在气泡正文里。
  pushGroup("未完成", unfinished);
  pushGroup("阻塞", blocked);
  return lines.join("\n");
}

/** finish_task 的证据分组（不含 status/summary）——长正文气泡后面续上，不另起一篇。 */
export function formatCompletionExtras(completion) {
  if (!completion || typeof completion !== "object") return "";
  const { unfinished, blocked } = splitCompletionFollowUps(completion);
  const lines = [];
  const pushGroup = (title, arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    lines.push("", `**${title}**`);
    for (const item of arr) lines.push(`- ${String(item)}`);
  };
  pushGroup("未完成", unfinished);
  pushGroup("阻塞", blocked);
  return lines.join("\n");
}

/**
 * 收官正文：有一段真正的执行者报告时，那才是气泡；一句 summary 不能把它换掉。
 * 没有产物（artifacts=[]）尤其如此——问答/扫描的交付就是那段话。
 */
export function pickCompletionChatText(completion, lastExecutorText) {
  const last = String(lastExecutorText ?? "").trim();
  const structured = formatCompletionChatText(completion);
  const summary = String(completion?.summary ?? "").trim();
  if (!last) return structured;
  // 巨文档/HTML 仍折在气泡里；阻塞清单走独立卡，不要焊进折叠正文。
  if (looksLikeHugeDocumentBody(last) || looksLikeHtmlDocument(last)) return last;
  const lastIsReport = last.length >= 200 || (summary.length > 0 && last.length > summary.length * 2);
  if (!lastIsReport) return structured || last;
  const extras = formatCompletionExtras(completion);
  if (!extras) return last;
  if (/\*\*(验证|假设|未完成|阻塞)\*\*/.test(last)) return last;
  return `${last}${extras}`;
}

const FOLDABLE_COMPLETION_HEADINGS = {
  "验证": "verification",
  "假设与前提": "assumptions",
  "假设": "assumptions",
};

/**
 * 从收官正文里拆出「验证 / 假设与前提」——这两项改成可展开，不占主气泡。
 * 执行者自己写成 **验证** 列表时也要拆，避免折叠块和正文重复。
 */
export function splitFoldableCompletionSections(text) {
  const groups = { verification: [], assumptions: [] };
  const kept = [];
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    const heading = line.trim().match(/^\*\*(验证|假设与前提|假设)\*\*$/);
    if (heading) {
      current = FOLDABLE_COMPLETION_HEADINGS[heading[1]];
      continue;
    }
    if (current && /^\*\*.+\*\*$/.test(line.trim())) current = null;
    if (current) {
      const item = line.match(/^\s*[-*]\s+(.*)$/);
      if (item) {
        groups[current].push(item[1]);
        continue;
      }
      if (!line.trim()) continue;
      current = null;
    }
    kept.push(line);
  }
  return {
    text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    verification: groups.verification,
    assumptions: groups.assumptions,
  };
}

function stringList(arr) {
  return Array.isArray(arr) ? arr.map((item) => String(item)).filter((item) => item.trim()) : [];
}

/** 折叠块数据：契约字段优先，正文里拆出的列表兜底。 */
export function completionFoldGroups(completion, text) {
  const split = splitFoldableCompletionSections(text);
  const verification = stringList(completion?.verification);
  const assumptions = stringList(completion?.assumptions);
  return {
    text: split.text,
    verification: verification.length ? verification : split.verification,
    assumptions: assumptions.length ? assumptions : split.assumptions,
  };
}

/**
 * 把 finish_task.artifacts 声明与会话写出文件对齐。
 * 声明优先；basename 只在唯一命中时对上，重名不猜。
 * extras: "all"（默认，兼容旧测试）| "delivery"（滤掉核查脚本）| "none"
 */
export function mergeCompletionArtifactFiles(declared, sessionFiles, opts = {}) {
  const session = (sessionFiles ?? []).filter((f) => f && f.path && f.kind !== "upload");
  const extras = opts.extras ?? "all";
  const norm = (p) => String(p ?? "").replace(/\\/g, "/").trim();
  const byNorm = new Map(session.map((f) => [norm(f.path), f]));
  const out = [];
  const used = new Set();

  for (const raw of declared ?? []) {
    // 模型写的是自由文本：先提取真实路径（剥前缀/注释、拆并列），
    // 一条多路径拆成多张卡——实现成本低于一卡多操作，且每张卡的操作不变
    for (const extracted of extractArtifactPaths(raw)) {
      const path = norm(extracted);
      if (!path) continue;
      let hit = byNorm.get(path);
      if (!hit) {
        const suffixHits = session.filter((f) => {
          const fp = norm(f.path);
          return fp.endsWith("/" + path) || path.endsWith("/" + fp);
        });
        if (suffixHits.length === 1) hit = suffixHits[0];
      }
      if (!hit) {
        const base = fileBasename(path).toLowerCase();
        const baseHits = session.filter((f) => fileBasename(norm(f.path)).toLowerCase() === base);
        if (baseHits.length === 1) hit = baseHits[0];
        else if (baseHits.length > 1) {
          for (const f of baseHits) {
            const key = norm(f.path);
            if (used.has(key)) continue;
            out.push(f);
            used.add(key);
          }
          continue;
        }
      }
      if (hit) {
        if (used.has(norm(hit.path))) continue;
        out.push(hit);
        used.add(norm(hit.path));
      } else {
        out.push({ path, kind: "artifact", seq: 0 });
      }
    }
  }
  if (extras === "none") return out;
  for (const f of session) {
    const key = norm(f.path);
    if (used.has(key)) continue;
    if (extras === "delivery" && isNoiseArtifact(f.path)) continue;
    out.push(f);
  }
  return out;
}

/** 一场对话该看见的产物：声明优先，滤掉核查脚本与别的目录噪音 */
export function selectConversationArtifacts(files, { declared = [], task = "" } = {}) {
  const clean = (declared ?? []).flatMap((d) => extractArtifactPaths(d));
  const uploads = (files ?? []).filter((f) => f && f.kind === "upload");
  const artifacts = (files ?? []).filter((f) => f && f.path && f.kind !== "upload");
  const merged = clean.length
    ? mergeCompletionArtifactFiles(clean, artifacts, { extras: "delivery" })
    : artifacts.filter((f) => !isNoiseArtifact(f.path));
  void task;
  return [...uploads, ...merged];
}

/**
 * 预览坞用的清单：这场对话里出现过的文件都进，不按交付声明裁路径。
 * 核查脚本 / node_modules 仍排除——那些不是给人看的。
 */
export function selectPreviewArtifacts(files) {
  return (files ?? []).filter((f) => f && f.path && !isNoiseArtifact(f.path));
}

/**
 * 把路径并进预览清单：已在里面就回原位，否则追加到末尾。
 * 空路径不改清单。调用方负责把追加项记住，否则下一帧又丢。
 * @param {{path?:string}[]} list
 * @param {string} path
 * @returns {{ list:{path:string, kind?:string}[], index:number }}
 */
export function ensurePreviewArtifact(list, path) {
  const want = String(path ?? "");
  const cur = Array.isArray(list) ? list.filter((a) => a && a.path) : [];
  if (!want) return { list: cur, index: -1 };
  const index = cur.findIndex((a) => String(a.path) === want);
  if (index >= 0) return { list: cur, index };
  return { list: [...cur, { path: want, kind: "preview" }], index: cur.length };
}

/**
 * 点路径打开预览：一律走右侧画布。清单里没有的先并进去再开。
 * @param {{path?:string}[]} list
 * @param {string} path
 */
export function resolveArtifactOpen(list, path) {
  const { index } = ensurePreviewArtifact(list, path);
  return index >= 0 ? { mode: "canvas", index } : { mode: "none" };
}

/** 左键单击且无修饰键——Ctrl/中键仍走链接自己的 href（下载/新标签）。 */
function isPlainLeftClick(event) {
  const button = event?.button;
  return (button == null || button === 0)
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * 本地 file:// 或盘符路径。http 页一点就会整页开走，预览绝不能拿它当导航。
 * @param {string|null|undefined} href
 */
export function isLocalFileHref(href) {
  const raw = String(href ?? "").trim();
  if (!raw) return false;
  if (/^file:/i.test(raw)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith("\\\\")) return true;
  return false;
}

/**
 * 从 file:// / 盘符 href 抽出本地路径，给页内画布用。抽不出就空串。
 * @param {string|null|undefined} href
 */
export function localPathFromFileHref(href) {
  const raw = String(href ?? "").trim();
  if (!raw) return "";
  if (/^file:/i.test(raw)) {
    try {
      const u = new URL(raw);
      let path = decodeURIComponent(u.pathname || "");
      if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
      return path;
    } catch {
      return raw.replace(/^file:\/\//i, "");
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return raw;
  return "";
}

/**
 * 预览点击：拦默认导航（含 file://），交给页内坞。返回是否已接管。
 * @param {Event} event
 * @param {((path:string)=>void)|null|undefined} openFn
 */
export function stayInPageForPreviewClick(event, openFn) {
  const el = event?.target instanceof Element
    ? event.target.closest("[data-canvas-open], [data-path-preview], a[data-preview-path], a[href]")
    : null;
  if (!el) return false;
  const href = el.getAttribute("href") || "";
  const fromAttr = (
    el.getAttribute("data-canvas-open")
    || el.getAttribute("data-path-preview")
    || el.getAttribute("data-preview-path")
    || ""
  ).trim();
  const fileHref = isLocalFileHref(href);
  if (!fromAttr && !fileHref) return false;
  const path = fromAttr || localPathFromFileHref(href);
  if (fileHref) {
    event.preventDefault();
    event.stopPropagation?.();
    if (isPlainLeftClick(event) && typeof openFn === "function" && path) openFn(path);
    return true;
  }
  if (!isPlainLeftClick(event)) return false;
  event.preventDefault();
  if (typeof openFn === "function" && path) openFn(path);
  return true;
}

export const SIDEBAR_COLLAPSED_KEY = "agent-ui-sidebar-collapsed";

export function readSidebarCollapsed(storage) {
  try {
    return storage?.getItem?.(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage, collapsed) {
  try {
    if (collapsed) storage?.setItem?.(SIDEBAR_COLLAPSED_KEY, "1");
    else storage?.removeItem?.(SIDEBAR_COLLAPSED_KEY);
  } catch { /* 偏好写失败不影响显隐 */ }
}

export function deriveThreadDeclaredArtifacts(runs, runStates, tipId) {
  const byId = new Map((runs ?? []).map((r) => [r.runId, r]));
  const ids = [];
  const seen = new Set();
  let cur = tipId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    ids.unshift(cur);
    cur = byId.get(cur)?.continuedFrom;
  }
  const out = [];
  for (const id of ids) {
    const st = runStates instanceof Map ? runStates.get(id) : null;
    const arts = st?.completion?.artifacts;
    if (Array.isArray(arts)) out.push(...arts);
  }
  return out;
}

/**
 * 收官交付：有 finish_task 时，长执行者正文留下（问答/扫描没有产物也算交付）；
 * 只有短进度句才改用 summary。产物卡仍走 artifacts。
 */
export function applyStructuredDelivery(items, state, sessionFiles) {
  const completion = state?.completion && typeof state.completion === "object"
    ? state.completion
    : null;
  let out = [...(items ?? [])];

  if (completion) {
    // 只改**当前这一轮**（最后一条用户话之后）。跨轮去找「最后一段正文」
    // 会把 finish_task(blocked) 焊到上一轮杂志总结上——本轮只剩 Thought Process。
    const lastUserAt = lastUserItemIndex(out);
    const turnStart = lastUserAt >= 0 ? lastUserAt + 1 : 0;
    let lastExecutorText = "";
    let textAt = -1;
    for (let i = out.length - 1; i >= turnStart; i--) {
      if (out[i].kind === "text" && out[i].role !== "verifier" && out[i].role !== "planner") {
        textAt = i;
        lastExecutorText = String(out[i].text ?? "");
        break;
      }
    }
    const text = pickCompletionChatText(completion, lastExecutorText);
    if (text) {
      const folds = completionFoldGroups(completion, text);
      const summaryItem = {
        kind: "text",
        text: folds.text,
        role: "main",
        fromCompletion: true,
        seq: null,
        ...(folds.verification.length ? { verification: folds.verification } : {}),
        ...(folds.assumptions.length ? { assumptions: folds.assumptions } : {}),
      };
      if (textAt >= 0) {
        out[textAt] = { ...out[textAt], ...summaryItem, seq: out[textAt].seq };
      } else {
        const verdictAt = out.findIndex((it) => it.kind === "verdict");
        if (verdictAt < 0) out.push(summaryItem);
        else out.splice(verdictAt, 0, summaryItem);
        textAt = out.findIndex((it) => it.fromCompletion);
      }
      const follow = deriveRunFollowUp(state);
      const leftover = splitCompletionFollowUps(completion);
      if (follow.live || leftover.unfinished.length > 0 || leftover.blocked.length > 0
        || String(completion.status) === "partial" || String(completion.status) === "blocked") {
        out = out.filter((it) => it.kind !== "run-next");
        const after = out.findIndex((it) => it.fromCompletion);
        const notice = {
          kind: "run-next",
          live: follow.live,
          autoContinue: follow.autoContinue,
          title: follow.title,
          text: follow.text,
          seq: null,
          key: "run-next",
        };
        out.splice(after >= 0 ? after + 1 : out.length, 0, notice);
      }
    }
  }

  const declared = Array.isArray(completion?.artifacts) ? completion.artifacts : [];
  // 排序用的声明清单同样先提取干净路径——带注释的原文连 basename 都对不上
  const declaredClean = declared.flatMap((d) => extractArtifactPaths(d));
  const files = completion
    ? mergeCompletionArtifactFiles(declared, sessionFiles, { extras: "delivery" })
    : (sessionFiles ?? []).filter((f) => f && f.path && f.kind !== "upload" && !isNoiseArtifact(f.path));
  const ranked = rankDeliveryArtifacts(files, { task: state?.task ?? "", declared: declaredClean });
  return weaveDeliveryArtifacts(out, ranked, state?.runId ?? null);
}

const BLOCK_REASON_MAX = 280;

function shortBlockLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  if (!line) return "";
  if (looksLikeHugeDocumentBody(line) || looksLikeHtmlDocument(line)) return "";
  return truncate(line, BLOCK_REASON_MAX);
}

/**
 * 从 finish_task 入参 / 短错误回执抽出阻塞句。巨文档只当折叠物，不当理由。
 * @param {RunState} state
 * @returns {string[]}
 */
function extractBlockedConditionsFromTimeline(state) {
  const all = [...(state?.timeline ?? []), ...(state?.verifierTimeline ?? [])];
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.type === "tool_call" && e.name === "finish_task") {
      const input = e.input && typeof e.input === "object" ? /** @type {any} */ (e.input) : null;
      const blockers = Array.isArray(input?.blockers)
        ? input.blockers.map((x) => String(x).trim()).filter(Boolean)
        : [];
      if (blockers.length) return blockers;
      const summary = shortBlockLine(input?.summary);
      if (summary) return [summary];
    }
  }
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.type === "tool_result" && e.resultIsError) {
      const line = shortBlockLine(e.resultContent);
      if (line) return [line];
    }
  }
  return [];
}

/**
 * 对话面要画的阻塞清单。status/stopReason 不是 blocked 则不画卡
 * （partial 的未完成项仍走收官正文）。
 * @param {RunState} state
 * @returns {{title:string, conditions:string[], summary:string}|null}
 */
export function deriveBlockedFace(state) {
  const stop = String(state?.stopReason ?? "");
  const completion = state?.completion && typeof state.completion === "object"
    ? state.completion
    : null;
  const status = String(completion?.status ?? "");
  if (stop !== "blocked" && status !== "blocked") return null;
  const leftover = splitCompletionFollowUps(completion);
  let conditions = leftover.blocked.map((x) => String(x).trim()).filter(Boolean);
  if (conditions.length === 0 && Array.isArray(completion?.blockers)) {
    conditions = completion.blockers.map((x) => String(x).trim()).filter(Boolean);
  }
  if (conditions.length === 0) conditions = extractBlockedConditionsFromTimeline(state);
  if (conditions.length === 0) return null;
  return {
    title: "阻塞",
    conditions,
    summary: String(completion?.summary ?? "").trim(),
  };
}

/**
 * 阻塞卡挂在**最后一轮**产物后面（没有产物则在 run-next / 裁决前）。
 * 幂等：先摘掉旧卡再插一张。
 * @param {any[]} items
 * @param {RunState} state
 * @returns {any[]}
 */
export function applyBlockedCard(items, state) {
  const without = (items ?? []).filter((it) => it.kind !== "blocked");
  const face = deriveBlockedFace(state);
  if (!face) return without;
  const card = {
    kind: "blocked",
    title: face.title,
    conditions: face.conditions,
    summary: face.summary,
    seq: null,
    key: "blocked",
  };
  const artAt = without.findIndex((it) => it.kind === "artifacts");
  if (artAt >= 0) {
    without.splice(artAt + 1, 0, card);
    return without;
  }
  const runNextAt = without.findIndex((it) => it.kind === "run-next");
  if (runNextAt >= 0) {
    without.splice(runNextAt, 0, card);
    return without;
  }
  const verdictAt = without.findIndex((it) => it.kind === "verdict");
  if (verdictAt >= 0) {
    without.splice(verdictAt, 0, card);
    return without;
  }
  without.push(card);
  return without;
}

/** 连续工具收成一组：摘要滑动显示正在做的那一步，点开才铺逐条。 */
function collapseToolGroups(items) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    const tools = buf.filter((it) => it.kind === "tool");
    if (tools.length > 0) {
      out.push({ kind: "tools", tools, seq: tools[0].seq });
    } else {
      out.push(...buf);
    }
    buf = [];
  };
  for (const it of items) {
    if (it.kind === "tool" || it.kind === "gate") buf.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

export function deriveArtifacts(state) {
  // 注意**不能**复用 WRITE_TOOLS：那一组含 bash（它用来判"这轮返工有没有动过
  // 东西"），而 bash 没有 path 入参，混进来只会产生一堆空路径

  const results = new Map();
  for (const e of state.timeline ?? []) {
    if (e.type === "tool_result") results.set(e.toolUseId, e);
  }
  /** @type {Map<string, any>} */
  const byPath = new Map();
  for (const e of state.timeline ?? []) {
    if (e.type !== "tool_call" || !ARTIFACT_TOOLS.has(e.name)) continue;
    const input = e.input && typeof e.input === "object" ? e.input : {};
    const path = String(input.path ?? input.file_path ?? "").trim();
    if (!path) continue;
    const res = results.get(e.toolUseId);
    if (!res || res.resultIsError) continue; // 没成的不是产物
    const prev = byPath.get(path);
    byPath.set(path, {
      path,
      tool: e.name,
      seq: prev ? prev.seq : e.seq, // 保留首次出现的次序
      writes: (prev?.writes ?? 0) + 1,
    });
  }
  return [...byPath.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * 本批事件里被写盘工具**成功**触碰的路径——产物画布「运行中自动刷新」的判据。
 *
 * tool_call 先记 toolUseId → path（含历史 timeline 里的调用：结果可能落在
 * 后面的批次），tool_result 成功（result.isError 不为真）才把路径计入。
 * 同时把本批 tool_call 的路径直接计入——结果还没到时先刷一次（顶多拿到旧
 * 内容），结果落地的那批再刷一次；防抖在画布侧，这里只如实上报。
 *
 * @param {RunState|null|undefined} state 归约前的状态（历史 tool_call 在这里查）
 * @param {any[]} queue 本批 SSE 信封（{ event } 或裸事件都认）
 * @returns {string[]} 去重后的路径
 */
export function deriveWrittenPaths(state, queue) {
  /** @type {Map<string, string>} */
  const pathByCallId = new Map();
  const collectCall = (e) => {
    if (!e || e.type !== "tool_call" || !ARTIFACT_TOOLS.has(e.name) || !e.toolUseId) return;
    const input = e.input && typeof e.input === "object" ? e.input : {};
    const path = String(input.path ?? input.file_path ?? "").trim();
    if (path) pathByCallId.set(String(e.toolUseId), path);
  };
  for (const e of state?.timeline ?? []) collectCall(e);

  /** @type {Set<string>} */
  const written = new Set();
  for (const item of queue ?? []) {
    const e = item?.event ?? item;
    if (!e || typeof e !== "object") continue;
    collectCall(e);
    if (e.type === "tool_call") {
      // 结果未到的先计一次（见函数头注释）
      const path = pathByCallId.get(String(e.toolUseId ?? ""));
      if (path) written.add(path);
    } else if (e.type === "tool_result" && e.toolUseId) {
      const isError = Boolean(e.resultIsError ?? (e.result && typeof e.result === "object" ? e.result.isError : false));
      const path = pathByCallId.get(String(e.toolUseId));
      if (path && !isError) written.add(path);
    }
  }
  return [...written];
}

/** 会引起"换段"的事件类型：turn_start 这类噪声不该产生分界 */
const CHAT_SOURCED = new Set([
  "user_message", "assistant_text", "assistant_thinking", "tool_call", "approval_request",
]);

/**
 * 把对话条目渲染成 HTML。**对话是叙事，不是管道**：文字是主角，
 * 工具调用与返回折叠成一行摘要，需要时能展开但不淹没"它当时在说什么"。
 * @returns {string}
 */
export function renderChatStream(items, state) {
  if (!items || items.length === 0) {
    return state?.status === "running"
      ? '<p class="empty-note">刚开始，还没有内容。</p>'
      : '<p class="empty-note">这次运行没有产生对话内容。</p>';
  }
  return items.map((it) => renderChatItem(it)).join("");
}

/**
 * 是否像编排计划契约：`{ subtasks: [{ id, title, ... }] }`。
 * 判据按内容不按来源——planner 落进对话的裸 JSON 与日后别处同形状一并受益。
 */
export function looksLikePlanPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subs = value.subtasks;
  if (!Array.isArray(subs) || subs.length === 0) return false;
  return subs.every(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof t.id === "string" &&
      t.id.length > 0 &&
      typeof t.title === "string",
  );
}

/** 流式半截是否像在吐计划 JSON（宁可多判，也不要再铺一面墙） */
export function looksLikePlanJsonStream(text) {
  const t = String(text ?? "").trimStart();
  if (!t.startsWith("{")) return false;
  return /"subtasks"\s*:/.test(t.slice(0, 400));
}

/**
 * 从计划契约对象派生与 `derivePlanFace` 同形的「草稿面」——全部 pending，
 * 供对话卡在正式 `plan` 事件到达前也能画分层图。
 */
export function buildPlanDraftFace(parsed) {
  if (!looksLikePlanPayload(parsed)) return null;
  const subs = parsed.subtasks.map((t) => ({
    id: String(t.id),
    title: String(t.title ?? t.id),
    pack: t.pack == null ? null : String(t.pack),
    description: typeof t.description === "string" ? t.description : "",
    acceptance: Array.isArray(t.acceptance) ? t.acceptance.map(String) : [],
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    resources: Array.isArray(t.resources) ? t.resources.map(String) : [],
  }));
  const byId = new Map(subs.map((t) => [t.id, t]));
  const depth = new Map();
  const computing = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (computing.has(id)) return 0;
    computing.add(id);
    const t = byId.get(id);
    const d = !t || t.dependsOn.length === 0
      ? 0
      : Math.max(...t.dependsOn.map((p) => depthOf(p) + 1));
    computing.delete(id);
    depth.set(id, d);
    return d;
  };
  const nodes = subs.map((t) => ({
    ...t,
    depth: depthOf(t.id),
    status: "pending",
    durationMs: null,
    reworks: null,
    verdict: null,
  }));
  const layers = [];
  for (const n of nodes) (layers[n.depth] ??= []).push(n);
  return {
    concurrency: Number(parsed.concurrency ?? 1) || 1,
    concurrencyMode: String(parsed.concurrencyMode ?? "fixed"),
    plannerMs: 0,
    nodes,
    layers: layers.map((l) => l ?? []),
    parallelWidth: Math.max(1, ...layers.map((l) => (l ?? []).length)),
    maxDuration: 1,
    timing: null,
    completed: null,
    planned: true,
    plannerRaw: null,
    plannerRecovery: null,
    plannerFailure: null,
    warnings: [],
    skipped: [],
    gate: null,
  };
}

/**
 * 对话内的编排计划卡：分层 = 可并发语义；甘特条在有耗时时由 `renderPlanNode` 画出。
 * 原始 JSON 收进 `<details>`，默认不占视线。
 */
export function renderPlanChatCard(plan, { live = false, rawJson = null } = {}) {
  if (!plan || !plan.nodes?.length) return "";
  let html =
    `<div class="chat-plan${live ? " chat-plan--live" : ""}" role="group" aria-label="编排计划">` +
    `<div class="chat-plan-head">` +
    `<strong class="chat-plan-title">${live ? "正在整理编排计划" : "编排计划"}</strong>` +
    `<span class="chat-plan-meta">` +
    `${plan.nodes.length} 步 · 层宽 ${plan.parallelWidth}` +
    `${plan.concurrency ? ` · 并行度 ${plan.concurrency}` : ""}` +
    `</span></div>`;
  html += renderPlanReviewHtml(plan, { className: "chat-plan-layers" });
  if (rawJson) {
    html +=
      `<details class="chat-aside chat-plan-raw"><summary>查看原始 JSON</summary>` +
      `<pre class="md-code chat-plan-raw-pre">${esc(rawJson)}</pre></details>`;
  }
  html += "</div>";
  return html;
}

/**
 * 模型正文的渲染入口：散文走 Markdown；**编排计划契约走分层卡**；
 * 其余纯 JSON 仍走代码块 pretty-print。
 *
 * 动机演进：先是「裸 JSON 别当散文墙」（代码块）；委托方进一步要求
 * 「计划不要直接露 JSON，要流程图/甘特式可视化」——计划形状单独分支。
 * pretty-print / 卡片只发生在展示层，事件流原文不动。
 */
function renderAssistantText(text) {
  const t = String(text ?? "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      const draft = buildPlanDraftFace(parsed);
      if (draft) {
        return renderPlanChatCard(draft, {
          rawJson: JSON.stringify(parsed, null, 2),
        });
      }
      return renderMarkdown("```json\n" + JSON.stringify(parsed, null, 2) + "\n```");
    } catch {
      // 不是纯 JSON（散文里恰好以花括号开头）——按散文走
    }
  }
  return renderMarkdown(text);
}

/**
 * 直播文本：计划 JSON 流先出「整理中」卡，能 parse 后立刻换成分层图；
 * 其它 JSON 流仍走代码块围栏；散文走 Markdown。
 */
function renderLiveText(text) {
  const t = String(text ?? "");
  if (looksLikePlanJsonStream(t)) {
    try {
      const parsed = JSON.parse(t.trim());
      const draft = buildPlanDraftFace(parsed);
      if (draft) return renderPlanChatCard(draft, { live: true });
    } catch {
      // 半截 JSON
    }
    return (
      `<div class="chat-plan chat-plan--live" role="status">` +
      `<div class="chat-plan-head"><strong class="chat-plan-title">正在整理编排计划…</strong></div>` +
      `</div>`
    );
  }
  if (/^\s*[{[]/.test(t)) return renderMarkdown("```json\n" + t);
  return renderMarkdown(t);
}

function renderArtifactCard(f, runId) {
  const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(f.path)}`;
  const name = fileBasename(f.path);
  const short = fileShortPath(f.path);
  const kind = artifactKindLabel(f.path);
  const icon = artifactKindIcon(kind);
  const image = isImagePath(f.path);
  const primaryOpen = image || /\.html?$/i.test(f.path);
  const thumb = image
    ? `<a class="chat-artifact-thumb" href="${esc(href)}" data-canvas-open="${esc(f.path)}">` +
      `<img src="${esc(href)}" alt="${esc(name)}" loading="lazy" /></a>`
    : `<span class="chat-artifact-icon" aria-hidden="true"><i class="ph ${icon}"></i></span>`;
  const primary = primaryOpen
    ? `<button type="button" class="chat-artifact-primary" data-canvas-open="${esc(f.path)}">打开</button>`
    : `<button type="button" class="chat-artifact-primary" data-reveal="${esc(f.path)}">在文件夹中显示</button>`;
  const menu = [
    primaryOpen ? "" : `<button type="button" data-canvas-open="${esc(f.path)}">打开</button>`,
    `<a href="${esc(href)}&download=1">下载</a>`,
    primaryOpen ? `<button type="button" data-reveal="${esc(f.path)}">在文件夹中显示</button>` : "",
  ].filter(Boolean).join("");
  return (
    `<div class="chat-artifact" data-artifact-path="${esc(f.path)}">` +
    thumb +
    `<div class="chat-artifact-body">` +
    `<a class="chat-artifact-name" href="${esc(href)}" data-canvas-open="${esc(f.path)}" title="${esc(f.path)}">${esc(short)}</a>` +
    `<span class="chat-artifact-kind">${esc(kind)}</span>` +
    `</div>` +
    `<div class="chat-artifact-cta">` +
    primary +
    `<details class="chat-artifact-more">` +
    `<summary aria-label="更多操作"><i class="ph ph-caret-down" aria-hidden="true"></i></summary>` +
    `<div class="chat-artifact-menu" role="menu">${menu}</div>` +
    `</details></div></div>`
  );
}

/**
 * 对话内联产物卡。默认最多露出 ARTIFACT_PREVIEW_LIMIT 个（已按权重排过）；
 * 多出来的再点「显示全部」。对标 Cowork：一行一张卡，主操作在右侧。
 */
function renderChatArtifacts(it) {
  const runId = it.runId ?? null;
  const files = it.files ?? [];
  if (!runId || files.length === 0) return "";
  const featured = files.slice(0, ARTIFACT_PREVIEW_LIMIT);
  const rest = files.slice(ARTIFACT_PREVIEW_LIMIT);
  const list = featured.map((f) => renderArtifactCard(f, runId)).join("");
  const extra = rest.length
    ? `<details class="chat-artifacts-rest">` +
      `<summary>显示全部（还有 ${rest.length} 个）</summary>` +
      rest.map((f) => renderArtifactCard(f, runId)).join("") +
      `</details>`
    : "";
  return (
    // role="group" 让 aria-label 合法（裸 div 挂 aria-label 是 aria-prohibited-attr）
    `<div class="chat-artifacts" role="group" aria-label="本次产物">` +
    `<div class="chat-artifacts-list">${list}${extra}</div>` +
    `</div>`
  );
}

/** 收官后的编排计划 / 子代理：默认收成一行，点开看原卡。 */
function renderFoldedConversationChrome(folded, summary, inner) {
  if (!folded) return inner;
  return (
    `<details class="chat-aside chat-chrome-fold">` +
    `<summary>${esc(summary)}</summary>` +
    `<div class="chat-chrome-fold-body">${inner}</div></details>`
  );
}

function renderCompletionFolds(it) {
  const blocks = [
    ["验证", it.verification],
    ["假设与前提", it.assumptions],
  ];
  let html = "";
  for (const [title, items] of blocks) {
    if (!Array.isArray(items) || items.length === 0) continue;
    html +=
      `<details class="chat-aside chat-completion-fold">` +
      `<summary>${esc(title)} · ${items.length}</summary>` +
      `<ul class="chat-completion-fold-list">` +
      items.map((item) => `<li>${esc(item)}</li>`).join("") +
      `</ul></details>`;
  }
  return html;
}

function renderThinkingDetails(text, { open = false, live = false, redacted = false } = {}) {
  const cls = [
    "chat-thinking",
    live ? "chat-thinking--live" : "",
    redacted ? "chat-thinking--redacted" : "",
  ].filter(Boolean).join(" ");
  const summary = live
    ? `<span class="thinking-shimmer">Thinking</span><span class="thinking-shimmer thinking-shimmer-dots">...</span>`
    : "Thought Process";
  const body = redacted ? "（已省略）" : renderMarkdown(String(text ?? ""));
  const bodyCls = live ? "chat-body md chat-live-thinking" : "chat-body md";
  return (
    `<details class="${cls}"${open ? " open" : ""}>` +
    `<summary>${summary}</summary>` +
    `<div class="${bodyCls}">${body}</div></details>`
  );
}

/**
 * 单条对话条目。
 *
 * @param {any} it
 * @param {boolean} [thinkingOpen] 思考块是否默认展开——见 `THINKING_PREF_KEY`
 * @returns {string}
 */
export function renderChatItem(it, thinkingOpen = false) {
  {
    let html = "";
    switch (it.kind) {
      case "boundary":
        html += renderSegmentBoundary({ role: it.role, round: it.round ?? 0, source: it.source });
        break;
      case "user": {
        const { attachments } = splitUserMessageAttachments(it.text);
        const painted = paintConversationUserText(it.text);
        if (painted.kind === "receipt") {
          html += renderFoldedToolReceiptChip(painted.stub, it.text);
          break;
        }
        const runId = it.runId ?? null;
        const imageAtts = attachments.filter((p) => isImagePath(p) && runId);
        const previews = imageAtts
          .map((p) => {
            const href = `/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(p)}`;
            return (
              `<a class="chat-attach-preview" href="${esc(href)}" data-canvas-open="${esc(p)}" title="${esc(p)}">` +
              `<img src="${esc(href)}" alt="${esc(p)}" loading="lazy" /></a>`
            );
          })
          .join("");
        const captions = attachments
          .map((p) => `<div class="chat-attach-caption">附件：${esc(p)}</div>`)
          .join("");
        const folded = painted.kind === "document"
          ? foldConversationBody(splitUserMessageAttachments(it.text).displayBody || it.text)
          : null;
        const bodyHtml = folded
          ? `<div class="chat-body chat-body--text">${esc(folded.stub)}</div>`
          : painted.display
            ? `<div class="chat-body chat-body--text md">${renderMarkdown(painted.display)}</div>`
            : "";
        const foldHtml = folded ? folded.detailsHtml : "";
        const media = previews.length > 0;
        html +=
          `<div class="chat-msg chat-msg--user${media ? " chat-msg--user-media" : ""}">` +
          // 信息队列：运行中插队进来的指令，与正常追加区分开——它是"打断当前的思考"
          (it.steering ? `<div class="chat-msg-tag">插队指令</div>` : "") +
          (looksLikeChatFeedback(painted.display || it.text) ? `<div class="chat-msg-tag">反馈</div>` : "") +
          (it.executorSwitched ? `<div class="chat-msg-tag">已切换模型 · 正史已接上</div>` : "") +
          (previews ? `<div class="chat-attach-previews">${previews}</div>` : "") +
          (media || captions
            ? `<div class="chat-msg-user-copy">${captions}${bodyHtml}</div>`
            : bodyHtml) +
          foldHtml +
          `</div>`;
        break;
      }
      case "text": {
        const planShaped = isPlanShapedAssistantText(it.text);
        const folded = !planShaped ? foldConversationBody(it.text) : null;
        html +=
          `<div class="chat-msg chat-msg--assistant${planShaped ? " chat-msg--plan" : ""}">` +
          (folded
            ? `<div class="chat-body chat-body--text">${esc(folded.stub)}</div>${folded.detailsHtml}`
            : `<div class="chat-body${planShaped ? "" : " chat-body--text md"}">${renderAssistantText(it.text)}</div>`) +
          renderCompletionFolds(it) +
          `</div>`;
        break;
      }
      case "plan":
        html += renderFoldedConversationChrome(
          it.folded,
          `编排计划 · ${(it.plan?.nodes ?? []).length} 步`,
          `<div class="chat-msg chat-msg--assistant chat-msg--plan"><div class="chat-body">${renderPlanChatCard(it.plan)}</div></div>`,
        );
        break;
      case "agents":
        html += renderFoldedConversationChrome(
          it.folded,
          `子代理 · ${(it.agents ?? []).length}`,
          renderAgentsCard(it.agents ?? []),
        );
        break;
      case "thinking":
        html += renderThinkingDetails(it.text, {
          open: thinkingOpen,
          live: Boolean(it.live),
          redacted: Boolean(it.redacted),
        });
        break;
      /**
       * 正在流入的这一轮。思考在上、正文在下，与已落定的形态一致，
       * 所以它结束时被真正的条目接替不会有视觉跳变。
       *
       * 正文与落定条目走**同一支 Markdown**（委托方："流式输出的时候就是
       * markdown 形式"）。此前流式按纯文本、落定再换 Markdown——同一段字在
       * 结束瞬间整体变脸，那才是真正的跳变。当年顾虑的"半截记法抽搐"如今
       * 有两层缓冲：增量经匀速放行按帧批量落下（不是每个字一次重排），
       * 且渲染器对没闭合的围栏本就容忍（余下部分整体成码块，见
       * core/markdown.js 的围栏分支）。未闭合的行内记法保持字面，闭合瞬间
       * 才变换——这与最终形态是同向收敛，不是抖动。
       */
      case "live":
        if (String(it.thinking ?? "").trim() || it.waiting) {
          html += renderThinkingDetails(it.thinking, {
            open: thinkingOpen,
            live: true,
          });
        }
        if (String(it.text ?? "").trim()) {
          const planLive = looksLikePlanJsonStream(it.text);
          const folded = !planLive ? foldConversationBody(it.text) : null;
          html +=
            `<div class="chat-msg chat-msg--assistant chat-msg--live${planLive ? " chat-msg--plan" : ""}">` +
            (folded
              ? `<div class="chat-body chat-body--text chat-live-text">${esc(folded.stub)}</div>${folded.detailsHtml}</div>`
              : `<div class="chat-body${planLive ? "" : " chat-body--text md chat-live-text"}">${renderLiveText(it.text)}</div></div>`);
        }
        break;
      case "activity":
        html +=
          `<div class="chat-activity" role="status">` +
          `<span class="thinking-shimmer">正在</span> <code>${esc(it.name ?? "")}</code>` +
          (it.peek ? ` <span class="aside-peek">${esc(truncate(String(it.peek), 72))}</span>` : "") +
          `</div>`;
        break;
      case "notice":
        html +=
          `<div class="chat-activity chat-notice${it.live ? " chat-notice--live" : ""}" role="status">` +
          `<span class="${it.live ? "thinking-shimmer" : ""}">${esc(it.text)}` +
          (it.peek ? ` ${esc(it.peek)}` : "") +
          `</span></div>`;
        break;
      case "run-next":
        html +=
          `<div class="chat-run-next${it.live ? " chat-run-next--live" : ""}" role="status">` +
          `<div class="chat-run-next-title">` +
          (it.live ? `<span class="thinking-shimmer">${esc(it.title)}</span>` : esc(it.title)) +
          `</div>` +
          `<p class="chat-run-next-body">${esc(it.text)}</p>` +
          `</div>`;
        break;
      case "tools":
        html += renderToolGroup(it);
        break;
      case "tool":
        html += renderToolRow(it);
        break;
      case "gate":
        html += `<div class="chat-gate">⚠ ${esc(it.name)} 需要你放行</div>`;
        break;
      case "verdict":
        html += renderVerdictInline(it);
        break;
      case "artifacts":
        html += renderChatArtifacts(it);
        break;
      case "blocked": {
        const conditions = Array.isArray(it.conditions) ? it.conditions : [];
        const summary = String(it.summary ?? "").trim();
        html +=
          `<aside class="chat-blocked" role="status">` +
          `<div class="chat-blocked-head">${esc(it.title || "阻塞")}</div>` +
          (summary ? `<p class="chat-blocked-summary">${esc(summary)}</p>` : "") +
          (conditions.length
            ? `<ul class="chat-blocked-list">${conditions.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
            : "") +
          `</aside>`;
        break;
      }
      case "cite": {
        const refs = Array.isArray(it.refs) ? it.refs : [];
        const body = refs.map((ref) => {
          const files = Array.isArray(ref.artifacts) && ref.artifacts.length
            ? ref.artifacts.join("、")
            : "无主产物";
          return `${formatCiteChip({ title: ref.title, runId: ref.runId, workdirLabel: ref.workdirLabel })} · ${files}`;
        }).join("\n");
        html +=
          `<div class="chat-recap chat-cite" role="note">` +
          `<div class="chat-recap-head">引用的会话</div>` +
          `<p class="chat-recap-body">${esc(body)}</p>` +
          `</div>`;
        break;
      }
      case "sources": {
        const rows = Array.isArray(it.rows) ? it.rows : [];
        html +=
          `<aside class="chat-sources" role="region" aria-label="来源">` +
          `<div class="chat-sources-head">来源</div>` +
          `<div class="md-table-wrap"><table class="md-table chat-sources-table"><thead><tr>` +
          `<th>来源</th><th>该页说的</th><th>链接</th>` +
          `</tr></thead><tbody>` +
          rows.map((r) =>
            `<tr><td>${esc(r.title || "链接")}</td><td>${esc(r.quote || "")}</td>` +
            `<td><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></td></tr>`,
          ).join("") +
          `</tbody></table></div>` +
          `<button type="button" class="btn btn--ghost chat-sources-export" data-chat-action="export-sources">导出链接列表</button>` +
          `</aside>`;
        break;
      }
      case "recap": {
        const turns = Number(it.turns ?? 0);
        const head = turns > 0 ? `此前 ${turns} 轮` : "此前对话";
        html +=
          `<div class="chat-recap" role="note">` +
          `<div class="chat-recap-head">${esc(head)}</div>` +
          `<p class="chat-recap-body">${esc(it.text)}</p>` +
          `</div>`;
        break;
      }
      default:
        break;
    }
    if ((it.kind === "user" || it.kind === "text") && it.showActions) html += renderChatMsgActions(it);
    return html;
  }
}

/**
 * 一次工具调用 = 一行。**摘要必须一眼认得出这是在干什么**。
 *
 * 委托方截图里那行 `→ bash {` 就是反例：入参被 `JSON.stringify(…, null, 2)`
 * 美化过，取首行自然只剩一个左花括号——等于什么都没说。
 * 现在按工具的**主参数**取摘要（command / path / url / query…），取不到才退回紧凑 JSON。
 */
function renderToolGroup(it) {
  const tools = it.tools ?? [];
  const live = [...tools].reverse().find((t) => t.status === "running");
  const featured = live ?? tools[tools.length - 1];
  const err = tools.some((t) => t.status === "error");
  const cls = live ? " chat-tool-group--live" : err ? " chat-tool-group--err" : "";
  const headline = featured
    ? toolHeadline(featured.name, featured.input)
    : { verb: "", target: "", stages: [], command: "" };
  const mark = live ? "" : `<span class="aside-mark">${err ? "✗" : "✓"}</span>`;
  const command = featured ? toolCommandText(featured) : "";
  const commandFold = command && (looksLikeHugeDocumentBody(command) || looksLikeHtmlDocument(command))
    ? foldConversationBody(command, {
        path: toolPathHint(featured?.input),
        tool: featured?.name,
      })
    : null;
  const resultBody = !live && featured ? renderToolResultBody(featured) : "";
  return (
    `<details class="chat-tool-group${cls}">` +
    `<summary>${mark}${renderToolHeadline(headline, Boolean(live))}</summary>` +
    `<div class="chat-tool-group-body">` +
    (commandFold
      ? `<div class="chat-body chat-body--text">${esc(commandFold.stub)}</div>${commandFold.detailsHtml}`
      : (command ? `<pre class="chat-tool-now">${esc(truncate(command, 1200))}</pre>` : "")) +
    resultBody +
    `</div>` +
    `</details>`
  );
}

function renderToolRow(it) {
  const cls = it.status === "error" ? " chat-tool--err" : it.status === "running" ? " chat-tool--live" : "";
  const mark = it.status === "error" ? "✗" : it.status === "running" ? "⋯" : "✓";
  const dur = it.durationMs != null ? `<span class="aside-peek">${it.durationMs}ms</span>` : "";
  const gate = it.gated ? '<span class="chat-tool-gate" title="这一步曾等待人工放行">⚠ 经放行</span>' : "";
  const peek = esc(truncate(toolPeek(it.name, it.input), 88));
  const paths = renderToolPathStrip(it.input);
  const body = paths + renderToolResultBody(it);
  return (
    `<details class="chat-tool${cls}">` +
    `<summary><span class="aside-mark">${mark}</span> <code>${esc(it.name ?? "")}</code> ` +
    `<span class="aside-peek">${peek}</span> ${gate} ${dur}</summary>${body}</details>`
  );
}

function renderToolResultBody(it) {
  const candidate = toolBodyCandidate(it?.input, it?.result);
  const folded = foldConversationBody(candidate, {
    path: toolPathHint(it?.input),
    tool: it?.name,
    written: String(it?.name ?? "") === "write_file",
  });
  if (folded) {
    return `<div class="chat-body chat-body--text">${esc(folded.stub)}</div>${folded.detailsHtml}`;
  }
  if (it?.result) {
    return `<pre class="chat-body">${esc(truncate(String(it.result), 4000))}</pre>`;
  }
  const inputDump = formatInput(it?.input);
  if (looksLikeHugeDocumentBody(inputDump) || looksLikeHtmlDocument(inputDump)) {
    const via = foldConversationBody(inputDump, {
      path: toolPathHint(it?.input),
      tool: it?.name,
    });
    if (via) return `<div class="chat-body chat-body--text">${esc(via.stub)}</div>${via.detailsHtml}`;
  }
  return `<pre class="chat-body">${esc(truncate(inputDump, 1200))}</pre>`;
}

/** 各工具的"主参数"——摘要行只说这一个，别的展开再看 */
const TOOL_PEEK_KEYS = ["catalogId", "githubUrl", "writeTarget", "kind", "command", "path", "file_path", "url", "query", "name", "expression", "pattern"];

/**
 * 工具入参里哪些字段具有明确的“路径所有权”。
 *
 * 不解析 shell command：`cd a && node b.js` 不是路径，猜命令语义会把可执行文本
 * 误画成文件。只收结构化字段；最终仍由服务端按该 run 的 workdir + stat 确认。
 */
const TOOL_PATH_KEY = /(?:^|_)(?:path|paths|file|files|filename|filenames|dir|dirs|directory|directories|cwd|workdir|root)(?:$|_)/i;

/** @returns {string[]} */
export function toolPathCandidates(input) {
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value ?? "").trim();
    const key = clean.toLocaleLowerCase();
    if (!clean || seen.has(key) || !isLocalPathCandidate(clean)) return;
    seen.add(key);
    found.push(clean);
  };
  const visit = (value, key = "", inherited = false, depth = 0) => {
    if (found.length >= 16 || depth > 5 || value == null) return;
    const pathField = inherited || TOOL_PATH_KEY.test(key);
    if (typeof value === "string") {
      if (pathField) add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, pathField, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey, pathField || TOOL_PATH_KEY.test(childKey), depth + 1);
      if (found.length >= 16) break;
    }
  };

  if (typeof input === "string") add(input);
  else visit(input);
  return found;
}

function renderToolPathStrip(input) {
  const paths = toolPathCandidates(input);
  if (paths.length === 0) return "";
  return (
    '<div class="tool-path-strip" role="group" aria-label="工具涉及的路径">' +
    '<span class="tool-path-strip-label"><i class="ph ph-folder-simple" aria-hidden="true"></i>路径</span>' +
    paths.map((path) => `<code data-local-path="${esc(path)}">${esc(path)}</code>`).join("") +
    "</div>"
  );
}

export function toolPeek(name, input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return firstLine(input, 88);
  if (typeof input !== "object") return String(input);
  for (const k of TOOL_PEEK_KEYS) {
    const v = /** @type {any} */ (input)[k];
    if (typeof v === "string" && v.trim()) return firstLine(v, 88);
  }
  // 没有已知主参数时给紧凑单行 JSON——至少不是一个孤零零的花括号
  const compact = Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return firstLine(compact, 88);
}

const BASH_FLAG_WITH_ARG = new Set([
  "-e", "-E", "-f", "-m", "-C", "-t",
  "--regexp", "--file", "--max-count",
  "-name", "-iname", "-path", "-ipath", "-type", "-newermt", "-newer",
  "-mtime", "-ctime", "-atime", "-size", "-user", "-group",
  "-maxdepth", "-mindepth", "-printf",
  "--include", "--exclude",
]);

const TOOL_VERB = {
  read_file: "read",
  write_file: "write",
  write_pptx: "write",
  fetch_url: "fetch",
  describe_image: "看图",
  generate_image: "生图",
  memory_read: "记忆",
  memory_write: "记忆",
  memory_search: "记忆",
};

function tokenizeShell(s) {
  const out = [];
  let cur = "";
  let quote = null;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "\\" && i + 1 < str.length) {
      cur += str[++i];
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    if (c === "|") {
      if (cur) { out.push(cur); cur = ""; }
      out.push("|");
      continue;
    }
    if (c === "&" && str[i + 1] === "&") {
      if (cur) { out.push(cur); cur = ""; }
      out.push("&&");
      i++;
      continue;
    }
    if (c === ";" || (c === "&" && str[i + 1] !== "&")) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(";");
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function cleanHeadlineTarget(t) {
  let s = String(t ?? "").trim();
  if (!s || /^[0-9]*[<>]/.test(s) || s === "2>&1") return "";
  if (/[\\/]/.test(s) && s !== "/" && s !== ".") {
    s = s.split(/[\\/]/).filter(Boolean).pop() ?? s;
  }
  return truncate(s.replace(/^\^/, "").replace(/\$$/, ""), 28);
}

function stageHeadline(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const raw = tokens[i] ?? "";
  const verb = (raw.split(/[\\/]/).pop() ?? raw).replace(/\.(exe|cmd|bat)$/i, "");
  i++;
  let target = "";
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "2>&1" || tok === ">" || tok === ">>" || tok === "<") {
      i += tok === "2>&1" ? 1 : 2;
      continue;
    }
    if (tok.startsWith("-")) {
      const takes = BASH_FLAG_WITH_ARG.has(tok);
      if (takes && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
        if (!target && /^-([eE]|name|iname|path|ipath)$|^--regexp$/.test(tok)) {
          target = cleanHeadlineTarget(tokens[i + 1]);
        }
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (!target) target = cleanHeadlineTarget(tok);
    break;
  }
  return { verb, target };
}

function toolCommandText(t) {
  if (!t) return "";
  const name = String(t.name ?? "").replace(/^.*__/, "");
  if (name === "bash" || name === "shell") {
    const cmd = typeof t.input === "string" ? t.input : t.input?.command ?? "";
    return String(cmd);
  }
  if (t.input == null) return "";
  if (typeof t.input === "string") return t.input;
  return formatInput(t.input);
}

/**
 * 工具摘要只留动词 + 对象，不把整条命令（含 2>&1、长正则、管道尾巴）铺在对话里。
 * @returns {{verb:string, target:string, stages:{verb:string,target:string}[], command:string}}
 */
export function toolHeadline(name, input) {
  const tool = String(name ?? "").replace(/^.*__/, "");
  if (tool === "bash" || tool === "shell") {
    const cmd = typeof input === "string" ? input : input?.command ?? "";
    const tokens = tokenizeShell(String(cmd).replace(/\b2>&1\b/g, " "));
    const stages = [];
    let buf = [];
    const flush = () => {
      if (buf.length) {
        stages.push(stageHeadline(buf));
        buf = [];
      }
    };
    for (const tok of tokens) {
      if (tok === "|" || tok === "&&" || tok === ";" || tok === "||") flush();
      else buf.push(tok);
    }
    flush();
    const parts = stages.filter((s) => s.verb).slice(0, 2);
    return {
      verb: parts[0]?.verb ?? "bash",
      target: parts[0]?.target ?? "",
      stages: parts,
      command: firstLine(cmd, 400),
    };
  }
  const peek = toolPeek(name, input);
  const verb = TOOL_VERB[tool] ?? tool;
  const target = cleanHeadlineTarget(peek);
  return { verb, target, stages: [{ verb, target }], command: peek };
}

function renderToolHeadline(headline, live) {
  const stages = headline.stages?.length
    ? headline.stages
    : [{ verb: headline.verb, target: headline.target }];
  const inner = stages
    .map((s) =>
      `<span class="tool-kw">${esc(s.verb)}</span>` +
      (s.target ? ` <span class="tool-target">${esc(s.target)}</span>` : ""),
    )
    .join('<span class="tool-kw-sep"> · </span>');
  return `<span class="tool-headline${live ? " thinking-shimmer" : ""}">${inner}</span>`;
}

/** 裁决卡：一段的收尾，就地出现在对话里而不是另一个标签页 */
function renderVerdictInline(it) {
  const v = it.verdict ?? {};
  const tone = v.passed ? (v.issues?.length ? "warn" : "ok") : "bad";
  const label = v.passed ? (v.issues?.length ? "通过（有备注）" : "核查通过") : "核查未通过";
  const list = (arr, mark, cls) =>
    arr && arr.length
      ? `<ul class="chat-verdict-list chat-verdict-list--${cls}">${arr
          .map((x) => `<li class="md-inline">${mark} ${renderMarkdownInline(x)}</li>`)
          .join("")}</ul>`
      : "";
  // 裁决只对它核查的那一轮对话负责——轮号必须与结论并列显示，不能让"通过"
  // 看起来像是整场对话的通过（判的是哪一轮 = 这份裁决的适用范围）
  const judged =
    it.judgedTurn != null
      ? `<span class="aside-peek chat-verdict-turn" data-judged-turn="${Number(it.judgedTurn)}">判第 ${Number(it.judgedTurn)} 轮对话</span>`
      : "";
  return (
    `<div class="chat-verdict chat-verdict--${tone}">` +
    `<div class="chat-verdict-head">◆ ${esc(label)}` +
    judged +
    (it.round ? `<span class="aside-peek">返工第 ${it.round} 轮</span>` : "") +
    "</div>" +
    (v.summary ? `<p class="md-inline chat-verdict-summary">${renderMarkdownInline(v.summary)}</p>` : "") +
    list(v.issues, v.passed ? "⚠" : "✗", "bad") +
    list(v.unverified, "?", "warn") +
    list(v.advisory, "◈", "note") +
    "</div>"
  );
}

/** 取首行并截断——折叠摘要上给一眼能认出是什么的线索 */
function firstLine(text, max) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return truncate(line.trim(), max);
}

/**
 * 角色显示名（只在渲染层）。事件流 / 台账仍用 planner / main / verifier。
 * 不要署剧名：计划卡就叫计划，提问卡就叫助手。
 */
export const ROLE_PERSONA = {
  planner: "计划",
  main: "助手",
  rework: "助手",
  verifier: "核查",
};

/** 段分界：main→verifier 用 ━，返工用 CLI 同款 ↺（src/cli.ts:449） */
function renderSegmentBoundary(seg) {
  const label = {
    verifier: `${ROLE_PERSONA.verifier} · 全新上下文独立复核`,
    rework: `${ROLE_PERSONA.rework} · 核查未通过，返工（第 ${seg.round} 轮）`,
    planner: `${ROLE_PERSONA.planner} · 只读拆解`,
    main: `${ROLE_PERSONA.main} · 执行`,
  }[seg.role];
  const mark = seg.role === "rework" ? "↺" : seg.role === "verifier" ? "◆" : seg.role === "planner" ? "❑" : "▸";
  // 编排模式下来源形如 "s1/main"：并行时多个子任务的日志按 seq 交错，
  // 不标出子任务 id 就完全读不懂谁在说话
  const src = String(seg.source ?? "");
  const stepId = src.includes("/") ? src.slice(0, src.indexOf("/")) : null;
  const step = stepId ? `<code class="segment-step">${esc(stepId)}</code> ` : "";
  return `<div class="segment-boundary segment-boundary--${seg.role}"><span class="segment-mark">${mark}</span>${step}<span class="segment-label">${esc(label)}</span></div>`;
}

function patchUsageFooter(parts, state) {
  if (parts.usage) {
    setAttr(parts.usage, "hidden", "");
    parts.usage.innerHTML = "";
  }
  if (parts.drawer) setAttr(parts.drawer, "hidden", "");
}


/**
 * 用量脚注（V-07）。
 *
 * 口径是这里的全部要点。旧版把最后一条 done 的 usage 当成整个 run 的开销——
 * 返工场景下那只是最后一轮，主轮与 verifier 的花费全部漏计。现在优先用
 * executionUsage（全部执行轮合计，含被否掉的中间轮），核查开销单列，
 * 每个数字都带口径标注：界面上不出现没有口径的数字。
 * @returns {string}
 */
function renderUsageFooterBody(state) {
  const exec = state.runEnd && state.runEnd.executionUsage;
  const verify = state.runEnd && state.runEnd.verificationUsage;
  const cost = deriveCostFace(state);

  if (!exec && !state.usage && !cost) return "";

  let html = "";
  if (exec) {
    html += `<span class="usage-item">执行（全部轮次合计）：${exec.turns} 轮 · 入 ${formatTokens(exec.inputTokens)} · 出 ${formatTokens(exec.outputTokens)}</span>`;
    if (verify && verify.turns > 0) {
      html += `<span class="usage-item">核查：${verify.turns} 轮 · 入 ${formatTokens(verify.inputTokens)} · 出 ${formatTokens(verify.outputTokens)}</span>`;
    }
    if (state.runEnd.reworks) {
      html += `<span class="usage-item">返工 ${state.runEnd.reworks} 轮</span>`;
    }
    const denom = exec.inputTokens + exec.cacheCreationTokens + exec.cacheReadTokens;
    if (denom > 0) {
      html += `<span class="usage-item">缓存命中 ${((exec.cacheReadTokens / denom) * 100).toFixed(0)}%</span>`;
    }
  } else if (state.usage) {
    // 运行中：只有段级数据，标注清楚它不是全程合计
    html += `<span class="usage-item">本段：${state.usage.turns} 轮 · 入 ${formatTokens(state.usage.inputTokens)} · 出 ${formatTokens(state.usage.outputTokens)}</span>`;
    html += `<span class="usage-item">缓存命中 ${(state.usage.cacheHitRatio * 100).toFixed(0)}%</span>`;
  }
  // OBS-02：钱与 token 并排。算不出价时这一格写"为什么"，不写 $0.00
  if (cost) {
    html += `<span class="usage-item usage-item--cost${cost.known ? "" : " usage-item--unknown"}" title="${esc(cost.title)}">${esc(cost.text)}</span>`;
  }
  return html;
}

/** @returns {string} */
function renderApprovalCards(state, isRunning) {
  let html = `<div class="approval-cards">`;
  for (const app of state.pendingApprovals) {
    const isPending = app.status === "pending";
    const operable = isPending && isRunning;
    const resolved = !isPending;

    // 卡片身份用 approvalId（toolUseId#requestSeq）：返工轮复用同一 toolUseId，
    // 只有它能把"这一轮的卡"和"上一轮的历史卡"区分开（V-03）
    const cardId = app.approvalId || app.toolUseId;

    html += `<div class="approval-card ${resolved ? "approval-card--resolved" : ""}" data-approval-id="${esc(cardId)}">`;
    html += `<div class="approval-card-header">`;
    html += `<span class="approval-tool-name">${esc(describeApprovalAction(app.name, app.input))}</span>`;

    if (resolved) {
      const decisionLabel =
        app.status === "allowed" ? "已允许" :
        app.status === "denied" ? "已拒绝" : "已过期";
      const decisionClass =
        app.status === "allowed" ? "approval-result--allow" :
        app.status === "denied" ? "approval-result--deny" : "approval-result--expired";
      html += `<span class="approval-result ${decisionClass}">${decisionLabel}</span>`;
    }
    html += `</div>`;

    html += `<p class="approval-summary">${esc(describeApprovalAction(app.name, app.input))}</p>`;
    html += `<details class="approval-details"><summary>详情</summary><pre class="approval-input">${esc(formatInput(app.input))}</pre></details>`;

    if (operable) {
      html += `<div class="approval-actions">`;
      html += `<button class="btn btn--allow" data-action="allow" data-approval-id="${esc(cardId)}">允许</button>`;
      html += `<button class="btn btn--deny" data-action="deny" data-approval-id="${esc(cardId)}">拒绝</button>`;
      // aria-label 而非只靠 placeholder：placeholder 虽按 accname 规范算兜底名称，
      // 但输入后即从视觉上消失，屏幕阅读器用户失去上下文
      html += `<input class="deny-reason" data-approval-id="${esc(cardId)}" aria-label="拒绝 ${esc(app.name)} 的理由（可选）" placeholder="拒绝理由（可选）" />`;
      html += `</div>`;
    } else if (resolved) {
      if (app.decidedAt) {
        html += `<div class="approval-meta">${formatTime(app.decidedAt)}</div>`;
      }
      if (app.reason) {
        html += `<div class="approval-reason">理由：${esc(app.reason)}</div>`;
      }
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

/** @returns {string} */
function renderOverviewTab(overview, state) {
  let html = "";

  // 最终状态徽章（醒目）+ 补救提示（V-04）
  const isRunning = overview.finalStatus === "running";
  const cls = isRunning ? classifyStopReason(null) : deliveryFace(state.stopReason, deriveArtifacts(state));
  const statusLabel = isRunning ? "运行中" : cls.label;
  const statusCls = isRunning ? "status--live" : toneClass(cls.tone);
  html += `<div class="overview-status">`;
  html += `<span class="status-badge status-badge--lg ${statusCls}">${esc(statusLabel)}</span>`;
  // 说明这次终止意味着什么、下一步能做什么——"撞轮次护栏"这类结局，
  // 光给一个标签用户还是不知道该怎么办
  if (cls.hint) html += `<div class="status-hint">${esc(cls.hint)}</div>`;
  html += `</div>`;

  // 结果摘要
  if (overview.resultSummary) {
    html += `<div class="overview-section">`;
    html += `<h3 class="overview-section-title">结果摘要</h3>`;
    html += `<div class="overview-summary-text">${esc(overview.resultSummary)}</div>`;
    html += `</div>`;
  }

  // finish_task 的证据字段必须在 UI 可见；只显示 summary 会把结构化契约又压回散文。
  if (overview.completion) {
    const groups = [
      ["产物", overview.completion.artifacts],
      ["验证", overview.completion.verification],
      ["假设与前提", overview.completion.assumptions],
    ].filter(([, items]) => Array.isArray(items) && items.length > 0);
    if (groups.length > 0) {
      html += `<div class="overview-section"><h3 class="overview-section-title">结构化交付</h3>`;
      for (const [label, items] of groups) {
        html += `<div class="overview-summary-text"><strong>${esc(label)}</strong><ul class="action-items">`;
        for (const item of items) html += `<li>${esc(item)}</li>`;
        html += `</ul></div>`;
      }
      html += `</div>`;
    }
  }

  // 验证结论
  if (overview.verdict) {
    html += renderVerdictCard(overview.verdict);
  }

  // 需介入事项
  const hasActionItems =
    overview.actionItems.pendingApprovals.length > 0 ||
    overview.actionItems.unverifiedItems.length > 0 ||
    overview.actionItems.blockers.length > 0;
  if (hasActionItems) {
    html += `<div class="overview-section overview-section--action">`;
    html += `<h3 class="overview-section-title">⚠ 需介入事项</h3>`;
    html += `<ul class="action-items">`;
    for (const a of overview.actionItems.pendingApprovals) {
      html += `<li class="action-item action-item--approval">⚠ 待审批：${esc(a.name)} — ${esc(truncate(formatInput(a.input), 80))}</li>`;
    }
    for (const u of overview.actionItems.unverifiedItems) {
      html += `<li class="action-item action-item--unverified">⋯ 待复核：${esc(u)}</li>`;
    }
    const leftover = splitCompletionFollowUps(overview.completion ?? { blockers: overview.actionItems.blockers });
    for (const item of leftover.unfinished) {
      html += `<li class="action-item action-item--unverified">⋯ 未完成：${esc(item)}</li>`;
    }
    for (const blocker of leftover.blocked) {
      html += `<li class="action-item action-item--blocked">⚠ 阻塞：${esc(blocker)}</li>`;
    }
    html += `</ul>`;
    html += `</div>`;
  }

  // 已处理审批（只读记录，不静默丢失）
  if (overview.resolvedApprovals && overview.resolvedApprovals.length > 0) {
    html += `<div class="overview-section">`;
    html += `<h3 class="overview-section-title">审批记录</h3>`;
    html += `<ul class="action-items">`;
    for (const a of overview.resolvedApprovals) {
      const label = a.status === "allowed" ? "已允许" : a.status === "denied" ? "已拒绝" : "已过期";
      const reasonSuffix = a.reason ? ` — ${esc(a.reason)}` : "";
      html += `<li class="action-item action-item--resolved">${label}：${esc(a.name)}${reasonSuffix}</li>`;
    }
    html += `</ul>`;
    html += `</div>`;
  }

  // 错误醒目
  if (state.error) {
    html += `<div class="error-banner">⚠ ${esc(state.error)}</div>`;
  }

  // 无结果时显示提示
  if (!overview.resultSummary && !overview.verdict && !hasActionItems && !state.error) {
    html += `<div class="overview-placeholder">运行中，暂无结果摘要…</div>`;
  }

  return html;
}

// renderLogTab 已移除：日志面板改为 patchLogPanel 的增量追加，
// 不再有"把整份日志拼成一段 HTML"这一步（那正是 O(n²) 与滚动跳动的来源）。
// 区块标题 "Agent 执行" 移到 patchTabContent 的骨架里（委托方 §12 文案不变）。

/** @returns {string} */
function renderLogEntry(e) {
  const collapsed = e.collapsed;
  const headerHtml = renderLogEntryHeader(e, collapsed);
  const bodyHtml = collapsed ? "" : renderLogEntryBody(e);

  let cls = "log-entry";
  if (e.type === "tool_result" && e.resultIsError) cls += " log-entry--error";
  if (e.type === "approval_request") cls += " log-entry--approval";
  if (e.type === "api_retry") cls += " log-entry--warning";
  if (e.type === "model_call_end" && e.status === "error") cls += " log-entry--warning";
  if (e.type === "model_fallback") cls += " log-entry--warning";
  if (e.type === "recovery_decision") cls += " log-entry--warning";
  if (e.type === "run_forked") cls += " log-entry--warning";
  if (e.type === "run_resumed") cls += " log-entry--warning";
  if (e.type === "compaction") cls += " log-entry--warning";
  if (e.type === "hook" && (e.outcome === "error" || e.outcome === "block")) cls += " log-entry--warning";
  if (collapsed) cls += " log-entry--collapsed";

  // 折叠的工具调用也必须看得到路径入口：路径条独立于 body，避免用户为了打开
  // 一个文件先展开整块 JSON；同时避开在 role=button 的 header 里嵌套链接。
  const pathHtml = e.type === "tool_call" ? renderToolPathStrip(e.input) : "";
  return `<div class="${cls}" data-seq="${e.seq}">
    ${headerHtml}
    ${pathHtml}
    ${bodyHtml}
  </div>`;
}

/** @returns {string} */
function renderLogEntryHeader(e, collapsed) {
  const icon = entryIcon(e.type, e.resultIsError);
  const action = entryActionLabel(e);
  const detail = entryDetail(e);
  // V-12：耗时用可读格式（此前原样输出 `124757ms`，人得自己心算成 2 分钟）
  const duration = e.durationMs != null ? formatDuration(e.durationMs) : "";
  const expandIcon = collapsed ? "▸" : "▾";

  // action / detail 在此统一 esc，entryActionLabel 内部不得再 esc 一次
  // （V-16：双重转义会把工具参数里的引号显示成 &amp;quot;）
  return `<div class="log-entry-header" data-seq="${e.seq}" tabindex="0" role="button" aria-expanded="${!collapsed}">
    <span class="log-entry-expand">${expandIcon}</span>
    <span class="log-entry-icon">${icon}</span>
    <span class="log-entry-action">${esc(action)}</span>
    <span class="log-entry-detail">${esc(detail)}</span>
    ${duration ? `<span class="log-entry-duration">${esc(duration)}</span>` : ""}
  </div>`;
}

/** @returns {string} */
function renderLogEntryBody(e) {
  switch (e.type) {
    case "tool_call":
      return `<pre class="log-entry-body">${esc(formatInput(e.input))}</pre>`;
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
    case "tool_failed":
    case "tool_aborted":
      return `<div class="log-entry-body">idempotencyKey=<code>${esc(e.idempotencyKey ?? "")}</code>${
        e.skipped ? "<br>skipped duplicate commit" : ""
      }${e.reason ? `<br>${esc(e.reason)}` : ""}${
        e.inputHash ? `<br>inputHash=<code>${esc(String(e.inputHash).slice(0, 16))}…</code>` : ""
      }</div>`;
    case "mid_tool_replay": {
      const items = Array.isArray(e.items) ? e.items : [];
      const summary = items
        .map((item) => `${item.action}:${item.name || item.toolUseId}`)
        .join(" · ");
      return `<div class="log-entry-body">SAFE-06 mid-tool · ${esc(summary || "（空计划）")}</div>`;
    }
    case "tool_result":
      return `<pre class="log-entry-body">${esc(e.resultContent ?? "")}</pre>`;
    case "assistant_text":
      // 模型散文走 Markdown 渲染（委托方反馈：原样显示 **粗体**/- 列表是噪声）。
      // renderMarkdown 内部先整体转义再变换，此处不能再 esc 一次——那会双重转义（V-16）
      return `<div class="log-entry-body log-entry-text md">${renderMarkdown(e.text ?? "")}</div>`;
    case "approval_request":
      return `<pre class="log-entry-body">${esc(formatInput(e.input))}</pre>`;
    case "assistant_thinking":
      return e.redacted
        ? '<div class="log-entry-body log-thinking">服务端已加密该段思考（redacted），内容取不到——但它确实发生过。</div>'
        : `<div class="log-entry-body log-thinking md">${renderMarkdown(e.text ?? "")}</div>`;
    case "segment_resume":
      return `<div class="log-entry-body">整段因瞬时故障终止，已带着之前 ${esc(String(e.priorTurns ?? "?"))} 轮的会话正史接着跑（不是从头重来）。<br>原因：${esc(e.reason ?? "")}</div>`;
    case "plan_replan": {
      const bits = [
        e.kept?.length ? `保留 ${e.kept.length}` : null,
        e.added?.length ? `新增 ${e.added.length}` : null,
        e.changed?.length ? `改写 ${e.changed.length}` : null,
        e.dropped?.length ? `删掉 ${e.dropped.length}` : null,
      ].filter(Boolean);
      return `<div class="log-entry-body">按委托方新要求重规划${bits.length ? `（${esc(bits.join(" · "))}）` : ""}。<br>原因：${esc(e.reason ?? "")}</div>`;
    }
    case "plan_resume": {
      const bits = [
        e.kept?.length ? `跳过已通过 ${e.kept.length}` : null,
        e.remaining?.length ? `续发射 ${e.remaining.length}` : null,
      ].filter(Boolean);
      return `<div class="log-entry-body">按落盘节点续发射半截计划${bits.length ? `（${esc(bits.join(" · "))}）` : ""}。<br>已通过：${esc((e.kept ?? []).join("、") || "无")}；待跑：${esc((e.remaining ?? []).join("、") || "无")}</div>`;
    }
    case "spawn_start":
      return `<div class="log-entry-body">开调查支线：${esc(e.title ?? "")}（扣本 run 谱系预算，深度 1）${
        e.runId
          ? `<br><button type="button" class="linkish" data-open-run="${esc(e.runId)}">进入子对话</button>`
          : ""
      }</div>`;
    case "spawn_done":
      return `<div class="log-entry-body">${e.passed ? "支线完成" : "支线未完成"}：${esc(e.title ?? "")}${
        e.summary ? `<br>${esc(String(e.summary).slice(0, 240))}` : ""
      }${e.error ? `<br>错误：${esc(e.error)}` : ""}${
        typeof e.turns === "number" ? `<br>轮次：${esc(String(e.turns))}` : ""
      }${e.runId ? `<br><button type="button" class="linkish" data-open-run="${esc(e.runId)}">进入子对话</button>` : ""}</div>`;
    case "campaign_child":
      return `<div class="log-entry-body">子对话 ${esc(e.title ?? "")} · ${esc(e.status ?? "")}${
        e.runId
          ? ` · <button type="button" class="linkish" data-open-run="${esc(e.runId)}">进入子对话</button>`
          : ""
      }</div>`;
    case "api_retry":
      // 等待时长要看得见：抖动之后同一 attempt 的等待不再是定值，
      // 只显示"第几次重试"会让人以为退避是固定的
      return `<div class="log-entry-body">原因：${esc(e.reason ?? "")}${
        typeof e.backoffMs === "number" ? `<br>退避等待：${esc(formatDuration(e.backoffMs))}（含抖动）` : ""
      }</div>`;
    case "model_call_start":
      return `<div class="log-entry-body">第 ${esc(String(e.turn ?? "?"))} 轮 · 第 ${esc(String((e.attempt ?? 0) + 1))} 次发送</div>`;
    case "model_call_end":
      return `<div class="log-entry-body">${e.status === "ok" ? "成功" : "失败"} · ${esc(
        typeof e.durationMs === "number" ? formatDuration(e.durationMs) : "?",
      )}</div>`;
    case "model_fallback":
      // 三件事都要写出来：换到了哪家、为什么离开上一家、这之后的输出归谁。
      {
        const roleLabel = e.role && e.role !== "executor" ? `（角色 ${esc(e.role)}）` : "（主执行者）";
        return `<div class="log-entry-body">端点${roleLabel}从 <code>${esc(e.from ?? "")}</code> 换到 <code>${esc(
          e.to ?? "",
        )}</code>（第 ${esc(String(e.turn ?? "?"))} 次模型调用）。<br>离开原因：${esc(
          fallbackReasonText(e.reason),
        )}${e.routing ? `<br>路由策略：${esc(e.routing)}` : ""}<br>此后该角色的输出由新端点产生。</div>`;
      }
    case "recovery_decision":
      return `<div class="log-entry-body">${esc(e.detail ?? "")}${
        typeof e.extraTurns === "number" ? `<br>追加额度：${esc(String(e.extraTurns))} 轮` : ""
      }</div>`;
    case "file_rewind_snapshot":
      return `<div class="log-entry-body">${esc(e.path ?? "")}` +
        `${e.existed ? ` · ${esc(String(e.bytes ?? 0))} 字节` : " · 当时还不存在"}` +
        `${e.skipped ? ` · 未存镜像（${esc(e.skipped)}）` : ""}</div>`;
    case "conversation_rewound": {
      const bits = [];
      if (e.revertFiles) bits.push("连改动一起退");
      if (e.restored?.length) bits.push(`还原 ${e.restored.length} 个`);
      if (e.deleted?.length) bits.push(`删除 ${e.deleted.length} 个`);
      if (e.gitRestored?.length) bits.push(`git 退回 ${e.gitRestored.length} 个`);
      if (e.skipped?.length) bits.push(`未还原 ${e.skipped.length} 个`);
      return `<div class="log-entry-body">父运行 <code>${esc(e.parentRunId ?? "")}</code> · 裁到 seq ${esc(String(e.rewindSeq ?? ""))}` +
        `${bits.length ? `<br>${esc(bits.join("；"))}` : ""}</div>`;
    }
    case "run_forked": {
      const budget = e.inheritedBudget ?? {};
      const budgetText = [
        budget.maxTurns != null ? `轮次 ${budget.usedTurns ?? 0}/${budget.maxTurns}` : `已用轮次 ${budget.usedTurns ?? 0}`,
        budget.maxTokens != null ? `token ${budget.usedTokens ?? 0}/${budget.maxTokens}` : `已用 token ${budget.usedTokens ?? 0}`,
      ].join("；");
      return `<div class="log-entry-body">${esc(e.boundary ?? "")}` +
        `<br>直接父运行：<code>${esc(e.parentRunId ?? "")}</code>` +
        `<br>继承总账：${esc(budgetText)}` +
        `${Array.isArray(e.reset) && e.reset.length ? `<br>已重置：${esc(e.reset.join("、"))}` : ""}</div>`;
    }
    case "run_resumed": {
      const budget = e.inheritedBudget ?? {};
      const budgetText = [
        budget.maxTurns != null ? `轮次 ${budget.usedTurns ?? 0}/${budget.maxTurns}` : `已用轮次 ${budget.usedTurns ?? 0}`,
        budget.maxTokens != null ? `token ${budget.usedTokens ?? 0}/${budget.maxTokens}` : `已用 token ${budget.usedTokens ?? 0}`,
      ].join("；");
      return `<div class="log-entry-body">${esc(e.boundary ?? "")}` +
        `<br>同 run：<code>${esc(e.runId ?? "")}</code>` +
        (e.segmentIndex != null ? `<br>检查点段号：${esc(String(e.segmentIndex))}` : "") +
        `<br>继承总账：${esc(budgetText)}` +
        `${Array.isArray(e.reset) && e.reset.length ? `<br>未恢复：${esc(e.reset.join("、"))}` : ""}</div>`;
    }
    case "compaction":
      return `<div class="log-entry-body">${e.reactive ? "反应式（撞上下文超长 400 后重发同一轮）· " : ""}丢弃 ${e.droppedBlocks ?? "?"} 个块` +
        (e.collapsedTurns ? ` · 折叠 ${e.collapsedTurns} 轮旧对话` : "") +
        (typeof e.ledgerEntries === "number" ? ` · 账本 ${e.ledgerEntries} 条` : "") +
        (e.summaryApplied ? " · 已合并 LLM 摘要" : "") +
        `</div>`;
    case "hook":
      return `<div class="log-entry-body">${esc(e.hook ?? "")}${e.tool ? ` · ${esc(e.tool)}` : ""} · ${esc(e.outcome ?? "")}` +
        (e.timedOut ? " · 超时" : e.exitCode != null ? ` · exit ${esc(String(e.exitCode))}` : "") +
        (e.detail ? `<br>${esc(e.detail)}` : "") +
        `</div>`;
    default:
      return "";
  }
}

/** @returns {string} */
function entryIcon(type, isError) {
  // 一律用**单色排印符**，不用 emoji。
  //
  // 理由不是审美：emoji 是自带调色板的彩色字形，CSS `color` 对它们无效，
  // 因此它们无法参与主题系统——浅色暖底上尤其像贴上去的异物。排印符继承
  // currentColor，明暗两套主题里都跟着语义色走。
  //
  // 符号表同时向 CLI 收敛（src/cli.ts:512-591），Web 与终端看到的是同一套记号。
  switch (type) {
    case "turn_start": return "──";      // cli.ts:516
    case "tool_call": return "→";        // cli.ts:527
    case "tool_prepared": return "⬡";
    case "tool_running": return "⬡";
    case "tool_committed": return "⬡";
    case "tool_failed": return "⬡";
    case "tool_aborted": return "⬡";
    case "mid_tool_replay": return "↻";
    case "tool_result": return isError ? "✗" : "✓"; // cli.ts:530-531
    case "assistant_text": return "¶";   // CLI 直接流式打印无标记，列表里需要一个
    case "assistant_thinking": return "✽"; // 与对话视图同款，自成语域
    case "approval_request": return "⚠"; // cli.ts:539
    case "api_retry": return "⟳";        // cli.ts:563
    case "model_call_start": return "▷";
    case "model_call_end": return "■";
    case "segment_resume": return "⟲";   // 与 ⟳(同轮重试) 区分：这是整段续跑
    case "plan_replan": return "⧉";
    case "plan_resume": return "↺";
    case "spawn_start": return "⧉";
    case "spawn_done": return "⧉";
    case "model_fallback": return "⇄";   // 前两个换的是时机，这个换的是端点（cli.ts 同款）
    case "recovery_decision": return "⤷";
    case "run_forked": return "↗";
    case "conversation_rewound": return "↩";
    case "file_rewind_snapshot": return "▣";
    case "run_resumed": return "↺";
    // CLI 对压缩也用 ⚠，这里刻意分开：V-19 要求不可逆自成语域，
    // 与普通警告共用符号会让人对它脱敏
    case "compaction": return "⊟";
    case "hook": return "‡";
    case "user_message": return "✎";
    // 信息队列：插队是"插到正在想的这一轮前面"，排队是"排在这一轮后面"
    case "steering": return "⇢";
    case "message_queued": return "◷";
    case "message_queue_updated": return "◷";
    default: return "·";
  }
}

/** @returns {string} */
function entryActionLabel(e) {
  // 这里一律返回**未转义**的纯文本，转义由 renderLogEntryHeader 统一做（V-16）
  switch (e.type) {
    case "turn_start": return `第 ${e.turn ?? "?"} 轮`;
    case "tool_call": return e.name ?? "";
    case "tool_prepared": return `${e.name ?? ""} prepared`;
    case "tool_running": return `${e.name ?? ""} running`;
    case "tool_committed":
      return `${e.name ?? ""} committed${e.skipped ? " (skipped)" : ""}`;
    case "tool_failed": return `${e.name ?? ""} tx failed`;
    case "tool_aborted": return `${e.name ?? ""} tx aborted`;
    case "mid_tool_replay":
      return `mid-tool 重放（${Array.isArray(e.items) ? e.items.length : 0}）`;
    // name 由 deriveLogEntries 按 toolUseId 回填；真取不到才退回 id（V-12）
    case "tool_result": return `${e.name ?? e.toolUseId ?? ""} ${e.resultIsError ? "失败" : "成功"}`;
    case "assistant_text": return "助手消息";
    case "assistant_thinking":
      return e.redacted ? "思考过程（已加密）" : `思考过程（${(e.text ?? "").length} 字）`;
    case "approval_request": return `审批请求：${e.name ?? ""}`;
    case "api_retry": return `API 重试（第${e.attempt ?? "?"}次）`;
    case "model_call_start": return `模型请求开始（第${(e.attempt ?? 0) + 1}次）`;
    case "model_call_end": return e.status === "error" ? "模型请求失败" : "模型请求结束";
    case "segment_resume": return `瞬时失败后带正史续跑（已完成 ${e.priorTurns ?? "?"} 轮）`;
    case "plan_replan": {
      const bits = [
        e.kept?.length ? `保留 ${e.kept.length}` : null,
        e.added?.length ? `新增 ${e.added.length}` : null,
        e.changed?.length ? `改写 ${e.changed.length}` : null,
        e.dropped?.length ? `删掉 ${e.dropped.length}` : null,
      ].filter(Boolean);
      return `重规划${bits.length ? `（${bits.join(" · ")}）` : ""}`;
    }
    case "plan_resume": {
      const bits = [
        e.kept?.length ? `跳过 ${e.kept.length}` : null,
        e.remaining?.length ? `续跑 ${e.remaining.length}` : null,
      ].filter(Boolean);
      return `半截计划续发射${bits.length ? `（${bits.join(" · ")}）` : ""}`;
    }
    case "spawn_start": return `支线开始：${e.title ?? ""}`;
    case "spawn_done": return `支线${e.passed ? "完成" : "未完成"}：${e.title ?? ""}`;
    case "model_fallback": return `端点降级${e.role && e.role !== "executor" ? `[${e.role}]` : ""}：${e.from ?? "?"} → ${e.to ?? "?"}`;
    case "recovery_decision": {
      const labels = {
        request_completion: "要求业务收口",
        continue_with_context: "同上下文有界续跑",
        change_strategy: "检测停滞，要求换策略",
        force_completion: "强制结构化收口",
      };
      return labels[e.action] ?? "恢复路由";
    }
    case "run_forked": return "从归档检查点派生";
    case "conversation_rewound": return e.revertFiles ? "已回退对话和改动" : "已回退对话";
    case "file_rewind_snapshot": return e.existed ? `记下改前文件 ${e.path ?? ""}` : `记下新建文件 ${e.path ?? ""}`;
    case "run_resumed": return "同运行热恢复";
    case "compaction": return "上下文压缩";
    case "hook": {
      const who = e.tool ? `${e.hook ?? "hook"} ${e.tool}` : (e.hook ?? "hook");
      if (e.outcome === "block") return `${who} 阻断`;
      if (e.outcome === "error") return `${who} 错误`;
      return `${who} 放行`;
    }
    case "usage": return "本轮用量";
    case "user_message":
      return `追加指令（第 ${e.turn ?? "?"} 轮对话${e.verify === true ? "，本轮核查" : e.verify === false ? "，本轮不核查" : ""}）`;
    case "steering": return "插队指令（已注入正在运行的思考）";
    case "message_queued":
      return e.mode === "steer" ? "插队指令已受理（下一轮模型调用前生效）" : "指令已排队（本轮结束后自动发送）";
    case "message_queue_updated": return "排队消息更新";
    default: return e.type;
  }
}

/**
 * 降级原因的人话。`circuit_open` 是 L0 的内部标记，不是端点回的错误码——
 * 原样显示会让人以为上游返回了一个叫 circuit_open 的东西，从而去查错方向。
 * 摘要行与展开体共用这一处，两处各写一遍就是"同一件事两种说法"的开始。
 * @returns {string}
 */
function fallbackReasonText(reason) {
  if (reason === "circuit_open") return "上一个端点仍在熔断隔离期，本次直接跳过";
  if (reason === "probe_unhealthy") return "粘性探针标为不健康，prefer_healthy 跳过";
  return reason ?? "";
}

/** @returns {string} */
function entryDetail(e) {
  switch (e.type) {
    case "tool_call":
      return truncate(formatInput(e.input), 60);
    case "tool_prepared":
    case "tool_running":
    case "tool_committed":
      return truncate(e.idempotencyKey ?? "", 48);
    case "tool_failed":
      return truncate(e.reason ?? "", 60);
    case "tool_aborted":
      return truncate(e.idempotencyKey ?? "", 48);
    case "tool_result":
      return truncate(e.resultContent ?? "", 60);
    case "assistant_text":
      return truncate(e.text ?? "", 80);
    case "approval_request":
      return truncate(formatInput(e.input), 60);
    case "api_retry":
      return e.reason ?? "";
    case "model_call_start":
      return `第 ${e.turn ?? "?"} 轮`;
    case "model_call_end":
      return e.status === "error" ? "失败" : "成功";
    case "model_fallback":
      return fallbackReasonText(e.reason);
    case "recovery_decision":
      return e.detail ?? e.reason ?? "";
    case "run_forked":
      return e.boundary ?? "";
    case "run_resumed":
      return e.boundary ?? "";
    case "plan_resume":
      return (e.remaining ?? []).join("、") || (e.kept ?? []).join("、");
    case "user_message":
      return truncate(e.text ?? "", 80);
    case "steering":
      return truncate(e.text ?? "", 80);
    case "message_queued":
      return truncate(e.text ?? "", 60);
    case "message_queue_updated":
      return e.sendError ?? "";
    case "hook":
      return e.detail ?? (e.timedOut ? "超时" : e.outcome === "block" ? "阻断" : "");
    default:
      return "";
  }
}

/** @returns {string} */
function renderVerifyTab(state, face) {
  let html = "";

  // Verification 面恒在：没跑核查本身就是一条信息，不是一个空白。
  // 界面要说清"为什么没有裁决"——是没开核查，还是执行根本没跑完导致核查
  // 压根没机会运行。后者尤其重要：那种情形下"没有裁决"绝不等于"没问题"。
  if (!state.verdict && state.verifierTimeline.length === 0) {
    if (!state.verify) {
      html += '<div class="callout callout--info"><strong>本次运行未开启独立核查</strong>' +
        "<p>提交任务时勾选「开启独立核查」，会由一个全新上下文的核查 Agent 重读产物并出具三值裁决。</p></div>";
    } else {
      const cls = classifyStopReason(state.stopReason);
      html += '<div class="callout callout--warn"><strong>核查未运行</strong>' +
        `<p>已开启独立核查，但执行段以 <code>${esc(state.stopReason ?? "未知")}</code>（${esc(cls.label)}）终止，核查没有机会执行。<strong>没有裁决不等于没有问题</strong>——这一类失败核查救不了。</p></div>`;
    }
    return html;
  }

  // 三类饥饿告警分开列，不混成一条——它们指向不同的根因层，混在一起就没法归因
  if (face) {
    const s = face.starvation;
    if (s.noWhitelist) {
      html += '<div class="callout callout--warn"><strong>⚠ verifier 处于无白名单状态</strong>' +
        "<p>本包未声明 <code>verify.readOnlyCommands</code>，核查者撞上审批门只能被拒——它无法亲手重跑门禁，只能靠间接证据。这正是案例 #4 那次 22 轮空转的配置形态。</p></div>";
    }
    if (s.emptyRework.length > 0) {
      html += `<div class="callout callout--warn"><strong>⚠ 第 ${s.emptyRework.join("、")} 轮返工零写入</strong>` +
        "<p>被否之后的返工段里没有任何写类工具调用，疑似核查饥饿（fail-closed 的第三种误伤形态）：模型在重新证明已经为真的东西，而不是修东西。</p></div>";
    }
    if (s.parseFail) {
      html += '<div class="callout callout--bad"><strong>⚠ 裁决解析失败</strong>' +
        "<p>verifier 的输出不是可解析的 JSON 裁决，被 fail-closed 判为未通过。这是误伤，不是真的核查不过。</p></div>";
    }
  }

  // 核查结论（如果存在）
  if (state.verdict) {
    html += renderVerdictCard(state.verdict);
  }

  // 逐轮裁决（V-08：末轮之外的中间轮也保留）
  if (face && face.rounds.length > 1) {
    html += '<h3 class="overview-section-title">逐轮裁决</h3><ol class="verify-rounds">';
    for (const r of face.rounds) {
      const mark = r.verdict?.passed ? "✔" : "✘";
      const issues = r.verdict?.issues?.length ?? 0;
      html += `<li class="verify-round verify-round--${r.verdict?.passed ? "ok" : "bad"}">` +
        `<span class="round-mark">${mark}</span> 第 ${r.round + 1} 次核查` +
        (issues ? `：${issues} 项不符` : "") +
        (r.verdict?.summary ? `<span class="round-summary">${esc(r.verdict.summary)}</span>` : "") +
        "</li>";
    }
    html += "</ol>";
  }

  // 核查者的能力边界——deny 消息即教学，白名单即边界说明书
  if (face) {
    /**
     * 裁决获得路径（§2.1 前置）：裁决是"首轮直接给的"还是"靠兜底救回来的"，
     * 这件事本身就是信号——救回来的那些说明核查者收口不稳，而不是产物有问题。
     * 也是 fail-closed 三种误伤形态第一次可计量。
     * （措辞避开"核查"+"过程"连写：那是 v1 的旧标签名，AC7 文案门禁仍在禁它。）
     */
    const recoveries = face.rounds.map((r) => r.recovery).filter(Boolean);
    /**
     * §2.1 之后**健康路径有两条**：tool（走终结工具交付，新的理想路径）与
     * direct（末条消息恰好可解析，端点不认强制工具时的形态）。
     * 这个集合必须跟着 VerdictRecovery 走——漏一个值，那条运行就会被界面
     * 说成"收口不稳"，而它其实一切正常（V-04：界面不得对委托方说谎）。
     */
    const HEALTHY_RECOVERY = new Set(["tool", "direct"]);
    if (recoveries.length > 0 && recoveries.some((r) => !HEALTHY_RECOVERY.has(r))) {
      const label = {
        tool: "首轮直接交付（结构化）",
        direct: "首轮直接给出",
        wrapup: "预算用尽后收口续跑救回",
        reformat: "重问转写救回",
        failed: "兜底未救回（fail-closed）",
      };
      html += '<h3 class="overview-section-title">裁决获得路径</h3><ul class="unverified-list">';
      html += face.rounds
        .map((r, i) => `<li>第 ${r.round ?? i} 轮：${esc(label[r.recovery] ?? String(r.recovery ?? "—"))}</li>`)
        .join("");
      html += "</ul><p class=\"rail-note\">有轮次靠兜底才拿到裁决，说明核查者收口不稳——问题出在核查这一环，不是产物本身。</p>";
    }

    html += '<h3 class="overview-section-title">核查者的边界</h3><dl class="boundary-list">';
    html += `<dt>只读白名单</dt><dd>${
      face.whitelist.length
        ? esc(face.whitelist.join("、")) +
          (whitelistSourceLabel(face.whitelistSource) ? ` <small>（${esc(whitelistSourceLabel(face.whitelistSource))}）</small>` : "")
        : "（空——只能读文件，无法重跑门禁）"
    }</dd>`;
    // 不再写"固定"：9.1 之后领域包可用 verify.maxTurns 覆盖，
    // 而"这个数从哪来"决定了人要不要去改它
    html += `<dt>核查预算</dt><dd>${face.budgetTurns ?? "—"} 轮${
      face.budgetSource === "pack"
        ? "（领域包声明）"
        : face.budgetSource === "env"
          ? "（AGENT_VERIFY_MAX_TURNS 覆盖）"
          : "（默认；与执行者的 maxTurns 解耦）"
    }</dd>`;
    html += `<dt>评分表来源</dt><dd>${face.rubricSource ? esc(face.rubricSource) : "（未注入——advisory 恒为空）"}</dd>`;
    html += "</dl>";
  }

  // 核查时间线（使用日志卡片风格）
  if (state.verifierTimeline.length > 0) {
    html += `<div class="verify-timeline">`;
    html += `<h3 class="overview-section-title">◆ 核查 Agent 过程</h3>`;
    for (const e of state.verifierTimeline) {
      const logEntry = { ...e, collapsed: defaultCollapsed(e) };
      html += renderLogEntry(logEntry);
    }
    html += `</div>`;
  }

  if (!state.verdict && state.verifierTimeline.length === 0) {
    html += `<div class="log-empty">暂无核查记录。</div>`;
  }

  return html;
}

/** @returns {string} */
function renderVerdictCard(v) {
  const badge = v.passed
    ? '<span class="verdict-badge verdict-badge--pass">✔ 核查通过</span>'
    : '<span class="verdict-badge verdict-badge--fail">✘ 核查未通过</span>';
  let html = `<div class="verdict-card">`;
  html += `<div class="verdict-header">${badge}<span class="verdict-summary md-inline">${renderMarkdownInline(v.summary)}</span></div>`;

  if (v.issues.length > 0) {
    html += `<div class="verdict-section verdict-section--issues">`;
    html += `<div class="verdict-section-title">✗ 客观项不符</div>`;
    html += `<ul>${v.issues.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.unverified.length > 0) {
    html += `<div class="verdict-section verdict-section--unverified">`;
    html += `<div class="verdict-section-title">⋯ 待委托方复核</div>`;
    html += `<ul>${v.unverified.map((s) => `<li>⋯ ${esc(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }
  if (v.advisory.length > 0) {
    html += `<div class="verdict-section verdict-section--advisory">`;
    html += `<div class="verdict-section-title">◈ 评审意见</div>`;
    html += `<ul>${v.advisory.map((s) => `<li class="md-inline">◈ ${renderMarkdownInline(s)}</li>`).join("")}</ul>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/**
 * 编码脸空态是作业清单，不是教具三字。点一下填进输入框，不直接开跑。
 */
export const CODE_STARTER_JOBS = [
  {
    id: "plan",
    label: "从计划开始",
    hint: "先对齐做法，再动代码",
    text: "先对齐做法再动代码：看清这个仓库后，列出你打算改什么、怎么验收，等我同意再动手。",
    plan: true,
  },
  {
    id: "survey",
    label: "看看这个仓库",
    hint: "用一段话说明项目在做什么",
    text: "看看当前工作目录里有哪些源文件，用一段话说明这个项目在做什么。",
  },
  {
    id: "fix-test",
    label: "修一处并跑通测试",
    hint: "改代码，用测试当判据",
    text: "找一处值得修的地方改掉，用相关测试当判据，跑通后告诉我结果。",
  },
];

/** Work 脸第一屏：稿件 / 纪要 / 出处，不是仓库作业。 */
export const OFFICE_STARTER_JOBS = [
  {
    id: "minutes",
    label: "做纪要",
    hint: "把材料收成可转发的短纪要",
    text: "根据当前工作目录里最近的材料，写一份短纪要：结论、待办、未决问题各一段。",
  },
  {
    id: "page",
    label: "做一页",
    hint: "一页介绍，浏览器里预览",
    text: "做一页介绍：主题自拟，相对 CSS，不要外链。写完告诉我打开哪里预览。",
  },
  {
    id: "sources",
    label: "带出处问答",
    hint: "回答时列出来说 / 该页说的 / 链接",
    text: "按我的问题查资料并回答。每个要点都带来源：该页说的、链接。没有出处就标明不确定。",
  },
];

/** @deprecated 教具三字已退役；兼容旧 import，内容就是编码作业。 */
export const EXAMPLE_TASKS = CODE_STARTER_JOBS;

/** 空态画廊只露出前三条。 */
export const STARTER_EXAMPLE_TASKS = CODE_STARTER_JOBS;

/** 开会话时选的 design 模板（画布顶条不再放模板） */
export const DESIGN_STARTER_TEMPLATES = [
  {
    id: "deck-basic",
    title: "多页幻灯",
    hint: "封面主张，可导出 PPTX",
    prompt: "用多页幻灯做一套介绍：主题自拟，一页一个主张。",
  },
  {
    id: "social-basic",
    title: "社媒方图",
    hint: "三张 1080，可发朋友圈",
    prompt: "做三张 1080 方图，适合朋友圈或社媒轮播。",
  },
  {
    id: "landing-basic",
    title: "单页落地",
    hint: "一页介绍，浏览器里预览",
    prompt: "用落地页做一页介绍：主题自拟，不要外链。",
  },
];

export const OFFICE_MORE_DRAFTS = Object.freeze({
  id: "more",
  title: "更多稿件",
  hint: "原型、看板、邮件和其他样子",
});

export function designTemplateById(id) {
  return DESIGN_STARTER_TEMPLATES.find((t) => t.id === id) ?? null;
}

export const DESIGN_LOOKS = Object.freeze([
  Object.freeze({ id: "ink", label: "墨水", prompt: "墨水 / ink", bg: "#0f1419", fg: "#f4f1ea", accent: "#3b82f6" }),
  Object.freeze({ id: "paper", label: "暖纸", prompt: "暖纸 / paper", bg: "#f4f1ea", fg: "#1a1814", accent: "#b0522f" }),
  Object.freeze({ id: "night", label: "夜色", prompt: "夜色 / night", bg: "#0b1020", fg: "#e8eefc", accent: "#7dd3fc" }),
  Object.freeze({ id: "meadow", label: "草地", prompt: "草地 / meadow", bg: "#f3f6ef", fg: "#1e2a1c", accent: "#3f7d4e" }),
  Object.freeze({ id: "terracotta", label: "陶土", prompt: "陶土 / terracotta", bg: "#2a1812", fg: "#f6ebe4", accent: "#c15f3c" }),
]);

const LOOK_CLAUSE_RE = /\s*色板用「[^」]+」。\s*$/;

export function designLookById(id) {
  return DESIGN_LOOKS.find((l) => l.id === id) ?? null;
}

export function stripLookClause(text) {
  return String(text ?? "").replace(LOOK_CLAUSE_RE, "").trimEnd();
}

export function sampleTakesLook(sample) {
  return sample?.template === "deck-basic" || sample?.template === "social-basic";
}

export function promptTakesLook(text) {
  const t = stripLookClause(text);
  return /deck-basic|social-basic|data-look|多页幻灯|介绍幻灯|封面主张|杂志风幻灯|三点汇报|社媒方图|1080/.test(t);
}

export function composePromptWithLook(prompt, lookId) {
  const base = stripLookClause(prompt).trim();
  const look = designLookById(lookId);
  if (!base || !look || !promptTakesLook(base)) return base;
  return `${base} 色板用「${look.prompt}」。`;
}

export function isDesignTemplatePrompt(text) {
  const t = stripLookClause(text).trim();
  return DESIGN_STARTER_TEMPLATES.some((item) => item.prompt === t);
}

/**
 * 新建对话空态：FATHOM hero（徽记 + 字标 + 主标语）。
 * 模板与示例在 #starter-gallery（提交栏下方），由 renderStarterGallery 单独画。
 */
export function renderEmptyState(_hasRuns, _opts = {}) {
  const mainEl = document.getElementById("main-area");
  if (!mainEl) return;
  const designClass = _opts.designModeActive ? " empty-state--design" : "";
  mainEl.innerHTML =
    `<div class="empty-state empty-state--welcome${designClass}">` +
    '<p class="empty-eyebrow">Agent Console</p>' +
    '<span class="empty-mark" aria-hidden="true">' +
    '<svg class="fathom-plumb" width="46" height="46" viewBox="0 0 24 24">' +
    '<line class="fathom-tick" x1="6" y1="2.5" x2="6" y2="21.5" stroke-width="1"/>' +
    '<line class="fathom-tick" x1="6" y1="5.2" x2="9.6" y2="5.2" stroke-width="1.1"/>' +
    '<line class="fathom-tick" x1="6" y1="9.4" x2="9.6" y2="9.4" stroke-width="1.1"/>' +
    '<line class="fathom-tick" x1="6" y1="13.6" x2="9.6" y2="13.6" stroke-width="1.1"/>' +
    '<line class="fathom-tick" x1="6" y1="17.8" x2="9.6" y2="17.8" stroke-width="1.1"/>' +
    '<line class="fathom-line" x1="16.6" y1="2.5" x2="16.6" y2="14" stroke-width="1.6"/>' +
    '<circle class="fathom-bob" cx="16.6" cy="17.4" r="1.9"/>' +
    "</svg></span>" +
    '<p class="empty-brand">FATHOM<span class="fw-dot">.</span></p>' +
    '<p class="empty-tagline">说要做什么，回车就发。</p>' +
    '<p class="empty-tagline-cn">稿件、纪要、问答都可以从这里开始。</p>' +
    '<p class="empty-window-note">现在只能在这个窗口下指令。</p>' +
    '<p class="empty-cite-hint">输入 @ 可按文件名找这个文件夹里的文件。旧对话用「引用会话」。</p>' +
    '<span class="empty-depthline" aria-hidden="true"></span>' +
    "</div>";
}

/** 设计模式六页签。进入后先出页签 chip，再展开该页签下的样例卡。 */
export const DESIGN_MODE_TABS = Object.freeze([
  "Prototype",
  "Live Artifact",
  "Deck",
  "Template",
  "Media",
  "Other",
]);

/** 页签内部值保持英文（路由 / data-design-tab）；界面只显示中文。 */
export const DESIGN_MODE_TAB_LABELS = Object.freeze({
  Prototype: "原型",
  "Live Artifact": "实时产物",
  Deck: "幻灯",
  Template: "模板",
  Media: "媒体",
  Other: "其他",
});

export function designTabLabel(tab) {
  return DESIGN_MODE_TAB_LABELS[tab] || tab;
}

/**
 * 设计模式空态样例卡（UI only）。页签 3–5 张，缩略图用 CSS 迷你版式。
 * designId 走现有注册表；template 填本地种子目录名。
 */
export const DESIGN_SAMPLE_CARDS = Object.freeze([
  Object.freeze({
    id: "proto-free",
    tab: "Prototype",
    title: "自由风格",
    thumb: "blank",
    designId: "web-prototype",
    template: null,
    prompt: "从空白做一页网页原型：主题自拟，相对 CSS，不要外链 CDN。",
  }),
  Object.freeze({
    id: "proto-landing",
    tab: "Prototype",
    title: "落地主视觉",
    thumb: "landing",
    designId: "saas-landing",
    template: "landing-basic",
    prompt: "用 landing-basic 落地页模板做一页介绍：主题自拟，相对 CSS，不要外链 CDN。",
  }),
  Object.freeze({
    id: "proto-mobile",
    tab: "Prototype",
    title: "移动应用",
    thumb: "mobile",
    designId: "mobile-app",
    template: null,
    prompt: "做一款移动应用原型：手机装框，启动后是主界面，相对 CSS，不要外链 CDN。",
  }),
  Object.freeze({
    id: "proto-3d",
    tab: "Prototype",
    title: "三维对象",
    thumb: "cube",
    designId: "3d-object",
    template: null,
    prompt: "做一个可交互的三维对象页：自包含 HTML，shader 或 WebGL 场景，相对资源。",
  }),
  Object.freeze({
    id: "live-free",
    tab: "Live Artifact",
    title: "自由风格",
    thumb: "blank",
    designId: "dashboard",
    template: null,
    prompt: "从空白做一块管理台：侧栏加主区，主题自拟，相对 CSS。",
  }),
  Object.freeze({
    id: "live-ops",
    tab: "Live Artifact",
    title: "运营看板",
    thumb: "dashboard",
    designId: "dashboard",
    template: null,
    prompt: "做一块运营看板：关键指标、近期动态和一张简表，带侧栏。",
  }),
  Object.freeze({
    id: "live-metrics",
    tab: "Live Artifact",
    title: "分析台",
    thumb: "dashboard",
    designId: "dashboard",
    template: null,
    prompt: "做一块分析台：趋势图占位、转化漏斗和分面筛选。",
  }),
  Object.freeze({
    id: "live-monitor",
    tab: "Live Artifact",
    title: "监控墙",
    thumb: "dashboard",
    designId: "dashboard",
    template: null,
    prompt: "做一块监控墙：服务健康、延迟和告警列表。",
  }),
  Object.freeze({
    id: "deck-free",
    tab: "Deck",
    title: "自由风格",
    thumb: "blank",
    designId: "html-ppt",
    template: "deck-basic",
    prompt: "做一套介绍幻灯：主题自拟，一页一个主张。",
  }),
  Object.freeze({
    id: "deck-cover",
    tab: "Deck",
    title: "封面主张",
    thumb: "deck",
    designId: "guizang-ppt",
    template: "deck-basic",
    prompt: "做一套封面主张幻灯：大标题加一句导语，再补要点与收束。",
  }),
  Object.freeze({
    id: "deck-magazine",
    tab: "Deck",
    title: "杂志风",
    thumb: "magazine",
    designId: "guizang-ppt",
    template: "deck-basic",
    needsImages: true,
    prompt: "做一套杂志风幻灯：封面有刊头和大图，内页分栏。",
  }),
  Object.freeze({
    id: "deck-bullets",
    tab: "Deck",
    title: "要点页",
    thumb: "bullets",
    designId: "html-ppt",
    template: "deck-basic",
    prompt: "做一套三点汇报幻灯：封面、要点、收束各一页。",
  }),
  Object.freeze({
    id: "doc-free",
    tab: "Template",
    title: "空白文档",
    thumb: "blank",
    designId: null,
    template: null,
    prompt: "从空白写一份文档页：标题、目录和正文，HTML 可预览。",
  }),
  Object.freeze({
    id: "doc-spec",
    tab: "Template",
    title: "产品规格",
    thumb: "doc",
    designId: "pm-spec",
    template: "pm-spec",
    prompt: "写一份产品规格：含目录、需求与决策日志，HTML 单页。",
  }),
  Object.freeze({
    id: "doc-spec-deck",
    tab: "Template",
    title: "规格 + 幻灯",
    thumb: "doc",
    designId: "spec-plus-deck",
    template: null,
    prompt: "写一份产品规格，并做成三页汇报幻灯。",
  }),
  Object.freeze({
    id: "doc-okr",
    tab: "Template",
    title: "团队 OKR",
    thumb: "okr",
    designId: "team-okrs",
    template: "team-okrs",
    prompt: "做一张团队 OKR 记分卡：目标、关键结果和进度。",
  }),
  Object.freeze({
    id: "doc-finance",
    tab: "Template",
    title: "财务摘要",
    thumb: "doc",
    designId: "finance-report",
    template: null,
    prompt: "做一份管理层财务摘要：收入、支出和要点结论。",
  }),
  Object.freeze({
    id: "media-free",
    tab: "Media",
    title: "社媒方图",
    hint: "三张 1080，可发朋友圈",
    thumb: "poster",
    designId: "social-carousel",
    template: "social-basic",
    prompt: "做三张 1080 方图，适合朋友圈或社媒轮播。",
  }),
  Object.freeze({
    id: "media-poster",
    tab: "Media",
    title: "杂志海报",
    hint: "一张 1080 方图",
    thumb: "poster",
    designId: "magazine-poster",
    template: "social-basic",
    prompt: "做一张 1080 杂志海报：大标题加一句导语。",
  }),
  Object.freeze({
    id: "media-email",
    tab: "Media",
    title: "营销邮件",
    thumb: "email",
    designId: "email-marketing",
    template: null,
    prompt: "做一封营销邮件：表格降级安全，有页头、正文和行动号召。",
  }),
  Object.freeze({
    id: "media-motion",
    tab: "Media",
    title: "动效画幅",
    thumb: "motion",
    designId: "motion-frames",
    template: null,
    prompt: "做一段循环 CSS 动效主视觉：单页，不要外链库。",
  }),
  Object.freeze({
    id: "other-free",
    tab: "Other",
    title: "自由风格",
    thumb: "blank",
    designId: "critique",
    template: null,
    prompt: "从空白做一张自评或清单页：主题自拟。",
  }),
  Object.freeze({
    id: "other-critique",
    tab: "Other",
    title: "自评表",
    thumb: "check",
    designId: "critique",
    template: null,
    prompt: "做一张五维自评记分表：可勾选、有简短评语栏。",
  }),
  Object.freeze({
    id: "other-tweaks",
    tab: "Other",
    title: "微调清单",
    thumb: "check",
    designId: "tweaks",
    template: null,
    prompt: "列一份微调面板清单：把可调的视觉参数写成控件列表。",
  }),
]);

export function designSamplesForTab(tab) {
  return DESIGN_SAMPLE_CARDS.filter((s) => s.tab === tab);
}

export function designSampleById(id) {
  return DESIGN_SAMPLE_CARDS.find((s) => s.id === id) ?? null;
}

export function resolveDesignSampleChoice(sampleId) {
  const sample = designSampleById(sampleId);
  if (!sample) return null;
  return {
    sampleId: sample.id,
    designId: sample.designId || null,
    designTemplate: sample.template || null,
    prompt: sample.prompt,
    needsImages: Boolean(sample.needsImages),
  };
}

/** 识图没配时，「要配图」样例不能空跑。未传入快照时不禁用（测试/首屏）。 */
export function harnessVisionConfigured(harness) {
  const backing = harness?.describeImageBacking;
  if (backing === "executor" || backing === "vision-role") return true;
  if (backing === "none") return false;
  return Boolean(harness?.roleModels?.vision?.configured);
}

export function designSampleBlockedReason(sample, visionConfigured) {
  if (!sample?.needsImages || visionConfigured !== false) return "";
  return "未配置识图，这类要配图的样例不能空跑";
}

export function isDesignSamplePrompt(text) {
  const t = stripLookClause(text).trim();
  return DESIGN_SAMPLE_CARDS.some((item) => item.prompt === t);
}

/** 点样例卡之后的 composer 状态。输入已有人写的字不覆盖。 */
export function nextDesignSampleState(sampleId, prev = {}, { toggle = false } = {}) {
  const choice = resolveDesignSampleChoice(sampleId);
  const prevPrompt = String(prev.prompt ?? "");
  const prevLook = prev.selectedDesignLook ?? null;
  if (!choice) {
    return {
      selectedDesignSample: prev.selectedDesignSample ?? null,
      selectedDesignId: prev.selectedDesignId ?? null,
      selectedDesignTemplate: prev.selectedDesignTemplate ?? null,
      selectedDesignLook: prevLook,
      prompt: prevPrompt,
    };
  }
  if (toggle && prev.selectedDesignSample === sampleId) {
    const clearPrompt = isDesignSamplePrompt(prevPrompt) || isDesignTemplatePrompt(prevPrompt);
    return {
      selectedDesignSample: null,
      selectedDesignId: null,
      selectedDesignTemplate: null,
      selectedDesignLook: prevLook,
      prompt: clearPrompt ? "" : prevPrompt,
    };
  }
  const cur = prevPrompt.trim();
  const replace = !cur || isDesignTemplatePrompt(cur) || isDesignSamplePrompt(cur);
  return {
    selectedDesignSample: choice.sampleId,
    selectedDesignId: choice.designId,
    selectedDesignTemplate: choice.designTemplate,
    selectedDesignLook: prevLook,
    prompt: replace ? composePromptWithLook(choice.prompt, prevLook) : prevPrompt,
  };
}

export function nextDesignLookState(lookId, prev = {}, { toggle = false } = {}) {
  const known = designLookById(lookId);
  const prevLook = prev.selectedDesignLook ?? null;
  const nextLook = toggle && prevLook === lookId ? null : (known ? known.id : prevLook);
  const prevPrompt = String(prev.prompt ?? "");
  const replace = !prevPrompt.trim() || isDesignSamplePrompt(prevPrompt) || isDesignTemplatePrompt(prevPrompt);
  return {
    selectedDesignLook: nextLook,
    prompt: replace ? composePromptWithLook(prevPrompt, nextLook) : prevPrompt,
  };
}

function renderSampleThumb(kind) {
  switch (kind) {
    case "landing":
      return '<span class="dst-nav"><span></span><span></span><span></span></span>' +
        '<span class="dst-hero"><span class="dst-bar"></span><span class="dst-title"></span><span class="dst-cta"></span></span>' +
        '<span class="dst-feats"><span></span><span></span><span></span></span>';
    case "mobile":
      return '<span class="dst-phone"><span class="dst-notch"></span><span class="dst-status"></span>' +
        '<span class="dst-title"></span><span class="dst-line"></span><span class="dst-line dst-line--short"></span>' +
        '<span class="dst-dock"><span></span><span></span><span></span><span></span></span></span>';
    case "cube":
      return '<span class="dst-stage"></span><span class="dst-cube">' +
        '<span class="dst-face dst-face-a"></span><span class="dst-face dst-face-b"></span><span class="dst-face dst-face-c"></span></span>';
    case "dashboard":
      return '<span class="dst-side"></span><span class="dst-main">' +
        '<span class="dst-kicker"></span><span class="dst-grid"><span></span><span></span><span></span><span></span></span></span>';
    case "deck":
      return '<span class="dst-kicker"></span><span class="dst-title"></span><span class="dst-line"></span><span class="dst-line dst-line--short"></span>';
    case "magazine":
      return '<span class="dst-mast"></span><span class="dst-photo"></span><span class="dst-cols"><span></span><span></span></span>';
    case "bullets":
      return '<span class="dst-title"></span><span class="dst-bullets"><span></span><span></span><span></span></span>';
    case "doc":
      return '<span class="dst-title"></span><span class="dst-line"></span><span class="dst-line"></span><span class="dst-line"></span><span class="dst-line dst-line--short"></span>';
    case "okr":
      return '<span class="dst-title"></span><span class="dst-grid dst-grid--3"><span></span><span></span><span></span></span>';
    case "poster":
      return '<span class="dst-poster"><span class="dst-title"></span></span>';
    case "email":
      return '<span class="dst-head"></span><span class="dst-line"></span><span class="dst-line"></span><span class="dst-line dst-line--short"></span><span class="dst-cta"></span>';
    case "motion":
      return '<span class="dst-frames"><span></span><span></span><span></span></span>';
    case "check":
      return '<span class="dst-title"></span><span class="dst-checks"><span></span><span></span><span></span></span>';
    case "blank":
    default:
      return '<span class="dst-blank-page"><span class="dst-line"></span><span class="dst-line"></span><span class="dst-line dst-line--short"></span></span>';
  }
}

function renderDesignModeGallery(opts = {}) {
  const tab = opts.selectedDesignTab && DESIGN_MODE_TABS.includes(opts.selectedDesignTab)
    ? opts.selectedDesignTab
    : "Prototype";
  const selectedSample = opts.selectedDesignSample ? String(opts.selectedDesignSample) : "";
  const selectedLook = opts.selectedDesignLook ? String(opts.selectedDesignLook) : "";
  const selectedPack = opts.selectedDesignFilePack ? String(opts.selectedDesignFilePack) : "";
  const showLooks = tab === "Deck" || tab === "Media";
  const hint = opts.designRouteHint
    ? `<p class="design-route-hint">${esc(String(opts.designRouteHint))}</p>`
    : "";
  const tabs = DESIGN_MODE_TABS.map((name) => {
    const on = name === tab;
    return (
      `<li><button type="button" class="starter-tile design-tab-chip${on ? " is-selected" : ""}" ` +
      `data-design-tab="${esc(name)}" aria-pressed="${on ? "true" : "false"}">` +
      `<span class="starter-tile-title">${esc(designTabLabel(name))}</span>` +
      "</button></li>"
    );
  });
  const samples = designSamplesForTab(tab);
  const previewLook = showLooks
    ? (designLookById(selectedLook) || designLookById("ink"))
    : null;
  const sampleCards = samples.map((s) => {
    const on = selectedSample ? s.id === selectedSample : false;
    const blocked = designSampleBlockedReason(s, opts.visionConfigured);
    const caption = blocked || (s.hint ? `${s.title}：${s.hint}` : s.title);
    return (
      `<li><button type="button" class="design-sample-card${on ? " is-selected" : ""}" ` +
      `data-design-sample="${esc(s.id)}" ` +
      (s.designId ? `data-design-id="${esc(s.designId)}" ` : "") +
      (s.template ? `data-design-template="${esc(s.template)}" ` : "") +
      (s.needsImages ? `data-needs-images="1" ` : "") +
      (blocked ? `disabled aria-disabled="true" ` : "") +
      `aria-pressed="${on ? "true" : "false"}" title="${esc(caption)}">` +
      `<span class="design-sample-thumb design-sample-thumb--${esc(s.thumb)}" aria-hidden="true">` +
      renderSampleThumb(s.thumb) +
      "</span>" +
      `<span class="design-sample-title">${esc(s.title)}</span>` +
      (blocked
        ? `<span class="design-sample-hint">${esc(blocked)}</span>`
        : s.hint
          ? `<span class="design-sample-hint">${esc(s.hint)}</span>`
          : "") +
      "</button></li>"
    );
  });
  const packs = Array.isArray(opts.installedFilePacks) ? opts.installedFilePacks : [];
  const packChips = packs.map((p) => {
    const name = String(p?.name ?? "");
    if (!name) return "";
    const on = name === selectedPack;
    return (
      `<li><button type="button" class="starter-tile design-file-pack-chip${on ? " is-selected" : ""}" ` +
      `data-design-file-pack="${esc(name)}" aria-pressed="${on ? "true" : "false"}"` +
      (p.description ? ` title="${esc(p.description)}"` : "") + `>` +
      `<span class="starter-tile-title">${esc(name)}</span>` +
      (p.description ? `<span class="starter-tile-hint">${esc(p.description)}</span>` : "") +
      "</button></li>"
    );
  }).filter(Boolean);
  const packRow = packChips.length
    ? `<p class="design-pack-label">已安装文件包</p><ul class="starter-tiles design-pack-row">${packChips.join("")}</ul>`
    : "";
  const lookChips = showLooks
    ? DESIGN_LOOKS.map((look) => {
      const on = look.id === selectedLook;
      return (
        `<li><button type="button" class="starter-tile design-look-chip${on ? " is-selected" : ""}" ` +
        `data-design-look="${esc(look.id)}" aria-pressed="${on ? "true" : "false"}" ` +
        `title="${esc(look.prompt)}">` +
        `<span class="design-look-swatch" style="--look-bg:${esc(look.bg)};--look-accent:${esc(look.accent)}" aria-hidden="true"></span>` +
        `<span class="starter-tile-title">${esc(look.label)}</span>` +
        "</button></li>"
      );
    }).join("")
    : "";
  const lookRow = lookChips
    ? `<p class="design-pack-label">色板</p><ul class="starter-tiles design-look-row">${lookChips}</ul>`
    : "";
  const back =
    `<p class="design-mode-nav">` +
    `<button type="button" class="design-mode-back" data-design-mode-exit="1">` +
    `<span class="back-chevron" aria-hidden="true">←</span> 返回` +
    `</button></p>`;
  return (
    hint +
    back +
    `<ul class="starter-tiles design-tab-row">${tabs.join("")}</ul>` +
    lookRow +
    (sampleCards.length
      ? `<ul class="design-sample-row${previewLook ? " has-look" : ""}"${
        previewLook
          ? ` style="--look-bg:${esc(previewLook.bg)};--look-fg:${esc(previewLook.fg)};--look-accent:${esc(previewLook.accent)}"`
          : ""
      }>${sampleCards.join("")}</ul>`
      : "") +
    packRow
  );
}

function renderJobTile({ title, hint, attrs }) {
  return (
    `<li><button type="button" class="starter-tile" ${attrs}` +
    (hint ? ` title="${esc(hint)}"` : "") + `>` +
    `<span class="starter-tile-title">${esc(title)}</span>` +
    (hint ? `<span class="starter-tile-hint">${esc(hint)}</span>` : "") +
    "</button></li>"
  );
}

/** 模板 + 作业清单，画在 #starter-gallery。 */
export function renderStarterGallery(opts = {}) {
  const root = document.getElementById("starter-gallery");
  if (!root) return;
  const catalogOpen = Boolean(opts.designModeActive || opts.officeCatalogOpen);
  const face = opts.workspaceFace === "office" ? "office" : "code";
  root.classList.toggle("starter-gallery--design", catalogOpen);
  root.classList.toggle("starter-gallery--jobs", !catalogOpen);
  if (catalogOpen) {
    root.innerHTML = renderDesignModeGallery(opts);
    return;
  }
  if (face === "office") {
    const tiles = [
      ...OFFICE_STARTER_JOBS.map((e) =>
        renderJobTile({
          title: e.label,
          hint: e.hint,
          attrs: `data-example="${esc(e.text)}"`,
        }),
      ),
      renderJobTile({
        title: OFFICE_MORE_DRAFTS.title,
        hint: OFFICE_MORE_DRAFTS.hint,
        attrs: `data-office-more="1"`,
      }),
    ];
    root.innerHTML = `<ul class="starter-tiles starter-tiles--jobs">${tiles.join("")}</ul>`;
    return;
  }
  const tiles = CODE_STARTER_JOBS.map((e) =>
    renderJobTile({
      title: e.label,
      hint: e.hint,
      attrs:
        `data-example="${esc(e.text)}"` +
        (e.plan ? ` data-starter-plan="1"` : ""),
    }),
  );
  root.innerHTML = `<ul class="starter-tiles starter-tiles--jobs">${tiles.join("")}</ul>`;
}

// ---------------------------------------------------------------

// 格式化工具

function esc(s) {
  if (typeof s !== "string") return String(s ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s, maxLen) {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

function formatInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const CHAT_RATING_KEY = "agent-ui-chat-rating";

export function chatRatingStorageKey(runId, seq) {
  return `${CHAT_RATING_KEY}:${runId}:${seq}`;
}

export function readChatRating(runId, seq, storage = globalThis.localStorage) {
  if (!runId || seq == null || !storage) return "";
  try {
    const v = storage.getItem(chatRatingStorageKey(runId, seq));
    return v === "up" || v === "down" ? v : "";
  } catch {
    return "";
  }
}

/**
 * 赞/踩是发给模型的反馈，不是本地开关：同一侧再点不撤销（已经出手）。
 * 换边才改口并再发一次。返回当前值（"" | "up" | "down"）。
 */
export function writeChatRating(runId, seq, rating, storage = globalThis.localStorage) {
  if (!runId || seq == null || !storage) return "";
  const wanted = rating === "up" || rating === "down" ? rating : "";
  try {
    const key = chatRatingStorageKey(runId, seq);
    const cur = readChatRating(runId, seq, storage);
    if (!wanted) {
      storage.removeItem(key);
      return "";
    }
    if (cur === wanted) return cur;
    storage.setItem(key, wanted);
    return wanted;
  } catch {
    return "";
  }
}

/** 赞/踩真正喂给模型的那句话。空 rating 不发。 */
export function buildChatFeedbackMessage(rating, excerpt) {
  const clip = String(excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (rating === "up") {
    return clip
      ? `【反馈】刚才这轮回答很好，请继续保持这个方向。针对的是：「${clip}」`
      : "【反馈】刚才这轮回答很好，请继续保持这个方向。";
  }
  if (rating === "down") {
    return clip
      ? `【反馈】刚才这轮回答不理想，请按这个意见重新调整。针对的是：「${clip}」`
      : "【反馈】刚才这轮回答不理想，请重新调整。";
  }
  return "";
}

export function looksLikeChatFeedback(text) {
  return /^【反馈】/.test(String(text ?? "").trim());
}

export function chatPlainText(it) {
  if (!it) return "";
  if (it.kind === "user") {
    const painted = paintConversationUserText(it.text);
    return painted.display || painted.stub || "";
  }
  const folded = foldConversationBody(it.text);
  if (folded) return folded.stub;
  const extra = [];
  for (const [title, items] of [["验证", it.verification], ["假设与前提", it.assumptions]]) {
    if (!Array.isArray(items) || items.length === 0) continue;
    extra.push("", `**${title}**`, ...items.map((item) => `- ${item}`));
  }
  return [String(it.text ?? ""), ...extra].join("\n").trim();
}

export function chatTextFromNode(node) {
  if (!node) return "";
  const scoped = node.querySelector(".chat-msg-user-copy .chat-body") || node.querySelector(".chat-body");
  return String(scoped?.innerText ?? scoped?.textContent ?? "").trim();
}

/**
 * 开场任务气泡的时间：取 run 创建时刻与时间线最早 at 的较小值。
 * 快照分叉的子 run createdAt 是“现在”，但复制过来的事件仍是旧时间。
 */
export function pickTaskAt(state) {
  const ats = [...(state?.timeline ?? []), ...(state?.verifierTimeline ?? [])]
    .map((e) => e?.at)
    .filter((n) => Number.isFinite(n));
  const fromEvents = ats.length ? Math.min(...ats) : null;
  const created = Number.isFinite(state?.createdAt) ? state.createdAt : null;
  if (fromEvents != null && created != null) return Math.min(fromEvents, created);
  return fromEvents ?? created;
}

/** Cursor 式相对时间：刚刚 / 4m ago / 3h ago / 2d ago */
export function formatChatRelTime(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < 45_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export const REWIND_WRITE_TOOLS = new Set(["write_file", "edit_file", "write_pptx", "generate_image"]);

/** 回退对话框：这条之后有多少写盘快照、多少没有镜像的写入 */
export function deriveRewindFilePreview(state, seq) {
  const cut = Number(seq);
  const snapshots = (state?.fileRewindSnapshots ?? []).filter((s) =>
    Number.isFinite(Number(s.seq)) && Number(s.seq) > cut && !s.skipped,
  );
  const snapped = new Set(snapshots.map((s) => s.toolUseId));
  const unrestorable = (state?.timeline ?? [])
    .filter((e) =>
      e.type === "tool_call"
      && REWIND_WRITE_TOOLS.has(e.name)
      && Number(e.seq) > cut
      && !snapped.has(e.toolUseId),
    )
    .map((e) => ({
      path: String(e.input?.path ?? ""),
      tool: String(e.name ?? ""),
    }))
    .filter((row) => row.path);
  return { restorable: snapshots, unrestorable };
}

export function rewindDialogHtml(preview = {}) {
  const restorable = preview.restorable ?? [];
  const unrestorable = preview.unrestorable ?? [];
  const n = restorable.length;
  const u = unrestorable.length;
  const fileHint = n > 0
    ? `这条之后记下了 ${n} 个文件的改前内容，可以一并退回。`
    : u > 0
      ? `这条之后改过 ${u} 个文件，但没有改前快照。若工作区是 git，会尽量退回最后一次提交；bash 改过的不保证能退。`
      : "这条之后没有记下可还原的写盘。选「对话和改动一起退」时，只会试 git 已跟踪的文件。";
  return (
    `<div class="rewind-dialog" role="dialog" aria-modal="true" aria-labelledby="rewind-dialog-title">` +
    `<h2 id="rewind-dialog-title">回到这里？</h2>` +
    `<p>对话会裁到这条消息，这条之后的回复不会带进新对话。原来的对话原样保留。</p>` +
    `<p>${esc(fileHint)}</p>` +
    `<p class="rewind-dialog-ask">要不要改动也一起退？</p>` +
    `<div class="rewind-dialog-actions">` +
    `<button type="button" class="btn" data-rewind-choice="cancel">取消</button>` +
    `<button type="button" class="btn" data-rewind-choice="chat">只退对话</button>` +
    `<button type="button" class="btn btn--allow" data-rewind-choice="files">对话和改动一起退</button>` +
    `</div></div>`
  );
}

export function closeRewindDialog(root = typeof document !== "undefined" ? document : null) {
  root?.getElementById("rewind-dialog-root")?.remove();
}

/**
 * @returns {Promise<"chat"|"files"|null>}
 */
export function askRewindChoice(preview, root = typeof document !== "undefined" ? document : null) {
  if (!root) return Promise.resolve(null);
  closeRewindDialog(root);
  const host = root.createElement("div");
  host.id = "rewind-dialog-root";
  host.className = "rewind-dialog-backdrop";
  host.innerHTML = rewindDialogHtml(preview);
  root.body.appendChild(host);
  const dialog = host.querySelector(".rewind-dialog");
  const first = host.querySelector("[data-rewind-choice=cancel]");
  first?.focus?.();
  return new Promise((resolve) => {
    const finish = (choice) => {
      closeRewindDialog(root);
      resolve(choice);
    };
    host.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-rewind-choice]") : null;
      if (!btn) {
        if (e.target === host) finish(null);
        return;
      }
      const choice = btn.getAttribute("data-rewind-choice");
      finish(choice === "chat" || choice === "files" ? choice : null);
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(null);
    });
    dialog?.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const buttons = [...host.querySelectorAll("[data-rewind-choice]")];
      if (buttons.length === 0) return;
      const i = buttons.indexOf(root.activeElement);
      if (e.shiftKey && (i <= 0)) {
        e.preventDefault();
        buttons[buttons.length - 1].focus();
      } else if (!e.shiftKey && (i === buttons.length - 1 || i < 0)) {
        e.preventDefault();
        buttons[0].focus();
      }
    });
  });
}

function renderChatMsgActions(it) {
  const runId = it.runId ?? "";
  const seq = it.seq ?? "";
  const rateable = it.kind === "text";
  const rating = rateable ? readChatRating(runId, seq) : "";
  const time = formatChatRelTime(it.at);
  const btn = (action, icon, label, on = false) =>
    `<button type="button" class="chat-action${on ? " is-on" : ""}" data-chat-action="${esc(action)}"` +
    ` data-run-id="${esc(String(runId))}" data-seq="${esc(String(seq))}"` +
    ` title="${esc(label)}" aria-label="${esc(label)}"` +
    `${on ? ` aria-pressed="true"` : ""}>` +
    `<i class="ph ${icon}" aria-hidden="true"></i></button>`;
  return (
    `<div class="chat-msg-actions" role="group" aria-label="消息操作">` +
    (rateable
      ? btn("up", "ph-thumbs-up", "有用，告诉模型继续保持", rating === "up") +
        btn("down", "ph-thumbs-down", "不理想，告诉模型重新调整", rating === "down")
      : "") +
    btn("copy", "ph-copy", "复制") +
    btn("rewind", "ph-clock-counter-clockwise", "回到这里") +
    btn("fork", "ph-git-fork", "分叉对话") +
    (time ? `<span class="chat-msg-time">${esc(time)}</span>` : "") +
    `</div>`
  );
}

/**
 * 格式化毫秒时间戳为可读时间。
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 格式化毫秒时间戳为短时间（HH:mm）。
 * @param {number} ms
 * @returns {string}
 */
function formatTimeShort(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 格式化毫秒时长为可读字符串。
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m${secs}s`;
}
