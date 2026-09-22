# FeatureBench 单题盲测开发检查（2026-09-22）

## 结论

本次封存提交通过官方 evaluator 完成评分，**严格结果为未解决（resolved=false）**。补丁成功应用；F2P 为 **284 通过、10 失败**，官方部分通过率 **96.6%**；P2P 为 **3508 通过、0 失败**。这是一个新上下文 subagent 的单题开发检查，**不是 TripleTeam 经 Pi 执行得到的系统 benchmark 成绩**。

本次没有修改封存补丁、选择另一份候选或依据隐藏反馈重新提交。评分结果也没有反馈给答题 subagent。该实例已经用于开发检查，后续不能再列入未见测试集。

## 实例与隔离协议

- 数据集：FeatureBench v1.1，`fast`。
- 实例：`pypa__packaging.013f3b03.test_metadata.e00b5801.lv1`。
- 数据 revision：`76b4a4566e04f4bcc13c35125d4f301791efa736`。
- fast parquet SHA-256：`d775855a031b0fb5932ff7fdf4512ce733fbc6716528395bf15cbad22df5d2c3`。
- evaluator 源码 revision：`8d4e347ec57546685c5a87e8676bf575db022ea6`。
- 答题 Agent 使用全新上下文，只获发公开需求与已遮蔽代码，按指令禁止访问原始仓库历史、上游答案、安装包实现和 evaluator 数据。
- 准备程序机械应用数据集的遮蔽补丁，删除 held-out 文件、字节码与原始 Git 历史，随后重新初始化 Git。准备阶段没有向答题 Agent 提供原始答案或隐藏测试。
- 完成并封存补丁后，独立 evaluator 才获得评分所需数据。模型没有根据评分挑选候选。

此处“盲测”指新对话上下文及遵守读取范围的开发协议。执行工具共享宿主机，**不是由操作系统强制隔离的正式盲测环境**。native starter 由固定 GitHub 源码归档生成，没有通过官方推理容器初始化；正式结果比较应使用统一的官方容器与网络限制。

## 封存产物独立复核

| 对象 | 固定身份 |
|---|---|
| 已遮蔽 baseline commit | `fe8c0f2fb774f328e348fa78da1db944860fb6df` |
| baseline tree | `b37042aef35bb7912cd987ca2b7581910db87981` |
| 提交 tree | `a20df4ce6a7eb61504fa399ec666a77971192136` |
| 提交 patch SHA-256 | `c1c725ce01ed6dfb392d54fd1ad230da681bf81087a3a7fd940db8b2ff3aa491` |
| solver-report.json SHA-256 | `8adc44813a8567e2017d4ffdf19a77f2f3d0eb673a1a7b250d58258c913319ce` |

独立检查将 baseline 克隆到新的目录，执行 `git apply --index submission.patch`，然后计算 `git write-tree`，结果与封存 tree 完全一致。官方 evaluator 保存的 `patch.diff` 再次计算 SHA-256，也与上表完全一致。评分前后没有改动提交文件。

## 实际评分环境

- 使用固定 revision 的官方 `featurebench.cli eval`，源码未修改。
- 使用官方 `libercoders/featurebench-specs_packaging-instance_c393a6a8` 镜像，digest：`sha256:96b12548b35b5983ac1dab9a101b4a49946fceb6a05c97690cd942ff014be916`。
- 测试容器：Python **3.10.19**、pytest **9.0.1**。
- 宿主 evaluator：独立临时 venv，CPython **3.13.15**。
- 官方 `uv.lock` SHA-256：`4f01e56e2277d5b2ca248428be91ef1ead0e1bb900e74311fb9927429b7b86f1`。
- 首次 `uv sync --frozen` 因锁文件内镜像站的 TLS 连接失败而中止。随后从原锁文件 `uv export --frozen`，使用 PyPI 下载、`--require-hashes` 校验同版本包。**仅改变依赖下载来源，没有改 evaluator、锁文件、测试脚本或提交**。
- evaluator 未执行模型推理，没有使用付费推理 API。答题 subagent 属于对话平台提供的计算；本次没有可比较的完整美元成本账。

实际命令（从固定官方源码目录运行）：

```bash
HF_HOME=/tmp/tripleteam-featurebench-eval-20260922/hf-cache \
HF_HUB_DISABLE_PROGRESS_BARS=1 \
.venv/bin/python -m featurebench.cli eval \
  -p /tmp/tripleteam-featurebench-eval-20260922/results/predictions.jsonl \
  --data-version 76b4a4566e04f4bcc13c35125d4f301791efa736 \
  --split fast --include-failed --n-concurrent 1 \
  --task-id pypa__packaging.013f3b03.test_metadata.e00b5801.lv1
```

`python -m featurebench.cli eval` 调用与 `fb eval` 相同的官方 dispatcher。`--include-failed` 保留失败提交；本次只有一份封存候选、一次评分，没有 best-of-N 选择。

## 官方报告

