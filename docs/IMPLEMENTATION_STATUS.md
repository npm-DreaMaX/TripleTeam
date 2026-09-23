# 实施结果与证据边界

日期：2026-09-23。定位：**面向长程软件工程任务的自适应执行与可信交付系统**。产品入口是独立 CLI 与本地 daemon，执行基础固定为 vendored Pi。

本轮补充：基线诊断与固定依赖准备、按 scope/atomic 编译可验证增量、剩余交付预算驱动的可选验证分配、带 Git/上下文依赖的观察复用、上游 artifact 证据输入、受限审查格式纠正、TASK/FINAL 阶段探针、供应商账户故障止损、`/why`、真实导出工作流 demo，以及完整配置冻结和配对 benchmark 分析。操作入口见 [验收手册](ACCEPTANCE.md) 和 [评测指南](BENCHMARK_GUIDE.zh-CN.md)。最新 [最终交付记录](validation/2026-09-23-final-handoff.md)汇总本轮检查；[Atlas 实际运行](validation/2026-09-23-atlas-development.md)保留全部四轮结果及最后的 API 余额不足。下面的历史验证数字按对应版本保留。

本次完成了代码审查后的实现、回归测试、评测适配和面试材料。正式的模型质量、费用、延迟对照实验尚未运行。这里的“完成”指列明的实施与验证范围，不表示软件绝无缺陷。

后续增加了独立交互终端、按角色配置模型/API、完整设置入口与运行配置冻结、中英文 README、源码打包，以及独立规格验证、辅助计算计费、规划预算与降级路径。此前 [9 月 23 日发布记录](validation/2026-09-23-release.md)为 **277 项通过、0 失败、0 跳过**。9 月 22 日的 142 项发布回归保存在 [历史记录](validation/2026-09-22-release.md)；下文的 121 项早期检查与旧 subagent 试验也保留原始语义。

**当前真实执行证据：**实际 Pi + DeepSeek API 已完成两次 [单目标 VERIFIED_DELIVERY](validation/2026-09-23-controlled-runtime.md)，以及一次 [双任务、独立检查发现错误、自动修复后交付](validation/2026-09-23-two-module-runtime.md)。这些是受控工程验收；正式模型质量、成本、延迟对照仍需冻结 benchmark。旧 subagent 单题不经过本系统控制面，不能与工程测试拼接成系统成绩。

最新 [真实交互终端试跑](validation/2026-09-23-terminal-runtime.md)保留了首次规格协议失败及修复后的 VERIFIED_DELIVERY；[FeatureBench 开发试跑](validation/2026-09-23-featurebench-development.md)保留全部五次阻塞和官方空补丁未解决结果。未把失败重跑包装成首次成功率。

## 1. 原始审查问题已转成回归约束

原始报告针对提交 `4690901a390878593aa41e2fd25b98e8831b9578`；原报告及 `reproduce.mjs` 保留历史语义。当前正确性门禁是 `test/`，不能继续把“成功复现旧 bug”当作新版本验收。

| 问题 | 实施结果 | 主要证据 |
| --- | --- | --- |
| R1：diff-only 可被当行为验收 | 未声明检查默认 STRUCTURAL；行为/外部声明必须有受保护 oracle 和固定 Docker 镜像隔离，否则降为 BUILD | `check-runner.test.ts`、`reporter.test.ts` |
| R2：实际检查对象与报告 tree 不同 | 每项检查独立 worktree；检查 HEAD、index、实际文件、权限与修改记录；Docker 源码只读；最终验收绑定权威 integration tree | `check-runner.test.ts`、`run-verifier.test.ts` |
| R3：常量/跨 Task 指纹误判重复失败 | 指纹包含实际检查身份、稳定命令版本和日志；重复计数按 Task；基础设施复验与 writer 重试分开 | `task-executor-recovery.test.ts` |
| R4：子任务可扩权到整个仓库 | 自动接受的 prerequisite 必须位于源 Task scope 内，保留约束、能力和冻结验收政策 | `authority-budget-contracts.test.ts` |
| R5：暂停使提案无故过期 | 提交时核对 Task version，接受时核对任务 revision 与依赖图摘要；状态漂移不会冒充规格变化 | `authority-budget-contracts.test.ts` |
| R6：A/B 决策不回灌、不解锁 | 决策、ANSWER 消息和解锁在一个 SQLite 事务内；同 Task 仍有未答问题则继续等待 | `authority-budget-contracts.test.ts` |
| R7：失败探索无法重试 | 按 revision、baseline、hypothesis 有界重试；恢复时失败化孤立 RUNNING 记录；过滤过期报告 | `task-executor-recovery.test.ts`、迁移回归 |

## 2. 三个卖点现在对应什么代码

### Adaptive Compute Allocation

实现位置：`control/coordination-policy.ts`、`control/scheduler.ts`、`config/execution.ts`、`runtime/pi/metered-run.ts`。

