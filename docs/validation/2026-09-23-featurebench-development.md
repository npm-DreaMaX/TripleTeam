# FeatureBench 真实 API 开发试跑记录（2026-09-23）

## 结论

**五次开发试跑均以 BLOCKED 结束，最终没有可交付的代码变更。** v5 的权威 integration head 仍是已遮蔽输入基线；只将该权威版本导出，得到 **0 字节补丁**。封存后运行一次固定官方 evaluator，结果为 **未解决，0 / 1**，并明确归类为“空补丁未应用”。失败 writer 的 candidate 没有替代最终提交。

这次执行实际经过 TripleTeam/Pi 和 `deepseek / deepseek-flash / high`，有真实模型费用。它是**同一道题上的五次开发调试**，期间调整了运行时代码、配置及工具环境，不能称为正式公平 benchmark、pass@1，或优于 Codex／Claude Code 的证据。JSONL 中 `n_attempt=1` 仅表示向 evaluator 提交了一份封存产物。

五次合计已记录费用为 **$0.728481 的已知下界**；其中 v5 为 **$0.422066 的已知下界**。共 **9 条 Agent 用量记录不完整**，不能将缺失部分计为零或据此计算节省比例。此次没有成功交付，每成功交付成本不作计算。

## 1. 任务与隔离

- 实例：`pypa__hatch.ff4b4040.test_fmt.782c88a8.lv1`，FeatureBench v1.1 `fast`。
- 数据 revision：`76b4a4566e04f4bcc13c35125d4f301791efa736`。
- fast parquet SHA-256：`d775855a031b0fb5932ff7fdf4512ce733fbc6716528395bf15cbad22df5d2c3`。
- 固定 evaluator commit：`8d4e347ec57546685c5a87e8676bf575db022ea6`。
- 官方镜像：`libercoders/featurebench-specs_hatch-instance_02086956@sha256:70c443280ebe701fe0b6ca24d22c139f3b5c92817a5c1c16c2fc5762b67a4fb1`。

准备器仅依据仓库／环境元数据选择新题，调用固定官方 `RuntimeHandler.initialize_runtime(white_box=False)` 与 `clear_package_caches`。机械检查确认隐藏文件、原始 `/root/my_repo`、遮蔽补丁及缓存已移除，Git 重建为单一基线提交。**本次独立准备及元数据统计代理**没有打开题面、实现源码、探针定义或 Agent 对话正文；这项说明只覆盖本次准备／统计工作，不对所有历史参与者作笼统断言。执行模型需要从文件读取公开题面和源码。

执行容器与宿主题库、evaluator 目录隔离；准备时无宿主挂载。最初准备快照是普通 bridge，随后执行方配置了受限网络。独立复核仅读取 Docker 网络／端口字段，确认当前 solver **只连接 `--internal` 网络 `tripleteam-blind-20260923`**；代理 `tripleteam-deepseek-proxy-20260923` 同时连接该 internal 网络和外部 bridge，双方均无宿主端口映射。保留的 TLS CONNECT 代理配置只允许 `api.deepseek.com:443`，其他方法／目标返回 403。

网络创建时间及代理配置文件时间早于 v1 启动，但没有每次试跑的网络快照。因此，上述证据能核实**当前拓扑及保留的出口策略**，不能独立证明五次历史运行中所有时刻的接线和已加载代理字节始终不变，也不等于已复现完整官方 inference 网络协议。复核未导出环境变量或凭证，详见[网络核对记录](/tmp/tripleteam-featurebench-eval-20260923/network-verification.json)。

各 run 的 `human=false` 表示没有在运行内回答任务问题；这不抹去 run 之间由外部控制者进行的开发修复和调参。评分前没有向执行模型提供隐藏反馈，评分后没有修补或重交。

## 2. 保留全部五次试跑

费用按 Pi 的运行用量账本统计，尚未与 provider 的最终账单独立对账。Token 数包含 input、output、cache read、cache write；它不等同于未缓存输入量，也不能直接当作不同模型之间的同一计算单位。

| 开发试跑 | 终态 | Task / Attempt / Execution | 逻辑运行时长 | CLI 进程时长 | 已知费用 USD | 已记录 Token | 不完整 Agent 记录 |
|---|---|---|---|---|---:|---:|---:|
| v1 | BLOCKED | 0 / 1 / 1 | 2m 49s | 10m 38s | 0.057705 | 1,566,045 | 1 |
| v2 | BLOCKED | 0 / 1 / 1 | 30s | 33s | 0.014160 | 113,017 | 0 |
| v3 | BLOCKED | 1 / 7 / 4 | 15m 38s | 15m 44s | 0.144327 | 2,783,160 | 2 |
| v4 | BLOCKED | 1 / 5 / 4 | 3m 42s | 10m 56s | 0.090223 | 1,193,564 | 4 |
| v5 | BLOCKED | 5 / 11 / 11 | 35m 00s | 35m 01s | 0.422066 | 8,291,119 | 2 |

