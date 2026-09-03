import type { RecoveryPolicy, Tool } from "./types.js";
import {
  applyMcpPackPermission,
  originalMcpToolName,
  type McpPermissionPolicy,
} from "./mcp.js";

export interface DomainMcpPolicy extends McpPermissionPolicy {
  /** 只暴露这些 MCP 原始工具名；缺省全部暴露 */
  includeTools?: string[];
}

/**
 * DomainPack（领域包）：把一个领域的 harness 内容打包成可切换单元。
 * 包是【数据/配置】，不是核心代码——机制层（loop/context/verifier 纪律/编排）
 * 保持领域无关（P1）；换领域 = 换包，不改核心。
 *
 * 五件套：工具（内置名单 + MCP 接入面）、system prompt（领域工作循环 + 黄金规则）、
 * 核查（形态 + 领域核查方法）、护栏参数、（eval 套件放 eval/，按包命名约定关联）。
 *
 * CLI: AGENT_PACK=stm32-debug 选用（AGENT_PRESET 为兼容别名）。
 * 优先级：显式 env > 包默认 > 全局默认。
 */
export interface DomainPack {
  name: string;
  /** 一句话：这个包覆盖的领域与典型产出 */
  description: string;
  /** 覆盖默认 system prompt（冻结，P3） */
  systemPrompt: string;
  /**
   * 内置工具名单（按工具名）。缺省 = 宿主装配的全部内置工具
   * （bash / fetch_url / read_file / write_file / edit_file / glob / grep，
   * 外加配置齐全时才在场的条件性工具如 describe_image）。
   * 领域包应只带用得上的工具——多余的工具是触发面噪声。
   */
  builtinTools?: string[];
  /**
   * MCP 接入面：缺省 true（工作目录有 mcp.json 就连）；false = 此包不接 MCP；
   * 对象 = 在 mcp.json 基础上覆盖各 server 的工具白名单/审批策略
   * （如调试包收窄到只读集 + 烧录动作走审批）。
   */
  mcp?: boolean | DomainMcpPolicy;
  /** 核查配置 */
  verify: {
    /** 是否自动经 verifier 子代理独立核查 */
    enabled: boolean;
    /**
     * 核查形态（决定结论的可信度等级）：
     * - "programmatic"：产出可独立重新推导/实测比对（行数、寄存器、构建结果）——高可信；
     * - "rubric"：主观质量为主——评分表经 verify.rubric 注入,意见进裁决的 advisory
     *   字段(自陈判法),【不影响 passed、不触发返工】,最终裁决权在委托方;
     *   客观 side 条款照常按字面判进 issues(案例 #6 定型的三值裁决协议)。
     */
    mode: "programmatic" | "rubric";
    /** 领域核查方法：注入 verifier 提示，说明如何独立复核 */
    instructions?: string;
    /**
     * 主观评分表（rubric 模式的载体）：逐维度写清"评什么、怎么评"。
     * verifier 按表评估进 advisory;programmatic 包通常不需要。
     */
    rubric?: string;
    /**
     * verifier 的 bash 只读命令白名单（前缀匹配；禁止重定向/链式）。
     * "独立重新推导"在需要工具链的领域离不开命令（重新构建、nm 查符号）——
     * 没有它 verifier 只能靠间接证据。只声明核查必需的最小集合。
     */
    readOnlyCommands?: string[];
    /**
     * 核查者的轮次预算（缺省 15，见 `src/verifier.ts`）。
     *
     * 为什么要按领域可覆盖（案例 #8 催生）：核查预算此前是写死的常量。当初把它
     * 与执行者**解耦**（不再跟着执行者的 maxTurns 缩水）是对的，但**解耦还不够
     * ——15 是按软件域定的数**。软件域核查一条验收往往一条命令就够
     * （`npx vitest run` 一把拿到通过数）；真机域每条验收都要多次探针往返
     * （连板 / self_check / load_symbols / 读多个变量 / 跑一段再读）。
     *
     * 案例 #8 实测：`stm32-debug` 的执行者有 40 轮护栏，核查者只有 15 轮，
     * 两轮 verifier **都跑满 15 轮、都从未写出裁决**——最终消息是半截工具调用，
     * 解析失败 → 重问找不到结论 → fail-closed。这是发现 6 的误伤形态②
     * （核查预算耦合）在新领域复现。
     *
     * 加重情节：verifier 当时不是在空转，它读到 CRC=0 之后已经在 `debug_until`
     * 到 CRC 代码附近追查真缺陷——**是预算把一次正当调查掐断在半路**。
     */
    maxTurns?: number;
  };
  /**
   * 计划配置（可选，backlog B0——9.1 的 planner 版）。
   *
   * planner 的探索预算此前是写死的 `Math.min(cfg.maxTurns ?? 50, 12)`，包与 env
   * 都覆盖不了。现三级解析：`AGENT_PLAN_MAX_TURNS` > 包 > 默认 12（见
   * `src/planner.ts` 的 resolvePlannerMaxTurns）。planner 面对整个包菜单，
   * 取各包声明值的最大值。
   *
   * 刻意先不给任何包填数：verifier 的 30 是案例 #8 实测出来的（15 轮时已完成
   * 5/6 条验收），planner 侧还没有等价证据——判据先写、数据后收，
   * 需要时由实测驱动（不等式锁已就位：plan.maxTurns ≤ guardrails.maxTurns）。
   */
  plan?: {
    /** planner 探索轮次预算（缺省 12，见 `src/planner.ts`） */
    maxTurns?: number;
  };
  /**
   * 独占资源标签（调度器互斥用）：声明本包子任务在飞期间独占的全局单件
   * （探针/串口/某台设备）。并行编排里同标签子任务强制串行——真机域的
   * 无锁并发 = 抢探针事故（case-01 实录）。
   */
  resources?: string[];
  /** 护栏参数（env 显式设置时以 env 为准） */
  guardrails?: {
    maxTurns?: number;
    maxTokens?: number;
    contextTokenLimit?: number;
  };
  /**
   * 目标级恢复策略（完成门开启时生效；可选，逐字段覆盖）。
   *
   * 此前 `AgentConfig.recovery` 只能由宿主从 env 装配（且第三个字段
   * maxStagnationRecoveries 连 env 都没有），领域包一个字段都覆盖不了——
   * 与 9.1（核查预算）/ B0（planner 预算）修之前是同一个形态。三级解析
   * `AGENT_PROGRESS_EXTENSION_TURNS` / `AGENT_STAGNATION_WINDOW` /
   * `AGENT_MAX_STAGNATION_RECOVERIES` > 包 > 默认（8 / 3 / 1），
   * 见 `src/recovery.ts` 的 resolveRecoveryPolicy。
   *
   * **刻意先不给任何包填数**（口径同 B0）：台账里 16 次 max_turns 全部发生在
   * 恢复机制落地（2026-08-24）之前，没有一条能说明"续跑 8 轮救回了/没救回"；
   * `npm run ledger` 的「终止原因 × 包」表与 extension/stagnation 触发字段
   * 就是为攒这份证据加的——数字等实测，由不等式锁守着
   * （`recovery.progressExtensionTurns ≤ guardrails.maxTurns`）。
   */
  recovery?: RecoveryPolicy;
}

