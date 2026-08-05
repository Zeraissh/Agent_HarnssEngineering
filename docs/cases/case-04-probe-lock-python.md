# 真实任务案例 #4 — 探针跨进程锁 × 首个 Python 项目（2026-08-05）

**任务**：案例 #3 产出的需求 #1——给用户的开源项目 stm32-gdb-mcp（Python 3.13）
实现探针 OS 级锁：同探针同时刻只允许一个进程拉起 GDB server，占用时报
`probe '<键>' held by PID <x>`（此前只有裸的 OpenOCD "init mode failed"）。
同时这是 harness **首次给 Python 项目干活**——刻意先用通用配置（无领域包）跑，
检验通用面的成色。执行者/核查者均 deepseek-v4-pro。

## 交付与验证（全绿）

- **交付物**（留仓未提交，待用户审）：`src/mcp_server/probe_lock.py`（stdlib-only，
  锁键三级派生 serial→interface cfg→server_type，锁载荷记 locker_pid+child_pid）、
  `gdb_manager.py` 集成（Popen 前取锁/adopted 不取/stop 与全部失败路径释放/spawn 后
  回填 child_pid）、`error_taxonomy.py` 新增 `probe_locked`（retryable=false，
  借 retry_call 现有判定自动快速失败）、`tests/test_probe_lock.py` 15 测试。
- **地面真值四道门禁**：pytest 916 passed（基线 901+15）、ruff/mypy/compileall 零错误；
  改动面恰好 4 文件无污染。
- **真机 HIL 三场景**（DAPLink + L151，无烧录，事后零残留）：
  | 场景 | 实测 |
  |---|---|
  | 活持有者抢占 | `probe '132765404453' held by PID 35360`，分类 probe_locked/不可重试 |
  | 僵尸 openocd（杀 locker 留子进程） | 归因到 child `held by PID 33200`——案例 #3 历史事故形态首次有名有姓 |
  | 双死陈锁 | 自动清理 → 真机干净启动+停止 |

## 通用配置轮（轮 1）——两个缺口如实出现

执行者 30 轮完成（其间 2 次幻觉调用 `edit_file`——通用工具面只有 write_file）。
**verifier 无核查白名单 → bash 全 deny × 6 → 跑不了任何门禁**：首次核查产出
"无实质结论"被 fail-closed 判 failed → **触发 22 轮返工，零写入、纯粹重证明了
已经为真的东西**（地面真值：返工前四道门禁已全绿）；二次核查只能靠读文件的
间接证据签字（裁决声称"验证了 AC1-AC3"，实际上退出码根本无从读到）。

**发现 1（核查饥饿）**：白名单缺失不只是"证据降级"，还是"返工经济性"问题——
verifier 取证能力不足时,fail-closed 会把"查不了"错判成"没做对",烧掉整轮返工。
这是 fail-closed 的第三种误伤形态（前两种：裁决解析失败、核查预算耦合）。

## python-coding 包 + A/B（轮 2，同交付物同模型，唯一变量=包）

包内容对症今天两缺口：verify.readOnlyCommands（pytest/ruff check/mypy/compileall/
pip list/git status·diff·log/ls/grep/wc；刻意不放行裸 python·python -c，ruff 必须带
check 防误放 format）+ 系统提示成文"工具面没有 edit_file"+ Python 质量门禁纪律。

**A/B 结果**：轮 2 verifier 亲手重跑全部四道门禁 + git status/diff 改动面取证，
裁决带第一手数字（"pytest 916 passed/0 exit…"）,零返工。微观亮点：`cd X && git status`
被链式规则正确拒绝后,verifier 按 deny 消息里的白名单提示立刻改用合规裸命令——
**deny 消息即教学**。

## 意外收获：bash 工具第三层地板缺陷（已修）

包的新测试从 PowerShell 跑 vitest 时,既有的 verifier 白名单测试假失败——stash 对照
锁定为预存问题,探针定位真凶：**Git Bash 拉起来了,但 `bash -c` 不跑 profile,
coreutils（wc/grep/sed）全赌父进程 PATH**。父进程是 Git Bash 时碰巧有,是
PowerShell/计划任务时 `wc: command not found`。修复：bashTool 自动把 Git `usr\bin`
前置进子进程 PATH——工具自带运行时完整性,不赌宿主环境。这是"cmd 冒充 bash"
（2026-07-25）的续集：**shell 对了还不够,工具链在场才算地板铺完**。

## 结论

案例 #3 的需求闭环：探针纠纷从"无归因秒败"升级为"报 PID 的确定性快速失败",
真机重演历史事故形态验证归因正确。harness 双线飞轮再转一圈：Python 首跑暴露
两缺口 → python-coding 包当日落地并 A/B 证实 → 顺带挖出并修掉 bash 运行时
第三层地板。交付物与 HANDOFF-PROBE-LOCK.md（轮 2 的门禁证据报告）均留仓待审。
