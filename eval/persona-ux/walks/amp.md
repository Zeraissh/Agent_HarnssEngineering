# 走查：Amp / Factory / Warp 惯用者

- **角色：** 第一次用这个软件。家是长线程、远程机器不关、终端块、PR 工厂；锁死一家模型会骂。
- **习惯卡：** `habits.md` 没有 Amp / Factory / Warp 专卡。对照计划原文 + 第 6 张「透明控制派」（BYOK / 换模型 / Plan·Act）的伸手动作。
- **表面：** CLI 先，再自己的浏览器页。Web 与别人共用 http://127.0.0.1:4173/ 。
- **日期：** 2026-09-14
- **live-UI：** 是（自开 Chrome 调试口 9265，`#walk=amp`；Cursor 内置浏览器抢不到页。本机 4173 HTTP 200）

证据规则：只记屏幕 / `--help` / 报错原文。每条带「我本来以为会」。

---

## 0. CLI 先：`--help`（还没开浏览器）

**屏幕原文（`npm run agent -- --help` 全文）：**

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

（帮助块里 `Run options:` 标题在真实输出里是有的，上面逐条原文照抄。）

**好**
- `--resume-run ID` 写在第一屏帮助里。远程线程断了要接上，这是我伸手要的东西。
  - 我本来以为会：只有 `run`，续跑藏在网页里。

**不习惯**
- 产品名是 `Agent_Design CLI`，脚本却叫 `agent` / `cli`。Amp 叫 `amp`，Factory 叫 `droid`，Warp 就在终端里。这里要先猜 `npm run agent`。
  - 我本来以为会：`amp --help` 或至少帮助第一行是我要打的那个二进制名。
- 没有 `--model` / `--provider` / 换 Key。帮助只给 `--yes --verify --plan --parallel --auto --ask --resume-run`。
  - 我本来以为会：第一屏就能换模型，否则就是锁死一家。
- 没有 thread / orb / remote / PR 这些词。`--plan` 是 planner 拆解，不是 Warp 的终端块，也不是 Factory 的 PR 工厂。
  - 我本来以为会：帮助里有线程、远程机、开 PR。

**不实用**
- `--verify` / `--auto` / `pack` 对我这个角色不是日常旋钮。我要的是线程还在、模型能换、命令块看得见。
  - 我本来以为会：帮助先讲怎么挂远程、怎么续上一条长线程。

## 0b. CLI 先：极小 `run`（无工具）

命令：`npm run agent -- run "Reply with only the word pong. Do not use any tools."`  
退出码 0。未加 `--yes`。

**屏幕原文（启动横幅 + 两轮，密钥未出现）：**

```
compat mode [anthropic]: model=deepseek-v4-flash via https://api.deepseek.com/anthropic (thinking/effort/cache_control disabled)
上下文：水位 963k（跟窗口） / 窗口 1,048k（来源：registry）
mcp: connected "stm32" (20 tools)
mcp: skipped "github" (missing GITHUB_PERSONAL_ACCESS_TOKEN)
vision model: deepseek-v4-flash-vision-exp
describe_image: vision-role (deepseek-v4-flash-vision-exp)
execution: report-only / host (mode=report, probe=unavailable) — shell commands are not run-isolated
durable: cli-1789390950045 → .agent-run-history/cli-1789390950045/state.json
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
git: Zeraissh/Agent_HarnssEngineering @ main (dirty)
recovery: extension=8(default) stagnation=3(default) recoveries=1(default)
─── turn 1 ───
▷ 模型请求 #0（第 1 轮）
pong
■ 模型请求 ok 1517ms
  tokens: in=226 cacheW=0 cacheR=10368 out=3
⚠ 空转 · wire 层 end_turn 不等于任务完成；先给一次提问或继续工作的机会。
─── turn 2 ───
…
→ tool finish_task {"status":"completed","summary":"按要求仅回复了 \"pong\"…","artifacts":[],…}
✓ 0ms 已收到，交付完成。
■ completed (2 turns)
  total: in=421 cacheW=0 cacheR=20864 out=249 | cacheHit=98.0%
```