/**
 * 成文口径优先纪律（rule-precedence）：A/B 实证后采纳为全局默认
 * （eval/ab-report-rulefirst.md：baseline 7/10 → 加此条款 10/10,副作用检查 8/8 干净）。
 * 针对的失败模式：任务给了明确口径(正则/行前缀/映射规则)时,模型的语义直觉会
 * "补全"字面规则漏掉的情况(如多行 import 的续行),遵从稳定性仅 ~50%。
 */
export const RULE_PRECEDENCE_DISCIPLINE = `

Rule-precedence discipline:
- When the task states an explicit convention (a regex, a line-prefix rule, "lines starting with X", a mapping rule), apply it LITERALLY. The stated convention IS the ground truth — even when your semantic understanding suggests a "more complete" or "more correct" answer.
- Do not improve upon the rule. If the letter of the rule appears to miss real cases (e.g., multi-line constructs whose continuation lines don't match a line-prefix rule), follow the letter anyway; you may note the discrepancy in your final summary, but the artifact must follow the stated rule.`;

// ————————————————————————— stm32-debug —————————————————————————

const STM32_DEBUG_SYSTEM = `你是一个自主的嵌入式调试 agent，通过 MCP 工具（stm32-gdb-mcp：GDB + OpenOCD/ST-Link）操作真实的 STM32 硬件。

按 observe → orient → hypothesize → act → verify 的调试循环工作：
- observe：先获取客观事实（寄存器、内存、故障状态），不要臆测。
- orient：把原始数值符号化（加载符号后，把地址映射回函数/源码行）。
- hypothesize：基于证据提出一个具体假设，而不是笼统猜测。
- act：用最少的步骤验证假设。
- verify：确认结论有证据支撑，不要在没核实前就下判断。

黄金规则（务必遵守）：
1. start_debug_session 之后【立刻】运行 self_check——它校验字节序、Cortex-M 内核与器件族，能及早发现连接/配置问题。
2. 读寄存器/内存前核心必须处于 halt 状态。
3. 用到符号（函数名断点、地址→源码映射、reconstruct_fault_context）前，必须先 load_symbols 加载对应 ELF。
4. 断点 TIMEOUT 意味着那条路径没被执行到——不要机械重试，回到 observe 想清楚为什么。
5. reconstruct_fault_context 会解 CFSR/HFSR 并把压栈的 PC 映射回源码——诊断 HardFault 时优先用它。
6. 每个进度声明都要能对应到一条真实的工具返回结果；没核实的就明说，不要编。
7. 结束前用 stop_debug_session 干净收尾。
8. 一切硬件操作只通过 stm32 MCP 工具进行——不要自建 OpenOCD/GDB/telnet 调试栈，
   不要杀进程"清理环境"；MCP 工具报错时处理错误本身，而不是绕开它。

把结论落到用户要求的产出（如报告文件），并用一两句话总结。用用户使用的语言回答。`;