总计已记录 **13,946,905 Token**：input 641,417，output 382,096，cache read 12,923,392，cache write 0。不同 run 的进程区间存在重叠，不能把 CLI 时长简单相加当作连续实验墙钟。

v1、v4 在逻辑终态后分别又等待约 **467.6s、431.4s** 才退出 CLI。这与随后定位的 RPC 等待资源未释放问题相关；适配器修复在 v5 冻结 build 之外完成，没有热更新本次试跑。v5 自身的 CLI 已于逻辑终态后约 **97ms** 退出；独立封存时，容器内只观察到保活 `tail` 进程。

### 配置与环境变化

共同配置为 `ADAPTIVE`、最大并行 2、最大 Execution 48、每 run 美元上限 5、总 deadline 2,100,000ms、独立验证 `required`。模型和 reasoning 保持上述配置，运行时 build 哈希逐次保留在机器记录中。

| 试跑 | 相对前一次的变化 | 观察到的阻塞 |
|---|---|---|
| v1 | 初始总 Token 上限 1.5M | 规划阶段耗尽全局预算，未产生任务图 |
| v2 | 总 Token 上限改为 10M；规划限制 250k Token / 24 tools / 120s；更新 build | 规划纠正后契约仍缺少可检查的 artifactPaths / checkNames |
| v3 | 冻结策略值与 v2 相同；更新 build；首次补齐 `rg 15.2.0`、`fd 10.4.2` | 独立验证设计失败，包括不可追溯引用；旧代码记录为 IMPLEMENT_RUNTIME / INFRASTRUCTURE |
| v4 | 更新 build，加入工作区搜索边界、持久化设计纠正；每次设计 300k Token / 40 tools / 180s | 三次设计分配耗尽，记录为 SPECIFICATION_DESIGN / VERIFICATION / BLOCK |
| v5 | 与 v4 相同 build；每次设计提高至 1.2M Token / 60 tools / 240s | 进入实现、审查和集成检查；修复期间达到总 deadline |

搜索工具修复 receipt 明确记录 `modelSteering=false`、`codeEdits=false`，原因是官方 Python 镜像缺少 Pi grep/find 所需二进制，模型出口限制又阻止了自动下载。该环境变化发生在 v2 与 v3 之间，不能从失败分母中删除前两次运行。

v3/v4 创建过 `workflow_function=IMPLEMENT` 的 Attempt，但其 Agent 用量阶段中没有 `IMPLEMENT` 调用记录：实现 Attempt 可以在验证设计阶段就失败。**Attempt 数量不能解释为实际 writer 推理次数。** 历史 start 文件中的简述与 SQL 阶段记录均保留，结论以具体账本字段为准。

## 3. v5 的控制流程与公开失败

v5 账本记录了规划、规划纠正、规格设计、独立批判、实现、review、公开集成检查与后续修复。其模型阶段开销如下；不完整阶段仍只列已知下界。

| 阶段 | 已知费用 USD | 已记录 Token | 用量状态 |
|---|---:|---:|---|
| PLAN | 0.015641 | 105,663 | 完整运行记录 |
| PLAN_CORRECTION | 0.003483 | 28,105 | 完整运行记录 |
| SPECIFICATION_DESIGN | 0.080681 | 607,396 | 完整运行记录 |
| PROBE_CRITIQUE | 0.075342 | 807,027 | 完整运行记录 |
| IMPLEMENT | 0.218592 | 6,370,848 | 2 条记录不完整 |
| REVIEW | 0.028326 | 372,080 | 完整运行记录 |

| 当时记录的 phase | classification | disposition | 可确认的观察 |
|---|---|---|---|
| IMPLEMENT_RUNTIME | INFRASTRUCTURE | INFRA_RETRY | 等待 Pi 事件超时；记录不足以证明是 provider 故障、运行时故障或模型执行过久 |
| INTEGRATION_VERIFY | VERIFICATION | RETRY | 公开 `pytest` 返回 exit 2，在 import collection 阶段失败 |
| IMPLEMENT_RUNTIME | INFRASTRUCTURE | BLOCK | 触达冻结的运行限制；run 终态 reason 为 `Run deadline exhausted` |

公开集成检查报告无法导入 `hatch._version`，以及无法从 `hatch.project.config` 导入 `ProjectConfig`。这是**收集阶段错误，不是行为断言正确率**。记录不足以区分生成文件、安装／导入布局、阶段性接口缺失和实现问题；本次没有检查实现内容来定位根因，不能全部归咎于模型。表中的分类是系统当时采用的处理策略，也不是独立证实的根因。

