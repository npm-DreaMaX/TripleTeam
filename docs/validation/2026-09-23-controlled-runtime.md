# Real Pi + DeepSeek validation — 2026-09-23

This is a controlled engineering fixture, not a benchmark score or a comparison with another product. TripleTeam ran the complete workflow through its actual Pi RPC adapter and the official DeepSeek API. The conversation agent supplied the public fixture and did not write its solution. No runtime human answers or manual code fixes were supplied.

Machine-readable phase costs, source identities and checks: [summary](2026-09-23-controlled-runtime.summary.json).

## Fixture and frozen acceptance

A fresh Python repository contained unimplemented `parse_ranges` and `format_ranges`, a public README and protected public acceptance tests. Requirements included signed inclusive ranges, duplicate removal, sorted results, strict malformed-input handling, literal compact formatting, empty inputs and rejecting boolean/float/string values during formatting.

Input commit: `51e6bd93d51f0aeffd08b8f975dfb013d87e8169`.

Input tree: `2a047e59f822b2850f70c7e7626922e8f126da0d`.

The acceptance command was `python3 -B -m unittest discover -s tests -v`. Its test file was frozen under `oracle.protectedPaths` and checks used the installed immutable Python image `sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f`, read-only source and no network. Independent probes used the same isolated interpreter image. The writer itself ran in a host worktree.

The frozen execution policy used `SINGLE`, `noninteractive`, `deepseek/deepseek-flash`, reasoning `high`, 24 maximum executions, 750000 total tokens, a 20-minute deadline and a $2 model-price budget. Assurance was `required`, at most 8 obligations / 3 probes / 2 design attempts, with 2 repeats. There was no planner inference in this whole-goal baseline.

## Results

| Run | Model contexts | Estimated model cost | Result |
| --- | --- | --- | --- |
| `213c37cf-0428-48dc-a75c-069dcda8c839` | 3: specification, critique, writer | $0.024578 | `VERIFIED_DELIVERY` |
| `f4aa1bf9-943b-4375-ac9b-6ccf0f56ce71` | 4: specification, critique, writer, candidate review | $0.040918 | `VERIFIED_DELIVERY` |

The second run started again from the unchanged baseline. It verified the correction that maps a configured `MEDIUM` review level to the Task model's `NORMAL` level. The first run did not purchase candidate review because the earlier defaults mismatched that label; it still ran independent probe critique and protected acceptance. Both records are retained.

Each run produced 3 discriminating controls, 18 actual repeated probes across candidate/integration/final run, and 3 protected acceptance executions: 24 check records in total. The second final tree is `a88a6cffcd3aec24eef4d01dc358341c57408f09`; its delivery commit is `81a15db3bfb91b6c1af06df131428a4da20a447a`.

Costs are derived from Pi's token observations and the configured peak-period price table, not a provider invoice. The successful paths have no interrupted model calls. The fixture demonstrates real execution and enforcement of these contracts; it does not establish benchmark generalization, cost savings, parallel speedup or correctness outside the checked requirements.

## Independent control-path regressions

Separate deterministic tests deliberately generated an incorrect writer candidate. Real Git, SQLite and CheckRunner rejected it under `INDEPENDENT_VERIFY`, selected `RETRY`, preserved the frozen probe plan and accepted the corrected candidate only after checks, integration and final verification. Additional tests interrupted evaluation batches and Git publication recovery to verify that partial or old successful records cannot satisfy acceptance.
