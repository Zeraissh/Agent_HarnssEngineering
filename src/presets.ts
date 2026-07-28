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
     * - "rubric"：主观质量按评分表判（文案、审美）——低一档，裁决只能当参考。
     */
    mode: "programmatic" | "rubric";
    /** 领域核查方法：注入 verifier 提示，说明如何独立复核 */
    instructions?: string;
  };
  /** 护栏参数（env 显式设置时以 env 为准） */
  guardrails?: {
    maxTurns?: number;
    maxTokens?: number;
    contextTokenLimit?: number;
  };
}

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

export const PACKS: Record<string, DomainPack> = {
  "stm32-debug": {
    name: "stm32-debug",
    description: "STM32 真机烧录与调试：ST-Link/OpenOCD 上电、烧录 ELF、断点/变量/故障现场取证",
    systemPrompt: STM32_DEBUG_SYSTEM,
    // 调试包不需要 fetch_url；bash 留给读构建产物路径等轻活
    builtinTools: ["bash", "read_file", "write_file"],
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
        "reset_target",
        "stop_debug_session",
      ],
    },
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: STM32_VERIFY_INSTRUCTIONS,
    },
    guardrails: { maxTurns: 40 },
  },

  "stm32-coding": {
    name: "stm32-coding",
    description: "STM32 固件编程：读写 C 源码、CMake 交叉编译、产出可烧录 ELF（交接给 stm32-debug）",
    systemPrompt: STM32_CODING_SYSTEM,
    builtinTools: ["bash", "read_file", "write_file"],
    mcp: false, // 编程阶段不碰硬件——需要真机时切 stm32-debug 包
    verify: {
      enabled: true,
      mode: "programmatic",
      instructions: STM32_CODING_VERIFY_INSTRUCTIONS,
    },
    guardrails: { maxTurns: 25 },
  },
};

export function getPack(name: string): DomainPack | undefined {
  return PACKS[name];
}

// ————— 兼容别名（v0.8 及之前的 Preset 命名）—————
export type Preset = DomainPack;
export const PRESETS = PACKS;
export const getPreset = getPack;
