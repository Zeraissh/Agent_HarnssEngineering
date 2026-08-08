# 05 研究发现 (Findings)

本文档是对两周 harness engineering 研究的系统提炼——从仓库 `eval/` 下的全部 A/B 实验报告与 `docs/cases/` 下的真实任务案例中，提取跨报告合并结论，按八个主题组织：方法学、杠杆定律、工具运行时地板、Verifier 学、编排学、领域包、真实任务飞轮、开放问题。每条发现均附原始报告指针，关键数字均经逐字比对验证。

---

## 1. 方法学

### 1.1 A/B 臂设计：控制变量方法论

本项目 A/B 实验的默认设计是**两臂单一变量对照**——baseline 臂（当前 harness 配置 + 单跑，不做核查）与实验臂（改动一个维度），其余条件（模型、用例、REPS）严格对齐。实验臂因研究问题而异：

- **verified 臂**：加 verifier 独立核查 + 最多 1 轮返工（`eval/ab-report.md`、`eval/ab-report-flash.md`、`eval/ab-report-qwen.md`）；
- **verified-strong 臂**：核查者模型与执行者解耦，用更强的模型做核查（`eval/ab-report-strong.md`、`eval/ab-report-hard.md`）；
- **planned-* 臂**：三角编排（planner 拆解 → 执行 → 核查），并行度、planner 模型、拆分协议各为变量（`eval/ab-report-parallel-strongplanner.md`、`eval/ab-report-parallel-struct.md`）；
- **rule-first 臂**：system prompt 注入成文口径优先纪律（`eval/ab-report-rulefirst.md`），副作用用独立副作用臂 `eval/ab-report-rulefirst-side.md` 覆盖三个无冲突精确任务 + 一个软性语义任务；
- **prompt-hint 臂**：system prompt 注入批量命令策略提示（`eval/ab-report-hint.md`）；
- **rework-fresh / rework-inherit 臂**：返工模式对照（`eval/ab-report-rework.md`）。

**方法论原则**：每一轮 A/B 实验独立成报告（一份 `.md` + 对应的 `ab-log.jsonl` 逐 run JSONL + 完整 transcript），三要素齐全——实验臂定义、每臂汇总表（成功率/轮数/tokens）、明细矩阵（逐用例通过次数/轮数/tokens）。`eval/baseline-report.md` 作为 harness 改动的回归基线，任何改动后重跑 `npm run eval` 即可判定行为/效率回归。

**核心教训**：单一变量只在一个维度成立——当 harness 自身有 bug（checker 口径、shell 运行时、verdict 解析）时，实验测的不是"策略差异"而是"缺陷耦合"。方法学上这意味着：**任何 A/B 结论在排除仪器缺陷之前都是假设**。

1. **变量隔离铁律**：baseline 与实验臂的唯一差异必须是目标变量——但这一铁律被 checker bug（`eval/ab-report-diagnose.md`）、shell 运行时错配（`eval/ab-report-hint.md`→`eval/ab-report-bash.md`）、verifier 预算耦合（`eval/ab-report-rep5-rework.md`）三次打破，每次修掉后才拿到干净信号。

2. **注入臂（fixed-*）的价值**：当 planner 本身是混淆变量时（拆分摇摆），用 `opts.plan` 注入固定计划跳过 planner（`eval/ab-report-parallel.md` 的 fixed-serial / fixed-par3 臂），使"调度器并行度"成为唯一变量——墙钟 −58.5%（127.7s→53s），精确贴合关键路径。

3. **副作用臂的必要性**：rule-first 纪律在主对照 `eval/ab-report-rulefirst.md` 中验证有效（7/10→10/10），但需要 `eval/ab-report-rulefirst-side.md` 独立验证"不会让模型在无歧义任务上过度死板"——4 用例 8/8 全过，条款作用面收敛。

### 1.2 REPS 纪律：小样本结论三次被推翻的实录

本项目对 REPS（单格重复次数）执行逐次提额的纪律：REPS=2 的结论视为假设，REPS≥5 才进入采纳决策。

**推翻 #1：弱 verifier 破坏性（`eval/ab-report.md` → `eval/ab-report-rep5-verifier.md`）**

| 阶段 | REPS | 结论 | 关键数据 |
|---|---|---|---|
| 初报（`eval/ab-report.md`） | 2 | 弱 verifier 毁掉 h2-count：baseline 2/2 → verified 0/2；"verifier 必须强于执行者，否则净负" | qwen-9b 自查：h2-count 2/2→0/2 |
| REPS=5 复现（`eval/ab-report-rep5-verifier.md`） | 5 | **破坏性未复现**：qwen 自查与 pro 核查双双 5/5，零假阴性、零破坏性返工 | verified 5/5（11t/38k），verified-strong 5/5（7.6t/14k） |

**推翻原因**：不是模型能力变化，是 harness 缺陷被修掉了——当初 h2 被毁的 run 里有裁决解析失败 → fail-closed 返工；现非 JSON 裁决先重问转写。加之当初 qwen verifier 在 cmd 环境里独立重数容易数错。**曾被推翻**，原结论降级为："弱 verifier 的破坏性主要来自 harness 失效模式，修掉后同强度自查不再净负；强 verifier 的确定优势是核查效率（7.6t/14k vs 11t/38k，约 1/3 成本）。"

**推翻 #2：inherit > fresh 返工模式（`eval/ab-report-rework.md` → `eval/ab-report-rep5-rework.md` → `eval/ab-report-rep5-rework-clean.md`）**

| 阶段 | REPS | 结论 | 关键数据 |
|---|---|---|---|
| 初报（`eval/ab-report-rework.md`） | 2 | inherit 8/8 > fresh 7/8，认为继承正史续跑优于从零重跑 | inherit 100% vs fresh 88% |
| REPS=5（`eval/ab-report-rep5-rework.md`） | 5 | **方向反转**：fresh 4/5 > inherit 2/5。合并 7 次：fresh 5/7 vs inherit 4/7——无显著差异 | fresh 80% vs inherit 40% |
| 干净环境 REPS=5（`eval/ab-report-rep5-rework-clean.md`） | 5 | **平局**：fresh 3/5 = inherit 3/5。三轮合并 fresh 8/12 vs inherit 7/12——无差异 | 两臂各 60% |

**推翻原因**：REPS=2 轮的真返工事件仅 3 起，纯噪声。REPS=5 轮还被 verifier 预算耦合缺陷污染。修复（核查预算固定 15，与执行者解耦；重问提示加防编造规则）后拿到干净平局。**曾被推翻**，结论**悬置**：返工模式在本负载下无显著差异，默认保持 fresh（实现更简单）。

**推翻 #3：planner 拆分率"倾向不拆"（`eval/ab-report-parallel.md` 初报 → REPS=5 复现批）**

| 阶段 | REPS | 结论 | 关键数据 |
|---|---|---|---|
| 初报 | 3（含冒烟） | 拆分率 1/4，flash"倾向不拆" | 3 次 `s1[]` 不拆 |
| REPS=5 复现 | 5 | **拆分率 4/5**。合并 9 次：5/9（~56%），实为 ~50/50 不稳定 | 4 次 fan-out+join |

**推翻原因**：拆分决策落在"能一次完成"与"可并行分片"两条纪律的真歧义区，模型在歧义区里掷硬币——3 次观测不够。**曾被推翻**。合并 14 次 planner 驱动（flash 9 次 + kimi-k3 5 次）后整体拆分率 ~50%，图合法率累计 14/14（零成环/零悬空）。教训：拆分摇摆是纪律歧义区的自由裁量问题，不是能力问题——判断歧义要用确定性规则消除，不能用更强判断者掩盖（详见第 5 节编排学）。

**REPS 纪律总结**：三次推翻中，REPS 从 2→5 后结论两次反转、一次归平。REPS=2 的实验只产生假设；REPS≥5 的实验（且排除仪器缺陷后）才进采纳决策。

### 1.3 仪器错误家族：harness 自身的三类缺陷

#### (a) Checker bug：ground truth 口径歧义

