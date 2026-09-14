# Kimi / Kimi Code 惯用者 · 走查卡

- **角色：** Kimi / Kimi Code 惯用者（长文和超长仓库是家；要中文、Plan/Goal、百万上下文；CLI 和 IDE/网页都能进）
- **习惯卡：** `eval/persona-ux/habits.md` 没有单独的 Kimi 卡。按评测计划那一行习惯走：长文超长仓库、中文、Plan/Goal、百万上下文、CLI+IDE。
- **表面：** CLI 先（避免和别人抢同一台宿主）再 Web http://127.0.0.1:4173/ 自开标签
- **日期：** 2026-09-14
- **活 UI：** 是。CLI 在仓库根当场跑过；Web 用本机独立 Chrome（CDP **9232**，用户目录 `D:\Work\scratch\kimi-walk-chrome-20260914`，`http://127.0.0.1:4173/#walk=kimi`）点过，不共用 9229/9231，也不用别人的 Cursor 浏览器标签。
- **习惯伸手：** 先确认当前目录和语言是不是中文 → 命令行 `--help` 找 `kimi` / 计划 / Goal / 上下文窗口 → 第一句用中文交代长任务，眼睛找 Plan 或目标，而不是「运行 / 包 / 核查」。也会伸手找「把同一条任务丢进 IDE」的入口。

---

## 7. CLI 对照（先做，对应剧本 2 / 3 / 5）

仓库根 `d:\Work\Github_pros\Agent_Design`。只靠 `npm run agent -- --help` 和当场输出。Kimi Code 惯用者会先在终端找入口，再找网页/IDE。

### 7a. `--help`（冷启动等价）

原文：

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

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 选项说明是中文（自动批准、独立核查、拆解、提问、续跑）。`npm run agent -- --help` 当场能看。 | 中文用户打开 CLI 不用先翻英文文档。 |
| **不习惯** | 产品名是 `Agent_Design CLI`，没有 Kimi / Moonshot / 长上下文 / Goal。`--plan` 写的是「planner 拆解、执行并核查」，不像先出 Plan/Goal 等人改。 | 帮助里能看见 Plan、Goal、上下文窗口，以及「用中文长文直接开干」。 |
| **不实用** | `--verify` / `--auto` / `--parallel` / pack 当默认工作方式摊出来。没有「百万上下文」或模型窗口数字。 | 默认就是「在这个目录用中文交代一件事」；窗口大小写在能看见的地方。 |

下一步：用中文下一句小事，先不加 `--yes`，看会不会停在批准（Kimi Code 写盘前通常会问）。

### 7b. 一句话小事（中文，先不加 `--yes`）

命令：

```
npm run agent -- run "在当前工作目录写一个 hello-kimi-cli.txt，内容只有一行：ping。不要读别的文件，不要跑命令。"
```

启动横幅原文（节选）：

```
compat mode [anthropic]: model=deepseek-v4-flash via https://api.deepseek.com/anthropic …
上下文：水位 963k（跟窗口） / 窗口 1,048k（来源：registry）
mcp: connected "stm32" (20 tools)
mcp: skipped "github" (missing GITHUB_PERSONAL_ACCESS_TOKEN)
execution: report-only / host (mode=report, probe=unavailable) — shell commands are not run-isolated
durable: cli-1789390368979 → .agent-run-history/cli-1789390368979/state.json
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
─── turn 1 ───
✽ 思考过程 513 字：Simple task: write a single file with one line "ping". The u…
→ tool write_file {"path":"hello-kimi-cli.txt","content":"ping\n"}
Error [ERR_USE_AFTER_CLOSE]: readline was closed
```

退出码 1。工作目录里没有出现 `hello-kimi-cli.txt`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 第一屏就有「窗口 1,048k」。这是百万上下文，不用翻设置。中文任务被原样收下。 | 长文 / 超长仓库用户一上来要看见窗口有多大。 |
| **好** | `permissionMode: 手动 · 危险动作会先问你`，写文件前没落盘。工具原文在：`write_file {"path":"hello-kimi-cli.txt","content":"ping\n"}`。 | 写盘前能看见要写什么。 |
| **不习惯** | 该问的时候没有中文 `y/n`，直接 `readline was closed`。思考过程是英文 `Simple task…`。模型名是 deepseek，不是 Kimi。 | 停在可读的中文批准；思考也用中文；能看见或换成 Kimi。 |
| **不实用** | 横幅先甩 compat / mcp stm32 / github token / report-only。一句写文件被包进装配日志。 | 默认安静，只留窗口大小、权限、即将写的文件。 |

