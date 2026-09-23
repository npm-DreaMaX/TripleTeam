import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "../../src/config/paths.ts";
import { type CheckCommand, checkCommandVersion, type ProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import type {
	ManagedPiWorker,
	PiWorkerLauncher,
	PiWorkerRequest,
	ResolvedPiProfile,
} from "../../src/runtime/pi/launcher.ts";
import type { PiUsage } from "../../src/runtime/pi/rpc-worker.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { AssuranceService } from "../../src/verification/assurance-service.ts";
import {
	type AssuranceDefinition,
	type AssurancePolicy,
	agentJson,
	parseAssuranceDefinition,
	parseAssurancePolicy,
} from "../../src/verification/assurance-types.ts";
import { CheckRunner } from "../../src/verification/check-runner.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const actor = { kind: "SYSTEM", id: "assurance-test" } as const;
const goal = "encode('a b') must return 'a%20b'. encode('+') must return '%2B'.";
const specification = "Encode ASCII spaces as %20. Encode a plus sign as %2B.\n";
const assertImport = "const assert = (await import('node:assert/strict')).default;";
const correctCode = "export function encode(value) { return encodeURIComponent(value); }\n";
const incorrectCode = "export function encode(value) { return value.replaceAll(' ', '+'); }\n";
const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, toolCalls: 0 };
const rpcState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	sessionId: "offline-assurance",
	autoCompactionEnabled: true,
	messageCount: 0,
	pendingMessageCount: 0,
} as RpcSessionState;
const assuranceFailure = (error: unknown) =>
	error instanceof DomainInvariantError && error.code.startsWith("ASSURANCE_");

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

function definition(twoProbes = false): AssuranceDefinition {
	const result: AssuranceDefinition = {
		obligations: [
			{
				id: "space",
				behavior: "A space is encoded as %20.",
				risk: "HIGH",
				sources: [
					{ kind: "GOAL", quote: "encode('a b') must return 'a%20b'." },
					{ kind: "FILE", path: "SPEC.md", quote: "Encode ASCII spaces as %20." },
				],
			},
		],
		probes: [
			{
				id: "space_probe",
				obligations: ["space"],
				language: "javascript",
				setup: assertImport + "\nconst { encode } = await import('./encoder.mjs'); const actual = encode('a b');",
				assertions: "assert.equal(actual, 'a%20b');",
				contrastSetup: assertImport + "\nconst actual = 'a+b';",
				contrastReason: "Form-style encoding incorrectly substitutes + for a space.",
			},
		],
		assumptions: [],
	};
	if (twoProbes) {
		result.obligations.push({
			id: "plus",
			behavior: "A literal plus sign is percent encoded.",
			risk: "HIGH",
			sources: [{ kind: "GOAL", quote: "encode('+') must return '%2B'." }],
		});
		result.probes.push({
			id: "plus_probe",
			obligations: ["plus"],
			language: "javascript",
			setup: assertImport + "\nconst { encode } = await import('./encoder.mjs'); const actual = encode('+');",
			assertions: "assert.equal(actual, '%2B');",
			contrastSetup: assertImport + "\nconst actual = '+';",
			contrastReason: "An encoder incorrectly preserves a literal plus sign.",
		});
	}
	return result;
}