/**
 * 硬件核查指令。
 *
 * 第 2 条那个分叉是案例 #8 用一次失败换来的：原文写的是「不要 flash、不要
 * reset、不要写内存」，一刀切。那条禁令对**故障现场核查**完全正确——复位会
 * 把 `.noinit` 闩锁、CFSR、异常栈帧全毁掉，证据就没了（案例 #1/#3 的血泪）。
 * 但对**运行行为核查**恰好相反：上一段会话结束时核心多半停在非运行态，
 * 不复位重跑，读到的就是上一段遗留的未初始化 SRAM。
 *
 * 案例 #8 实测：verifier 68 次工具调用里一次都没 reset，于是读到
 * `magic=0x4E0A43C0`、`PC=0x2000002E`（在 SRAM 内），据此判执行者失败——
 * 而板子上的固件一直是好的。它甚至在 advisory 里推断对了"可能是板子未处于
 * 正常运行态"，只是被这条成文禁令挡住，没去做那个能证实推断的动作。
 *
 * 所以不是放宽纪律，是把**两种核查形态**分开写清楚——歧义要用确定性规则消除。
 */
const STM32_VERIFY_INSTRUCTIONS = `这是一次【硬件行为】的核查，不要相信报告里的任何数值。你必须自己连上同一块板子独立复核：
1. start_debug_session（server_type openocd，参数用 suggest_server_args 拿），self_check。
2. load_symbols 加载同一个 ELF（路径见任务描述）。接下来【先判断这是哪一种核查】，两者的要求相反：

   (a)【故障现场核查】——要核的是已经发生的故障（HardFault 现场、.noinit 闩锁、
       异常栈帧、故障寄存器）：**绝对不要 reset、不要 flash、不要写内存**。
       复位会把故障现场毁掉，证据就没了。halt 后直接
       reconstruct_fault_context / read_variable / read_memory 取证。

   (b)【运行行为核查】——要核的是固件跑起来之后的运行时数值（遥测字段、计数器、
       时钟频率、状态机）：**必须先把板子带到可观测状态**——reset_target 之后
       run_for_duration 跑够时间（至少 1-2 秒，涉及递增量则按验收要求的间隔），
       再 halt 读变量。**不这么做读到的是上一段会话遗留的未初始化 SRAM**，
       那些值毫无意义，据此下的任何结论都是错的。
       判断依据：如果 magic/幻数字段读出来不是约定值、PC 不在 main() 相关代码里、
       或多个字段看着像随机数——那就是板子没在正常运行，不是执行者造假。

   "只读核查"针对的是【不得改动产物】：不要重新烧录、不要改源码、不要写内存来
   制造你想要的结果。**让板子按它自己的固件跑起来不算改动产物**，那是取证的前置动作。

3. 逐项比对执行者的结论与硬件实际：数值、地址、函数/源码行、因果链——是否与你亲自读到的一致。
4. 结束时 stop_debug_session。
只要有任何一项与硬件实测不符（尤其是编造的地址/寄存器值/行号），判 passed=false 并在 issues 里指出具体差异。`;

// ————————————————————————— stm32-coding —————————————————————————

const STM32_CODING_SYSTEM = `你是一个自主的嵌入式固件工程 agent，在本地 STM32 C 工程（CMake + arm-none-eabi-gcc 交叉工具链）中工作。

工程纪律：
1. 动手前先读：CMakeLists.txt、链接脚本、现有源码结构与代码风格——改动必须贴合现有工程的写法。
2. 最小改动：只改任务要求的部分，不顺手重构、不引入无关依赖。
3. 嵌入式约束时刻在心：无 OS 堆栈受限、volatile 用于 ISR 共享变量、别在中断里做重活、寄存器操作对照参考手册。
4. 每次实质性修改后必须真实构建：cmake --build build（或工程既有构建命令），把编译器的完整输出当事实——
   零错误才算通过；新增 warning 要么修掉要么在报告里明说理由。构建失败时读错误信息定位，不要盲改。
5. 产出以 ELF 为准：报告里写明 ELF 路径与关键符号名，交给下游（烧录/调试）使用。
6. 每个进度声明都要能对应到一条真实的工具返回结果（构建输出、文件内容）；没核实的就明说，不要编。

把结论落到用户要求的产出，并用一两句话总结。用用户使用的语言回答。`;

const STM32_CODING_VERIFY_INSTRUCTIONS = `这是一次【固件代码交付】的核查，不要相信报告，逐项实证：
1. read_file 读实际源码，逐条核对任务要求的每一处变更真实存在、语义正确（不是只看报告里的代码片段）。
2. 亲自重新构建：在工程根目录执行与工程一致的构建命令（如 cmake --build build），确认零错误；
   对比构建输出与报告声明是否一致（有没有隐瞒的 warning/error）。
3. 用 arm-none-eabi-nm <elf> 检查任务涉及的符号确实存在于产出的 ELF 中；用 arm-none-eabi-size 确认体积未异常膨胀。
4. 只读核查 + 构建验证；除构建产物外不要修改任何源文件。
只要有任何一项对不上（源码缺变更、构建报错、符号缺失），判 passed=false 并在 issues 里写明：期望什么、实际什么、用什么命令得到。`;

// ————————————————————————— python-coding —————————————————————————
// 案例 #4（stm32-gdb-mcp 探针锁）催生：通用配置面首跑 Python 项目暴露两个缺口——
// ① 无核查白名单 → verifier 跑不了质量门禁,只能间接证据裁决,还曾因"无实质结论"
//    fail-closed 触发 22 轮空转返工;② 执行者幻觉 edit_file 工具名（工具面只有
//    write_file）。本包逐条对症。