**源头**：`eval/ab-report-diagnose.md` 与 `eval/ab-report-strong.md`。trap-no-newline 与 trap-conditional 两个用例的 checker 存在行数口径 bug：`split("\n")` 口径与 `wc -l` 口径差 1。后果：trap-no-newline 所有按 `wc -l` 答对的 run 被冤判为失败；trap-conditional 奇偶直接反转。修复后 qwen baseline 从 50%（4/8）飙升至 100%（8/8）。

#### (b) Eval 宿主审批打穿：只读约束的静默失守

**源头**：`eval/ab-report-budget.md`（预算轴 A/B 的附带发现）。eval 宿主对一切审批请求先到先得地 allow，把 verifier 内部的自动 deny 变成空操作——此前所有 verified 臂的只读约束在设计上实际失守（行为日志未见实际写操作，但防线被打穿记录在案）。已修：宿主只放行 main/rework 来源的审批。教训：**多层防线之间的仲裁顺序也是仪器的一部分**——防线各自正确、组合后失效，且不产生任何显式错误信号，只能靠审计发现。

#### (c) run.ts 化石：版本锁定导致的假阳性/假阴性

三处 harness 代码级缺陷（`eval/ab-report-rework.md`、`eval/ab-report-rep5-rework.md`）：① executionUsage 漏计——旧版漏计被否掉的主 run token；② verifier 预算耦合——`min(cfg.maxTurns, 15)` 使核查预算也缩到 8；③ 重问机制编造裁决——重问把"无结论的引言"转写成了幻觉通过。三项均已修复。

### 1.4 Transcript 留档破案：通过回放发现根因

本项目在每轮 run 时生成完整 transcript（模型每轮完整消息历史 + 工具调用/输出的逐字节内容），事后回放是定位根因的核心手段。

**案例 1：prompt-hint 证伪 + shell 错配税发现**（`eval/ab-report-diagnose.md`）：四个 run 全部第 1 轮就上批量 grep/sed 管道——策略根本不是瓶颈。轮次烧在 cmd.exe 对 bash 语法的引号/转义崩溃后的环境考古。修掉 shell 错配后（详见第 3 节），同模型/同用例/同 REPS 下成功率从 63% 升至 88%（+25pp），平均 tokens 从 47.3k 降至 28.3k（−40%）。

**案例 2：返工模式机制的裁决序列分析**（`eval/ab-report-rework.md`）：唯一决定性差异格（import-list）上，fresh rep1 裁决序列 F→F（从零重蹈覆辙），inherit rep2 裁决序列 F→P（带着已有探索增量修复）。

**案例 3：弱 verifier 破坏性的 transcript 溯源**（`eval/ab-report-strong.md`）：强 verifier（deepseek-v4-pro）用 hex dump 抓出确切字节 `22 31 31 22 20 20 0d 0a`，裁决 failed→返工修复——完整闭环。弱 verifier 根本没有这种字节级核查能力（详见第 4 节强弱核查对照）。

---

## 2. 杠杆定律（提示词三定律）

以下三条定律综合了本项目全部 A/B 实验的证据链，按"信号纯度"从低到高排列为优先级排序。

### 2.1 prompt-hint 证伪：提示词打在能力/环境缺口上无效

**证据链**：`eval/ab-report-hint.md` + `eval/ab-report-hard.md` + `eval/ab-report-diagnose.md` + `eval/ab-report-bash.md`

hard-import-list 在 baseline 上 0/2（全 max_turns 耗尽）。假设"模型缺乏批量命令策略"，注入 prompt-hint 臂，对照 budget-30 臂（纯提轮数上限）。

| 臂 | 成功率 | import-list | substring-count |
|---|---|---|---|
| baseline（`eval/ab-report-hard.md`） | 63%（5/8） | 0/2 | 2/2 |
| prompt-hint（`eval/ab-report-hint.md`） | 63%（5/8） | 0/2 | 1/2 |
| budget-30（`eval/ab-report-diagnose.md`） | 50%（1/2） | 1/2 | — |
| 真 Git Bash 修复后（`eval/ab-report-bash.md`） | **88%（7/8）** | 1/2 | 2/2 |

**结论**：prompt-hint 对目标用例 0 收益（0/2→0/2），且有副作用（substring-count 退化、chain 单 run token 爆到 163k）。transcript 回放显示模型本来就会第一轮上批量管道：**策略不是瓶颈，cmd.exe 冒充 bash 才是**。修掉 shell 错配后，成功率从 63% 升至 88%，tokens 降 40%（详见第 3 节地板效应）。

> **定律一**：提示词是弱杠杆——当瓶颈在能力（模型不会）或环境（工具运行时不匹配）时，提示词无效且有副作用。修环境 > 写提示词。

### 2.2 rule-precedence 10/10：提示词打在决策歧义点上高效

**证据链**：`eval/ab-report-rulefirst.md` + `eval/ab-report-rulefirst-side.md`

baseline vs rule-first（system prompt 注入成文口径优先纪律），2 用例 × 2 臂 × 5 次。

| 用例 | baseline | rule-first |
|---|---|---|
| hard-import-list | 3/5 | **5/5**（平均轮数 8.6→6.6） |
| xhard-export-chain | 4/5 | **5/5** |
| **合计** | **7/10（70%）** | **10/10（100%）** |

副作用检查（`eval/ab-report-rulefirst-side.md`）：4 用例 8/8 全过——条款以"任务给出成文口径"为触发条件，作用面收敛。失败模式 100% 命中目标：baseline 全部 3 次失败均为 letter-vs-spirit（transcript 实锤），零基建/格式噪声混入。

> **定律二**：提示词是弱杠杆，但打在决策歧义点上就是够用的杠杆；打在能力/环境缺口上则无效。判断歧义 → 一句话有效；能力缺口 → 修模型/修环境。

### 2.3 强 planner 证伪：判断歧义不能用更强的判断者掩盖

**证据链**：`eval/ab-report-parallel-strongplanner.md` + `eval/ab-report-parallel.md` + `eval/ab-report-strong.md`

flash planner 拆分率 5/9（~56%），摇摆 ~50/50。假设"更强的 planner 模型能稳定拆分"——用 kimi-k3 做 planner、flash 做执行者（`eval/ab-report-parallel-strongplanner.md`，5 次）。

| planner 模型 | 拆分率 | 计划形状数 | planner 墙钟均值 |
|---|---|---|---|
| flash（freeform） | 5/9（~56%） | 2 种 | ~80s |
| kimi-k3（freeform） | **2/5（40%）** | 2 种 | ~199s |

**假设证伪**：kimi-k3 拆分率 2/5 vs flash 5/9——同为掷硬币，摇摆纹丝不动。planner 墙钟反而 2.5× 纯亏。图合法率累计 14/14——瓶颈从来不是"写不对图"，是"拆不拆"的摇摆。根本原因：拆分决策落在"能一次完成"与"可并行分片"的真歧义区，什么强度的模型都在歧义区里掷硬币。

> **定律三**：判断歧义要用确定性规则消除，不能用更强的判断者掩盖。歧义消不掉时，把裁量移出模型——宿主规则 + 模型只出事实。

### 2.4 结构化协议证实：裁量移出模型后摇摆消失

**证据链**：`eval/ab-report-parallel-struct.md` + `eval/ab-report-parallel-strongplanner.md`

实施结构化拆分协议：模型只枚举互不依赖分片 + 预估轮数（estTurns）+ 可选 join，拆不拆由宿主 `SplitRule` 纯函数判定。

| 协议 × planner 模型 | 拆分率 | 形状方差 | planner 墙钟均值 |
|---|---|---|---|
| freeform × flash | 5/9 | 两种形状 | ~80s |
| freeform × kimi-k3 | 2/5 | 两种形状 | ~199s |
| **structured × flash** | **5/5** | **零（五次全同）** | **~29s** |

分片枚举 3/3/3/3/3 零方差，estTurns 稳定在 2–3。"任务有几个写集不相交的部分"是事实问题，模型答得稳；"值不值得拆"是裁量问题，谁来答都掷硬币。**决策点归宿主后摇摆消失**，planner 反而快 2.7×（详见第 5 节结构化协议）。

