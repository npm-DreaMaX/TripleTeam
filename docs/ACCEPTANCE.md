# 验收与演示

TripleTeam 的交付入口是独立 CLI；执行由 vendored Pi 驱动。本页把代码机制、真实任务交付和正式模型评测分成可复现的验收步骤。

## 1. 安装与工程检查

```bash
npm install --ignore-scripts
npm run check
npm test
npm run build
node dist/cli.js doctor --json
node dist/benchmark.js --help
```

`doctor` 离线检查 Pi 实际使用的搜索工具。安装 `rg` 与 `fd`/`fdfind`，或准备当前 `PI_CODING_AGENT_DIR` 下的 Pi 工具缓存。切换 Agent 配置目录时，该目录的工具缓存也会变化。

完整验证隔离检查还需要固定 Python Docker 镜像：

```bash
docker pull python:3.13-slim
ATLAS_IMAGE="$(docker image inspect python:3.13-slim --format '{{.Id}}')"
TRIPLETEAM_TEST_DOCKER_IMAGE="$ATLAS_IMAGE" npm test
```

将实际 image ID 保存到验收记录；测试使用这个不可变 ID。没有该环境时，相关 Docker 用例会明确 skip，不能记为完整通过。

## 2. 可运行的跨模块产品演示

```bash
node dist/cli.js demo create /tmp/atlas-demo "$ATLAS_IMAGE"
```

这会创建独立 Git 仓库，包含一个可用的同步报表服务、HTTP 入口、SDK、公开规格和冻结验收测试。目录必须尚不存在。无参数的 `tripleteam demo` 仍为界面预览；`demo create` 创建真实任务，不调用模型，也没有附带答案。

在该目录中配置模型并启动：

```bash
cd /tmp/atlas-demo
tripleteam model all YOUR_PROVIDER/YOUR_MODEL high
tripleteam
```

输入：

```text
Implement the asynchronous report export workflow in SPEC.md across contracts, jobs, HTTP API and SDK. Preserve existing behavior and pass the frozen final acceptance checks. Keep supplied tests unchanged.
```

所有角色可独立配置 provider/model；详见 [模型配置](CONFIGURATION.md)。演示默认限制为 3 个 writer、200 万累计 token、$5 模型估算费用、20 分钟和 30 次 execution。这是可调整的演示额度，不能保证每种模型都能完成。累计 token 包括每次调用的缓存读取；它不是最终代码长度。

### 演示时展示什么

1. **输入一个完整工程目标。** 实现异步提交、状态与进度、下载、取消、失败重试、幂等键、SDK 有界轮询和并发取消语义，保留同步接口。
2. **`/tasks` 与 `/why`。** 展示实际任务图、调度理由、当前真实 writer 进程数、可选验证计算的分配理由及最终树上尚未通过的检查。以实际策略为准；小任务采用 SINGLE 也可能是正确分配。
3. **`/events` 和 `/artifacts`。** 若本次遇到失败，查看失败证据和下一步动作。故障恢复可在执行期间中断 CLI，再 `/continue`；恢复不改变冻结预算，也不授予旧进程提交权。
4. **`/delivery`。** 查看交付分支与 evidence manifest。用 `git show` 审查真实代码；最终检查通过的树必须和 delivery tree 相同。
5. **运行交付代码。** 从交付 ref 创建新 worktree，再执行下列验收。不要在原始输入 checkout 上运行新功能。

```bash
git worktree add /tmp/atlas-delivery refs/heads/tripleteam-deliveries/RUN_ID
cd /tmp/atlas-delivery
python3 -B -m unittest discover -s tests -v
python3 -B showcase.py
```

`showcase.py` 启动同进程 HTTP 服务和后台 tick，通过真实 HTTP SDK 完成提交、轮询与下载，然后退出。规格要求线程安全的内存任务队列，不要求持久队列；单独执行 `python3 -B -m atlas.api` 时只有 HTTP 服务，没有 tick。

未指定 Docker 镜像时可以运行 native 演示，其检查证据最多为 BUILD，最终报告相应为 `STRUCTURAL_HANDOFF`。固定镜像、冻结 oracle 和只读源码允许行为证据进入 `VERIFIED_DELIVERY` 判定。这个状态仍只证明配置的验收义务，不等于任意隐藏测试都正确。

## 3. 机制验收点

| 机制 | 可检查的事实 | 回归位置 |
| --- | --- | --- |
| 阶段验收 | scope 选取检查；atomic 合并；全局失败不被拆图绕过；Kernel 拒绝删减冻结条件 | `test/planning/increments.test.ts` |
| 阶段探针 | TASK 在增量执行；FINAL 等待下游；最终树必须通过全部探针；禁止把所有义务推迟 | `test/verification/assurance.test.ts` |
| 环境准备 | 干净 worktree 执行冻结 preparation；源代码变化被拒绝；环境错误先于模型计算 | `test/verification/{baseline,check-runner}.test.ts` |
| 分配额外计算 | 为剩余 writer/review/终验估计开销；高风险和 required 条件不可因预算而免除 | `test/control/compute-allocation.test.ts` |
| 复用探索 | 同问题/版本/上下文与 Git 读取依赖才能复用；新上下文、搜索范围变化会失效；复用省掉真实 launcher 调用 | `test/runtime/read-observations.test.ts`、`test/planning/planning-allocation.test.ts` |
| 合同与集成 | 消费者取得准确 blob/check/version；变更传播到消费者复验；CAS 串行发布 | `test/control/authority-budget-contracts.test.ts` |
| 恢复与最终验收 | stale execution、崩溃恢复、最终修复、非交互权限约束 | `test/control/`、`test/verification/` |
| 评测账本 | 全部计划样本、失败费用、完整配置、准确树与外部判分绑定 | `test/benchmark/` |

## 4. 面试中的演示回答

**“Codex 能不能做这个功能？”** 能，应该让它在相同输入与预算下实际做。这里展示的贡献是把任务粒度、额外计算、接口兑现、失败修复和外部验收形成一个可观察、可消融的执行系统。是否值得用户采用，由完整交付率、费用、延迟、恢复效果和操作负担决定。

正式比较先跑 [Benchmark 指南](BENCHMARK_GUIDE.zh-CN.md)。本页演示有公开验收测试，不能作为盲测分数或领先竞品的证据。
