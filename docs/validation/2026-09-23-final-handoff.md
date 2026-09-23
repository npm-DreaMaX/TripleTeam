# Final source handoff — 2026-09-23

This snapshot adds verifiable increments, baseline environment preparation, compute allocation for optional verification, dependency-bound exploration reuse, artifact inputs for consumers, stage-aware independent probes, permanent-provider-error handling, `/why`, a real Atlas demo and paired benchmark analysis.

## Validation

| Gate | Result |
| --- | --- |
| TypeScript + Biome (`npm run check`) | Passed |
| Full suite with the pinned Python Docker image | 301 passed, 0 failed, 0 skipped |
| Build | CLI, daemon, control extension and benchmark entry point built |
| Clean source-archive installation | `npm install --ignore-scripts`, build, doctor, benchmark help and demo creation passed |
| Packaged file identities | Every payload file checked against `RELEASE_MANIFEST.json` |
| Credential exclusion | No occurrence of the supplied testing credential in the source payload |
| Local documentation links | Checked, with no missing target files |
| Git whitespace checks | Passed |

The full-suite command uses the installed immutable image identity:

```bash
npm run check
TRIPLETEAM_TEST_DOCKER_IMAGE=sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f npm test
npm run build
```

The prior 277-test [release record](2026-09-23-release.md) retains its historical scope. Deterministic tests validate state transitions, real Git/check execution and transport contracts; they are not model-quality measurements.

## Real API boundary

The [Atlas development record](2026-09-23-atlas-development.md) preserves all four trials. The last run accepted the shared-contract task, then the provider returned HTTP 402 Insufficient Balance. The complete new workflow has therefore not passed real API acceptance yet. The code changes addressing stage coupling and provider failures have regression evidence; a funded API trial is the remaining live validation step. No comparative accuracy, speed or cost score is claimed.

## Handoff artifacts

Run `python3 scripts/package-source.py` after building to produce `release/TripleTeam-source.tar.gz`, `release/TripleTeam-source.zip`, `release/RELEASE_MANIFEST.json` and `release/SHA256SUMS`. The manifest describes the current working snapshot, including uncommitted and untracked source. Git history, credentials, installed dependencies and local runtime state are excluded.

The recipient can publish from a fresh clone of the destination's current history using [PUBLISH.md](../PUBLISH.md). No commit, force push or remote publication was performed as part of this handoff.