- 任务图上的关键路径优先级参与调度；短任务结束后立即补位，无需等待整批任务结束。
- 决策检查 dependency、scope、可分解性、顺序性、接口耦合、探索历史及共享预算。
- ADAPTIVE 按完成的 writer Attempt 聚合耗时/费用与真实结果；设计、review、检查与探索分开统计。辅助成本、检查负载和调查收益代理共同参与决策，并持久化输入及选择。
- 高耦合保持串行；中等耦合只有在**具体共享接口**的 obligation 与对应证据成立时才允许放宽。已验证的无关接口不能解除其他耦合。
- 规划、探索、实现、review、修复与恢复共用费用、token、deadline 和 execution 上限；失败调用也计入。
- `SINGLE` 从完整目标创建一个 Task，不先消耗模型拆图预算；其 writer 重试可使用全局额度，并保留相同的无进展止损。辅助 review/诊断属于共同交付机制，因此该条件应称“强单 writer 基线”。

**算法表述边界：**当前是可解释、带历史反馈的启发式策略。可靠性以 Beta(2,2) 先验、任务实际 writer outcome 及最多 4 个跨任务等效观察估计，并记录保守分数；重复诊断不增加失败样本。`marginalUsefulMs` 是有单位的收益代理。这些估计未经校准，也不是已学习的价值函数，不能写成“实现最优预算分配”或“训练了调度策略”。

### Artifact-backed Coordination

实现位置：`control/contract-types.ts`、`control/contract-verifier.ts`、Kernel 的 contract evidence/consumption 门禁。

1. `provides` / `assumptions` 中的每个声明有 `artifactPaths + checkNames`。
2. `requires` 解析到唯一 producer，并形成图依赖。
3. producer 的声明由真实 Git blob、文件 mode、准确 tree 和指定的通过检查支持。
4. consumer 的 Attempt 记录使用了哪个 definition version、baseline 和证据 ID。
5. 后续 Candidate 修改已发布产物时，计算 accepted producer 及传递依赖闭包，对全部受影响任务重跑各自冻结 integration checks。
6. 全部通过后才生成新树的证据并发布。原有 baseline 的证据继续有效，尚未发布的新证据不会抢占旧 baseline 的权威。

这里的 version 区分**合同定义**与**一次 artifact 实现的证明**。同一冻结定义可以有多份 immutable exact-tree proof；兼容实现演进需要复验。改变用户要求的语义不能通过补一份测试结果完成，仍需新的授权规格/目标。

这些机制证明“约定产物存在且约定检查通过”。检查是否充分刻画语义仍取决于 oracle；不能把编译通过或 Git 可合并声称为完整语义证明。

### Verified Autonomy

实现位置：`control/failure-policy.ts`、`control/task-executor.ts`、`verification/`、`control/reconciler.ts`、`delivery/reporter.ts`。

- REPLAN 会运行独立只读诊断；RETRY/REBASE 保留上一份 Candidate；INFRA_RETRY 在新验证工作树上复验，不重新购买 writer。
- 实现前由独立上下文形成可追溯义务、同断言错误对照与探针，并经独立批判后冻结。候选与集成执行当前 TASK 探针，最终树重复执行全部 TASK/FINAL 探针；设计失败保留原定义和原因，在阶段额度内局部纠正，耗尽后阻塞而非空开 writer。
- 规划阶段超过分配或无法形成合法图时，在全局权限和预算允许下退回完整目标 Task；保留失败记录及原 scope/验收。搜索工具离线预检与工作树范围检查避免缺少依赖或根目录搜索消耗模型预算。
- 最终检查失败可创建有界 repair Task，保留原目标、授权范围与验收条件，携带真实失败检查及日志。
- effective Pi profile、工具限制及显式 model/provider/reasoning 选择被固定；恢复的动态反馈作为新观察注入，初始 session/context identity 保持不变。
- `noninteractive` 在权威入口拒绝人类答复、消息、手动 retry 和用户图变更决策；DecisionRequest 可以落盘，无法授权则 BLOCKED。
- 事件计费与 Pi 公共 session statistics 对账覆盖可获得的 compaction、cache warm、tool usage；未报告用量明确未知。多个 planner 调用不能抵消一个没有计费记录的崩溃 execution。
- Terminal manifest 包含代码树、检查、合同证据、控制动作和记录的用量。模型、聊天、进程退出都不能直接完成 acceptance。

## 3. 已执行检查

9 月 23 日此前发布快照（本轮记录见上方链接）：

```text
npm run check                         PASS
npm run build                         PASS
npm test + pinned Docker test image  277 passed / 0 failed / 0 skipped
node dist/cli.js doctor --json        PASS
node dist/benchmark.js --help         PASS
```

