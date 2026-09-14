# 透明控制派（Cline / OpenCode / Aider / Goose）· 走查卡

- **角色：** 透明和控制是家。自己的 Key（BYOK）是家。Plan / Act 要自己拨。用量数字要摊开。git diff 是真相。
- **表面：** CLI 先，再 Web http://127.0.0.1:4173/（自己的标签页，不跟别人抢）
- **日期：** 2026-09-14
- **活 UI：** 否。本机 `http://127.0.0.1:4173/` 当时在听（`/health` 200，`FATHOM 控制台`），我多次新建浏览器标签，标签立刻丢（`Browser view not found` / `No browser tab available`），没点到页面。Web 字来自当时这份活页的 HTML，以及它加载的 `settings.js` / `usage.js` / `onboarding.js` 和 `/api/usage`、`/api/models`（点「打开设置 / 消耗 / 管理模型」会落到这些字）。CLI 是亲手跑的。
- **习惯伸手：** 先找 Key / 供应商 / 用量 → 找 Plan/Act / 只读 → `--help` 或 `/` → 第一句话前确认「现在会不会直接改文件」。

---

## 0. CLI 冷启动（先于 Web）

仓库根执行 `npm run agent -- --help`，原文：

```
Agent_Design CLI

Usage:
  npm run agent -- run [options] "task description"
  npm run agent -- doctor
  npm run agent -- --help | --version

Compatibility:
  npm run cli -- [options] "task description"

Run options:
  --yes          自动批准工具请求（仅用于明确接受风险的无人值守运行）
  --verify       独立核查，未通过时有界返工
  --plan         planner 拆解、执行并核查子任务
  --parallel N   plan 并行度；也接受 --parallel=N，省略 N 表示 auto
  --auto         自动选择单领域 pack
  --ask          允许 agent 在执行前集中提问（与 --yes 互斥）
  --resume-run ID  同 run 续跑（单执行者=检查点；--plan=半截 DAG；预算耗尽则拒）
  --             后续内容一律视为任务文本

Doctor is static: it performs no network request and starts no execution worker.
```

`npm run agent -- --version` → `1.3.0`

空跑 `npm run agent`（不带任务）退出码 1：

```
Usage: npm run agent -- run [options] "task description"（旧入口 npm run cli -- 仍兼容）
```

我下意识又打了 `npm run agent -- run --help`（Aider / Cline 用户会这样问「run 子命令还有什么开关」），红字：

```
run 不能与 --help 同时使用
使用 --help 查看用法。
```

`npm run doctor`（无密钥，只看有没有凭据）：

```
provider: anthropic (source: default)
model: deepseek-v4-flash (source: .env-or-environment-same-value)
base_url_origin: https://api.deepseek.com (source: .env-or-environment-same-value)
credential_present: yes (source: .env-or-environment-same-value)
```

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | `--help` 没有 `--model`、没有 `--api-key` / `--provider`、没有 Plan / Act / 只读档位。有 `--yes`（自动批准）、`--plan`（planner 拆解）、`--verify`、`--ask`。 | Cline / OpenCode：冷启动就能拨 Plan↔Act，或 Aider 的 `--model` / 自己贴 Key。第一眼确认「现在会不会改文件」。 |
| **不习惯** | `run --help` 被拒，只能看总帮助。 | 子命令自己的帮助，把模式和模型参数摊开。 |
| **好** | `doctor` 把 provider / model / base_url_origin / credential_present 摊开，并且说自己不做网络、不开工。 | 透明派要先看见「用哪家、有没有 Key」，这一点对上了。 |
| **不实用** | `doctor` 只有「有没有凭据」，没有本次/今日用量数字，也没有「贴自己的 Key 怎么贴」。provider 写 `anthropic (source: default)`，模型却是 deepseek——家和线对不上，但没有解释。 | 用量数字和 BYOK 入口写在 `--help` 或 doctor 里。 |
| **不习惯** | `--plan` 的帮助原文是「planner 拆解、执行并核查子任务」，不是「先出计划、不写盘」。`--yes` 是自动批准，不是 Act。没有只读 / dry-run。 | Plan = 只规划不改文件；Act = 才写盘。两个词在这里被占用了，意思反了。 |
| **不习惯** | `npm run agent -- run --model` 退出码 2：`未知参数: --model` / `使用 --help 查看用法。` | Aider / Cline 第一下就会带 `--model`。帮助里也没写这条开关存在。 |

