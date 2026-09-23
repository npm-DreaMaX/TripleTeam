import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { parseExecutionPolicy } from "../../src/config/execution.ts";
import type { ProjectPaths } from "../../src/config/paths.ts";
import type { CheckCommand, ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { Reconciler } from "../../src/control/reconciler.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { RunScheduler } from "../../src/control/scheduler.ts";
import { ReconciliationRequiredError, TaskExecutor } from "../../src/control/task-executor.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import { PiReviewer } from "../../src/review/reviewer.ts";
import type {
	ManagedPiWorker,
	PiWorkerLauncher,
	PiWorkerRequest,
	ResolvedPiProfile,
} from "../../src/runtime/pi/launcher.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { AssuranceService } from "../../src/verification/assurance-service.ts";
import { type AssuranceDefinition, parseAssurancePolicy } from "../../src/verification/assurance-types.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { RunVerifier } from "../../src/verification/run-verifier.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const actor = { kind: "SYSTEM", id: "assurance-execution-test" } as const;
const goal = "encode('a b') must return 'a%20b'.";
const baselineCode = "export function encode(value) { return value; }\n";
const incorrectCode = "export function encode(value) { return value.replaceAll(' ', '+'); }\n";
const correctCode = "export function encode(value) { return encodeURIComponent(value); }\n";
const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, toolCalls: 0 };
const rpcState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	sessionId: "offline-execution",
	autoCompactionEnabled: true,
	messageCount: 0,
	pendingMessageCount: 0,
} as RpcSessionState;
const assuranceFailure = (error: unknown) =>
	error instanceof DomainInvariantError && error.code.startsWith("ASSURANCE_");
