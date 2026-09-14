# Copilot 企业用户 · 走查卡

- **角色：** Copilot 企业用户（IDE 插件 + GitHub 是家；工作单元是 issue / PR；公司账号，少换壳；云端是 issue→PR）
- **表面：** Web http://127.0.0.1:4173/ （剧本 1–6）
- **日期：** 2026-09-14
- **活 UI：** 是。本机 4173 Listen；Cursor 内建浏览标签当时建不出来（`No browser tab available`）。自开独立 Chrome（CDP 9231，user-data `copilot-walk-chrome`）打开 `http://127.0.0.1:4173/#walk=copilot`，不共用别人的走查页。
- **习惯伸手：** 先看登录 / 公司租户 → 找 PR / 评审 / 仓库或侧栏 Chat → 输入像提 issue。不找「领域包」「核查者」。盯：留在 GitHub/PR、公司账号、不要新操作系统、评审不是聊天稿倾倒。

---

## 1. 冷启动

打开 `http://127.0.0.1:4173/#walk=copilot`。标签原文：`FATHOM 控制台`。第一眼是整页工作台，不是 GitHub，也不是 IDE 侧栏。

中区大字：

> AGENT CONSOLE
> FATHOM.
> see every run to the bottom.
> 每一层都看得见。

左侧：`Work` / `Code`、`新建对话`、搜索「搜索对话…」、按文件夹分组的旧对话（`Agent_Design` / `ui-qa` / `T5-live-mu-chat`…）。**没有登录、没有公司租户、没有 PR / 评审 / issue 列表。**

输入栏标签「任务描述」，占位跟当时目录走（打开时是「要「ui-qa」做什么…」）。旁边：`项目` `未入项（按目录）`、工作目录、`环境变量 · deepseek-v4-flash`、`运行设置`、勾选「独立核查」。欢迎卡：「从计划开始 / 先对齐做法，再动代码」「看看这个仓库 / 用一段话说明项目在做什么」「修一处并跑通测试」。

右下角盖着新手卡 1/4 原文：

> 初次使用 / 先圈定工作目录 / 工具写入圈是白名单里的全部目录。主目录是这次的焦点；其它已添加的项目也可以直接改，不必绕路。 / 1 / 4 / 跳过 / 下一步

底栏读屏名：`打开指挥中心` / `打开产物` / `打开定时任务` / `记忆` / `打开设置`。

点「打开设置」。侧栏条目原文：`外观` / `模型` / `MCP / Skills` / `领域包` / `运行默认值` / `通知` / `快捷键` / `消耗` / `关于`。没有「登录」「组织」「SSO」「公司账号」。模型区是自己贴 Key：`环境变量 Key` / `已存 Key` / `API Key` / `留空 = 使用环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY）`。

往下翻到 MCP 才看见 GitHub。卡片原文：

> GitHub / MCP / 仓库、议题与拉取请求。 / 已安装 / 已启用

点「详情」：

> 官方 github/github-mcp-server（docker）。工作区连接器，不是某个领域包的私货。
> 官方镜像 ghcr.io/github/github-mcp-server。需要 GITHUB_PERSONAL_ACCESS_TOKEN（可用 GITHUB_TOKEN 别名）。

同一屏底句：

> MCP 未连接（需 AGENT_UI_MCP=1）。

首页可见字里搜不到「登录 / 账号 / 租户 / SSO / Copilot / 评审 / Pull request」。`看看这个仓库` 是本地目录示例，不是 GitHub 仓库页。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 第一眼是 `FATHOM 控制台` 整页台子：新建对话、领域包、独立核查、写入圈。没有公司登录，没有 PR 列表。 | 用公司账号进 GitHub 或 IDE 侧栏 Copilot Chat，工作单元是 issue / PR。 |
| **不习惯** | GitHub 藏在设置 → MCP，要个人 `GITHUB_PERSONAL_ACCESS_TOKEN`，并且写着「MCP 未连接」。 | 公司租户已经登录；仓库权限跟组织走，不是再贴一把 PAT。 |
| **不实用** | 冷启动先考工作目录白名单和模型 Key。这是另一套操作系统，不是插件。 | 少换壳：还在原来的 IDE / github.com 里提一句 issue。 |
| **好** | 设置里 GitHub 卡片至少写了「仓库、议题与拉取请求」，名字对得上我要的工作单元。 | 家在 GitHub 的 PR / issue，而不是「一次运行」。 |

下一步：在当前目录写一个小文件，看交出来的是 PR / 评审，还是一段聊天稿。

---

## 2. 一句话小事

