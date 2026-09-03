# A1 — 工具面地板测量（`edit_file` / `glob` / `grep`）

> **本文件的第 1 节（判据）在跑任何一次实验之前写下并提交**（commit 1，见 git 历史）。
> 后续小节由实测数字填充。判据不得事后修改——若发现判据本身写错，改判据要单独说明并保留原文。

## 1. 先写的判据（pre-registered，2026-09-03）

被测变化：执行者的内置工具面从 `bash / read_file / write_file`（3 件）扩到
`bash / read_file / write_file / edit_file / glob / grep`（6 件）。**唯一变量是工具面**——
system prompt、模型、轮次上限、用例、判分器全部不动。

动机（不是猜的）：台账工具直方图里执行者调用过**不存在的工具**——`edit_file` ×1、
`replace_in_file` ×3。模型自发想要的工具是真需求最诚实的信号（与 `read_file` 的
`offset/limit` 同一条判据，见 read-file.ts 注释）。

### 判据 a（不回归，硬门）

对照 `eval/baselines/heldout-v1.3.0.json`（25 用例 × 3 rep = 75 run，75/75 全过，
Wilson95 下界 0.9513）：

- **a1（矩阵级）**：新配置的合计通过率 ≥ **0.9513**（旧基线的 Wilson95 下界）。
  低于此值 = 回归，必须逐 transcript 定因。
- **a2（用例级）**：**没有任何一条**用例从 3/3 掉到 ≤1/3。单条掉到 2/3 记为"待复现"
  （REPS=2 一律视为待复现，本仓纪律），不单独判死，但必须在 taxonomy 里写清失败形态。
- **a3（不许换判据）**：判分器、用例、`maxTurns=15`、`AB_ARMS=baseline` 与基线完全一致；
  出现回归**只允许修 harness 缺陷，不允许调提示词**。

### 判据 b（有效性，软门）

edit-heavy 用例上 tokens / turns 应当下降。本套件里"需要改动已存在文件"的用例
（下称 edit-heavy 子集，在跑之前按用例文本圈定并在 §3 列出）：

- **b1**：edit-heavy 子集的 Σtokens 相对基线**下降**（任意幅度即算方向正确）。
- **b2**：edit-heavy 子集的 Σturns 不上升。
- b1/b2 不达成**不判失败**——它是效果测量，不是门禁；不达成时要给出解释
  （如"该子集本就不需要局部编辑"），不得把它说成成功。

### 判据 c（工具面缺口关闭，硬门）

- **c1**：本轮全部 run 的 transcript 里，对**不存在工具**的调用次数 = **0**
  （基线时代的 `edit_file` / `replace_in_file` 幻觉必须消失）。
- **c2**：`edit_file` 至少被真实调用 1 次并成功（否则本次测量对 `edit_file` 无话可说，
  结论只能覆盖 `glob`/`grep`）。

### 判据 d（不许悄悄变贵）

- **d1**：矩阵合计 tokens ≤ 基线合计的 **1.5×**（基线 651,543 → 上限 977,315）。
  工具面变大本身会让每轮请求略贵（tools 块变长），这条是防止"为省几轮烧更多 token"。

### 记录纪律

- 全部 25 用例 × 3 rep，`AB_SUITE=heldout` / `AB_ARMS=baseline` / 执行者 `deepseek-v4-flash` /
  `AB_TOKEN_CAP=6000000`，独立 worktree、`npm ci`、`.env` 从主检出复制、
  进程内继承的 `ANTHROPIC_* / OPENAI_* / AGENT_*` 全部清空后启动。
- 基线 JSON **不改**——它钉的是 v1.3.0 tag 的数字。
- 墙钟为同机不同时段读数，只作方向参考，不进判据。

## 2. 实测结果

_（跑完填充）_

## 3. edit-heavy 子集与逐用例对照

_（跑完填充）_

## 4. 失败 taxonomy

_（跑完填充）_

## 5. 判据裁决

_（跑完填充）_
