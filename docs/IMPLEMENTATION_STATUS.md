# 实施结果与证据边界

日期：2026-09-22。定位：**面向长程软件工程任务的自适应执行与可信交付系统**。产品入口是独立 CLI 与本地 daemon，执行基础固定为 vendored Pi。

本次完成了代码审查后的实现、回归测试、评测适配和面试材料。正式的模型质量、费用、延迟对照实验尚未运行。这里的“完成”指列明的实施与验证范围，不表示软件绝无缺陷。

后续发布收尾增加了独立终端界面、按角色配置模型/API、中英文 README 和源码打包。最新完整回归为 **142 项通过、0 失败、0 跳过**，详见 [发布验证记录](validation/2026-09-22-release.md)。下文保留此前 121 项实现回归及盲题检查的原始记录。

**验证缺口：**单题 subagent 试验绕过了 TripleTeam 的运行控制面；当前没有“新版完整系统在未见 benchmark 题目上的闭环执行”证据。121 项实现回归与单题答题结果不能拼接成这项证据，因此不能据此宣称“系统测试已全部完成”。

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
- ADAPTIVE 使用耗时/费用历史、失败次数和检查负载生成边际收益代理，并持久化输入、先验来源和选择结果。
- 高耦合保持串行；中等耦合只有在**具体共享接口**的 obligation 与对应证据成立时才允许放宽。已验证的无关接口不能解除其他耦合。
- 规划、探索、实现、review、修复与恢复共用费用、token、deadline 和 execution 上限；失败调用也计入。
- `SINGLE` 从完整目标创建一个 Task，不先消耗模型拆图预算；其 writer 重试可使用全局额度，并保留相同的无进展止损。辅助 review/诊断属于共同交付机制，因此该条件应称“强单 writer 基线”。

**算法表述边界：**当前是可解释、带历史反馈的启发式策略。`successProbability` 是由失败次数构造的代理量，`marginalUsefulMs` 是有单位的收益代理；它们没有经过概率校准，也不是已学习的价值函数。默认耗时和费用先验已在代码中显式记录。不能写成“实现最优预算分配”或“训练了调度策略”。

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
- 最终检查失败可创建有界 repair Task，保留原目标、授权范围与验收条件，携带真实失败检查及日志。
- effective Pi profile、工具限制及显式 model/provider/reasoning 选择被固定；恢复的动态反馈作为新观察注入，初始 session/context identity 保持不变。
- `noninteractive` 在权威入口拒绝人类答复、消息、手动 retry 和用户图变更决策；DecisionRequest 可以落盘，无法授权则 BLOCKED。
- 事件计费与 Pi 公共 session statistics 对账覆盖可获得的 compaction、cache warm、tool usage；未报告用量明确未知。多个 planner 调用不能抵消一个没有计费记录的崩溃 execution。
- Terminal manifest 包含代码树、检查、合同证据、控制动作和记录的用量。模型、聊天、进程退出都不能直接完成 acceptance。

## 3. 已执行检查

本次最终实现检查：

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

使用公开 FeatureBench fast 中一题，先由准备程序遮蔽源码、删除隐藏测试并清空 Git 历史，再交给 `fork_turns=none` 的 solver。solver 只被授予公开题面与起始目录，没有收到项目分析或隐藏反馈。补丁及 Git tree 封存后，由另一个执行者运行固定官方 evaluator 与镜像。

**严格结果 0/1 未解决；F2P 284/294，P2P 3508/3508。**未修复、未重新提交。详细版本、哈希、命令和局限见 [盲题记录](validation/2026-09-22-blind-featurebench.md)。

这次检查显示：公开测试全部通过仍可能漏掉需求。它支持保留独立验收及完整失败记录的必要性，不能证明调度算法获益，也不能作为 TripleTeam 经 Pi 执行的正式成绩。

## 5. 已准备好的正式评测入口

- FeatureBench：严格公开字段输入、冻结清单、实例/run 持久映射、从权威 integration tree 导出 patch、全部预定实例收集、独立官方报告核对与费用汇总。
- SWE-Milestone：只消费官方已释放的 queue/SRS，沿用自己之前的代码，冻结剩余额度，使用不可移动提交标签；官方 watcher 控制后续任务解锁。
- 基线与消融：SINGLE、FIXED、HEURISTIC、ADAPTIVE、关闭 contracts、关闭 failure adaptation；配方同时说明 Codex / Claude Code 的版本、模型、预算和计费边界。

操作见 [BENCHMARK_ADAPTERS.md](BENCHMARK_ADAPTERS.md) 与 [BASELINE_COMPARISON.md](BASELINE_COMPARISON.md)。完整官方容器批量启动、模型 API 成本/质量测量以及统计结论属于后续正式评测，未在本次调用。

## 6. 必须保留的边界

- 工作树、工具白名单和 SQLite capability 不提供 OS 级 writer 隔离。正式盲评需要独立容器与网络规则；本次新上下文 solver 使用的是明确访问协议。
- oracle、检查镜像和宿主环境属于信任基础。应保护验收入口及其依赖；原生检查不能独自产生 VERIFIED_DELIVERY。
- 验证工作树是新的，native npm 检查需要预配置依赖环境；可信 Docker 镜像应预装检查所需依赖，不应依赖 writer 的临时安装或隐藏网络下载。
- dollar/token 限额根据可观测事件执行，无法消除在途请求及账单延迟；中断用量保留未知值。没有可靠账单就不能宣称更便宜。
- 未显式选定 model/provider 时，Pi 默认模型设置仍是外部环境的一部分。正式评测必须显式固定。
- 没有证明相对 Codex/Claude Code 的完成率、时间或成本优势，也没有证明方法首次提出。

实现与测量基础已完成；简历中的性能数字只能由后续冻结实验产生。
