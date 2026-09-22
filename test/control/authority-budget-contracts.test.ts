import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import { type CheckCommand, checkCommandVersion, evidenceClassForCheck } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ContractVerifier } from "../../src/control/contract-verifier.ts";
import { ControlKernel, type TaskChangeSet, type TaskCoordinationInput } from "../../src/control/kernel.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { TaskExecutor } from "../../src/control/task-executor.ts";
import { BoundedTaskProposalPolicy } from "../../src/control/task-proposal-policy.ts";
import type { PiReviewer } from "../../src/review/reviewer.ts";
import { PiWorkerLauncher, type PiWorkerRequest, type ResolvedPiProfile } from "../../src/runtime/pi/launcher.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { MIGRATIONS } from "../../src/store/schema.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

const execFileAsync = promisify(execFile);
const system = { kind: "SYSTEM", id: "authority-test" } as const;
const user = { kind: "USER", id: "local-user" } as const;
const check: CheckCommand = {
	name: "interface-check",
	argv: ["node", "--test"],
	timeoutMs: 5_000,
	lane: "LIGHT_CHECK",
	evidenceClass: "BUILD",
};
const acceptance = { candidateChecks: [check], integrationChecks: [check], requireReview: false };
const assessment: TaskCoordinationInput["assessment"] = {
	decomposability: "HIGH",
	sequentiality: "LOW",
	semanticCoupling: "LOW",
	integrationCost: "LOW",
	uncertainty: "LOW",
	rationale: "Test fixture defines the exact interface boundary",
	evidenceRefs: [],
	explorationQuestions: [],
};

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: TestContext, decisionMode = "interactive") {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-authority-"));
	const repository = join(root, "repo");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Authority Test"]);
	await git(repository, ["config", "user.email", "authority@example.test"]);
	await writeFile(join(repository, "api.ts"), "export type Value = unknown;\n");
	await writeFile(join(repository, "schema.json"), "{}\n");
	await writeFile(
		join(repository, ".tripleteam.json"),
		JSON.stringify({
			execution: { decisionMode },
			candidateChecks: [check],
			integrationChecks: [check],
			runChecks: [check],
			reviewRequiredFor: [],
		}),
	);
	await git(repository, ["add", "."]);
	await git(repository, ["commit", "-m", "baseline"]);
	const app = await LocalOrchestrator.open(repository);
	context.after(async () => {
		app.close();
		await rm(app.paths.root, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const initialized = await app.initialize("Implement a compatible interface");
	const runId = initialized.runId;
	const addTask = (id: string, scope = ["src"]) => {
		app.kernel.createTask({
			id,
			runId,
			title: id,
			objective: "Implement " + id,
			scope,
			constraints: [],
			acceptanceContract: acceptance,
			riskClass: "LOW",
			actor: system,
		});
		app.kernel.markTaskReady(id, system);
		return id;
	};
	const start = (taskId: string, suffix = "") =>
		app.kernel.startAttempt({
			id: taskId + "-attempt" + suffix,
			taskId,
			baseCommit: app.catalog.getRun(runId).integrationHead,
			profileName: "implementer",
			profileVersion: "1",
			actor: system,
		});
	const coordinate = (taskId: string, provides: string[], requires: string[] = []) =>
		app.kernel.recordTaskCoordination({
			taskId,
			assessment,
			contract: {
				provides,
				requires,
				assumptions: [],
				ownedScope: app.catalog.getTask(taskId).scope as string[],
				interfaces: provides,
				evidenceRefs: [],
				obligations: provides.map((key) => ({
					key,
					artifactPaths: [key === "api" ? "api.ts" : "schema.json"],
					checkNames: [check.name],
				})),
			},
			actor: system,
		});
	const verifier = new ContractVerifier(app.kernel, app.catalog, app.workspaces);
	return { app, runId, addTask, start, coordinate, verifier };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function recordCheck(
	f: Fixture,
	taskId: string,
	subjectKind: "CANDIDATE" | "INTEGRATION",
	subjectId: string,
	treeHash: string,
	options: { name?: string; state?: "PASSED" | "FAILED" } = {},
): string {
	return f.app.kernel.recordCheckResult({
		runId: f.runId,
		taskId,
		subjectKind,
		subjectId,
		treeHash,
		checkKind: options.name ?? check.name,
		checkVersion: checkCommandVersion(check),
		evidenceClass: evidenceClassForCheck(check),
		command: check.argv,
		environmentHash: "fixture",
		state: options.state ?? "PASSED",
		actor: system,
	});
}

async function preparedProducer(f: Fixture) {
	f.addTask("producer", ["api.ts", "schema.json"]);
	f.coordinate("producer", ["api", "schema"]);
	const attempt = f.start("producer");
	const run = f.app.catalog.getRun(f.runId);
	const workspace = await f.app.workspaces.createWorktree(attempt.attemptId, run.integrationHead);
	await writeFile(join(workspace.path, "api.ts"), "export type Value = string;\n");
	await writeFile(join(workspace.path, "schema.json"), '{"type":"string"}\n');
	const candidate = await f.app.workspaces.sealCandidate(f.runId, workspace, "publish interface");
	const candidateId = f.app.kernel.submitCandidate({
		taskId: "producer",
		attemptId: attempt.attemptId,
		attemptEpoch: attempt.epoch,
		baseCommit: run.integrationHead,
		...candidate,
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	recordCheck(f, "producer", "CANDIDATE", candidateId, candidate.treeHash);
	f.app.kernel.markCandidateEligible(candidateId, system);
	const integrationId = f.app.kernel.queueIntegration({
		candidateId,
		expectedHead: run.integrationHead,
		actor: system,
	});
	f.app.kernel.markIntegrationApplying(integrationId, system);
	const integration = await f.app.workspaces.prepareIntegration({
		runId: f.runId,
		integrationRef: run.integrationRef,
		expectedHead: run.integrationHead,
		candidateCommit: candidate.commitHash,
	});
	const checkId = recordCheck(f, "producer", "INTEGRATION", integrationId, integration.treeHash);
	return { attempt, integration, integrationId, checkId, expectedHead: run.integrationHead };
}

async function acceptProducer(f: Fixture, producer: Awaited<ReturnType<typeof preparedProducer>>) {
	await f.verifier.verify("producer", producer.integration.commitHash, producer.integration.treeHash, [
		producer.checkId,
	]);
	await f.app.workspaces.publishIntegration({
		integrationRef: f.app.catalog.getRun(f.runId).integrationRef,
		expectedHead: producer.expectedHead,
		resultCommit: producer.integration.commitHash,
	});
	f.app.kernel.commitIntegration({
		integrationId: producer.integrationId,
		resultCommit: producer.integration.commitHash,
		resultTreeHash: producer.integration.treeHash,
		actor: system,
	});
	f.app.kernel.acceptTask({ taskId: "producer", integrationId: producer.integrationId, actor: system });
}

test("contracts require artifacts and named passing checks for the same commit/tree before integration", async (context) => {
	const f = await fixture(context);
	const producer = await preparedProducer(f);
	assert.throws(
		() =>
			f.app.kernel.commitIntegration({
				integrationId: producer.integrationId,
				resultCommit: producer.integration.commitHash,
				resultTreeHash: producer.integration.treeHash,
				actor: system,
			}),
		{ code: "UNPROVEN_CONTRACT" },
	);
	assert.throws(() =>
		f.app.kernel.acceptTask({ taskId: "producer", integrationId: producer.integrationId, actor: system }),
	);
	for (const invalid of [
		recordCheck(f, "producer", "INTEGRATION", producer.integrationId, producer.integration.treeHash, {
			name: "unrelated",
		}),
		recordCheck(f, "producer", "INTEGRATION", producer.integrationId, producer.integration.treeHash, {
			state: "FAILED",
		}),
		recordCheck(f, "producer", "INTEGRATION", producer.integrationId, "0".repeat(40)),
	])
		await assert.rejects(
			f.verifier.verify("producer", producer.integration.commitHash, producer.integration.treeHash, [invalid]),
			{ code: "MISSING_CONTRACT_CHECK" },
		);
	await assert.rejects(
		f.verifier.verify("producer", producer.integration.commitHash, "0".repeat(40), [producer.checkId]),
		{ code: "CONTRACT_TREE_MISMATCH" },
	);
	assert.equal(f.app.catalog.getCoordinationContract("producer")?.state, "BOUND");
	await acceptProducer(f, producer);
	assert.equal(f.app.catalog.getTask("producer").state, "ACCEPTED");
	const contract = f.app.catalog.getCoordinationContract("producer");
	assert.equal(contract?.state, "SATISFIED");
	const proof = f.app.catalog.listContractEvidence(contract?.id as string);
	assert.deepEqual(proof.map((entry) => entry.obligation).sort(), ["api", "schema"]);
	for (const entry of proof) {
		assert.equal(entry.treeHash, producer.integration.treeHash);
		assert.deepEqual(entry.checkIds, [producer.checkId]);
		assert.equal(entry.artifacts.length, 1);
	}
});

test("consumers bind every requirement to a unique accepted producer and reject changed artifacts", async (context) => {
	const f = await fixture(context);
	const producer = await preparedProducer(f);
	f.addTask("consumer", ["client.ts"]);
	f.coordinate("consumer", [], ["api", "schema"]);
	const premature = f.start("consumer", "-premature");
	await assert.rejects(f.verifier.bindRequirements("consumer", premature.attemptId, producer.expectedHead), {
		code: "UNRESOLVED_CONTRACT",
	});
	f.app.kernel.failAttempt({
		attemptId: premature.attemptId,
		reason: "Wait for proven producer",
		retryTask: true,
		actor: system,
	});
	await acceptProducer(f, producer);
	const consumer = f.start("consumer", "-ready");
	await f.verifier.bindRequirements("consumer", consumer.attemptId, producer.integration.commitHash);
	const binding = f.app.database.sql
		.prepare("SELECT evidence_ids_json FROM contract_consumptions WHERE attempt_id=?")
		.get<{ evidence_ids_json: string }>(consumer.attemptId);
	assert.equal((JSON.parse(binding?.evidence_ids_json ?? "[]") as string[]).length, 2);
	await f.verifier.assertPreserved(f.runId, producer.integration.commitHash);
	const workspace = await f.app.workspaces.createWorktree("mutated-api", producer.integration.commitHash);
	await writeFile(join(workspace.path, "api.ts"), "export type Value = number;\n");
	const altered = await f.app.workspaces.sealCandidate(f.runId, workspace, "incompatible API");
	await assert.rejects(f.verifier.assertPreserved(f.runId, altered.commitHash), { code: "STALE_CONTRACT_ARTIFACT" });
	f.addTask("duplicate", ["another.ts"]);
	f.coordinate("duplicate", ["api"]);
	await assert.rejects(f.verifier.bindRequirements("consumer", consumer.attemptId, producer.integration.commitHash), {
		code: "UNRESOLVED_CONTRACT",
	});
});

test(
	"a published artifact cannot silently change its executable mode",
	{ skip: process.platform === "win32" },
	async (context) => {
		const f = await fixture(context);
		const producer = await preparedProducer(f);
		await acceptProducer(f, producer);
		const workspace = await f.app.workspaces.createWorktree("mode-change", producer.integration.commitHash);
		await chmod(join(workspace.path, "api.ts"), 0o755);
		const altered = await f.app.workspaces.sealCandidate(f.runId, workspace, "change artifact mode");
		assert.notEqual(altered.treeHash, producer.integration.treeHash);
		await assert.rejects(f.verifier.assertPreserved(f.runId, altered.commitHash), { code: "STALE_CONTRACT_ARTIFACT" });
	},
);

test("new exact-tree contract proofs preserve old baselines and authorize only the proven artifacts", async (context) => {
	const f = await fixture(context);
	const producer = await preparedProducer(f);
	await acceptProducer(f, producer);
	f.addTask("consumer", ["client.ts"]);
	f.coordinate("consumer", [], ["api", "schema"]);
	const consumer = f.start("consumer");
	const workspace = await f.app.workspaces.createWorktree("compatible-api", producer.integration.commitHash);
	await writeFile(join(workspace.path, "api.ts"), "// Compatible implementation update\nexport type Value = string;\n");
	const updated = await f.app.workspaces.sealCandidate(f.runId, workspace, "compatible API update");
	const updatedCheck = recordCheck(f, "producer", "INTEGRATION", producer.integrationId, updated.treeHash);
	await f.verifier.verify("producer", updated.commitHash, updated.treeHash, [updatedCheck]);
	await f.verifier.assertPreserved(f.runId, producer.integration.commitHash);
	await f.verifier.bindRequirements("consumer", consumer.attemptId, producer.integration.commitHash);
	await f.verifier.assertPreserved(f.runId, updated.commitHash);
	const contract = f.app.catalog.getCoordinationContract("producer");
	const proofs = f.app.catalog.listContractEvidence(contract?.id as string);
	assert.equal(proofs.length, 4);
	assert.equal(contract?.version, 1);
	await writeFile(join(workspace.path, "api.ts"), "export type Value = number;\n");
	const unproven = await f.app.workspaces.sealCandidate(f.runId, workspace, "unproven interface update");
	await assert.rejects(f.verifier.assertPreserved(f.runId, unproven.commitHash), { code: "STALE_CONTRACT_ARTIFACT" });
});

test("the real executor rechecks transitive accepted consumers before publishing a changed interface", async (context) => {
	const f = await fixture(context);
	const producer = await preparedProducer(f);
	await acceptProducer(f, producer);
	const launcher = new PiWorkerLauncher();
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
	let edit = async (_cwd: string) => {};
	context.mock.method(launcher, "create", async (request: PiWorkerRequest, profile: ResolvedPiProfile) => ({
		profileVersion: profile.version,
		worker: {
			start: async () => rpcState,
			state: async () => rpcState,
			steer: async () => {},
			followUp: async () => {},
			abort: async () => {},
			stop: async () => {},
			run: async () => {
				if (request.profileName === f.app.config.profiles.implementer) await edit(request.cwd);
				return {
					state: rpcState,
					lastAssistantText: "Preserve the string interface and recheck its consumers.",
					usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, toolCalls: 1 },
				};
			},
		},
		close: async () => {},
	}));
	const executor = new TaskExecutor(
		f.app.kernel,
		f.app.catalog,
		new OperationJournal(f.app.database),
		f.app.workspaces,
		launcher,
		{} as PiReviewer,
		new CheckRunner(f.app.resources),
		f.app.resources,
		f.app.paths,
		f.app.config,
	);
	const addCheckedTask = (id: string, file: string, script: string) => {
		const taskCheck: CheckCommand = { ...check, name: id + "-check", argv: [process.execPath, "-e", script] };
		f.app.kernel.createTask({
			id,
			runId: f.runId,
			title: id,
			objective: "Implement " + id,
			scope: [file],
			constraints: [],
			riskClass: "LOW",
			acceptanceContract: { candidateChecks: [check], integrationChecks: [taskCheck], requireReview: false },
			actor: system,
		});
		f.app.kernel.markTaskReady(id, system);
	};
	addCheckedTask(
		"consumer",
		"client.ts",
		"require('node:assert/strict').ok(require('node:fs').existsSync('client.ts'))",
	);
	f.coordinate("consumer", [], ["api", "schema"]);
	f.app.kernel.addDependency({ taskId: "consumer", dependsOnTaskId: "producer", kind: "CONSUMES", actor: system });
	edit = async (cwd) => {
		await writeFile(join(cwd, "client.ts"), "export const client = 'string';\n");
	};
	assert.equal(await executor.execute("consumer"), "ACCEPTED");
	addCheckedTask(
		"downstream",
		"downstream.ts",
		"require('node:assert/strict').match(require('node:fs').readFileSync('api.ts','utf8'), /Value = string/)",
	);
	f.app.kernel.addDependency({ taskId: "downstream", dependsOnTaskId: "consumer", kind: "REQUIRES", actor: system });
	edit = async (cwd) => {
		await writeFile(join(cwd, "downstream.ts"), "export const downstream = 'requires string API';\n");
	};
	assert.equal(await executor.execute("downstream"), "ACCEPTED");
	f.addTask("update", ["api.ts"]);
	const before = f.app.catalog.getRun(f.runId);
	const oldProofCount = f.app.database.sql
		.prepare("SELECT COUNT(*) AS n FROM contract_evidence")
		.get<{ n: number }>()?.n;
	edit = async (cwd) => {
		await writeFile(join(cwd, "api.ts"), "export type Value = number;\n");
	};
	assert.equal(await executor.execute("update"), "RETRY");
	assert.equal(f.app.catalog.getRun(f.runId).integrationHead, before.integrationHead);
	assert.equal(await f.app.workspaces.resolveRef(before.integrationRef), before.integrationHead);
	assert.equal(
		f.app.database.sql.prepare("SELECT COUNT(*) AS n FROM contract_evidence").get<{ n: number }>()?.n,
		oldProofCount,
	);
	assert.ok(
		f.app.database.sql
			.prepare("SELECT id FROM check_runs WHERE task_id='update' AND check_kind='downstream-check' AND state='FAILED'")
			.get(),
	);
	edit = async (cwd) => {
		await writeFile(join(cwd, "api.ts"), "// Compatible refactor\nexport type Value = string;\n");
	};
	assert.equal(await executor.execute("update"), "ACCEPTED");
	const after = f.app.catalog.getRun(f.runId);
	assert.notEqual(after.integrationHead, before.integrationHead);
	assert.equal(await f.app.workspaces.resolveRef(after.integrationRef), after.integrationHead);
	await f.verifier.assertPreserved(f.runId, after.integrationHead);
	const action = f.app.database.sql
		.prepare("SELECT detail_json FROM control_actions WHERE task_id='update' AND kind='CONTRACT_REVERIFY'")
		.get<{ detail_json: string }>();
	const tasks = (JSON.parse(action?.detail_json ?? "{}").tasks as Array<{ taskId: string }>)
		.map((task) => task.taskId)
		.sort();
	assert.deepEqual(tasks, ["consumer", "downstream", "producer"]);
});

function addition(scope: string[] = ["src/prerequisite.ts"]): TaskChangeSet {
	return {
		additions: [
			{
				key: "prerequisite",
				title: "Prerequisite",
				objective: "Provide the prerequisite",
				scope,
				constraints: [],
				acceptanceContract: acceptance,
				riskClass: "LOW",
				priority: 1,
			},
		],
		revisions: [],
		cancellations: [],
		dependencies: [{ task: { taskId: "source" }, dependsOn: { newTaskKey: "prerequisite" }, kind: "REQUIRES" }],
	};
}

test("a prerequisite with repository-wide scope cannot be accepted by the bounded policy", async (context) => {
	const f = await fixture(context);
	f.addTask("source", ["src"]);
	const attempt = f.start("source");
	const proposalId = f.app.kernel.proposeTaskChanges({
		runId: f.runId,
		changes: addition(["."]),
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	f.app.kernel.failAttempt({
		attemptId: attempt.attemptId,
		reason: "Proposed refinement",
		retryTask: true,
		actor: system,
	});
	const result = new BoundedTaskProposalPolicy(f.app.kernel, f.app.catalog, f.app.config).process(f.runId);
	assert.deepEqual(result.accepted, []);
	assert.equal(result.requiresUser[0]?.proposalId, proposalId);
	assert.match(result.requiresUser[0]?.reason ?? "", /expands scope/);
	assert.equal(f.app.catalog.listTasks(f.runId).length, 1);
	assert.equal(f.app.catalog.getTask("source").state, "BLOCKED");
});

test("proposal validity follows task revisions instead of ordinary blocked-state versions", async (context) => {
	const f = await fixture(context);
	f.addTask("source");
	const revision = (objective: string): TaskChangeSet => ({
		additions: [],
		dependencies: [],
		cancellations: [],
		revisions: [
			{
				taskId: "source",
				expectedVersion: f.app.kernel.getTask("source").version,
				title: "Revised",
				objective,
				scope: ["src"],
				constraints: [],
				acceptanceContract: acceptance,
				riskClass: "LOW",
				priority: 0,
			},
		],
	});
	const first = f.app.kernel.proposeTaskChanges({ runId: f.runId, changes: revision("First revision"), actor: system });
	f.app.kernel.blockReadyTask("source", "Await decision", system);
	f.app.kernel.blockRun(f.runId, "Await decision", system);
	assert.equal(f.app.kernel.taskProposalIsCurrent(first), true);
	f.app.kernel.acceptTaskChanges(first, user);
	assert.equal(f.app.catalog.getTask("source").objective, "First revision");
	const stale = f.app.kernel.proposeTaskChanges({ runId: f.runId, changes: revision("Stale revision"), actor: system });
	const accepted = f.app.kernel.proposeTaskChanges({
		runId: f.runId,
		changes: revision("New revision"),
		actor: system,
	});
	f.app.kernel.acceptTaskChanges(accepted, user);
	assert.equal(f.app.kernel.taskProposalIsCurrent(stale), false);
	assert.throws(() => f.app.kernel.acceptTaskChanges(stale, user), { code: "STALE_TASK_PROPOSAL" });
});

test("A/B decisions atomically deliver answers and unblock only after all required decisions resolve", async (context) => {
	const f = await fixture(context);
	f.addTask("source");
	const attempt = f.start("source");
	const request = (question: string) =>
		f.app.kernel.createDecisionRequest({
			runId: f.runId,
			taskId: "source",
			kind: "REQUIREMENT_CHOICE",
			question,
			options: ["A", "B"],
			actor: { kind: "ATTEMPT", id: attempt.attemptId },
		});
	const first = request("Select persistence semantics");
	const second = request("Select ordering semantics");
	f.app.kernel.failAttempt({
		attemptId: attempt.attemptId,
		reason: "Needs product semantics",
		retryTask: false,
		actor: system,
	});
	f.app.kernel.blockRun(f.runId, "Needs product semantics", system);
	const failure = context.mock.method(f.app.kernel, "sendMessage", () => {
		throw new Error("injected answer storage failure");
	});
	assert.throws(() => f.app.resolveDecision(first, "A", "Choose durable"), /injected answer storage failure/);
	assert.equal(f.app.catalog.getDecisionRequest(first).state, "OPEN");
	assert.equal(f.app.database.sql.prepare("SELECT COUNT(*) AS n FROM decisions").get<{ n: number }>()?.n, 0);
	failure.mock.restore();
	f.app.resolveDecision(first, "A", "Choose durable");
	assert.equal(f.app.catalog.getTask("source").state, "BLOCKED");
	assert.equal(f.app.catalog.getRun(f.runId).state, "BLOCKED");
	f.app.resolveDecision(second, "B", "Choose stable ordering");
	assert.equal(f.app.catalog.getTask("source").state, "READY");
	assert.equal(f.app.catalog.getRun(f.runId).state, "OPEN");
	const answers = f.app.catalog.listMessages({ runId: f.runId, recipientKind: "TASK", recipientId: "source" });
	assert.equal(answers.length, 2);
	assert.deepEqual(answers.map((message) => JSON.parse(message.body).selectedOption).sort(), ["A", "B"]);
});

test("noninteractive runs reject messages, decisions, user graph changes and extra retries without side effects", async (context) => {
	const f = await fixture(context, "noninteractive");
	f.addTask("source");
	const attempt = f.start("source");
	await assert.rejects(f.app.sendUserMessage(attempt.attemptId, "Use the hidden answer"), {
		code: "NONINTERACTIVE_RUN",
	});
	assert.equal(f.app.database.sql.prepare("SELECT COUNT(*) AS n FROM messages").get<{ n: number }>()?.n, 0);
	const request = f.app.kernel.createDecisionRequest({
		runId: f.runId,
		taskId: "source",
		kind: "REQUIREMENT_CHOICE",
		question: "Choose behavior",
		options: ["A", "B"],
		actor: { kind: "ATTEMPT", id: attempt.attemptId },
	});
	f.app.kernel.failAttempt({
		attemptId: attempt.attemptId,
		reason: "Missing authority",
		retryTask: false,
		actor: system,
	});
	f.app.kernel.blockRun(f.runId, "Missing authority", system);
	assert.throws(() => f.app.resolveDecision(request, "A", "Extra direction"), { code: "NONINTERACTIVE_RUN" });
	assert.throws(() => f.app.kernel.proposeTaskChanges({ runId: f.runId, changes: addition(), actor: user }), {
		code: "NONINTERACTIVE_RUN",
	});
	const proposal = f.app.kernel.proposeTaskChanges({ runId: f.runId, changes: addition(), actor: system });
	assert.throws(() => f.app.acceptTaskProposal(proposal), { code: "NONINTERACTIVE_RUN" });
	await assert.rejects(f.app.retry("source"), { code: "NONINTERACTIVE_RUN" });
	assert.equal(f.app.catalog.getDecisionRequest(request).state, "OPEN");
	assert.equal(f.app.catalog.getTask("source").state, "BLOCKED");
	assert.equal(f.app.catalog.listTasks(f.runId).length, 1);
});

test("migration from populated v7 preserves exploration evidence and allows only bounded failed retries", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-v7-populated-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "state.db");
	const legacy = await createNodeSqliteFactory().open(path);
	for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) legacy.exec(migration.sql);
	legacy.exec("PRAGMA user_version=7");
	const timestamp = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO runs (id,repository_root,input_commit,integration_ref,integration_head,state,created_at,updated_at) VALUES ('run','/repo','base','refs/run','base','OPEN',?,?)",
		)
		.run(timestamp, timestamp);
	legacy
		.prepare(
			"INSERT INTO tasks (id,run_id,current_revision_id,state,risk_class,created_at,updated_at) VALUES ('task','run','revision','READY','LOW',?,?)",
		)
		.run(timestamp, timestamp);
	legacy
		.prepare(
			"INSERT INTO task_revisions (id,task_id,revision,title,objective,scope_json,constraints_json,acceptance_contract_json,provenance_json,created_at) VALUES ('revision','task',1,'Explore','Explore','[\"src\"]','[]',?,'{}',?)",
		)
		.run(JSON.stringify(acceptance), timestamp);
	for (const [id, state] of [
		["failed", "FAILED"],
		["completed", "COMPLETED"],
	]) {
		legacy
			.prepare(
				"INSERT INTO exploration_records (id,run_id,task_id,task_revision_id,baseline_commit,investigation_key,hypothesis,question,state,report,created_at,updated_at) VALUES (?,'run','task','revision','base',?,'hypothesis','question',?,?,?,?)",
			)
			.run(id as string, id as string, state as string, "preserved " + id, timestamp, timestamp);
	}
	legacy.close();
	const database = await openControlDatabase(path);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	assert.equal(database.sql.prepare("PRAGMA user_version").get<{ user_version: number }>()?.user_version, 8);
	assert.deepEqual(
		catalog
			.listExplorations("task")
			.map((record) => [record.id, record.report])
			.sort(),
		[
			["completed", "preserved completed"],
			["failed", "preserved failed"],
		],
	);
	const input = {
		taskId: "task",
		baselineCommit: "base",
		investigationKey: "failed",
		hypothesis: "hypothesis",
		question: "question",
		maxExecutions: 2,
		actor: system,
	};
	const retry = kernel.beginExploration(input);
	kernel.finishExploration({ explorationId: retry, state: "FAILED", report: "Retry also failed", actor: system });
	assert.throws(() => kernel.beginExploration(input), { code: "EXPLORATION_EXHAUSTED" });
	assert.throws(() => kernel.beginExploration({ ...input, investigationKey: "completed" }), {
		code: "DUPLICATE_EXPLORATION",
	});
	assert.deepEqual(database.sql.prepare("PRAGMA foreign_key_check").all(), []);
});