async function fixture(
	context: TestContext,
	proposed = definition(),
	options: {
		policy?: Partial<AssurancePolicy>;
		response?: (role: string, prompt: string) => unknown;
		responseText?: (role: string, prompt: string) => string;
		usage?: (role: string) => Partial<PiUsage>;
		files?: Record<string, string>;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-assurance-"));
	const repository = join(directory, "repo");
	await mkdir(repository);
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Assurance Test"]);
	await git(repository, ["config", "user.email", "assurance@example.test"]);
	await writeFile(join(repository, "encoder.mjs"), incorrectCode);
	await writeFile(join(repository, "encoder.py"), "def encode(value):\n    return value.replace(' ', '+')\n");
	await writeFile(join(repository, "SPEC.md"), specification);
	for (const [name, content] of Object.entries(options.files ?? {})) await writeFile(join(repository, name), content);
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
	let closed = false;
	const closeDatabase = () => {
		if (closed) return;
		closed = true;
		database.close();
	};
	context.after(async () => {
		closeDatabase();
		await rm(directory, { recursive: true, force: true });
	});
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const resources = new LocalResourceGovernor();
	const checks = new CheckRunner(resources);
	const structural: CheckCommand = {
		name: "diff-check",
		argv: ["git", "diff", "--check"],
		timeoutMs: 5000,
		lane: "LIGHT_CHECK",
		evidenceClass: "STRUCTURAL",
	};
	const policy = parseAssurancePolicy({
		mode: "required",
		maxDesignAttempts: 1,
		repetitions: 2,
		probeTimeoutMs: 5000,
		...options.policy,
	});
	const config: ProjectConfig = {
		maxAttemptsPerTask: 3,
		maxPlannerExplorations: 1,
		workerTimeoutMs: 5000,
		candidateChecks: [structural],
		integrationChecks: [structural],
		runChecks: [structural],
		reviewRequiredFor: [],
		profiles: {
			planner: "planner",
			explorer: "explorer",
			implementer: "implementer",
			reviewer: "reviewer",
			verifier: "verifier",
		},
		assurance: policy,
	};
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective: goal,
		inputCommit: baseline.commitHash,
		inputTreeHash: baseline.treeHash,
		integrationRef,
		goalContract: { assurancePolicy: policy, runChecks: [structural] },
		actor,
	});
	const contract = { candidateChecks: [structural], integrationChecks: [structural], requireReview: false };
	kernel.createTask({
		id: "task",
		runId: "run",
		title: "Encode URI components",
		objective: goal,
		scope: ["encoder.mjs", "encoder.py"],
		constraints: [],
		acceptanceContract: contract,
		riskClass: "HIGH",
		actor,
	});
	kernel.markTaskReady("task", actor);
	const calls: Array<{ request: PiWorkerRequest; profile: ResolvedPiProfile; prompt: string; commit: string }> = [];
	const launcher = {
		resolveProfile: (_cwd: string, name: string, tools: string[]): ResolvedPiProfile => ({
			name,
			description: "Offline assurance fixture",
			systemPrompt: "Read-only fixture.",
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
					calls.push({ request, profile, prompt, commit: await git(request.cwd, ["rev-parse", "HEAD"]) });
					return {
						state: rpcState,
						lastAssistantText:
							options.responseText?.(profile.name, prompt) ??
							JSON.stringify(
								options.response
									? options.response(profile.name, prompt)
									: profile.name === "verifier"
										? proposed
										: { approved: true, reason: "Literal public specification." },
							),
						usage: { ...usage, ...options.usage?.(profile.name) },
					};
				},
				steer: async () => undefined,
				followUp: async () => undefined,
				abort: async () => undefined,
				stop: async () => undefined,
			},
			close: async () => undefined,
		}),
	} as PiWorkerLauncher;
	const services = { kernel, catalog, workspaces, launcher, checks, resources, paths, config };
	const service = new AssuranceService(services);
	const candidate = async (content = correctCode) => {
		const workspace = await workspaces.createWorktree("candidate-" + randomUUID(), baseline.commitHash);
		try {
			await writeFile(join(workspace.path, "encoder.mjs"), content);
			return await workspaces.sealCandidate("run", workspace, "offline implementation");
		} finally {
			await workspaces.removeWorktree(workspace);
		}
	};
	const submit = async (content: string) => {
		const attempt = kernel.startAttempt({
			taskId: "task",
			baseCommit: baseline.commitHash,
			profileName: "implementer",
			profileVersion: "offline",
			actor,
		});
		const sealed = await candidate(content);
		const id = kernel.submitCandidate({
			taskId: "task",
			attemptId: attempt.attemptId,
			attemptEpoch: attempt.epoch,
			baseCommit: baseline.commitHash,
			commitHash: sealed.commitHash,
			treeHash: sealed.treeHash,
			changedPaths: sealed.changedPaths,
			actor,
		});
		const workspace = await workspaces.createWorktree("structural-" + randomUUID(), sealed.commitHash);
		try {
			const result = await checks.run(structural, {
				cwd: workspace.path,
				baseCommit: baseline.commitHash,
				subjectCommit: sealed.commitHash,
				runInputCommit: baseline.commitHash,
				artifactDirectory: paths.artifacts,
			});
			assert.equal(result.state, "PASSED");
			kernel.recordCheckResult({
				runId: "run",
				taskId: "task",
				subjectKind: "CANDIDATE",
				subjectId: id,
				treeHash: sealed.treeHash,
				checkKind: structural.name,
				checkVersion: checkCommandVersion(structural),
				command: result.command,
				environmentHash: result.environmentHash,
				state: result.state,
				exitCode: result.exitCode,
				result: result.result,
				actor,
			});
		} finally {
			await workspaces.removeWorktree(workspace);
		}
		return { ...sealed, id };
	};
	return {
		repository,
		baseline,
		database,
		closeDatabase,
		kernel,
		catalog,
		service,
		services,
		checks,
		calls,
		candidate,
		submit,
	};
}

test("assurance definitions reject empty coverage, unknown obligations and unsafe source paths", () => {
	const valid = definition(true);
	const policy = parseAssurancePolicy();
	const cases = [
		{ ...valid, obligations: [] },
		{ ...valid, probes: [] },
		{ ...valid, probes: [valid.probes[0]] },
		{ ...valid, probes: [{ ...valid.probes[0], obligations: ["unknown"] }] },
		{ ...valid, obligations: [{ ...valid.obligations[0], sources: [] }] },
	];
	for (const invalid of cases) assert.throws(() => parseAssuranceDefinition(invalid, policy));
	for (const path of ["../SPEC.md", "/tmp/SPEC.md", "C:/SPEC.md", ".git/config", "src/../SPEC.md", "SPEC.md\nother"]) {
		const invalid = definition();
		assert.ok(invalid.obligations[0]);
		invalid.obligations[0].sources = [{ kind: "FILE", path, quote: "Encode ASCII spaces as %20." }];
		assert.throws(() => parseAssuranceDefinition(invalid, policy));
	}
});

test("JSON responses preserve quoted backticks and accept only outer response fencing", () => {
	const proposed = definition();
	assert.ok(proposed.obligations[0]);
	proposed.obligations[0].sources = [{ kind: "GOAL", quote: "```original quote```" }];
	const json = JSON.stringify(proposed);
	assert.deepEqual(agentJson(json), proposed);
	assert.deepEqual(agentJson("```json\n" + json + "\n```"), proposed);
});