帮助里的逃生口是 `--yes`。下面用它把同一句中文小事跑完。

### 7c. 同一句小事加 `--yes`

命令：`npm run agent -- run --yes "在当前工作目录写一个 hello-kimi-cli.txt…"`

退出码 0。磁盘 `hello-kimi-cli.txt` 就是一行 `ping`。过程原文：

```
⚠ auto-approved: approve write_file {"path":"hello-kimi-cli.txt","content":"ping\n"}
✓ 4ms Wrote 5 bytes to hello-kimi-cli.txt
已创建 `hello-kimi-cli.txt`，写入 5 字节，内容为一行 `ping`（末尾带换行）。
⚠ 空转 · wire 层 end_turn 不等于任务完成；先给一次提问或继续工作的机会。
→ tool read_file {"path":"hello-kimi-cli.txt"}
→ tool finish_task {… "summary":"已在工作目录创建 hello-kimi-cli.txt…" …}
■ completed (4 turns)
  completed: 已在工作目录创建 hello-kimi-cli.txt，内容为单行 "ping"，并回读确认。
```

同一次横幅仍写着：

```
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
上下文：水位 963k（跟窗口） / 窗口 1,048k（来源：registry）
```

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 模型最终用中文收口；文件真的是 `ping`。窗口数字每次都在。大约 11 秒。 | 中文交代、中文回复；长窗口看得见。 |
| **不习惯** | 加了 `--yes`，横幅还说「不会自动放行」且 `yes=false`，下一行却是 `⚠ auto-approved`。思考仍是英文。写完还空转一轮再读文件。 | 横幅跟档位一致；思考跟用户语言；写完就停。 |
| **不实用** | 没有 Goal，没有「把这条任务丢进 IDE」的提示。完成摘要在终端里，不像一份可带走的长文成品。 | CLI 跑完能在 IDE 里接着看同一份上下文。 |

下一步用 `--plan`，看 Plan/Goal 会不会先停下来给人改。

### 7d. `--plan`（Plan / Goal 对照）

命令：`npm run agent -- run --plan --yes "先列出当前目录顶层文件名，再写一份只有三行的中文说明到 kimi-cli-note.txt…先出计划再动手。"`

计划打印出来之后**没有停**，直接 `━━━ 子任务 s1`，再自动开 `verifier 独立复核`。横幅仍是 `plan=false gate=false yes=false`。全程约 46s。`kimi-cli-note.txt` 三行是 `已列出` / `三行说明` / `完成`。

中间原文（节选）：

```
━━━ 计划单元（planner，只读拆解）━━━
═══ 计划 ═══
s1 列顶层文件并写三行说明文件
    验收: 第 1 行严格等于“已列出”…
━━━ 子任务 s1：列顶层文件并写三行说明文件 ━━━
╔══ verifier 独立复核（全新上下文，自己重读硬件）══
═══ 三角编排结果 ═══
✔ 全部子任务执行并核查通过（全程 46.0s…）
```

没有 Goal 这个词。`--help` 里也没有 `--goal`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 终端里有 `═══ 计划 ═══` 和中文子任务标题、验收条目。最终说明是中文长文，还贴了顶层清单。窗口仍写 1,048k。 | 能看见计划文本，不是转圈十分钟再 Done。 |
| **不习惯** | `--plan` 没有计划门：计划出完立刻执行，没法改一条再跑。没有 Goal。planner 思考仍是英文。 | `/plan` 或 Goal 先停，我改条目，确认后才动手。 |
| **不实用** | 一句列目录被拆成「计划单元 + 子任务 + verifier + 三角编排」，还去读硬件口吻的复核。46 秒写三行。 | 计划是可选档；默认不要独立核查和编排黑话。 |

### 7e. 中途停止 + `--resume-run`

先跑会拖几轮的中文慢写。`taskkill /T` 在第 3 行后切断（`kimi-cli-slow.txt` 已有 `一` / `二` / `三`）。终端在飞行中无收尾行，退出码 1。没有 `Esc` / `Ctrl+C` 友好提示。