> **定律三的推论（已证实）**：把裁量移出模型（宿主规则 + 模型只出事实），摇摆源头即消——且模型在"事实枚举"上稳定得多。

### 2.5 优先级排序：修环境 > 提示词 > 事后核查

| 优先级 | 手段 | 证据 | 效果量级 |
|---|---|---|---|
| **1. 修环境** | 工具运行时（cmd→bash）、checker 口径修复、harness 缺陷修复 | `eval/ab-report-bash.md`（63%→88%，tokens −40%）；`eval/ab-report-strong.md`（修复 checker bug 后 baseline 50%→100%）；`eval/ab-report-rep5-rework.md`（verifier 预算解耦后信号才干净） | **+25pp ~ +50pp**，成本零或负 |
| **2. 提示词打在歧义点** | 规则遵从优先级纪律、收口句约束 | `eval/ab-report-rulefirst.md`（70%→100%，10/10）；`eval/ab-report-parallel.md`（planner 收口句使汇总步快 3–4×） | **+30pp**，成本低廉 |
| **3. 结构化协议** | 决策点移出模型（规则判定替代自由裁量） | `eval/ab-report-parallel-struct.md`（拆分率 5/5 零方差，planner 快 2.7×）；副作用臂 8/8 | 消除摇摆、降低成本 |
| **4. 事后核查（verifier）** | 强核查 + 返工 | `eval/ab-report-strong.md`（强 verifier 救回字节错误）；`eval/ab-report-hard.md`（仅覆盖"完成但错误"） | **条件性有效**，代价 ~2.5× tokens |

**不推荐的顺序**：提示词打能力/环境缺口（`eval/ab-report-hint.md`：0 收益 + 副作用）；弱 verifier 自查（`eval/ab-report.md`：净负——REPS=5 修正为"修复 harness 缺陷后不再净负，但仍无增益"）；更强模型替代确定性规则（`eval/ab-report-parallel-strongplanner.md`：摇摆纹丝不动 + 墙钟 2.5× 纯亏）。

---

## 3. 工具运行时地板

核心论点：模型能力固定时，**工具运行时的质量构成了 Agent 表现的下限**——名字与运行时错配、工具链残缺、回执与行为不一致，三者各自从不同层面压低 Agent 的有效能力。修环境一分钱不花，效果超过任何提示词工程和事后核查。

**发现 1 —— shell 错配税：−40% tokens，+25pp 成功率**（`eval/ab-report-bash.md`）

`eval/ab-report-bash.md` 与 `eval/ab-report-hard.md` 的 baseline 构成唯一变量对照：同模型、同用例、同 REPS，唯一差异是 bash 工具的运行时从 `cmd.exe` 换成真正的 Git Bash。

| 指标 | cmd 时代 | bash 时代 | 变化 |
|---|---|---|---|
| 成功率 | 5/8 (63%) | 7/8 (88%) | **+25pp** |
| 平均轮数 | 11.0 | 8.1 | **−26%** |
| 平均 tokens | 47.3k | 28.3k | **−40%** |
| hard-import-list | 0/2（全 max_turns） | 1/2 | 复活 |

机制：模型看到工具名叫 `bash` 就写 bash 管道（策略完全正确），但 cmd.exe 的引号转义让管道崩掉，每个 shell 重度任务固定烧 5–10 轮做环境考古。模型按名字选择策略，然后被运行时打回去——**这不是模型能力问题，是 harness 基建问题。**（详见第 2 节定律一：prompt-hint 证伪。）

**发现 2 —— `bash -c` 不跑 profile，coreutils 全赌父进程 PATH**（`eval/ab-report-budget.md`、`eval/ab-report-kimi.md`、`docs/cases/case-04-probe-lock-python.md`）

三层问题：① `grep` 在管道末尾吃掉前序命令的退出码——npm test 的实际失败被 grep 过滤掩盖（`eval/ab-report-budget.md`）；② 跨厂商网络可达性——kimi-k3 verifier 需要 `api.moonshot.cn` 路由正确（`eval/ab-report-kimi.md`）；③ Git Bash 拉起但 `bash -c` 不跑 profile，`wc`/`grep`/`sed` 全赌父进程 PATH——PowerShell/计划任务中 `wc: command not found`（详见第 6 节 python-coding 包）。修复：bashTool 自动把 Git `usr\bin` 前置进子进程 PATH——工具自带运行时完整性，不赌宿主环境。

**发现 3 —— MCP「回执 ok ≠ 生效」——文档态才是真值**（`docs/cases/case-05-kicad-swd-adapter.md`）

MCP 工具的 `status:ok` 只是 JSON-RPC 收发成功回执，不是"文档已修改"。落盘矩阵实验（逐 api 直连验证文档变化）：`drawMultiWire` ✔ 落盘；但 `placeSymbol`、`createPcbPad`、`drawPcbTrack`、`placePcbVia` 全部返回 ok 但文档不变。根因埋在闭源 C++ 侧不可达。任务转向文件生成路线（直写 KiCad s-expression + kicad-cli headless ERC/DRC）——当工具运行时不可靠时，退回到 Agent 可直接控制的文件层面反而是更稳健的策略（详见第 7 节案例 #5）。

**综合结论**——三层递进：

| 层级 | 问题 | 修复成本 | 效果 |
|---|---|---|---|
| cmd 冒充 bash | 名字暗示 bash → 模型写 bash 管道 → cmd 炸掉 | 改一行 shebang | −40% tokens, +25pp 成功率 |
| bash 缺 coreutils | `bash -c` 不跑 profile，coreutils 赌 PATH | 工具启动时前置 PATH | 消除 `wc: command not found` 类失败 |
| MCP 回执 ok ≠ 生效 | JSON-RPC 成功 ≠ 文档已修改 | 落盘矩阵实验（前置仪器） | 避免在死工具上浪费数十轮 |

`eval/ab-report-mut.md` 提供了反面印证：当工具运行时干净 + 任务自带快速 oracle，flash 模型变更任务达到 9/9 饱和——工具运行时地板铺平之后，模型能力的上限才能充分释放。

---

## 4. Verifier 学

核心论点：Verifier（独立核查子代理）不是银弹——它的价值域有明确边界，fail-closed 设计会产生可枚举的误伤形态，有效性依赖白名单、设计原则和信号源选择。

**发现 4 —— verifier+返工管线的两种无效场景**（`eval/ab-report-hard.md`、`eval/ab-report-diagnose.md`）

verifier+返工管线只覆盖"完成但错误"这一种失败："根本没完成"的两种失败（stopReason=error 和 max_turns 耗尽）它都无能为力。`eval/ab-report-hard.md`：hard-import-list verified-strong rep1 主 run 耗尽 → 返工又耗尽，30 轮 127k tokens 全打水漂。verifier 的价值域夹在两条边界之间：执行者太强 → 没错可救；执行者失败在预算/基建层 → 救不着。**只有"能力边界附近的语义错误"才是 verifier 的主场。**

**发现 5 —— 弱 verifier 破坏性来自 harness 失效模式，修掉后同强度自查不再净负**（`eval/ab-report-rep5-verifier.md`、`eval/ab-report-rework.md`）

REPS=5 对照实验推翻了早期结论（"弱 verifier 必须强于执行者，否则净负"）：

| verifier 臂 | 成功率 | 平均轮数 | 平均 tokens |
|---|---|---|---|
| verified（qwen 自查） | 5/5 | 11.0t | 38k |
| verified-strong（pro 核查） | 5/5 | 7.6t | 14k |

当初 h2-count 2/2→0/2 的破坏链条已被修复：① verdict 重问机制上线；② 真 Git Bash 替换 cmd。修订版原则："弱 verifier 的破坏性主要来自 harness 失效模式；强 verifier 的确定优势是核查效率（约 1/3 成本）与裁决质量余量。'核查者 ≥ 执行者'仍是稳妥默认，但不再是硬性前提。"

**发现 6 —— fail-closed 的三种误伤形态（假阳性）**（`eval/ab-report-hard.md`、`eval/ab-report-rework.md`、`docs/cases/case-04-probe-lock-python.md`）

