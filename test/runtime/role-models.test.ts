import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { LocalOrchestrator } from "../../src/app/orchestrator.ts";
import {
	AGENT_ROLES,
	type AgentRole,
	executionPolicyFor,
	modelSelectionFor,
	parseExecutionPolicy,
} from "../../src/config/execution.ts";
import { OperationJournal } from "../../src/control/operation-journal.ts";
import { TaskExecutor } from "../../src/control/task-executor.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import { PiExplorer } from "../../src/exploration/explorer.ts";
import { PiPlanner } from "../../src/planning/plan.ts";
import { PiReviewer } from "../../src/review/reviewer.ts";
import {
	assertFrozenProfile,
	constrainProfileTools,
	freezePiProfiles,
	type PiProfileRole,
	PiWorkerLauncher,
} from "../../src/runtime/pi/launcher.ts";
import { PiRpcWorker } from "../../src/runtime/pi/rpc-worker.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";

const execFileAsync = promisify(execFile);
const system = { kind: "SYSTEM", id: "role-model-test" } as const;
const readOnlyTools = ["read", "grep", "find", "ls"];
const writerTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const names = { planner: "shared", explorer: "shared", implementer: "shared", reviewer: "shared" };
const profileRoles: Record<AgentRole, PiProfileRole> = {
	planner: "PLAN",
	explorer: "EXPLORE",
	implementer: "IMPLEMENT",
	reviewer: "REVIEW",
};
const mixedPolicy = {
	provider: "default-provider",
	model: "default-model",
	reasoning: "medium",
	roles: {
		planner: { provider: "planner-provider", model: "planner-model", reasoning: "high" },
		explorer: { model: "explorer-model", reasoning: "low" },
		implementer: { provider: "writer-provider", model: "writer-model", reasoning: "xhigh" },
		reviewer: { provider: "review-provider", model: "review-model", reasoning: "off" },
	},
};

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-role-models-"));
	const agentDirectory = join(directory, "pi");
	const previousPi = process.env.PI_CODING_AGENT_DIR;
	const previousState = process.env.TRIPLETEAM_STATE_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.TRIPLETEAM_STATE_DIR = join(directory, "state");
	context.after(async () => {
		if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousPi;
		if (previousState === undefined) delete process.env.TRIPLETEAM_STATE_DIR;
		else process.env.TRIPLETEAM_STATE_DIR = previousState;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(join(agentDirectory, "agents"), { recursive: true });
	await writeFile(
		join(agentDirectory, "agents", "shared.md"),
		"---\nname: shared\ndescription: Role fixture\ntools: read, grep, bash, edit\nmodel: profile-model\n---\nInspect the task and follow its assigned role.\n",
	);
	return { directory };
}

test("role model settings inherit missing fields without changing other roles or global defaults", () => {
	const execution = parseExecutionPolicy(mixedPolicy);
	assert.deepEqual(modelSelectionFor(execution, "planner"), mixedPolicy.roles.planner);
	assert.deepEqual(modelSelectionFor(execution, "explorer"), {
		provider: mixedPolicy.provider,
		...mixedPolicy.roles.explorer,
	});
	assert.deepEqual(modelSelectionFor(execution, "implementer"), mixedPolicy.roles.implementer);
	assert.deepEqual(modelSelectionFor(execution, "reviewer"), mixedPolicy.roles.reviewer);
	assert.deepEqual(modelSelectionFor(execution), {
		provider: mixedPolicy.provider,
		model: mixedPolicy.model,
		reasoning: mixedPolicy.reasoning,
	});
	const partial = parseExecutionPolicy({
		provider: "default",
		model: "base",
		reasoning: "medium",
		roles: { reviewer: { reasoning: "off" }, explorer: {} },
	});
	assert.deepEqual(modelSelectionFor(partial, "reviewer"), { provider: "default", model: "base", reasoning: "off" });
	assert.deepEqual(modelSelectionFor(partial, "planner"), modelSelectionFor(partial));
	assert.deepEqual(modelSelectionFor(partial, "explorer"), modelSelectionFor(partial));
	assert.deepEqual(modelSelectionFor(undefined, "planner"), {
		provider: undefined,
		model: undefined,
		reasoning: undefined,
	});
});

test("role configuration rejects misspellings, provider-only overrides and provider secrets", () => {
	const invalid = [
		{ roles: null },
		{ roles: [] },
		{ roles: { writer: { model: "x" } } },
		{ roles: { planner: [] } },
		{ roles: { reviewer: null } },
		{ roles: { planner: { provider: "other" } } },
		{ roles: { planner: { model: "" } } },
		{ roles: { explorer: { model: null } } },
		{ roles: { reviewer: { reasoning: "maximum" } } },
		{ roles: { planner: { reasoning: null } } },
		{ roles: { implementer: { apiKey: "fixture-secret" } } },
		{ roles: { implementer: { baseUrl: "http://example.invalid" } } },
		{ roles: { planner: { roles: {} } } },
	];
	for (const configuration of invalid) assert.throws(() => parseExecutionPolicy(configuration));
});

test("one shared Pi profile resolves independently for every role and freezes effective authority", async (context) => {
	const { directory } = await fixture(context);
	const launcher = new PiWorkerLauncher();
	const execution = parseExecutionPolicy(mixedPolicy);
	const frozen = freezePiProfiles(launcher, directory, names, execution);
	const legacy = launcher.resolveProfile(directory, "shared", readOnlyTools);
	assert.equal(legacy.model, "profile-model");
	const reasoningOnly = launcher.resolveProfile(
		directory,
		"shared",
		readOnlyTools,
		parseExecutionPolicy({ roles: { planner: { reasoning: "high" } } }),
		"planner",
	);
	assert.equal(reasoningOnly.model, "profile-model");
	assert.equal(reasoningOnly.reasoning, "high");
	for (const role of AGENT_ROLES) {
		const resolve = (policy = execution) => {
			const profile = launcher.resolveProfile(directory, names[role], writerTools, policy, role);
			return role === "implementer" ? profile : constrainProfileTools(profile, readOnlyTools);
		};
		const profile = resolve();
		const selection = modelSelectionFor(execution, role);
		assert.equal(profile.name, "shared");
		assert.equal(profile.source, "user");
		assert.equal(profile.model, selection.model);
		assert.equal(profile.provider, selection.provider);
		assert.equal(profile.reasoning, selection.reasoning);
		assert.deepEqual(profile.tools, role === "implementer" ? ["read", "grep", "bash", "edit"] : ["read", "grep"]);
		assertFrozenProfile({ piProfiles: frozen }, profileRoles[role], profile);
		for (const changed of [{ model: "changed-model" }, { provider: "changed-provider" }, { reasoning: "minimal" }]) {
			const policy = parseExecutionPolicy({
				...mixedPolicy,
				roles: { ...mixedPolicy.roles, [role]: { ...mixedPolicy.roles[role], ...changed } },
			});
			assert.throws(
				() => assertFrozenProfile({ piProfiles: frozen }, profileRoles[role], resolve(policy)),
				(error: unknown) => error instanceof DomainInvariantError && error.code === "FROZEN_PI_PROFILE_MISMATCH",
			);
			const updated = freezePiProfiles(launcher, directory, names, policy);
			for (const unaffected of AGENT_ROLES.filter((candidate) => candidate !== role))
				assert.deepEqual(updated[profileRoles[unaffected]], frozen[profileRoles[unaffected]]);
		}
	}
});

test("each resolved role reaches Pi worker configuration without starting an agent", async (context) => {
	const { directory } = await fixture(context);
	const launcher = new PiWorkerLauncher();
	const execution = parseExecutionPolicy(mixedPolicy);
	const start = context.mock.method(PiRpcWorker.prototype, "start", async () => {
		throw new Error("This offline test must not start Pi");
	});
	for (const role of AGENT_ROLES) {
		const resolved = launcher.resolveProfile(directory, names[role], writerTools, execution, role);
		const profile = role === "implementer" ? resolved : constrainProfileTools(resolved, readOnlyTools);
		const managed = await launcher.create(
			{
				cwd: directory,
				sessionDirectory: join(directory, "sessions"),
				sessionId: "offline-" + role,
				sessionName: "Offline configuration",
				profileName: names[role],
				defaultTools: profile.tools,
			},
			profile,
		);
		try {
			assert.ok(managed.worker instanceof PiRpcWorker);
			const config = managed.worker.config;
			assert.deepEqual(
				{ model: config.model, provider: config.provider, reasoning: config.reasoning },
				modelSelectionFor(execution, role),
			);
			assert.deepEqual(config.tools, profile.tools);
			assert.equal(managed.profileVersion, profile.version);
		} finally {
			await managed.close();
		}
	}
	assert.equal(start.mock.callCount(), 0);
});

test("planning, replan, exploration, writing, resume and review resolve their frozen role after reopening", async (context) => {
	const { directory } = await fixture(context);
	const repository = join(directory, "repo");
	await mkdir(repository);
	await execFileAsync("git", ["init", repository]);
	await writeFile(join(repository, "source.txt"), "baseline\n");
	await writeFile(join(repository, ".tripleteam.json"), JSON.stringify({ profiles: names, execution: mixedPolicy }));
	await execFileAsync("git", ["-C", repository, "add", "."]);
	await execFileAsync("git", [
		"-C",
		repository,
		"-c",
		"user.name=Role Model Test",
		"-c",
		"user.email=test@localhost",
		"commit",
		"-m",
		"baseline",
	]);
	let orchestrator: LocalOrchestrator | undefined = await LocalOrchestrator.open(repository);
	context.after(() => orchestrator?.close());
	const initialized = await orchestrator.initialize("Change source with independent model roles");
	const originalGoal = orchestrator.catalog.getRun(initialized.runId).goalContract;
	assert.deepEqual(executionPolicyFor(originalGoal), parseExecutionPolicy(mixedPolicy));
	orchestrator.close();
	orchestrator = undefined;
	await writeFile(
		join(repository, ".tripleteam.json"),
		JSON.stringify({ profiles: names, execution: { provider: "edited-provider", model: "edited-model" } }),
	);
	orchestrator = await LocalOrchestrator.open(repository);
	const { kernel, catalog, database, workspaces, resources, paths, config } = orchestrator;
	assert.deepEqual(catalog.getRun(initialized.runId).goalContract, originalGoal);
	assert.equal(config.execution?.model, "edited-model");
	const taskId = kernel.createTask({
		runId: initialized.runId,
		title: "Change source",
		objective: "Update source.txt",
		scope: ["source.txt"],
		constraints: [],
		acceptanceContract: {
			candidateChecks: config.candidateChecks,
			integrationChecks: config.integrationChecks,
			requireReview: false,
		},
		riskClass: "LOW",
		actor: system,
	});
	kernel.markTaskReady(taskId, system);
	const launcher = new PiWorkerLauncher();
	const realResolve = launcher.resolveProfile.bind(launcher);
	const captured: Array<{
		role: AgentRole | undefined;
		name: string;
		model?: string;
		provider?: string;
		reasoning?: string;
	}> = [];
	const stop = new Error("Offline profile boundary reached");
	context.mock.method(launcher, "resolveProfile", (...args: Parameters<PiWorkerLauncher["resolveProfile"]>) => {
		const profile = realResolve(...args);
		const role = args[4];
		const effective = role === "implementer" ? profile : constrainProfileTools(profile, readOnlyTools);
		assert.ok(role);
		assertFrozenProfile(originalGoal, profileRoles[role], effective);
		captured.push({
			role,
			name: profile.name,
			model: profile.model,
			provider: profile.provider,
			reasoning: profile.reasoning,
		});
		throw stop;
	});
	const create = context.mock.method(launcher, "create", async () => {
		throw new Error("The role model test must never start a Pi worker");
	});
	const explorer = new PiExplorer(kernel, catalog, workspaces, launcher, resources, paths, config);
	const planner = new PiPlanner(kernel, catalog, workspaces, launcher, explorer, resources, paths, config);
	const reviewer = new PiReviewer(kernel, catalog, workspaces, launcher, resources, paths, config);
	const executor = new TaskExecutor(
		kernel,
		catalog,
		new OperationJournal(database),
		workspaces,
		launcher,
		reviewer,
		new CheckRunner(resources),
		resources,
		paths,
		config,
	);
	const common = { runId: initialized.runId, repositoryRoot: repository, objective: "Change source" };
	const stopped = (error: unknown) => error === stop;
	await assert.rejects(planner.plan({ ...common, inputCommit: initialized.inputCommit }), stopped);
	await assert.rejects(
		explorer.explore({ ...common, taskId, baseCommit: initialized.inputCommit, question: "Inspect source" }),
		stopped,
	);
	await assert.rejects(
		explorer.explore({
			...common,
			taskId,
			baseCommit: initialized.inputCommit,
			question: "Diagnose failure",
			purpose: "REPLAN",
		}),
		stopped,
	);
	await assert.rejects(executor.execute(taskId), stopped);
	await assert.rejects(
		reviewer.review({
			...common,
			task: catalog.getTask(taskId),
			candidateId: "candidate",
			candidateCommit: initialized.inputCommit,
			baseCommit: initialized.inputCommit,
		}),
		stopped,
	);
	assert.equal(catalog.countAttempts(taskId), 0);
	const writer = realResolve(
		repository,
		names.implementer,
		writerTools,
		executionPolicyFor(originalGoal),
		"implementer",
	);
	const attempt = kernel.startAttempt({
		taskId,
		baseCommit: initialized.inputCommit,
		profileName: writer.name,
		profileVersion: writer.version,
		actor: system,
	});
	const executionId = kernel.createExecution({
		attemptId: attempt.attemptId,
		piSessionId: "offline-session",
		contextManifestHash: "offline-context",
		actor: system,
	});
	kernel.finishExecution({ executionId, state: "LOST", actor: system });
	await assert.rejects(executor.resume(attempt.attemptId), stopped);
	const expectedRoles: AgentRole[] = ["planner", "explorer", "planner", "implementer", "reviewer", "implementer"];
	assert.deepEqual(
		captured,
		expectedRoles.map((role) => ({
			role,
			name: "shared",
			...modelSelectionFor(parseExecutionPolicy(mixedPolicy), role),
		})),
	);
	assert.equal(create.mock.callCount(), 0);
});
