# 工具与外围模块参考

> 本文档覆盖 Agent Harness 的工具层与外围基础设施，共 10 个源文件，每节对应一个模块。签名均逐行取自源码，未做美化或简化。

---

## execution-broker.ts

### 职责

SAFE-05 的任意命令边界：解析 `off|report|required` 与 `auto|oci|bwrap`，为每个 run
固定 boundary，执行 OCI 功能探测，并保证 `required` 不可用时绝不回退宿主。状态用
`direct|report-only|partial|failed` 与 coverage 表达；本版 OCI 只覆盖 bash，所以不会
报告整个 run 已隔离。

### 主要导出

```typescript
export function parseExecutionPolicy(env?: NodeJS.ProcessEnv): ExecutionPolicyConfig;
export function configuredExecutionStatus(env?: NodeJS.ProcessEnv, boundaryId?: string): ExecutionBoundaryStatus;
export function createExecutionBroker(options: ExecutionBrokerOptions): ExecutionBroker;
export function buildOciRunArgs(spec: OciRunSpec): string[];
export function executionBoundaryLabel(boundaryId: string): string;
export function executionNamespaceLabel(namespace: string): string;
```

OCI 参数由宿主固定：不可变镜像引用、`--pull never`、network none、只读 root、唯一
RW workdir（递归子 mount 禁用）、numeric non-root、无 supplementary group、cap-drop、
NNP、builtin seccomp、PID/CPU/内存/FD/tmpfs/输出/wall-time 上限。agent command 通过
stdin 先全量写入私有 tmpfs 脚本，再由固定 `/bin/sh` bootstrap 以 fd0=EOF 执行，
不出现在 Docker CLI argv/`Config.Cmd`；`env -i` 清空镜像与宿主环境。runtime 必须是
Linux 上 root 管理的绝对真实路径并逐次核对 SHA-256，daemon
只接受 root 管理的本机 Unix socket；socket 与设备均不进入 worker。

探测会真实启动 canary 检查 UID/GID/groups、rootfs mount、NNP、CapEff、seccomp、网络
路由、cgroup/FD 限制与 workdir 写入。实际 workdir 还会做 daemon 双向 read/write/
rename/delete canary，并拒绝嵌套 mount、socket/FIFO/device、hardlink 与 symlink 路径组件。
required 每次执行和每个 segment 准入都强制刷新；segment 收尾立即 dispose，follow-up
更换 broker。清理无法取得“容器不存在”的 daemon 回执时全局 readiness/准入降级，
per-run canary 前后双重重验。不能用“docker 命令存在”冒充
安全后端。

required+OCI 还要求稳定的 deployment namespace。每个容器原子写入 schema-3
namespace/owner/boot/PID-namespace/PID/starttime/lease/kind/boundary/policy/lease-ms labels；probe 在 canary 前完整校验当前
namespace，只按 full ID 回收“已到期且 owner 死亡证据完整”的 lease。未到期或 owner 仍活的并发 worker 不动，owner 存活性未知与畸形 tombstone 均 fail closed，
正常 cleanup 也先核对 lease 以避免迟到 cleanup 删除名称复用对象。该 reaper 只保证下一次成功
probe 后收敛，不是没有宿主进程时仍会触发的 daemon TTL。

`report` 探测后仍走明确标注的 host lane；`required` 只有探测通过才走 OCI。
`bwrap` 目前只保留配置值并报告 unavailable，未叠 cgroup 前不能满足 SAFE-05。

---

## bash.ts

### 职责

提供 shell 命令工具（`bash`），是 Agent 提交任意命令的入口。它只负责输入/输出适配、
环境去密和 shell 语义；实际执行必须走 `ToolContext.executionBroker`。自动探测 Windows
下的 Git Bash 路径以保持工具名与迁移期 host runtime 一致；required OCI 恒用 `/bin/sh`。

### 导出签名

```typescript
// 实际使用的 shell 描述字符串（供宿主注入 dynamicContext）
export const SHELL_DESC: string;
export function shellDescription(env?: NodeJS.ProcessEnv): string;
export function createBashTool(options?: {
  legacyBrokerFactory?: (boundaryId: string, workdir: string) => ExecutionBroker;
}): Tool;
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

// bash 工具定义（Tool 接口实例）
export const bashTool: Tool;
```

