# kicad-host-kit — 宿主侧 KiCad 结构化工具箱(案例 #11 沉淀)

案例 #11(STM32L151 最小系统 → 蓝药丸式开发板)里,执行者对 8000 行 `.kicad_pcb` 做文本手术三次写坏文件,
最终全部 PCB 结构性操作由宿主用 pcbnew Python API 完成。这里是那套脚本的仓库版:**路径参数化、可重复、每个脚本一件事、
纯计算与落板分进程**。它同时是 harness 下一步"结构化编辑工具"(agent 可调用的 rip/restore/mitre/audit)的原型。

## 前提

- KiCad 9(`D:\KiCad\bin\python.exe` 带 pcbnew;`kicad-cli` 在 PATH)。脚本默认这两条路径,PS1 有参数可改。
- freerouting 2.3.0 + JRE ≥ 25(2.3.0 编译到 class 69;JRE 21 起不来)。便携安装即可:`D:\Work\tools\freerouting\`。
- 视觉复核:`npm i`(sharp)一次;`kicad-cli … export svg` → `zoom.mjs` 裁区放大 → Read。

## 三条硬纪律(从案例 #11 血泪里来)

1. **拆与算与落板分进程。** `board.Remove()` 后同进程再算几何会读到"毒化"对象(SWIG);所以 `route_repair.py`(纯计算 → actions.json)
   与 `apply_actions.py`(落板)是两个进程,`move_parts.py` 也分 `rip` / `move` 两步。
2. **拆线前先想 GND 缝合 via。** 它们天生没有 B.Cu 段;任何"孤 via 清理"若把 GND 算进被拆网,会把 24 个缝合 via 全删掉(踩过,回滚快照)。`rip_runs.py` 已把 GND 强制留在保留名单。
3. **判据先写,结果后过。** `audit_routing.py` 的 7 条判据校准自量产板(见 `docs/reference/l151-production-board-conventions.md`),
   任何布线结果——手工、freerouting、混合——都过同一份体检单;不许为了结论好看改阈值。

## 脚本一览

### 建板 / 约束
| 脚本 | 作用 |
|---|---|
| `examples/case11_build_devboard.py <net> <out.pcb>` | 从基线网表 + 摆位表用官方库重建空板(范本:宿主重建管线) |
| `pour_gnd.py <pcb> [--rect …]` | B.Cu 整层 GND 单池(先池后线——底层=参考面) |
| `keepout.py <pcb> NAME:LAYER:x0,y0,x1,y1 …` | 规则区禁走线(晶振下方 B 禁线 + F 围栏);freerouting 照做 |
| `jlc_rules.py <pcb> [--clearance 0.152]` | 嘉立创口径板级最小约束 + 丝印线宽/字高整体抬到 0.15/1.0 |
| `fab_check.py <pcb>` | 工艺校验:板级约束/网类/实物统计,并打印嘉立创能力表参照 |

### 自动布线桥(freerouting headless)
| 脚本 | 作用 |
|---|---|
| `export_dsn.py <pcb> [out.dsn]` | 导 DSN(GND 池 → plane;规则区 → wire_keepout) |
| `run_freerouting.ps1 -Dsn -BasePcb -OutPcb [-Is -Us]` | 一盘到底:布线 → 导入 → DRC 计数 → 惯例审计;自动挪走同名 `.rules`(否则弹确认框阻塞) |
| `import_ses.py <base> <ses> <out>` | 导入 SES + 重填铺铜 |
| `freerouting.template.json` | headless 配置:gui 关、neckdown 关、fanout 关、单线程 |

结论备忘:`-is/-us` 只动优化阶段,主布线结果确定(6 组扫掠同一结果);DSN 注入 `autoroute_settings` 层代价 headless 下 0 网可布——别用;
让它守规矩的手段是**约束(池/禁区/网类/关 neckdown)+ 事后审计 + 混合返工**,不是调它的旋钮。

### 返工循环(DRC 驱动)
| 脚本 | 作用 |
|---|---|
| `rework_loop.ps1 -Pcb … [-MaxRounds 4] [-BCost 4] [-Deep]` | 拆冲突 → 逐轮清悬空 → 未连接对 → 恢复清单 → 返工路由 → 落板 → 切角 → DRC |
| `rip_conflicts.py <pcb> <rpt>` / `clean_dangling.py <pcb> <rpt>` | 按 DRC 报告精确拆 |
| `restore_from_drc.py <pcb> <rpt>` | unconnected_items → restore.json(Zone 端 → DIVE) |
| `add_restore.py <pcb> [--append] NET:REF-PIN:REF-PIN\|DIVE\|x,y` | 手写恢复项 |
| `route_repair.py <pcb> [b_cost] [--deep]` | 网格 A*(0.125 栅、F 优先、B 代价 ×b_cost、DIVE 下潜入主池打针),纯计算 |
| `apply_actions.py <pcb>` | 落板 + 重填 |
| `rip_runs.py <pcb> [minlen] [keep]` / `rip_net.py <pcb> NETS` / `drop_via.py` | 定点拆 |
| `move_parts.py <pcb> rip\|move REF:x,y,rot` | 挪件两步走 |
| `mitre.py <pcb> [--dry]` | 全板拐角整形:度数 2 拐点 → 八向 L 形或 45° 斜角,逐遍收敛(用户红框批评"90°/锐角"后写) |

嵌套扇出要**由内向外**恢复(PB14 → PB13 → PB12),外圈先占道内圈就无路——这是 `--deep` 存在的原因之一。

### 审计 / 视觉
| 脚本 | 作用 |
|---|---|
| `audit_routing.py <pcb> [--xtal box] [--xtal-nets]` | 7 判据:B 长 ≤40% F;最长 B 段 ≤15mm;via ≤80 且 ≤0.35/段;晶振盒无外网;GND B 池轮廓=1;线宽 ≥0.25;via 0.6/0.3 |
| `islands.py <pcb>` / `bruns.py <pcb>` | 孤岛数量面积;底层跑道成串排名(找切池元凶) |
| `place_silk.py <pcb> REFS` | 位号自动安置(几何净空含板级文本——否则位号压排针标注) |
| `silk_labels.py <pcb> <labels.json>` | 排针逐引脚丝印 + 板名(幂等);`examples/case11_silk_labels.json` |
| `zoom.mjs <svg> <outdir> name:x0,y0,x1,y1` | mm 矩形裁图给宿主看(通用 viewBox 映射,sch/pcb 都行) |

## 典型流程(案例 #11 最终版就是这么来的)

```
build → pour_gnd → keepout → export_dsn → run_freerouting → audit
  → rip_runs(切池长跑道) → rework_loop(F 优先重连) → mitre → place_silk/silk_labels
  → jlc_rules → DRC 0 → fab_check → gerber
