# Web 主界面 UX 第二批（persona-ux web2-app）

日期：2026-09-14  
范围：`ui/public/app.js`、`index.html`、`styles.css`、`features/workdir-picker.js`、`features/workspace-git.js`、`features/settings.js`（onboarding 未改）、对应 `test/ui-*.test.ts`。  
未 commit / 未 push。未改 `ui/server.ts`、`src/cli.ts`、`cross-app/**`、`artifacts.js`、`command-center.js`。未碰 git 暂存区。

## 每条

| 条 | 状态 | 可见变化 | 文件 | 测试 |
|---|---|---|---|---|
| **#13** | 已改 | 计划确认门每条子任务标题和短说明可改。批准时 POST `/plan-approval` 带 `edits: [{id,title,description}]`。服务端目前只认 `decision`，改过的字会带上但执行面还按原计划跑（不翻 planner / 不改 server）。没有确认门的 run 不硬造一门。 | `app.js`（`patchPlanGate` / `renderPlanNode` / `collectPlanGateEdits`）、`index.html`（`postPlanDecision`） | `test/ui-patch.test.ts`「计划卡每条短句可改」 |
| **#16** | 已改（较小那档） | `@` `#` `/` `$` 不再打开旧对话 picker。没有文件补全就不弹。明确按钮「引用会话」仍可点出名会话。空态写「用附件或工作目录，这里没有 @ 文件补全。」命令板仍是 Ctrl+K。 | `app.js`（`composerCiteTrigger` 恒 null）、`index.html`（`#cite-session-btn`）、空态文案 | `test/ui-app.test.ts`「不吃 @ # / $」；`test/ui-patch.test.ts` cite-session-btn |
| **#18** | 已改 | 目录菜单两行人话：点名=下次写入这里，勾选=这次也可以读写。按钮「正在写入 / 改到这里」，不再并排「勾选 vs 设为主」。触发器仍用主目录短名。占位保持「说要做什么…」（与 #9 一致，避免再写成「要「Agent_Design」做什么」）。 | `features/workdir-picker.js` | `test/ui-workdir-picker.test.ts` 菜单提示 |
| **#19** | 已改 | 「全部项目」默认勾上并记住。换项目不再把侧栏收成「尚无运行」。2xx 已进内存的发送会带上 `workdir` / `projectId`，失败收尾仍挂在边上。409 没进内存的不造草稿。 | `index.html`（`#sidebar-all-projects checked`、乐观 `runs.unshift`） | `test/ui-app.test.ts` / `test/ui-patch.test.ts` 默认 checked + submittedWorkdir |
| **#22** | 已改 | 工作单元 git 菜单：没连 GitHub MCP 只说「现在只会改这个文件夹」，不给开 PR。仓库在且 MCP `github` 为 `connected` 才给「开 PR」弱链（GitHub compare，不是代开流程）。 | `features/workspace-git.js` | `test/ui-workspace-git.test.ts` `workspaceGitHonesty` |
| **#23** | 已改 | 空态写「现在只能在这个窗口下指令。」全页不出现「微信」。飞书/Slack 卡面写明装了也不会在这个窗口派活；已装再补「写入配方不等于已接通」。 | `app.js` 空态、`features/settings.js` `MCP_MARKET_COPY` | `test/ui-patch.test.ts` empty-window-note；设置卡面仍走原市场锁 |
| **#26** | 已改 | 对话里答文/抓页链接收成「来源 / 该页说的 / 链接」表，可「导出链接列表」。会话引用改叫「引用的会话」，不再独占「引用」。运行设置领域包：`consult · 查资料`，旁注「查资料选 consult」。consult 仍在领域包名单里。 | `app.js`（`deriveChatSources` / `packOptionLabel` / cite 文案）、`index.html` pack 行 | `test/ui-app.test.ts` deriveChatSources；`test/ui-patch.test.ts` 来源表 + 引用的会话 |

## 测了哪些

```
npx vitest run test/ui-patch.test.ts test/ui-app.test.ts test/ui-a11y.test.ts \
  test/ui-workdir-picker.test.ts test/ui-workspace-git.test.ts test/ui-settings.test.ts \
  test/ui-faces.test.ts
```

**结果：7 files / 907 tests 全绿。**

首跑有一条旧锁被出处表带红：`对话里工具组可展开` 原先要求整段对话 `not.toContain("https://a.example")`。工具组仍收起，URL 现在只出现在 `#26` 的来源表。断言改成：答文气泡不含该 URL，`.chat-sources` 含该 URL。

## 诚实缺口

- `#13` 批准 POST 带 `edits`，**未改 `ui/server.ts`**，服务端仍只认 `decision`。界面能改短句，执行面还按原计划跑。要落地得另开 server 一轮。
- `#16` 没有工作区文件补全 API，选了较小档：`@` 不弹 picker。引用旧会话走「引用会话」按钮。
- `#18` 输入占位保持「说要做什么…」（与 `#9` 目录命令口吻锁一致）。触发器短名跟主目录走；勾选 vs 写入点改成两行人话。
- `#19` 409 没进内存的失败发送不造草稿。2xx 乐观行带 `workdir` / `projectId`。
- `#23` 空态不出现「微信」（不当功能）。飞书卡面写明装了也不会在这个窗口派活。
- 未碰 git 暂存区；未改 `artifacts.js` / `command-center.js` / `ui/server.ts` / `src/cli.ts` / `cross-app/**`。
