# OpenClaw / AutoClaw 自托管派 · 走查卡

- **角色：** OpenClaw / AutoClaw 自托管派（家在自己的机器 + Skill 目录 + 微信 / 飞书网关；封闭商店会骂）
- **表面：** CLI 先（`--help` / `doctor`，避免和别人抢同一台宿主）再 Web http://127.0.0.1:4173/ 自开标签（`#walk=openclaw`）
- **日期：** 2026-09-14
- **活 UI：** 是。CLI 在仓库根当场跑过；Web 用本机独立 Chrome（CDP 9230，`http://127.0.0.1:4173/#walk=openclaw`）点过，不共用别人的 Cursor 浏览器标签。
- **习惯伸手：** 找技能、网关、频道、本机目录。会找「自己的 Key」和「本地文件」。第一句可能是「接到我的飞书」而不是「在当前仓库写 hello」。
- **本卡范围：** 统一剧本第 1、4、5、6 步偏交任务 / IM 续跑 / 成品与技能入口；不强迫写仓库。CLI 只做冷启动对照（帮助 + 自检），不加 `--yes` 开跑。

---

## 7. CLI 对照（先做，对应冷启动：技能 / Key / 网关找不找得到）

仓库根 `d:\Work\Github_pros\Agent_Design`。只靠 `npm run agent -- --help`、`npm run doctor` 和当场输出。

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
  --             后续内容一律视为任务文本

Doctor is static: it performs no network request and starts no execution worker.
```

版本：`npm run agent -- --version` → `1.3.0`。

`npm run` 一眼能对上产品入口的名字：`agent` / `cli` / `doctor` / `ui` / `desktop` / `start`。没有 `gateway` / `skill` / `wechat` / `feishu` 这种脚本名。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | `--help` 立刻给出 `run` / `doctor`，不必翻网页。`doctor` 写明「static: no network / no execution worker」，本机自检不会偷偷联网跑任务。 | 冷启动能在自己机器上先看懂怎么开、怎么自检。 |
| **不习惯** | 帮助全文没有 skill / MCP / gateway / 微信 / 飞书 / 频道 / 本机 Skill 目录。入口是一次性 `run "task"`，不是挂在网关上等人派活。 | 第一屏就能指到本地技能目录、接微信/飞书、带自己的 Key。 |
| **不实用** | 默认选项是 `--verify` / `--plan` / `--parallel` / `--auto`（选 pack）。我要的是 24 小时网关，不是拆解核查子任务。 | 帮助先写「挂网关 / 指技能目录 / 填自己的 Key」，编排是进阶。 |

下一步：跑 `doctor`，看自检会不会说出 Key、技能目录、网关。

### 7b. `doctor`（自己的 Key 在不在）

`npm run doctor` 与 `npm run agent -- doctor` 两份原文相同，退出码 0：

```
provider: anthropic (source: default)
model: deepseek-v4-flash (source: .env-or-environment-same-value)
base_url_origin: https://api.deepseek.com (source: .env-or-environment-same-value)
credential_present: yes (source: .env-or-environment-same-value)
```

没有把密钥本体打出来。也没有 skill / MCP / 飞书 / 微信 / 网关一行。

旁边允许看的启动说明（`.env.example`，不是帮助）：有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`、可改 `ANTHROPIC_BASE_URL`、可选 `AGENT_UI_MCP=1`、可选 `AGENT_FEISHU_WEBHOOK=`（「飞书 / 办公出站门禁卡片（只出站）」「自定义机器人 webhook」）。全文搜不到「微信」。全文搜不到「Skill 目录」。仓库根也没有名叫 `skills` / `Skills` 的文件夹。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | `credential_present: yes`，不打印 Key 本体。`.env.example` 让我把 Key 写在自己机器上，还能换 base URL（DeepSeek 兼容端点也算自己的供应商）。 | 能带自己的模型 Key，密钥存在家里，不进云商店。 |
| **不习惯** | doctor 只报 provider / model / origin / 有没有凭据。不问技能目录，不问 MCP，不问网关活没活。 | `doctor` 会列出：本机 Skill 路径、已接频道、MCP、Key 来源。 |
| **不实用** | 飞书只在示例文件里，而且是「只出站」webhook 门禁卡片，不是「接到我的飞书、在 IM 里续跑」。微信零痕迹。 | 网关是入口：微信/飞书进来一条，家里机器接着跑。 |