test("source field mistakes identify the exact obligation and fields without guessing an alias", async (context) => {
	const invalid = definition();
	assert.ok(invalid.obligations[0]);
	invalid.obligations[0].sources[1] = {
		kind: "FILE",
		...{ source: "SPEC.md" },
		quote: "Encode ASCII spaces as %20.",
	};
	assert.throws(
		() => parseAssuranceDefinition(invalid, parseAssurancePolicy()),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /obligations\[0\]\.sources\[1\].*obligation "space"/);
			assert.ok(error.message.includes('Actual field keys: ["kind","source","quote"]'));
			assert.match(error.message, /FILE requires kind, path and quote/);
			assert.ok(error.message.includes('{"kind":"FILE","path":"README.md","quote":"exact file quotation"}'));
			assert.match(error.message, /repository-relative.*no absolute paths/);
			return true;
		},
	);
	let designs = 0;
	const state = await fixture(context, invalid, {
		policy: { maxDesignAttempts: 2 },
		response: (role) =>
			role === "verifier"
				? ++designs === 1
					? invalid
					: definition()
				: { approved: true, reason: "Each source now uses the required fields and exact quotation." },
	});
	assert.ok(await state.service.ensure(state.catalog.getTask("task")));
	assert.deepEqual(
		state.calls.map((call) => call.profile.name),
		["verifier", "verifier", "reviewer"],
	);
	const prompt = state.calls[0]?.prompt ?? "";
	assert.ok(prompt.includes('{"kind":"GOAL","quote":"exact goal/task/constraint quotation"}'));
	assert.ok(prompt.includes('{"kind":"FILE","path":"README.md","quote":"exact baseline file quotation"}'));
	assert.match(prompt, /field named path \(never source\)/);
	const rejected = state.catalog.listControlActions("run", "ASSURANCE_DESIGN_REJECTED")[0];
	assert.ok(rejected);
	const feedback = JSON.parse(rejected.detail_json);
	assert.deepEqual(feedback.definition, invalid);
	assert.ok(state.calls[1]?.prompt.includes(JSON.stringify(feedback.reason)));
});

for (const legacyNull of [false, true]) {
	test(
		"JSON repair restores raw errors and the last complete definition after restart (legacy null=" + legacyNull + ")",
		async (context) => {
			const previous = definition();
			const malformed =
				'{\n  "obligations": [{"id":"space" "behavior":"missing comma"}],\n  "probes": [], "assumptions": []\n}';
			let designs = 0,
				critiques = 0;
			const state = await fixture(context, previous, {
				policy: { maxDesignAttempts: 3 },
				responseText: (role) => {
					if (role === "reviewer")
						return JSON.stringify({ approved: ++critiques > 1, reason: "Cover the literal plus sign as well." });
					designs++;
					return designs === 2 ? malformed : JSON.stringify(designs === 1 ? previous : definition(true));
				},
			});
			const record = state.kernel.recordControlAction.bind(state.kernel);
			const interrupted = context.mock.method(
				state.kernel,
				"recordControlAction",
				(input: Parameters<ControlKernel["recordControlAction"]>[0]) => {
					const id = record(input);
					if (input.kind === "ASSURANCE_DESIGN_REJECTED" && designs === 2)
						throw new Error("Simulated crash after malformed JSON was recorded");
					return id;
				},
			);
			await assert.rejects(state.service.ensure(state.catalog.getTask("task")), /Simulated crash/);
			interrupted.mock.restore();
			const rejection = state.catalog.listControlActions("run", "ASSURANCE_DESIGN_REJECTED").at(-1);
			assert.ok(rejection);
			const feedback = JSON.parse(rejection.detail_json);
			assert.deepEqual(feedback.definition, previous);
			assert.equal(feedback.rawResponse.text, malformed);
			assert.equal(feedback.rawResponse.originalBytes, Buffer.byteLength(malformed));
			assert.equal(feedback.rawResponse.truncated, false);
			assert.match(feedback.reason, /Invalid verification design JSON/);
			assert.match(feedback.reason, /position|line|column/);
			if (legacyNull) {
				// Reproduce a persisted older rejection that had erased the proposal with definition:null.
				state.database.sql
					.prepare("UPDATE control_actions SET detail_json=? WHERE id=?")
					.run(JSON.stringify({ ...feedback, definition: null }), rejection.id);
			}
			state.closeDatabase();
			const database = await openControlDatabase(state.database.path);
			try {
				const kernel = new ControlKernel(database),
					catalog = new ControlCatalog(database);
				assert.ok(await new AssuranceService({ ...state.services, kernel, catalog }).ensure(catalog.getTask("task")));
				const prompt = state.calls.findLast((call) => call.profile.name === "verifier")?.prompt ?? "";
				assert.ok(prompt.includes(JSON.stringify(previous)));
				assert.ok(prompt.includes(JSON.stringify(malformed)));
				assert.ok(prompt.includes(JSON.stringify(feedback.reason)));
				assert.match(prompt, /not a replacement for the retained definition/);
				assert.equal(designs, 3);
				assert.equal(critiques, 2);
				assert.deepEqual(
					catalog
						.listControlActions("run", "ASSURANCE_DESIGN_ATTEMPT")
						.map((action) => JSON.parse(action.detail_json).attempt),
					[1, 2, 3],
				);
			} finally {
				database.close();
			}
		},
	);
}

test("malformed raw response feedback is explicitly bounded at 1 MiB without breaking UTF-8", async (context) => {
	const malformed = "中".repeat(Math.ceil((1024 * 1024) / 3) + 10);
	const state = await fixture(context, definition(), { responseText: () => malformed });
	await assert.rejects(state.service.ensure(state.catalog.getTask("task")), /Invalid verification design JSON/);
	const rejection = state.catalog.listControlActions("run", "ASSURANCE_DESIGN_REJECTED")[0];
	assert.ok(rejection);
	const feedback = JSON.parse(rejection.detail_json);
	assert.equal(feedback.definition, undefined);
	assert.equal(feedback.rawResponse.originalBytes, Buffer.byteLength(malformed));
	assert.equal(feedback.rawResponse.truncated, true);
	assert.ok(Buffer.byteLength(feedback.rawResponse.text) <= 1024 * 1024);
	assert.ok(malformed.startsWith(feedback.rawResponse.text));
	assert.ok(!feedback.rawResponse.text.includes("\uFFFD"));
	assert.equal(state.calls.length, 1);
	assert.equal(state.kernel.assurance.get("task"), null);
});