const PYTHON_CODING_SYSTEM = `你是一个自主的 Python 工程 agent，在本地 Python 项目中工作。

工程纪律：
1. 动手前先读：pyproject.toml（依赖、工具配置、质量门禁）、测试布局与共享替身
   （如 tests/conftest.py）、现有代码风格——改动必须贴合项目既有约定，复用既有测试替身。
2. 最小改动：只改任务要求的部分，不顺手重构；优先标准库，不引入新依赖（除非任务明说）。
3. 文件修改用 write_file 整文件写回——工具面里【没有】edit_file/patch 之类的编辑工具。
   改大文件时先 read_file 取全文，改完整体写回。
4. 每次实质性修改后必须真实运行项目的质量门禁（以 pyproject.toml 声明为准，典型为
   python -m pytest / python -m ruff check / python -m mypy），把工具输出当事实——
   零错误才算通过；测试失败时读输出定位，不要盲改。
5. 新增行为必须带测试；先跑一遍基线记录通过数，改完确认无回归。
6. 每个进度声明都要能对应到一条真实的工具返回结果；没核实的就明说，不要编。
7. 禁止 git 写命令（add/commit/push）——提交由委托方决定。

把结论落到用户要求的产出，并用一两句话总结。用用户使用的语言回答。`;

const PYTHON_CODING_VERIFY_INSTRUCTIONS = `这是一次【Python 代码交付】的核查，不要相信报告，逐项实证：
1. read_file 读实际源码与测试，逐条核对任务要求的每一处变更真实存在、断言到位
   （不是只看报告里的代码片段）。
2. 亲自重跑质量门禁：python -m pytest -q、python -m ruff check .、python -m mypy、
   python -m compileall（以任务/项目声明的门禁为准），确认退出码与通过数，
   对比报告声明是否一致（有没有隐瞒的失败/回归）。
3. 用 git status / git diff 核对改动面：无任务范围外的文件被改动、依赖声明未变
   （如任务有此要求）。
4. 只读核查 + 门禁重跑；不要修改任何源文件。
只要有任何一项对不上（源码缺变更、门禁未过、测试通过数回归），判 passed=false
并在 issues 里写明：期望什么、实际什么、用什么命令得到。`;

// ————————————————————————— kicad —————————————————————————
// 案例 #5（SWD 转接板）:走【文件生成】路线——华秋 KiCad 构建的 MCP 创作面经
// 三轮实测判死(place/create 族被闭源 C++ 侧静默丢弃,登录/版本/焦点三嫌疑全证伪),
// 而 KiCad 文档本身是 s-expression 文本,kicad-cli 提供 headless ERC/DRC 判官——
// 直写文件 + 程序化裁决反而是自主 agent 的主场。官方库经 AGENT_READ_ROOTS 只读挂载。