const definition: AssuranceDefinition = {
	obligations: [
		{
			id: "space",
			behavior: "Encode spaces as %20.",
			risk: "HIGH",
			sources: [{ kind: "GOAL", quote: goal }],
		},
	],
	probes: [
		{
			id: "space_probe",
			obligations: ["space"],
			language: "javascript",
			setup:
				"const assert = (await import('node:assert/strict')).default; const { encode } = await import('./encoder.mjs'); const actual = encode('a b');",
			assertions: "assert.equal(actual, 'a%20b');",
			contrastSetup: "const assert = (await import('node:assert/strict')).default; const actual = 'a+b';",
			contrastReason: "Form encoding incorrectly substitutes a plus sign for a space.",
		},
	],
	assumptions: [],
};

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(
	context: TestContext,
	writerOutputs = [correctCode],
	options: { proposed?: AssuranceDefinition; failureAdaptation?: boolean; emptyCritique?: boolean } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-assurance-execution-"));
	const repository = join(directory, "repo");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Assurance Execution Test"]);
	await git(repository, ["config", "user.email", "assurance@example.test"]);
	await writeFile(join(repository, "encoder.mjs"), baselineCode);
	await git(repository, ["add", "."]);
	await git(repository, ["commit", "-m", "public baseline"]);
	const state = join(directory, "state");
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
	const baseline = await workspaces.snapshot("run");
	const integrationRef = await workspaces.initializeIntegrationRef("run", baseline.commitHash);
	const database = await openControlDatabase(paths.database);
	context.after(async () => {
		database.close();
		await rm(directory, { recursive: true, force: true });
	});
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const journal = new OperationJournal(database);
	const resources = new LocalResourceGovernor();
	const checks = new CheckRunner(resources);
	const check: CheckCommand = {
		name: "structural",
		argv: ["git", "diff", "--check"],
		timeoutMs: 5000,
		lane: "LIGHT_CHECK",
		evidenceClass: "STRUCTURAL",
	};
	const assurancePolicy = parseAssurancePolicy({
		mode: "required",
		maxDesignAttempts: 1,
		maxProbes: 1,
		repetitions: 2,
		probeTimeoutMs: 5000,
	});
	const executionPolicy = parseExecutionPolicy({
		policy: "FIXED",
		maxParallelism: 1,
		maxExecutions: 16,
		maxFinalRepairs: 0,
		enableFailureAdaptation: options.failureAdaptation ?? true,
	});
	const config: ProjectConfig = {
		maxAttemptsPerTask: 3,
		maxPlannerExplorations: 1,
		maxRepeatedFailureFingerprints: 2,
		workerTimeoutMs: 5000,
		candidateChecks: [check],
		integrationChecks: [check],
		runChecks: [check],
		reviewRequiredFor: [],
		profiles: {
			planner: "planner",
			explorer: "explorer",
			implementer: "implementer",
			reviewer: "reviewer",
			verifier: "verifier",
		},
		assurance: assurancePolicy,
		execution: executionPolicy,
	};
	const contract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective: goal,
		inputCommit: baseline.commitHash,
		inputTreeHash: baseline.treeHash,
		integrationRef,
		goalContract: {
			objective: goal,
			authorizedScope: ["encoder.mjs"],
			assurancePolicy,
			executionPolicy,
			runChecks: [check],
			taskAcceptancePolicy: { ...contract, reviewRequiredFor: [] },
		},
		actor,
	});
	kernel.createTask({
		id: "task",
		runId: "run",
		title: "Encode URI spaces",
		objective: goal,
		scope: ["encoder.mjs"],
		constraints: [],
		acceptanceContract: contract,
		riskClass: "HIGH",
		actor,
	});
	const launches: Array<{ profile: string; prompt: string; commit: string; before?: string }> = [];
	let writers = 0;
	let critics = 0;
	const launcher = {
		resolveProfile: (_cwd: string, name: string, tools: string[]): ResolvedPiProfile => ({
			name,
			description: "Offline fixture",
			systemPrompt: "",
			tools,
			version: "offline",
			source: "builtin",
		}),
		create: async (request: PiWorkerRequest, profile: ResolvedPiProfile): Promise<ManagedPiWorker> => ({
			profileVersion: profile.version,
			worker: {
				start: async () => rpcState,
				state: async () => rpcState,
				run: async (prompt) => {
					const commit = await git(request.cwd, ["rev-parse", "HEAD"]);
					let text: string;
					if (profile.name === "implementer") {
						assert.ok(kernel.assurance.get("task"), "The independent plan must freeze before writer execution");
						const before = await readFile(join(request.cwd, "encoder.mjs"), "utf8");
						launches.push({ profile: profile.name, prompt, commit, before });
						const output = writerOutputs[writers++];
						assert.ok(output, "No extra writer attempt is expected");
						await writeFile(join(request.cwd, "encoder.mjs"), output);
						text = "Implementation candidate prepared.";
					} else {
						assert.equal(writers, 0, "Design and critique must use the pre-writer baseline");
						assert.equal(commit, baseline.commitHash);
						launches.push({ profile: profile.name, prompt, commit });
						text = JSON.stringify(
							profile.name === "verifier"
								? (options.proposed ?? definition)
								: { approved: true, reason: "Matches the public goal." },
						);
					}
					if (profile.name === "reviewer" && options.emptyCritique && critics++ === 0) text = "";
					return { state: rpcState, lastAssistantText: text, usage };
				},
				steer: async () => undefined,
				followUp: async () => undefined,
				abort: async () => undefined,
				stop: async () => undefined,
			},
			close: async () => undefined,
		}),
	} as PiWorkerLauncher;
	const reviewer = new PiReviewer(kernel, catalog, workspaces, launcher, resources, paths, config);
	const executor = new TaskExecutor(
		kernel,
		catalog,
		journal,
		workspaces,
		launcher,
		reviewer,
		checks,
		resources,
		paths,
		config,
	);
	const assurance = new AssuranceService({ kernel, catalog, workspaces, launcher, checks, resources, paths, config });
	const verifier = new RunVerifier(kernel, catalog, workspaces, checks, paths, config, assurance);
	const structuralVerifier = new RunVerifier(kernel, catalog, workspaces, checks, paths, config);
	const scheduler = new RunScheduler(kernel, catalog, executor, verifier, resources);
	const reconciler = new Reconciler(database, kernel, catalog, journal, workspaces, config);
	const ready = () => kernel.markTaskReady("task", actor);
	const otherCorrectTree = async () => {
		const workspace = await workspaces.createWorktree("alternate-" + randomUUID(), baseline.commitHash);
		try {
			await writeFile(join(workspace.path, "encoder.mjs"), correctCode);
			await writeFile(join(workspace.path, "unrelated.txt"), "A different exact tree.\n");
			return await workspaces.sealCandidate("run", workspace, "alternate passing tree");
		} finally {
			await workspaces.removeWorktree(workspace);
		}
	};
	return {
		database,
		kernel,
		catalog,
		journal,
		workspaces,
		baseline,
		integrationRef,
		executor,
		assurance,
		verifier,
		structuralVerifier,
		scheduler,
		reconciler,
		checks,
		launches,
		ready,
		otherCorrectTree,
	};
}