内部函数（未导出）：

```typescript
function detectWindowsBash(): string | undefined;
```

### 设计决策

- **工具名与运行时一致性（2026-07-25 A/B 诊断教训）**：工具名叫 `bash` 而运行时是 `cmd.exe` 时，模型按名字写 bash 管道 → cmd 引号转义全崩 → 模型每次烧 5-10 轮做环境考古。工具名与运行时必须一致；名字的暗示力大于描述里的免责声明。
- **避开 WSL 的 `System32\bash.exe`**：路径语义与 Git Bash 不同，比 cmd 更糟，探测时跳过。
- **探测优先级**：`ProgramW6432` → `ProgramFiles` → `C:\Program Files`，依次查找 `Git\usr\bin\bash.exe` 和 `Git\bin\bash.exe`。
- **权限门**：任意命令执行 = 最大能力面，默认 `permission: "ask"`（走审批门），
  `approvalPolicy.maxScope = "once"`，客户端不能扩大成同参数自动放行。
- **并发安全**：`parallelSafe: false`。
- **逐 run Broker**：Web 用 `executionBrokerFactory(runId, workdir)` 固定实例；CLI 同样创建独立 boundary。旧式直接 `Tool.execute` 也只会进入明确标注的 `legacy-unbound` broker，并在调用后自行 dispose。
- **超时与缓冲**：单命令 120s 超时（`TIMEOUT_MS = 120_000`），每路缓冲区上限 10 MiB（`MAX_BUFFER = 10 * 1024 * 1024`）。
- **输出合并**：stdout 与 stderr 合并为一个字符串，以 `\n--- stderr ---\n` 分隔；空结果返回 `"(no output)"`。
- **边界真相**：每条结果首行带 boundary/effective backend/mode/probe；`report-only` 与 `direct` 明确写未隔离。
- **错误收敛**：timeout、abort、输出超限、清理未确认或非零退出码均包装为 `isError: true`，错误消息经 `truncate` 截断。

---

## fetch-url.ts

### 职责

领域工具试点（v0.4）：从公开 HTTPS URL 抓取文本内容，作为验证"新增领域能力只需实现 Tool 接口"的示例工具。

### 导出签名

```typescript
export function createFetchUrlTool(overrides?: Partial<FetchUrlDependencies>): Tool;

export const fetchUrlTool: Tool;

export function isPublicIpAddress(address: string): boolean;
```

内部函数（未导出）：

```typescript
function stripHtml(html: string): string;
```

### 设计决策

- **试点验证目标（v0.4）**：新增领域能力只需实现 Tool 接口 —— L0/L1/L3 零改动。
- **安全考量**：GET 请求也有外泄面（模型可把数据拼进查询串发给任意主机），默认
  `permission: "ask"`，只允许同 run、同工具定义、同规范化 URL 输入在 10 分钟内
  自动复用最多 5 次；宿主可进一步收紧。
- **协议与目标限制**：用 WHATWG `URL` 解析，仅接受 HTTPS、拒绝 URL 内嵌凭据；
  hostname 每次都解析为 IP 并拒绝 loopback、private、link-local、CGNAT、benchmark、
  documentation、multicast/reserved IPv4 及非 global-unicast/特殊隧道 IPv6。
- **超时/取消**：整个操作共用 20s `AbortSignal.timeout` + `ctx.signal`；DNS lookup 即使底层 resolver 不支持取消，也经 abort-aware Promise 闸门及时返回。
- **DNS pinning**：DNS 校验后，`https.request` 的 TCP 连接直接使用该 IP，TLS SNI、
  证书校验和 HTTP Host 仍使用原域名，关闭“校验时公网、连接时私网”的 rebinding 窗口。
