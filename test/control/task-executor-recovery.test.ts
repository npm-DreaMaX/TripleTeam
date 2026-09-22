import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../../src/config/paths.ts";
import type { CheckCommand, ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { FailurePolicy, failureFingerprint } from "../../src/control/failure-policy.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { TaskExecutor } from "../../src/control/task-executor.ts";
import { AdaptiveExplorationCoordinator, PiExplorer } from "../../src/exploration/explorer.ts";
import type { PiReviewer } from "../../src/review/reviewer.ts";
import type {
	ManagedPiWorker,
	PiWorkerLauncher,
	PiWorkerRequest,
	ResolvedPiProfile,
} from "../../src/runtime/pi/launcher.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const system = { kind: "SYSTEM", id: "test" } as const;
const rpcState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	sessionId: "fake",
	autoCompactionEnabled: true,
	messageCount: 0,
	pendingMessageCount: 0,
} as RpcSessionState;
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, toolCalls: 1 };

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: TestContext, enableFailureAdaptation = true) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-recovery-test-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = join(root, "repo");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Test User"]);
	await git(repository, ["config", "user.email", "test@example.com"]);
	await writeFile(join(repository, "base.txt"), "base\n");
	await git(repository, ["add", "base.txt"]);
	await git(repository, ["commit", "-m", "base"]);
	const state = join(root, "state");
	const paths: ProjectPaths = {
		root: state,
		database: join(state, "state.db"),
		worktrees: join(state, "worktrees"),
		sessions: join(state, "sessions"),
		artifacts: join(state, "artifacts"),
		logs: join(state, "logs"),
		daemon: join(state, "daemon.json"),
	};
	const workspaces = await GitWorkspaceManager.open(repository, paths.worktrees);
	const snapshot = await workspaces.snapshot("run");
	const integrationRef = await workspaces.initializeIntegrationRef("run", snapshot.commitHash);
	const database = await openControlDatabase(paths.database);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const journal = new OperationJournal(database);
	const resources = new LocalResourceGovernor();
	const check: CheckCommand = {
		name: "feature-check",
		argv: [
			process.execPath,
			"-e",
			"const value=require('fs').readFileSync('feature.txt','utf8').trim();if(value!=='fixed'){console.error('AssertionError: feature expected fixed, got '+value);process.exit(1)}",
		],
		timeoutMs: 5_000,
		lane: "LIGHT_CHECK",
		evidenceClass: "BUILD",
	};
	const config: ProjectConfig = {
		maxAttemptsPerTask: 5,
		maxPlannerExplorations: 2,
		maxDiverseExplorations: 2,
		maxExplorationAttempts: 2,
		maxRepeatedFailureFingerprints: 2,
		workerTimeoutMs: 5_000,
		candidateChecks: [check],
		integrationChecks: [check],
		runChecks: [check],
		reviewRequiredFor: [],
		profiles: { explorer: "explorer", planner: "planner", implementer: "implementer", reviewer: "reviewer" },
	};
	const contract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective: "Add a feature",
		inputCommit: snapshot.commitHash,
		integrationRef,
		goalContract: { executionPolicy: { enableFailureAdaptation } },
		actor: system,
	});
	const addTask = (id: string) => {
		kernel.createTask({
			id,
			runId: "run",
			title: id,
			objective: "Create feature.txt",
			scope: ["feature.txt"],
			constraints: [],
			acceptanceContract: contract,
			riskClass: "LOW",
			actor: system,
		});
		kernel.markTaskReady(id, system);
	};
	addTask("task");
	const launches: Array<{ request: PiWorkerRequest; profile: ResolvedPiProfile; prompt: string }> = [];
	let runWorker = async (_request: PiWorkerRequest, _profile: ResolvedPiProfile, _prompt: string): Promise<string> =>
		"unused";
	const launcher = {
		resolveProfile: (_cwd: string, name: string, tools: string[]) => ({
			name,
			description: "test",
			systemPrompt: "",
			tools,
			version: "fake-profile",
			source: "builtin",
		}),
		create: async (request: PiWorkerRequest, profile: ResolvedPiProfile): Promise<ManagedPiWorker> => ({
			profileVersion: profile.version,
			worker: {
				start: async () => rpcState,
				run: async (prompt) => {
					launches.push({ request, profile, prompt });
					return { state: rpcState, lastAssistantText: await runWorker(request, profile, prompt), usage };
				},
				steer: async () => undefined,
				followUp: async () => undefined,
				abort: async () => undefined,
				state: async () => rpcState,
				stop: async () => undefined,
			},
			close: async () => undefined,
		}),
	} as PiWorkerLauncher;
	const executor = new TaskExecutor(
		kernel,
		catalog,
		journal,
		workspaces,
		launcher,
		{} as PiReviewer,
		new CheckRunner(resources),
		resources,
		paths,
		config,
	);
	return {
		root,
		repository,
		paths,
		workspaces,
		snapshot,
		database,
		kernel,
		catalog,
		journal,
		resources,
		config,
		contract,
		launcher,
		executor,
		launches,
		addTask,
		setWorker: (worker: typeof runWorker) => {
			runWorker = worker;
		},
	};
}

