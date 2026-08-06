# 真实任务案例 #7 — Web 宿主 UI × 委托方整改报告闭环（2026-08-05 ~ 08-06）

**任务**：harness 给自己盖房子——把 CLI 宿主升级为浏览器实时控制台（任务提交 /
事件流直播 / 审批应答 / 三值裁决呈现）。自托管（agent 在 harness 自己的仓库里
开发，s1/s2 期间 `src/**` 禁改的纪律约束），执行者/核查者均 deepseek-v4-pro。
本案催生第四个领域包 ts-coding，并成为 rubric-verifier 的生产首秀。

**全案跨度**：建设两阶段（s1/s2）→ 委托方出具正式整改报告 → 按报告整改五轮
（s3a~s3e）→ 依赖安全收尾。单测 146 → **225**。

## 一、建设期（s1 + s2，均零返工）

| 阶段 | 交付物 | 轮数 |
|---|---|---|
| s1 后端事件桥 | `ui/server.ts`（纯 Node 内置，零新依赖）：SSE 重放+直播、审批回调挂起到 HTTP、verdict 合成事件 + 六场景契约测试 | 21 |
| s2 前端 + 集成修正 | 零构建原生 ES modules：纯 reducer 与 DOM 渲染分离、时间线/核查面板/审批卡/三值裁决卡 + 委托方审出的三处集成缺口修正 | — |

**浏览器全栈实测**（flash 真跑）：UI 提交任务 → 时间线直播 → 浏览器点击放行
`write_file` 审批（回调跨 HTTP 挂起/应答链路实证）→ verifier 现场演示诚实降级
（bash 被只读门拒 ×2 → 改 `read_file` 取证 → passed=true 且"字节数/换行细节缺
工具无法独立验证"如实落 `unverified`）→ 三值裁决卡渲染。
**harness 的 UI 直播了 harness 核查自己的过程。**

**rubric-verifier 生产首秀**（`AGENT_VERIFY_RUBRIC` 首用）：s2 注入四维评分表，
verifier 产出四条 ◈ advisory，每条"维度 | 结论 | 依据"带具体证据（色值对照 CLI
语义、折叠阈值、BEM 命名核对）——**主观意见与客观裁决在同一份裁决里各行其道**：
advisory 不触发返工，passed 只由客观项决定。

## 二、整改期（委托方报告 → s3a~s3e）

委托方基于实际界面审计出具正式整改报告（P0/P1/P2 分级、R-01~R-08 问题项、
AC-01~AC-10 验收标准、同类产品对照、文案整改表）。报告已固化进仓库
[`ui/remediation-v1.md`](../../ui/remediation-v1.md) 作为**验收基线**——每轮任务书
要求 agent 先通读它，验收标准直接引用委托方的编号，不做二次转译。逐条关闭状态见
[`ui/remediation-status.md`](../../ui/remediation-status.md)。

| 轮次 | 内容 | commit |
|---|---|---|
| s3a | P0：审批状态机（幂等 409 + 三态）、390px 单栏、第 12 节文案 | `4156a57` |
| s3b | P1/P2：结果优先四层结构、日志摘要卡分层、对比度、洋红收敛、令牌统一 | `b1f7dfa` |
| s3c | AC-10 六类流程回归（审批拒绝/执行失败/核查未通过） | `e0dae78` |
| s3d | 无障碍专项实测：修孤儿 `role=option`、tab 三件套、APG 键盘模式 | `a1b548e` |
| s3e | axe-core 常驻门禁（委托方拍板引入 devDep） | `7a5ffdf` |

**结果：R-01~R-08 与 AC-01~AC-10 全部关闭**，发布门槛项仅余"监控基线"（属上线后
运营项）。剩余非阻断建议：NVDA 真实听感人工过一遍。

## 三、结构性发现

1. **委托方审查与程序化门禁互补**：s1 全绿后，委托方代码审查仍抓出三处集成级
   缺口（缺省模型硬编码 / compat 写死 / verifier 审批双响风险）——门禁验证
   "做对了写的"，审查发现"没写的"。