test("oversized definitions are rejected instead of truncating the persisted correction", async (context) => {
	const proposed = definition();
	proposed.assumptions = ["x".repeat(1024 * 1024)];
	const state = await fixture(context, proposed);
	await assert.rejects(state.service.ensure(state.catalog.getTask("task")), (error: unknown) => {
		assert.ok(error instanceof DomainInvariantError);
		assert.equal(error.code, "ASSURANCE_DESIGN_EXHAUSTED");
		assert.match(error.message, /exceeds 1 MiB/);
		return true;
	});
	assert.equal(state.catalog.listControlActions("run", "ASSURANCE_DESIGN_PROPOSED").length, 0);
	assert.equal(state.kernel.assurance.get("task"), null);
});

for (const kind of ["GOAL", "FILE"] as const) {
	test("unsupported " + kind + " quotations are rejected before critique or candidate work", async (context) => {
		const proposed = definition();
		assert.ok(proposed.obligations[0]);
		proposed.obligations[0].sources = [{ kind, path: kind === "FILE" ? "SPEC.md" : undefined, quote: "Invented rule" }];
		const state = await fixture(context, proposed);
		const rejected = (error: unknown) => {
			assert.ok(error instanceof DomainInvariantError);
			assert.equal(error.code, "ASSURANCE_DESIGN_EXHAUSTED");
			assert.match(error.message, /Untraceable specification quotation for obligation space/);
			assert.ok(error.message.includes("source " + kind));
			if (kind === "FILE") assert.ok(error.message.includes('"SPEC.md"'));
			assert.ok(error.message.includes('"Invented rule"'));
			assert.match(error.message, /short, contiguous substring/);
			assert.match(error.message, /code fences.*ellipses/);
			return true;
		};
		await assert.rejects(state.service.ensure(state.catalog.getTask("task")), rejected);
		// Exhaustion survives service recreation and retains the final concrete failure.
		await assert.rejects(new AssuranceService(state.services).ensure(state.catalog.getTask("task")), rejected);
		assert.equal(state.kernel.assurance.get("task"), null);
		assert.equal(state.calls.length, 1);
		assert.equal(
			state.database.sql.prepare("SELECT COUNT(*) AS count FROM check_runs").get<{ count: number }>()?.count,
			0,
		);
	});
}

test("a rejected definition is repaired locally with its complete durable proposal and exact error", async (context) => {
	const invalid = definition(true);
	assert.ok(invalid.obligations[0]);
	invalid.obligations[0].sources = [{ kind: "FILE", path: "SPEC.md", quote: "Encode ASCII spaces ... %20." }];
	let designs = 0;
	const state = await fixture(context, invalid, {
		policy: { maxDesignAttempts: 2 },
		response: (role) =>
			role === "verifier"
				? ++designs === 1
					? invalid
					: definition(true)
				: { approved: true, reason: "All quotations now match their original sources." },
	});
	const plan = await state.service.ensure(state.catalog.getTask("task"));
	assert.ok(plan);
	assert.deepEqual(
		state.calls.map((call) => call.profile.name),
		["verifier", "verifier", "reviewer"],
	);
	const rejected = state.catalog.listControlActions("run", "ASSURANCE_DESIGN_REJECTED");
	assert.equal(rejected.length, 1);
	const feedback = JSON.parse(rejected[0]?.detail_json ?? "{}");
	assert.deepEqual(feedback.definition, invalid);
	assert.equal(feedback.baselineCommit, state.baseline.commitHash);
	assert.ok(state.calls[1]?.prompt.includes(JSON.stringify(invalid)));
	assert.ok(state.calls[1]?.prompt.includes(JSON.stringify(feedback.reason)));
	assert.match(state.calls[1]?.prompt ?? "", /Repair the previous complete definition locally/);
	assert.match(state.calls[1]?.prompt ?? "", /instead of repeating repository exploration/);
	assert.equal(plan.definition.probes.length, 2);
});

test("design correction resumes from SQLite after a crash following durable rejection", async (context) => {
	const invalid = definition();
	assert.ok(invalid.obligations[0]);
	invalid.obligations[0].sources = [{ kind: "GOAL", quote: "```encode('a b') must return 'a%20b'.```" }];
	let designs = 0;
	const state = await fixture(context, invalid, {
		policy: { maxDesignAttempts: 2 },
		response: (role) =>
			role === "verifier"
				? ++designs === 1
					? invalid
					: definition()
				: { approved: true, reason: "Original contiguous quotation verified." },
	});
	const record = state.kernel.recordControlAction.bind(state.kernel);
	const interrupted = context.mock.method(
		state.kernel,
		"recordControlAction",
		(input: Parameters<ControlKernel["recordControlAction"]>[0]) => {
			const id = record(input);
			if (input.kind === "ASSURANCE_DESIGN_REJECTED") throw new Error("Simulated daemon crash after durable rejection");
			return id;
		},
	);
	await assert.rejects(state.service.ensure(state.catalog.getTask("task")), /Simulated daemon crash/);
	assert.equal(state.kernel.assurance.get("task"), null);
	assert.equal(state.calls.length, 1);
	interrupted.mock.restore();
	state.closeDatabase();
	const database = await openControlDatabase(state.database.path);
	try {
		const kernel = new ControlKernel(database),
			catalog = new ControlCatalog(database);
		const service = new AssuranceService({ ...state.services, kernel, catalog });
		const plan = await service.ensure(catalog.getTask("task"));
		assert.ok(plan);
		assert.equal(designs, 2);
		assert.ok(state.calls[1]?.prompt.includes(JSON.stringify(invalid)));
		assert.match(state.calls[1]?.prompt ?? "", /Untraceable specification quotation for obligation space/);
		assert.match(state.calls[1]?.prompt ?? "", /code fences/);
		assert.deepEqual(
			catalog
				.listControlActions("run", "ASSURANCE_DESIGN_ATTEMPT")
				.map((action) => JSON.parse(action.detail_json).attempt),
			[1, 2],
		);
	} finally {
		database.close();
	}
});

