# TripleTeam / Codex / Claude Code 基线运行配方

核对日期：2026-09-22。本文提供可复现的运行与比较协议；**三套产品的正式对照尚未运行，结果表保持为空**。下面标为执行阶段的命令会调用模型，本次只核对本机版本、CLI 帮助和官方文档。

## 1. 先区分两种结论

| 实验 | 固定条件 | 可以回答 |
|---|---|---|
| 产品对比 | 相同任务、环境、预算协议、验收；分别记录模型和 CLI 配置 | 用户采用哪个“系统 + 模型”组合更有效 |
| 机制消融 | 同一 Pi、模型/provider/reasoning、工具和验收，仅改变控制策略 | 调度、契约、失败适应分别带来什么收益 |

不同模型上的产品胜负不能归因于 TripleTeam 的算法。即使模型显示名称相同，也应核对 endpoint、完整模型 ID、reasoning 和实际返回的模型标识；不同产品的 `high` 不是已证明相同的计算量。

优先使用固定版本官方 benchmark 已有的 Codex／Claude Code 入口。这样可以复用其容器准备、题面传递、缓存清理和补丁提取规则：[FeatureBench inference adapters](https://github.com/LiberCoders/FeatureBench/tree/8d4e347ec57546685c5a87e8676bf575db022ea6/featurebench/infer/agents)、[SWE-Milestone agent adapters](https://github.com/DeepCommit-ai/SWE-Milestone/tree/17a8f1593e172e26b36cea15e2b30fb9536c93f5/harness/e2e/agents)。TripleTeam 的接入见 [BENCHMARK_ADAPTERS.md](BENCHMARK_ADAPTERS.md)。

## 2. 每个对照必须冻结的共同输入

- benchmark、evaluator commit、data revision／digest、相同实例集及重复编号；保存题面和每题 starter tree 的哈希。
- 相同容器 image digest、CPU／内存、网络出口规则、源码可见范围、公开测试、独立隐藏 evaluator。
- 每套系统从同一个已遮蔽 starter 的独立副本开始；不得共用前一个系统修改后的代码、历史会话、缓存中的答案或失败反馈。
- 固定 CLI／系统 revision、完整模型 ID、reasoning、工具／MCP／插件／skills 配置和是否允许原生子 Agent。允许使用的子 Agent 调用全部计入总账；不要用我方并行对比被人为禁用正常能力的基线。
- 关闭人工回答、人工 steer、人工代码修复；需要人才能继续的任务保留为未完成。权限按官方 benchmark 容器配方预先配置，并记录实际配置。
- 固定总墙钟 deadline、计费方式、重复次数、失败／超时处理；一个系统尝试只提交一份最终补丁。

FeatureBench 需要先执行官方遮蔽准备；数据中的原始 `base_commit` 含被删除功能，不能直接交给模型。SWE-Milestone 必须保留连续代码、官方释放队列和 `early_unblock` 配置。两种 benchmark 不合并成一个平均百分比。

## 3. 三套系统的执行配方

### 3.1 先保存本机版本（无模型调用）

已实际核对：`codex-cli 0.155.1`、`Claude Code 2.1.278`。这些是本次配方的版本，不表示未来应自动升级到 latest。

```bash
codex --version
claude --version
codex exec --help
claude --help
git -C /path/to/TripleTeam rev-parse HEAD
```

正式运行应固定相同版本的软件包或容器，并将以上输出写入实验记录。验证部署中的实际版本；不能只记录“请求安装的版本”。产品有本地未提交修改时，先固定该源码快照，避免同一 commit 名下对应不同实现。

### 3.2 公共变量

以下是 Linux 容器中的 Bash 配方。先将占位路径和模型 ID 替换为实际配置。每套系统使用不同的 `TASK_REPO` 和 `RUN_DIR`，其他实验条件保持一致。日志目录位于题目仓库之外。

```bash
TASK_REPO=/prepared/task-repository
TASK_TEXT=/public/TASK.md
RUN_DIR=/outputs/one-system-one-instance
MODEL=EXACT_MODEL_ID
EFFORT=high
WALL_SECONDS=7200
BUDGET_USD=10
mkdir -p "$RUN_DIR"
```

示例预算仅用于展示命令参数，未被实验证明足够。`timeout` 控制该调用的墙钟时间；正式控制整个容器／进程组的停止与排空，避免后台子进程在主 CLI 退出后继续运行和计费。启动、重试、检查、集成以及最终提交封存的时间都应记录；冷启动环境准备时间单列，三套系统使用相同口径。

### 3.3 TripleTeam

在准备好的仓库中放置固定 `.tripleteam.json`，其中 `execution.decisionMode` 为 `noninteractive`，模型、reasoning、总预算和所选策略明确填写。保存规范化配置哈希并冻结 manifest 后执行：

```bash
TRIPLETEAM_ROOT=/path/to/TripleTeam
TASK_JSON=/public/task.json
FROZEN_MANIFEST=/experiment/tripleteam-manifest.json
node "$TRIPLETEAM_ROOT/dist/benchmark.js" config-hash "$TASK_REPO"

set +e
timeout --signal=TERM --kill-after=30s "$WALL_SECONDS" \
  node "$TRIPLETEAM_ROOT/dist/benchmark.js" featurebench-run \
  "$TASK_REPO" "$TASK_JSON" "$FROZEN_MANIFEST" "$RUN_DIR" \
  > "$RUN_DIR/events.jsonl" 2> "$RUN_DIR/stderr.log"
run_exit=$?
printf '%s\n' "$run_exit" > "$RUN_DIR/exit-code.txt"
```

内部规划、探索、writer、reviewer、失败重试共享预算。封存必须使用数据库中权威 integration head。超时后先结束 worker、完成恢复对账，再导出终态；不能把仍在运行的 run 当作最终提交。原始 CLI 退出码、BLOCKED／CANCELLED／ERROR 与已有部分结果均需保留。

### 3.4 Codex CLI 0.155.1

在官方准备的非交互权限环境中运行。下面使用官方推荐的显式 `workspace-write` 模式；若 benchmark adapter 使用不同的外部容器隔离／权限配方，记录并复用其确定配置。[官方非交互说明](https://learn.chatgpt.com/docs/non-interactive-mode)

```bash
set +e
timeout --signal=TERM --kill-after=30s "$WALL_SECONDS" \
  codex exec --json --model "$MODEL" \
  --config "model_reasoning_effort=\"$EFFORT\"" \
  --sandbox workspace-write -C "$TASK_REPO" - \
  < "$TASK_TEXT" > "$RUN_DIR/events.jsonl" 2> "$RUN_DIR/stderr.log"
run_exit=$?
printf '%s\n' "$run_exit" > "$RUN_DIR/exit-code.txt"
```

题面从 stdin 传入。`--json` 用于保存事件流；必须另外冻结实际生效的用户／项目配置、工具、网络能力及原生协作设置。避免继承个人会话、个人记忆或不可审计的外部连接。

**该核对版本没有与 Claude 的 `--max-budget-usd` 等价的已验证命令参数。** 上面命令实现时间限制，不能声称已实现公平美元上限。美元预算对照需由共同的计费 gateway／proxy 记录并约束所有模型调用；没有该能力时，报告“同 deadline 对照”，费用作为事后测量值。

### 3.5 Claude Code 2.1.278

在官方 adapter 已配置好非交互编辑／命令权限的题目容器内运行，工作目录为题目仓库。题面从 stdin 传入：

```bash
set +e
(
  cd "$TASK_REPO" || exit 1
  timeout --signal=TERM --kill-after=30s "$WALL_SECONDS" \
    claude -p --model "$MODEL" --effort "$EFFORT" \
    --output-format stream-json --verbose --max-budget-usd "$BUDGET_USD" \
    < "$TASK_TEXT"
) > "$RUN_DIR/events.jsonl" 2> "$RUN_DIR/stderr.log"
run_exit=$?
printf '%s\n' "$run_exit" > "$RUN_DIR/exit-code.txt"
```

`-p` 是非交互执行，`stream-json` 保存结构化事件。[官方 headless 文档](https://code.claude.com/docs/en/headless) `--max-budget-usd` 适用于 print 模式，子 Agent 开销计入；恢复会话时，历史恢复总额不计入这次上限。因此连续任务／多次 resume 仍需累计全局账单，每次只分配剩余预算，或使用共同 gateway。[官方 CLI 参数说明](https://code.claude.com/docs/en/cli-reference)

正式对照中记录是否有权限拒绝和未执行工具。由权限配置导致不能编辑／不能测试的运行属于基础设施条件问题，不能隐去后只报其他成功任务，也不能把这种弱化配置当作竞争产品的正常能力。

## 4. 计费、封存和独立验收

共同计费账应覆盖每个外部实例／campaign 的全部请求，包括主 Agent、子 Agent、planner、review、重试、恢复、失败、cache、reasoning 和仍在途的调用。记录计价日期、模型价格表、缓存价格及硬件资源；比较 subscription 时另报额度／实际支出，不能把订阅请求计为免费。

Codex `turn.completed.usage` 是事件中的用量信息，不自动证明已经覆盖所有子会话、重试和未完成请求；Claude 的终态 cost 也应核对其会话范围。使用 provider／gateway 账单对账，避免缓存 token 双重计费和将不同 tokenizer 的 token 数当作同一计算单位。账单缺失记为 `UNKNOWN`，保留已知费用下界；不得填 0 或据此宣称节省。

| 运行轨道 | 可执行的约束 | 可以比较 |
|---|---|---|
| 同时间 | 三套系统相同外层 deadline／资源；实际费用完整记录 | deadline 内完成率、实际支出、费用与速度分布 |
| 同美元预算 | 共同 gateway 对全部调用做累计计费／准入，记录在途超限 | 相同总预算下的严格完成率、成功交付成本 |
| 本地原生预算 | 各产品自己的能力；明确 Codex 暂无相同已验证 dollar flag | 产品运行事实；不得标为已统一美元上限 |

Agent 停止且所有后台进程结束后，由官方 adapter 从最终工作树提取唯一补丁。独立裸 CLI 调试时，可先 `git add -A`，记录 `git write-tree`，然后相对于固定的 masked baseline 导出 `git diff --cached --binary BASE_COMMIT`；原始日志和控制文件必须放在仓库之外。TripleTeam 始终通过自己的权威集成树导出。

把这份封存补丁交给独立 evaluator。FeatureBench 使用 `n_attempt=1` 和 `--include-failed`；内部执行多少次都计入这一份系统尝试。缺失、超时、BLOCKED 和运行错误保留在预先固定的任务分母中。SWE-Milestone 使用官方宏平均，不能用单个 milestone 的微平均替代。

## 5. TripleTeam 固定策略和两项消融

| 变体 | `execution` 差异 | 实际含义 |
|---|---|---|
| SINGLE | `policy: "SINGLE", maxParallelism: 1` | 一个全目标 writer Task，初始化不调用模型 planner／explorer；保留相同 review、检查、重试及总预算 |
| HEURISTIC | `policy: "HEURISTIC"` | 结构／语义规则控制并行，作为无边际收益估算的对照 |
| FIXED-2 / FIXED-4 | `policy: "FIXED", maxParallelism: 2 / 4` | 固定并行上限，仍遵守就绪依赖、所有权和语义兼容要求 |
| ADAPTIVE | `policy: "ADAPTIVE"` | 使用依赖、成本、历史运行信号估算下一份计算价值；当前是可解释估算策略，没有训练出学习策略 |
| ADAPTIVE 无契约机制 | `enableContracts: false` | 关闭额外 artifact 契约机制，单列其对返工及联合成功的影响 |
| ADAPTIVE 无失败适应 | `enableFailureAdaptation: false` | 使用有界 retry／infra-retry／block 对照，关闭依据失败原因切换后续计算的策略 |

所有变体固定模型、provider、reasoning、公开信息、候选／集成／最终验收、review、允许 scope 及总预算；分别生成独立 manifest。FIXED 的数字是并行上限，实际运行 Agent 数应从 trace 读取。SINGLE 保留同样的失败预算和验收机会，避免成为只给一次答题机会的弱对照。

以下 Python 标准库命令只生成配置，不启动模型。`BASE_CONFIG` 是已经填写模型、预算和检查的完整项目配置；保留原配置中的验收设置：

```bash
BASE_CONFIG=/experiment/base.tripleteam.json
VARIANT_DIR=/experiment/variants
python3 - "$BASE_CONFIG" "$VARIANT_DIR" <<'PY'
import copy, json, pathlib, sys
base = json.loads(pathlib.Path(sys.argv[1]).read_text())
policy = base["execution"]
for key in ("model", "provider", "reasoning", "costLimitUsd", "tokenLimit", "deadlineMs", "maxExecutions"):
    if key not in policy:
        raise SystemExit("Missing frozen execution field: " + key)
common = dict(policy, decisionMode="noninteractive", policy="ADAPTIVE",
              maxParallelism=4, enableContracts=True, enableFailureAdaptation=True)
variants = {
    "single": {"policy": "SINGLE", "maxParallelism": 1},
    "heuristic": {"policy": "HEURISTIC"},
    "fixed-2": {"policy": "FIXED", "maxParallelism": 2},
    "fixed-4": {"policy": "FIXED", "maxParallelism": 4},
    "adaptive": {},
    "adaptive-no-contracts": {"enableContracts": False},
    "adaptive-no-failure-adaptation": {"enableFailureAdaptation": False},
}
output = pathlib.Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
for name, changes in variants.items():
    config = copy.deepcopy(base)
    config["execution"] = dict(common, **changes)
    with (output / (name + ".json")).open("x") as target:
        json.dump(config, target, ensure_ascii=False, indent=2)
        target.write("\n")
PY
```

将选定配置放入一个新准备的仓库，再执行 `tripleteam-benchmark config-hash REPOSITORY`，把得到的 `executionConfigHash` 写入该变体的 manifest 并 `freeze`。已初始化 run 的配置被冻结；不要原地换策略后继续旧 run。正式测试集不用于选择这些变体的参数。

## 6. 尚无结果的对照表

同一张表只放相同 benchmark／数据 revision／实例集／预算轨道的结果。空白表示尚未测量；缺账应标 `UNKNOWN`，没有足够外部验收应标 `INCOMPLETE`。

| 系统／变体 | CLI／源码版本 | 完整模型 ID／reasoning | 计划实例 N | 严格解决数／N | 官方 Score／部分通过率 | 总费用及完整性 | 每成功交付成本 | deadline 内解决率 | p50／p90 墙钟 | 失败／超时／BLOCKED |
|---|---|---|---|---|---|---|---|---|---|---|
| Codex | 0.155.1 |  |  |  |  |  |  |  |  |  |
| Claude Code | 2.1.278 |  |  |  |  |  |  |  |  |  |
| TripleTeam SINGLE |  |  |  |  |  |  |  |  |  |  |
| TripleTeam HEURISTIC |  |  |  |  |  |  |  |  |  |  |
| TripleTeam FIXED-2 / FIXED-4 |  |  |  |  |  |  |  |  |  |  |
| TripleTeam ADAPTIVE |  |  |  |  |  |  |  |  |  |  |
| ADAPTIVE 无契约 |  |  |  |  |  |  |  |  |  |  |
| ADAPTIVE 无失败适应 |  |  |  |  |  |  |  |  |  |  |

逐实例保存字段：`benchmark / data_revision / instance_id / replicate / system / cli_version / model / reasoning / policy_hash / image_digest / input_tree / output_tree / patch_sha256 / exit_status / runtime_state / external_resolved / partial_score / cost_known / cost_complete / elapsed_ms / timeout / human_interventions / usage_receipts`。长期任务另存后续回归、恢复次数与额外费用；返工与集成占比作为机制解释。

最终至少画两组曲线：**累计总预算 → 严格完成率**、**deadline → 严格完成率**。费用要包含失败任务；墙钟分布不能只画成功者而隐藏超时。总费用除以成功数仅在账单完整、所有计划实例结果齐备且成功数大于 0 时计算。SWE-Milestone 按仓库／演化范围处理相关性，不能把连续 milestone 当作独立样本夸大显著性。

本次单题 subagent 盲测记录见 [开发检查报告](validation/2026-09-22-blind-featurebench.md)。它使用独立官方 evaluator，但没有经由 TripleTeam 的 Pi 执行路径，因此不会填进以上产品对照表。