再执行：

```
npm run agent -- run --yes --resume-run cli-1789390467926 "继续。接着往 kimi-cli-slow.txt 写剩下的中文数字，不要重开。"
```

原文：

```
durable resume: cli-1789390467926 → .agent-run-history/cli-1789390467926/state.json
⚠ 没有已提交的 main 检查点（飞行中崩溃不能热续） 将从任务正文重开一轮，不会接着飞行中的工具，也不假装有检查点。
─── turn 1 ───
→ tool bash ls -la | head -50
→ tool glob **/kimi-cli-slow*
```

它先去翻 `claude-cli-slow.txt` / `hello-claude-cli.txt` 和一堆 `.agent-run-history`，大约 8 轮考古后才追加 `四`～`十`。最终文件是 10 行中文数字。窗口数字还在，但续跑并没有把上一轮正史接上。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | `--help` 写了 `--resume-run ID`，横幅给出 `durable: cli-…`。杀树后面上文件还在（`一`/`二`/`三`）。最终中文收口。 | 退出码和 run id 能脚本化；中文能接着说「继续」。 |
| **不习惯** | 没有会话里的停止键；非 TTY 里批准直接崩，TTY 外只能杀进程。百万窗口在，续跑却说「不能热续」，把「继续」当新任务。 | `Ctrl+C` 停当前轮，提示「已停，可接着同一条长上下文」。 |
| **不实用** | 续跑自己承认「不能热续」，然后去翻别人的 claude 产物和历史目录。 | 接着上次工具正史写下「四」，不必考古。 |

CLI 剧本 2 / 3 / 5 到此。下面改走 Web，自开标签，不再跟这份 CLI 抢宿主。

---

## 1. 冷启动（Web）

Cursor 内置浏览器这轮接不上（`No browser tab available`）。改开本机独立 Chrome，远程调试口 **9232**，用户目录 `D:\Work\scratch\kimi-walk-chrome-20260914`，地址 `http://127.0.0.1:4173/#walk=kimi`。标签原文：`FATHOM 控制台`。不共用 9229/9231 别人的调试口。

带 `?walk=kimi` 没试（Claude 卡写过查询串会 404）；hash 能进控制台。

第一眼盖着新手卡，DOM 原文：

> 初次使用 / 先圈定工作目录 / 工具写入圈是白名单里的全部目录。主目录是这次的焦点；其它已添加的项目也可以直接改，不必绕路。 / 1 / 4 / 跳过 / 下一步

卡后面已经露出主界面：

> AGENT CONSOLE / FATHOM. / see every run to the bottom. / 每一层都看得见。

输入框标签「任务描述」，占位「要「ui-qa」做什么…」。工作目录按钮显示 `D:\Work\scratc…0260908\ui-qa`（别人的目录）。模型：`环境变量 · deepseek-v4-flash`。旁边：项目 / 工作目录 / 模型 / 运行设置。勾选项「独立核查」。发送钮读屏名「运行任务」。

欢迎区三张起步卡：

- `从计划开始` / `先对齐做法，再动代码`
- `看看这个仓库` / `用一段话说明项目在做什么`
- `修一处并跑通测试` / `改代码，用测试当判据`

侧栏：Work / Code / 新建对话 + 一长串别人的中文任务标题。底栏：打开指挥中心 / 打开产物 / 打开定时任务 / 记忆 / 打开设置。第一屏**没有**「窗口 1,048k」、没有 Goal、没有 Kimi。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 标签、新手卡、占位、起步卡「从计划开始」都是中文。侧栏里别人的任务也是中文标题。 | 中文用户打开就是中文，不用先切语言。 |
| **好** | 空态直接给「从计划开始」。 | 长任务先对齐 Plan，再动手。 |
| **不习惯** | 品牌是 FATHOM / Agent Console，英文标语压在中文上面。默认目录是别人的 `ui-qa`。没有上下文窗口数字，没有 Goal，没有 Kimi。 | 打开就是「这个超长仓库 + 百万窗口 + 用中文交代 Goal」。 |
| **不实用** | 冷启动先考「写入圈 / 白名单 / 独立核查」。侧栏已经堆满别人的运行。 | 冷启动只问「把哪份长文或哪个目录丢进来」。 |