CLI 冷启动到此。不在命令行交写仓库的任务。下面改走 Web，自开标签，找技能 / MCP / BYOK / IM / 商店。

---

## 1. 冷启动（Web）

自开 `http://127.0.0.1:4173/#walk=openclaw`（本机独立 Chrome，远程调试口 9230）。标签：`FATHOM 控制台`。截屏：`eval/persona-ux/walks/_openclaw-1-cold.png`。

盖着新手卡，原文：

> 初次使用
> 先圈定工作目录
> 工具写入圈是白名单里的全部目录。主目录是这次的焦点；其它已添加的项目也可以直接改，不必绕路。
> 1 / 4
> 跳过 / 下一步

卡后面能看见的字：侧栏 `Work` / `Code` / `新建对话`，一长串别人的仓库任务标题；中区 `AGENT CONSOLE` / `FATHOM.` / `see every run to the bottom.` / `每一层都看得见。`；输入标签 `任务描述`，发送读屏名 `运行任务`，勾选项 `独立核查`；欢迎卡全是仓库：`从计划开始` / `先对齐做法，再动代码` / `看看这个仓库` / `修一处并跑通测试`。工作目录已经指着 `D:\Work\Github_pros\Agent_Design`。模型按钮：`环境变量 · deepseek-v4-flash`。第一屏没有「技能」「网关」「飞书」「微信」「频道」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **不习惯** | 第一眼是「先圈定工作目录 / 工具写入圈」。家被说成仓库白名单，不是家里那台机器上的 Skill 目录。 | 打开先问：技能目录在哪、接到哪条微信/飞书。 |
| **不习惯** | 发送叫「运行任务」，欢迎卡四张全是代码仓库。侧栏全是别人的 hello.txt / 列目录。 | 第一句是「接到我的飞书」，不是「在当前仓库写 hello」。 |
| **不实用** | 冷启动就摆「独立核查」。我要挂网关等人派活，不要先学核查。 | 工程旋钮藏起来，先露出技能和频道。 |
| **好** | 模型写着「环境变量 · deepseek-v4-flash」，Key 看来在本机环境里，不是登录某家云商店。 | 能带自己的 Key，不必先开官方账户。 |

点「跳过」后原文多了一句「已跳过引导」。旋钮还在。底栏能点：`打开指挥中心` / `打开产物` / `打开定时任务` / `记忆` / `打开设置`。

下一步：点「打开设置」，找技能 / MCP / Key / IM。

---

## 1b. 设置页：技能 / MCP / BYOK / IM

点底栏「打开设置」。地址变成 `#/settings`。活字提示「设置已打开」。左侧栏目：`外观` / `模型` / `MCP / Skills` / `领域包` / `运行默认值` / `通知` / `快捷键` / `消耗` / `关于`。截屏：`eval/persona-ux/walks/_openclaw-3-settings.png`、`_openclaw-4-mcp-skills.png`。

### 自己的 Key（BYOK）

「模型」原文：

> 模型库落在服务端工作目录的 `.agent-models.json`。添加、删除或改角色会立刻写盘；重启宿主仍在。
> 留空 = 使用环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY）。Key 只保存在服务端，永不下发浏览器。

能填 Provider（`Anthropic / Claude 兼容` / `OpenAI 兼容（DeepSeek / Kimi / 本地网关）`）、模型名、Base URL、API Key。有「测试连接」「保存到模型库」「同步到 .env」。已有条目写「环境变量 Key」或「已存 Key」，端点能看见 `api.deepseek.com` / `api.moonshot.cn`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 设置里能贴自己的 Key 和 Base URL，写明 Key 不下发浏览器，还能同步到本机 `.env`。本地网关也是一个 Provider 选项。 | 能带自己的模型 Key，密钥存在家里。 |
| **好** | 已装的模型来自环境变量或本机模型库文件，不是登录某家商店账号。 | 家在自己机器上。 |