test("truncated critique is repaired in the same attempt without redesigning or bypassing the gate", async (context) => {
	const state = await fixture(context, [correctCode], { emptyCritique: true });
	const plan = await state.assurance.ensure(state.catalog.getTask("task"));
	assert.ok(plan);
	assert.deepEqual(
		state.launches.map((launch) => launch.profile),
		["verifier", "reviewer", "reviewer"],
	);
	assert.equal(state.kernel.assurance.get("task")?.id, plan.id);
	assert.equal(state.catalog.listControlActions("run", "ASSURANCE_CRITIQUE_FORMAT_REPAIR").length, 1);
	assert.equal(state.database.sql.prepare("SELECT COUNT(*) AS n FROM executions").get<{ n: number }>()?.n, 2);
	assert.equal(
		state.database.sql.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE kind='AGENT'").get<{ n: number }>()?.n,
		3,
	);
});

test("scheduler retries an assurance-rejected writer and completes only after candidate, integration and run probes", async (context) => {
	const state = await fixture(context, [incorrectCode, correctCode]);
	const result = await state.scheduler.runUntilSettled("run");
	assert.equal(result.state, "COMPLETED");
	assert.equal(state.catalog.getTask("task").state, "ACCEPTED");
	assert.equal(await state.workspaces.resolveRef(state.integrationRef), result.integrationHead);
	const tree = await state.workspaces.treeHash(result.integrationHead);
	assert.deepEqual(
		state.launches.map((launch) => launch.profile),
		["verifier", "reviewer", "implementer", "implementer"],
	);
	assert.equal(state.launches[2]?.before, baselineCode);
	assert.equal(state.launches[3]?.before, incorrectCode);
	assert.match(state.launches[3]?.prompt ?? "", /INDEPENDENT_VERIFY|space_probe/);
	const candidates = state.database.sql
		.prepare("SELECT id,state,tree_hash FROM candidates ORDER BY rowid")
		.all<{ id: string; state: string; tree_hash: string }>();
	assert.equal(candidates.length, 2);
	assert.equal(candidates[0]?.state, "REJECTED");
	assert.equal(candidates[1]?.state, "INTEGRATED");
	assert.equal(candidates[1]?.tree_hash, tree);
	const failure = state.database.sql
		.prepare("SELECT phase,classification,disposition,evidence_refs_json FROM failure_diagnoses ORDER BY rowid LIMIT 1")
		.get<{ phase: string; classification: string; disposition: string; evidence_refs_json: string }>();
	assert.ok(failure);
	assert.equal(failure.phase, "INDEPENDENT_VERIFY");
	assert.equal(failure.classification, "VERIFICATION");
	assert.equal(failure.disposition, "RETRY");
	assert.equal((JSON.parse(failure.evidence_refs_json) as unknown[]).length, 2);
	const evaluations = state.database.sql
		.prepare("SELECT subject_kind,state,tree_hash FROM assurance_evaluations ORDER BY rowid")
		.all<{ subject_kind: string; state: string; tree_hash: string }>();
	assert.deepEqual(
		evaluations.map((evaluation) => [evaluation.subject_kind, evaluation.state]),
		[
			["CANDIDATE", "FAILED"],
			["CANDIDATE", "PASSED"],
			["INTEGRATION", "PASSED"],
			["RUN", "PASSED"],
		],
	);
	assert.ok(evaluations.slice(1).every((evaluation) => evaluation.tree_hash === tree));
	for (const subject of ["CANDIDATE", "INTEGRATION", "RUN"]) {
		const probes = state.database.sql
			.prepare(
				"SELECT state,tree_hash FROM check_runs WHERE subject_kind=? AND json_extract(result_json,'$.assurance.control')=0 AND state='PASSED'",
			)
			.all<{ state: string; tree_hash: string }>(subject);
		assert.equal(probes.length, 2, subject + " requires its own repeated probes");
		assert.ok(probes.every((probe) => probe.tree_hash === tree));
	}
});

