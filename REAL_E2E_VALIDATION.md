# Real E2E Validation

验收日期：2026-09-21 至 2026-09-22（Asia/Shanghai）

> 历史真实模型运行记录：本文件证明当时版本的五个受控场景。后续审查与修复没有重跑付费 Pi/API；当前实现的 121 项回归、Docker 检查和独立盲题记录见 [实施结果](docs/IMPLEMENTATION_STATUS.md)。不能把本文件的历史 PASS 当作新版完整模型端到端测试或性能成绩。

> 版本说明：下面五个场景记录的是使用真实 Pi / DeepSeek V4.1 Flash 完成的运行证据。其后项目新增了 Adaptive Coordination Layer、first-class DecisionRequest、FailureDiagnosis/Disposition 和 Kernel-owned frozen-contract acceptance；这次上层改动没有冒充成一次新的模型 benchmark。当时源码另经 51 项 contract/regression tests、静态检查、生产构建与 `doctor` 验证通过。原始真实 E2E 结论保留，用于证明底层并行、隔离、恢复与集成语义；新增策略能力的边界以 `调研.md` 和当前测试为准。
>
> 当前项目名为 TripleTeam，并已把同版本 Pi `0.86.1` 的实际使用包固定在 `vendor/pi`。下文路径和“官方 npm 包”描述是当次历史运行的原始环境记录，不应被改写；当前 `doctor` 已确认 Pi CLI 从仓库内 vendor 路径加载。

## 结论

正式跑真实项目题目之前要求的五类核心验收全部 **PASS**。

| 场景 | 结果 | 结论 |
|---|---|---|
| 单 Agent 完整闭环 | PASS | 真实 Pi Planner / Implementer / Reviewer 完成 Candidate、验证、审查、集成与系统验收 |
| 两个 Agent 真并行 | PASS | 两个真实 Pi execution 时间重叠，session、worktree、Candidate 隔离，integration 串行 |
| Attempt epoch | PASS | epoch 1 被撤销后，旧进程的 Candidate 与控制请求均被拒绝；epoch 2 接管 |
| Crash / Resume | PASS | daemon 被 `SIGKILL` 后恢复 SQLite、同一 Pi session、worktree、operation；集成中断也不会误提交 |
| Stale integration | PASS | 同 base 的第二个 Candidate 在 head 移动后以新 head 重建结果，并在新 integration tree 上重新验证 |

当前实现已经具备本次验收范围内的真实 multi-agent 并行、隔离、epoch fencing、进程崩溃恢复、证据绑定、串行集成和 acceptance gate。可以进入正式真实项目测试。这里的 PASS 是对受控真实 Git 仓库和真实 Pi/API 执行的工程验收，不是对所有项目形态的普遍正确性证明，也不是模型 benchmark。

## 运行边界与来源

- Agent runtime 使用官方 npm 包 `@earendil-works/pi-coding-agent@0.86.1`，不是旧的本地 Pi clone。
- 源码核对使用从 `https://github.com/earendil-works/pi.git` 重新 clone 的官方 `main`，验收时 commit 为 `7f06f9cf1626504cde95683f1c81a72a7bc7a0cb`。运行时消费官方发布包；源码 clone 只用于核对实现与模型目录。
- 官方源码将 provider/model `deepseek/deepseek-flash` 命名为 **DeepSeek V4.1 Flash**。最终计入结果的 Pi session 均持久化记录了 `provider=deepseek`、`modelId=deepseek-flash`。
- 在正式场景前执行过一次真实 Pi 直连探针，模型返回预期文本 `PI_FLASH_READY`。没有使用 mock provider、伪造 transcript 或测试替身。
- 认证由 Pi 自己的 auth store 提供。本仓库、Git 变更、验收报告和命令输出中均未写入 API key。
- 所有场景均使用真实 Git repository、真实 worktree/ref/commit、真实 SQLite、真实 Pi 子进程以及真实验证命令。没有运行 CooperBench benchmark，也没有新增 GUI、remote worker、memory、workflow DSL 或角色。
- E2E 临时仓库和运行状态保存在 `/tmp/agent-orchestrator-real-e2e.ADNz5U`；它们是本机验收证据，不纳入产品源码。