### MCP / Skills 目录（伸手要技能文件夹，碰到的是商店）

栏目原文：

> MCP / Skills
> 本宿主目录，安装才写入。MCP 需 AGENT_UI_MCP=1。

目录卡片（屏幕上的名字 / 种类 / 一句说明 / 按钮）：

- 飞书 · MCP ·「文档、日历、会话。」· `安装` / `详情`
- Slack · MCP ·「读频道、发消息。」· `安装` / `详情`
- GitHub · MCP ·「仓库、议题与拉取请求。」· `已安装` / `详情`
- 文件系统 · MCP ·「额外的目录访问，不是内置读写的替代。」· `安装` / `详情`
- Notion · MCP ·「连接 Notion 工作区。」· `安装` / `详情`
- Superpowers · Skill ·「技能包，安装后注入后续对话。」· `安装` / `详情`
- ppt-master · Skill ·「可编辑 PPTX 幻灯 skill。」· `安装` / `详情`
- Google Workspace · 缺 ·「本目录没有可装的官方配方。」· `不可装` / `详情`

已安装区：GitHub（已启用，可停用/移除）、stm32（已启用，路径 `D:/Work/MCP_Servers/stm32-gdb-mcp/.venv…`，本机目录）。底下还能贴 `GitHub URL`，种类可选 `MCP` / `Skill`，以及按钮「手动添加服务」。页脚：

> MCP 未连接（需 AGENT_UI_MCP=1）。D:\Work\Github_pros\Agent_Design\mcp.json

仓库根有一份 `mcp.json`（stm32 指向本机 python，github 指向 docker 镜像）。没有名叫 `skills` / `Skills` 的文件夹。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 有「MCP / Skills」这一栏，已装的 stm32 指到本机路径。能「手动添加服务」、能贴 GitHub URL。 | 技能是本地文件，能改能加。 |
| **不习惯** | 第一眼是一张官方配方目录：安装 / 不可装。Superpowers / ppt-master 要「安装后注入后续对话」，不是让我指一个家里的 Skill 文件夹。 | 打开就能指到本地 Skill 目录，文件在自己仓库里。 |
| **不实用** | Google Workspace 写「本目录没有可装的官方配方 / 不可装」。缺官方配方就不能装——这就是封闭商店。 | 没有官方配方也能自己加本地技能，商店只是可选目录。 |
| **不实用** | 飞书在目录里，但说明是「文档、日历、会话」，按钮是「安装」MCP。不是「接到我的飞书、在 IM 里派活」。微信一张卡都没有。页脚还说 MCP 没连上，要 `AGENT_UI_MCP=1`。 | 微信 / 飞书是网关入口，24 小时挂着等人派活。 |

「通知」只有系统通知授权和侧栏铃铛，没有飞书/微信频道。「领域包」要签字安装，文件包目录 `.agent-packs`，草稿「不能选用」——又一套安装仪式，不是 Skill 目录。

点开飞书卡片的「详情」（是 `<summary>`，不是按钮）。原文：

> 飞书官方 OpenAPI MCP（文档、日历、会话等）。不是出站 IM 卡片。
> 官方仓库 larksuite/lark-openapi-mcp。需要飞书应用 APP_ID / APP_SECRET（只写变量名，不填密钥）。出站 webhook（AGENT_FEISHU_WEBHOOK）是另一条 IM 卡片切片，装这条不会配置 webhook。

Superpowers「详情」：

> obra/superpowers 是 skill/plugin，不是 stdio MCP，也不是 DomainPack。
> 安装写入 `.agent-skills/superpowers/SKILL.md`（钉死 using-superpowers），启用后注入本 run 的执行者 system prompt。

ppt-master 同类：安装写入 `.agent-skills/ppt-master/SKILL.md`。Google Workspace「详情」：