for (const failureAdaptation of [true, false])
	test(`exhausted independent design blocks without empty writer retries (adaptation=${failureAdaptation})`, async (context) => {
		const proposed = structuredClone(definition);
		const source = proposed.obligations[0]?.sources[0];
		assert.ok(source);
		source.quote = "This requirement does not occur in the public sources.";
		const state = await fixture(context, [], { proposed, failureAdaptation });
		const result = await state.scheduler.runUntilSettled("run");
		assert.equal(result.state, "BLOCKED");
		assert.deepEqual(
			state.launches.map((launch) => launch.profile),
			["verifier"],
		);
		assert.equal(state.catalog.countAttempts("task"), 1);
		const diagnosis = state.catalog.latestFailureDiagnosis("task");
		assert.equal(diagnosis?.phase, "SPECIFICATION_DESIGN");
		assert.equal(diagnosis?.classification, "VERIFICATION");
		assert.equal(diagnosis?.disposition, "BLOCK");
		assert.match(diagnosis?.detail ?? "", /Untraceable specification quotation/);
		assert.equal(state.catalog.getTask("task").state, "BLOCKED");
		assert.equal(await state.workspaces.resolveRef(state.integrationRef), state.baseline.commitHash);
	});

for (const alreadyPublished of [false, true]) {
	test(
		"integration recovery cannot bypass missing or obsolete evidence " +
			(alreadyPublished ? "after" : "before") +
			" Git publication",
		async (context) => {
			const state = await fixture(context);
			state.ready();
			const evaluate = AssuranceService.prototype.evaluate;
			const omitted = context.mock.method(
				AssuranceService.prototype,
				"evaluate",
				async function (this: AssuranceService, ...args: Parameters<AssuranceService["evaluate"]>) {
					if (args[2] === "INTEGRATION")
						return { status: "PASSED" as const, checkIds: [], detail: "Probe dispatch was omitted" };
					return evaluate.apply(this, args);
				},
			);
			try {
				await assert.rejects(
					state.executor.execute("task"),
					(error: unknown) => error instanceof ReconciliationRequiredError && assuranceFailure(error.cause),
				);
			} finally {
				omitted.mock.restore();
			}
			const pending = state.database.sql
				.prepare("SELECT id,state FROM integrations")
				.get<{ id: string; state: string }>();
			assert.ok(pending);
			assert.equal(pending.state, "APPLYING");
			const operation = state.journal.find("UPDATE_INTEGRATION_REF", pending.id);
			assert.ok(operation);
			const intent = operation.desiredState as {
				ref: string;
				expectedHead: string;
				resultCommit: string;
				resultTreeHash: string;
			};
			assert.equal(await state.workspaces.resolveRef(state.integrationRef), state.baseline.commitHash);
			assert.throws(
				() => state.kernel.assertIntegrationPublishable(pending.id, intent.resultTreeHash),
				assuranceFailure,
			);
			const commit = () =>
				state.kernel.commitIntegration({
					integrationId: pending.id,
					resultCommit: intent.resultCommit,
					resultTreeHash: intent.resultTreeHash,
					actor,
				});
			assert.throws(commit, assuranceFailure);
			if (alreadyPublished) {
				await state.workspaces.publishIntegration({
					integrationRef: intent.ref,
					expectedHead: intent.expectedHead,
					resultCommit: intent.resultCommit,
				});
				state.journal.markObservedCompleted(operation.id, {
					commitHash: intent.resultCommit,
					treeHash: intent.resultTreeHash,
				});
			}
			await assert.rejects(state.reconciler.reconcile("run"), assuranceFailure);
			assert.equal(state.catalog.getRun("run").integrationHead, state.baseline.commitHash);
			assert.equal(state.catalog.getTask("task").state, "ACTIVE");
			assert.equal(
				await state.workspaces.resolveRef(state.integrationRef),
				alreadyPublished ? intent.resultCommit : state.baseline.commitHash,
			);
			assert.equal(
				(await state.assurance.evaluate(["task"], intent.resultCommit, "INTEGRATION", pending.id)).status,
				"PASSED",
			);
			assert.doesNotThrow(() => state.kernel.assertIntegrationPublishable(pending.id, intent.resultTreeHash));
			const plan = state.kernel.assurance.get("task");
			assert.ok(plan);
			state.kernel.assurance.beginEvaluation(plan, intent.resultTreeHash, "INTEGRATION", pending.id);
			assert.throws(commit, assuranceFailure);
			await assert.rejects(state.reconciler.reconcile("run"), assuranceFailure);
			assert.equal(state.catalog.getRun("run").integrationHead, state.baseline.commitHash);
			assert.equal(
				(await state.assurance.evaluate(["task"], intent.resultCommit, "INTEGRATION", pending.id)).status,
				"PASSED",
			);
			const recovered = await state.reconciler.reconcile("run");
			assert.equal(recovered.recoveredIntegrations, 1);
			assert.equal(state.catalog.getRun("run").integrationHead, intent.resultCommit);
			assert.equal(await state.workspaces.resolveRef(state.integrationRef), intent.resultCommit);
			assert.equal(state.catalog.getTask("task").state, "ACCEPTED");
			assert.equal(state.journal.find("UPDATE_INTEGRATION_REF", pending.id)?.phase, "COMPLETED");
			assert.equal(state.launches.length, 3);
		},
	);
}

