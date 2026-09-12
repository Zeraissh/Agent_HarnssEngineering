# 11 · design 模式外部对标汇总（扩展版）

- 状态：汇总稿（仅消费本地产物，不重新抓取、不重新推导）
- 日期：2026-09-11
- 输入产物：
  - `_research/design-ext/s1-ai-native-builders.md`（下称 s1：v0 / Lovable / Framer AI / Google Stitch）
  - `_research/design-ext/s2-design-tools-ai.md`（下称 s2：Figma / Canva / Microsoft Designer / Gamma）
  - `docs/10-design-mode-evolution.md`（下称 10 号文档：Kimi 设计模式 / Claude Design / R1-R3 路由规则）
- 口径：上游标「未核实」的字段原样保留为「未核实」，不做补全；矩阵各行结论可回三份产物逐条核对。
- 注：10 号 R3 已改（不再写「PPTX 需后导出」）；本文是对标当时摘录，调研矩阵事实不改。

---

## 一、对标形态矩阵（10 款产品）

| 产品 | 模式入口形态 | 制品类型清单 | 导出/交接形态 | 来源 |
|---|---|---|---|---|
| Kimi 设计模式 | 首页统一会话输入框 + 侧栏平铺模式入口（PPT/文档/网站/表格/设计等），各入口独立路由（`/design`、`/websites`、`/slides` 等） | 「设计」、可交互真实网站、PPT、文档、表格（以侧栏清单与独立路由显式呈现） | 未核实（10 号文档未载明导出形态） | 10 号文档 |
| Claude Design | 单一 Design 产品入口（Anthropic Labs，research preview）：「Describe what you need and Claude builds a first version」 | 原型、线框/效果图、设计探索、Pitch decks、营销物料（落地页/社媒图）、前沿交互设计；可从代码库读入设计系统 | 导出 Canva / PDF / PPTX / 独立 HTML；可交接 Claude Code | 10 号文档 |
| v0（Vercel） | 首页即统一输入框（"What do you want to create?"）+ 快捷 chip + 模板分类入口（Apps and Games / Landing Pages / Components / Dashboards）；无侧栏模式清单 | working applications（可运行应用）、live websites；模板四类：应用与游戏、落地页、组件、仪表盘；原型/线框稿类制品未核实 | GitHub 仓库同步、Vercel 一键部署、design mode 可视化编辑、模板与设计系统、iOS 端；是否支持 Figma 导入未核实 | s1 |
| Lovable | 首页统一输入框（"Build something Lovable"），输入区下方 Build / Preview 同页分屏（对话构建 + 实时预览） | production-grade software；粒度为 product / app / website / internal tool / prototype 一级，未单列落地页/幻灯等细分类目 | 自家托管发布（hosting/SSL/后端基础设施）；JSON-LD 口径：Sync with GitHub + One-click deploy；Connectors / MCP server / Download apps；Figma 交接未核实 | s1 |
| Framer AI | 画布内嵌 agent 对话（设计画布原生面板，非独立聊天路由）：`/` 技能、`@` 引用、图层上下文、模型选择、图片/文件/URL 引用、分支迭代；起步 chip（portfolio/startup/landing page/blog） | 可编辑网站页面/分区/文案/视觉（非静态图）、响应式整站、CMS 集合与内容、自定义代码组件；场景入口含 Landing pages、Portfolio；移动 App UI、幻灯/文档类制品未核实 | 自家托管发布（Publish/Hosting）、branches/staging 协作、外部 agent/IDE 交接（Claude Code、Cursor、Codex、GitHub PR）、迁移导入（Notion/WordPress/CMS、Figma to HTML）；独立 HTML/代码包导出未核实 | s1 |
| Google Stitch | 提示词 + 图片/线框稿上传 + 交互式对话 + 主题选择器（Google Labs 实验产品，Gemini 2.5 Pro）；产品页为 JS 应用壳，入口细节以 Google 官方开发者博客公告为准 | 移动端与 Web 应用 UI 设计稿（自然语言或图片/线框稿两条生成路径）+ 多变体探索 + 前端代码；落地页/多页站点/幻灯等类目未核实 | Paste to Figma、导出前端代码；托管发布能力未核实 | s1 |
| Figma（Make / AI） | Figma Make 为独立产品路由（figma.com/make/）+ 文件浏览器右上角 Make 新建入口；界面为「AI chat + 可运行 preview」双区；Figma AI 为伞形能力页，其余能力以应用内功能散布（agent/Weave/plugins/MCP 等）；支持 Plan mode、附件、语音输入 | Make：functional prototype / web app（code-backed、可加 backend）；AI 伞下：设计方向与 diagrams、图像/矢量/视频素材、插件、着色器；Make 是否直接产出演示文稿类制品未核实 | 复制预览快照为设计图层回 Figma Design、分享预览、发布为公网站点（专属 URL/自定义域名/Figma Community）、创建 Pull Request 交接代码库、MCP server/connectors；PPTX/PDF 等办公格式导出未核实 | s2 |
| Canva（Magic Design / Canva AI） | 应用内模式 + 首页 AI 搜索栏双入口：编辑器左侧「Design」选项卡，或首页搜索栏选 Canva AI →「Design for me」；Canva AI 2.0 对话式统一入口（抓取当日标 Coming Soon）；「Magic Studio」独立页已 404，品牌收口至 Canva AI | 平面/文档：presentations、posters、cards、flyers、invitations、business cards、postcards、documents；社媒：Instagram/Facebook/Pinterest/YouTube/X 多尺寸；视频：reels/TikTok 等 | 导出 JPG / PNG / PDF / PPTX；生成后回编辑器继续编辑、下载或分发到各平台；生态内交接：Brand Kit、Magic Switch 改尺寸、Content planner 排期发布（Pro） | s2 |
| Microsoft Designer | 独立 Web App（designer.microsoft.com），应用内「Create with AI」/「Edit with AI」选项卡式模式切换 + 模板搜索栏；需个人 M365 账户；首页正文为 JS 应用壳，应用内详细界面文案未核实 | 社媒帖、邀请函、digital postcards、graphics；banners、贺卡、拼贴、相框、brand kits（注意 2025-10-20 起旧编辑器停用、Brand kits 随之下线的公告）、custom images（DALL-E）；另提及 business presentations | 下载到本地（图片）/ 扫码传手机 / 复制粘贴到文件或邮件；云存档 My projects；M365 组件嵌入 Teams、Outlook、Word for the Web、OneNote、PowerPoint；下载的具体文件格式未核实 | s2 |
| Gamma | 首页统一创作入口 + 分制品产品路由混合（Presentations / Websites / Social Media / Documents / API / Graphics）；三种起点：一段想法 / 粘贴大纲 / 导入已有文件；Generate → Shape → Share 三段式 | 演示文稿、托管网站、文档（one-pager 到 white paper）、社媒内容、品牌图形（infographics/illustrations）、API 编程生成 | 导出 PPT / PDF / PNG / Google Slides；发布为网站或社媒帖、链接分享（团队/个人/公开三级）、参与度统计；制品间复用（deck 改季度、one-pager 转社媒素材） | s2 |

