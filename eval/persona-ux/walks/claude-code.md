# Claude Code 惯用者 · 走查卡

- **角色：** Claude Code 惯用者（终端是家；`CLAUDE.md` / `AGENTS.md` 是家规；git 是撤销）
- **表面：** CLI 先（避免和 Web 抢同一台宿主）再 Web http://127.0.0.1:4173/ 自开标签
- **日期：** 2026-09-14
- **活 UI：** 是。CLI 在仓库根当场跑过；Web 用本机独立 Chrome（CDP 9229，`http://127.0.0.1:4173/#walk=claude-code`）点过，不共用别人的 Cursor 浏览器标签。
- **习惯伸手：** 先确认当前目录 → 输入框或命令行打 `/` 等补全 → 找 Plan / 权限档 / 项目说明 → 第一句任务前先瞄「只读、要确认、还是全放行」。

---

## 7. CLI 对照（先做，对应剧本 2 / 3 / 5）

仓库根 `d:\Work\Github_pros\Agent_Design`。只靠 `npm run agent -- --help` 和当场输出。

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
| **好** | `npm run agent -- --help` 立刻给出 `run` / `doctor` / 选项列表，不必翻网页。 | 冷启动能 `--help` 看懂怎么开干。 |
| **不习惯** | 帮助里没有斜杠命令、没有 `/plan` `/compact` / 权限切换、没有 `AGENTS.md` / `CLAUDE.md`、没有交互式 REPL。入口是 `run "task"` 一次性跑完。 | 打开就是可打 `/` 的会话，斜杠补全计划门和权限档。 |
| **不习惯** | `--plan` 写的是「planner 拆解、执行并核查子任务」，不像先停在计划等人改再动手。`--yes` 是自动批准，没有 `--permission-mode` / 只读档。 | `--plan` 只出计划；另有权限档（read / ask / bypass）。 |
| **不实用** | `--verify` / `--auto` / `--parallel` / pack 这些词，帮助当默认工作方式写出来。 | 默认就是「在这个目录干活」，核查和编排是进阶。 |

下一步：不加 `--yes` 跑一句小事，看会不会停在批准。

### 7b. 一句话小事（先不加 `--yes`）

命令：

```
npm run agent -- run "Write a file named hello-claude-cli.txt … only the word ping …"
```

启动横幅原文（节选）：

```
compat mode [anthropic]: model=deepseek-v4-flash via https://api.deepseek.com/anthropic …
mcp: connected "stm32" (20 tools)
mcp: skipped "github" (missing GITHUB_PERSONAL_ACCESS_TOKEN)
execution: report-only / host (mode=report, probe=unavailable) — shell commands are not run-isolated
durable: cli-1789386494330 → .agent-run-history/cli-1789386494330/state.json
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
git: Zeraissh/Agent_HarnssEngineering @ main (dirty)
─── turn 1 ───
→ tool write_file {"path":"hello-claude-cli.txt","content":"ping\n"}
Error [ERR_USE_AFTER_CLOSE]: readline was closed
```

退出码 1。工作目录里没有出现 `hello-claude-cli.txt`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 第一屏就写出 `permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask … yes=false)`，写文件前真的没落盘。 | 第一句任务前先能看见现在是只读、要确认、还是全放行。 |
| **好** | 工具调用原文在：`→ tool write_file {"path":"hello-claude-cli.txt","content":"ping\n"}`。 | 自己审将要写什么，不把叙述当真相。 |
| **不习惯** | 该问的时候没有 `y/n` 提示，直接 `readline was closed` 崩掉，退出码 1。非交互终端等于没批准面。 | 停在可读的批准提示，回车或 `y` 放行；管道里也能 `--yes` 或明确说「这里需要 TTY」。 |
| **不实用** | 横幅先甩 compat / mcp stm32 / github token / report-only / durable path。一句写文件被包进一堆内部装配。 | 默认安静，只显示权限档和即将执行的工具。 |

帮助里的逃生口是 `--yes`。下面用它把同一句小事跑完。

### 7c. 同一句小事加 `--yes`

命令：`npm run agent -- run --yes "Write a file named hello-claude-cli.txt … ping …"`

退出码 0。磁盘 `hello-claude-cli.txt` 内容就是一行 `ping`。过程原文：