---

## 2. CLI · 一句话小事

先不加 `--yes`（我要确认它会不会直接改文件）：

```
npm run agent -- run "在当前工作目录写一个 hello-transparent.txt，内容只有一行：ping。不要读别的文件，不要跑命令。"
```

启动横幅原文（节选）：

```
compat mode [anthropic]: model=deepseek-v4-flash via https://api.deepseek.com/anthropic …
mcp: connected "stm32" (20 tools)
mcp: skipped "github" (missing GITHUB_PERSONAL_ACCESS_TOKEN)
execution: report-only / host (mode=report, probe=unavailable) — shell commands are not run-isolated
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
─── turn 1 ───
  tokens: in=237 cacheW=0 cacheR=10368 out=276
→ tool write_file {"path":"hello-transparent.txt","content":"ping\n"}
Error [ERR_USE_AFTER_CLOSE]: readline was closed
```

工具调用原文摊开了，然后审批问句还没出来就崩了（这个壳不是交互 TTY）。文件没写成。

再带 `--yes` 重跑同一句，写成了。磁盘 `hello-transparent.txt` 只有一行 `ping`。过程原文：

```
→ tool write_file {"path":"hello-transparent.txt","content":"ping\n"}
⚠ auto-approved: approve write_file {"path":"hello-transparent.txt","content":"ping\n"}
✓ 7ms Wrote 5 bytes to hello-transparent.txt
─── turn 2 ───
→ tool read_file {"path":"hello-transparent.txt"}
✓ 2ms ping
─── turn 3 ───
→ tool finish_task {…}
■ completed (3 turns)
  total: in=578 cacheW=0 cacheR=32000 out=589 | cacheHit=98.2%
```

同一趟横幅仍写着 `permissionMode: … yes=false`，但下一行已经 `auto-approved`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 每轮有 `tokens: in=… cacheW=… cacheR=… out=…`，收工有 `total: … cacheHit=98.2%`。 | 用量数字摊开。Cline / OpenCode 要看见花了多少，这里 CLI 给了。 |
| **好** | `→ tool write_file {json}` 原文展开，还有耗时和回写字节数。 | 工具调用能展开，出错能看到命令/结果，不是「遇到了一点问题」。 |
| **好** | 启动就打印 model / 端点 / MCP 连了谁、github 缺 token 被跳过。 | 第一眼确认供应商和会不会改文件。 |
| **不习惯** | 默认不是 Plan。不加 `--yes` 时本该停在批准，但在这个非交互壳里直接 `readline was closed`，退出码 1，文件没写。 | Aider / Goose：没 TTY 会说「要批准请加 --yes」，而不是把 readline 摔了。 |
| **不习惯** | 我写了 `--yes`，横幅仍是 `yes=false` / 「不会自动放行」，同时 `⚠ auto-approved`。 | 模式灯和实际行为一致。 |
| **不实用** | `execution: report-only / host (mode=report, probe=unavailable)` 我读不懂现在是只读报告还是真写盘。下一秒它真写了文件。 | 一句话告诉我：现在是 Plan 还是 Act。 |
| **不习惯** | 没有 `--model`。模型锁在横幅的 deepseek-v4-flash，换模型只能去 `.env`。 | 命令行就能换模型、贴 Key。 |

---

## 3. CLI · 要批准的事

不加 `--yes` 的那次，批准卡片没画出来就死了（见上）。`--yes` 的帮助原文是「自动批准工具请求（仅用于明确接受风险的无人值守运行）」——这是 Act 全开，不是「先问再写」。

