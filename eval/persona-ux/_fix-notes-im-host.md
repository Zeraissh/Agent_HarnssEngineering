# 飞书 / 微信宿主收口

日期：2026-09-15  
范围：完善已有办公 notify，做成飞书入站闭环 + 企业微信群机器人出站。未 commit / 未 push。未改 `ui/server.ts`、`cross-app/**`、review-mode / artifact-canvas / workspace-files / file-tree / github-pr。

## 各自实际能做什么

### 飞书

- **出站（原有，仍在）：** `AGENT_FEISHU_WEBHOOK` 自定义机器人。看板（`project_status`）写入/清除时推文本卡片。真实宿主读 env；注入 `modelClient` 的测试宿主不读（仪器纪律未动）。
- **入站（本轮补齐）：** 飞书事件订阅回调 `POST /api/im/feishu`。校验 `X-Lark-Signature`（`timestamp + nonce + ENCRYPT_KEY + raw body` 的 SHA256）。通过后把文本消息变成一次 run（注入 `startRun`；真实 launcher 再 POST 本机 `/api/runs`）。run 结束后把结果 POST 回同一条出站 webhook。
- **url_verification** 回 `{ challenge }`。支持 Encrypt Key 整包加密。
- **不假装：** 没配 `AGENT_FEISHU_ENCRYPT_KEY` 入站不启。本机 `127.0.0.1` 飞书云到不了，入站要自己反代/隧道。本仓不帮你注册飞书应用。密钥 / webhook 不进 stdout、不进 `/api/im` 快照。

### 微信

- 仓里原先没有个微 / 公众号 / 企业微信入站半成品。
- **本轮只做企业微信群机器人出站：** `AGENT_WECOM_WEBHOOK`，body 是 `msgtype/text.content`。优先级低于飞书 webhook。
- **`POST /api/im/wecom` 固定 501**，正文写明：个微/公众号需要你们自己的 App 凭证，本仓不伪造；不收个微私聊。

## 要配哪些 env

| 变量 | 作用 |
|---|---|
| `AGENT_FEISHU_WEBHOOK` | 飞书自定义机器人出站 |
| `AGENT_FEISHU_ENCRYPT_KEY` | 飞书入站签名；无此键不启入站 |
| `AGENT_FEISHU_VERIFICATION_TOKEN` | 可选，challenge / header.token 对账 |
| `AGENT_WECOM_WEBHOOK` | 企业微信群机器人出站 |
| `AGENT_NOTIFY_WEBHOOK` | 通用 JSON webhook（飞书、企微都没配时） |

启动行（`ui/serve.ts`）无配置时印「飞书/微信宿主未开」，armed 时只印已开/未开，不印 URL / token。

## 改了什么

- `src/notify.ts`：入站签名 / 解析 / 解密、企微出站体、`attachImInbound`（拦在 UI handler 前，故不走 `ACCESS_TOKEN`）、本机 `startRun`/`waitForRun` 注入口。
- `ui/serve.ts`：挂入站、启动行诚实 hint。
- `src/cli.ts`：env 注释 + 启动 hint。
- `ui/public/app.js`：快照 `kind=wecom` 芯片「企业微信出站已开」（`cross-app/app.js` 未动）。
- `test/notify.test.ts`：签名失败拒、无密钥 503、成功路径注入、challenge、结果回写、企微出站体。
- `test/ui-patch.test.ts`：企微芯片。
- `.env.example` / `README.md`：只补 IM 段。

## 测试

已跑绿：

| 文件 | 结果 |
|---|---|
| `test/notify.test.ts` | 绿（含签名失败 401、无密钥 503、成功注入 `run_injected`、challenge / 密文 challenge、结果回写、企微出站体） |
| `test/ui-patch.test.ts` | 绿（企微芯片「企业微信出站已开」，不带 webhook） |
| `test/skills-install.test.ts` / `test/mcp-catalog.test.ts` | 绿（快照仍不泄 webhook） |

合计上述 4 文件 **364 passed**。未 commit。
