# 飞书入站：公网可达（隧道说明）

日期：2026-09-15  
范围：`src/notify.ts`、`ui/serve.ts`、`src/cli.ts`（同一条启动行）、`.env.example` / `README.md` IM 段、`scripts/im-tunnel.ts`、`test/notify.test.ts`。  
未 commit / 未 push。未改 review-mode、`ui/public/app.js`、`cross-app/**`、git remote。

## 谎话

`POST /api/im/feishu` 签名校验已在，配了 `AGENT_FEISHU_ENCRYPT_KEY` 入站就武装。但飞书云打不到 `127.0.0.1`。启动行原先只写「已开/未开」，操作员不知道回调路径、也不知道必须自己上公网 HTTPS。不假装个微。

## 各自实际能做什么

- **入站仍要签名。** 隧道只是把 HTTPS 映到本机；`X-Lark-Signature` 不关。
- **启动行（入站已武装）：** 印 `回调路径 /api/im/feishu` +「飞书云到不了 127.0.0.1，需要公网 HTTPS」。配了干净的 `AGENT_IM_PUBLIC_BASE`（https、无用户信息、不像出站 webhook）再印拼好的公网回调。未配 / 非法不炸、不印。Encrypt Key / webhook 永不进 banner。
- **`npm run im:tunnel`：** 只打印 cloudflared 命令与飞书「请求网址」，不拉起隧道、不裸开无签名整站。quick tunnel 会暴露整个端口——文案要求 `AGENT_UI_ACCESS_TOKEN`，并写明更好是反代只转发 `POST /api/im/feishu`。
- **个微：** 仍不提供入站。

## 操作员要配什么

| 变量 | 作用 |
|---|---|
| `AGENT_FEISHU_ENCRYPT_KEY` | 入站签名；无此键不启入站 |
| `AGENT_FEISHU_VERIFICATION_TOKEN` | 可选，challenge / header.token 对账 |
| `AGENT_FEISHU_WEBHOOK` | 出站回结果（可选；不配则结果只在本机 UI） |
| `AGENT_IM_PUBLIC_BASE` | 自己的公网 HTTPS 根（隧道/反代）。只用于启动行拼回调 |
| `AGENT_UI_ACCESS_TOKEN` | quick tunnel 会暴露整站时必设（≥32） |

飞书开放平台「请求网址」填：`$AGENT_IM_PUBLIC_BASE/api/im/feishu`。本仓不帮注册应用。

## 启动行会看到什么

无 IM 配置：

```
飞书/微信宿主未开
```

入站已武装、未配 public base：

```
飞书入站已开（出站未配，结果只在本机 UI）；回调路径 /api/im/feishu。飞书云到不了 127.0.0.1，需要公网 HTTPS
```

入站 + 出站 + `AGENT_IM_PUBLIC_BASE=https://im.example.test`：

```
飞书宿主已开（入站收消息 + 出站回结果）；回调路径 /api/im/feishu → https://im.example.test/api/im/feishu。飞书云到不了 127.0.0.1，需要公网 HTTPS
```

## 测试

```
npx vitest run test/notify.test.ts
```

锁：未配 public base 不炸；armed 文案含 `/api/im/feishu`；密钥 / webhook 不进 banner；误把 webhook 当 public base 被拒；隧道说明只打印命令且仍写签名。
