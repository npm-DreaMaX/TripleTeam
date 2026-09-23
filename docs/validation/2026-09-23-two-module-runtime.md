# Two-module execution and automatic repair — 2026-09-23

This controlled repository test used the actual TripleTeam planner, Pi workers and official `deepseek/deepseek-flash` API. It is an engineering validation, not a benchmark score. [Machine-readable evidence](2026-09-23-two-module-runtime.summary.json).

## Public task and acceptance

The fixture had two independent Python components: Unicode-to-ASCII slug formatting and merging closed intervals. The README specified exact outputs, invalid input behavior, separate owned source/test files and no mutation of inputs. The conversation agent prepared unimplemented stubs and protected public acceptance tests; it supplied no implementation or human answers during execution.

The planner created two tasks. The adaptive coordinator selected `PARALLEL_TASKS`, with two writer slots. Each task required independent specification design, critique, two probes repeated twice and candidate review. Integration used an immutable Python Docker image, read-only source and no network. The final protected acceptance command exercised both components.

Frozen limits: 2M total tokens, $2 estimated model cost, 20 minutes, `noninteractive`, `ADAPTIVE`, at most two design attempts per task. The source baseline was commit `fde342416401e00eb55f69e4a55224d60491967f`, tree `671f57d306b6271ef7b023bead85d797c6277b0c`.

## Observed result

- Run `3c7ecd3a-0c10-4cd7-8993-9ccd3b8a7c2a`: **VERIFIED_DELIVERY**, both tasks accepted.
- An interval candidate failed the independently generated invalid-input assertions on both repeats. Failure policy recorded `INDEPENDENT_VERIFY / VERIFICATION / RETRY`; a new writer attempt repaired the candidate.
- Two proposed verification designs were also rejected before freezing. These calls and the failed candidate are included in usage.
- There are 42 check records: 40 passed and 2 failed. Required checks on the delivered tree passed.
- Final commit `f0e87a9479ecf5a9fa5d8077ddde551181b1fddd`, tree `12a9b8094c35a84a92e6eb98fdf1f5e599a9d9ed`.
- Total observed model-price estimate: **$0.128688**. This uses the configured peak-period price table, not an invoice.

The two tasks were dispatched concurrently and auxiliary work overlapped. **Their three writer inference windows did not overlap**, because the independent verification designs completed at different times. This run establishes multi-task coordination, automatic repair and final integration; it does not establish parallel writer speedup. The time windows are preserved in the summary.
