# design 模板（OpenDesign 路线）

Agent 用真实 HTML/CSS 做设计交付；宿主整站预览 + 点评 + 翻页。

| 目录 | 用途 |
|---|---|
| `deck-basic/` | 多页幻灯：`section.slide[data-slide]` |
| `landing-basic/` | 单页落地 |
| `DESIGN.md.example` | 可选品牌契约，复制到任务 workdir 根改名为 `DESIGN.md` |

## 契约摘要

1. 入口必须是可预览的 HTML（相对 CSS/JS，禁外链 CDN）。
2. 幻灯页用 `.slide[data-slide="…"]`。
3. 创作源是 HTML；需要 PPTX 时后导出，不要假装内置 Office。

包：`AGENT_PACK=design`（或 Web UI 选 `design`）。