横幅里的档位词：`approval=ask plan=false gate=false`。`--help` 没有开关能把这次运行拨成「只 Plan 不写盘」。`--plan` 写的是「planner 拆解、执行并核查子任务」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 想看批准卡片，得到的是 `readline was closed` 栈。 | 终端里出现 y/n，命令和路径写清楚，回车才写盘。 |
| **不实用** | `--yes` 是唯一能跑完的批准开关，而且一开就全放行。 | Plan / Act 两档，默认可先 Plan。 |

`npm run agent -- run --api-key dummy` → `未知参数: --api-key`（退出码 2）。`npm run agent -- run --act` → `未知参数: --act`。

---

## 4. CLI · 稍长一点（我当它是 Plan）

我把 `--plan` 当成 Cline 的 Plan 档，跑：

```
npm run agent -- run --plan --yes "只列出当前目录里名字以 hello-transparent 开头的文件，不要写文件，不要跑命令。"
```

它先印 `━━━ 计划单元（planner，只读拆解）━━━`，展开 `→ tool glob`、`→ tool submit_plan {json}`，再印 `═══ 计划 ═══` / `s1 列出当前目录 hello-transparent* 文件`，然后**立刻**进入 `━━━ 子任务 s1 ━━━` 执行，再自动开 `verifier 独立复核`，最后 `三角编排结果 / ✔ 全部子任务执行并核查通过`。横幅仍写 `plan=false gate=false yes=false`。全程约 26.9s。没有问我改计划、也没有单独的 Act 拨杆。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | planner / 子任务 / verifier 的工具调用都是原文 `→ tool … {json}`，还有 tokens 和小计。 | 过程能展开，不是转圈十分钟 Done。 |
| **不习惯** | `--plan` 不是「只规划不写盘」。它拆完就执行、还自动核查。帮助原文已经这么写，但我的手仍伸向 Plan/Act。 | `--plan` 停在计划等人改；`--act` 才干活。 |
| **不实用** | 列一个文件名走了 planner + 执行 + verifier + 三角编排。对这句小事是仪式。 | 这种活直接 Act，Plan 是我自己拨的。 |

---

## 5. CLI · 过程中途：停、找上次、续

第一次想停：`--yes` 写 40 句解释 ping。文本当场流出来（每句 `TRANSPARENT …`），18s 自己 `■ completed`，没来得及停。`--help` 没有 `--stop` / `/stop`。

第二次：`--yes` 写 120 句（`TRANSPARENT2`）。印到 `─── turn 1 ─── / ▷ 模型请求 #0` 时我把 `src/cli.ts run` 那棵进程杀掉。终端只剩半截横幅，退出码 1，**没有**「已停止 / 用户中断」一行。横幅留过：

```
durable: cli-1789387852776 → .agent-run-history/cli-1789387852776/state.json
```

按 `--help` 的 `--resume-run ID` 续：

```
npm run agent -- run --resume-run cli-1789387852776 --yes "停在半路了。不要再写 120 句。用一句话说明上次停在哪，不要写文件，不要调工具。"
```

原文：

```
durable resume: cli-1789387852776 → .agent-run-history/cli-1789387852776/state.json
⚠ 没有已提交的 main 检查点（飞行中崩溃不能热续） 将从任务正文重开一轮，不会接着飞行中的工具，也不假装有检查点。
```

模型回的是「最近活跃线是 AD7793 热电偶前端」，跟刚才被杀掉的 120 句 ICMP **无关**。`state.json` 里 `checkpoint: null`，`phase: executing`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 流式文本当场出，停之前能看见它在写。横幅把 run id 和 state 路径写出来。续跑时诚实说「飞行中崩溃不能热续」「不假装有检查点」。 | 中途能看见，断了不说谎。 |
| **不习惯** | 停 = 杀进程。没有斜杠命令，没有「停止」按钮。杀完没有一句人话收尾。 | Cline / OpenCode：Esc 或 `/stop`，状态写成 stopped，还能接着那段。 |
| **不实用** | `--resume-run` 找到了档案，但重开后模型讲的是另一条线（AD7793），不是我杀掉的那次。 | 续 = 回到同一条线程，用量和工具记录还在。 |