版本：`npm run agent -- --version` → `1.3.0`。

**好**
- `─── turn 1 ───` / `─── turn 2 ───` 把一轮收成一块，有点像 Warp 的终端块：请求、正文、tokens 在同一段。
  - 我本来以为会：一整片滚屏，分不出哪次模型往返。
- `durable: cli-1789390950045 → .agent-run-history/…/state.json` 跟 `--resume-run` 对得上。机器不关、线程可接，这是 Amp orb / Factory droid 的地板。
  - 我本来以为会：跑完就没了，ID 要自己从日志里挖。
- 用量数字摊在块脚：`tokens: in=… out=…`、`cacheHit=98.0%`。
  - 我本来以为会：只有「Done」，不说花了多少。

**不习惯**
- 只回一个 `pong` 也被判 `⚠ 空转 · wire 层 end_turn 不等于任务完成`，又逼出第二轮 `finish_task`。Warp 里我说一句话它回一句话，不会再审我是不是「交付完成」。
  - 我本来以为会：无工具短答直接结束。
- 横幅先报 `mcp: connected "stm32"`，`github` 因 `missing GITHUB_PERSONAL_ACCESS_TOKEN` 被 skipped。Factory 的家是 PR 工厂，不是板子。
  - 我本来以为会：冷启动先接 git / GitHub，硬件工具默认不出现。
- 模型名在 compat 灰字里：`model=deepseek-v4-flash`。没有「现在用哪家、怎么换」。
  - 我本来以为会：启动就问模型，或给 `--model`。

**不实用**
- `execution: report-only / host (mode=report, probe=unavailable)`、`recovery: extension=8…` 对我开长线程没用，还占了第一屏。
  - 我本来以为会：第一屏是 thread 状态 + 远程是否还在跑。
- `git: … @ main (dirty)` 只是状态，没有「开 PR / 出 diff 块」。
  - 我本来以为会：脏工作区直接给我 PR 入口。

## 7 提前：CLI 第 2 步（一句话小事：写 hello.txt）

先试了**不带** `--yes`（见下一节批准），文件没写出来。再跑：

`npm run agent -- run --yes "Write a file at eval/persona-ux/walks/_amp-scratch/hello.txt containing exactly the word ping…"`

退出码 0。自己用字节核对：`exists=True bytes=4 hex=70-69-6E-67 text=[ping]`。

**屏幕原文（节选）：**

```
durable: cli-1789391279436 → .agent-run-history/cli-1789391279436/state.json
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
─── turn 1 ───
→ tool bash {"command":"cd \"D:/Work/Github_pros/Agent_Design\" && ls -la … 2>/dev/null || echo \"dir missing\""}
⚠ auto-approved: approve bash {…}
✗ 7ms Refused: shell redirect target escapes the working directory ("/dev/null"). Use a path inside D:\Work\Github_pros\Agent_…
─── turn 3 ───
→ tool write_file {"path":"eval/persona-ux/walks/_amp-scratch/hello.txt","content":"ping"}
⚠ auto-approved: approve write_file {…}
✓ 8ms Wrote 4 bytes to eval/persona-ux/walks/_amp-scratch/hello.txt
─── turn 6 ───
→ tool finish_task {"status":"completed","artifacts":["eval/persona-ux/walks/_amp-scratch/hello.txt"],…}
■ completed (6 turns)
```

**好**
- 工具调用是一块块的：`→ tool` + 命令原文 + `prepared / running / committed` + 绿勾或红叉。这就是我要的终端块，比「我已经写好了」强。
  - 我本来以为会：只给一段叙述，命令藏起来。
- `artifacts` 在 `finish_task` 里点了路径。Warp / Amp 线程末尾也要能指到文件。
  - 我本来以为会：完成词里没有路径。