## Legacy 保护

在继续删除旧 CooperBench 前，已保存：

- branch：`legacy/cooperbench`
- tag：`legacy-cooperbench-20260921`
- 两者均指向：`80c5761209eda4adca9b7da8f65a465d673e055b`

旧删除仍保留在当前 worktree 中，没有用 reset/checkout 覆盖。

## 场景 1：单 Agent 完整闭环 — PASS

这是在模型配置纠正后重新执行、并计入最终结论的运行。更早使用旧模型配置的试跑不计入本报告的模型验收。

- repository：`/tmp/agent-orchestrator-real-e2e.ADNz5U/repo`
- Run：`856855b3-5ea3-438b-8a9f-0dfb44db786a`
- input commit：`79981fbb0b22fa7580be8257aeb5b4bc2332d528`
- final integration commit：`e6967ddc60d0f21007ec343eac50c9414692edab`
- final integration tree：`63cbfab862c7fba8730c4f00794d0564c31bc650`

真实链路：

1. Planner Attempt `4aeac8e8-f305-48d9-b1b0-3fe4957fd4e0` 创建 Task。
2. Implementer Attempt `aa204e9a-dce2-4abb-881b-278e82f483be` 在独立 worktree 中产生 immutable Candidate `267b3de6-ff8b-4983-bb19-511ed92ce720`。
3. Candidate commit 为 `0a4a6734b1ef1267506dc51acd7045c8871f7f31`，只改变 `calculator.js`。
4. Candidate check 在 Candidate tree 上 `PASSED`。
5. 独立 Reviewer Attempt `c95dd3dd-3717-4eba-a8dc-11dafeef9208` 给出 `APPROVED`；Review 只提供审查结论，没有直接完成 Task。
6. Integration `06f867b4-c38b-4ada-8618-083d4632a2fb` 从预期 head `79981f...` 提交到 `e6967d...`。
7. integration check 与 final run check 均在绑定 tree 上 `PASSED`。
8. `AcceptanceDecision.result=ACCEPTED`，Task 进入 `ACCEPTED`，Run 进入 `COMPLETED`。

三份 Pi session 均记录 `deepseek/deepseek-flash`。用户 checkout 始终停留在原始输入提交，运行结束没有遗留 Worker worktree。随后又从最终 integration commit 建立独立 detached worktree 执行 `npm test`，1/1 通过。

## 场景 2：两个 Agent 真并行 — PASS

- repository：`/tmp/agent-orchestrator-real-e2e.ADNz5U/parallel-pass-repo`
- Run：`ad0f1f2d-3220-4e9d-b2a4-d7f3e9c6ff56`
- shared input commit：`83b13530d11a44d48207c946965bde90bdd403de`
- final integration commit：`8e958cdc72756503d6d0cf68017a9294a4697ef4`

两个 Implementer execution 的实际时间窗口重叠：

| Attempt | Execution 开始 | Execution 结束 | Candidate commit |
|---|---|---|---|
| `973c039d-7f5e-434c-832f-8b6a61f55145` | `15:40:29.938Z` | `15:40:39.075Z` | `fbc548d4b7668637cc886fc4fdd5ae079b6534c3` |
| `48d00457-9807-4164-af2d-240aead2e051` | `15:40:29.940Z` | `15:40:37.320Z` | `e2c31b53b0f028f68b63694bb7e3af7f929ee980` |

它们具有不同的 Attempt、Pi session、worktree 和 Candidate：

- greeting Candidate `c20740e9-0d86-4766-b095-8544ff98cd74`，tree `e6ac76b245318dba9cbfd4e57d8817ba2dd3736e`，只改变 `greeting.js` 与 `greeting.test.js`。
- math Candidate `7c18a07e-e246-4229-92fb-7f362fa1343c`，tree `8dc1d320b615ce2a1cfd125de74b6569a58fa99b`，只改变 `math.js` 与 `math.test.js`。