三种形态：① **裁决解析失败**——verifier 产出空输出或非 JSON 裁决时，fail-closed 直接判失败，可能误伤正确产物（`eval/ab-report-hard.md`）；② **核查预算耦合**——verifier 自身轮次/token 预算与核查任务复杂度耦合，预算耗尽无法完成核查 → fail-closed 假阳性（`eval/ab-report-rework.md`）；③ **核查饥饿（白名单缺失）**——verifier 取证能力不足，把"查不了"错判成"没做对"，代价最高——触发 22 轮返工，零写入、纯粹重证明了已经为真的东西（详见发现 7）。

**发现 7 —— 核查白名单 = 返工经济性**（`docs/cases/case-04-probe-lock-python.md`）

case-04 的 A/B 对照量化了白名单影响：

| 配置 | verifier 取证方式 | 返工次数 | 裁决质量 |
|---|---|---|---|
| 通用配置（无白名单） | bash 全 deny，只能读文件间接推断 | **22 轮返工** | "无实质结论" |
| python-coding 包（有白名单） | 亲手重跑 pytest/ruff/mypy/compileall + git diff 取证 | **0 返工** | 裁决带第一手数字 |

白名单使 verifier 从"只能读文件的被动观察者"升级为"能亲手重跑门禁的主动验证者"（详见第 6 节 python-coding 包）。deny 消息即教学，白名单即能力边界说明书。

**发现 8 —— rule-precedence 纪律在 verifier 裁决端同样适用**（`eval/ab-report-rulefirst.md`）

baseline vs rule-first（各 5 次 × 2 用例）：**合计 7/10 → 10/10**，失败模式 100% 命中 letter-vs-spirit 目标，零基建/格式噪声。该纪律已进入 `src/presets.ts`。verifier 评判执行者产出时，同样以任务给出的成文规则为最高优先级——消除 verifier 与执行者在规则解释上的不一致空间（详见第 2 节定律二）。

**发现 9 —— verifier 的裁决 summary 是返工决策的唯一信号源**（`eval/ab-report-rework.md`）

fresh 返工只拿到裁决文字，容易重蹈覆辙；inherit 返工能看到上一轮全部工具输出 + 被否产物，修复是增量的。裁决 summary（结构化 P/F + 证据）足以驱动"是否返工"，但单独不足以支撑"怎么修"——高效返工需要 summary + 被否产物的组合信号。verifier 不需要也不应处理完整执行 transcript：核查只需检查最终产物，不需知道执行者经历了多少轮挣扎。

---

## 5. 编排学

**发现 10 —— 单领域任务上编排是纯开销，跨领域/长管线才是编排的主场**（`eval/ab-report-parallel.md`）

baseline 臂（单 agent 直跑）在 par-fanout 用例上以 31k tokens / 41s 墙钟完胜所有编排臂——planned 臂同一任务 112k tokens / 231s，token 膨胀 3.6×、墙钟膨胀 5.6×。编排的价值边界在跨领域交接（如 coding→debug→验证）与高风险需独立核查的场景。

**发现 11 —— 并行化不改变"该不该编排"的答案，只把"编排贵在时间"这条反对理由划掉了一半**（`eval/ab-report-parallel.md`）

并行把 planned 的墙钟罚金从 3.1×（fixed-serial 128s）压到 1.3×（fixed-par3 53s），但 token 开销仍在——编排的 token 成本是结构性的，并行只解决时间维度。

**发现 12 —— 同 DAG 下并行调度墙钟 −56%~−62%，精确等于关键路径**（`eval/ab-report-parallel.md`、`eval/ab-report-parallel-curve.md`、`docs/cases/case-02-parallel-reference-docs.md`）

fixed-par3 平均 53s vs fixed-serial 127.7s（**−58.5%**），三个 rep 并行墙钟恰好等于 max(分片) + 汇总。收益曲线：serial 210s → par3 93s（−56%）→ par6 79s（−62%，对 par3 仅 −15%）。案例 #2（并行参考文档）：子任务阶段墙钟 512s vs 串行合计 904s（**−43%**），关键路径精确成立。

**发现 13 —— 并行度翻倍边际收益锐减，AUTO_CONCURRENCY_CAP=3 获曲线背书**（`eval/ab-report-parallel-curve.md`）

par6 对 par3 仅 −15%，衰减来自：① 汇总步不可并行（Amdahl 定律，19–39s）；② 并发 12 路流下出现 44–53s 慢尾（疑似端点排队）。**cap=3 恰好在收益曲线拐点处**。

**发现 14 —— REPS=5 复现证实并行收益稳定**（`eval/ab-report-parallel-rep5.md`、`eval/ab-report-parallel-smoke.md`）

planned-par3 ×5，5/5 pass，4/4 精确贴关键路径。`eval/ab-report-parallel-smoke.md` 冒烟测试暴露了"planner 与调度器混淆"的架构问题，催生了 fixed-* 注入臂的解耦实验设计（详见第 1 节方法学）。

**发现 15 —— 自由裁量协议下拆分率 ~50/50，无论模型强弱**（`eval/ab-report-parallel.md`、`eval/ab-report-parallel-rep5.md`、`eval/ab-report-parallel-strongplanner.md`）

flash 拆分率 5/9（~56%），kimi-k3 拆分率 2/5（40%）——同为掷硬币。拆分摇摆是纪律歧义区的自由裁量问题，不是能力问题（详见第 2 节定律三）。

**发现 16 —— 结构化拆分协议实现 5/5 零方差**（`eval/ab-report-parallel-struct.md`）

模型只枚举互不依赖分片 + 预估轮数，宿主 `SplitRule` 纯函数判定拆不拆：拆分率 5/5、五次全同、分片枚举 3/3/3/3/3 零方差。planner 反而快 2.7×（29s vs 80s）、更便宜（9–32k tok vs 13–64k tok）。

**发现 17 —— 协议对照全景：freeform-flash 5/9 → freeform-kimi 2/5 → structured-flash 5/5**（`eval/ab-report-parallel-struct.md`、`eval/ab-report-xhard.md`）

完整呈现杠杆定律：能力/环境缺口 → 提示词无效，修环境；判断歧义 → 一句纪律有效；歧义消不掉 → 裁量移出模型。

**发现 18 —— 编排器内部互斥 ≠ 跨进程锁——两层缺一不可**（`docs/cases/case-03-dual-probe-parallel.md`）

编排器内部的审批互斥门只保证并发子任务审批不交错，管不到进程之间。双 OpenOCD 会话（端口 3343/3353）全程共存，资源标签（`probe-stlink` / `probe-daplink`）正确性经受住实战。墙钟节省 **−34%**（361.8s vs 549.6s）。

**发现 19 —— 跨进程探针锁从事故中催生**（`docs/cases/case-04-probe-lock-python.md`、`docs/cases/case-03-dual-probe-parallel.md`）

探针 OS 级锁（`probe_lock.py`，stdlib-only），锁键三级派生 serial→interface cfg→server_type。真机 HIL 三场景全绿：活持有者抢占报 PID、僵尸 openocd 归因到 child PID、双死陈锁自动清理（详见第 6 节 python-coding 包催生）。

**发现 20 —— 规模张力 = 另一种资源竞争**（`eval/ab-report-scale.md`、`eval/ab-report-xhard.md`）

scale-audit（60 模块依赖图传递闭包）2/3 通过，唯一失败是 max_turns 耗尽——flash 级模型上唯一存活的区分轴是"轮次预算 × 规模张力"（详见第 8 节规模轴）。

---

## 6. 领域包

DomainPack = 五件套——工具面、prompt、核查、护栏、评估，由 `AGENT_PACK` 环境变量切换。

| 组件 | 职责 | 架构层映射 |
|---|---|---|
| **工具面** | 领域专用 Tool 注册（MCP 白名单、自定义工具），收窄通用能力面 | L2 ToolLayer |
| **prompt** | 领域系统提示：领域知识纪律、格式约束、"何时用哪个工具" | L3 ContextManager |
| **核查** | verifier 只读命令白名单 + 领域特定取证步骤 | L4 Verifier |
| **护栏** | 领域危险操作许可、预算上限 | L1 AgentLoop + L2 permission |
| **评估** | 领域用例与程序化判定 | eval/ |

