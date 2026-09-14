# Web UX 第四批（persona-ux web4）

日期：2026-09-14  
范围：设计包纪律 + 模板 CSS / 三维 starter、浏览器标签、思考增量接宿主、`@` 浅列过滤。  
未 commit / 未 push。未碰 git add / commit / reset / rebase。未改 CLI。未改 `D:\Work\scratch\**`。`ui/public/app.js` 只本路写。

## 做了哪几条

| 条 | 状态 | 可见变化 |
|---|---|---|
| **A. 三维/稿件假失败遮罩** | 已改 | 设计包硬契约第 12 条：失败遮罩必须 `[hidden]{display:none!important}`（或成功后从 DOM 拿掉），禁止只靠 `hidden` 配 `display:flex`。空白 `index.html`、规格+幻灯入口、十份稿件 `style.css` 都带了这条。新增可拷贝 starter `templates/design/webgl-object/`（目录名不能以数字开头，所以不是 `3d-object`）：`.fallback{display:flex}` + `hidden`，成功则从 DOM 拿掉。整站预览注入（`review-mode.js`）没动。 |
| **B. 浏览器标签** | 已改 | 首页 `<title>` / `<h1>` 是 `FATHOM`，不再写「FATHOM 控制台」。`documentTabTitle` / `applyDocumentTabTitle` 与桌面七路对齐：对话 `FATHOM · 对话`，设置 / 指挥中心 / 产物 / 定时任务 / 消耗同款。`applyHash` 与 `writeHash` 都会改 `document.title` 和 sr-only `h1`。 |
| **C. 思考过程流式** | 已改 | harness 已有 `thinking_delta`（SSE `event: delta` `kind:thinking`），对话里本来就能流。`reduceEvent` 把 `thinking_delta` 与 `text_delta` 一样丢掉，不进时间线。正文 delta 为 0 且本轮已有 `assistant_thinking` 时，直播条写「正在想…」，不再假死在「等待模型响应…」。有 `liveThinking` 时直播条仍让位给对话里的 Thinking。没有造假逐字流。 |
| **D. `@` 按名过滤** | 已改 | 浅列 API 不变。picker 顶上多一个「按文件名过滤」框；`filterWorkspaceFileEntries` 对已列出的一层做包含匹配。`@` 后缀仍走 `q=`。不是整棵 IDE 树。 |

## 文件

- `src/presets.ts` — `HIDDEN_ATTR_FIX_CSS` / `HIDDEN_FALLBACK_DISCIPLINE`，design 包契约第 12 条
- `src/design-mode.ts` — 空白页与入口 HTML 带同一条 CSS
- `templates/design/*/style.css` — 十份稿件模板补 `[hidden]`
- `templates/design/webgl-object/index.html` — 三维 starter
- `ui/design-templates.ts` — `webgl-object` 标题「三维对象」
- `ui/public/app.js` — 标题、reduce 投影、直播条、「正在想…」、`filterWorkspaceFileEntries`
- `ui/public/index.html` — 默认标题、`applyDocumentTabTitle`、picker 过滤框
- `ui/public/styles.css` — `.cite-picker-filter`
- `README.md` — 页标题口径与桌面对齐（不再承诺「控制台」）
- `cross-app/electron/window-title.cjs` — 注释：宿主页已按路由写标题，壳仍挡住旧口号

未改：`src/cli.ts`、git 暂存区、`eval/persona-ux` walks / VERIFY。

## 测了哪些

```
npx vitest run test/design-mode.test.ts test/presets.test.ts \
  test/ui-design-templates.test.ts test/ui-app.test.ts \
  test/ui-patch.test.ts test/review-mode.test.ts \
  cross-app/test/window-title.test.js
# 6 files / 684 passed
```

新增/收紧的锁：

- 设计包 prompt + 空白 HTML + 入口 HTML 含 `[hidden]{display:none!important}`
- `webgl-object` 与 `landing-basic` CSS 含同一条
- `thinking_delta` 不进 RunState（与 `text_delta` 同）
- 本轮已有 `assistant_thinking`、无正文增量 → 直播条「正在想…」
- `documentTabTitle` 七路与桌面对齐，不含「控制台」
- `index.html` 默认 `<title>FATHOM</title>`，并调用 `applyDocumentTabTitle`
- `filterWorkspaceFileEntries("hel")` 只留 `hello.txt`

## 诚实缺口

- `3d-object` 目录名过不了模板 id（必须字母开头），starter 用 `webgl-object`。点「三维对象」芯片仍是 `seed: blank`，不会自动拷这份 starter；要从模板廊选 `webgl-object`，或靠包纪律自己写。
- 思考 **逐字** 仍只在端点真推 `thinking_delta` 时出现。compat 端点若不推增量，只能等 turn 级 `assistant_thinking` 到了，直播条才从「等待模型响应…」改成「正在想…」。
- `@` 仍只浅列一层。过滤框筛的是已经列出的那一页，不是全库搜索。
- 未改 VERIFY / walks：档案仍可能写「FATHOM 控制台」。