test("final acceptance requires its own current-tree complete probe batch despite prior integration and run successes", async (context) => {
	const state = await fixture(context);
	state.ready();
	assert.equal(await state.executor.execute("task"), "ACCEPTED");
	const run = state.catalog.getRun("run");
	const tree = await state.workspaces.treeHash(run.integrationHead);
	const complete = () => state.kernel.completeRun({ runId: "run", treeHash: tree }, actor);
	assert.equal((await state.structuralVerifier.verify("run")).status, "PASSED");
	assert.throws(complete, assuranceFailure);
	const alternate = await state.otherCorrectTree();
	assert.notEqual(alternate.treeHash, tree);
	assert.equal((await state.assurance.evaluate(["task"], alternate.commitHash, "RUN", "run")).status, "PASSED");
	assert.throws(complete, assuranceFailure);
	const verified = await state.verifier.verify("run");
	assert.equal(verified.status, "PASSED");
	assert.equal(verified.treeHash, tree);
	assert.equal(verified.checkIds.length, 3);
	const check = state.checks.run.bind(state.checks);
	const interrupted = context.mock.method(state.checks, "run", async (...args: Parameters<CheckRunner["run"]>) => {
		if (args[0].name.startsWith("assurance:")) throw new Error("Final probe infrastructure interrupted");
		return check(...args);
	});
	try {
		await assert.rejects(state.verifier.verify("run"), /Final probe infrastructure interrupted/);
		assert.throws(complete, assuranceFailure);
		assert.equal(state.catalog.getRun("run").state, "OPEN");
	} finally {
		interrupted.mock.restore();
	}
	assert.equal((await state.verifier.verify("run")).status, "PASSED");
	complete();
	assert.equal(state.catalog.getRun("run").state, "COMPLETED");
	assert.equal(state.launches.length, 3);
});