- **重定向**：手动处理 301/302/303/307/308；每一跳重新执行 URL、DNS 与 IP 校验，最多 5 跳。
- **响应上限**：网络层最多读取 1,000,000 bytes，再把返回模型的文本截断到 20,000 字符。
- **断流收口**：响应监听 `end/aborted/error/close`；headers 后中途断流会明确报错，不会留下永久 pending Promise。
- **User-Agent**：`agent-harness/1.2 (+https://github.com/Zeraissh/Agent_HarnssEngineering)`。
- **HTML 朴素去标签**：`stripHtml` 移除 `<script>`、`<style>` 块及所有 HTML 标签，实体解码（`&nbsp;` `&amp;` `&lt;` `&gt;`），压缩空白。对 v0.4 试点足够；正经抽取（readability 等）是后续工具的事。
- **输出截断**：结果经 `truncate` 截断到 20 000 字符（`truncate(text, 20_000)`）；空响应返回 `"(empty response)"`。
- **内容类型判断**：响应 `Content-Type` 含 `html` 时走去标签流程，否则原始文本直通。
- **并发安全**：`parallelSafe: true`。
- **受控网络边界**：使用 198.18.0.0/15 等 synthetic/fake-IP DNS 的本地 TUN 环境会
  fail closed；在专用受控 egress/proxy 能把验证地址与真实连接绑定之前，不应为兼容而
  自动放开这类非公网地址。

---

## fs-util.ts

### 职责

文件类工具共享的基础工具函数：路径安全校验（防逃逸）与输出截断（控 token）。

### 导出签名

```typescript
/**
 * 先做 lexical containment，再校验目标或最近存在父目录的真实路径仍在 workdir 内。
 */
export function resolveInWorkdir(workdir: string, p: string): string;

/** 只读路径可额外落在 readRoots 内，仍执行同一真实路径边界校验。 */
export function resolveReadable(
  workdir: string,
  readRoots: string[] | undefined,
  p: string,
): string;

/**
 * 输出截断：超长内容回填给模型只会烧 token，不会更有用。
 * 默认上限 30 000 字符。
 */
export function truncate(text: string, limit = 30_000): string;
```

### 设计决策

- **路径不可信原则**：先用 `path.resolve/path.relative` 拒绝 lexical 逃逸，再用
  `realpathSync.native` 校验目标或最近存在父目录，拒绝经 POSIX symlink、Windows
  junction/reparse point 越界；workdir 本身不存在时 fail closed。
- **写入二次校验**：`write_file` 在创建父目录之后、最终写入之前再次解析真实边界，
  防止新建目录阶段引入链接。Node 跨平台 API 没有 `openat` 式逐分量原子圈禁，检查与
  最终 I/O 之间仍有极窄 TOCTOU；彻底封闭依赖后续逐 run OS sandbox。
- **截断语义**：超长内容回填给模型只会烧 token，不会更有用 —— 超限时截取前 `limit` 字符并附加 `...[truncated N of total chars]` 标记。
- **默认截断上限**：`truncate` 默认 30 000 字符；各工具可按需传入更小限制（如 `fetch-url` 传 20 000）。

---

## read-file.ts

### 职责

读取工作目录内的 UTF-8 文本文件。Agent 在分析或修改文件之前的标准途径。

### 导出签名

```typescript
export const readFileTool: Tool;
```

### 设计决策

- **权限**：`permission: "auto"` —— 只读操作，无需审批。
- **并发安全**：`parallelSafe: true`。
- **路径约束**：输入为相对路径，经 `resolveInWorkdir` 校验后通过 `fs.readFile(resolved, "utf8")` 读取。
- **输出控制**：内容经 `truncate` 截断至 30 000 字符（默认上限）。
- **错误处理**：路径为空时返回 `isError`；文件不存在或其他 I/O 错误由 Promise 向上传播（由 ToolExecutor 统一捕获为 `isError` result）。

---

## registry.ts

### 职责

L2 层核心：ToolRegistry（工具注册与序列化）+ ToolExecutor（权限评估与并行调度）。

### 导出签名