矩阵速读（据上表归纳，非新证据）：

- 入口形态三分：统一输入框（v0/Lovable/Stitch/Claude Design）、画布或编辑器内嵌（Framer/Canva/Figma Make 双区）、独立产品路由 + 分制品子入口（Kimi/Figma Make/Designer/Gamma 混合）。Kimi 的「侧栏模式清单」在其余 9 款中未见复现。
- 制品均为可继续编辑的真实产物（可运行应用、可编辑图层、文档/幻灯源文件），无一以静态图为终态。
- 导出分三阵营：代码 + 托管（v0/Lovable/Framer/Figma Make）、办公格式（Claude Design/Canva/Gamma，均含 PPTX）、设计工具交接（Stitch→Figma、Figma Make→设计图层、Designer→M365）。

---

## 二、对 10 号文档三条公开形态提炼的逐条结论

10 号文档从 Kimi/Claude Design 提炼的三条形态（统一模式入口 / 模式内制品类型显式可选 / 真实可预览产出支持迭代导出），现以 s1/s2 八款产品为新增证据逐条核验。

### 提炼 1：统一的「设计」模式入口 —— 新证据支持（需补充分类）

- s1 四款全部收敛为「单一自然语言输入优先」：v0、Lovable 首页即输入框，Stitch 提示词 + 图片输入 + 对话，Framer 把对话原生嵌入画布。
- s2 四款为两类形态：独立产品/应用入口（Figma Make 专属路由、Designer 独立 Web App、Gamma 首页统一创作入口）与应用内模式切换（Canva 编辑器「Design」选项卡 + 首页 AI 栏）。
- 结论：十条证据无一例外存在「统一入口」语义，方向成立。修正点在表述而非方向：「统一」应注明至少两种实现——AI 原生阵营的单一输入框，与设计工具阵营的「独立路由/应用 + 应用内模式入口」并存；Kimi 式侧栏清单仅为其中一种变体，非通行形态。