**发现 21 —— stm32-coding 包：被固件缺陷催生**（`docs/cases/case-01-telemetry-firmware.md`）

case-01 遥测固件的 boot_count +510 缺陷——SysTick ISR 里误挂 `g_boot_count++`，导致每次 SysTick 中断都自增。verifier 的 **remarks 比 verdict 更早暴露了缺陷**：执行者将 +510 合理化（"持续递增，PASS"），verifier 在 summary 里点名增量与标注不符。包由此催生：固件代码正确性需要领域特定编码纪律（magic 门控、`.noinit` 段）和对应核查白名单。coding→debug 双包接力 + verifier 独立连板复核完整验证了包间交接正确性（详见第 7 节案例 #1、第 8 节 rubric-verifier）。

**发现 22 —— stm32-debug 包：被真实硬件交互缺口催生**（`docs/cases/case-01-telemetry-firmware.md`、`docs/cases/case-03-dual-verify.md`）

两个缺口：① SWD 链路抖动下执行者重连风暴（首轮 7 次 `start_debug_session`）；② 调试包缺 `write_memory` 工具——故障注入是正当调试动作但当时不在白名单。`docs/cases/case-03-dual-verify.md` 的双板对照验收进一步验证了 debug 包的验收协议——uptime 增量 ±10% 容差窗、hclk/magic 字面比对、boot_count 严格 +1 判定。

**发现 23 —— python-coding 包：被核查饥饿催生**（`docs/cases/case-04-probe-lock-python.md`）

通用配置轮暴露两个精准缺口：① verifier 无核查白名单 → bash 全 deny ×6 → 首次核查"无实质结论" → fail-closed 误判 → 22 轮返工、零写入（地面真值：四道门禁已全绿）；② 执行者幻觉调用 `edit_file`（只有 `write_file`）。python-coding 包对症：核查白名单（pytest/ruff/mypy/compileall + git 系列）+ 系统提示成文"工具面没有 edit_file"。A/B 结果：零返工，裁决带第一手数字（详见第 4 节发现 7）。`docs/cases/case-05-kicad-swd-adapter.md` 的 kicad 包首战即防住了同一陷阱。

**发现 24 —— kicad 包：被 EDA 领域文件格式深层结构缺口催生**（`docs/cases/case-05-kicad-swd-adapter.md`）

原理图阶段三发才过：发 1 = API 瞬断；发 2 = 双拒签暴露真实能力缺口——执行者不知道 KiCad 7+ 格式的两条硬结构：`lib_symbols` 嵌入段、符号实例的 `(instances ...)` 注释段（缺后者 = 网表导出为空）；发 3 = 任务书补【结构契约】+ 指向官方 demo 当结构范本，一杆命中。kicad 包核心理念有三：① 核查白名单首战防住核查饥饿（三轮核查全部第一手取证，零空转返工）；② 领域文件格式深层结构 = 能力缺口新形态，官方范本是对症药；③ MCP 不可轻信——文档态才是真值（详见第 3 节发现 3、第 7 节案例 #5）。

---

## 7. 真实任务飞轮

### 7.1 飞轮总览

五个真实案例构成一条从"需求 → 执行 → 暴露问题 → 方法论/工具改进 → 回灌 harness → 下一案例受益"的闭环飞轮。每案产出的改进已在后续案例中验证生效。

### 7.2 五案飞轮表

| 案例编号 | 需求描述 | 暴露的问题 | 催生的方法论/工具改进 | 落地闭环证据 |
|---|---|---|---|---|
| **#1** | STM32L151 遥测+故障闩锁固件：从一句话任务书到真机五项验收 | ① verifier 备注比裁决更早暴露固件缺陷（+510 被合理化）；② verifier 裁决端 letter-vs-spirit 宽纵；③ SWD 链路抖动下重连风暴 | ① **rule-precedence 纪律延伸进 verifier 提示**；② **调试包 write_memory 加入白名单**；③ **任务书内嵌执行纪律** | `docs/cases/case-01-telemetry-firmware.md`：4 个 run，verifier 两次正确拒签；`eval/pilot-hw-verify.md`：先导硬件验证模式（除零修复，5/5 PASS） |
| **#2** | 为 21 个 src/ 模块生成参考文档：三份分组文档 + 索引 | ① freeform 拆分协议 ~50/50 摇摆；② 汇总步 planner 版比手写注入版慢 3–4× | ① **结构化拆分协议**——拆分率 5/5 零方差；② **planner 提示词补汇总收口句**；③ **AUTO_CONCURRENCY_CAP=3** | `docs/cases/case-02-parallel-reference-docs.md`：墙钟 −43%（512s vs 904s）；`eval/baseline-report.md`：5/5 基线确保回归检测框架就绪 |
| **#3** | 双板（ST-Link + DAPLink）并行烧录 + 三项硬件验收 + 双板对照汇总 | ① 两层白名单交集陷阱——交集只剩 9 工具；② 跨进程探针锁缺失——hypo 会话致 A 板 11 次秒败；③ 执行者幻觉出不存在的工具名 | ① **连接层白名单 = 各包需求并集**；② **探针 OS 级锁需求**写入 stm32-gdb-mcp；③ **失败形态即证据**方法论 | `docs/cases/case-03-dual-probe-parallel.md` + `docs/cases/case-03-dual-verify.md`：四轮才通，墙钟 −34%；`eval/plan-verify-2.md`：计划→执行→独立核查→报告闭环先例 |
| **#4** | 给 stm32-gdb-mcp（Python 3.13）实现探针 OS 级锁——案例 #3 的需求闭环 | ① 核查饥饿——22 轮返工纯重证已为真；② 通用工具面缺口——幻觉调用 `edit_file`；③ bash 工具第三层地板缺陷 | ① **python-coding 领域包当日落地**——零返工；② **bash 工具自动补齐 PATH**——全局收益 | `docs/cases/case-04-probe-lock-python.md`：916 passed，HIL 三场景全绿 |
| **#5** | KiCad SWD 调试转接板：原理图 + PCB + 制造输出全套 | ① MCP "回执 ok ≠ 生效"——落盘矩阵实验证伪；② 领域文件格式深层结构缺口——不知道 `lib_symbols` 嵌入段和 `(instances ...)` 注释段 | ① **落盘矩阵实验方法论**；② **结构契约 + 官方 demo 范本对症**；③ **kicad 包核查白名单首战防住核查饥饿**——case-04 教训兑现 | `docs/cases/case-05-kicad-swd-adapter.md`：ERC 零违例 + DRC 三个零 + 全套 Gerber |

### 7.3 评估体系如何嵌入飞轮

三份评估报告定义了飞轮的"度量仪表盘"：

- **`eval/baseline-report.md`**（5/5）：定义了 harness 的行为回归基线——飞轮的**安全网**，任何改进合并前基线跑绿是前置条件。
- **`eval/pilot-hw-verify.md`**：首次真机硬件验证先导，确立了"自检→烧录→多轮采样→逐项判定→原始工具输出摘要"的真机验收模板，案例 #1、#3 均继承此模板。
- **`eval/plan-verify-2.md`**：计划→验证闭环的第二实例——planner 拆解 coding/debug 两包，verifier 独立连板逐条复核 8 项验收标准，为案例 #1 的三角编排提供了可复用验收清单格式。

飞轮运转逻辑：**基线定义参考系 → 先导验证建立模板 → 案例实战产改进 → 改进回灌 harness → A/B 量化收益 → 下一案例受益 → 基线更新**。

---

## 7.5 宿主学（2026-08-07~08 新增）

核心论点：**harness 的能力与宿主能不能用上它，是两件事。** 这一节的每条都来自
"能力早就在、只差接线"的实际形态——它出现得太频繁，已经足以当方法论。

**发现 34 —— "harness 有、宿主没接"是稳定规律，且缺口会即刻生成**
（`docs/06-backlog.md` 第零节、案例 #7/#8）

累计 **8 例**：会话正史 `result.messages`、thinking 块、`runContinuation`、
角色模型、`runPlanned`、文本流式 `text_delta`、MCP 接入、思考块透出。
前五例的形态是"旧宿主落后于新 harness"，后三例改写了这条规律：