```typescript
/** 工具注册表：按 name 存储、按 name 排序返回（缓存前缀稳定） */
export class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  /** 按 name 排序 —— 工具顺序稳定 = 缓存前缀稳定（P3） */
  list(): Tool[];
  /** 转为 Anthropic API 格式的 tools 数组 */
  toApiTools(): Anthropic.Tool[];
}

/** 审批回调：宿主决定是否放行某个工具调用 */
export type ApprovalFn = (
  block: Anthropic.ToolUseBlock,
) => Promise<{ decision: "allow" | "deny"; reason?: string }>;

/** 单次工具执行记录 */
export interface ExecutedTool {
  toolUseId: string;
  result: ToolResult;
  durationMs: number;
}

/** 工具执行器：所有权评估 → 并发/串行调度 → 错误收敛 */
export class ToolExecutor {
  constructor(registry: ToolRegistry, workdir: string);

  /**
   * 执行一轮内的全部 tool_use 块：
   * - parallelSafe 的并发执行，其余串行；
   * - 结果按原 block 顺序返回（合并进单条 user 消息由 loop 负责）；
   * - 任何失败都收敛为 isError result，绝不向上抛（P5）。
   */
  executeAll(
    blocks: Anthropic.ToolUseBlock[],
    signal: AbortSignal,
    approve: ApprovalFn,
    onResult?: (executed: ExecutedTool) => void,
  ): Promise<Anthropic.ToolResultBlockParam[]>;
}
```

### 设计决策

- **工具顺序稳定 = 缓存前缀稳定（P3）**：`list()` 和 `toApiTools()` 均按 `name` 排序输出，保证两次运行间工具列表字节一致，缓存可命中。
- **并发调度策略**：`parallelSafe: true` 的工具并发执行（`Promise.all`），其余严格串行。
- **结果顺序保持**：无论并发或串行，结果数组均按原始 `blocks` 顺序组装，确保后续 `tool_result` 与 `tool_use` 一一对应（API 硬约束）。
- **错误永不逃逸（P5）**：任何失败 —— 未知工具、审批拒绝、执行异常 —— 全部收敛为 `isError: true` 的 ToolResult，绝不向上抛异常。
- **审批门**：`permission: "ask"` 的工具在 executeSingle 中调用 `approve(block)`；deny 时返回带原因的 isError 结果。
- **注册去重**：同名工具重复注册抛 `Tool already registered` 错误。

---

## write-file.ts

### 职责

在工作目录内创建或覆写 UTF-8 文本文件。自动创建父目录。Agent 产出文件的唯一途径。

### 导出签名

```typescript
export const writeFileTool: Tool;
```

### 设计决策

- **权限**：写盘是可回滚性最差的内置动作，默认 `permission: "ask"` 且只允许单次审批。
- **并发安全**：`parallelSafe: false`。
- **覆写语义**：直接覆写已有文件内容 —— 需保留部分内容时应先 `read_file` 再 `write_file`。
- **自动建目录**：`mkdir(path.dirname(resolved), { recursive: true })` 确保父目录存在。
- **路径校验**：经 `resolveInWorkdir` 防止路径逃逸。
- **输出信息**：成功返回 `Wrote N bytes to <relative-path>`（字节数由 `Buffer.byteLength(content, "utf8")` 计算）。
- **输入校验**：`path` 或 `content` 非字符串时返回 `isError`。

---

## mcp.ts

### 职责

L2 扩展 —— MCP（Model Context Protocol）客户端接入层：把任意 MCP server 的工具适配为 harness 的 `Tool` 接口，使整个 MCP 生态（硬件调试、数据库、浏览器等）可用，无需手写 TS 工具。

### 导出签名