未通过的集成没有成为最终权威产物。准确的 tree 和失败门控在本次阻止了错误交付，但**没有带来成功的软件修改**；该结果不能证明独立验证或额外 Agent compute 提升了 Verified Engineering Throughput。

## 4. 权威提交封存

从 SQLite 中读取终态、`input_commit`、`integration_head`、`integration_tree_hash`，核对 Git integration ref 与 tree 一致，再运行只读 `git diff --binary --full-index INPUT_COMMIT INTEGRATION_HEAD --`。没有读取或选择 writer 的失败 candidate。

| 身份 | 值 |
|---|---|
| v5 run | `a37bbede-1e86-4cd6-9667-03bac09b6eb0` |
| run 终态／version | `BLOCKED / 2` |
| 输入与最终 integration commit | `71955da1d6352ea7358c98fba73a6e891a42aa0c` |
| 输入与最终 tree | `a7e1f5cf47add2c515387cadf9c1a2cfb4436245` |
| patch 大小 | `0 bytes` |
| patch SHA-256 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| predictions JSONL SHA-256 | `f8e08a004c0958729642cb28064bebdf829c456451c1e41968748f92a9335c6e` |

另核对独立导出的 masked baseline，其 commit/tree 与最终提交相同；空补丁重放为不改变该基线。预测保留 `success=false`、`agent_exit_status=BLOCKED`。补丁、预测文件与 identity 封存后均未修改，官方保存的 `patch.diff` 与封存哈希一致。

## 5. 唯一一次官方评分

固定官方源码和原锁文件依赖环境，宿主 Python 3.13.15；题目镜像中的 Python 3.10.19、pytest 9.0.1。沿用此前安装的隔离 evaluator venv，未修改 evaluator 源码、测试脚本或提交。评分过程不调用模型 API。

实际命令：

```bash
cd /tmp/tripleteam-featurebench-eval-20260922/FeatureBench-8d4e347ec57546685c5a87e8676bf575db022ea6
HF_HOME=/tmp/tripleteam-featurebench-eval-20260922/hf-cache \
HF_HUB_DISABLE_PROGRESS_BARS=1 \
.venv/bin/python -m featurebench.cli eval \
  -p /tmp/tripleteam-featurebench-eval-20260923/sealed-submission/predictions.jsonl \
  --data-version 76b4a4566e04f4bcc13c35125d4f301791efa736 \
  --split fast --include-failed --n-concurrent 1 \
  --task-id pypa__hatch.ff4b4040.test_fmt.782c88a8.lv1
```

| 官方字段／结果 | 值 |
|---|---|
| CLI exit code | 0，表示评分程序完成 |
| 完成评分的实例数 | 1 |
| 严格解决数 | **0 / 1** |
| empty patch 未应用 | 1 |
| evaluator infrastructure errors | 0 |
| 官方 resolved_rate / pass_rate | 0 / 0 |
| F2P / P2P 通过数 | **未运行，不报告数值** |

固定官方 runtime 在检测到空补丁后直接返回；日志为 `Empty patch provided`。因此不能把官方汇总中的 pass_rate=0 描述成“运行了隐藏测试且全部失败”，也不能将缺失的 F2P/P2P 计数填为零。`--include-failed` 保证运行失败的提交仍保留在分母中。

## 6. 可复核材料

- [仓库内机器记录](2026-09-23-featurebench-development.summary.json)：五次试跑、策略变化、阶段用量、失败元数据、提交身份、官方判定、网络核对与 27 份原始文件哈希；不含题面、实现、探针定义、隐藏测试正文或 Agent 对话。
- [完整开发元数据快照](/tmp/tripleteam-deepseek-20260923/blind-development-summary.json)。
- [封存身份](/tmp/tripleteam-featurebench-eval-20260923/sealed-submission/identity.json)、[提交补丁](/tmp/tripleteam-featurebench-eval-20260923/sealed-submission/submission.patch)、[预测 JSONL](/tmp/tripleteam-featurebench-eval-20260923/sealed-submission/predictions.jsonl)。
- [官方逐实例报告](/tmp/tripleteam-featurebench-eval-20260923/sealed-submission/eval_outputs/pypa__hatch.ff4b4040.test_fmt.782c88a8.lv1/attempt-1/report.json)、[官方汇总](/tmp/tripleteam-featurebench-eval-20260923/sealed-submission/report.json)、[官方 CLI 日志](/tmp/tripleteam-featurebench-eval-20260923/official-cli.log)。

`/tmp` 原始文件可能被清理；需要长期复现时应连同机器记录备份。该实例已经用于开发，后续不能再放入未见测试集。
