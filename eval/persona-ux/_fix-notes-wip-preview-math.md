# WIP 预览 / 公式 / 全局搜索收口

日期：2026-09-15  
范围：KaTeX 对话+HTML 预览、Office 页内翻页、侧栏搜索框内 Enter 提示。未 commit / 未 push / 未 `git add -A`。未切分支。未改 schedules / app.js / planner / task-completion / `ui/serve.ts`。未 vendor 整份 KaTeX（仍走已有 `node_modules/katex` + `/vendor/katex/*` + `globalThis.katex`）。

## 改了什么

- `ui/public/core/math.js`（入库）：成对 `\\(` / `\\[` 剥一层；`$` / `$$` / `\(` / `\[` 抽出；`$100` / `C:\Users` 不动。KaTeX `trust:false`。`htmlHasTexDelimiters` 也认成对 `$…$`，避免只有美元公式的稿不注入。
- `ui/public/core/katex-preview-runtime.js`（入库）：iframe 里 unescape + auto-render；导出 `bootKatexPreviewRuntime`。
- `ui/public/core/markdown.js`：围栏外反转义 → 行内先 hold 公式再粗体/斜体 → restore 走 `renderTexHtml`；块级 `$$` / `\[` 单独成 `.md-math-block`。
- `ui/public/features/file-preview.js`：pptx/docx 把取件 URL 改写成 `/api/office-preview`（抄 workdir），渲染仍复用 `renderPreviewBody`。不是 Microsoft 就地编辑。
- `ui/public/features/global-search.js`：`#global-search-trigger` 嵌进 `.run-search-field`，脸上只留 `Enter`；错误走 `humanizeHttpFailure`，网络失败写成「网络断了，搜索没做成」。
- 测试：`test/ui-math.test.ts`、`test/ooxml-preview.test.ts`、`test/ui-office-preview-endpoint.test.ts` 补齐；file-preview / global-search 锁 URL、workdir、docx、人话错误。

## 怎么预览

- 对话气泡：`\\(E=mc^2\\)` / `$E=mc^2$` / 跨行 `\[ \]` 应长出 `.katex`，不再铺裸反斜杠。
- HTML 产物：稿面有 TeX 且没自带渲染器时，响应里叠本机 `/vendor/katex/*` + runtime。
- `.pptx` / `.docx`：右侧坞翻页看文本+嵌入图；顶条文案是「预览 + 点评 + 对话改稿」。xlsx 400；加密/坏文件 422；逃出 workdir 403。
- 侧栏搜索框右侧是紧凑 Enter 提示（点按 ≡ 回车），不另开第三套搜索。失败行内提示，不写 `HTTP 500`。

## 测了什么

```
npx vitest run test/ui-math.test.ts test/ui-file-preview.test.ts \
  test/ui-global-search.test.ts test/ooxml-preview.test.ts \
  test/ui-office-preview-endpoint.test.ts test/markdown.test.ts
```

**6 files / 124 passed**（含既有 markdown 回归，确认 `$` 抽取没打穿转义纪律）。

## 没做

- 未改 `ui/server.ts` / `src/ooxml-preview.ts` / `artifact-canvas.js` / `review-mode.js` / CSS（端点、拆页、画布翻页、注入钩子、框内定位样式本来就在）。
- 未做成完整 Office IDE：无就地编辑、无宏、不解密、不预览 xlsx。
- 未把 KaTeX 源码拷进仓。
- 未提交、未推送、未碰 `.env`。