```

审计不过就回到拆/返工,不动阈值。最终 v6:DRC 0(嘉立创口径)、ERC 0、审计 5/7(via 81 vs 80;孤岛主池 + 12.7mm² + 1.0mm² 已桥接)、417 个 45° 角。

## 已知边界(诚实记录,不是待办)

- **规则活在 `.kicad_pro` 里,不在 `.kicad_pcb` 里。** 板级最小约束(min_clearance 等)由 KiCad 9 存进同名 `.kicad_pro`;
  只拷 `.kicad_pcb` 的快照读回来是默认值(0/0.2/0.8…),DRC 会按默认值判。快照/交接必须 `.kicad_pcb + .kicad_pro (+ .kicad_sch)` 三件一起。
  `fab_check.py` 会在 `.kicad_pro` 缺席时明说。
- **0.125 栅 A* 复现不了 freerouting 的最小节距紧密排线。** 0.45 节距(0.25 线 + 0.2 距)不是 0.125 的整数倍;
  拆掉紧密带里的一根(如 v6 的 PA9,夹在 PA10/PA8 之间 x=33.554)后,栅上没有合法列,`--deep` 也救不回。
  拆前先看 `bruns.py`/邻线节距;紧密带要么整束拆掉重排,要么手工。有余量的网(smoke:PA4/PB1)一轮即回,DRC 0。
- **`place_silk.py` 把 F.Cu 走线也当障碍**(可读性,不是 DRC 要求),密区可能找不到位;失败时保留原位并明说。
- 2026-08-17 冒烟(仓库路径、v6 板副本):audit/islands/bruns/mitre --dry/fab_check/build/export_dsn 全通;rip PA4,PB1 → rework_loop 一轮 2/2 恢复、5 个切角、DRC 0;
  silk_labels 幂等 48 条;jlc_rules 持久化到 `.kicad_pro`(0.152 读回)。

## 与 harness 的关系

`docs/cases/case-11-l151-minsys-devboard.md` 记录了这些脚本诞生的每一步失败;`docs/06-backlog.md` 记录下一步:
把 rip/restore/mitre/audit 收成 kicad 包里 agent 可调用的结构化工具(`src/tools/kicad-py/`),让"执行者不碰原文件"从纪律变成能力。
