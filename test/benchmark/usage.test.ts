import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage } from "../../src/benchmark/metrics.ts";

test("several planner invocations cannot hide an unmetered crashed writer execution", () => {
	const usage = aggregateUsage(
		[0, 1, 2].map(() => ({
			kind: "AGENT",
			phase: "PLAN",
			duration_ms: 10,
			input_tokens: 10,
			output_tokens: 5,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: 0.1,
			tool_calls: 0,
			details_json: JSON.stringify({ executionId: "planner", complete: true }),
		})),
		2,
		["planner", "lost-writer"],
	);
	assert.equal(usage.unknownUsageRecords, 1);
	assert.equal(usage.costComplete, false);
	assert.ok(Math.abs(usage.knownCostUsd - 0.3) < 1e-10);
});