**不习惯**
- 加了 `--yes`，横幅仍写 `permissionMode: 手动 · 危险动作会先问你，不会自动放行 (… yes=false)`，同时又刷 `⚠ auto-approved`。第一眼以为没放行。
  - 我本来以为会：`--yes` 时第一行就改成「已自动放行」。
- 写 4 个字走了 6 轮，还先 `ls`、撞 `/dev/null` 拒绝、再 `write_file`、再 `od`/`git status`。Amp 线程里这种小事不该像流水线开工。
  - 我本来以为会：一轮 `write_file` 结束。

**不实用**
- `Progress updated (2)` / `▣ Progress 0/2` 像内部看板，不是 PR，也不是终端块摘要。
  - 我本来以为会：末尾给我 `git diff` 或「开 PR」。

## 7 提前：CLI 第 3 步（要批准的事）

同一条写文件，**不加** `--yes`。模型两发 `bash`（`ls` 目录 + `git status`）。没有打印出「允许 / 拒绝」卡片，直接炸：

**屏幕原文：**

```
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
─── turn 1 ───
→ tool bash {"command":"ls -la eval/persona-ux/walks/ …"}
→ tool bash {"command":"cd /d/Work/Github_pros/Agent_Design && git status --porcelain …"}
Error [ERR_USE_AFTER_CLOSE]: readline was closed
    at Interface.question …
    at renderEvent (…\src\cli.ts:2199:33)
```

退出码 1。`hello.txt` 当时 **MISSING**。`durable-state EXISTS`（`cli-1789391211924`）。

**好**
- 默认是问，不是偷偷写。这点跟 Amp 权限档、Warp 命令确认同方向。
  - 我本来以为会：没 `--yes` 就直接改盘。

**不习惯**
- 手伸向 y/n 或一块「Allow bash」时，终端没有命令块可点，只有 Node 堆栈。
  - 我本来以为会：打印要跑的命令，等我回车，或明白写出「非交互环境请加 --yes」。
- 帮助只说 `--yes`「无人值守」，没说**有人值守时怎么答**。
  - 我本来以为会：`--help` 里有「批准时按 y」或斜杠 `/approve`。

**不实用**
- 在这个执行环境里（stdin 已被收掉），「手动批准」等于任务失败。远程机器上的 Factory / Amp 线程经常也不是一张活 TTY。
  - 我本来以为会：远程/非 TTY 自动改口成「写一条待批、进程不退」，而不是 `readline was closed`。

## 7 提前：CLI 第 5 步（中途停 + 续）

对炸掉的那次 `cli-1789391211924` 跑：`npm run agent -- run --resume-run cli-1789391211924 --yes`

**屏幕原文：**

```
durable resume: cli-1789391211924 → .agent-run-history/cli-1789391211924/state.json
⚠ 没有已提交的 main 检查点（飞行中崩溃不能热续） 将从任务正文重开一轮，不会接着飞行中的工具，也不假装有检查点。
─── turn 1 ───
✽ 思考过程 … The user says "接着上次的检查点继续" …
→ tool bash {"command":"cd /d/Work/Github_pros/Agent_Design && pwd && ls -la"}
```

它没有回去写 `hello.txt`，自己改口去翻仓库（还 `sleep 20`）。我按 Amp 远程线程该做的把它停掉：整棵 `node` 树 `taskkill /T /F`，复查 `cli-1789391211924` 进程已 GONE。

**好**
- `--resume-run` 真的接得上同一个 ID，横幅写 `durable resume`。远程机器不关、线程还能点开，这是地板。
  - 我本来以为会：ID 过期或要重新粘整段任务。
- 诚实说「飞行中崩溃不能热续」「不假装有检查点」。Warp 块断了有时装没事。
  - 我本来以为会：假装从工具中间接着跑。

**不习惯**
- 帮助写「同 run 续跑」，实际重开后模型看见的是「接着上次的检查点继续」，原任务「写 ping」丢了。
  - 我本来以为会：同一条写文件从下一刀续。