```typescript
/** 单个 MCP server 的配置 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 默认 "ask"——外部进程能力面未知，审批兜底 */
  permission?: "auto" | "ask";
  /** 按 MCP 原始工具名覆盖 server 默认权限 */
  toolPermissions?: Record<string, "auto" | "ask">;
  /** 默认 false——MCP server 内部多为有状态会话，保守串行 */
  parallelSafe?: boolean;
  /** 只暴露这些工具（可选，控制工具面大小） */
  includeTools?: string[];
}

/** MCP 配置文件顶层结构 */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

/** server / DomainPack 共用的权限策略 */
export interface McpPermissionPolicy {
  permission?: "auto" | "ask";
  toolPermissions?: Record<string, "auto" | "ask">;
}

/** MCP server 返回的原始工具信息 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** MCP 工具实际调用签名（适配层的注入点，便于测试） */
export type McpCaller = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError: boolean }>;

/** 将一个 MCP 工具信息 + 调用函数适配为 Tool */
export function adaptMcpTool(
  serverName: string,
  info: McpToolInfo,
  call: McpCaller,
  cfg: Pick<McpServerConfig, "permission" | "toolPermissions" | "parallelSafe">,
): Tool;

/** server default → pack default → server tool → pack tool 合并 */
export function resolveMcpToolPermission(
  rawToolName: string,
  serverPolicy?: McpPermissionPolicy,
  packPolicy?: McpPermissionPolicy,
): "auto" | "ask";

/** 传输层死亡判定：SDK 在 stdio 断开后抛 "Not connected" / "Connection closed" */
export function isTransportDead(err: unknown): boolean;

/** MCP content 块渲染为回填文本：text 直通，其余类型标注占位 */
export function renderMcpContent(content: unknown): string;

/** MCP 连接管理：封装 Client + 自动重连 */
export class McpConnection {
  readonly serverName: string;

  /** 启动子进程并建立 stdio 传输 */
  static connect(serverName: string, cfg: McpServerConfig): Promise<McpConnection>;

  /** 获取并适配该 server 的全部工具 */
  tools(): Promise<Tool[]>;

  /** 关闭连接 */
  close(): Promise<void>;
}

/** MCP 运行时：连接全部配置 server 后的产物 */
export interface McpRuntime {
  tools: Tool[];
  /** serverName → 工具数（宿主打印用） */
  summary: Record<string, number>;
  close(): Promise<void>;
}

/**
 * 连接配置里的全部 server；单个失败不拖垮整体（打印警告继续）。
 */
export async function connectMcpServers(
  config: McpConfig,
  onWarn: (msg: string) => void = console.warn,
): Promise<McpRuntime>;

/** 读取 mcp.json；文件不存在返回 undefined（MCP 是可选能力） */
export async function loadMcpConfig(configPath: string): Promise<McpConfig | undefined>;
```

### 设计决策

- **一次适配，整个 MCP 生态可用（P1）**：领域能力（硬件调试、数据库、浏览器等）不再需要手写 TS 工具，L0/L1/L3 依旧零改动。
- **命名空间隔离**：工具名统一加 `${serverName}__` 前缀，避免与内置工具及多 server 之间撞名。
- **权限默认 "ask"（P6）**：外部进程的能力面未知，宿主审批兜底；信任的 server 可在 `mcp.json` 中按 server 配置 `"auto"` ，再用 `toolPermissions` 将烧录/复位/写内存等单工具收紧为 `"ask"`。最终优先级为 `pack 单工具 > server 单工具 > pack 默认 > server 默认 > ask`：pack 的泛化 `auto` 不能盖掉 server 对具体危险工具的 `ask`；要覆盖必须在 pack 中同样逐工具点名。所有最终为 ask 的 MCP 工具缺省 `approvalPolicy.maxScope = "once"`，不能仅凭相同参数自动复用破坏性外部调用。
- **isError 直通（P5）**：MCP 的 `isError` 直接映射为 `ToolResult.isError`，错误进入上下文供模型阅读。
- **传输层死亡自愈**：server 进程被杀或 stdio 断开 → 自动重启 server 进程并重连（一次）。教训（v1.0 三角编排演示）：执行者用 bash 清理进程时可能扫死共享的 MCP server，多轮编排的寿命比连接长，必须能自愈。
- **重连代价标注**：重连后 server 端会话状态清零（如调试会话），调用方需自行重建会话。
- **单点故障隔离**：`connectMcpServers` 中某个 server 连接失败不拖垮整体 —— 打印警告，其他 server 的工具照常可用。
- **MCP 为可选能力**：`loadMcpConfig` 在文件不存在时返回 `undefined`，整个 MCP 链路优雅降级。
- **长任务超时**：`CALL_TIMEOUT_MS = 300_000`（5 分钟），因硬件/长任务类 MCP 工具（如 flash 烧录）可能很慢。
- **includeTools 过滤**：配置中的 `includeTools` 可限制暴露的工具面大小，未配置则全量暴露。

---

## memory.ts

### 职责

L5 —— 文件式跨会话记忆系统：一记忆一文件，索引实时从文件首行提取，不依赖模型自觉维护汇总文件。提供四个记忆工具（`memory_list` / `memory_read` / `memory_write` / `memory_delete`）。

### 导出签名