- **文本流式**：服务端 R2 起就在推 `event: delta`，前端一行 `return state` 丢弃。
  实测一次约 90 秒的运行流了 **1133 条 delta**，全被扔掉。
- **MCP 接入**：`ui/server.ts` 连 `src/mcp.js` 都没 import，`AGENT_UI_MCP=1` 只改
  状态快照文案。后果不是"少个功能"——**`stm32-debug` 这类全 MCP 工具面的包在
  Web 宿主下等于废的**，agent 只拿得到 read_file/write_file。
- **`api_retry.backoffMs`**：**在加这个字段的同一个提交里就产生了缺口**——
  前端 reducer 是逐字段白名单投影的，新字段默认被静默丢弃，且不报任何错。

**所以规律要改写**：不只是"旧宿主落后"，而是**只要 harness 加字段而不同时接
宿主，缺口就即刻生成**。本轮同一条踩了**四次**（`backoffMs`、
`verifierBudgetTurns`、`run_config` 扩展、`assistant_thinking`）。

> **纪律**：harness 加一个字段 = 同一个提交里把宿主那一侧一起接上，并加一条渲染锁。
> 具体到 `ui/public/app.js`，加字段必查**三处**：`reduceEvent` 的投影分支、
> 派生函数（`derive*Face`）、渲染分支。

**同族的另一种谎话**：改了语义却没改文案。把常量改成可配置时（核查预算 15 →
按包可覆盖），`/api/harness` 里写死的数字和界面上那句"（固定）"当场都变成假话。
**改常量为可配置时，要搜一遍谁在文案里承诺过它"固定"。**

**发现 35 —— 纯函数全绿 ≠ 那条路径对：单测覆不到"纯函数与控制器的缝"**
（案例 #8 期间实测）

`applySegmentDone` 的快路径"非核查模式下 done 即终止"不限定来源，而编排模式下
**planner 自己那一轮也发 `done(completed)`**。reducer 单测逐条喂事件、从不关连接，
所以永远绿；真机上控制器看到 `status === "done"` 就 `es.close()`，之后的
`plan_result` / 子任务进度 / `run_end` 全丢，界面停在"已完成"并把 planner 的
JSON 当执行者报告展示。触发条件是 `mode=plan` 且未勾核查——**正是选了"计划编排"
之后的默认组合**。

这就是 V-01 那条「段终止 ≠ run 终止」，当时在**服务端事件层**修过，
**reducer 侧漏掉了同一条**。

> **两条推论**：
> ①凡"reducer 的某个输出会驱动控制器做副作用"（关连接、停轮询、清缓冲），
> 必须另有一条走真实控制器的验证；
> ②**一条修在 A 层的纪律，要回头查它在 B 层有没有同构的漏网。**

**发现 36 —— 诊断手法：重放对比 live**（案例 #8）

界面与服务端不一致时，把服务端事件拉下来**在页面里用同一份 reducer 重新 reduce
一遍**。结果对 → 派生逻辑没错，是实时投递断了；结果也错 → reducer 的问题。
一步就把两类原因分开，不必逐层猜。

**发现 42 —— 补偿是症状药，布局才是病：先问"这东西为什么会动"**
（委托方两轮反馈，2026-08-08）

审批栏原本在滚动容器顶部，于是每次它变高变矮，下面的内容整块平移——用户点一下
"允许"，正在读的地方就被甩走。我的第一反应是**加滚动补偿**（记录锚点位置、补丁后
反向补 `scrollTop`）。做出来更糟：新审批卡冒出来时锚点下移，补偿把视口一起往下拉，
把那张**刚出现、正等着人点**的卡推出了视野。我于是给补偿加了方向不对称
（"长高让它长，变矮才补偿"）——**在给补丁打补丁**。

委托方给的是结构解法：**把输入框移到底部，待办钉在输入框正上方、放在滚动容器
之外**。这一改，三个问题一起没了：①它不在滚动流里，变高变矮只改变滚动容器的
高度，容器内容一动不动，**补偿函数连同它那五条测试直接删掉**；②它在固定位置，
用户翻到哪都看得见；③给它 `max-height:42vh; overflow-y:auto`，"无限堆叠"变成
有界内滚——实测 8 张卡时坞高 302px、内部自滚、输入框位置不动、页面整体不滚。

> **判据**：当你在写"补偿/回正/防抖"这类**抵消某个位移**的代码时，先问
> **"它为什么会位移"**。位移来自布局把两件不相干的东西放进了同一条流，
> 那就改布局；改对之后补偿代码是负债，不是资产。

**发现 43 —— 静默失效的两个新形态**（同轮实测）

都不报错、都只表现为"看起来没生效"：

- **CSS 变量引用未定义**：`var(--fg-dim)` 被引用四处，而这个名字**从来没定义
  过**。`var()` 引用未定义变量时该声明在计算值阶段作废，颜色回退成继承值。
  已加全量扫描锁（`used ⊆ defined`）。
- **两个开关只切了一个**：把审批区搬进新容器 `#action-dock` 后，渲染层仍只切
  内层 `.action-rail` 的 `hidden`——**外层坞始终盖着，整块「需你决定」永远不显示**。
  既有的所有测试都只断言节点**存在**（`querySelector('.deny-reason')` 照样命中），
  隐藏与否一律通过。

> **纪律**：UI 测试断言"节点存在"是不够的，**可见性要单独断言**；
> 而且新加一层容器 = 新加一处显隐接线，必须同时加锁。
> （验证方式照旧：把修复临时改回去，看新测试是否真的红。）

**发现 44 —— 把"控制器逻辑"搬进纯函数，覆盖面才长得出来**
（合并输入框，2026-08-08）

委托方问「追加指令和下方的输入框不能公用吗 为啥要分开」。分开纯粹是实现遗留：
一个打 `POST /api/runs`，一个打 `POST /api/runs/:id/messages`。合并本身不难，
难的是这两处的判据全都写在 `index.html` 的内联 `<script>` 里——而所有 UI 测试
的 `loadSkeleton()` 都**无条件剥掉 `<script>`**。也就是说"按钮该写什么、能不能
点、这一下会新建还是会追加"这几件事，此前一条覆盖都没有。

做法是把它们提成 `app.js` 的三个导出：`deriveComposerMode`（模式派生，纯）、
`composerSubmitPlan`（去向决策，纯）、`patchComposer`（DOM 应用，**零
addEventListener**）。内联脚本只剩"喂事实"和"发请求"。

> **一般化**：想给一段逻辑加测试却发现"它在一个测不到的地方"，
> 不要去测它的宿主——**把它搬出来**。搬家本身就是设计改进：
> 派生与应用一分开，"重复绑定监听"这类问题从可能变成结构上不可能。

顺带被这次拆分照出来的三个既有缺陷（都不报错）：

- **默认值被当成观测**：`createInitialState` 把 status 初始化成 `"running"`。
  拿它当"在跑"的证据，点开一条早已结束的运行会走 append→running→append 的抖动，
  中间还挂一句"运行进行中"的假话。**本地状态只能单向生效**（能把结论往"已结束"
  推，不能往"在跑"推）。
- **换标签回来对话白屏**：`patchTabContent` 重建时只清了 `sig.tabBody`，漏了
  `sig.chat`，于是 `patchLoopView` 看签名没变直接提前 return。
- **宽屏下"返回"是空操作**：`exitDetailMode` 整个函数体包在 `isNarrow()` 里。
  合并前只是"后退键没反应"，合并后直接变成骗人——地址栏说没选中运行，
  底栏却停在「继续对话」，而 F5 之后同一个 URL 又变成「运行任务」。

**发现 45 —— EventSource 分不清"正常收流"与"掉线"，得用 harness 事实去分**
（委托方截图，2026-08-08）

一个状态是**已完成**的运行，顶上挂着「连接中断，正在重连…」。根因不是竞态而是
必现：服务端推完 `run_end` 就 `res.end()`，浏览器收到 FIN 派发的是 `error`、
readyState 同样是 `CONNECTING`——**传输层看不出区别**；而 `run_end` 那条 message
还在批处理队列里（一帧之后才 flush），所以顺序被结构性地固定成「先 error 挂横幅、
后 flush 才 close」，前端永远抢不到前面。

