import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionPolicy } from "../../src/config/execution.ts";
import { allocateVerification } from "../../src/control/compute-allocation.ts";
import { parseAssurancePolicy } from "../../src/verification/assurance-types.ts";

const input: Parameters<typeof allocateVerification>[0] = {
	policy: parseExecutionPolicy({ maxExecutions: 30 }),
	assurance: parseAssurancePolicy(),
	budget: {
		costUsd: 0,
		tokens: 0,
		reservedUsd: 0,
		reservedTokens: 0,
		executions: 0,
		remainingMs: null,
		unavailableReason: null,
	},
	risk: "NORMAL",
	uncertainty: "MEDIUM",
	protectedBehavior: false,
	reviewRequired: true,
	remainingTasks: 2,
	successes: 0,
	failures: 0,
};
test("extra verification yields to mandatory delivery work when remaining execution budget is tight", () => {
	const decision = allocateVerification({ ...input, policy: parseExecutionPolicy({ maxExecutions: 4 }) });
	assert.equal(decision.required, false);
	assert.match(decision.reason, /Preserve/);
});
test("protected behavior evidence avoids redundant model design; observed failures can justify it again", () => {
	assert.equal(allocateVerification({ ...input, protectedBehavior: true }).required, false);
	const decision = allocateVerification({
		...input,
		protectedBehavior: true,
		failures: 3,
		uncertainty: "HIGH",
		auxiliaryMs: 10_000,
		auxiliaryUsd: 0.02,
	});
	assert.equal(decision.required, true);
	assert.equal(decision.calibrated, false);
});
test("expensive low-value verification is skipped while frozen required/high-risk assurance cannot be budget-waived", () => {
	assert.equal(
		allocateVerification({ ...input, successes: 20, auxiliaryMs: 600_000, auxiliaryUsd: 2 }).required,
		false,
	);
	assert.equal(
		allocateVerification({ ...input, risk: "HIGH", policy: parseExecutionPolicy({ maxExecutions: 1 }) }).required,
		true,
	);
	assert.equal(
		allocateVerification({
			...input,
			assurance: parseAssurancePolicy({ mode: "required" }),
			policy: parseExecutionPolicy({ maxExecutions: 1 }),
		}).required,
		true,
	);
});