```typescript
/** 记忆条目摘要 */
export interface MemoryEntry {
  name: string;
  /** 文件首个非空行（去掉 # 前缀），截断到 80 字符 */
  summary: string;
  sizeBytes: number;
}

/** 记忆存储：文件式，圈禁在 memoryDir 内 */
export class MemoryStore {
  readonly dir: string;

  constructor(dir: string);

  /** 列出全部记忆（索引不落盘，实时从文件首行提取摘要） */
  list(): Promise<MemoryEntry[]>;

  /** 读取单条记忆全文 */
  read(name: string): Promise<string>;

  /** 写入/覆写一条记忆（上限 64 KiB） */
  write(name: string, content: string): Promise<void>;

  /** 删除一条记忆 */
  delete(name: string): Promise<void>;

  /** 生成 dynamicContext 注入用的索引文本：模型开局即知自己记得什么 */
  indexBlock(): Promise<string>;
}

/** 由一个 MemoryStore 派生出四个记忆工具（工厂：一个 agent 一套，互不串味） */
export function createMemoryTools(store: MemoryStore): Tool[];
```

内部常量（未导出）：

```typescript
const MAX_MEMORY_BYTES = 64 * 1024;  // 单条记忆上限
const NAME_RE = /^[\w][\w\-./]*\.md$/;  // 合法记忆名正则
```

内部函数（未导出）：

```typescript
function firstLineSummary(text: string): string;
```

### 设计决策

- **索引不落盘（P6）**：一条记忆 = 一个文件；`list()` 时从每个文件首行实时提取摘要 —— 不依赖模型自觉维护 `MEMORY.md`，不变量靠 harness 而非 prompt 纪律。
- **晋升为专用工具的正面案例（P2）**：写操作被硬性圈禁在 `memoryDir` 内，这个不变量让 `memory_write` 可以 `permission: "auto"` —— 而通用 `write_file` 必须 `ask`。
- **易变信息不进 system prompt（P3）**：记忆索引每次 run 开始时经 `dynamicContext` 注入 messages，system prompt 保持字节冻结利于缓存。
- **单条记忆上限 64 KiB**：记忆是"值得复用的事实/教训"，不是数据仓库；超限抛出明确提示。
- **合法记忆名约束**：必须匹配 `/^[\w][\w\-./]*\.md$/` 且不含 `..`，杜绝路径逃逸与怪名；非法名称抛出带示例的错误。
- **摘要格式**：取文件首个非空行，去掉前导 `#`，截断到 80 字符。
- **目录不存在处理**：`list()` 在 `memoryDir` 不存在时返回空数组（"还没有记忆"），优雅降级。
- **四工具工厂模式**：`createMemoryTools(store)` 为一个 `MemoryStore` 创建 `memory_list` / `memory_read` / `memory_write` / `memory_delete` 四个 Tool，保证一个 agent 实例一套记忆，不同实例互不串味。

---

## diagnostics.ts

### 职责

缓存诊断：回答"两次请求的缓存为什么没命中"。缓存是前缀匹配（`tools → system → messages`），本模块按同样顺序找出第一处分歧。

### 导出签名

```typescript
/** 前缀分歧定位结果 */
export interface PrefixDivergence {
  /**
   * "none" = 两次请求前缀完全一致（缓存未命中的原因不在请求体，查 TTL/模型/最小长度）
   */
  tier: "tools" | "system" | "messages" | "none";
  /** 分歧所在 tier 内的索引（tools/messages 为条目下标，system 为块下标） */
  index: number;
  detail: string;
}

/** 比较两次 ModelRequest 的渲染结果，找出前缀的第一处分歧 */
export function diffRenderedRequests(a: ModelRequest, b: ModelRequest): PrefixDivergence;
```

内部函数（未导出）：

```typescript
function firstDiffPreview(a: string, b: string): string;
```

### 设计决策

- **前缀匹配模型**：缓存前缀顺序为 `tools → system → messages`，本工具逐层比对，找到第一处分歧即停止。
- **tools 层最敏感**：tools 渲染在最前，任何工具增删/改序/改描述都会使全部缓存失效。
- **system 层警惕易变内容**：分歧时给出提示 —— 检查是否有时间戳/会话 ID 等易变内容混入 system prompt。
- **messages 层**：分歧前的消息前缀仍可命中缓存，分歧点之后全部失效。
- **tier: "none" 诊断建议**：两次请求前缀完全一致却未命中，提示检查：是否换了模型（缓存按模型隔离）、是否超过 5 分钟 TTL、前缀是否短于该模型的最小可缓存长度。
- **差异预览**：`firstDiffPreview` 定位首个差异字符的前后 15 字符上下文，或报告长度差异。