```
⚠ auto-approved: approve write_file {"path":"hello-claude-cli.txt","content":"ping\n"}
✓ 3ms Wrote 5 bytes to hello-claude-cli.txt
■ completed (2 turns)
  completed: 已在工作目录写入 hello-claude-cli.txt，内容为 "ping" 加一个换行（5 字节）。
```

同一次横幅仍写着：

```
permissionMode: 手动 · 危险动作会先问你，不会自动放行 (approval=ask plan=false gate=false yes=false)
```

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | `--yes` 之后工具原文、自动批准、字节数、`completed` 都在终端里，大约 7 秒结束。文件真的是 `ping`。 | 退出码和日志能脚本化；自己能对磁盘。 |
| **不习惯** | 加了 `--yes`，横幅还说「不会自动放行」且 `yes=false`，下一行却是 `⚠ auto-approved`。权限档自己打自己脸。 | 横幅跟真实档位一致：bypass / acceptEdits 就写 bypass。 |
| **不习惯** | 没有 `git diff` 面板，只有「Wrote 5 bytes」。我要自己 `type` 文件才看见内容。 | 写完立刻给 diff，git 当撤销。 |

项目根没有 `AGENTS.md`，也没有 `CLAUDE.md`（按文件名找过，0 个）。帮助和横幅都没提项目指令文件。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 冷启动找不到家规入口。 | 根目录一眼看到 `AGENTS.md` / `CLAUDE.md`，或帮助写「读哪个指令文件」。 |

### 7d. `--plan`（计划门对照）

命令：`npm run agent -- run --plan --yes "List files … write … claude-cli-note.txt …"`

计划打印出来之后**没有停**，直接 `━━━ 子任务 s1`，再自动开 `verifier 独立复核`。横幅仍是 `plan=false gate=false yes=false`。全程约 60s。`claude-cli-note.txt` 三行是 `listed` / `three-line note` / `done`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 终端里有 `═══ 计划 ═══` 和子任务标题、验收条目，过程流式往下刷。 | 能看见计划文本，不是转圈十分钟再 Done。 |
| **不习惯** | `--plan` 没有计划门：计划出完立刻执行，没法改一条再跑。`--yes` 把「看计划」和「放行工具」捆死。 | `/plan` 先停，我改条目，确认后才动手。 |
| **不实用** | 帮助把 `--plan` 写成「拆解、执行并核查」。一句列目录被 verifier 复核几十秒，还去读 `.agent-run-history`。 | 计划是可选档；默认不要独立核查。 |

### 7e. 中途停止 + `--resume-run`

先跑一个会拖几轮的任务。`taskkill` 树在第 6 轮切断（已经写了 `claude-cli-slow.txt` 的 `1` / `2`，还没写到 10）。终端在 `─── turn 6 ───` 后无收尾行，退出码 1。没有 `Esc` / `Ctrl+C` 友好提示，就是进程死了。

再执行：

```
npm run agent -- run --yes --resume-run cli-1789386649969 "continue"
```

原文：

```
durable resume: cli-1789386649969 → .agent-run-history/cli-1789386649969/state.json
⚠ 没有已提交的 main 检查点（飞行中崩溃不能热续） 将从任务正文重开一轮，不会接着飞行中的工具，也不假装有检查点。
─── turn 1 ───
→ tool bash git status …
```

任务正文只剩 `"continue"`，模型从仓库闲逛，没有接着写第 3 行。我再次杀树才停。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | `--help` 写了 `--resume-run ID`，横幅给出 `durable: cli-…`。杀树后面上文件还在（`1`/`2`）。 | 退出码和 run id 能脚本化。 |
| **不习惯** | 没有会话里的停止键；非 TTY 里批准直接崩，TTY 外只能杀进程。 | `Ctrl+C` / `Esc` 停当前轮，提示「已停，可 `--resume-run`」。 |
| **不实用** | 续跑自己承认「不能热续」，把 `"continue"` 当新任务重开，还去 `git status`。 | 接着上次工具正史往下写第 3 行。 |

CLI 剧本 2 / 3 / 5 到此。下面改走 Web，自开标签，不再跟这份 CLI 抢宿主。

---

## 1. 冷启动（Web）

自开 `http://127.0.0.1:4173/`。带 `?walk=claude-code` 时页面是 `{"error":"File not found: ?walk=claude-code"}`；改成 `/#walk=claude-code` 才进控制台。标签：`FATHOM 控制台`。