修法是不在传输层里找答案：`shouldShowReconnecting({info, localStatus})` —— 服务端
列表或本地状态**任一**说这个 run 已经结束，就不是断线。（点开一条历史运行走的正是
这条：那时本地状态还是初始化默认的 `"running"`，只有服务端说得出真话。）

> **同族问题的判据**：当两个语义完全不同的事件在某一层长得一模一样时，
> 不要在那一层加时序 hack 去抢先后——**上一层去要事实**。

**发现 46 —— 复验一条验收，正确做法是变异测试而不是逐条打勾**
（AC2-18，2026-08-08）

"v1 的九条 + AC-01~10 在 v2 下有没有回退"这类复验，逐条去看"有没有对应的绿测试"
几乎必然签出一个假通过。改成对每条**可疑证据**做变异测试——**把它声称保护的东西
改坏，看有没有测试变红**——40 条里照出 4 处真缺陷、3 处假绿门禁：

| 变异 | 结果 |
|---|---|
| 把结果卡挪到下钻面之后（正是 R-03 要修的毛病） | 326 条测试**无一变红** |
| 把审批卡的 `operable` 闸改成恒 `true` | 同上，零变红（该闸在唯一调用路径上恒真） |
| 往样式表注入 `#fff` / `#ff0000cc` / 阴影里的裸色值 | 裸色值门禁**照样返回空** |

**四处真缺陷的共同形态是"断言在、绿着，但它保护的东西已经不在被测范围内"**：

- **AC-04 展开日志第一次点击是死点击**：宿主自己另写了一套 toggle，
  被测的 `toggleEntryCollapsed` **全仓零调用**——测试测的是产品不用的那份实现。
  这条是发现 44「把逻辑搬进纯函数」的反面教材：搬出来了却没接回去，等于没搬。
- **AC-07 对比度实际 4.23:1**：46 条断言的覆盖表里，`text-3` 只配了一种底色，
  而它实际落在另一种上。**覆盖表漏一行，门禁就只是看起来严。**
- **AC-05 两处焦点不可见**：一处被更具体的组件规则压掉（`:focus` 特指度赢
  `:focus-visible`），一处是可聚焦的 `.sr-only` 元素焦点环被 `clip` 裁没。
  单测断言"CSS 里有 `:focus-visible` 规则"是绿的，只有真机 Tab 一次才看得见。
- **裸色值门禁三个洞**：三位简写、八位 alpha、以及同一条声明里出现过 `var()`
  就整条跳过——而阴影与渐变正是硬编码色值最常见的落点。

> **纪律**：一条门禁上线时要**先证明它会红**（注入一个它该抓的东西），
> 而不是看它是绿的就放心。本轮新加的每一条锁都做了这一步。

**发现 47 —— 文档里写死的计数一定会过期，除非注明"这是哪一刻的快照"**
（§1.5，同日）

三份状态文档里三处写死的数字全错：「225 测试 / 16 文件」「485」「220」，
实际 641 / 21。产地是同一个——**逐轮追加的"测试规模"增量表**。它记的是
"某一轮加了哪些断言"，而那件事提交信息里本来就有；文档里的副本只会漂。

同族的第二种漂移：**证据引用了已经不存在的结构**（"三标签"、"10 个交互元素"、
`#0969da`、"追加输入框"）。这类不能删——那是当时确实验过的第一手记录，
删掉等于抹掉事实。做法是**就地标注它描述的是哪一代形态**，并把"当前结论"
统一指向一处。

> **两条**：①凡写死的计数，要么别写，要么写清"这是哪一刻的快照 + 当前值去哪儿取"；
> ②**同一件事不许在两张表里各记一遍**——本轮四视口零溢出被记了三遍且三遍都没有
> 自动化，屏幕阅读器被记了两遍。重复不是冗余保险，是三份会各自漂的记录。

---

## 7.6 核查失败的归因顺序（案例 #8 的核心产出）

**发现 37 —— 核查失败要分三层归因，顺序不能颠倒**

案例 #8 用同一份产物（ELF SHA256 四跑逐字节相同）做了四跑 A/B/C/D，
每次只加一个变量：

| | ① 15 轮 | ② 30 轮 | ③ +只读纪律分形态 | ④ +收口续跑 |
|---|---|---|---|---|
| `reset_target` 调用 | — | **0** | **2** | **2** |
| round 0 | ✗ 无裁决 | ✓ 但**误判** | ✗ 空输出 | **✓ 19 轮自行收口** |
| round 1 | ✗ 无裁决 | — | ✓ 正确 | ✓ 31 轮 = 30 调查 + 1 收口 |

> **① 核查者被成文规则挡住**（改规则）→ **② 预算不够跑完**（加预算）→
> **③ 缺取证手段**（补白名单）。**先怀疑规则，再怀疑预算，最后才怀疑能力。**

案例 #8 若只做②，得到的是**一次跑得更久的错误裁决**——②做完仍然是错的，
直到①被修掉。这条顺序是这一整轮最贵的教训。

**发现 38 —— "只读核查"在硬件域的边界：必须含"把系统带到可观测状态"**

`stm32-debug` 的核查指令原文写着「不要 flash、不要 reset、不要写内存」一刀切。
verifier 于是 68 次工具调用里**一次都没复位**，读到上一段会话遗留的未初始化
SRAM（`magic=0x4E0A43C0`、`PC=0x2000002E` 在 SRAM 内），据此判执行者失败——
**而板子上的固件一直是好的**。

它甚至在 advisory 里推断对了"可能是板子未处于正常运行态、固件本身可能是正确的"，
**只是被这条成文禁令挡住，没去做那个能证实推断的动作**。

而这条禁令**只对一种核查形态成立**：故障现场核查里复位会毁掉 `.noinit` 闩锁 /
CFSR / 异常栈帧（案例 #1/#3 的血泪）。运行行为核查恰好相反。

> 软件域的只读核查天然完整——文件就在那里。**硬件域的"只读"若不含"把系统带到
> 可观测状态"，核查就是空的。** 正解不是放宽纪律，是把两种形态分开写清楚，
> 并给出"怎么认出系统没在跑"的判据（幻数不对 / PC 不在正常代码 / 字段像随机数）。

**发现 39 —— 预算用尽 ≠ 核查失败：整场取证不该被一次没收口作废**

撞满预算时最终消息往往是半截工具调用、文本为空。原有的"重问"**另起新 loop 只喂
原始文本**，文本为空时直接跳过——整场核查连同已取到的全部证据一起作废。
案例 #8 四跑里这个形态出现了四次，其中一次 verifier 已经嗅到真缺陷并在追查。

正解是**续跑同一会话**（`runContinuation` 带上正史），要求"别查了，用已有证据
下结论"，并明写「没查完的进 `unverified`、**不得因没查完判 failed**」——
否则预算用尽会直接退化成 fail-closed 第三种误伤形态。

**同构的问题在执行者一侧也成立**：执行者第 29 轮 API 超时 → `stopReason=error`
→ 整段作废，而它已做 28 次工具调用、正朝着真缺陷去。一次端点抖动扔掉全部进展。
两者都靠同一条通路（`runContinuation`）救回。

**发现 40 —— fail-closed 兜底裁决必须带过程摘要**

`{passed:false, issues:["…无法解析…"]}` 对返工者是零信息量——它分不清
"核查者胡言乱语"和"核查者做了大量取证但没来得及收口"。案例 #8 是后者，
而返工者拿到的信号与前者完全相同，只能从头再来，又烧光一整轮预算。
**零工具调用与"查了 40 次没收口"是两种完全不同的故障，返工策略也不同。**

**发现 41 —— 芯片系列相关的常量是 agent 的稳定盲区，真机是唯一裁判**

