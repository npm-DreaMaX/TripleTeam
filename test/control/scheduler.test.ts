import assert from "node:assert/strict";
import test from "node:test";
import type { TaskDefinition } from "../../src/control/catalog.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { RunScheduler, selectParallelTasks } from "../../src/control/scheduler.ts";
import type { TaskExecutor } from "../../src/control/task-executor.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import type { RunVerifier } from "../../src/verification/run-verifier.ts";

const check = { name: "test", argv: ["npm", "test"], timeoutMs: 60_000, lane: "HEAVY_CHECK" } as const;

function task(id: string, scope: string[]): TaskDefinition {
	return {
		id,
		runId: "run",
		state: "READY",
		priority: 0,
		riskClass: "LOW",
		requiredCapabilities: [],
		attemptEpoch: 0,
		activeAttemptId: null,
		revisionId: id + "-revision",
		revision: 1,
		title: id,
		objective: id,
		scope,
		constraints: [],
		acceptanceContract: {},
	};
}

test("scheduler parallelizes only tasks with disjoint declared ownership scopes", () => {
	const selected = selectParallelTasks(
		[task("api", ["src/api"]), task("api-child", ["src/api/routes"]), task("docs", ["docs"])],
		3,
	);
	assert.deepEqual(
		selected.map((item) => item.id),
		["api", "docs"],
	);
	assert.deepEqual(
		selectParallelTasks([task("unknown", []), task("docs", ["docs"])], 2).map((item) => item.id),
		["unknown"],
	);
});

async function terminalRun(id: string) {
	const database = await openControlDatabase(":memory:");
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const user = { kind: "USER", id: "user" } as const;
	const system = { kind: "SYSTEM", id: "system" } as const;
	kernel.createRun({
		id,
		repositoryRoot: "/repo",
		objective: "Terminal run",
		inputCommit: "head",
		inputTreeHash: "tree",
		integrationRef: `refs/test/${id}`,
		actor: user,
	});
	const taskId = kernel.createTask({
		id: `${id}-task`,
		runId: id,
		title: "No longer needed",
		objective: "Cancelled by an authoritative proposal",
		scope: [],
		constraints: [],
		acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: false },
		riskClass: "LOW",
		actor: user,
	});
	const proposal = kernel.proposeTaskChanges({
		runId: id,
		changes: {
			additions: [],
			revisions: [],
			dependencies: [],
			cancellations: [{ taskId, expectedVersion: 1, reason: "Requirement withdrawn" }],
		},
		actor: user,
	});
	kernel.acceptTaskChanges(proposal, system);
	return { database, kernel, catalog };
}

test("scheduler completes only after a passing final run gate", async (context) => {
	const { database, kernel, catalog } = await terminalRun("run-pass");
	context.after(() => database.close());
	const checkId = kernel.recordCheckResult({
		runId: "run-pass",
		subjectKind: "RUN",
		subjectId: "run-pass",
		treeHash: "tree",
		checkKind: "final",
		checkVersion: "1",
		command: ["test"],
		environmentHash: "env",
		state: "PASSED",
		actor: { kind: "SYSTEM", id: "verifier" },
	});
	const verifier = {
		verify: async () => ({ status: "PASSED", treeHash: "tree", checkIds: [checkId] }),
	} as unknown as RunVerifier;
	const scheduler = new RunScheduler(kernel, catalog, {} as TaskExecutor, verifier, new LocalResourceGovernor());
	assert.equal((await scheduler.runUntilSettled("run-pass")).state, "COMPLETED");
});

test("scheduler blocks a terminal task graph when the global gate fails", async (context) => {
	const { database, kernel, catalog } = await terminalRun("run-fail");
	context.after(() => database.close());
	const verifier = {
		verify: async () => ({ status: "FAILED", treeHash: "tree", checkIds: [] }),
	} as unknown as RunVerifier;
	const scheduler = new RunScheduler(kernel, catalog, {} as TaskExecutor, verifier, new LocalResourceGovernor());
	assert.equal((await scheduler.runUntilSettled("run-fail")).state, "BLOCKED");
});
