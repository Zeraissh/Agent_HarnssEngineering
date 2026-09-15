# 点评三维仍选不中

日期：2026-09-15  
范围：`ui/public/features/review-mode.js`、`ui/public/features/review-mode.d.ts`、`test/review-mode.test.ts`。  
未 commit / 未 push。未 `git add -A`。未改 walks / VERIFY。未 Set-Content -Encoding utf8。  
未改：`ui/serve.ts`、飞书/notify、`app.js` 思考流、`cross-app/**`、git remote。

上一轮（`_fix-notes-review-inplace.md`，d3b1906）进点评不再刷 iframe，射线跳过隐形拾取盒。还选不中的三件事本轮补上。

## 改了什么

1. **空 Group**：射线打中隐形盒 / 无几何节点时，落到该组里**空间最近的可见后代 mesh**（要有 geometry + 可见材质）。有名 Group 在射线没命中 mesh 时再用包围盒收一次。匿名空 Group 不抢背景点击。没有可见后代就不编造命中。
2. **找 scene/camera/renderer**：除 `window.THREE` 外认 `window.scene` / `window.camera`、`app.scene` / `app.camera`，以及 `viewer`/`world`/`game` 等常见袋；遍历 iframe `window` 上的 `WebGLRenderer`（`isWebGLRenderer` 或 `domElement === canvas`）。页面不用改源码挂 THREE。找到实例就包一层 `render` 记 last scene/camera；即使不持续 `render`，只要挂了 scene+camera 也能射。
3. **CSS2D / `.label`**：不再当透明穿透。点标签：`data-review-id` / `data-slot` / `data-target` 或 CSS2D 的 parent/userData 绑到对象 → 选中那个对象（空 Group 再落到可见后代）；没绑定 → 标签自己一条 DOM 点评。
4. **chrome**：侧栏 `.panel` / HUD / 按钮 / 链接仍走 DOM，不拿去射三维。`.atmos` / loading / `.labels` 空档仍穿透。

## 现在能点中什么

- 可见 Mesh / InstancedMesh / SkinnedMesh（有体积和可见材质），含壳体、门、晶圆。
- 点到槽位隐形盒或有名空 Group：落到组里最近的可见后代（常见是该槽的晶圆/零件），selector 走 `reviewId` / `slot` / 非泛名。
- 页面只挂 `window.scene`+`camera` 或 `app.scene`，或能扫到 WebGLRenderer，不必 `window.THREE`、也不必持续 `renderer.render`。
- CSS 标注 / CSS2D：有绑定就点绑定对象；没绑定就点评这张标签。
- 侧栏按钮、HUD、链接：DOM 点评，不误伤成 mesh。

## 仍点不中什么

- 真的没有任何可见后代的空 Group（只有变换，组里也没有带材质的 mesh）。
- 匿名空 Group 的“空白处”（故意不抢背景；要点它得给名字 / `userData.reviewId` / `slot`）。
- 页面把 THREE、scene、camera、renderer 全部收在模块闭包里，window 上什么都不挂、也不调 `renderer.render`、canvas 上也没有 `__renderer`——钩子找不到上下文，canvas 点击会退回整张画。
- Line / Points / 纯 Helper / `material.visible===false` 且父组也没有可见后代。
- 活着的旧 4173：进程启动时 import 的还是旧 `appendSiteHooks`。父页硬刷新只换静态壳；**已打开的 iframe 仍是旧 runtime**。要吃到本轮钩子需重启宿主后再开一次预览（不要 taskkill 探活）。本轮探活时 4173 **没有 Listen**（OwningProcess>4 为空），未打开预览、未 taskkill。

## 测了哪些

```
npx vitest run test/review-mode.test.ts
```

锁：空 Group → 最近可见后代（远的壳体不抢、隐形盒不当命中、无后代不编造）；`app.scene` / 孤立 WebGLRenderer 能取出上下文且不要求 `window.THREE`；标签绑定 / CSS2D parent / 未绑定标签自己 / chrome 与 atmos 分工；钩子源文含 `app.scene`、`window.scene`、`isWebGLRenderer`、`isCSS2DObject`、`data-review-label`；runtime 点侧栏按钮、绑 id 的标签、独立标签、canvas 隐形盒。
