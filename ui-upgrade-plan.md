# Agent Harness UI 升级 · 实施方案

> 来源：[ui-upgrade-review](ui-upgrade-review.md)。本文件是执行台账，逐项勾选推进。
> 技术总原则：**保留服务端零依赖、前端零构建**（原生 ES modules），新功能一律做成 `ui/public/features/*.js` 独立模块，由现有控制器按需接线——不做整体重写。

## 工程约束（所有项必须遵守）

1. 不引入框架/打包器/CDN；新代码放 `ui/public/features/`，通过 `<script type="module">` 或动态 import 加载。
2. 视觉：只用设计令牌（`--surface-*` / `--text-*` / `--status-*`），不写死色值；4 主题下都要成立；禁用彩色 emoji，用单色排印符/Phosphor 图标。
3. 安全：markdown/高亮纪律不变（先转义后变换、链接协议白名单、禁原始 HTML）。
4. 服务端新端点挂进 `ui/server.ts` 路由表，遵守 loopback/令牌/圈禁现有纪律。
5. 每项完成后：`npm run typecheck` + 相关 vitest（UI 测试在 `test/ui-*.test.ts`）必须绿；新增逻辑要配测试。
6. 中文 UI 文案，术语与现有一致（"运行/对话/产物/核查"）。

## 实施清单

### P0 工程基础

- [x] **T1 消灭 cross-app 双副本漂移**：cross-app 改为构建/启动期从 `ui/public` 同步；删除手工静态副本；清理 `ui/history-backup.ts` 死代码（确认无引用后）。
- [x] **T2 前端模块化落点**：建立 `ui/public/features/` 目录与加载约定（本项随 T3 一起落地，不单独做）。

### P1 补到行业及格线

- [x] **T3 命令面板（Cmd+K / Ctrl+K）**：模糊搜索——新建对话、切换会话、切换主题、切换工作目录、跳转设置、停止运行；键盘上下选择、Enter 执行、Esc 关闭；独立模块 + 测试。
- [x] **T4 通知中心**：浏览器 Notification API（授权后）+ 应用内"待你处理"聚合条——审批待决、ask_user 待答、计划门待签、运行完成、预算耗尽五类事件；跨会话聚合（不打开该会话也能看到）。
- [x] **T5 记忆面板**：服务端新端点读 `.agent-memory/*.md`（按当前工作目录作用域），侧栏/抽屉展示记忆列表与内容预览；只读起步。
- [x] **T6 全局搜索**：服务端端点搜索 `.agent-run-history/*/transcript.jsonl` 正文（关键词、限量、圈禁在历史根目录内）；侧栏搜索框升级为"标题+正文"两档。
- [x] **T7 设置中心**：独立视图（hash 路由 `#/settings`）——主题、思考强度默认值、审批/自动放行默认策略、通知开关、快捷键一览；localStorage 持久化，与 composer 旋钮同源。
- [x] **T8 变更审查视图（Touched Files）**：从事件流聚合本运行 write/edit_file 触碰的文件清单 + 服务端 `stat`/内容预览；有 git 仓库时给 `git diff` 摘要（无 git 时降级为文件清单+预览）。先做到"改了哪些文件一目了然"。
- [x] **T9 定时任务**：服务端 cron 调度器（最小实现：`AGENT_UI_SCHEDULES` 持久化 JSON + setTimeout 轮询），UI 任务列表页 + 新建入口；跑出的结果进正常 run 历史。

### P2 差异化形态

- [x] **T10 产物画布**：右栏产物卡升级——HTML 内嵌 iframe 预览（sandbox 属性）、图片/表格原生渲染、多产物切换 tab。
- [x] **T11 运行指挥中心**：侧栏顶部"运行中"聚合视图——各 run 进度/预算/待审批数卡片，点击直达干预点。
- [x] **T12 过程/结论双模式**：默认视图收敛为"结论 + 关键步骤摘要"，过程时间流一键展开（用户可记偏好）。

## 执行顺序与依赖

```
T1 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12
（T2 并入 T3；每项独立可交付，前一个绿了下个才开工）
```

## 验收基线

- 每完成一项：`npm run typecheck` ✅、`npm test`（至少 UI 相关）✅、手动起 `npm run ui` 目检 ✅
- 全部完成后：更新 `ui-upgrade-review.md` 的缺口清单状态，补一组 Playwright 截图存档

## 执行结果（2026-09-05 全部完成）

- 12/12 项完成；新增 `ui/public/features/` 9 个特性模块 + `ui/scheduler.ts`；新增服务端端点：`/api/memory`、`/api/memory/:name`、`/api/search`、`/api/runs/:id/changes`、`/api/schedules`（CRUD + 手动触发）
- 新增测试约 290 个全部通过；typecheck 与全量测试的失败数与接手时基线完全一致（11 个类型错误 + 14~16 个测试失败，全部位于 owner 未提交的 WIP 区域——"常驻上下文水位""编排面板""stopReason 分档"等测试先行功能，实现未跟上）
- 每项均有实证：Playwright 截图（`.tmp_search/ui-*.png`）或 curl 契约验证
- 改动未提交 git（工作区另有 owner WIP 批次，留待人工一并审阅）