| 指标 | 结果 |
|---|---:|
| 补丁成功应用 | 是 |
| evaluator 完成标记 | 是 |
| 严格完成实例数 | **0 / 1** |
| F2P | **284 / 294 通过** |
| 官方 F2P pass_rate | **0.966** |
| P2P | **3508 / 3508 通过** |
| 评分基础设施错误 | 0 |

失败涉及元数据解析、内容类型校验及序列化边界。只将其作为本次固定提交的失败记录，不用这些隐藏案例指导原答题 Agent 修复。**96.6% 是部分测试通过率，不能写成任务正确率或已完成交付。**

这次结果能说明公开检查通过、Agent 给出完成报告之后，独立验收仍可能发现遗漏。它不能证明 TripleTeam 的自适应分配、接口契约、恢复或费用优于 Codex／Claude Code；这些机制仍需通过完整系统运行、固定预算基线与消融来验证。

## 原始记录

仓库内保留[机器可读汇总与身份记录](2026-09-22-blind-featurebench.summary.json)，含官方判定、测试计数、版本、提交身份及原始文件哈希；生成时已逐项核对所引用的六份原始文件。该汇总不含隐藏测试正文、测试名或 gold solution。

原始文件位于本机临时目录；以下哈希同时记录在独立 `identity.json`，便于复核。临时文件可能被系统清理，需要长期保存时应连同封存补丁备份这些原始记录。

- [独立身份与环境记录](/tmp/tripleteam-featurebench-eval-20260922/identity.json)。
- [官方逐实例报告](/tmp/tripleteam-featurebench-eval-20260922/results/eval_outputs/pypa__packaging.013f3b03.test_metadata.e00b5801.lv1/attempt-1/report.json)：SHA-256 `ad1a3f510f7a04267653e15cc49824a94d09b97e3bb37a6a6da1b37219ba4b09`。
- [官方汇总报告](/tmp/tripleteam-featurebench-eval-20260922/results/report.json)：SHA-256 `6285a070959a65e3732d9db01226b0fe505fac592ac92ecb2d116357b84c072a`。
- [官方 CLI 日志](/tmp/tripleteam-featurebench-eval-20260922/official-cli.log)：SHA-256 `9a9e9aabf84817e5b74ebeb3c730b5eb2273a290229514bfa9b89e11e9e1abe4`。
- [封存补丁](/tmp/tripleteam-blind-packaging/submission.patch)。

所有性能比较、成本节省比例和公开排行榜结论继续保持未声明状态。

## 评分后的复盘：为什么没有通过

本节在唯一补丁封存、官方评分完成之后检查失败日志及答题者自测，属于开发复盘。原成绩、补丁和 solver 报告保持不变，答题者未收到这些反馈。

### 实际测试路径与系统设计没有对齐

实际路径为“新上下文 subagent → 自己写代码与测试 → 封存 → 官方评分”。TripleTeam 的 Scheduler、Task/Attempt 状态、合同兑现、PiReviewer、FailurePolicy 与有界修复没有参与这道题。solver 新增文件名中的 `contract` 只表示其自写的测试，不表示运行过 TripleTeam 的 CoordinationContract。

因此这次试验能检查题面准备、封存及官方评分的流程，也暴露了一份答题结果的兼容性缺陷；它无法判断系统设计能否发现这些缺陷、如何分配修复计算或最终能否通过。此前“本轮完成”的表述必须限定到实现与回归范围，完整系统的未见题验证仍缺证据。

### 10 个失败用例集中于少数行为差异

| 观察到的失败 | 数量 | 日志首先暴露的差异 |
| --- | ---: | --- |
| 元数据序列化 | 7 | 输出 header 的大小写与官方精确比较不一致；不能据此推断改完大小写后其他断言一定通过 |
| 多行序列化 | 1 | continuation line 缩进与预期不同 |
| 异常编码 | 1 | 非法编码转换采用替换字符，未按 evaluator 预期保留内容 |
| 内容类型校验 | 1 | charset 的大小写处理比 evaluator 要求更宽松 |

这里报告的是与固定官方 oracle 的不一致。题面并未把所有输出格式与兼容细节逐项明确写出；不能简单认定每项都属于忽视了明确指令，也不能据此改写官方判定。

答题者生成了 44 项自测。其中序列化主要检查重新解析后语义一致；多行测试还直接固化了自己的缩进选择。这说明实现与自测可能共享同一错误假设。公开测试大量通过，并不能替代目标功能独立的兼容性验收。

### 对系统设计的实际启示

准确 tree、冻结检查、epoch 与 CAS 约束执行和证据身份。它们无法自动保证检查已覆盖所有规格，也无法把通过检查的实现自动变成对隐藏 oracle 的完整兼容。

下一项需要验证的机制是：在公开信息范围内，将规格中的风险与假设形成可追溯义务，由独立验证执行生成有区分度的反例；系统据可见失败决定继续实现、调查或修复。必须在真正的控制流程中观察这些动作，不能由父 Agent 在外部替系统补步骤，也不能把最终隐藏评分反馈加入答题循环。

这一改进方向及完整系统试验尚不能计为本次已证明的能力。当前失败记录不支持“多加 Agent 就会通过”或“设计已保证任务正确”的结论。