---

## 6. CLI · 换地方

`npm run agent -- run --workdir D:\tmp` → `未知参数: --workdir`（退出码 2）。`--help` 也没有工作目录开关。当前目录就是仓库根，所以 `hello-transparent.txt` 写在了仓库顶层。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 换目录只能自己 `cd`，命令行不认 `--workdir`。 | Aider 在仓库根开干；Goose/OpenCode 能指工作区。至少 help 写一句「在当前目录跑」。 |

---

## 7. Web 冷启动（没点到活页，字来自当时的活页源）

`GET http://127.0.0.1:4173/` → 200，`<title>FATHOM 控制台</title>`。底栏按钮读屏名：`打开指挥中心` / `打开产物` / `打开定时任务` / `记忆` / `打开设置`。输入栏：`任务描述`、`未入项（按目录）`、`选择目录`、`独立核查`、`运行任务`。角色胶囊：`规划 ·` / `核查 ·`。模型一侧有 `环境变量`、`管理模型…`。新手引导脚本里的四页：`先圈定工作目录` / `用一句话写下目标` / `运行设置按次装配` / `对话按项目分组`。

点开「运行设置」会看到的旋钮名（首页 HTML 原文）：

- `领域包`（`不用领域包`）
- `自动匹配`
- `权限`：`手动 · 危险动作会先问你，不会自动放行`；选项 `自定义` / `逐次审批` / `计划确认门` / `自动放行 ask`
- `计划`：`拆解后等人批准`
- `多 agent`
- `自动放行`：`工具调用不再逐次问`——复选框在 HTML 里是 **`checked`**
- `思考强度` / `评分表`

同一栏 `title`：「只改审批节奏。圈禁、硬拒与密钥门不受档位影响。」另有「上下文用量」环、`追加预算继续本对话` / `当场给谱系加一段 token 跑道，不必改环境变量或重启宿主`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 第一眼是 FATHOM / 任务描述 / 领域包 / 核查，没有 Plan/Act 拨杆，没有贴 Key 的框。 | 打开就看见模式（Plan/Act）和 Key/用量。 |
| **不习惯** | 权限文案说「不会自动放行」，`自动放行` 勾是勾上的。 | 默认先问；Act 是我自己开的。 |
| **不实用** | 「计划」= planner 拆解等人批，不是只读 Plan。 | 这两个词别占用。 |

---

## 8. Web · BYOK / 用量 / 模型（设置页脚本上的字）

底栏 `打开设置`。设置分组名：`外观 / 模型 / 领域包 / 运行默认值 / 通知 / 快捷键 / 消耗 / 关于`。

**模型（BYOK 在这里，不在首页）：**

- `添加模型`
- 字段名原文：`Provider`、`模型名`、`API Key`（password）、`Base URL`
- Provider 选项文案：`OpenAI 兼容（DeepSeek / Kimi / 本地网关）`
- 列表徽章：`已存 Key` / `环境变量 Key`
- `留空 = 使用环境变量`；`已保存（输入以替换；清空并保存 = 改用环境变量）`
- `测试连接` → 成功句：`连接成功——端点、Key 与模型名都可用`
- `同步到 .env`：`把当前角色模型名写回 .env，下次冷启动仍可用；不写 API key，当前进程不会因此换模型`
- 来源：`当前来源：模型库文件（.agent-models.json）` / `当前来源：环境变量（首次保存后转为模型库文件）`

当时 `/api/models`：`环境变量 · deepseek-v4-flash` 的 `hasApiKey: false`（走环境变量）；另有 `kimi-k3` / `kimi-k2.6` 等 `hasApiKey: true`。没把任何密钥写进本卡。