新手卡盖住主界面，原文：「初次使用 / 先圈定工作目录 / 工具写入圈是白名单里的全部目录。… / 1 / 4 / 跳过 / 下一步」。点「跳过」后中区是：

> AGENT CONSOLE / FATHOM. / see every run to the bottom. / 每一层都看得见。

输入框标签「任务描述」，占位跟目录走（后来换成 chat 目录时是「要「chat」做什么…」）。旁边：项目 / 工作目录 / 模型 / 运行设置 / 独立核查。侧栏是 Work / Code / 新建对话 + 一长串别人的任务标题，其中有一条就叫 `/plan`（是对话名，不是命令）。

点「运行设置」原文：

- 权限默认（我没改之前）：`自动 · ask 级会自动放行；deny / 圈禁 / 硬拒仍拦住`；选项是「自定义 / 逐次审批 / 计划确认门 / 自动放行 ask」
- 「自动放行」勾着：`工具调用不再逐次问`
- 「计划」没勾：`拆解后等人批准`
- 领域包 / 自动匹配 / 多 agent / 思考强度 / 评分表

设置页有「MCP / Skills」，没有 `AGENTS.md` / `CLAUDE.md` / 项目指令。Skills 文案：「技能包，安装后注入后续对话。」

输入框打 `/`：没有 `/plan` `/compact` 补全。Ctrl+K 命令面板打 `/plan`，列表是「对话 /plan D:\Work\Github_pros\Agent_Design」，帮助区仍写「没有匹配的命令」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 运行设置里能看见权限档和「计划确认门」这几个词；工作目录按钮能对上当前盘符。 | 第一句任务前先瞄现在是只读、要确认、还是全放行。 |
| **不习惯** | 默认是自动放行，不是 ask。没有斜杠命令。侧栏那条 `/plan` 是旧对话标题。设置里有 Skill 商店，没有家规文件入口。 | 打开就能打 `/`，默认 Plan/ask，根上有 `AGENTS.md`。 |
| **不实用** | 冷启动先考「写入圈 / 领域包 / 独立核查」。 | 冷启动只问「在这个目录干什么」。 |

---

## 2. 一句话小事（Web）

把工作目录选成 `D:\Work\Github_pros\Agent_Design`，权限改成「逐次审批」，关掉自动放行和独立核查。输入：

> 在当前工作目录写一个 hello-claude-web.txt，内容只有一行：ping。不要读别的文件，不要跑命令。

点「运行任务」。立刻：「新任务已提交：…」地址变成 `#/run/98d0308d-…/loop`，有「停止」。过程是 `Thinking...` 然后工具原文：

```
⚠ write_file
{ "path": "hello-claude-web.txt", "content": "ping\n" }
允许本次 / 短期允许相同参数 / 拒绝并说明
```

点「允许本次」后：「运行已完成」+「已按要求在工作目录写入 hello-claude-web.txt，内容仅一行 "ping"。」磁盘文件就是 `ping`。产物条：`hello-claude-web.txt / 文档 / 产物 / 预览 / 下载 / 在文件夹中显示 / 变更`。同一屏还写过「本次运行没有写盘操作」。事后点开「变更」是 `写入 ?? 5 B`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 工具 JSON 和「允许本次」在写盘前出现；文件真的是 `ping`。过程不是转圈十分钟再 Done。 | 自己审将要写什么，不把叙述当真相。 |
| **不习惯** | 从打字到看见结果要：改权限 → 发送 → 等卡 → 允许本次 → 读一段「已写入」。没有 `git diff` 正文，只有 `?? 5 B`。 | 默认就要确认；写完直接出 diff。 |
| **不实用** | 「已写入」和「本次运行没有写盘操作」对着干。 | 真相只有一份。 |

---

## 3. 要批准的事（Web）

上一步的写文件卡就是批准面。权限改成「逐次审批」之后，条上变成「手动 · 危险动作会先问你，不会自动放行」。按钮是「允许本次 / 短期允许相同参数 / 拒绝并说明」，另有一项「自动放行 ask」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 卡片上是将要执行的 `write_file` 路径和内容，不是只有工具名。拒绝按钮在。 | 危险操作等人；能看懂要写什么。 |
| **不习惯** | 必须先把默认的「自动放行」拧到「逐次审批」，否则按设置页的话「新对话默认自动放行低风险工具」。 | 默认就是 ask，bypass 才是显式档。 |