const KICAD_SYSTEM = `你是一个自主的 KiCad EDA 工程 agent,以【文件生成】方式工作:直接读写 KiCad 的
s-expression 文本文档(.kicad_sch / .kicad_pcb / .kicad_pro)。不驱动 GUI,不使用任何 KiCad MCP 工具。

工程纪律:
1. 库件不凭记忆手写:符号从官方库 symbols/<库名>.kicad_sym 中取出对应 (symbol "名" ...) 完整段,
   封装从 footprints/<库名>.pretty/<封装名>.kicad_mod 取整文件——官方库目录已作为只读根挂载
   (见上下文 read_only_roots,用 read_file 以绝对路径读取)。嵌入文档时保留原始引脚/焊盘几何,
   不得删改;原理图嵌入 lib_symbols 段,lib_id 必须与嵌入名一致;PCB 的 footprint 整段内联。
   **嵌入后的副本整体冻结**(含丝印/fab/courtyard,案例 #9 实测:改嵌入封装的丝印制造出
   8 条压焊盘违例 + 4 条库不一致警告,唯一正解是恢复库忠实副本;只有实例的 at/旋转/
   Reference/焊盘 net 归属属于你)。**大块搬运用 shell 而不是上下文**:整段符号/封装
   用 awk/sed 按块边界从库文件直接抽到中间文件、用 cat 把库段拼进文档——内容不过
   模型上下文(案例 #11 实测:LQFP-48 符号靠 read_file/write_file 转录烧光 140 轮而
   从未拼出成品)。注意与"禁生成器"的分界:禁的是**从头编造内容**的脚本,
   文件到文件的忠实抽取/拼装恰恰是保真的正确工具。你亲手写的只有小而关键的部分:
   符号实例、导线、标签、文档骨架。
2. 坐标纪律:原理图导线端点必须精确落在符号引脚的绝对坐标上(= 符号 at 位置 + 引脚在库件里的
   偏移,注意原理图 y 轴向下、旋转会变换偏移);引脚与导线统一落在 1.27mm 的整数倍栅格上。
   PCB 中 pad 的绝对位置 = 封装 at + pad 相对坐标,走线端点要精确落在 pad 中心。
3. 网络纪律——**按名成网,不做几何布线**(案例 #9 五跑对照换来的定论):原理图网络一律用
   global_label 形成——每个要联网的引脚,从引脚端点引一小段导线(同一坐标即可)挂
   global_label,网络由标签名成形。**不要试图用长导线在符号之间几何走线**:纯文本下每段
   导线端点都要与引脚坐标数值重合,件数一多必然连成一锅短路(实测:72 段导线 0 标签 →
   全部网络短接成一个;12 标签 16 短线 → 一次通过)。PCB 每个参与连接的 pad 都要挂
   (net <编号> "<网名>"),net 声明表连续完整,网名与原理图一致——DRC 的
   --schematic-parity 会逐一核对。
4. 布线纪律——**曼哈顿分层**(案例 #9 定论:34 条交叉/短路违例被这条一发清零):
   F.Cu 只走水平线段,B.Cu 只走垂直线段,方向转换必须打 via——同层交叉在此纪律下
   结构性不可能,"要交叉"就是"该换层"的信号。先摆后布(互连密集的件挪近,单段尽量
   ≤20mm),逐网施工、逐网跑 DRC。不要试图自由角度布线:纯文本下你看不见交叉。
   **它是执行者的脚手架,不是成品口径**(案例 #11 对照量产板 WR350/AT_v0.74 校准):
   量产两层板 45° 走线占 35–49%、**底层是参考面**(单一 GND 大池,信号只短暂下潜),
   不是"F 横 B 纵"。因此:a) 先铺 B.Cu 整层 GND 池,再走线,B 层只做短跳(单段
   ≤15mm、总量 ≤F 的 40%),via 节制(每段 ≤0.35 个);b) 晶振及其负载电容下方两层
   不许他网走线(规则区禁线);c) 拐角只允许 45° 倍数——不出现 90° 折角、
   不出现锐角回折、不出现看不出理由的绕行(委托方红框三连:C8 无解绕线/Y2 旁 90°/
   锐角 45°);d) 排针**逐引脚**丝印标注(GPIO/调试/BOOT 排针一个不落),丝印不压焊盘、
   位号不压标注;e) 板厂能力表落到 .kicad_pro 的板级最小约束(如嘉立创:线宽/距 ≥0.10、
   过孔 0.3 孔/≥0.45 外径、丝印线 ≥0.15 字高 ≥1.0),DRC 0 才算过。
   若宿主提供了 kicad-host-kit(eval/kicad-host-kit)或结构化编辑工具,布线/返工/切角/
   审计一律走工具,**不要用 read_file/write_file 手改 .kicad_pcb**(案例 #11:执行者三次
   文本手术三次写坏 8000 行文件,全部由宿主 pcbnew 重建管线收拾)。
5. 排版纪律(可读性——案例 #9 委托方三次肉眼抓获 + 案例 #11 阶段一 45 处整形手术
   换来的完整规则,目标是"去重叠、易理解"):
   a) **标签方向随引脚朝外**:全局标签沿引脚延长线向符号体**外侧**延伸,禁止穿体——
      左侧引脚用 (at x y 180)+(justify right),右侧引脚用 0+(justify left);
      竖直引脚**成排**时(如 MCU 顶部 VDD 脚组)必须 90/270 竖排,
      水平放置必然叠成一摞(案例 #11:五个 +3V3 标签横排互相全覆盖)。
   b) **文本各占其位,零相交**:值/位号文本不得压引脚标签框、不得压符号体——
      成排电容的值统一放 GND 标签行的下一行或体侧中高处,位号与电源标签框错行错位。
      检验口径:任何文本与图形/导线/其它文本的包围盒不相交(极限贴近可接受,相交不行)。
   c) **功能分块**(量产参考设计惯例):电源/晶振/复位/调试口/BOOT 各自成区,
      同类器件一字排开坐标对齐(如去耦排同 y 一行),组内对称(晶振居中、
      负载电容分居两侧),块间留白;每块配一条用途注释(水平,放分块上下方空位,
      如"VDD 去耦 (pin24/36/48)")。让不看网表的人能按块读懂电路意图。
   d) 器件实例原点全部落 1.27mm 栅格;标签锚点=引脚端点坐标,**移动器件时标签
      精确跟到新端点;只调排版时标签只旋转不平移**——锚点即电气连接点,平移=改网。
   e) **排版=电气冻结下的几何整形**,验收三件套:改动后 ERC 仍 0、网表与改前
      逐网逐节点语义相等、导出 PDF/SVG 供视觉终审。三者缺一不算完成。
6. oracle 纪律:每次实质修改后立刻跑 kicad-cli 实测(原理图: kicad-cli sch erc
   --exit-code-violations;PCB: kicad-cli pcb drc --schematic-parity --exit-code-violations),
   用 -o 输出报告并读它逐条定位修复。报告是唯一事实,不要臆断"应该没问题"。
   **ERC 退出码 0 不等于网络成形**:原理图每次 ERC 通过后必须再
   kicad-cli sch export netlist,确认网表非空、网络数与设计一致、关键网络的引脚归属
   逐条对得上——网表才是布网的地面真值。**不得调低/忽略任何 ERC/DRC 严重度,
   不得用 exclusion 隐藏违例**——修根因,核查者会检查配置是否为默认。
7. 文件版本:改既有文件保留其 (version ...) 与结构;新建文件从任务提供的骨架起步。
8. 每个进度声明都要能对应到一条真实的工具返回结果;没核实的就明说,不要编。
9. 禁止 git 写命令(add/commit/push)——提交由委托方决定。

把结论落到用户要求的产出,并用一两句话总结。用用户使用的语言回答。`;