- `--help` 没有 `stop` / `cancel`。停 = 杀进程。
  - 我本来以为会：`amp stop` 或线程里一个 Interrupt。

**不实用**
- 续跑变成在脏仓库里考古，还去读别人的走查稿。远程 PR 工厂最怕这种「接上了但干别的」。
  - 我本来以为会：读不到检查点就停，并打印原任务原文让我确认。

## 1. Web 冷启动（自己的 Chrome 页）

URL：`http://127.0.0.1:4173/#walk=amp`  
标题原文：`FATHOM 控制台`  
截图：`eval/persona-ux/walks/_amp-1-cold.png`（CJK 字在截图里糊成乱码，下面以页面文本为准）

**屏幕原文（欢迎主区 + 新手卡 + 侧栏）：**

```
FATHOM.
Agent Console
see every run to the bottom.
每一层都看得见。
Work / Code
新建对话
[ph] 搜索对话…
[ph] 要「ui-qa」做什么…
运行任务
独立核查
从计划开始  先对齐做法，再动代码
看看这个仓库  用一段话说明项目在做什么
修一处并跑通测试  改代码，用测试当判据
环境变量 · deepseek-v4-flash
运行设置
打开指挥中心 / 打开产物 / 打开定时任务 / 记忆 / 打开设置

初次使用
先圈定工作目录
工具写入圈是白名单里的全部目录。主目录是这次的焦点；其它已添加的项目也可以直接改，不必绕路。
1 / 4
跳过  下一步
```

侧栏已有别人的长串对话（`hello-chatgpt.txt` / `hello-antigr…` / `/plan` / `接到我的飞书` …），项目名 `Agent_Design`、`ui-qa`、`kimi-walk-20260914`、`lingma`、`T5-live-mu-chat`。输入框绑的是别人的 `ui-qa`。

模型钮 title 原文：`环境变量 · deepseek-v4-flash（anthropic · deepseek-v4-flash）· 1048k tokens（来源：登记表）。切换会按新窗口重算水位；进行中的这一轮不受影响。` 下拉里还能看见 `kimi-k3` / `kimi-k2.6` / `deepseek-v4-pro`。

**好**
- 左侧就是线程列表，而且很多条还在。Amp 的家是长线程，这里第一眼就是线程，不是空白聊天。
  - 我本来以为会：只有一个大输入框，历史要另开菜单。
- 写输入框旁边就能换模型，而且不止一家。锁死一家我会骂；这里至少 Web 没有锁死。
  - 我本来以为会：跟 CLI 一样只有横幅里一个 `deepseek-v4-flash`。
- 底栏有 `打开定时任务`。远程机器不关、定时再跑，是 Factory / Amp orb 伸手要的东西。
  - 我本来以为会：只有当场对话。

**不习惯**
- 品牌是 `FATHOM 控制台` / `每一层都看得见`，不是线程、Droid、Warp Drive。第一次不知道这是不是我要的那类终端 agent。
  - 我本来以为会：标题附近有 Thread / Remote / Terminal。
- 我自己的新页，工作目录和占位却是 `要「ui-qa」做什么…`，侧栏全是别人的 ping 任务。共享宿主像一台没分用户的远程机。
  - 我本来以为会：新标签 = 空线程，目录是我刚 `cd` 的仓库。
- 新手卡讲「写入圈 / 白名单 / 主目录」，不像 Amp 权限档，也不像 Warp 命令确认。
  - 我本来以为会：先问模型、远程是否接着跑、要不要开 PR。
- 截图里中文糊成拉丁乱码，页面文本是对的。远程看机的人如果只看图会以为软件坏了。
  - 我本来以为会：截下来就是我屏幕上的字。

**不实用**
- `独立核查`、`从计划开始` 当默认推荐，对我是仪式。我要终端块和 PR。
  - 我本来以为会：推荐「开 PR」或「在远程接着跑」。