test("failure fingerprints retain assertion values and paths and count recurrence within each task", async (context) => {
	const state = await fixture(context);
	state.addTask("other");
	const policy = new FailurePolicy(state.kernel, state.catalog, state.config);
	const input = {
		runId: "run",
		phase: "CANDIDATE_VERIFY",
		classification: "VERIFICATION" as const,
		detail: "src/feature.ts assertion expected 1 got 2 at line 42",
	};
	assert.equal(policy.diagnose({ ...input, taskId: "task" }).occurrence, 1);
	assert.equal(policy.diagnose({ ...input, taskId: "other" }).occurrence, 1);
	assert.equal(policy.diagnose({ ...input, taskId: "task" }).disposition, "REPLAN");
	assert.equal(
		failureFingerprint(input.phase, input.classification, input.detail),
		failureFingerprint(input.phase, input.classification, input.detail.replace("42", "88")),
	);
	assert.notEqual(
		failureFingerprint(input.phase, input.classification, input.detail),
		failureFingerprint(input.phase, input.classification, input.detail.replace("expected 1", "expected 3")),
	);
	assert.notEqual(
		failureFingerprint(input.phase, input.classification, input.detail),
		failureFingerprint(input.phase, input.classification, input.detail.replace("feature.ts", "other.ts")),
	);
});

test("candidate checks fingerprint real failure output and retries preserve the prior candidate", async (context) => {
	const state = await fixture(context);
	let call = 0;
	state.setWorker(async (request) => {
		call++;
		if (call > 1)
			assert.equal(await readFile(join(request.cwd, "feature.txt"), "utf8"), call === 2 ? "wrong-1\n" : "wrong-2\n");
		await writeFile(join(request.cwd, "feature.txt"), call === 1 ? "wrong-1\n" : call === 2 ? "wrong-2\n" : "fixed\n");
		return "implemented";
	});
	assert.equal(await state.executor.execute("task"), "RETRY");
	const first = state.catalog.latestFailureDiagnosis("task");
	assert.match(first?.detail ?? "", /AssertionError.*wrong-1/);
	assert.equal(await state.executor.execute("task"), "RETRY");
	const second = state.catalog.latestFailureDiagnosis("task");
	assert.match(second?.detail ?? "", /AssertionError.*wrong-2/);
	assert.equal(second?.occurrence, 1);
	assert.notEqual(second?.fingerprint, first?.fingerprint);
	assert.equal(await state.executor.execute("task"), "ACCEPTED");
	assert.equal(call, 3);
});

test("REPLAN runs a read-only diagnostic and persists its report before the next writer", async (context) => {
	const state = await fixture(context);
	let writers = 0;
	state.setWorker(async (request, profile, prompt) => {
		if (profile.name === "planner") {
			assert.deepEqual(profile.tools, ["read", "grep", "find", "ls"]);
			assert.match(prompt, /incorrect assumption/);
			assert.match(prompt, /AssertionError/);
			return "The feature output retains the wrong sentinel. Replace the sentinel with fixed, then run the feature check.";
		}
		writers++;
		if (writers === 3) {
			const messages = state.catalog.listMessages({
				runId: "run",
				recipientKind: "TASK",
				recipientId: "task",
				limit: 100,
			});
			assert.ok(messages.some((message) => message.body.includes('"purpose":"REPLAN"')));
			assert.match(prompt, /Replace the sentinel with fixed/);
		}
		await writeFile(join(request.cwd, "feature.txt"), writers < 3 ? "wrong\n" : "fixed\n");
		return "implemented";
	});
	assert.equal(await state.executor.execute("task"), "RETRY");
	assert.equal(await state.executor.execute("task"), "RETRY");
	assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "REPLAN");
	assert.equal(await state.executor.execute("task"), "ACCEPTED");
	assert.deepEqual(
		state.launches.map((launch) => launch.profile.name),
		["implementer", "implementer", "planner", "implementer"],
	);
});