没有改权限。当前工作目录按钮写着 `D:\Work\scratc…0260908\ui-qa`，占位「要「ui-qa」做什么…」。输入框打了一句像 issue 的话：

> 在当前工作目录写一个 hello-copilot.txt，内容只有一行：ping。不要读别的文件，不要跑命令。

点「运行任务」（`#submit-btn`，按下后变成「提交中…」）。地址变成 `#/run/94d88cd6-c02f-49be-a7fc-b50cf416349c/loop`。默认没有停下来问我，也没有出现 PR。

几秒后顶栏：`运行已完成：在当前工作目录写一个 hello-copilot.txt…`。中区是聊天稿，不是 diff：

> 已在工作目录创建 hello-copilot.txt，内容为单行 "ping"（含行尾换行，共 5 字节）。

上面还有 `Thought Process`。右侧：`Progress ⟩ 等待拆步…`，下面 `文档 1 / hello-copilot.txt / 产物 / 预览 / 下载 / 在文件夹中显示`，再下面「变更」自己写着：

> 本次运行没有写盘操作

磁盘 `D:\Work\scratch\agent-design-local-20260908\ui-qa\hello-copilot.txt` 就是 `ping` + 换行。同屏没有「Create pull request」「Review」「Files changed」「comment」。输入栏改成「接着说… / 本轮独立核查」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 交出来的是一段「已创建…」聊天稿 + Thought Process，工作单元是 `FATHOM · RUN 94D88C`。 | issue 丢进去，回来收 PR；评审在 GitHub 上做。 |
| **不习惯** | 「变更」栏写「本次运行没有写盘操作」，文件却已经在磁盘上。没有 files changed，不能留评审意见。 | 改动以 PR / 评审意见的形状出现，人在 GitHub 上批。 |
| **好** | 有「hello-copilot.txt / 在文件夹中显示 / 预览 / 下载」，文件内容真是 `ping`。 | 至少能摸到产物，不是只有空聊天。 |
| **不实用** | 默认自动写盘，本地 agent 改了文件却不给评审入口。右侧还挂着「等待拆步…」。 | 本地不要抢鼠标；云端 agent 才改仓库，而且出口是 PR。 |

---

## 3. 要批准的事

点「运行设置」。原文：

> 权限 / 自动 · ask 级会自动放行；deny / 圈禁 / 硬拒仍拦住
> 自定义 / 逐次审批 / 计划确认门 / 自动放行 ask
> 自动放行 / 工具调用不再逐次问（默认勾着）
> 领域包 / 计划 / 多 agent / 思考强度 / 评分表

把权限点成「逐次审批」，关掉「自动放行」。新对话输入：

> 在当前工作目录写一个 approve-copilot.txt，内容只有一行：review。不要读别的文件，不要跑命令。

Run `CB2DF5`。写盘前停住。卡片原文是工具 JSON，不是评审：

> ⚠ write_file
> { "path": "approve-copilot.txt", "content": "review\n" }
> 允许本次 / 短期允许相同参数 / 拒绝并说明 / 自动放行 ask

点「允许本次」之前，磁盘上没有这个文件。点完之后文件出现，内容是 `review`。主区仍停在 `Thinking... / write approve-copilot.txt`，顶上闪过「连接中断，正在重连…」。侧栏这条已经标「完成」，输入钮变成「继续对话」。没有 Files changed，没有 comment 框。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 关掉自动放行后，写盘前真的问了；拒绝按钮在；批准前文件不存在。 | 没批准就不能改文件。 |
| **不习惯** | 卡片主体是 `write_file` 和 JSON，不是 diff，不能留一条评审意见。 | 评审还是人在 GitHub 上做：files changed + comment。 |
| **不习惯** | 默认是「自动 · ask 级会自动放行」。要自己找到「运行设置」才拧到逐次审批。 | 公司策略已经设好，不必在另一个壳里拨档。 |
| **不实用** | 批准之后聊天卡在 Thinking，侧栏却说完成。这不是我能拿去请同事 Review 的东西。 | 批准面就是 PR；批完能分享链接，不是一段断掉的 Thinking。 |

---

## 4. 稍长一点的事

运行设置还开着，旋钮原文还在：`领域包`（默认「不用领域包」）、`计划 · 拆解后等人批准`、`多 agent`、`独立核查`（输入栏勾）、`权限 · 逐次审批`。这些词我当公司策略或 GitHub 评审都认不出来。

新建对话，输入：

> 列一下当前目录顶层文件名，再写一份只有三行的说明到 copilot-note.txt。不要跑命令。