- `Work` / `Code` 两个脸，第一眼不知道跟线程有什么关系。
  - 我本来以为会：一个线程流，终端块嵌在对话里。

## 2. Web 一句话小事（写 amp-web-hello.txt）

关掉新手卡「跳过」。工作目录从别人的 `ui-qa` 点成 `D:\Work\Github_pros\Agent_Design`。占位变成 `要「Agent_Design」做什么…`。点「运行任务」。

按钮瞬时原文：`提交中…`  
随后地址：`http://127.0.0.1:4173/#/run/3f1b3908-d41c-4c35-a739-ec116509857e/loop`

**屏幕原文（跑完后还能看见的字）：**

```
新任务已提交：Write a file at eval/persona-ux/walks/_amp-scratch/amp-web-hello.txt …
运行已完成：Write a file at …
[aria] 预览 eval/persona-ux/walks/_amp-scratch/amp-web-hello.txt
[aria] 在文件夹中显示 eval/persona-ux/walks/_amp-scratch/amp-web-hello.txt
cmp <(printf 'ping') eval/persona-ux/walks/_amp-scratch/amp-web-hello.txt 返回 EXACT_BYTES_MATCH
Loop 循环：9 轮，■ 已完成，思考强度 low（compat 下不发送），… ⚠ 空转 · 可停止
```

磁盘：`amp-web-hello.txt` = 4 字节 `70-69-6E-67` = `ping`。截图 `_amp-2-running.png`。

输入框还在同一条线程，提示大意是运行中可直接发送插入（截图乱码，文本层有「运行进行中」一类）。

**好**
- 发出去就变成一条带 URL 的线程，还能追加。这就是 Amp 长线程，不是一问一答就关。
  - 我本来以为会：发完跳到一段不能续的日志。
- 结果里有路径、`在文件夹中显示`、右边还有产物。比只回「写好了」像 Warp 块。
  - 我本来以为会：只有聊天稿，文件要自己去翻盘。

**不习惯**
- 四个字写了 **9 轮**，中间一长段英文纠结要不要换行。Warp 里这是一次 `write` 块。
  - 我本来以为会：一两块终端输出就结束。
- 已完成还挂着 `⚠ 空转 · 可停止`。
  - 我本来以为会：完成就是完成，空转只在还转的时候出现。

**不实用**
- 右侧 Progress / Loop 护栏数字（续跑 8 / 停滞窗 3）不像 PR 工厂的检查项。
  - 我本来以为会：右边是 diff 或 PR 预览。

## 3. Web 要批准的事

共享页上权限已被别人拨成 `自动放行 ask`。我打开「运行设置」，把选择器改成原文 `逐次审批`，并去掉「自动放行 / 工具调用不再逐次问」。新建对话，发写 `amp-web-approve.txt` / `gate`。

**屏幕原文（批准卡，截图 `_amp-3-approve.png`）：**

```
⚠ bash
{ "command": "cd \"D:/Work/Github_pros/Agent_Design\" && ls -la eval/persona-ux/walks/_amp-scratch/ …" }
允许本次
短期允许相同参数
拒绝并说明
[aria] 拒绝 bash 的理由（可选）
停止
开启桌面通知，运行完成或需要你决定时提醒你
```

地址：`#/run/1c6df73a-ce2b-46f4-97f1-66f19c97a1f6/loop`  
当时文件 **还没写出来**（`amp-web-approve.txt` MISSING）。右边 Progress：`● 确认目标路径…  ○ 写入 amp-web-approve.txt  ○ 字节级校验…`，`本次运行没有写盘操作`。

**好**
- 命令原文摊在一块橙框里，底下是允许 / 短期允许 / 拒绝。这就是 Warp 终端块 + Amp 权限档，比 CLI 那次 `readline was closed` 能用。
  - 我本来以为会：只有「运行中」转圈，或只有工具名没有命令。