test("design and critique use the frozen per-call phase allocation despite mutable project configuration", async (context) => {
	const limits = { maxDesignTokens: 4000, maxDesignToolCalls: 9, maxDesignMs: 4000 };
	const state = await fixture(context, definition(), { policy: limits });
	state.services.config.assurance = parseAssurancePolicy({ maxDesignTokens: 1, maxDesignToolCalls: 1, maxDesignMs: 1 });
	assert.ok(await state.service.ensure(state.catalog.getTask("task")));
	const rows = state.database.sql
		.prepare("SELECT phase,details_json FROM usage_records WHERE kind='AGENT' ORDER BY rowid")
		.all<{ phase: string; details_json: string }>();
	assert.deepEqual(
		rows.map((row) => row.phase),
		["SPECIFICATION_DESIGN", "PROBE_CRITIQUE"],
	);
	for (const row of rows) {
		const recorded = JSON.parse(row.details_json).phaseBudget;
		assert.equal(recorded.tokenLimit, limits.maxDesignTokens);
		assert.equal(recorded.toolCallLimit, limits.maxDesignToolCalls);
		assert.equal(recorded.durationMs, limits.maxDesignMs);
		assert.match(recorded.label, /Assurance/);
	}
});

for (const role of ["verifier", "reviewer"] as const) {
	test(role + " exceeding its phase allocation cannot freeze assurance or retry indefinitely", async (context) => {
		const state = await fixture(context, definition(), {
			policy: { maxDesignTokens: 30, maxDesignToolCalls: 4 },
			usage: (current) => (current === role ? (role === "verifier" ? { inputTokens: 30 } : { toolCalls: 4 }) : {}),
		});
		await assert.rejects(state.service.ensure(state.catalog.getTask("task")), (error: unknown) => {
			assert.ok(error instanceof DomainInvariantError);
			assert.equal(error.code, "ASSURANCE_DESIGN_EXHAUSTED");
			assert.match(
				error.message,
				role === "verifier" ? /Assurance specification design exhausted/ : /Assurance probe critique exhausted/,
			);
			return true;
		});
		assert.equal(state.kernel.assurance.get("task"), null);
		assert.equal(state.calls.length, role === "verifier" ? 1 : 2);
		assert.equal(state.catalog.listControlActions("run", "ASSURANCE_DESIGN_ATTEMPT").length, 1);
		const row = state.database.sql
			.prepare("SELECT details_json FROM usage_records WHERE kind='AGENT' ORDER BY rowid DESC LIMIT 1")
			.get<{ details_json: string }>();
		assert.ok(row);
		assert.equal(JSON.parse(row.details_json).complete, false);
	});
}

test("CLI probes may use temporary files and mock external operations without mutating source", async (context) => {
	const proposed = definition();
	const probe = proposed.probes[0];
	assert.ok(probe);
	probe.language = "python";
	probe.setup =
		"from cli import main\nfrom pathlib import Path\nfrom tempfile import TemporaryDirectory\nfrom unittest.mock import patch\nwith TemporaryDirectory() as directory:\n    output = Path(directory) / 'result.txt'\n    with patch('cli.subprocess.run') as external:\n        main(['a b', str(output)])\n        calls = external.call_count\n    actual = output.read_text()";
	probe.assertions = "assert actual == 'a%20b'\nassert calls == 1";
	probe.contrastSetup = "actual = 'a+b'\ncalls = 1";
	const state = await fixture(context, proposed, {
		files: {
			"cli.py":
				"import subprocess\nfrom pathlib import Path\nfrom encoder import encode\ndef main(args):\n    subprocess.run(['external-operation', args[0]], check=True)\n    Path(args[1]).write_text(encode(args[0]))\n",
		},
	});
	assert.ok(await state.service.ensure(state.catalog.getTask("task")));
	assert.match(state.calls[0]?.prompt ?? "", /TemporaryDirectory\/tempfile and unittest.mock are allowed/);
	assert.match(state.calls[0]?.prompt ?? "", /Do not modify tracked repository source/);
	const workspace = await state.services.workspaces.createWorktree("python-writer", state.baseline.commitHash);
	try {
		await writeFile(
			join(workspace.path, "encoder.py"),
			"from urllib.parse import quote\ndef encode(value):\n    return quote(value, safe='')\n",
		);
		const candidate = await state.services.workspaces.sealCandidate("run", workspace, "correct Python encoder");
		const statusBeforeProbe = await git(workspace.path, ["status", "--porcelain"]);
		const result = await state.service.evaluate(["task"], candidate.commitHash, "CANDIDATE", "python-candidate");
		assert.equal(result.status, "PASSED", result.detail);
		assert.deepEqual(candidate.changedPaths, ["encoder.py"]);
		assert.equal(await git(workspace.path, ["status", "--porcelain"]), statusBeforeProbe);
	} finally {
		await state.services.workspaces.removeWorktree(workspace);
	}
});

for (const language of ["javascript", "python"] as const) {
	test(language + " setup assertions cannot masquerade as a discriminating control", async (context) => {
		const proposed = definition();
		const probe = proposed.probes[0];
		assert.ok(probe);
		probe.language = language;
		if (language === "javascript")
			probe.contrastSetup = assertImport + "\nassert.fail('setup failed before observations');";
		else {
			probe.setup = "from encoder import encode\nactual = encode('a b')";
			probe.assertions = "assert actual == 'a%20b'";
			probe.contrastSetup = "assert False, 'setup failed before observations'";
		}
		const state = await fixture(context, proposed);
		await assert.rejects(state.service.ensure(state.catalog.getTask("task")), /contrast|control|assert|exhausted/i);
		assert.equal(state.kernel.assurance.get("task"), null);
		assert.deepEqual(
			state.calls.map((call) => call.profile.name),
			["verifier"],
		);
	});
}