---

## cli.ts

### 职责

CLI 宿主：Agent Harness 的命令行入口，作为事件流的一个完整消费者示例。负责解析命令行参数、初始化所有子系统（模型客户端、记忆、MCP、领域包、三角编排/核查）、消费 TurnEvent 流并渲染到终端。

### 导出签名

本模块是入口脚本，无导出。所有逻辑封装在局部函数 `main()` 和 `renderEvent()` 中。

### 设计决策

- **命令行用法**：`npx tsx src/cli.ts "任务描述" [--yes] [--verify] [--plan [--parallel=N]] [--auto]`
  - `--yes`：自动批准所有审批请求（非交互环境/CI 用；交互终端下走 y/n 提示）。
  - `--verify`：完成后由 verifier 子代理独立核查，未通过自动返工一轮。
  - `--plan`：三角编排 —— planner 拆解子任务（自选领域包+依赖图）→ 执行 → 核查 → 交接；互不依赖的子任务默认并发执行，并行度 `auto` = `min(3, 计划层宽)`。
  - `--parallel=N`：显式并行度覆盖 `auto`；`=1` 退回全串行。仅对 `--plan` 生效。
  - `--auto`：调度单元路由领域包（单领域任务免手选；显式 `AGENT_PACK` 优先）。
- **--parallel 的 A/B 采纳（ab-report-parallel.md）**：拆分率 ~50/50 下串行默认让一半 run 白付拆分成本；线性链 auto 自动退化为串行。
- **system prompt 保持字节冻结（P3）**：易变信息（日期、平台、shell、workdir、memory_index）均通过 `dynamicContext` 注入 messages，`SYSTEM_PROMPT` 常量自身不变。
- **护栏参数优先级**：显式环境变量 > 领域包默认值 > 全局默认值（`AGENT_CONTEXT_LIMIT` / `AGENT_MAX_TOKENS` / 领域包 `maxTurns`）。
- **领域包自动路由（--auto）**：无显式 `AGENT_PACK` 时，`routeToPack` 根据任务描述自动选择合适的领域包；router 判断为跨领域任务时提示 `--plan` 更合适。
- **verifier 独立模型**：`--verify` 时可配 `AGENT_VERIFIER_MODEL` 指向更强模型（核查者应 ≥ 执行者强度），配套 `AGENT_VERIFIER_PROVIDER` / `_BASE_URL` / `_API_KEY` 可指向不同端点。
- **planner 独立模型**：`--plan` 时可配 `AGENT_PLANNER_MODEL`（拆分决策摇摆的稳定化杆），镜像 verifier 的端点配置组。
- **结构化拆分协议**：`AGENT_PLAN_PROTOCOL=structured` 启用"枚举与决策分离"的模式（分片枚举 + 宿主规则判拆），默认 `freeform`。
- **compat 模式**：非 `claude-*` 模型（DeepSeek/GLM/Kimi/Ollama）自动去掉 Claude 专属参数（thinking/effort/cache_control）。
- **跨会话记忆**：默认 `<cwd>/.agent-memory`，`AGENT_MEMORY_DIR` 可覆盖。
- **MCP 为可选能力**：`./mcp.json` 存在即连接，`AGENT_MCP_CONFIG` 可覆盖路径；领域包可整体关闭（`mcp: false`）或覆盖各 server 的工具白名单/审批策略。
- **并发渲染**：并行度 > 1 时事件交错到达，改为每事件一行 + `[子任务/角色]` 前缀；审批仍走完整问答（已被编排层串行化）。
- **verifier 视觉区分**：verifier 事件以洋红色 `╔══ verifier` / `║` 前缀渲染，与主 agent 视觉隔离。
- **done 事件着色**：`stopReason` 为 `completed` = 绿，`max_tokens` = 黄（截断但内容保留），其余 = 红。
- **错误处理**：`main()` 最外层 `.catch` 打印堆栈并以 exit code 1 退出。