### 提炼 2：进入模式后制品类型以清单或子入口显式可选 —— 支持，表述需修正

- 支持证据：v0 输入框下方模板分类 chip（Apps/Landing Pages/Components/Dashboards）、Framer 起步 chip、Gamma 导航分制品产品路由、Canva FAQ 显式列举可创作设计类型、Kimi 侧栏平铺制品入口。
- 反向证据：Lovable 未单列细分类型（制品粒度停留在 product/app/website 一级），Stitch 未载明落地页/幻灯等类目（未核实），Figma Make 的类型表达是「functional prototype / web app」能力描述而非选择清单。
- 结论：方向支持，但 10 号文档「显式清单」的表述需放宽——通行做法是轻量呈现（输入框下方 chip、导航子路由、FAQ 列举）而非必经的选择步骤；显式类型呈现多为「辅助起步」，不阻塞直接描述需求。这与 10 号文档路径 A（默认自动路由）+ 路径 B（显式清单备选）的双路径设计恰好同构，属加固而非推翻。

### 提炼 3：产出真实可预览的页面/文件，支持迭代与导出 —— 新证据支持（可加强为「三阵营」）

- 可预览真实产物：v0/Lovable 产出可运行应用并同页预览，Framer 产出画布可编辑图层，Figma Make 为「chat + working preview」双区，Stitch 产出 UI 稿 + 前端代码，Canva/Designer/Gamma 产出可回编辑器继续编辑的制品。
- 迭代：十款全部支持（对话迭代、画布接管、分支、版本历史）。
- 导出/交接：全部具备，且明显分三阵营（代码 + 托管 / 办公格式含 PPTX / 设计工具或办公生态交接），详见第一节矩阵速读。
- 结论：成立且可加强——「支持导出」应显式承认多阵营并存，10 号文档 R3 的「通用 HTML 交付 + 照实说明限制」落在「办公格式」阵营的能力边界上，与外部产品的做法（把 PPTX 导出做成一等能力）存在已知差距，属定位差异而非形态错误。

---

## 三、对制品类型清单、模板注册表与 R1-R3 规则的启示

### 3.1 10 号文档制品类型清单的缺口

10 号文档路径 B 的类型清单为：落地页、多页幻灯、品牌单页/海报、纯文档页、已安装设计类文件包。对照十款产品，缺口如下：

| 外部高频制品类型 | 对标证据 | 10 号清单现状 |
|---|---|---|
| 可交互原型 / Web 应用 | v0/Lovable/Figma Make 的核心制品；Claude Design 的原型与前沿交互 | 缺失（design 包 HTML+CSS 能力可部分承载，建议评估是否新增类型或在落地页类型下注明交互边界） |
| 仪表盘 / 组件 | v0 模板分类 Apps and Games、Dashboards、Components | 缺失 |
| 社媒多尺寸物料 | Canva/Designer/Gamma 的主要制品族（多平台多尺寸变体） | 「品牌单页/海报」部分覆盖，但未表达「一稿多尺寸变体」语义（对照 Canva Magic Switch） |
| 文档页（one-pager/白皮书） | Gamma Documents、Claude Design Pitch decks 之外的文档类 | 已覆盖（纯文档页），外部证据支持保留 |
| 移动端 UI 设计稿 | Stitch 的移动端 UI | 缺失；但超出当前 HTML 沙箱预览定位，可不收录，建议在注册表注明为明确排除项 |
| 演示文稿（PPTX 语义） | Kimi /slides、Claude Design、Canva、Gamma、Figma Slides | 以「多页幻灯（HTML）」覆盖创作侧，PPTX 二进制导出按 R3 口径为能力边界，缺口在导出侧而非类型侧 |

### 3.2 对模板注册表设计的启示