- `短期允许相同参数` 在。长线程里同一条 `ls` 不该每轮都问。
  - 我本来以为会：只有「允许本次」，没有线程级记忆。

**不习惯**
- 卡上是 JSON，`command` 还带一堆 `\\\"`。Warp 块是我能抄的那一行。
  - 我本来以为会：黑底绿字一条 `ls -la …`。
- 问的是 `ls`，不是写 `gate`。Factory 的闸门我以为会卡在开 PR / 改文件。
  - 我本来以为会：第一张卡就是 `write_file`。

**不实用**
- 旁边同时出现 `Tools 工具无领域包19 个工具`、`隔离：仅报告，宿主直跑`、`Verification 核查⋯ 尚未核查`。批准一个人不需要这些。
  - 我本来以为会：一张卡、三个按钮、一句影响面。

## 4. Web 稍长一点（同一条线程续上）

停掉写 `gate` 之后，输入框占位变成 `接着说…`，有按钮原文 `继续对话` / `追加指令`。我点「继续对话」，追加：

> 不要写新文件。用三行列出 eval/persona-ux/walks/_amp-scratch 里已经有哪些文件。三行分别写：已列出、文件名、完成。

还是同一个 URL。它记得上次 `ls` 过 `amp-web-hello.txt` 和 `hello.txt`，但又要再跑一次 bash，再出 `⚠ bash` 卡。我点「允许本次」。

**屏幕原文（跑完）：**

```
现有 2 个文件：amp-web-hello.txt、hello.txt；原任务要求的 amp-web-approve.txt（内容 gate）经委托方明确撤销，未创建。
bash: ls -1 eval/persona-ux/walks/_amp-scratch/ 输出 amp-web-hello.txt、hello.txt
按要求输出三行清单（已列出 / 文件名 / 完成）
Loop 循环：4 轮，■ 已完成
运行已完成：Write a file at … amp-web-approve.txt …   ← 标题仍是第一刀的任务
```

冷启动欢迎区另有卡片原文：`从计划开始  先对齐做法，再动代码`。运行设置里有 `计划 拆解后等人批准`、`计划确认门`。侧栏里别人正在做「列一下…再写三行说明」。

**好**
- 停掉的线程能接着说，而且记得目录里已经有什么。这是 Amp 长线程，不是新开一局。
  - 我本来以为会：停止 = 这条作废，只能新建对话。

**不习惯**
- 线程标题一直是第一句写 `gate`，追加的三行清单不改名。Amp 线程名我会改。
  - 我本来以为会：追加之后标题跟着最后一句走，或让我重命名。
- `从计划开始` 是欢迎区一张推荐卡，不是 `/plan`。侧栏倒是有人打了字面 `/plan`。
  - 我本来以为会：输入框先打 `/` 出斜杠命令。

**不实用**
- 只列两个文件名又要批准 bash、再走 4 轮。Warp 里这是我自己敲的一截 `ls`。
  - 我本来以为会：续跑直接吐三行，不再开工具卡。

## 5. 过程中途：停止、回看、刷新

在写 `gate` 还没落盘时点「停止」。

**屏幕原文：**

```
已停止 · 这次运行由你主动停止；已完成的工具调用与写入不会回滚。
Loop 循环：2 轮，■ 已停止
运行已完成：Write a file at … amp-web-approve.txt …
[aria] 继续对话
追加预算继续本对话
```

刷新到 `http://127.0.0.1:4173/#/`（标题仍 `FATHOM 控制台`）。侧栏还在，约 94 条。点回 `Write a file at eval/pe…` → `已选择运行：…amp-web-approve.txt…`，停止说明还在。通知中心原文：`被停止` 那条 approve、`完成` 那条 hello（「3 分钟前」）。

**好**
- 停止立刻停，并写明「写入不会回滚」。远程线程被我砍掉时，我要知道盘上改了什么。
  - 我本来以为会：转完这一轮才停，或不说有没有写过。