Run `2CC271`。中间栏只有 `等待模型响应… / Thinking...`。没有可改的计划卡，没有 PR draft，没有 Files changed。`copilot-note.txt` 当时没落到磁盘上。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 「领域包 / 计划 / 多 agent / 独立核查 / 评分表」摊在一件列目录的小事旁边。 | 一句话说要什么，附上仓库；出口是 PR，不是再学一套编排词。 |
| **不实用** | 勾了「计划」才会「拆解后等人批准」——我没勾，它也不会先出一份给人改的 PR 计划。空转 Thinking 也不出评审面。 | 稍长的改动先开 PR，人在 GitHub 上改描述再让 bot 继续。 |

---

## 5. 过程中途（停止 / 历史 / 刷新）

`2CC271` 还在 Thinking 时点「停止」，按钮先变成「正在停止…」。随后原文：

> 已停止 · 这次运行由你主动停止；已完成的工具调用与写入不会回滚。

输入钮变成「继续对话」。`copilot-note.txt` 仍然不在磁盘上。

刷新同一条 `#/run/2cc271c2-1174-45a3-ae8a-390578771764/loop`，停止说明还在。侧栏点 `hello-copilot` 的 recap（「已写入 `hello-copilot.txt`…」）回到 `#/run/94d88cd6-…/loop`，产物还在。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 运行中有「停止」，点下去会停；刷新和侧栏能找回上次 hello 与停止说明。 | 中途能打断；回来还能看到上次结果。 |
| **不习惯** | 停完是「继续对话」，不是「在这个 PR 上再推一commit」。历史按对话标题分组，不是 issue / PR 列表。 | 云端 agent 挂在 issue 上，回来收 PR；刷新 github.com 还在。 |
| **不实用** | 停下来没有可给同事的评审链接，只有 `FATHOM · RUN 2CC271`。 | 工作单元是 PR 号，能丢到公司群里。 |

---

## 6. 换地方

还停在 hello 那条 run 上时，工作目录控件是 `scope-field--locked`，`<select>` `disabled`，换不了目录。先点「新建对话」才解锁。

点开工作目录菜单，原文：

> 勾选的目录本次都可以读写。设为主只换默认写入点，不会把旧主目录自动勾回。

把 `D:\Work\Github_pros\Agent_Design` 点「设为主」。触发器变成 `D:\Work\Github…\Agent_Design`，占位变成「要「Agent_Design」做什么…」。侧栏仍按文件夹分组：`Agent_Design` / `ui-qa`（hello-copilot 还在 ui-qa 底下）。项目控件仍是「未入项（按目录）」+「网盘管理」+「＋ 新建项目…」。

底栏「记忆」打开后是：

> 记忆 / D:\Work\Github_pros\Agent_Design\\.agent-memory / 本项目 / 全部 / deploy-ports.md / design-mode-benchmarks.md / …

本地 markdown 笔记，不是 GitHub 仓库、不是 issue 模板，也没有「把这次改动留给下一个 PR」。首页此时搜不到 GitHub。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 换主目录后占位跟着仓库文件夹名走；旧目录的对话还在分组里，能点回去。 | 换一个项目不会把上次结果弄丢。 |
| **不习惯** | 换的是本机文件夹「设为主」，不是切换 GitHub 仓库 / 组织。进行中的对话还把目录锁死。 | 公司账号下换 repo，issue 还挂在原来的仓库。 |
| **不实用** | 「记忆」是 `.agent-memory` 一堆 md；「项目」是「未入项（按目录）」。没有 PR 可指给下一次。 | 下次从同一条 issue / PR 续，而不是翻本地记忆文件。 |

---

## 伸手对照（GitHub / PR / 公司账号 / 不要新 OS / 评审不是聊天稿）

| 伸手要什么 | 屏幕上实际有什么 |
|---|---|
| 公司账号 / 租户 / SSO | 没有登录。设置里是自己贴 `API Key` / `环境变量 Key`。 |
| 留在 GitHub / issue→PR | 首页没有 PR 列表。GitHub 只在设置 → MCP：「仓库、议题与拉取请求」，要 `GITHUB_PERSONAL_ACCESS_TOKEN`，且写着「MCP 未连接（需 AGENT_UI_MCP=1）」。 |
| 少换壳，不要新操作系统 | 第一眼是 `FATHOM 控制台` 整页台子（新建对话 / 领域包 / 写入圈）。不是 IDE 插件，也不是 github.com。 |
| 评审不是聊天稿倾倒 | 小事交出 `Thought Process` +「已创建…」叙述。批准卡是 `write_file` JSON。变更栏写过「本次运行没有写盘操作」。没有 Files changed / comment。 |

**活 UI：是。** 路径：`eval/persona-ux/walks/copilot.md`
