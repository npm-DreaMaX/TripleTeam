# Benchmark adapters and blind development exercises

Status: runnable adapter code and deterministic contract tests are implemented. No paid model evaluation or public leaderboard result is claimed here. The native blind exercise is separately labelled and cannot establish a score, price advantage, or end-to-end Pi runtime performance.

## Boundaries

- `src/benchmark/main.ts` is a separate executable. `featurebench-run`, `milestone-step`, and `milestone-watch` execute through `LocalOrchestrator`; other commands do not invoke models.
- The core runtime has no knowledge of benchmark answers, special case scoring, or externally assigned milestone completion.
- Frozen experiment manifests pin the evaluator commit, data revision and SHA-256, ordered instance set, system revision, model/provider, execution policy hash, total limits, image digests, network policy, and price accounting assumptions.
- SQLite stores experiment identity, external-instance/run mappings, publication state and the campaign integration head. JSON is an immutable export, not a second task authority.
- Submissions come from SQLite's integration head after comparing it with the real integration ref. The user worktree, writer worktree and an agent's chat response cannot select the submitted tree.
- Official evaluator results are imported only after submission. They never enter the runtime's failure policy or unlock tasks in the adapter.

## Pinned upstream contracts

| Evaluator | Contract revision | Adapter boundary |
|---|---|---|
| FeatureBench | `8d4e347ec57546685c5a87e8676bf575db022ea6` | Public masked starter → one official prediction row → independent official evaluator |
| SWE-Milestone | `17a8f1593e172e26b36cea15e2b30fb9536c93f5` | Official public `TASK_QUEUE.md` / released SRS → integration checkpoint tag |

FeatureBench fast v1.1 was pinned to Hugging Face revision `76b4a4566e04f4bcc13c35125d4f301791efa736`, parquet SHA-256 `d775855a031b0fb5932ff7fdf4512ce733fbc6716528395bf15cbad22df5d2c3`. The data file itself is not committed here.

The contracts were checked against the pinned sources:

- [FeatureBench inference result fields](https://github.com/LiberCoders/FeatureBench/blob/8d4e347ec57546685c5a87e8676bf575db022ea6/featurebench/infer/models.py), [runtime preparation](https://github.com/LiberCoders/FeatureBench/blob/8d4e347ec57546685c5a87e8676bf575db022ea6/featurebench/infer/runtime.py), [evaluation report](https://github.com/LiberCoders/FeatureBench/blob/8d4e347ec57546685c5a87e8676bf575db022ea6/featurebench/harness/report.py).
- [SWE-Milestone task release and tag watcher](https://github.com/DeepCommit-ai/SWE-Milestone/blob/17a8f1593e172e26b36cea15e2b30fb9536c93f5/harness/e2e/orchestrator.py).

Changing these pins requires checking the upstream contract and updating the adapter tests. No dependencies float to upstream `main`.

## CLI

From the TripleTeam checkout:

```bash
node --import tsx src/benchmark/main.ts --help
node --import tsx src/benchmark/main.ts config-hash /path/to/prepared/repository
node --import tsx src/benchmark/main.ts freeze /path/to/manifest-input.json /path/to/frozen-manifest.json
```

The built distribution may expose the same entry as `tripleteam-benchmark`.

Create the manifest using the shape below. Replace every placeholder with an actual pinned value; placeholders intentionally fail validation. `executionConfigHash` comes from `config-hash`, which hashes the normalized execution policy including model, reasoning, policy ablations and limits. Budget values must exactly match the repository's base execution configuration. For FeatureBench they apply per instance; for SWE-Milestone they apply to the entire campaign.

```json
{
  "schema": "tripleteam-benchmark/v1",
  "benchmark": "featurebench",
  "evaluatorCommit": "8d4e347ec57546685c5a87e8676bf575db022ea6",
  "datasetRevision": "76b4a4566e04f4bcc13c35125d4f301791efa736",
  "datasetDigest": "d775855a031b0fb5932ff7fdf4512ce733fbc6716528395bf15cbad22df5d2c3",
  "split": "fast",
  "instanceIds": ["EXACT_INSTANCE_ID"],
  "systemCommit": "REPLACE_WITH_SYSTEM_COMMIT",
  "model": "EXACT_MODEL_ID",
  "provider": "EXACT_PROVIDER_ID",
  "replicate": "1",
  "executionConfigHash": "REPLACE_WITH_CONFIG_HASH",
  "budget": { "costUsd": 10, "tokens": 100000, "deadlineMs": 7200000, "maxExecutions": 20 },
  "protocol": {
    "humanMode": "DISABLED",
    "hiddenFeedback": "FORBIDDEN",
    "submissionSelection": "FINAL",
    "networkPolicy": "DESCRIBE_ENFORCED_CONTAINER_NETWORK_POLICY",
    "containerImages": { "INSTANCE_IMAGE": "IMAGE@sha256:REPLACE_WITH_DIGEST" }
  },
  "accounting": {
    "priceSnapshot": "DATE_AND_SAVED_RATE_CARD_OR_ACTUAL_BILLING_LEDGER",
    "costScope": "MODEL_API_ONLY",
    "missingUsage": "UNKNOWN"
  }
}
```

Example budget numbers are configuration examples, not measured or recommended performance targets. CPU/container costs and subscription costs are not silently converted into API dollars. Preserve those resource measurements separately.

## FeatureBench

### Prepare without leaking the answer

Use the pinned official harness's `RuntimeHandler.initialize_runtime` and `clear_package_caches` in its task container before invoking TripleTeam. That trusted side applies the dataset corruption/mask patch, removes held-out files, removes bytecode and resets Git history. **The dataset `base_commit` names pristine code; cloning it and giving it directly to the solver exposes the removed implementation.**

The public envelope passed to TripleTeam has exactly these fields:

```json
{
  "instance_id": "EXACT_INSTANCE_ID",
  "problem_statement": "PUBLIC_PROBLEM_STATEMENT",
  "repo": "OWNER/REPOSITORY",
  "image_name": "ACTUAL_IMAGE",
  "prepared_base_commit": "GIT_HEAD_AFTER_MASKING_AND_REINITIALIZATION",
  "prepared_base_tree": "GIT_HEAD_TREE_AFTER_PREPARATION"
}
```

Do not pass a full dataset row. The parser rejects `patch`, `test_patch`, held-out test fields, and every other unsupported field. Keep evaluator data and gold code outside the agent container. The prepared baseline commit is the export patch base.

### Execute and export

The following command invokes models and is for the later evaluation run:

```bash
node --import tsx src/benchmark/main.ts featurebench-run /prepared/repo /public/task.json /frozen-manifest.json /outputs
```

Repeated invocation resumes the same durable instance/run mapping. It cannot create hidden best-of-N candidates. A new experimental replicate requires a new frozen manifest. Terminal failures and cancellations still export their authoritative partial artifact and usage. Exports do not equate `success: true` with external correctness; that field means the runtime reached its own completed state.

For a terminal run that already exists, export without invoking a model:

```bash
node --import tsx src/benchmark/main.ts featurebench-export /prepared/repo RUN_ID /public/task.json /frozen-manifest.json /outputs
node --import tsx src/benchmark/main.ts featurebench-collect /frozen-manifest.json /outputs /predictions.jsonl
```

`collect` emits every frozen instance, using an explicit empty failed prediction for a missing trial. It never removes failures from the denominator. `n_attempt` is always 1: internal retries are counted in that one system attempt and billed together.

### Evaluate independently

Run the pinned official `fb eval` on the prediction JSONL, explicitly selecting the frozen data revision and split. `--include-failed` is required: the official default skips predictions whose runtime `success` field is false, which would omit partial failed/cancelled outputs. Do not use best-attempt selection to choose TripleTeam's submission. Preserve the actual evaluator command/config and image digests with the output.

```bash
fb eval -p /predictions.jsonl \
  --data-version 76b4a4566e04f4bcc13c35125d4f301791efa736 \
  --split fast --include-failed --n-concurrent 1
```

Use `--task-id EXACT_INSTANCE_ID` for a single sealed exercise. This is an evaluation command, with no model inference calls. It requires the pinned official Python environment and Docker images; no evaluator run is implied by the existence of the adapter.

After evaluation, normalize reports without exposing them to a running Agent:

```bash
node --import tsx src/benchmark/main.ts featurebench-verdicts /frozen-manifest.json /outputs /official-evaluation-output /verdicts.json
node --import tsx src/benchmark/main.ts summarize /frozen-manifest.json /outputs /verdicts.json
```

The importer requires the pinned report completion marker, `n_attempt: 1`, and byte-identical `patch.diff`. Verdicts are bound to the exported tree. Missing/interrupted evaluator outputs remain missing; they are not fabricated as verified outcomes.

## SWE-Milestone continuous campaign

Run the official harness's persistent container and watcher with its frozen data/image manifest and `early_unblock` configuration. Set `benchmark: "swe-milestone"`, the matching evaluator commit, and `protocol.earlyUnblock` in TripleTeam's manifest. Launch this adapter **inside the existing agent container**, with the queue and repo paths the official harness prepared:

```bash
node --import tsx /opt/tripleteam/src/benchmark/main.ts milestone-watch /path/to/repo /e2e_workspace/TASK_QUEUE.md /frozen-manifest.json /outputs
```

`milestone-step` executes at most one released milestone and is useful for inspecting orchestration. The adapter consumes only queue entries and those entries' SRS files. It does not inspect a future DAG/spec directory or evaluator outputs. The official watcher owns all dependency unlock decisions.

For each released goal:

1. Initialize a frozen GoalContract at the campaign's previous authoritative integration commit.
2. Persist its external ID → run ID mapping before any model execution.
3. Execute/recover through `LocalOrchestrator.continue` using the remaining campaign limits.
4. Seal the trial in SQLite, publish `agent-impl-<milestone_id>` by Git CAS, then advance the campaign head.

A crash between tagging and advancing replays the same immutable checkpoint. A tag denotes a submitted artifact, including a partial failed artifact, and confers no internal or external acceptance. Each milestone has one final submission under this adapter's declared protocol. That differs from studies permitting unlimited revised submissions or unlimited resume budget; compare all products under the same frozen total limits and clearly identify the track.

The campaign preserves its own code and authoritative SQLite mapping. Pi continues to own individual sessions. A new external goal creates a new GoalContract and may create new Pi sessions; this is not claimed to preserve one uninterrupted model conversation across all goals. The public prior SRS files remain available according to the official harness.

The CLI integration point is implemented and tested with a controlled queue and Git repository. Registering/launching it in the full official container fleet and validating every repository's environment are evaluation setup tasks, not checks already performed in this repository. Do not call fixture tests an official end-to-end benchmark run.

SWE-Milestone's official scoring uses its own macro averaging. `summarize` reports costs, states and an explicitly diagnostic instance fraction; it does not replace the official Score or Resolve calculation.

## Blind development exercise without model API calls

`benchmark/prepare_blind_featurebench.py` prepares the selected `pypa/packaging` fast task from public source at its exact dataset revision. It mechanically masks the code, deletes held-out files, removes bytecode and old Git history, and emits only a public repository/spec/envelope/provenance. Its Python requirement is pinned in `benchmark/requirements-preparation.txt` and is separate from the product's runtime dependencies.

```bash
python3 benchmark/prepare_blind_featurebench.py \
  --parquet /trusted-evaluator/featurebench-fast-v1.1.parquet \
  --instance pypa__packaging.013f3b03.test_metadata.e00b5801.lv1 \
  --output /tmp/new-blind-exercise
```

The native preparer is deliberately limited to the validated repository. Official scores use the official container preparation for all repositories.

Give a fresh-context solver only the released directory and a bounded task instruction. It must not read this project's review, evaluator files, upstream future history or installed copies of the removed implementation. Its final patch must be sealed before an independent evaluator opens the held-out tests. Do not relay hidden-test failures back into that same attempt. Record the solver's actual access restrictions, patch/tree identity, public checks and independent results.

Fresh conversation context does not physically sandbox filesystem/network access. The local exercise therefore uses an explicit access protocol; a publishable blind evaluation needs the official container/network quarantine. Solving one exercise also does not establish a multi-agent speed/cost advantage or test the Pi provider loop.

## Deterministic verification

```bash
node --import tsx --test test/benchmark/*.test.ts
```

Tests cover immutable pinning, rejection of hidden fields, export of the integrated tree while user HEAD is dirty, failed/missing goal accounting, official queue parsing, path escape rejection, crash publication recovery, tag immutability, and exact-tree verdict matching. No model requests or official hidden tests are used by this suite.

Final experiment material should include the frozen manifest, public envelope digests, all trial records and usage, exact Git objects/patches, independent official reports, environment receipts, and analysis from all planned goals. Paid performance numbers remain unclaimed until those runs exist.