const KICAD_VERIFY_INSTRUCTIONS = `这是一次【KiCad 设计文件交付】的核查,不要相信报告,逐项实证:
1. 亲自重跑判官:原理图跑 kicad-cli sch erc --exit-code-violations(全严重度,不加过滤),
   PCB 跑 kicad-cli pcb drc --schematic-parity --exit-code-violations;记录真实退出码与违例数,
   与执行者声明比对(有没有隐瞒的违例/靠过滤器蒙混的"零违例")。
2. read_file 读交付的设计文件,逐条核对验收标准里的元件/封装/网络真实存在;网络拓扑用
   kicad-cli sch export netlist 导出后核对(每个网络包含哪些引脚,按字面逐一比对)。
3. 抽查嵌入库件的保真度:用 read_file 读官方库原文(只读根绝对路径),与文档中嵌入段比对
   关键几何(引脚/焊盘坐标),防止执行者手搓库件。
4. 只读核查 + 判官重跑;不要修改任何设计文件。
5. 判定"严重度被降级/配置被操纵"时,以官方 demo 工程
   D:\\KiCad\\share\\kicad\\demos\\ecc83\\ecc83-pp.kicad_pro 的实测值为默认基线——
   **不要凭记忆断言默认值,也不要采信执行者报告的自述(包括"自首")**。
   案例 #9 实测:执行者报告自称降级了一项严重度,核查者凭记忆认定默认是 warning
   而拒签——对照 demo 才发现该项默认就是 ignore,"降级"根本不存在。
6. 视觉核查(工具面上有 describe_image 才做):
   kicad-cli pcb render -o <系统临时目录>/board.png 渲染板子,用 describe_image 带
   **具体问题**核查可数的客观事实——元件是否越出板框、连接器是否贴板边、丝印
   参考号是否可读、有无明显元件重叠。可数事实不符可进 issues(写清看到什么/期望
   什么);"好不好看"类观感只进 advisory。视觉描述是**二手证据**:判 failed 前先用
   DRC 报告或文件坐标交叉印证,两者矛盾时以程序化判官为准并把矛盾写进 advisory。
   工具面上没有 describe_image 时:排版/可读性类验收(标签穿体、文本相压、分块
   布局)不要默默跳过也不要含糊放行——逐条列成 unverified 移交委托方视觉终审,
   并给出用于终审的导出物路径(原理图 PDF/SVG、PCB render PNG)。
7. 排版核查的程序化部分不依赖视觉:成排器件坐标是否对齐/落栅格、标签锚点是否
   与引脚端点重合、移动前后网表是否逐网相等——这些用 read_file 与 netlist 比对
   就能实证,视觉工具缺席不豁免这部分。
8. PCB 布线体检(案例 #11,判据先写、结果后过——DRC 0 只是下限):
   a) 拐角:统计走线拐点角度,90° 折角/锐角回折 → issues(委托方肉眼必抓);
   b) 底层用量:B.Cu 走线总长 ≤ F.Cu 的 40%、单段 ≤15mm,GND 底池轮廓数=1(孤岛为 0)
      → 超出进 issues,并列出元凶网;via 数按"每段 ≤0.35"衡量;
   c) 晶振盒(晶振+负载电容包围盒)内两层无他网走线;
   d) 排针逐引脚丝印:每个排针的每个引脚在丝印层有对应网名文本,缺一进 issues;
   e) 板级最小约束读 .kicad_pro(不是 .kicad_pcb;只拷 pcb 的快照读回默认值),
      与任务指定的板厂能力表逐项比对——达不到进 issues。
   宿主 kit(eval/kicad-host-kit:audit_routing/islands/bruns/fab_check)若在
   read-only 命令白名单里可直接调用;不在时用 read_file 数几何,判据不变。
只要有任何一项对不上(违例数与声明不符、网络拓扑与验收不符、库件几何被改),判 passed=false
并在 issues 里写明:期望什么、实际什么、用什么命令得到。`;