两个 session 都记录 `deepseek/deepseek-flash`。两个 Candidate 并行产生，但 integration 由控制面安全串行：

1. 第一笔从 input head 集成，结果为 `8d84680b411867acf7c88135fa98b67ae1fce18f`。
2. 第二笔的 `expected_head` 是第一笔结果 `8d84680b...`，而不是旧 input head。
3. 第二笔生成新的合并 tree `b5267b13dafac310de8e1585d4d000155e803798`，最后提交为 `8e958cdc...`。

两个 Task 均 `ACCEPTED`，Run 为 `COMPLETED`。从最终 ref 建立 detached worktree 后再次执行 `npm test`，4/4 通过；用户 checkout 未被切换，Worker worktree 无泄漏。

### 被丢弃的红基线 fixture

第一次并行 fixture 在 base 中预先放入了两个失败的“未来测试”。当一个 Agent 完成自己的任务时，全局 Candidate check 仍会被另一个尚未完成的测试击败，系统因此正确阻止 acceptance。该 Run `dc72723b-f225-4f82-a4ac-ccde16649aea` 不计为产品失败，也不计入 PASS；它说明全局验收命令的基线必须是 green，或者由项目明确声明任务级检查。随后改用 green-base fixture 重新完成上述真实并行验收，没有为迎合 fixture 修改产品语义。

## 场景 3：Attempt epoch — PASS

- repository：`/tmp/agent-orchestrator-real-e2e.ADNz5U/epoch-repo`
- Run：`06234634-7d48-4aad-bb07-4990efb507de`
- final integration commit：`2bb15758707c512ce71476b6763d8859f636827d`
- 被接管 Task：`e8bd57c9-9fb2-4ea7-b9da-b02e0c9672f0`

在旧 Pi execution 仍为 `LIVE` 时，控制面主动撤销 epoch 1 Attempt `31dce110-b1d8-4bc9-bb31-c5588319dce8`，将其标记为 `FAILED` 并重新开放 Task。旧 Pi 进程随后仍真实完成并封存 commit `891015855e145d96195fa691571a29f72b6ccc2b`，但它不再具有 authoritative writer 权限。

验证结果：

- epoch 2 Attempt `f41c6236-9b40-40a2-97ea-857cd0870ff9` 成为新 owner 并成功提交。
- 用旧 epoch 的真实 commit/tree 再次提交时，kernel 返回 `DomainInvariantError` / `NOT_ACTIVE_ATTEMPT`，信息为 `Attempt is not the active writer for this task`。
- 旧 Attempt 通过真实 attempt-scoped control bridge 再发状态消息时返回 HTTP 400：`Only a running attempt can send a message`。
- 数据库中旧 Attempt 的 authoritative Candidate 数量为 0。
- 新 epoch Candidate 正常验证、集成并验收；Run 最终 `COMPLETED`。

最终 ref 的 detached worktree 测试 4/4 通过。

## 场景 4：Crash / Resume — PASS

### 4A. Worker 执行阶段强杀 daemon

- repository：`/tmp/agent-orchestrator-real-e2e.ADNz5U/crash-pass-repo`
- Run：`9e17bd2e-3dc7-497a-9896-8972b249c603`
- final integration commit：`4fcbc9e78a91fef6c674a1b57ad9c943dafc20c2`

在 daemon PID `1204346` 被 `SIGKILL` 前，Attempt `da7a4462-f84b-4ced-a406-e8af02f4d2c5` 为 epoch 1，Execution `e74f9733-01d4-4d5b-b74c-c24a3339c830` 为 `LIVE`，Pi session 文件与 worktree 已存在，`START_WORKER` operation 仍为 `RUNNING`。强杀后确认没有遗留 Pi 子进程。

重启并执行 `continue` 后的 reconciliation：

- `interruptedOperations=1`
- `lostExecutions=1`
- `failedAttempts=0`
- `resumableAttemptIds` 包含原 Attempt
- `recoveredIntegrations=0`
- `rejectedCandidates=0`

