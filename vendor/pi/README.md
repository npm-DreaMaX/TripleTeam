# Vendored Pi harness

This directory contains only the seven Pi packages TripleTeam actually uses. Each package keeps the official TypeScript `src/` tree and the matching official `0.86.1` `dist/` build.

- Upstream: `https://github.com/earendil-works/pi.git`
- Commit: `7f06f9cf1626504cde95683f1c81a72a7bc7a0cb`
- Version: `0.86.1`
- License: MIT; see [`LICENSE`](./LICENSE)

The package manifests contain runtime dependencies only. TripleTeam resolves every `@earendil-works/*` package here through repository-local `file:` dependencies, so Pi does not update automatically and no separate Pi checkout or build step is needed to run TripleTeam.

The vendored packages remain upstream code. TripleTeam-specific Task, Attempt, coordination, verification and delivery semantics stay outside this directory. If a local harness change is required, edit the relevant package source, regenerate its `dist`, and run the complete TripleTeam suite.