另外执行了真实 PTY 输入、中文、窗口缩放、daemon 控制与 OS 信号测试。最新实际 API 终端任务通过 24 项检查并正常交付、退出；完整记录见[发布验证](validation/2026-09-23-release.md)。

### 9 月 22 日初次审查后的历史检查

```text
npm run check                         PASS
npm run build                         PASS
npm test + pinned Docker test image  121 passed / 0 failed / 0 skipped
node dist/cli.js doctor               PASS
node dist/benchmark.js --help         PASS
```

Docker 检查镜像为本地固定 ID：`sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f`。未提供 `TRIPLETEAM_TEST_DOCKER_IMAGE` 时，默认 suite 会跳过两个可选 Docker 用例；上面的完整检查已实际运行它们。

测试覆盖 epoch/CAS/recovery、受保护验收入口、只读容器与进程回收、共享预算、实际 Git 合同复验、非交互权限、事件驱动调度、最终修复、profile 漂移、v7→v8 迁移和 benchmark 导出。TaskExecutor 的集成测试使用确定性 worker 替身生成变更，实际运行 Git、检查命令、Kernel、journal 和集成流程；这不等于实际模型调用的端到端成绩。

## 4. 盲题开发检查

### 9 月 22 日：独立对话 solver

使用公开 FeatureBench fast 中一题，先由准备程序遮蔽源码、删除隐藏测试并清空 Git 历史，再交给 `fork_turns=none` 的 solver。solver 只被授予公开题面与起始目录，没有收到项目分析或隐藏反馈。补丁及 Git tree 封存后，由另一个执行者运行固定官方 evaluator 与镜像。

**严格结果 0/1 未解决；F2P 284/294，P2P 3508/3508。**未修复、未重新提交。详细版本、哈希、命令和局限见 [盲题记录](validation/2026-09-22-blind-featurebench.md)。

这次检查显示：公开测试全部通过仍可能漏掉需求。它支持保留独立验收及完整失败记录的必要性，不能证明调度算法获益，也不能作为 TripleTeam 经 Pi 执行的正式成绩。

### 9 月 23 日：实际 Pi + DeepSeek

在官方遮蔽容器中对另一个 FeatureBench 实例进行了五次开发试跑。它们均未完成交付，期间修改了运行时、工具环境和阶段预算，因此不是固定配置的正式对照。最后一次从 SQLite 权威树封存空补丁，官方评分为未解决；官方空补丁分支未运行 F2P/P2P 测试。

这些试跑暴露了规划耗尽、协议纠错、错误范围搜索、取消等待清理，以及中间集成检查的环境/阶段配置问题。实现修复分别进入回归，全部失败、费用和未知用量仍保留在[开发记录](validation/2026-09-23-featurebench-development.md)。尚未证明相对其他产品的效果优势。

## 5. 已准备好的正式评测入口

- FeatureBench：严格公开字段输入、冻结清单、实例/run 持久映射、从权威 integration tree 导出 patch、全部预定实例收集、独立官方报告核对与费用汇总。
- SWE-Milestone：只消费官方已释放的 queue/SRS，沿用自己之前的代码，冻结剩余额度，使用不可移动提交标签；官方 watcher 控制后续任务解锁。
- 基线与消融：SINGLE、FIXED、HEURISTIC、ADAPTIVE、关闭 contracts、关闭 failure adaptation；配方同时说明 Codex / Claude Code 的版本、模型、预算和计费边界。

操作见 [BENCHMARK_ADAPTERS.md](BENCHMARK_ADAPTERS.md) 与 [BASELINE_COMPARISON.md](BASELINE_COMPARISON.md)。单题开发运行和独立评分已记录；多实例固定配置、产品基线及消融的统计结论仍属于后续正式评测。

## 6. 必须保留的边界

- 工作树、工具白名单和 SQLite capability 不提供 OS 级 writer 隔离。9 月 22 日的新上下文 solver 使用明确访问协议；9 月 23 日的实际 Pi 开发运行使用官方遮蔽容器与受限模型出口。正式评测需继续固定这些边界。
- oracle、检查镜像和宿主环境属于信任基础。应保护验收入口及其依赖；原生检查不能独自产生 VERIFIED_DELIVERY。
- 验证工作树是新的，native npm 检查可配置冻结 preparation，在源码完整性监控下准备依赖；可信 Docker 镜像应预装检查所需依赖，不应依赖 writer 的临时安装或隐藏网络下载。
- dollar/token 限额根据可观测事件执行，无法消除在途请求及账单延迟；中断用量保留未知值。没有可靠账单就不能宣称更便宜。
- 未显式选定 model/provider 时，Pi 默认模型设置仍是外部环境的一部分。正式评测必须显式固定。
- 没有证明相对 Codex/Claude Code 的完成率、时间或成本优势，也没有证明方法首次提出。

实现与测量基础已完成；简历中的性能数字只能由后续冻结实验产生。
