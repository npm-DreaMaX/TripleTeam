# Atlas: asynchronous report exports

Extend this existing service across shared contracts, jobs, HTTP API and SDK. Preserve the synchronous `POST /export` and `ReportClient.export` behavior. Standard library only; Python 3.11 or later.

## Observable requirements

- `contracts.EXPORT_STATES` contains PENDING, RUNNING, SUCCEEDED, FAILED, CANCELLED. A job snapshot has `id: str`, `state: str`, `progress: int` (0–100), and may include an error. Snapshots must not expose mutable internal state.
- `POST /exports` accepts `{rows: list[dict], idempotency_key?: str}`. Return 202 with a new PENDING snapshot. Identical rows with the same nonempty key return the existing job; reuse with different rows is 409. Invalid rows/key are 400. Copy submitted rows so later caller mutations cannot change the job.
- `GET /exports/{id}` returns 200 and the current snapshot, or 404. `GET /exports/{id}/result` returns 200 `{csv: str}` only after success; otherwise 409 (404 for unknown ID).
- `POST /exports/{id}/cancel` cancels PENDING or RUNNING jobs and is idempotent for CANCELLED jobs. Terminal SUCCEEDED/FAILED jobs return 409. Cancellation wins against an already running exporter: a late result must never resurrect a cancelled job.
- `POST /exports/{id}/retry` changes only FAILED jobs to PENDING, retaining their ID and original input and resetting progress/error. Other states return 409; unknown IDs return 404.
- `jobs.process_pending(exporter=export_csv)` processes currently pending jobs once, outside API submission. It transitions through RUNNING to SUCCEEDED/progress=100 or FAILED. Exporter exceptions become job failures. Use a thread-safe store; do not hold its lock while executing an exporter. Deterministic manual ticks are sufficient; persistent storage and automatic scheduling are outside this demo.
- The SDK exposes `start_export(rows, idempotency_key=None)`, `get_export(id)`, `cancel_export(id)`, `retry_export(id)`, `download_export(id)`, and `wait_export(id, max_polls=100, interval=0.01)`. Methods consume the transport boundary and raise ValueError on non-success status. Wait returns on terminal state, sleeps between bounded polls, and raises TimeoutError if still unfinished. Reject nonpositive poll limits and negative intervals.
- `atlas.api.Handler` must serve these same dispatch semantics through HTTP without requiring a second state store.

## Acceptance and workflow

`tests/test_contracts.py`, `test_jobs.py`, `test_api.py`, and `test_client.py` protect existing behavior. Component checks are used for intermediate integration. `tests/test_workflow.py` and `tests/test_concurrency.py` are **final public acceptance checks**, expected to fail on this input revision. Keep all supplied tests unchanged; add tests under new names if useful.

Plan verifiable increments. You may formalize the shared interface first, then build independent consumers against its checked artifact. Use task dependencies where implementation availability is required. Do not announce completion until the final feature checks pass. The system decides whether additional agents are worthwhile.

Run locally: `python3 -B -m unittest tests.test_contracts tests.test_jobs tests.test_api tests.test_client`.
Final checks: `python3 -B -m unittest tests.test_workflow tests.test_concurrency`.
Start HTTP service: `python3 -B -m atlas.api` (127.0.0.1:8080).