恢复保持了同一 Attempt、epoch、Pi session 与 worktree；旧 Execution 进入 `LOST`，新 Execution `c14a69cf-efe9-4055-9e26-f8992a2f3c03` 在同一 session 上继续并以 code 0 结束。`START_WORKER` operation 最终 `COMPLETED`，attempts 从 1 增至 2。恢复后的 Candidate 经过完整验证与串行集成，Run `COMPLETED`。最终 ref detached 测试 4/4 通过。

### 4B. Integration 验证阶段强杀 daemon

- repository：`/tmp/agent-orchestrator-real-e2e.ADNz5U/crash-integration-repo`
- Run：`5ce4c6d6-e6b6-4811-92e2-a0ee0c171ad7`
- final integration commit：`6c9ed5526b2cb10a011d63d62483adecd71c4de1`

该 fixture 的 integration check 是一个真实的 12 秒慢检查。daemon 在 Integration `f7914fc0-4765-4264-8e5c-e13eab28c925` 为 `APPLYING` 时被强杀；此时 Candidate `7813281f-1d3a-4f97-a1a8-99306f7afea0` 已 `ELIGIBLE`，但尚无 durable publish intent。

恢复后：

- 旧 Integration 被确定性标记为 `FAILED`，原因是 `Integration was interrupted before a publish intent was durable`。
- 旧 Candidate 被标记为 `REJECTED`，没有 integration PASS evidence，也没有 AcceptanceDecision。
- Task 重新开放，epoch 2 产生新 Candidate `508cd4e9-1536-4c2d-b6b2-98f230e7c1f2`。
- 只有新 Integration `cb1f1499-584c-412f-979b-f346cdd5dee5` 获得 integration PASS 和系统 AcceptanceDecision。
- Run 最终 `COMPLETED`。

最终 ref 在独立 detached worktree 中再次通过 `npm test` 和真实 `node slow-check.mjs`。

## 场景 5：Stale integration — PASS

场景 2 同时构造了要求的 stale-head 条件：两个 Candidate 都基于 `83b13530...`，第一笔成功后 authoritative integration head 已改变。

关键证据：

- 第二笔 Integration 的 `expected_head` 持久化为新 head `8d84680b...`，没有继续对旧 base 做 CAS。
- 第二个 Candidate 自身的旧证据绑定 Candidate tree `8dc1d320...`。
- 应用到新 head 后产生的 integration tree 是 `b5267b13...`，与 Candidate tree 不同。
- 系统在 `b5267b13...` 上创建并执行了新的 `subject_kind=INTEGRATION` check，随后 final run check 也绑定同一个最终 tree。
- 因而旧 Candidate evidence 没有被当成 post-integration evidence 复用。

这证明当前实现不是“两个 Agent 并行后直接移动 ref”，而是 Candidate 并行、integration 线性化、head 变化后重建结果并重新验证。

## 发现的问题与修复

### 已修复：崩溃后 persistent Pi session lock 阻止 resume

第一次 worker crash 验收暴露真实缺陷：daemon 被 `SIGKILL` 后，SQLite reconciliation 正确保留了可恢复 Attempt，但 `PiWorkerLauncher` 获取 persistent session lock 时没有请求回收 dead owner。旧锁中的 PID 已死亡，launcher 仍报 `Persistent subagent session ... is already running`，最终使 Attempt 失败、Run `BLOCKED`。

修复：`PiWorkerLauncher.create` 调用复用的 `PersistentSessionGuard.acquire` 时启用 `{ recoverDeadOwner: true }`。上游 guard 只会在 owner PID 已死亡且双重读取的 token 一致时删除陈旧锁；活 owner 的并发 session 仍会被拒绝。本项目没有重写 lock 协议。

新增 contract test：`Pi worker launcher recovers a session lock owned by a dead control process`。同时保留原有“双 owner 必须拒绝”的测试。修复后重新从头执行 4A，成功恢复同一 Attempt/session；测试总数由 37 增至 38。

