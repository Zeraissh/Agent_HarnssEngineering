# 点评就地开 / 三维选不中

日期：2026-09-15  
范围：`ui/public/features/review-mode.js`、`ui/public/features/artifact-canvas.js`、`ui/public/features/review-mode.d.ts`、对应单测。`ui/server.ts` 只改了一行注释（`appendSiteHooks` 行为变了，进程里的旧 import 要重启才吃到）。  
未 commit / 未 push。未 `git add -A`。未改 walks / VERIFY。未 Set-Content -Encoding utf8。

## 活页取证（4173 Listen PID 22440 = `tsx ui/serve.ts`，未 taskkill）

- `GET /api/runs/5e44430a-…/site/foup/index.html`（无 `inspect`）：只有 `agent-hidden-fix` + WebGL 探针，**没有**点评钩子。
- 同 URL `?inspect=1`：才出现 `__agentInspectHooked`，并且**立刻** `data-agent-inspect=1`。
- 父页点「点评」旧代码走 `renderCurrent()` → `siteUrlFor(..., { inspect: true })` → iframe 换 `?inspect=1`。沙箱是 `allow-scripts`、故意没有 `allow-same-origin`，父页读不到 `contentDocument`，所以以前只能靠导航把脚本打进文档。
- FOUP 页（`liquid-demo/foup`）：`#stage` 全屏 canvas；`.atmos` `pointer-events:none`；`.labels .label` **`pointer-events:auto`** 叠在模型上；左右 `.panel` 盖住画面两侧。页内射线 `intersectObjects(pickMesh, false)`，`pickMesh` 是 `material.visible=false` 的隐形槽位盒，壳体 / 门 / 晶圆 / 充电器不在列表里。

## 根因

1. **进点评要刷新**：钩子只在 `?inspect=1` 的 HTML 响应里。按钮把 iframe.src 改掉才能注入。WebGL 上下文、相机、轨道、拆解进度全丢。
2. **三维选不中**：点评钩子只认 `ev.target`（点到 canvas 就是整张画；点到标注/侧栏就是 DOM）。页内自己的拾取又只打隐形盒。标注层先吃点击。没有 mesh 的空 Group 射线打不中（这是形体问题，不是漏绑）。

## 改了什么

- `/site` 每次出 HTML 都注入**休眠**点评 runtime（跟 deck / WebGL 探针同族）。`?inspect=1` 只表示开机即开。
- 父页点「点评」只 `postMessage({ type: "agent-inspect-set", on })`，**不改 iframe.src**。换文件重挂时仍可带 `inspect=1`，那是新文档，不是为进点评而刷。
- 三维：包一层 `THREE.WebGLRenderer.prototype.render` 记下 scene/camera，再 `Raycaster` 打可见 mesh / InstancedMesh。跳过 `material.visible===false`、Helper、CSS2D。`.labels` / `.atmos` / loading 用 `elementsFromPoint` 穿透到 canvas。侧栏 / HUD / 按钮仍走 DOM，不当三维。
- selector：`userData.reviewId` → `[data-review-id=…]`；`userData.slot` → `mesh:slot-N`；否则非泛名 `mesh:Name`。

## 三维还选不中的边界

- **空 Group / 只有变换没有几何**：射线打不中，要有可见 mesh。
- **页面没把 THREE 挂到 `window.THREE`、也没有持续 `renderer.render`**：钩子记不住 scene/camera（FOUP / 常见 three 页没问题）。
- **CSS2D 当独立 UI 而不是标注**：被当成 overlay 穿透；若要点的就是那张标签，会落到底下的 mesh（或整张 canvas）。
- **活 4173 未重启**：这台进程启动时 import 的还是旧 `appendSiteHooks`。静态父页硬刷新即可改按钮行为；**已打开的旧 iframe 没有休眠 runtime**，点点评不会再刷，但页内也听不到 `inspect-set`。重启宿主后再开一次预览，之后进点评不再刷新。

## 测了哪些

```
npx vitest run test/review-mode.test.ts test/ui-artifact-canvas.test.ts test/ui-math.test.ts test/ui-server.test.ts -t "inspect|点评|site|appendSiteHooks|整站|WebGL|hidden"
```