for (const [errorName, contrastSetup] of [
	["AttributeError", "actual = 'a b'.unsupported_encoding()"],
	["NameError", "actual = missing_encoder('a b')"],
] as const) {
	test("contrast " + errorName + " is rejected before creating or paying for a reviewer", async (context) => {
		const proposed = definition();
		const probe = proposed.probes[0];
		assert.ok(probe);
		probe.language = "python";
		probe.setup = "from encoder import encode\nactual = encode('a b')";
		probe.assertions = "assert actual == 'a%20b'";
		probe.contrastSetup = contrastSetup;
		const state = await fixture(context, proposed);
		await assert.rejects(state.service.ensure(state.catalog.getTask("task")), (error: unknown) => {
			assert.ok(error instanceof DomainInvariantError);
			assert.equal(error.code, "ASSURANCE_DESIGN_EXHAUSTED");
			assert.match(error.message, new RegExp(errorName));
			return true;
		});
		assert.equal(state.kernel.assurance.get("task"), null);
		assert.deepEqual(
			state.calls.map((call) => call.profile.name),
			["verifier"],
		);
		assert.equal(state.database.sql.prepare("SELECT id FROM attempts WHERE profile_name='reviewer'").get(), undefined);
		const check = state.database.sql
			.prepare("SELECT state,stderr_path FROM check_runs")
			.get<{ state: string; stderr_path: string }>();
		assert.ok(check);
		assert.equal(check.state, "ERROR");
		assert.match(await readFile(check.stderr_path, "utf8"), new RegExp(errorName));
		assert.deepEqual(
			state.database.sql
				.prepare("SELECT phase FROM usage_records ORDER BY rowid")
				.all<{ phase: string }>()
				.map((row) => row.phase),
			["SPECIFICATION_DESIGN", "PROBE_CONTROL"],
		);
		const rejection = state.catalog.listControlActions("run", "ASSURANCE_DESIGN_REJECTED")[0];
		assert.ok(rejection);
		assert.match(JSON.parse(rejection.detail_json).reason, new RegExp(errorName));
	});
}

test("a contrast accepted by the shared assertion cannot freeze a plan", async (context) => {
	const proposed = definition();
	assert.ok(proposed.probes[0]);
	proposed.probes[0].contrastSetup = assertImport + "\nconst actual = 'a%20b';";
	const state = await fixture(context, proposed);
	await assert.rejects(state.service.ensure(state.catalog.getTask("task")), /contrast|control|exhausted/i);
	assert.equal(state.kernel.assurance.get("task"), null);
	assert.deepEqual(
		state.calls.map((call) => call.profile.name),
		["verifier"],
	);
});

test("passing controls still require approval from a fresh independent critique before freezing", async (context) => {
	const proposed = definition(true);
	const reason = "The proposed probes omit a required compatibility boundary.";
	const state = await fixture(context, proposed, {
		response: (role) => (role === "verifier" ? proposed : { approved: false, reason }),
	});
	await assert.rejects(state.service.ensure(state.catalog.getTask("task")), (error: unknown) => {
		assert.ok(error instanceof DomainInvariantError);
		assert.equal(error.code, "ASSURANCE_DESIGN_EXHAUSTED");
		assert.ok(error.message.includes("Independent probe critique: " + reason));
		return true;
	});
	assert.equal(state.kernel.assurance.get("task"), null);
	assert.equal(state.catalog.listControlActions("run", "ASSURANCE_PLAN_FROZEN").length, 0);
	assert.deepEqual(
		state.database.sql
			.prepare("SELECT state FROM check_runs ORDER BY rowid")
			.all<{ state: string }>()
			.map((row) => row.state),
		["PASSED", "PASSED"],
	);
	assert.deepEqual(
		state.calls.map((call) => call.profile.name),
		["verifier", "reviewer"],
	);
	assert.notEqual(state.calls[0]?.request.sessionId, state.calls[1]?.request.sessionId);
	assert.notEqual(state.calls[0]?.request.cwd, state.calls[1]?.request.cwd);
});

test("plans pass all controls before independent critique and reuse the frozen definition without inference", async (context) => {
	const state = await fixture(context, definition(true));
	const task = state.catalog.getTask("task");
	const plan = await state.service.ensure(task);
	assert.ok(plan);
	assert.notEqual(plan.designAttemptId, plan.criticAttemptId);
	assert.equal(plan.taskRevisionId, task.revisionId);
	assert.equal(plan.baselineCommit, state.baseline.commitHash);
	assert.equal(
		plan.definition.obligations[0]?.sources.find((source) => source.kind === "FILE")?.blobHash,
		await git(state.repository, ["rev-parse", state.baseline.commitHash + ":SPEC.md"]),
	);
	assert.deepEqual(
		state.calls.map((call) => call.profile.name),
		["verifier", "reviewer"],
	);
	assert.deepEqual(
		state.database.sql
			.prepare("SELECT phase FROM usage_records ORDER BY rowid")
			.all<{ phase: string }>()
			.map((row) => row.phase),
		["SPECIFICATION_DESIGN", "PROBE_CONTROL", "PROBE_CONTROL", "PROBE_CRITIQUE"],
	);
	assert.notEqual(state.calls[0]?.request.sessionId, state.calls[1]?.request.sessionId);
	assert.equal(
		state.database.sql.prepare("SELECT state FROM attempts WHERE id=?").get<{ state: string }>(plan.criticAttemptId)
			?.state,
		"SUBMITTED",
	);
	assert.ok(state.calls.every((call) => call.commit === state.baseline.commitHash));
	assert.ok(
		state.calls.every((call) => call.profile.tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool))),
	);
	assert.equal(JSON.stringify(await new AssuranceService(state.services).ensure(task)), JSON.stringify(plan));
	assert.equal(state.calls.length, 2);
	assert.equal(state.kernel.assurance.list("run").length, 1);
	const check = state.database.sql
		.prepare("SELECT state,exit_code,result_json,stderr_path FROM check_runs WHERE id=?")
		.get<{ state: string; exit_code: number; result_json: string; stderr_path: string }>(plan.controlCheckIds[0]);
	assert.ok(check);
	assert.equal(check.state, "PASSED");
	assert.equal(check.exit_code, 1);
	assert.match(await readFile(check.stderr_path, "utf8"), /TRIPLETEAM_PROBE_ASSERTION/);
	assert.equal((JSON.parse(check.result_json) as { assurance: { control: boolean } }).assurance.control, true);
	assert.throws(
		() => state.kernel.assurance.assertPassed("task", state.baseline.treeHash, "RUN", "run"),
		assuranceFailure,
	);
});