### 无需产品修复：并行 fixture 的红基线

前述第一次并行 fixture 是验收输入设计错误。控制面阻止带失败全局检查的 Candidate 正是预期行为。解决方式是修正 fixture 的基线，不是放松验证门禁。

### 验收纠偏：旧模型单 Agent 试跑不计入结果

最早一次单 Agent 试跑发生在模型设置纠正前，session 明确记录旧模型 ID。该运行没有被包装为 Flash 结果；切换到官方 `deepseek-flash` 后重新执行完整场景 1，并以新 Run `856855b3-...` 作为本报告证据。

## 最终独立复验

控制面完成后，又直接从 final integration ref 创建独立 detached worktree，绕过用户 checkout 和 Worker worktree执行仓库测试：

| 最终 ref | 独立复验 |
|---|---|
| single `e6967dd...` | `npm test`，1/1 PASS |
| parallel/stale `8e958cd...` | `npm test`，4/4 PASS |
| epoch `2bb1575...` | `npm test`，4/4 PASS |
| crash/resume `4fcbc9e...` | `npm test`，4/4 PASS |
| integration-crash `6c9ed55...` | `npm test`，1/1 PASS；`node slow-check.mjs` PASS |

所有正式计入的运行都保持用户 checkout 不变，结束时无 Worker worktree 和 Pi 子进程泄漏。

项目自身的最终交付检查也全部通过：

- `npm run check`：TypeScript typecheck 与 Biome lint PASS。
- `npm test`：当前完整套件 51/51 contract/regression tests PASS，0 fail/skip/cancel；原始真实 E2E 验收时为 38/38，之后新增的是上层协调与验收门禁回归覆盖。
- `npm run build`：CLI、daemon、control extension 三个生产 bundle 构建成功。
- `node dist/cli.js doctor`：Node、Git、官方 Pi CLI 路径与 SQLite 均正常。

## 当前能力判断

| 能力 | 判断 | 证据 |
|---|---|---|
| 真实 multi-agent 并行 | YES | 两个真实 Pi execution 时间重叠，不是顺序 mock |
| session/worktree/Candidate 隔离 | YES | 两个 Attempt 各自拥有独立资源与 immutable Candidate |
| authoritative ownership | YES | epoch 1 真实旧进程结束后仍不能写入 authoritative state |
| daemon crash/resume | YES | SQLite/operation/worktree/session 对账，同 Attempt 新 Execution 恢复 |
| integration crash safety | YES | 无 durable publish intent 的 APPLYING integration 被失败关闭，未误验收 |
| evidence correctness | YES | Candidate、Integration、Run CheckRun 均绑定具体 tree；输出为 content-addressed Artifact |
| stale-head 安全集成 | YES | integration CAS 串行；新合并 tree 必须产生新 evidence |
| acceptance 独立于 Agent 声明 | YES | 只有通过 verification/review/integration gate 的系统 decision 才接受 Task |

当前版本进一步将终态投影收紧为 `VERIFIED_DELIVERY`、`STRUCTURAL_HANDOFF`、`BLOCKED` 或 `CANCELLED`：只有绑定最终 tree 的 `BEHAVIORAL` / `EXTERNAL` run evidence 才能得到 `VERIFIED_DELIVERY`。这项分类是原始 E2E 之后加入的控制面语义，不应倒推为当时已经执行的新 benchmark 结果。

## 本次没有声称完成的范围

- 没有做 CooperBench 或其他 benchmark，也不讨论模型优劣。
- 没有验证 OS 级 sandbox；当前通过 tool/profile/worktree/control capability 做产品边界隔离，不能把它表述成内核安全沙箱。
- 没有验证所有语言、构建系统和超大真实仓库；这属于接下来的正式跑题覆盖面，而不是本次核心状态机验收的替代条件。
- 没有新增自动语义冲突解决。冲突应被显式标记和重新处理，不能由系统静默猜测。

最终判断：**通过正式跑题测试前的核心工程验收，可以开始用真实项目题目继续验证；无需再修改冻结架构。**
