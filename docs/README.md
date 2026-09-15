# 文档怎么放

人现在会读、会照着做的是**活文档**。案例与研究结论是**结案档案**：可以修仍当手册用却已错的命令/路径，不要重写成「当时没发生过」。

## 活文档（先读这些）

| 位置 | 内容 |
|---|---|
| 仓库根 [`README.md`](../README.md) | 三面怎么开、权限默认、能力边界 |
| [`06-backlog.md`](06-backlog.md) **第一屏** | 2026-09-14 开工交接；后面大段是已关闭档案 |
| [`08-maturity-optimization-checklist.md`](08-maturity-optimization-checklist.md) | 工程成熟度台账（`[x]` / `[~]` / `[ ]`） |
| [`07-production-runbook.md`](07-production-runbook.md) | 单操作员生产部署 / canary / 回滚 |
| [`permission-modes.md`](permission-modes.md) | 权限三档对照（与 `src/permission-mode.ts` 同源） |
| [`../.env.example`](../.env.example) | 环境变量名与注释；端点配置与兼容性说明 |
| [`../eval/persona-ux/README.md`](../eval/persona-ux/README.md) | 2026-09-14 人格走查：怎么读评测 |
| [`13-live-mu-backlog.md`](13-live-mu-backlog.md) | 共享宿主 flash 评测债（D1–D10 本波已标完成） |
| [`12-live-multiuser-harness-test.md`](12-live-multiuser-harness-test.md) | 共享宿主评测纪律 |
| [`adr/`](adr/) | 架构决策（隔离 / lease / durable state） |

## 结案档案（不要当「现在还没做」）

| 位置 | 内容 |
|---|---|
| `01`–`05`、`04-roadmap` | 哲学、架构蓝本、接口、v0.1–v1.1 路线、研究结论 |
| `09`–`12` 其余编号稿 | 借鉴清单、设计模式拍板、企业评审清单 |
| [`cases/`](cases/) | 真实任务案例 #1–#11 |
| [`reference/`](reference/) | 2026-08 给 agent 用的模块签名快照（不是现在的 `src/` 清单） |
| [`ui/`](ui/) | Web UI 升级评审台账（从仓库根迁来） |
| `06-backlog.md` 第一屏以下 | 2026-09-03 / 08-08 等旧交接，标题已标「已关闭档案」 |

根目录只留给人先看到的：`README.md`、`CHANGELOG.md`、`SECURITY.md`，以及早期验收留下的 `SUMMARY.md` / `STATS.md`。

演示站、硬件工程、PPT 不在本仓库，在 `D:\Work\scratch\agent-design-local-20260908`。