> Gmail / Calendar / Drive 不在本目录。没有可引用的官方 stdio MCP 配方。
> 不收录未经核实的 Workspace / AWS 官方插件，也不会从 Cursor Marketplace 搬运。请粘贴可信 GitHub URL，并说清是 mcp 还是 skill。

整页搜「微信」：没有。点「手动添加服务」后同一栏多出：`名称` / `命令` / `参数` / `添加 / 更新`。旁边还能贴 GitHub URL，种类 `MCP` / `Skill`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 飞书详情自己写「不是出站 IM 卡片」。手动添加是本机命令行，stm32 已指向家里的路径。Google 缺配方时让我贴 GitHub URL，而不是只能买官方包。 | 能加本地工具，不被一家商店锁死。 |
| **不习惯** | Skill 的家被写成「安装写入 `.agent-skills/…/SKILL.md`」。我要指自己仓库里的技能文件夹，不是从目录装一份钉死的 SKILL.md。 | 技能目录就是我家，能改能加，不必「安装」。 |
| **不实用** | 飞书要 APP_ID / APP_SECRET，装上是文档日历会话 API。微信零入口。出站 webhook 是另一条「IM 卡片切片」，还声明装 MCP 不会配 webhook。 | 接到我已经在用的飞书/微信，人在 IM 里下指令。 |

---

## 4. 稍长一点：定时任务像不像 24 小时网关

点底栏「打开定时任务」。活字：「定时任务已打开」。面板原文：`返回` / `定时任务` / `新任务`。列表里是别人的 `T5-draft-disabled`（「T5 草稿，禁止触发」），状态「已停用」，我没点启用/立即运行。

点「新任务」后表单字段：`名称` / `任务描述` / `工作目录` / `调度类型`（一次性 / 每天 / 每周 / 每隔几小时） / `独立核查` / `创建` / `取消`。没有频道、没有飞书、没有微信、没有「网关」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 本机有一份会自己醒的任务表，刷新网页不是唯一真相。 | 长任务在自己进程里活着。 |
| **不习惯** | 调度是闹钟（每天/每周），不是 IM 进来一条就跑。 | 网关挂着等人派活，不是 cron。 |
| **不实用** | 新建定时任务还要选工作目录、勾独立核查。这是给仓库定时跑，不是给微信值班。 | 第一入口是频道，不是工作目录。 |

---

## 1c. Work 脸（成品有，网关没有）

点侧栏 `Work`。欢迎卡换成：`多页幻灯`（封面主张，可导出 PPTX）/ `社媒方图`（三张 1080，可发朋友圈）/ `单页落地`（一页介绍，浏览器里预览）/ `更多稿件`（原型、看板、邮件和其他样子）。截屏：`eval/persona-ux/walks/_openclaw-9-work.png`。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | Work 脸上能看出「交成品」：PPTX、预览、朋友圈图。底栏还有「打开产物」。 | 交出来的是文件或页面，不是一段聊天稿。 |
| **不习惯** | 默认仍是 Code 脸。Work 也没有「接到飞书 / 微信」。 | 第一脸就是频道和技能，不是代码仓库。 |

---

## 2. 一句话小事：接到我的飞书（不写仓库）

仍在 Work 脸时，新建对话，关掉「独立核查」，输入：

> 接到我的飞书。不要写任何文件，不要跑命令。只告诉我现在能不能从飞书或微信收指令、在聊天里续跑。

点「运行任务」。屏幕原文：

> 提交失败（HTTP 409）：这是关于飞书/微信接入与聊天续跑能力的通用询问，不属于任何领域包的专用工具或交付物范畴，应直接回答而不调用领域包。

当时「运行设置」里领域包是「不用领域包」，「自动匹配」没勾。Work 脸自己把一句网关问话卡死。

改点 `Code` 脸，同一句再交。地址变成 `#/run/8ed1b61f-f0b7-45bc-80e5-29283e86e3eb/loop`，有「停止」。过程先 `glob *`，再给出正文（截屏 `_openclaw-10-submit.png`）：