for (const outcome of ["complete", "decision", "proposal"] as const) {
	test(`resumed workers preserve context binding and handle ${outcome} through the normal gates`, async (context) => {
		const state = await fixture(context);
		const attemptId = "interrupted";
		state.kernel.startAttempt({
			id: attemptId,
			taskId: "task",
			baseCommit: state.snapshot.commitHash,
			profileName: "implementer",
			profileVersion: "fake-profile",
			actor: system,
		});
		const worktree = await state.workspaces.createWorktree(attemptId, state.snapshot.commitHash);
		await writeFile(join(worktree.path, "feature.txt"), "partial\n");
		const executionId = state.kernel.createExecution({
			attemptId,
			piSessionId: "implement-" + attemptId,
			contextManifestHash: "original-binding",
			actor: system,
		});
		state.kernel.finishExecution({ executionId, state: "LOST", actor: system });
		state.kernel.sendMessage({
			runId: "run",
			taskId: "task",
			recipientKind: "TASK",
			recipientId: "task",
			kind: "OBSERVATION",
			body: "New durable observation after the original process stopped",
			actor: system,
		});
		state.setWorker(async (request, _profile, prompt) => {
			assert.equal(request.sessionId, "implement-interrupted");
			assert.match(prompt, /New durable observation/);
			assert.equal(await readFile(join(request.cwd, "feature.txt"), "utf8"), "partial\n");
			await writeFile(join(request.cwd, "feature.txt"), "fixed\n");
			if (outcome === "decision")
				state.kernel.createDecisionRequest({
					runId: "run",
					taskId: "task",
					kind: "REQUIREMENT_CHOICE",
					question: "Which visible behavior is required?",
					options: ["A", "B"],
					sourceKind: "ATTEMPT",
					sourceId: attemptId,
					actor: { kind: "ATTEMPT", id: attemptId },
				});
			if (outcome === "proposal")
				state.kernel.proposeTaskChanges({
					runId: "run",
					changes: {
						additions: [
							{
								key: "prerequisite",
								title: "Prepare feature",
								objective: "Prepare the missing feature prerequisite",
								scope: ["feature.txt"],
								constraints: [],
								acceptanceContract: state.contract,
								riskClass: "LOW",
								priority: 1,
							},
						],
						revisions: [],
						dependencies: [{ task: { taskId: "task" }, dependsOn: { newTaskKey: "prerequisite" }, kind: "REQUIRES" }],
						cancellations: [],
					},
					actor: { kind: "ATTEMPT", id: attemptId },
				});
			return "implemented";
		});
		assert.equal(
			await state.executor.resume(attemptId),
			outcome === "complete" ? "ACCEPTED" : outcome === "decision" ? "BLOCKED" : "RETRY",
		);
		assert.equal(state.catalog.getAttempt(attemptId).contextManifestHash, "original-binding");
		if (outcome !== "complete")
			assert.equal(
				state.database.sql.prepare("SELECT COUNT(*) AS count FROM candidates").get<{ count: number }>()?.count,
				0,
			);
		if (outcome === "proposal") assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "DELEGATE");
	});
}

test("failed adaptive explorations retry within a revision, carry their hypothesis, and stop at the cap", async (context) => {
	const state = await fixture(context);
	const question = {
		key: "design",
		hypothesis: "the implementation should use the existing typed API",
		question: "Which API is compatible?",
	};
	state.kernel.recordTaskCoordination({
		taskId: "task",
		assessment: {
			decomposability: "HIGH",
			sequentiality: "LOW",
			semanticCoupling: "LOW",
			integrationCost: "LOW",
			uncertainty: "HIGH",
			rationale: "Inspect API",
			evidenceRefs: ["base.txt"],
			explorationQuestions: [question],
		},
		contract: {
			provides: [],
			requires: [],
			assumptions: [],
			ownedScope: ["feature.txt"],
			interfaces: [],
			evidenceRefs: [],
		},
		actor: system,
	});
	let calls = 0;
	state.setWorker(async (_request, _profile, prompt) => {
		calls++;
		assert.match(prompt, /existing typed API/);
		throw new Error("repository read unavailable");
	});
	const explorer = new PiExplorer(
		state.kernel,
		state.catalog,
		state.workspaces,
		state.launcher,
		state.resources,
		state.paths,
		state.config,
	);
	const coordinator = new AdaptiveExplorationCoordinator(state.kernel, state.catalog, explorer, state.config);
	await coordinator.explore("task");
	await coordinator.explore("task");
	await coordinator.explore("task");
	assert.equal(calls, 2);
	assert.deepEqual(
		state.catalog.listExplorations("task").map((record) => record.state),
		["FAILED", "FAILED"],
	);
	assert.equal(state.catalog.getTask("task").state, "READY");
});

