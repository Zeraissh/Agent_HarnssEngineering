# design 模板（OpenDesign 路线）

Agent 用真实 HTML/CSS 做设计交付；宿主整站预览 + 点评 + 翻页。

| 目录 | 用途 |
|---|---|
| `deck-basic/` | 多页幻灯：`section.slide[data-slide]`；色板 `html[data-look]` 五选一 |
| `landing-basic/` | 单页落地 |
| `social-basic/` | 社媒/海报方图：`article.card[data-card][data-size]` |
| `pm-spec/` | 产品规格：目录锚点 + 决策日志 |
| `team-okrs/` | 团队 OKR 记分卡 |
| `DESIGN.md.example` | 可选品牌契约。需要时自己复制到任务 workdir 根并改名为 `DESIGN.md`；宿主不会自动写入，画布也不展示色板 |

## 宿主一键拷贝

开会话空态选模板（不在产物画布顶条）。提交新 run 后宿主 `POST /api/runs/:id/seed-template` 只拷 HTML 模板进 workdir（默认同名目录），**不**再顺带写 `DESIGN.md`。导出用画布「导出」菜单（ZIP；多页幻灯可导出 PowerPoint；方图可导出 PNG，由宿主截 `[data-card]`；已写出的 .pptx/.pdf 可下载；多页幻灯才出打印/另存 PDF）。

## 契约摘要

1. 入口必须是可预览的 HTML（相对 CSS/JS，禁外链 CDN）。
2. 幻灯页用 `.slide[data-slide="…"]`。
3. 创作源仍是 HTML（预览入口必须存在）。多页幻灯的 PowerPoint 由宿主从 `.slide[data-slide]` 派生（画布「导出 PowerPoint」）；`write_pptx` 仍可供手写简单页。多页幻灯仍可用「打印 / 另存 PDF」。

推荐入口：设计模式（CLI `AGENT_MODE=design`，或 Web UI 空态「设计模式」）。`AGENT_PACK=design`（或 Web UI 选包下拉里的 `design`）仍可用。