test("authority rejects empty coverage and reused control identities even with completed review attempts", async (context) => {
	const state = await fixture(context, definition(true));
	const freeze = state.kernel.assurance.freeze.bind(state.kernel.assurance);
	const capture = context.mock.method(state.kernel.assurance, "freeze", () => {});
	const plan = await state.service.ensure(state.catalog.getTask("task"));
	assert.ok(plan);
	capture.mock.restore();
	assert.equal(state.kernel.assurance.get("task"), null);
	assert.throws(() =>
		freeze({ ...plan, definition: { obligations: [], probes: [], assumptions: [] }, controlCheckIds: [] }),
	);
	assert.throws(() =>
		freeze({
			...plan,
			definition: { ...plan.definition, probes: plan.definition.probes.slice(0, 1) },
			controlCheckIds: plan.controlCheckIds.slice(0, 1),
		}),
	);
	const controlId = plan.controlCheckIds[0];
	assert.ok(controlId);
	assert.throws(() => freeze({ ...plan, controlCheckIds: [controlId, controlId] }));
	assert.throws(() => freeze({ ...plan, taskRevisionId: "obsolete-revision" }));
	assert.throws(() => freeze({ ...plan, criticAttemptId: plan.designAttemptId }));
	assert.throws(
		() => freeze({ ...plan, criticAttemptId: "" }),
		/Assurance requires completed independent review attempts/,
	);
	freeze(plan);
	assert.equal(state.kernel.assurance.get("task")?.id, plan.id);
});

test("independent probes block the wrong candidate while the correct candidate crosses the kernel gate", async (context) => {
	const state = await fixture(context);
	await state.service.ensure(state.catalog.getTask("task"));
	const wrong = await state.submit(incorrectCode);
	const failed = await state.service.evaluate(["task"], wrong.commitHash, "CANDIDATE", wrong.id);
	assert.equal(failed.status, "FAILED");
	assert.throws(() => state.kernel.markCandidateEligible(wrong.id, actor), assuranceFailure);
	state.kernel.rejectCandidate({ candidateId: wrong.id, reason: failed.detail, retryTask: true, actor });
	const good = await state.submit(correctCode);
	assert.throws(() => state.kernel.markCandidateEligible(good.id, actor), assuranceFailure);
	const passed = await state.service.evaluate(["task"], good.commitHash, "CANDIDATE", good.id);
	assert.equal(passed.status, "PASSED");
	assert.equal(passed.checkIds.length, 2);
	assert.doesNotThrow(() => state.kernel.markCandidateEligible(good.id, actor));
	assert.equal(
		state.database.sql.prepare("SELECT state FROM candidates WHERE id=?").get<{ state: string }>(good.id)?.state,
		"ELIGIBLE",
	);
	assert.equal(state.calls.length, 2);
	assert.equal(await git(state.repository, ["show", state.baseline.commitHash + ":encoder.mjs"]), incorrectCode.trim());
	assert.deepEqual(
		await git(state.repository, ["ls-tree", "--name-only", good.commitHash]),
		"SPEC.md\nencoder.mjs\nencoder.py",
	);
});

test("staged probes permit an increment but still block final acceptance until downstream behavior passes", async (context) => {
	const proposed = definition(true);
	const downstream = proposed.probes[1];
	assert.ok(downstream);
	downstream.stage = "FINAL";
	const state = await fixture(context, proposed);
	const plan = await state.service.ensure(state.catalog.getTask("task"));
	assert.equal(plan?.controlCheckIds.length, 2, "Both stages must have discriminating controls before freeze");
	const partial = await state.candidate("export function encode(value) { return value.replaceAll(' ', '%20'); }\n");
	for (const subject of ["CANDIDATE", "INTEGRATION"] as const) {
		const result = await state.service.evaluate(["task"], partial.commitHash, subject, "increment");
		assert.equal(result.status, "PASSED");
		assert.equal(result.checkIds.length, 2, "Only the TASK probe repeats at increment gates");
		assert.doesNotThrow(() => state.kernel.assurance.assertPassed("task", partial.treeHash, subject, "increment"));
	}
	assert.equal((await state.service.evaluate(["task"], partial.commitHash, "RUN", "run")).status, "FAILED");
	assert.throws(() => state.kernel.assurance.assertPassed("task", partial.treeHash, "RUN", "run"), assuranceFailure);
	const complete = await state.candidate();
	const result = await state.service.evaluate(["task"], complete.commitHash, "RUN", "run");
	assert.equal(result.status, "PASSED");
	assert.equal(result.checkIds.length, 4, "All frozen probes repeat on the final tree");
	assert.doesNotThrow(() => state.kernel.assurance.assertPassed("task", complete.treeHash, "RUN", "run"));
	assert.ok(state.calls.every((call) => call.prompt.includes("TASK probes")));
});