点「跳过」后新手卡 `display:none`。点底栏「打开设置」→「模型」：库里已经有 `kimi-k3` / `kimi-k2.6` / `kimi-k2.7-code` / `kimi-k2.7-code-highspeed`（`https://api.moonshot.cn/anthropic`，已存 Key）。文案写「按该模型窗口能力重算水位」。展开模型列表能看见：

- `kimi-k3` · 窗口 **1048k**（登记）
- `kimi-k2.6` / `kimi-k2.7-code` · 窗口 **262k**（登记）
- `kimi-k2.7-code-highspeed` · 窗口未知

当前执行角色仍是「环境变量 · deepseek-v4-flash」。没有 Goal。消耗页是「轮次 / $0.69」，不是周积分。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 设置里能直接选 Kimi / Moonshot，而且 k3 登记了 1048k。 | CLI+IDE 都能进，库里能找到自家模型。 |
| **不习惯** | 首页条上仍是 deepseek。Kimi Code 那两档只有 262k，不像「百万上下文」。窗口数字要点开模型列表才看见。 | 打开就是 Kimi，首页写着窗口多大。 |
| **不实用** | 没有 Goal。消耗按轮次和美元。 | 长文用户要的是 Goal + 窗口余量，不是领域包列表。 |

---

## 2. 一句话小事（Web）

工作目录从别人的 `ui-qa` 换成 `D:\Work\scratch\kimi-walk-20260914`（路径粘贴 +「选这个目录」；「前往」只会在选择器里逛，不会换主目录）。占位变成「要「kimi-walk-20260914」做什么…」。权限选「逐次审批」，关掉自动放行和独立核查。输入：

> 在当前工作目录写一个 hello-kimi-web.txt，内容只有一行：ping。不要读别的文件，不要跑命令。

点「运行任务」。立刻：「新任务已提交：…」地址变成 `#/run/10c352d8-…/loop`，有「停止」。过程是 `Thinking...` 然后工具原文：

```
⚠ write_file
{ "path": "hello-kimi-web.txt", "content": "ping\n" }
允许本次 / 拒绝并说明
```

点「允许本次」后：「运行已完成」+「在工作目录创建了 hello-kimi-web.txt，内容为单独一行 ping。」磁盘 `D:\Work\scratch\kimi-walk-20260914\hello-kimi-web.txt` 就是 `ping`。产物条：`hello-kimi-web.txt / 文档 / 产物 / 预览 / 下载 / 在文件夹中显示 / 变更`。同一屏写着「本次运行没有写盘操作」。发送钮变成「继续对话」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 中文任务原样进对话；工具 JSON 在写盘前出现；文件真的是 `ping`。过程不是转圈十分钟。 | 中文交代、当场看见要写什么。 |
| **不习惯** | 从打字到看见结果要：换目录 → 拧权限 → 发送 → 允许本次 → 读一段「已创建」。没有把同一条任务丢回 CLI 的入口。 | CLI 和网页是同一条长上下文的两扇门。 |
| **不实用** | 「已创建」和「本次运行没有写盘操作」对着干。还冒出「等待拆步…」。 | 真相只有一份；小事不要编排腔。 |

---

## 3. 要批准的事（Web）

上一步的写文件卡就是批准面。按钮是「允许本次 / 拒绝并说明」。卡片上是路径和 `ping\n`，不是只有工具名。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 卡片能看懂要写哪份文件、写什么。拒绝在。中文按钮。 | 写盘前用人话问一次。 |
| **不习惯** | 必须先把默认的「自动放行」拧到「逐次审批」。默认文案是「自动 · ask 级会自动放行」。 | 默认先问；长文里误写盘比多点一下更糟。 |

---

## 4. 稍长一点 / 计划门（Web）

新建对话。勾「计划」，权限选「计划确认门」。独立核查关掉。任务：

> 列一下当前目录顶层文件名，再写一份只有三行的中文说明到 kimi-web-note.txt。…先出计划等我改，不要直接写。

Run `2ED92C`。先 `✗ glob kimi-walk-20260914`，随后出现「编排计划 / 1 步 · 层宽 1」和「计划待签发」。按钮原文：`批准并开跑` / `改写到稿目录` / `改用普通模式`。卡片原文：