---

## 4. 稍长一点 / 计划门（Web）

新建对话。勾「计划」，权限选「计划确认门」。条上变成：「计划 · 先出计划再动手；危险动作会先问你，不会自动放行」和「出图后等人批准。日常对话、小修请关掉」。独立核查勾是关的，文案仍写「独立核查（计划编排默认仍核查子任务）」。

任务：「列一下当前目录顶层文件名，再写一份只有三行的说明到 claude-web-note.txt…先出计划等我改，不要直接写。」Run `3F2D8A`。过程是 `等待模型响应…` / `Thinking...`，然后出现 `✗ glob claude-web-note.txt`、`✗ glob {v,w,x,y,z}*`。直到我按停止，**没有出现可改的计划卡**，也没有「批准计划」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 旋钮名字对得上 Plan：有「计划确认门」，勾上后条会改口。 | 能找到 Plan 这个入口。 |
| **不习惯** | 勾了计划门仍先 glob，不停下来给人改条目。和 CLI `--plan --yes` 一样：计划文本（如果有）不挡执行。 | `/plan` 先停，我改完再跑。 |
| **不实用** | 关了「独立核查」，编排还声明子任务默认核查。领域包列表摊在一件列目录的小事旁边。 | 计划是档位；默认不要包和核查。 |

---

## 5. 过程中途（停止 / 历史 / 刷新）

Run `3F2D8A` 还在 Thinking / glob 时点「停止」。原文：

> 已停止 · 这次运行由你主动停止；已完成的工具调用与写入不会回滚。

发送钮变成「继续对话」，还有「追加指令」。顶栏同时又说「运行已完成：列一下当前目录…」。没有计划可续，也没有接着写 `claude-web-note.txt` 的检查点。

刷新同一条 `#/run/3f2d8a11-…/loop`，停止说明还在。侧栏点「在当前工作目录写一个 hello-claude…」回到 `98D030`，产物和 `ping` 还在。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 运行中有「停止」，点下去立刻停；刷新和侧栏能找回上次结果与产物。 | 中途能打断；历史还在。 |
| **不习惯** | 「已停止」和「运行已完成」并排。没有「从停止处接着写」。 | 停完能 `--resume` 同一条正史。 |

---

## 6. 换地方

工作目录从 `Agent_Design` 换成 `D:\Work\scratch\live-mu-20260914\chat`。还停在刚才那条 run 上。再点「新建对话」，占位变成「要「chat」做什么…」。侧栏仍按目录分组：`Agent_Design` 底下还能看见 hello-claude 和那条名叫 `/plan` 的对话；`ui-qa` / `T5-live-mu-chat` 是别人的。没有「把这份记忆留给下一次」的 `AGENTS.md` 入口，设置里只有 MCP / Skills 安装列表。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 换目录后占位跟着文件夹名走；旧目录的对话还在分组里，能点回去。 | 换地方不会把上次结果弄丢。 |
| **不习惯** | 换目录不会新开一个「项目家」；家规文件始终找不到。 | 新目录先读这里的 `AGENTS.md`，规则文件入口一眼看得见。 |

---

## 伸手对照（斜杠 / 计划门 / 权限 / AGENTS.md）

| 伸手要什么 | 屏幕上实际有什么 |
|---|---|
| `/plan` `/compact` 斜杠命令 | CLI 无 REPL。Web 输入 `/` 无补全；Ctrl+K 的 `/plan` 命中的是一条**对话标题**。 |
| 计划门 | 有旋钮「计划确认门」+「拆解后等人批准」。CLI `--plan` 和 Web 勾上后都**没有**停下来给人改计划。 |
| 权限分级 | Web 有四档；**默认自动放行**。CLI 横幅写「手动」但 `--yes` 时仍印 `yes=false`，下一行 `auto-approved`。非 TTY 不加 `--yes` 直接 `readline was closed`。 |
| `AGENTS.md` / `CLAUDE.md` | 仓库根没有这两个文件。帮助、横幅、设置页都不提。设置有 Skill 商店，不是项目指令文件。 |

**活 UI：是。** 路径：`eval/persona-ux/walks/claude-code.md`
