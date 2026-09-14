# 服务端 UX 修复笔记（#1 / #3 / #10）

日期：2026-09-14  
范围：HTTP / 新建 run 默认值。未改 `ui/public/**`、`src/cli.ts`、产品无关文档。未 commit / push。

## 改了哪些文件

- `src/permission-mode.ts` — Web 出厂默认常量
- `src/design-mode.ts` — 「点了模板芯片」判定；R2 只在点了芯片时挡创建
- `ui/api-errors.ts` — 新建（准入失败人话）
- `ui/server.ts` — `POST /api/runs` 不再因设计路由空包 409；`GET /api/harness.defaults`；4xx 正文消毒
- `test/ui-server-ux.test.ts` — 新建
- `test/ui-server.test.ts` — v2-15 非法 pack 文案对齐
- `test/permission-mode.test.ts` / `test/design-mode.test.ts` — 默认值与芯片判定锁

## 409 的证据（不是「只发生在前端 fetch 之前」）

活页 `eval/persona-ux/_verify-live.json`：Work 脸 `POST /api/runs` **HTTP 409**，正文

```json
{"error":"通用文件写入任务，不涉及任何领域包的专用工具或产出格式，直接执行即可。","designRoute":{"kind":"r2",...}}
```

根因在服务端：`mode=design` 且没点 `designId` / `designTemplate` / `designFilePack` 时仍跑设计路由；router 给 `pack=null` 被收成 R2，再用 409 挡发送。`designTab=Prototype`（Work 默认页签）也不算点了芯片。

现行为：没点芯片 → 直接建 run（2xx）。点了芯片仍 R2 → **400**，一句「请先选一个稿件模板，或直接描述要做什么。」

## 默认值叫什么

| 常量 / 字段 | 值 | 含义 |
|---|---|---|
| `WEB_DEFAULT_AUTO_APPROVE` | `false` | 新对话不自动放行写盘 |
| `WEB_DEFAULT_PERMISSION_MODE` | `"manual"` | 先问（ask） |
| `GET /api/harness` → `defaults.autoApprove` | `false` | 设置项「新对话默认自动放行…」应对齐为关 |
| `GET /api/harness` → `defaults.permissionMode` | `"manual"` | 同上 |
| `POST /api/runs` 省略 `autoApprove` | 不自动放行 | 已有行为，现加测试锁 |
| 请求显式 `autoApprove: true` 或 `permissionMode: "auto"` | 仍自动放行 | 用户打开才走这条 |
| CLI `--yes` | 仍 `autoYes: true` | 不读 Web 这两个常量；本路未改 `src/cli.ts` |

## 前端必须遵守的契约（三句）

1. **`error` / `message` 已是人话。** 不要再拼「提交失败（HTTP 409）：…」；状态码只属于 HTTP 头。4xx 正文保证不含 `HTTP`、`领域包`、`Prototype`。
2. **没点稿件芯片就按普通发送。** 不要因 Work 脸 / `mode=design` / 默认页签 Prototype 指望 409；`designTab` 不是芯片。芯片字段只有 `designId`、`designTemplate`、`designFilePack`。
3. **新对话默认先问。** 读 `GET /api/harness.defaults.autoApprove === false`，设置项默认关；未勾选时不要传 `autoApprove: true`。用户显式打开后再传。
