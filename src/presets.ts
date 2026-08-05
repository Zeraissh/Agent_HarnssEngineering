import type { Tool } from "./types.js";

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
   * 内置工具名单（按工具名）。缺省 = ["bash", "fetch_url", "read_file", "write_file"]。
   * 领域包应只带用得上的工具——多余的工具是触发面噪声。
   */
  builtinTools?: string[];
  /**
   * MCP 接入面：缺省 true（工作目录有 mcp.json 就连）；false = 此包不接 MCP；
   * 对象 = 在 mcp.json 基础上覆盖各 server 的工具白名单/审批策略
   * （如调试包收窄到只读集 + 烧录动作走审批）。
   */
  mcp?: boolean | { includeTools?: string[]; permission?: "auto" | "ask" };
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

const STM32_VERIFY_INSTRUCTIONS = `这是一次【硬件行为】的核查，不要相信报告里的任何数值。你必须自己连上同一块板子独立复核：
1. start_debug_session（server_type openocd，参数用 suggest_server_args 拿），self_check，halt。
2. load_symbols 加载同一个 ELF（路径见任务描述），然后按任务性质独立取证：
   故障诊断用 reconstruct_fault_context 重读故障现场；运行行为验证用 halt 后 read_variable 重读关键变量。
3. 逐项比对执行者的结论与硬件实际：数值、地址、函数/源码行、因果链——是否与你亲自读到的一致。
4. 不要 flash、不要 reset、不要写内存；只做只读复核。结束时 stop_debug_session。
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
2. 坐标纪律:原理图导线端点必须精确落在符号引脚的绝对坐标上(= 符号 at 位置 + 引脚在库件里的
   偏移,注意原理图 y 轴向下、旋转会变换偏移);引脚与导线统一落在 1.27mm 的整数倍栅格上。
   PCB 中 pad 的绝对位置 = 封装 at + pad 相对坐标,走线端点要精确落在 pad 中心。
3. 网络纪律:原理图靠导线与标签成网;PCB 每个参与连接的 pad 都要挂 (net <编号> "<网名>"),
   net 声明表连续完整,网名与原理图一致——DRC 的 --schematic-parity 会逐一核对。
4. oracle 纪律:每次实质修改后立刻跑 kicad-cli 实测(原理图: kicad-cli sch erc
   --exit-code-violations;PCB: kicad-cli pcb drc --schematic-parity --exit-code-violations),
   用 -o 输出报告并读它逐条定位修复。报告是唯一事实,不要臆断"应该没问题"。
5. 文件版本:改既有文件保留其 (version ...) 与结构;新建文件从任务提供的骨架起步。
6. 每个进度声明都要能对应到一条真实的工具返回结果;没核实的就明说,不要编。
7. 禁止 git 写命令(add/commit/push)——提交由委托方决定。

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
    builtinTools: ["read_file", "write_file"],
    mcp: {
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
    },
    resources: ["swd-probe"],
    guardrails: { maxTurns: 40 },
  },

  "stm32-coding": {
    name: "stm32-coding",
    description: "STM32 固件编程：读写 C 源码、CMake 交叉编译、产出可烧录 ELF（交接给 stm32-debug）",
    systemPrompt: STM32_CODING_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    builtinTools: ["bash", "read_file", "write_file"],
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
    builtinTools: ["bash", "read_file", "write_file"],
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

  kicad: {
    name: "kicad",
    description: "KiCad EDA 文件工程：直写原理图/PCB s-expression + kicad-cli ERC/DRC 程序化验收（不碰 GUI/MCP）",
    systemPrompt: KICAD_SYSTEM + RULE_PRECEDENCE_DISCIPLINE,
    builtinTools: ["bash", "read_file", "write_file"],
    mcp: false, // MCP 创作面已实测判死(见包头注释);文件路线全程不需要
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: KICAD_VERIFY_INSTRUCTIONS,
      // 判官重跑 + 网表导出 + 库件保真抽查所需的最小命令集
      readOnlyCommands: ["kicad-cli", "ls", "grep", "wc"],
    },
    guardrails: { maxTurns: 40 },
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
  const builtinNames = pack?.builtinTools ?? builtinPool.map((t) => t.name);
  const builtins = builtinPool.filter((t) => builtinNames.includes(t.name));

  let mcp: Tool[];
  if (pack?.mcp === false) {
    mcp = [];
  } else if (pack && typeof pack.mcp === "object" && pack.mcp.includeTools) {
    const allow = new Set(pack.mcp.includeTools);
    mcp = mcpPool.filter((t) => allow.has(t.name.split("__").slice(1).join("__")));
  } else {
    mcp = mcpPool;
  }
  return [...builtins, ...mcp];
}

// ————— 兼容别名（v0.8 及之前的 Preset 命名）—————
export type Preset = DomainPack;
export const PRESETS = PACKS;
export const getPreset = getPack;