> ◈ 计划待你签字
> 计明远（planner）已拆出 1 个子任务。下面是每一步要做什么——批准后才会发射第一个子任务；此刻否决没有任何副作用。

计划正文是一大段「严禁写盘、只交计划文本」，不是三条可改的 Goal。没有 Goal 这个词。`kimi-web-note.txt` 当时还没落盘。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 「计划待签发」+「批准并开跑」真的停住了，没有直接写文件。起步卡「从计划开始」和这个门对得上。 | 长任务先对齐 Plan，再动手。 |
| **不习惯** | 不能改条目。没有 Goal。先 glob 失败再出计划。名字是「计明远（planner）」和「发射子任务」。 | `/plan` 或 Goal 是几条能改的中文目标，不是编排说明书。 |
| **不实用** | 列目录被写成「层宽 / 并行度 / 只读工具白名单」。关了独立核查，界面仍是编排腔。 | 计划是档位；默认不要包和核查。 |

---

## 5. 过程中途（停止 / 历史 / 刷新）

`2ED92C` 停在计划门时点「停止」。屏幕变成：

> 计划未获批准 · 计划确认门被否决，一个子任务都没有发射——没有任何副作用

同时又写「运行已完成」。发送钮是「继续对话」。`kimi-web-note.txt` 仍不存在。

刷新同一条 `#/run/2ed92ce4-…/loop`，「计划未获批准」还在。侧栏点「在当前工作目录写一个 hello-kimi-w…」回到 `10C352`，产物和 `ping` 还在。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 运行中有「停止」；刷新和侧栏能找回上次结果与产物。 | 中途能打断；历史还在。 |
| **不习惯** | 计划门上等的时候点「停止」，被写成「否决计划」，不是「先挂起，等我改 Goal 再跑」。 | 停 = 挂起同一条长上下文；否决是另一个按钮。 |
| **不实用** | 「已停止/否决」和「运行已完成」并排。没有「从停止处接着写」。 | 停完能接着同一条正史。 |

---

## 6. 换地方

工作目录再换成 `D:\Work\scratch\kimi-walk-b-20260914`（粘贴路径等到面包屑出现，再「选这个目录」；「前往」只在选择器里逛）。要再点一次「新建对话」，占位才变成「要「kimi-walk-b-20260914」做什么…」。侧栏仍按目录分组：`kimi-walk-20260914` 底下还能看见 hello-kimi；`ui-qa` / `Agent_Design` 是别人的。设置里是 MCP / Skills，没有把「这份长文 / 家规」留给下一次的入口。底栏有「记忆」，点开后没有看到可指给下一次的长文附件。

输入框打 `/`：没有 `/plan` `/goal` 补全。侧栏有一条对话标题就叫 `/plan`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 换目录后占位跟着文件夹名走；旧目录的对话还在分组里，能点回去。 | 换地方不会把上次长上下文弄丢。 |
| **不习惯** | 换目录不会新开一个「项目家」；没有 Goal，没有百万窗口余量条。CLI 和网页对不上同一条 run。 | 新目录先读这里的长文/家规；同一条任务能从 CLI 丢进 IDE。 |

---

## 伸手对照（中文 / Plan / Goal / 百万上下文 / CLI+IDE）

| 伸手要什么 | 屏幕上实际有什么 |
|---|---|
| 中文长文开干 | Web 标签、新手卡、任务框、批准按钮都是中文。CLI 帮助选项也是中文。思考过程经常是英文。品牌是 FATHOM / Agent Console。 |
| Plan / Goal | 起步卡「从计划开始」。运行设置有「计划」和「计划确认门」。勾上后能停在「批准并开跑」。**没有 Goal**。计划正文不能改条目。CLI `--plan` 出完立刻执行。 |
| 百万上下文 | CLI 横幅立刻写「窗口 1,048k」。Web 要打开模型列表才看见：kimi-k3 = 1048k，kimi-k2.7-code = **262k**。首页默认仍是 deepseek。 |
| CLI + IDE 都能进 | 两边都能跑同一句中文小事。没有「把这条 CLI 任务丢进网页」的入口，也没有斜杠 REPL。 |
| `/plan` 斜杠 | CLI 无 REPL。Web 输入 `/` 无补全；侧栏 `/plan` 是旧对话标题。 |

**活 UI：是。** 路径：`eval/persona-ux/walks/kimi.md`