- 注册表条目建议增加「导出/交接形态」字段：外部产品把导出做成类型的一等属性（Gamma 逐制品标注导出格式，Canva 明示 JPG/PNG/PDF/PPTX），10 号注册表目前只映射「类型 → 包 + 模板目录 + 描述」。
- 命名与文案解耦：Canva「Magic Studio」独立页抓取当日已 404、品牌收口至 Canva AI；Microsoft create.microsoft.com 301 至 M365 Copilot 枢纽。外部品牌口径漂移频繁，注册表与 UI 文案应避免绑定外部产品式命名（10 号文档已将「OpenDesign」改「设计模式」，同向）。
- 类型呈现轻量化：按提炼 2 的修正，注册表消费侧以 chip/卡片辅助起步即可，不必做成强制选择步骤；与路径 A/B 设计一致。
- 入口与既有创建流合并有先例：Figma Make「与新建其他文件同一路径」的做法，佐证 10 号 UI 空态模板播种 + 模式入口并列的双轨不冲突。

### 3.3 对 R1-R3 路由规则的启示

- R1（唯一命中直派）：外部产品普遍「直接描述即开工」（v0/Lovable/Gamma 三起点），支持 R1 作为默认路径；「命中后照实说明可改」与 Framer 分支迭代、Gamma「可改」的通行做法同向。
- R2（多命中/低置信回退显式选择）：跨制品描述在外部产品中真实高频（Gamma 一条 prompt 可同时覆盖 deck/website/document；v0 模板分类横跨应用与落地页），R2 的「一条描述命中 ≥2 类型」场景有外部佐证，保留必要。
- R3（能力边界兜底）：外部证据显示 PPTX/PDF 导出是办公阵营一等能力（Claude Design、Canva、Gamma 均含 PPTX），10 号 R3 的「PPTX 需后导出」说明属明确的能力边界声明，方向正确；建议在 R3 文案中补一句外部口径对照（「Canva/Gamma 均原生导出 PPTX」），让委托方知晓差距是定位选择而非遗漏。R3「永不因路由失败阻塞执行」与各家「输入框永远可用」的形态一致，无修正。

---

## 四、未核实项清单（逐条标注来源）

以下各项在上游产物中已标「未核实」，本汇总原样保留，未作补全：

| # | 未核实项 | 来源 |
|---|---|---|
| 1 | Kimi 设计模式的导出/交接形态（10 号文档未载明） | 10 号文档 |
| 2 | 「kimi opendesign」作为产品名（Kimi 官方公开形态为「设计」模式） | 10 号文档 |
| 3 | v0 是否支持 Figma 导入（仅页面 JS 内部 `integrations:figma` 弱证据，可见文案未载明） | s1 |
| 4 | v0 的「原型/线框稿（mockup/wireframe）」类制品 | s1 |
| 5 | Lovable 的 Figma 交接形态 | s1 |
| 6 | Framer 的「导出为独立 HTML/代码包下载」 | s1 |
| 7 | Framer 的「移动端 App UI」「幻灯/文档」类制品 | s1 |
| 8 | Stitch 的落地页/多页站点/幻灯等制品类目 | s1 |
| 9 | Stitch 的托管发布能力 | s1 |
| 10 | Figma Make 是否直接产出演示文稿类制品 | s2 |
| 11 | Figma Make 的 PPTX/PDF 等办公格式导出 | s2 |
| 12 | Microsoft Designer 应用内详细界面文案（首页为 JS 应用壳） | s2 |
| 13 | Microsoft Designer 下载的具体文件格式（PNG/JPG 等两页均未载明） | s2 |
| 14 | Microsoft Designer 与 M365 Copilot Create 枢纽的合并细节 | s2 |

补充说明（非「未核实」项，但属上游已标注的口径偏差，一并留痕）：

- stitch.withgoogle.com 为 JS 应用壳，Stitch 入口/制品/导出字段以 Google 官方开发者博客公告（2025-05-20）为准（来源：s1）。
- vercel.com/solutions/v0 为软 404、blog.google 一篇 Stitch URL 为 404、canva.com/magic-studio/ 为 404、www.microsoft.com 两个 Designer 产品页分别为 404 与反爬拦截页，均未作证据（来源：s1/s2）。
- Microsoft Designer 支持页口径存在时间差：欢迎页载 2025-10-20 起旧编辑器停用、Brand kits 下线，FAQ 页仍保留 Brand kits 说明；以欢迎页停用公告为准（来源：s2）。
