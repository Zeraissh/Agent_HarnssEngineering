# 真实任务案例 #5 — KiCad SWD 转接板 × 首个 EDA 领域（2026-08-05）

**任务**：设计一块可打样的 SWD 调试转接板（ARM 标准 10-pin 1.27mm 座 → 面包板友好
2.54mm 单排 6-pin），原理图 + PCB + 制造输出全套。harness 首次进入 EDA 领域；
执行者/核查者均 deepseek-v4-pro。交付物在 `D:\Work\scratch\kicad-swd-adapter-20260805`
（HANDOFF-SWD-ADAPTER.md + gerbers/ 可直接送厂，处置归用户）。

## 路线抉择：MCP 侦察判死 → 文件生成路线

原计划走华秋 KiCad 构建自带的 kicad-mcp（IPC/pynng）。系统性侦察后判死：

- **落盘矩阵实验**（逐 api 直连验证文档变化）：`drawMultiWire` ✔ 落盘；
  `placeSymbol`/`placeGlobalLabel`/`createPcbPad`/`drawPcbTrack`/`placePcbVia`
  全部"status ok"但**文档不变**；`getSymbolLibrary`/`queryLayerNames` 返回
  不可能的空值（开着的板层列表为空 = 管线未绑定文档）。
- **三嫌疑全部证伪**：①用户登录华秋 copilot（access_token 4→371 字节）后重测无变化；
  ②DLL 字符串表含全部 api 名（版本配套）；③窗口激活重测无变化 + 用户肉眼确认
  画布无挂起物。根因埋在闭源 C++ 侧,不可达。
- 顺带发现并让用户修复了其 `~/.claude.json` 里坏的 kicad 注册
  （`["-","m","kicad_mcp_server"]`——`-m` 被拆 + 模块名错）。

转向:KiCad 文档本身是 s-expression 文本,kicad-cli 提供 headless ERC/DRC——
**直写文件 + 程序化判官恰是自主 agent 的主场**。路线由用户在岔路口拍板（先试登录,
证伪后转文件路线）。

## 交付与验证（全绿）

| 阶段 | 结果 | 轮数 |
|---|---|---|
| 原理图（3 发） | 全严重度 ERC 0 违例;六网拓扑逐引脚精确;嵌入符号与官方库逐点一致 | 36（末发） |
| PCB（1 发） | DRC+schematic-parity **三个零**;15 段双面走线;全套 Gerber+钻孔 | 会话中断吞签字 |
| 补签核查 | verifier 亲跑双判官+重导 Gerber 对比+封装逐字节比对,passed=true | 7 |

原理图三发的失败形态各有名姓:发 1 = API 瞬断(error 类失败,核查不运行——旧定论
再证);发 2 = **双拒签暴露真实能力缺口**——执行者不知道 KiCad 7+ 格式的两条硬结构
(`lib_symbols` 嵌入段、符号实例的 `(instances ...)` 注释段,缺后者=网表导出为空),
返工还把 lib_symbols 弄丢(越改越坏);发 3 = 任务书补【结构契约】+ 指向官方 demo
`ecc83-pp.kicad_sch` 当结构范本,一发即中。

## 结构性发现

1. **"回执 ok ≠ 生效"——文档态才是真值**。MCP 工具的 status:ok 只是收单回执;
   接入未知 MCP 前,逐 api 的落盘矩阵实验应成为前置仪器(本案的侦察方法论沉淀)。
   这是"工具运行时质量是地板"的 MCP 变体:名字与回执的暗示力 > 实际行为。
2. **领域文件格式的深层结构 = 能力缺口的新形态,官方范本是对症药**。结构契约
   (精确形状+根 uuid)+ demo 文件当范本(文件形态的 few-shot)一杆命中——归入
   "修环境 > 提示词"家族:能力缺口靠喂参考,不靠让模型悟。
3. **kicad 包的核查白名单首战即防住核查饥饿**(case-04 教训的直接兑现):三轮核查
   verifier 全部第一手取证——亲数 ERC/DRC 违例、亲验网表拓扑、亲比封装几何,
   两次拒签全部实质有据,零空转返工。
4. **read_file 额外只读根**(AGENT_READ_ROOTS,c0060bb):v0.8 起挂账的旧债由
   真需求(读官方库嵌入)驱动清偿——债务清单的正确清法是等需求到期,不是预支。

## 环境保障与残留

无硬件参与;华秋 KiCad/eeschema/pcbnew 试验进程用毕即关,scratch 试验区
(kicad-swd-20260805)与正式交付区分离;交付区已清至规范清单(设计文件+judge
报告+HANDOFF+gerbers+渲染图)。kicad MCP 判死结论与完整侦察档案存于交接记忆,
后续华秋构建更新可凭档案快速复测。
