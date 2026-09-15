# 真开 GitHub PR（persona-ux #22）

日期：2026-09-15  
范围：`ui/github-pr.ts`、`ui/server.ts`（只加 PR 路由）、`ui/public/features/github-pr.js`、`ui/public/features/workspace-git.js`（去掉 compare 弱链）、`ui/public/styles.css`（表单）、测试。  
未改：`app.js`、`review-mode.js`、artifact-canvas、`workspace-files.ts`、file-tree、`cross-app/**`、`ui/serve.ts`。  
未 commit / 未 push。

## 谎话

原先工作单元上的「开 PR」是 GitHub compare 链接，或没连 MCP 就装成没有出口。委托方要的是**真开 PR**；开不成要人话失败，不能装成已经开了。

## 怎么开

1. 工作目录必须是 **git 仓库**，且 `origin` 能解析出 `github.com/owner/repo`（远程仍叫旧名 `Agent_HarnssEngineering` 也可以，认的是 URL 里的 owner/repo）。
2. 当前不在默认分支上（默认 head=当前分支，base=origin 默认分支；同一条分支开不了）。
3. 环境里有一把令牌（只认这些名字，**不要写进 mcp.json / 不要打进日志 / 不要画在 UI**）：
   - `GITHUB_TOKEN`
   - `GH_TOKEN`
   - `AGENT_GITHUB_TOKEN`
4. 本机 PATH 上有 `gh`（宿主用 `execFile("gh", args)`，不拼 shell）。
5. 打开 Web 宿主 → 点 composer 上的分支芯片 → 填标题/说明（可空，标题默认当前分支名）→「开到 GitHub」。
6. 成功只返回 `https://github.com/<owner>/<repo>/pull/<n>`，界面给「打开 PR」。

端点：

- `GET /api/workspace/git/pr?workdir=` → `{ ready, error?, code?, head, base, repo }`，不含令牌。
- `POST /api/workspace/git/pr` → `{ url, number, title, base, head, repo }`。仅 loopback。workdir 走白名单。

## 缺什么配置

| 缺什么 | 界面/接口会说 |
|---|---|
| 三把令牌都空 | 「还没配置 GitHub 令牌。在环境里设 GITHUB_TOKEN、GH_TOKEN 或 AGENT_GITHUB_TOKEN 后再开。」 |
| 不是 git 仓库 | 「当前工作目录不是 git 仓库，没法开 PR。」 |
| 没有 GitHub 远程 | 「这个文件夹还没有 GitHub 远程。先加 origin 再开 PR。」 |
| 游离 HEAD | 「现在是游离 HEAD…先切到一个分支。」 |
| 当前就在默认分支 | 「当前就在 main 上，跟目标分支相同…」 |
| 没装 `gh` | 「本机没有 gh。装好 GitHub CLI，或检查 PATH。」 |
| workdir 不在白名单 | 403，跟其它工作区接口同一句。 |
| 非本机 Host | 「开 PR 仅本机（loopback）可用」。 |

MCP 的 `GITHUB_PERSONAL_ACCESS_TOKEN` **不**给这条宿主开 PR 用。GitHub MCP 连没连不再决定有没有按钮。

远程仓库：`Zeraissh/Fathom_Harness`。origin 若仍是旧名，只要 URL 指向这个 GitHub 仓库即可。

## 测试

```
npx vitest run test/github-pr.test.ts test/ui-github-pr.test.ts test/ui-github-pr-api.test.ts test/ui-workspace-git.test.ts
```

- 无令牌 / 非仓库 / 无远程：人话失败，`url` 不出现，不调 `gh`。
- 成功路径**注入 runner**，不真打 GitHub；断言 `file + args[]`，标题里的 `;` 仍是一个参数。
- 攻击面：workdir 白名单、非 loopback 403、响应/错误不含 token。