export const PACKS: Record<string, DomainPack> = {
  "stm32-debug": {
    name: "stm32-debug",
    description: "STM32 真机烧录与调试：ST-Link/OpenOCD 上电、烧录 ELF、断点/变量/故障现场取证",
    systemPrompt: STM32_DEBUG_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    // 不给 bash：v1.0 演示实证——给了 bash，执行者会绕开 MCP 自建 openocd/gdb
    // 调试栈,还会 taskkill "清理"时扫死共享的 MCP server。调试动作全走 MCP,
    // 报告用 write_file,读产物用 read_file,足够。
    //
    // A1 决定：**也不给 glob / grep / edit_file**（唯一保持三件套原样的包）。
    // 本包没有源码编辑面——它唯一的写是新起一份报告,write_file 已经够;
    // 而给它一套代码检索面等于向执行者暗示"可以去翻源码、改源码",
    // 而不是驱动探针取真机证据。工具的名字暗示力 > 描述里的免责声明,
    // 这条在本包上是刻意留白,不是遗漏。
    builtinTools: ["read_file", "write_file"],
    mcp: {
      // 读取/诊断默认直接执行；会持久改动 Flash/RAM 或丢失现场的动作必须审批。
      permission: "auto",
      toolPermissions: {
        flash_firmware: "ask",
        flash_and_run: "ask",
        reset_target: "ask",
        write_memory: "ask",
      },
      includeTools: [
        "suggest_server_args",
        "start_debug_session",
        "self_check",
        "halt_execution",
        "load_symbols",
        "flash_firmware",
        "flash_and_run",
        "run_and_wait",
        "run_for_duration",
        "breakpoint",
        "debug_until",
        "capture_state",
        "reconstruct_fault_context",
        "read_call_stack",
        "read_variable",
        "read_memory",
        "read_peripheral_register",
        "write_memory", // 故障注入测试用（如置位触发标志）——真实任务案例 #1 催生
        "reset_target",
        "stop_debug_session",
      ],
    },
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: STM32_VERIFY_INSTRUCTIONS,
      /**
       * 真机核查的每条验收都要多次探针往返（连板 / self_check / load_symbols /
       * 读多个变量 / 跑一段再读），缺省 15 轮装不下——案例 #8 实测两轮 verifier
       * 都跑满 15 轮、都从未写出裁决，最终落到 fail-closed 兜底。
       * 30 的依据：那次核查在第 15 轮时已经完成 5/6 条验收并在追查第 6 条，
       * 约需一倍余量收口；执行者护栏是 40，核查者不应比它高。
       */
      maxTurns: 30,
    },
    resources: ["swd-probe"],
    guardrails: { maxTurns: 40 },
  },

  "stm32-coding": {
    name: "stm32-coding",
    description: "STM32 固件编程：读写 C 源码、CMake 交叉编译、产出可烧录 ELF（交接给 stm32-debug）",
    systemPrompt: STM32_CODING_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    builtinTools: ["bash", "read_file", "write_file", "glob", "grep"],
    mcp: false, // 编程阶段不碰硬件——需要真机时切 stm32-debug 包
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: STM32_CODING_VERIFY_INSTRUCTIONS,
      // 核查必需的最小命令集：重新构建 + 符号/体积检查 + 常规只读探查
      readOnlyCommands: [
        "cmake --build",
        "cmake -B",
        "ninja",
        "arm-none-eabi-nm",
        "arm-none-eabi-size",
        "arm-none-eabi-objdump",
        "ls",
        "grep",
        "wc",
      ],
    },
    guardrails: { maxTurns: 25 },
  },

  "python-coding": {
    name: "python-coding",
    description: "Python 工程：读写源码、pytest/ruff/mypy 质量门禁、交付带测试的变更（不接硬件/MCP）",
    systemPrompt: PYTHON_CODING_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    builtinTools: ["bash", "read_file", "write_file", "glob", "grep"],
    mcp: false, // 纯代码域——需要真机时切 stm32-debug 包
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: PYTHON_CODING_VERIFY_INSTRUCTIONS,
      // 核查必需的最小命令集：质量门禁重跑 + 改动面核对 + 常规只读探查。
      // 刻意不放行裸 "python"/"python -c"（任意代码执行=写风险）；
      // "python -m ruff check" 带子命令,防止前缀误放 ruff format（会改文件）。
      readOnlyCommands: [
        "python -m pytest",
        "python -m ruff check",
        "python -m mypy",
        "python -m compileall",
        "python -m pip list",
        "git status",
        "git diff",
        "git log",
        "ls",
        "grep",
        "wc",
      ],
    },
    guardrails: { maxTurns: 30 },
  },

  "ts-coding": {
    name: "ts-coding",
    description: "TypeScript/Node 工程：读写源码、vitest/tsc 质量门禁、交付带测试的变更（不接硬件/MCP）",
    systemPrompt: `你是一个自主的 TypeScript/Node 工程 agent,在本地 TS 项目中工作。

工程纪律:
1. 动手前先读:package.json(脚本/依赖)、tsconfig、现有代码风格与测试布局——改动必须贴合项目既有约定。
2. 最小改动:只改任务要求的部分,不顺手重构;不引入新依赖(除非任务明说)。
3. 文件修改用 write_file 整文件写回——工具面里【没有】edit_file/patch 之类的编辑工具。改大文件先 read_file 取全文。
4. 每次实质性修改后必须真实运行质量门禁:npx vitest run 与 npx tsc --noEmit,把输出当事实——零错误才算通过;失败读输出定位,不要盲改。
5. 新增行为必须带测试;先跑基线记录通过数,改完确认无回归。
6. 每个进度声明都要能对应到一条真实的工具返回结果;没核实的就明说,不要编。
7. 禁止 git 写命令(add/commit/push)——提交由委托方决定。

把结论落到用户要求的产出,并用一两句话总结。用用户使用的语言回答。` + RULE_PRECEDENCE_DISCIPLINE,
    builtinTools: ["bash", "read_file", "write_file", "glob", "grep"],
    mcp: false,
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: `这是一次【TypeScript 代码交付】的核查,不要相信报告,逐项实证:
1. read_file 读实际源码与测试,逐条核对任务要求的每一处变更真实存在、断言到位。
2. 亲自重跑质量门禁:npx vitest run 与 npx tsc --noEmit,确认退出码与通过数,与报告声明比对。
3. 用 git status / git diff 核对改动面:无任务范围外的文件被改动。
4. 只读核查 + 门禁重跑;不要修改任何源文件。
只要有任何一项对不上,判 passed=false 并写明:期望什么、实际什么、用什么命令得到。`,
      readOnlyCommands: [
        "npx vitest run",
        "npx tsc",
        "node --version",
        // 零依赖项目的质量门禁（案例 #10 催生）：node:test / 语法检查。
        // 信任级别与 npx vitest run 同类——跑项目自己的测试即执行项目代码
        "node --test",
        "node --check",
        "git status",
        "git diff",
        "git log",
        "ls",
        "grep",
        "wc",
      ],
    },
    guardrails: { maxTurns: 40 },
  },

  kicad: {
    name: "kicad",
    description: "KiCad EDA 文件工程：直写原理图/PCB s-expression + kicad-cli ERC/DRC 程序化验收（不碰 GUI/MCP）",
    systemPrompt: KICAD_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    // describe_image：配置了 AGENT_VISION_MODEL 时才真实在场（宿主按池过滤，
    // 没配就干净缺席）。给执行者与核查者同一双眼睛——文本盲是本包全部三条
    // 几何缝（布网/布线/排版，案例 #9）的共同根因
    builtinTools: ["bash", "read_file", "write_file", "glob", "grep", "describe_image"],
    mcp: false, // MCP 创作面已实测判死(见包头注释);文件路线全程不需要
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: KICAD_VERIFY_INSTRUCTIONS,
      // 判官重跑 + 网表导出 + 库件保真抽查所需的最小命令集
      readOnlyCommands: ["kicad-cli", "ls", "grep", "wc"],
      /**
       * 案例 #9/#11 台账实证：默认 15 轮下 kicad 核查几乎每轮靠 wrapup 续命
       * （逐网列举 + 大文件分段读 + 判官重跑装不下），裁决里反复出现
       * "预算用尽未及核查"。25 = 观测所需 + 余量，仍远低于 70 轮执行者护栏。
       */
      maxTurns: 25,
    },
    /**
     * 拆解预算（案例 #9 第二跑实测把默认 12 打穿）：EDA 域的 planner 探索
     * 天然重——要清点工作区、读结构契约、翻 demo 范本、查 kicad-cli 能力，
     * 实测 12 轮 38 次工具调用仍在"再查一件事"的半路；收口续跑也没救回
     * （模型无视"别再调工具"继续取证，见 backlog B0b）。20 = 首跑成功那次
     * 的用量（12 轮 17 调用）× 未收口这次所差的约三分之二余量。
     */
    plan: { maxTurns: 20 },
    /**
     * 执行者轮次（案例 #9 实测把 40 打穿）：调试底板（3 连接器 + 按钮 + LED +
     * 电源开关 + 去耦）主轮与返工各跑满 40 轮，7 个官方库符号抽取完毕但
     * 原理图从未组装出来——预算在"库件保真"工序就烧完了。对照案例 #5：
     * 更小的转接板（2 连接器）全流程用了 36 轮。件数约两倍 → 70 ≈ 36×2。
     * 与核查/计划预算的关系不变（verify 15、plan 20 均远低于它）。
     */
    guardrails: { maxTurns: 70 },
  },
};