案例 #8 的交付物：链接符号、镜像长度、外设时序、按 32 位字喂入、执行时机全对，
**唯一缺陷是 `1u << 6`（STM32F1 的 CRCEN 位号）用在了 STM32L1 上**（L1 是 bit 12）。
L1 上 bit 6 未实现，写入被硬件丢弃（`RCC_AHBENR` 读回 `0x00008000` 可证），
CRC 外设始终无时钟 → `CRC->DR` 恒读 0。

编译器不管、静态检查不管、单测不管——**只有真机能**。而这恰恰是发现 4 说的
verifier 主场（能力边界附近的语义错误）：修好归因顺序（发现 37）之后，
verifier 独立读到了与委托方完全相同的寄存器证据。

> **不要为此加一层"猜芯片型号"的静态检查**——正解是让核查跑得完。

---

## 8. 开放问题

### 8.1 rubric-verifier：主观验收的困境

当前 verifier 对**硬事实**（数值、文件存在性、字节级一致性）有效，但对**主观质量判定**无能为力。

**发现 25 —— letter-vs-spirit 宽纵**（`docs/cases/case-01-telemetry-firmware.md`）：验收标准"boot_count 复位后 +1"，实测 +510，verifier 判 passed 仅标注"轻微报告不严谨"——执行者身上的 rule-precedence 纪律在核查者裁决端复现。改进方向：把 rule-precedence 写进 verifier 系统提示（详见第 4 节发现 8），但未触及主观判定的不可程序化问题。

**发现 26 —— 核查饥饿**（`docs/cases/case-04-probe-lock-python.md`）：通用配置下 verifier 无核查白名单 → 无实质结论 → fail-closed 误判 → 22 轮返工纯重证已为真的东西。这是 fail-closed 的第三种误伤形态（详见第 4 节发现 6–7）。

**发现 27 —— 裁决 summary/issues 是信号源，宿主不应只看 passed 布尔值**（`docs/cases/case-01-telemetry-firmware.md`）：verifier 的备注比裁决更早暴露了固件缺陷（详见第 4 节发现 9）。

**核心矛盾**：rubric 把主观判断降维为可程序化条款——近似误差在边界案例上表现为 letter-vs-spirit 摇摆。case-05 的解决方案（结构契约 + 官方 demo 范本）提供了一个思路：**用参考物代替文字规则**，但这是领域相关的，通用 rubric-verifier 问题仍未解决。

### 8.2 规模轴：区分度的前沿与局限

**发现 28 —— rule-precedence 纪律关闭了最后一条区分轴**（`eval/ab-report-scale.md`）：flash 级模型 + 真 bash + rule-precedence 后，语义陷阱、字节纪律、letter-vs-spirit 全部饱和——唯一存活的区分轴是"轮次预算 × 规模张力"（t15 下 67–83%）。

**发现 29 —— 预算张力又被纪律顺带解除**（`eval/ab-report-budget.md`）：budget-30 臂对比 baseline（t15）成功率持平——当年烧穿预算的 run 大量轮次花在规则歧义 churn 上。纪律条款采纳后 t15 不再紧张。"预算 × 规模张力"的相当一部分其实是规则歧义 churn 的转嫁。

**发现 30 —— xhard 套件揭示 letter-vs-spirit 二次独立复现**（`eval/ab-report-xhard.md`）：xhard-export-chain 1/2 失败——执行者把 `} from "./types.js"`（行首非 import）语义化地算了进去。与 hard-import-list 的 stdio.js 陷阱是同一失败模式的第二次独立出现。这个发现直接催生了 rule-precedence 纪律条款，该条款又反过来关闭了规模轴上的预算张力——典型的飞轮正反馈（详见第 2 节定律二、第 7 节飞轮）。

**局限**：当前规模用例（60 模块/文件）仍在中型项目范畴。规模轴的下一站是**窗口容量 × 任务广度**，而非轮次 × 规模。

### 8.3 server-side compaction：上下文窗口压缩

**发现 31 —— 本地截断是不可逆的信息丢失**：截断后的 tool_result 原文永不可恢复——模型需要被截断细节时只能重做工具调用。`eval/ab-report-budget.md` 中 planned 臂 token 爆炸（单 run 最高 1018k）部分源于子任务各自维护完整上下文的冗余。

**发现 32 —— 对跨领域长管线的压缩需求尚未被触发**：当前案例（#1–#5）单次任务上下文均未逼近模型窗口上限。`eval/ab-report-budget.md` 的结论——预算张力被 rule-precedence 纪律顺带解除——说明窗口压力在当前规模上不构成瓶颈（详见本节的发现 29）。

**发现 33 —— server-side compaction 的路线图位置**：`docs/04-roadmap.md` 将其列在"更远"节——替换本地截断，让 API 侧在保留完整语义的前提下压缩上下文。需要 Anthropic 服务端 compaction beta 能力就绪。

### 8.4 多 agent 演进方向

`docs/04-roadmap.md` 和五个案例的实践经验共同勾勒了多 agent 的演进路径——从现有机制的张力中自然生长出来的方向。

**当前事实基础**：v1.0 三角编排已是 proto-多-agent（planner/executor/verifier 三角，角色分离 + 独立上下文 + 独立模型可配）。v1.1 并行编排 = 同构多 executor，案例 #2、#3 证明了墙钟收益（−43%、−34%）。

**四条线索**：

1. **异构 agent 角色**：案例 #3 暴露跨进程探针锁缺失 → 暗示需要**资源管理 agent**；案例 #5 的 MCP 侦察 → 暗示需要**能力探测 agent**（`docs/cases/case-03-dual-probe-parallel.md`、`docs/cases/case-05-kicad-swd-adapter.md`）。

2. **结构化清单契约扩 deps 字段**：当前只表达 fan-out+join 和单体，顺序链仍归 freeform——路线图明确"统一需清单契约扩 deps 字段"（`docs/04-roadmap.md`）。

3. **跨域真机任务上的并行编排**：路线图将此项列为"更远"候选。需要**领域包隔离**（各子任务加载不同 DomainPack）和**跨域交接格式**（结构化数据而非文本摘要）。

4. **router 调度单元的自动化**：多 agent 演进的下一里程碑是**让 planner 不仅拆解子任务，还为每个子任务选择合适的 agent profile**（模型 + 领域包 + 预算 + 工具面组合）。案例 #4 的 A/B 证明领域包对 agent 表现的提升是量级差异——**为子任务分配合适的 profile 可能比分配更强的模型更重要**。

---

## 引用源文件清单

本文引用的全部原始报告与案例文档（按字母序）：

**A/B 报告（25 个）**：`eval/ab-report.md`、`eval/ab-report-flash.md`、`eval/ab-report-qwen.md`、`eval/ab-report-strong.md`、`eval/ab-report-hard.md`、`eval/ab-report-hint.md`、`eval/ab-report-diagnose.md`、`eval/ab-report-bash.md`、`eval/ab-report-budget.md`、`eval/ab-report-kimi.md`、`eval/ab-report-mut.md`、`eval/ab-report-scale.md`、`eval/ab-report-xhard.md`、`eval/ab-report-rulefirst.md`、`eval/ab-report-rulefirst-side.md`、`eval/ab-report-rework.md`、`eval/ab-report-rep5-rework.md`、`eval/ab-report-rep5-rework-clean.md`、`eval/ab-report-rep5-verifier.md`、`eval/ab-report-parallel.md`、`eval/ab-report-parallel-smoke.md`、`eval/ab-report-parallel-rep5.md`、`eval/ab-report-parallel-curve.md`、`eval/ab-report-parallel-strongplanner.md`、`eval/ab-report-parallel-struct.md`

**评估基线/先导（3 个）**：`eval/baseline-report.md`、`eval/pilot-hw-verify.md`、`eval/plan-verify-2.md`

**案例文档（6 个）**：`docs/cases/case-01-telemetry-firmware.md`、`docs/cases/case-02-parallel-reference-docs.md`、`docs/cases/case-03-dual-probe-parallel.md`、`docs/cases/case-03-dual-verify.md`、`docs/cases/case-04-probe-lock-python.md`、`docs/cases/case-05-kicad-swd-adapter.md`

**架构/路线图（3 个）**：`docs/02-architecture.md`、`docs/03-interfaces.md`、`docs/04-roadmap.md`