test("rebase recovery preserves conflicting candidate content for an explicit resolution", async (context) => {
	const state = await fixture(context);
	const first = await state.workspaces.createWorktree("candidate", state.snapshot.commitHash);
	await writeFile(join(first.path, "base.txt"), "candidate side\n");
	const candidate = await state.workspaces.sealCandidate("run", first, "candidate");
	const second = await state.workspaces.createWorktree("integration", state.snapshot.commitHash);
	await writeFile(join(second.path, "base.txt"), "integration side\n");
	const integration = await state.workspaces.sealCandidate("run", second, "integration");
	const retry = await state.workspaces.createWorktree("retry", integration.commitHash);
	const restored = await state.workspaces.restoreCandidate(retry, candidate.commitHash);
	assert.equal(restored.state, "CONFLICTED");
	assert.deepEqual(restored.conflicts, ["base.txt"]);
	const content = await readFile(join(retry.path, "base.txt"), "utf8");
	assert.match(content, /candidate side/);
	assert.match(content, /integration side/);
	await writeFile(join(retry.path, "base.txt"), "resolved\n");
	const resolution = await state.workspaces.sealCandidate("run", retry, "resolution");
	assert.equal(await git(state.repository, ["show", resolution.commitHash + ":base.txt"]), "resolved");
});

test("writer feedback discards exploration handoffs from an old revision or integration baseline", async (context) => {
	const state = await fixture(context);
	const current = state.catalog.getTask("task");
	for (const [id, taskRevisionId, baselineCommit, report] of [
		["old-revision", "old-revision", state.snapshot.commitHash, "STALE_REVISION_REPORT"],
		["old-baseline", current.revisionId, "old-baseline", "STALE_BASELINE_REPORT"],
		["current", current.revisionId, state.snapshot.commitHash, "CURRENT_REPORT"],
	]) {
		state.kernel.startAuxiliaryAttempt({
			id,
			runId: "run",
			taskId: "task",
			workflowFunction: "EXPLORE",
			baseCommit: state.snapshot.commitHash,
			profileName: "explorer",
			profileVersion: "fake-profile",
			actor: system,
		});
		state.kernel.sendMessage({
			runId: "run",
			taskId: "task",
			recipientKind: "TASK",
			recipientId: "task",
			kind: "HANDOFF",
			body: JSON.stringify({ taskRevisionId, baselineCommit, report }),
			actor: { kind: "ATTEMPT", id: id as string },
		});
		state.kernel.completeAuxiliaryAttempt(id as string, system);
	}
	state.setWorker(async (request, _profile, prompt) => {
		assert.doesNotMatch(prompt, /STALE_REVISION_REPORT|STALE_BASELINE_REPORT/);
		assert.match(prompt, /CURRENT_REPORT/);
		await writeFile(join(request.cwd, "feature.txt"), "fixed\n");
		return "implemented";
	});
	assert.equal(await state.executor.execute("task"), "ACCEPTED");
});

test("failure adaptation ablation preserves candidate work and enforces checks with bounded retries", async (context) => {
	const state = await fixture(context, false);
	let count = 0;
	state.setWorker(async (request, profile) => {
		assert.equal(profile.name, "implementer");
		if (count++ > 0) assert.equal(await readFile(join(request.cwd, "feature.txt"), "utf8"), "wrong\n");
		await writeFile(join(request.cwd, "feature.txt"), "wrong\n");
		return "implemented";
	});
	assert.equal(await state.executor.execute("task"), "RETRY");
	assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "RETRY");
	assert.equal(await state.executor.execute("task"), "RETRY");
	assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "RETRY");
	assert.equal(await state.executor.execute("task"), "BLOCKED");
	assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "BLOCK");
	assert.equal(count, 3);
	assert.equal(state.catalog.getTask("task").state, "BLOCKED");
});

test("failure adaptation ablation rejects writer graph changes before the bounded retry", async (context) => {
	const state = await fixture(context, false);
	state.setWorker(async (request) => {
		const attemptId = request.sessionId.slice("implement-".length);
		state.kernel.proposeTaskChanges({
			runId: "run",
			changes: {
				additions: [
					{
						key: "prerequisite",
						title: "Prepare feature",
						objective: "Prepare missing prerequisite",
						scope: ["feature.txt"],
						constraints: [],
						acceptanceContract: state.contract,
						riskClass: "LOW",
						priority: 1,
					},
				],
				revisions: [],
				dependencies: [{ task: { taskId: "task" }, dependsOn: { newTaskKey: "prerequisite" }, kind: "REQUIRES" }],
				cancellations: [],
			},
			actor: { kind: "ATTEMPT", id: attemptId },
		});
		return "graph change requested";
	});
	assert.equal(await state.executor.execute("task"), "RETRY");
	assert.equal(state.catalog.listTaskChangeProposals("run")[0]?.state, "REJECTED");
	assert.equal(state.catalog.listTasks("run").length, 1);
	assert.equal(state.catalog.latestFailureDiagnosis("task")?.disposition, "RETRY");
});
