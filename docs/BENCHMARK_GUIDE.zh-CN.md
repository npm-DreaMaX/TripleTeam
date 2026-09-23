# 应该跑什么，以及什么结果才说明有优势

核对日期：2026-09-23。先跑 **FeatureBench fast v1.1** 作为功能交付主线，再用 **SWE-Milestone** 补长程证据；**CooperBench** 用于协作机制分析。将正确率、费用和时间一起报告。正式测评由使用者运行，本项目不填写未测得的领先数字。

## 三条证据线

| 优先级 | Benchmark | 它能回答什么 | 主指标 | 当前入口 |
| --- | --- | --- | --- | --- |
| 1 | [FeatureBench](https://github.com/LiberCoders/FeatureBench) fast v1.1，100 题、无需 GPU | 能否在真实仓库完成复杂功能，达到相近正确率时是否更省 | 官方 `%RESOLVED` / `%PASSED`、全部尝试费用/解决数、总耗时 | `featurebench-run / collect / verdicts / summarize` |
| 2 | [SWE-Milestone](https://github.com/DeepCommit-ai/SWE-Milestone) | 连续功能演进、依赖解锁和长程积累是否可靠 | 官方宏平均 Score/Resolve、完整演进成功率、累计费用与回归 | `milestone-step / milestone-watch`，接官方公开队列 |
| 3 | [CooperBench](https://github.com/cooperbench/CooperBench) | 增加 agent 后，接口不兼容和返工是否下降 | 原协议得分、两功能联合通过、冲突/返工/通信成本 | 官方 evaluator；作为机制实验单独登记 |

FeatureBench 官方已有 Codex/Claude Code 推理适配器。使用相同数据修订重跑对照：当前网页榜单标注 Dataset v1.0，不能拿 v1.1 结果直接横比。fast 是实用的首轮主测试；环境冒烟题提前登记为开发集，与最终报告题目分开。

SWE-Milestone 的官方 watcher 控制题目释放和隐藏评分。不要把各题重置为原始仓库，也不要让模型预读后续规格。连续目标复用自己之前的代码；完整 campaign 共用一次预算。官方宏平均不能由一个微平均通过率替代。

CooperBench 的 coop 为分配各自功能的 peer，team 为 lead/members；solo 看到全工作量。信息可见性不同，不能把整个双功能描述直接交给 TripleTeam，再称为原 coop 协议下的公平胜负。若测“完整目标下自适应协调”，所有系统都看到两个功能，命名为独立 joint-goal 轨道；使用原 evaluator 测各功能，并另报同一最终树的联合通过率。当前没有注册为官方 `cooperbench run -a tripleteam` 插件，不提供一个实际不存在的命令。**本次主交付与正式对照可完整使用前两个适配器。**

## 对照矩阵

| 对照组 | 固定条件 | 可归因的结论 |
| --- | --- | --- |
| TripleTeam ADAPTIVE vs SINGLE | 同 Pi、模型、reasoning、工具、验收与总预算 | 自适应分配是否优于强单 writer 基线 |
| ADAPTIVE vs FIXED | 同模型、相同最大并行度与总预算 | 是否避免固定多 agent 的重复计算与协作代价 |
| 分别关闭 contracts / failure adaptation / compute allocation / evidence reuse | 每次只改一个开关，其他相同 | 哪个机制贡献了收益 |
| TripleTeam vs 原生 Codex / Claude Code | 同题面、容器、公开信息、验收和预算协议；保留各产品正常能力 | 用户选择的产品 + 模型组合哪个更有效 |

消融入口：`execution.policy`、`enableContracts`、`enableFailureAdaptation`、`enableComputeAllocation`、`enableEvidenceReuse`。SINGLE 仍有公共 review/验证机制，应称“单 writer 基线”；测试纯 Pi 裸 agent 时另列一个组。不要混淆控制机制与基座模型实力。

## 必须报告的六类数字

1. **质量**：官方解决率和测试通过比例，同时报超时/阻塞/取消/环境失败。
2. **成本**：所有规划、探索、writer、review、compaction、修复及失败调用的费用；`Cost per resolved = 总费用 / 外部解决数`。零解决数或费用不全时记为未定义，不记为 0。
3. **速度**：端到端墙钟、P50/P90；冷环境准备单列。已失败任务不能从速度和费用分母中删除。
4. **预算曲线**：提前固定例如低/中/高三个美元或墙钟档。只有共同计费入口真正限制总费用时，才能称“同美元预算”；否则称同 deadline 对照，费用事后测量。跨模型 token 数不等同于美元或能力。
5. **协作代价**：实际 writer 重叠时间、首次集成成功率、接口复验次数、返工 token、读观察复用次数。调度批次为 PARALLEL 不证明实际进程重叠。
6. **可信完成**：声称 VERIFIED 的提交在独立 evaluator 上失败的比例；另报同一冻结版本的故障注入/恢复正确性和用户操作次数。后两项为系统可靠性测试，单列，不包装成 benchmark 官方分数。

“更强且更省”的最低可信证据：在相同条件下多次重复，质量达到预先约定的非劣界，同时每个解决任务的总成本下降；或同等费用下质量上升。预注册非劣界，不在看到结果后挑选。有足够题目和仓库时给配对不确定性区间；只有少量开发题时只描述观察。

## 可执行流程

完整准备、隐藏信息隔离、固定版本和配置模板见 [适配器操作手册](BENCHMARK_ADAPTERS.md)；竞品命令和计费限制见 [对照协议](BASELINE_COMPARISON.md)。

```bash
# 不调用模型：获取配置 hash，并冻结实验
tripleteam-benchmark config-hash /prepared/repo
tripleteam-benchmark freeze /experiment/input.json /experiment/frozen.json

# 调用模型：只传官方准备后的公开题面和被遮蔽仓库
tripleteam-benchmark featurebench-run /prepared/repo /public/task.json /experiment/frozen.json /outputs/tripleteam

# 不调用模型：收集所有计划题目；缺失题目保留空的失败提交
tripleteam-benchmark featurebench-collect /experiment/frozen.json /outputs/tripleteam /outputs/predictions.jsonl

# 独立 evaluator；包括 runtime 未完成时的部分补丁
fb eval -p /outputs/predictions.jsonl \
  --data-version 76b4a4566e04f4bcc13c35125d4f301791efa736 \
  --split fast --include-failed --n-concurrent 1

tripleteam-benchmark featurebench-verdicts /experiment/frozen.json /outputs/tripleteam /official-evaluation-output /outputs/verdicts.json
tripleteam-benchmark summarize /experiment/frozen.json /outputs/tripleteam /outputs/verdicts.json
```

新实验在 manifest 中加入 `runtimeConfigHashes: {"INSTANCE_ID": "FULL_CONFIG_SHA256"}`，覆盖全部计划实例。`config-hash` 输出 `runtimeConfigHash`；它固定检查 scope、atomic、preparation、assurance 和全部配置，执行前及提交时都会核对。旧历史 manifest 保持可读，但没有这个额外的预注册约束。

对于 ADAPTIVE/SINGLE 等相同协议的两组已封存记录：

```bash
tripleteam-benchmark compare-featurebench \
  /adaptive/frozen.json /adaptive/outputs /adaptive/verdicts.json \
  /single/frozen.json /single/outputs /single/verdicts.json
```

输出配对胜负、完整解决率差、按仓库聚类的 bootstrap 区间和包含失败的费用/解决数。缺判分时不输出比较正确率或区间；缺费用时不输出费用优势。该命令直接读取本项目的 trial 格式；竞品原始日志须先按同字段规范独立转换并保留来源，不会自动猜测其费用。SWE-Milestone 仍使用官方统计。

全自动条件使用 `execution.decisionMode: "noninteractive"`，这会在权威控制面拒绝人工回答、steer、手动 retry 和人工改图。出现无法由公开材料决定的产品/权限问题应记录未完成，不能暗中人工解题后继续计作自主成功。