**消耗（用量数字在这里）：**

- 说明原文：`本机台账里的运行轮次与已计价成本。台账不记 token 原文，图上按模型堆叠的是轮次。`
- `每日轮次` / `按模型堆叠，近 7 天` / `未计价`
- 当时 `GET /api/usage`：`totalRuns` 67，`totalUsd` ≈ 0.656，今日 `usd` ≈ 0.160，模型全是 `deepseek-v4-flash`，`unpricedRuns` 20

**运行默认值：** `自动放行工具` — `新对话默认自动放行低风险工具；写入仍受工作目录边界约束。` 以及 `独立核查`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 设置里真能加自己的模型：Provider / Base URL / API Key / 测试连接 / 已存 Key。不是锁死一家。 | BYOK。Cline / OpenCode / Goose 要这个。 |
| **好** | 「消耗」有轮次和美元成本，还区分未计价。CLI 每轮 token 也摊开。 | 用量数字看得见。 |
| **不习惯** | Key 不在首页，要先找到齿轮 → 模型。CLI 完全没有 `--api-key`。`同步到 .env` 明确「不写 API key」。 | 冷启动就贴 Key；命令行也能带。 |
| **不习惯** | 消耗图堆的是**轮次**不是 token；CLI 报 token 不报美元。两套账。 | 同一个数字，CLI 和 Web 对得上。 |
| **不实用** | doctor 的 provider=anthropic、模型=deepseek，和设置里「OpenAI 兼容（DeepSeek / Kimi / 本地网关）」要自己脑内翻译。 | 家和线写在同一行。 |

---

## 9. Web · Plan/Act 和可见工具调用

我没能在活页里发出任务，所以**没看见** Web 对话里一条展开的工具卡片。首页运行设置把「工具调用不再逐次问」写成自动放行的说明，等于默认 Act。没有名为 Act 的开关，也没有只读 Plan。

CLI 侧工具调用是原文展开的（第 2、4 步），这一条对透明派是够用的——但那是终端，不是这个控制台。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | Web 没有 Plan/Act 拨杆。最接近的是「计划」勾和「权限 / 计划确认门」。 | 输入框旁边一个 Plan | Act。 |
| **不实用** | 默认 `自动放行` checked + 设置「新对话默认自动放行低风险工具」。控制权收进一键自动。 | 默认先问；自动是我开的。 |
| **（Web 工具展开：未见）** | 浏览器标签没点成。不能假装看见了「允许本次」或工具 JSON。 | 像 Cline 那样每步工具能展开原文。 |

---

## 10. 四件伸手要找的东西（对照）

| 要找的 | CLI | Web（活页源 / 设置脚本 / 接口） |
|---|---|---|
| **BYOK** | 无 `--api-key` / `--model`。doctor 只报 `credential_present: yes`。Key 在 `.env`。 | 设置 → 模型 → `API Key` / `添加模型` / `已存 Key`。首页没有。 |
| **用量数字** | **有。** 每轮 `tokens: in/cacheW/cacheR/out`，收工 `total` + `cacheHit`。doctor 没有。 | 设置 → `消耗`（轮次 + 美元）；顶栏「上下文用量」。两套口径。 |
| **Plan / Act** | `--plan` = 拆解并执行并核查。`--act` 未知参数。无只读档。 | 「计划」= planner 确认门。无 Act 这个词。默认自动放行。 |
| **可见工具调用** | **有。** `→ tool write_file {json}` + 回执字节/耗时。 | 本卡没点到活对话，不能算看见。 |

---

## 11. 这一双眼睛会不会再用

CLI 我会留下：过程原文和 token 数字是真透明。Web 的模型库 / 消耗页也对上 BYOK 和钱。

我会掉头的点：没有 Plan/Act、`--plan` 词义反了、默认自动放行、非 TTY 批准直接摔、杀掉后续不上同一条线程、CLI 换不了模型和目录。控制权看起来在，拨杆不在我以为的位置。