> 现在收不到 —— 两个都不行。
> 我这一侧没有任何飞书/Lark 工具可用……飞书确实在可选目录里（feishu-lark），但需要你先确认、我再执行安装；而且 Web 端还要 AGENT_UI_MCP=1 才会真正挂载。
> 可选目录里没有微信相关条目……这条不是「没配好」，是根本没有接入路径。
> 眼下你只能通过当前这个对话窗口给我下指令，飞书/微信的指令我一条都收不到。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | Code 脸上问出口之后，回答按字面承认：微信没入口，飞书要先装目录项 + `AGENT_UI_MCP=1`，现在只能在这个网页下指令。没假装已经接到 IM。 | 缺了会觉得坏了的东西，软件自己认。 |
| **不习惯** | Work 脸同一句 HTTP 409，还用「领域包」教训我。第一句「接到我的飞书」要先换脸。 | 交任务就是打一句人话，不管在哪一张脸。 |
| **不实用** | 我说不要跑命令，它仍 `glob *`。答案把飞书说成「可选目录里的安装项」，不是网关。 | 第一句就接到频道，不用逛商店、不用 glob 仓库。 |

---

## 5. 过程中途（停止 / 历史 / 刷新）

这次问话很快结束，发送钮变成「继续对话」/「追加指令」。刷新同一条 `#/run/8ed1b61f-…/loop`：正文「现在收不到」还在，侧栏仍能搜到「接到我的飞书」。截屏：`eval/persona-ux/walks/_openclaw-11-refresh.png`。

点底栏「记忆」：`记忆——Agent 在跨会话工作中积累的内容会出现在这里`（当时是空的）。不是 Skill 目录。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 刷新后答案还在；有「继续对话」。网页不是唯一真相，这次问话落在本机 run 上。 | 刷新不该把家里那次派活弄丢。 |
| **不习惯** | 「继续对话」还在这个浏览器里。没有「去飞书接着说」。记忆面板也不指向技能文件夹。 | IM 续跑是换一个聊天窗口还能接着。 |

---

## 6. 换地方

工作目录列表里能看见 `Agent_Design` / `ui-qa` / `chat` / `py` 等别人的盘符。这次回答自己写它跑在 `D:\Work\scratch\agent-design-local-20260908\ui-qa`。侧栏按目录分组，换「新建对话」后旧的「接到我的飞书」还留在列表里。没有「指到我的 Skill 目录当家」的入口；设置里的技能家是「安装写入 `.agent-skills/`」。

| 判定 | 证据 | 我本来以为会…… |
|---|---|---|
| **好** | 换目录、新建对话，旧 run 还在分组里。 | 换地方不会把上次结果弄丢。 |
| **不习惯** | 换的是仓库工作目录，不是技能文件夹或频道。家跟着盘符走。 | 家在 Skill 目录和网关，不在「要这个目录做什么」。 |

---

## 伸手对照（技能 / MCP / BYOK / IM / 商店）

| 伸手要什么 | 屏幕上实际有什么 |
|---|---|
| 本地 Skill 目录 | 设置「MCP / Skills」是一张安装目录。Skill 安装写入 `.agent-skills/…/SKILL.md`。仓库根没有 `skills/`。CLI `--help` / `doctor` 都不提技能。 |
| 微信 / 飞书网关 | 飞书是目录里的 OpenAPI MCP，「不是出站 IM 卡片」。微信整页没有。`.env.example` 只有出站 `AGENT_FEISHU_WEBHOOK`。定时任务是 cron，不是频道。 |
| 自己的 Key | **有。** 设置「模型」可填 Key / Base URL / 本地网关；`doctor` 报 `credential_present: yes` 且不打印本体。 |
| MCP | **有入口。** `mcp.json`、手动添加（名称/命令/参数）、已装 stm32 指本机路径。页脚：`MCP 未连接（需 AGENT_UI_MCP=1）`。 |
| 封闭商店 | Google Workspace「本目录没有可装的官方配方 / 不可装」。Skill 要「安装」。Work 脸问网关会 HTTP 409（领域包）。飞书也要先「确认安装」。 |

**活 UI：是。** 路径：`eval/persona-ux/walks/openclaw.md`