test("staging cannot eliminate all increment probes or silently reinterpret legacy definitions", () => {
	const proposed = definition();
	assert.equal(JSON.stringify(parseAssuranceDefinition(proposed, parseAssurancePolicy())), JSON.stringify(proposed));
	const probe = proposed.probes[0];
	assert.ok(probe);
	probe.stage = "FINAL";
	assert.throws(() => parseAssuranceDefinition(proposed, parseAssurancePolicy()), /at least one TASK/i);
	const invalid = JSON.parse(JSON.stringify(proposed));
	invalid.probes[0].stage = "SKIP";
	assert.throws(() => parseAssuranceDefinition(invalid, parseAssurancePolicy()), /stage must be TASK or FINAL/);
});

test("passing evidence cannot cross tree, subject, subject identity or task revision", async (context) => {
	const state = await fixture(context);
	const task = state.catalog.getTask("task");
	await state.service.ensure(task);
	const good = await state.candidate();
	assert.equal((await state.service.evaluate(["task"], good.commitHash, "CANDIDATE", "candidate-a")).status, "PASSED");
	assert.doesNotThrow(() => state.kernel.assurance.assertPassed("task", good.treeHash, "CANDIDATE", "candidate-a"));
	for (const [tree, subject, id] of [
		[state.baseline.treeHash, "CANDIDATE", "candidate-a"],
		[good.treeHash, "CANDIDATE", "candidate-b"],
		[good.treeHash, "INTEGRATION", "candidate-a"],
		[good.treeHash, "RUN", "candidate-a"],
	] as const)
		assert.throws(() => state.kernel.assurance.assertPassed("task", tree, subject, id), assuranceFailure);
	assert.equal(
		(await state.service.evaluate(["task"], good.commitHash, "INTEGRATION", "integration-a")).status,
		"PASSED",
	);
	assert.doesNotThrow(() => state.kernel.assurance.assertPassed("task", good.treeHash, "INTEGRATION", "integration-a"));
	assert.throws(() => state.kernel.assurance.assertPassed("task", good.treeHash, "RUN", "run"), assuranceFailure);
	const version = state.database.sql
		.prepare("SELECT version FROM tasks WHERE id=?")
		.get<{ version: number }>(task.id)?.version;
	assert.ok(version);
	const proposal = state.kernel.proposeTaskChanges({
		runId: "run",
		changes: {
			additions: [],
			dependencies: [],
			cancellations: [],
			revisions: [
				{
					taskId: task.id,
					expectedVersion: version,
					title: task.title,
					objective: task.objective + " Verify a slash as well.",
					scope: task.scope,
					constraints: task.constraints,
					acceptanceContract: task.acceptanceContract,
					riskClass: task.riskClass,
					priority: task.priority,
				},
			],
		},
		actor,
	});
	state.kernel.acceptTaskChanges(proposal, actor);
	assert.equal(state.kernel.assurance.get("task"), null);
	assert.throws(
		() => state.kernel.assurance.assertPassed("task", good.treeHash, "CANDIDATE", "candidate-a"),
		assuranceFailure,
	);
});

test("inconsistent real probe repetitions produce no passing verdict", async (context) => {
	const state = await fixture(context);
	await state.service.ensure(state.catalog.getTask("task"));
	const good = await state.candidate(
		"export function encode(value) { return process.env.TRIPLETEAM_ASSURANCE_TEST_VARIANT === 'bad' ? 'wrong' : encodeURIComponent(value); }\n",
	);
	const run = state.checks.run.bind(state.checks);
	let executions = 0;
	context.mock.method(state.checks, "run", async (...args: Parameters<CheckRunner["run"]>) => {
		const previous = process.env.TRIPLETEAM_ASSURANCE_TEST_VARIANT;
		process.env.TRIPLETEAM_ASSURANCE_TEST_VARIANT = ++executions === 1 ? "good" : "bad";
		try {
			return await run(...args);
		} finally {
			if (previous === undefined) delete process.env.TRIPLETEAM_ASSURANCE_TEST_VARIANT;
			else process.env.TRIPLETEAM_ASSURANCE_TEST_VARIANT = previous;
		}
	});
	const result = await state.service.evaluate(["task"], good.commitHash, "CANDIDATE", "flaky");
	assert.equal(result.status, "ERROR");
	assert.equal(result.checkIds.length, 2);
	assert.throws(
		() => state.kernel.assurance.assertPassed("task", good.treeHash, "CANDIDATE", "flaky"),
		assuranceFailure,
	);
	assert.deepEqual(
		state.database.sql
			.prepare("SELECT state FROM check_runs WHERE subject_id='flaky' ORDER BY rowid")
			.all<{ state: string }>()
			.map((row) => row.state),
		["PASSED", "FAILED"],
	);
});

test("an interrupted verification batch cannot reuse a previous batch's passing repetitions", async (context) => {
	const state = await fixture(context);
	await state.service.ensure(state.catalog.getTask("task"));
	const good = await state.candidate();
	const run = state.checks.run.bind(state.checks);
	for (const failAt of [1, 2]) {
		assert.equal((await state.service.evaluate(["task"], good.commitHash, "CANDIDATE", "repeated")).status, "PASSED");
		assert.doesNotThrow(() => state.kernel.assurance.assertPassed("task", good.treeHash, "CANDIDATE", "repeated"));
		let executions = 0;
		const interrupted = context.mock.method(state.checks, "run", async (...args: Parameters<CheckRunner["run"]>) => {
			if (++executions === failAt) throw new Error("Simulated check infrastructure interruption");
			return run(...args);
		});
		try {
			try {
				const outcome = await state.service.evaluate(["task"], good.commitHash, "CANDIDATE", "repeated");
				assert.equal(outcome.status, "ERROR");
			} catch (error) {
				assert.match(String(error), /Simulated check infrastructure interruption/);
			}
			assert.throws(
				() => state.kernel.assurance.assertPassed("task", good.treeHash, "CANDIDATE", "repeated"),
				assuranceFailure,
			);
		} finally {
			interrupted.mock.restore();
		}
	}
	assert.equal(state.calls.length, 2);
});