export function getPack(name: string): DomainPack | undefined {
  return PACKS[name];
}

/**
 * 按包从已装配的工具池里选工具（宿主用）：
 * - 内置池按 builtinTools 名单过滤（缺省全带）；
 * - MCP 池按包的接入面过滤——false 全不带；includeTools 按【原始名】匹配
 *   （已适配的 MCP 工具名形如 `${server}__${raw}`，见 mcp.ts）；缺省全带。
 * 好处：MCP 只需按 mcp.json 连接一次，按包换工具面是纯内存过滤（三角编排
 * 的子任务切包不用重连 server）。
 */
export function selectPackTools(
  pack: DomainPack | undefined,
  builtinPool: Tool[],
  mcpPool: Tool[],
): Tool[] {
  const rawMcpName = (tool: Tool): string =>
    originalMcpToolName(tool) ?? tool.name.split("__").slice(1).join("__");
  const builtinNames = pack?.builtinTools ?? builtinPool.map((t) => t.name);
  const builtins = builtinPool.filter((t) => builtinNames.includes(t.name));

  let mcp: Tool[];
  if (pack?.mcp === false) {
    mcp = [];
  } else if (pack && typeof pack.mcp === "object" && pack.mcp.includeTools) {
    const allow = new Set(pack.mcp.includeTools);
    mcp = mcpPool.filter((t) => allow.has(rawMcpName(t)));
  } else {
    mcp = mcpPool;
  }
  const packPolicy = pack && typeof pack.mcp === "object" ? pack.mcp : undefined;
  const resolvedMcp = mcp.map((tool) => {
    const rawName = rawMcpName(tool);
    return applyMcpPackPermission(tool, rawName, packPolicy);
  });
  return [...builtins, ...resolvedMcp];
}

// ————— 兼容别名（v0.8 及之前的 Preset 命名）—————
export type Preset = DomainPack;
export const PRESETS = PACKS;
export const getPreset = getPack;