- 刷新后线程还在。关电脑再开浏览器，Amp 的地板就是这个。
  - 我本来以为会：刷新变欢迎页，历史没了。

**不习惯**
- 同一屏既写 `已停止` 又写 `运行已完成`。通知里有时也叫「完成」。
  - 我本来以为会：停就是 Stopped，完成就是 Done。
- CLI 停 = 杀进程；Web 有「停止」。两面不是同一套手势。
  - 我本来以为会：CLI 也有 `stop` / 同一条 `--resume-run` 接 Web 的 ID。

**不实用**
- `追加预算继续本对话 当场给谱系加一段 token 跑道` 不像「这条远程线程还在跑」。
  - 我本来以为会：一个「在远程接着跑 / 关页不停」的开关。

## 6. 换地方（项目 / 目录）

侧栏原文分组：`Agent_Design`（我的两条 Write a file）、`ui-qa`、`kimi-walk-20260914`、`lingma`、`T5-live-mu-chat`。工作目录菜单里还有 `D:\Work\Wafer\AGS`、一串 `live-mu-20260914\…`、`＋ 添加目录…`。项目下拉：`未入项（按目录）` / `网盘管理` / `T5-live-mu-chat` / `＋ 新建项目…`。

新手卡还在讲「写入圈是白名单里的全部目录」。底栏 `记忆` 打开是：`还没有记忆——Agent 在跨会话工作中积累的内容会出现在这里`。

我在已停下的线程里点别人的 `kimi-walk-20260914`，输入框仍是 `接着说…`，目录钮还停在 `Agent_Design`——人还在旧线程上。

**好**
- 对话按目录扎堆，换项目时旧线程不会和别人的混成一块无标签流水。
  - 我本来以为会：94 条平铺，看不出是哪个仓库。
- `＋ 添加目录…` 在菜单第一层。远程机上换工作区不该先改配置文件。
  - 我本来以为会：只能用启动时那个目录。

**不习惯**
- 新标签默认占位是别人的 `要「ui-qa」做什么…`。共享宿主像一台没分用户的 Factory 机架。
  - 我本来以为会：我的浏览器页 = 我的工作区。
- 不先「新建对话」就点别的目录，线程不跟着走。
  - 我本来以为会：换目录等于换 Warp 工作区，输入框立刻对着新盘。

**不实用**
- 没有 PR 工厂：找不到「开 PR」「Review」入口。CLI 冷启动还写 `mcp: skipped "github" (missing GITHUB_PERSONAL_ACCESS_TOKEN)`。
  - 我本来以为会：脏工作区直接给我一条开 PR。
- `定时任务` 里是别人的 `T5-draft-disabled` / `已停用` / `立即运行`，以及创建模板「每日简报工作日 08:00」。这是闹钟，不是「这条编码线程丢到远程还在跑」。
  - 我本来以为会：当前线程一键挂到远程机。
- 设置里能换模型、填 Base URL、Key「只保存在服务端，永不下发浏览器」、「保存到模型库」「同步到 .env」。Web 没有锁死一家——但 CLI `--help` 仍没有 `--model`。两面分裂。
  - 我本来以为会：CLI 和网页共用一套换模型手势。

## 对照（同一双眼睛）

| 我伸手要的 | CLI | Web |
|---|---|---|
| 长线程 / 续上 | `--resume-run` 有；崩溃后改口去考古 | 刷新还在；`继续对话` 真能续 |
| 远程机器不关 | `durable: …/state.json` 落在这台盘上 | `定时任务` 是闹钟，不是 orb |
| 终端块 | `─── turn N ───` + 命令原文 | `⚠ bash` 橙块，JSON 难看但能批 |
| PR 工厂 | GitHub MCP 被 skipped | 没有开 PR |
| 别锁死模型 | `--help` 无 `--model` | 输入栏就能换，还有 `管理模型…` |

没有读 `docs/`、README、backlog、测试、`src/`。证据只来自 `--help`、报错、4173 页上的字和截图。