2. **回调跨进程挂起是事件桥的核心难点**：`approval_request` 的 respond 回调必须
   在服务端存活到浏览器应答；verifier 来源的审批已内部自答，再入挂起表即双响
   ——事件流的"来源"字段承担了语义隔离职责。
3. **可测性结构约束是前端质量的地板**：任务书强制 reducer（纯函数）与 DOM 渲染
   分离，使 UI 逻辑获得与后端同级的 vitest 覆盖——"零构建 + 可测"互相成就。
4. **ts-coding 包一次到位**：python-coding 的缺口清单（白名单/工具面成文）直接
   移植，TS 域首战零核查饥饿零返工——**领域包的边际成本在快速下降**。
5. **P0 状态机有"另一半"**：完成路径验过不等于失败路径也对。s3c 补 AC-10 时才
   发现 `stopReason=error` 结束时 pending 审批同样必须转 expired——异常流程回归
   不是补充，是同一条不变量的另一侧。
6. **静态断言只能守护"写了什么"**：s3d 的两处 ARIA 缺陷（孤儿 `role=option`、
   tab 三件套不全）在真实 DOM 上才暴露——手写断言查了"`role=option` 在不在"
   （在，绿），真 bug 是**缺父容器**。与案例 #5 的"落盘矩阵实验"同族：
   **声明层绿 ≠ 运行时对**。
7. **只加一半的无障碍改动比不改更糟**：s3d 引入 APG roving tabindex（未选中
   `tabindex=-1`）时必须同时实现 ←/→/Home/End 与焦点跟随，否则未选中标签从
   "能 Tab 到"变成"彻底不可达"。测试 32c 专门锁死这对约束。
8. **引入检查工具的价值在"查你想不到要查的"**：axe 上线首跑即抓到两处真缺陷，
   其中一处（空壳 listbox，critical）正是 s3d 手工修复自己引入的。
9. **incomplete 桶不是通过**：只断言 axe `violations` 为空不够——"本环境判定
   不了"的规则落在 `incomplete`，不盯就静默溜过。故建白名单机制，新增即失败。
10. **verifier 的失败日志是 harness 缺陷的富矿**：s3b/s3c 连续两轮 fail-closed
    空转，回放它"在被拒什么"，定位到 `isReadOnlyCommand` 按 `|` 切段不感知引号
    ——`grep -n "a\|b" f` 这类合法只读命令被误判为管道链，verifier 只能退化重试
    烧光轮次。**空转不只是噪声。**

## 四、附带修复的 harness 缺陷（本案催生，非报告范围）

| 缺陷 | 影响 | commit |
|---|---|---|
| `isReadOnlyCommand` 按 `\|` 切段不感知引号 | 合法只读命令被误拒 → verifier 烧光核查轮次 | `e0dae78` |
| 两条 high 依赖漏洞（fast-uri / ip-address，来自 mcp-sdk 树） | SSRF/信任边界绕过 | `0243232` |
| `@anthropic-ai/sdk` 0.90 → 0.115（最后一条 moderate） | audit 归零；跨大版本零代码改动 | `7c8ae75` |
| L0 请求构造契约零测试覆盖 | 220 测试全用 FakeModelClient，wire 层改动可全绿却在真机炸 | `3013eb3` |

SDK 升级窗口的验证纪律（已入交接记忆）：单测不碰真实 wire，故必须跑三条真机
冒烟——Anthropic wire+compat / OpenAI wire / verifier 三值裁决，MCP SDK 变动另加
活连通冒烟。**未覆盖项诚实声明**：原生 Anthropic 非 compat 路径（真实发送
`thinking: adaptive` + `output_config.effort`）本机无 key 无法验证，仅类型层确认。

## 五、状态

UI 可用 `createUiServer({ workdir, packName, modelClient })` 起在任意端口。
225 单测 + tsc 全绿，`npm audit` **total 0**。整改报告全部关闭，等委托方最终验收。
