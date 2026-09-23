import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ExecutionPolicy } from "../../src/config/execution.ts";
import type { ProjectPaths } from "../../src/config/paths.ts";
import { type CheckCommand, loadProjectConfig } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { LocalResourceGovernor } from "../../src/control/resource-governor.ts";
import { PiExplorer } from "../../src/exploration/explorer.ts";
import { PiPlanner } from "../../src/planning/plan.ts";
import type {
	ManagedPiWorker,
	PiWorkerLauncher,
	PiWorkerRequest,
	ResolvedPiProfile,
} from "../../src/runtime/pi/launcher.ts";
import type { PiUsage } from "../../src/runtime/pi/rpc-worker.ts";
import { openControlDatabase } from "../../src/store/database.ts";
import { GitWorkspaceManager } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);
const actor = { kind: "SYSTEM", id: "planning-allocation-test" } as const;
const objective =
	"Implement the requested behavior in src and document it in README.md without changing public interfaces.";
const scope = ["src", "README.md"];
const rpcState = { thinkingLevel: "off", sessionId: "offline-planning" } as RpcSessionState;
const zero = (): PiUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	toolCalls: 0,
});
const check = (name: string): CheckCommand => ({
	name,
	argv: ["git", "diff", "--check", "$RUN_INPUT", "$SUBJECT"],
	timeoutMs: 5000,
	lane: "LIGHT_CHECK",
	evidenceClass: "STRUCTURAL",
});

interface Step {
	profile?: "planner" | "explorer";
	text?: string;
	usage?: Partial<PiUsage>;
	before?: (kernel: ControlKernel) => void;
	error?: Error;
}

async function git(cwd: string, args: string[]) {
	return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(
	context: TestContext,
	steps: Step[],
	options: {
		policy?: Partial<ExecutionPolicy>;
		reviewRequiredFor?: string[];
		changeLocalPolicy?: boolean;
		reuse?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-planning-allocation-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const repository = join(directory, "repo");
	await mkdir(join(repository, "src"), { recursive: true });
	await writeFile(join(repository, "src", "index.txt"), "public baseline\n");
	await writeFile(join(repository, "README.md"), "Public project requirements.\n");
	const rawConfig = {
		candidateChecks: [check("frozen-candidate")],
		integrationChecks: [check("frozen-integration")],
		runChecks: [check("frozen-run")],
		reviewRequiredFor: options.reviewRequiredFor,
		workerTimeoutMs: 5000,
		execution: { tokenLimit: 1_000_000, maxPlanningToolCalls: 4, ...options.policy },
	};
	await writeFile(join(repository, ".tripleteam.json"), JSON.stringify(rawConfig));
	await git(repository, ["init"]);
	await git(repository, ["config", "user.name", "Planning Allocation Test"]);
	await git(repository, ["config", "user.email", "planning@example.test"]);
	await git(repository, ["add", "."]);
	await git(repository, ["commit", "-m", "public baseline"]);
	const config = await loadProjectConfig(repository);
	const root = join(directory, "state");
	const paths: ProjectPaths = {
		root,
		database: join(root, "state.db"),
		worktrees: join(root, "worktrees"),
		sessions: join(root, "sessions"),
		artifacts: join(root, "artifacts"),
		logs: join(root, "logs"),
		daemon: join(root, "daemon.json"),
	};
	const workspaces = await GitWorkspaceManager.open(repository, paths.worktrees);
	const baseline = await workspaces.snapshot("run");
	const integrationRef = await workspaces.initializeIntegrationRef("run", baseline.commitHash);
	const database = await openControlDatabase(paths.database);
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	const resources = new LocalResourceGovernor();
	const frozenGoal = {
		...(options.reuse ? { verificationPolicyVersion: 1 } : {}),
		objective,
		authorizedScope: scope,
		executionPolicy: config.execution,
		runChecks: config.runChecks,
		taskAcceptancePolicy: {
			candidateChecks: config.candidateChecks,
			integrationChecks: config.integrationChecks,
			reviewRequiredFor: config.reviewRequiredFor,
		},
	};
	kernel.createRun({
		id: "run",
		repositoryRoot: repository,
		objective,
		inputCommit: baseline.commitHash,
		inputTreeHash: baseline.treeHash,
		integrationRef,
		goalContract: frozenGoal,
		actor,
	});
	const calls: Array<{ profile: string; prompt: string }> = [];
	let aborts = 0;
	let closes = 0;
	const launcher = {
		resolveProfile: (_cwd: string, name: string, tools: string[]): ResolvedPiProfile => ({
			name,
			description: "Offline planning fixture",
			systemPrompt: "",
			tools,
			version: "offline",
			source: "builtin",
		}),
		create: async (request: PiWorkerRequest, profile: ResolvedPiProfile): Promise<ManagedPiWorker> => {
			assert.equal(await git(request.cwd, ["rev-parse", "HEAD"]), baseline.commitHash);
			assert.deepEqual(request.defaultTools, ["read", "grep", "find", "ls"]);
			const total = zero();
			let listener: ((usage: PiUsage) => void) | undefined;
			let eventListener: RpcEventListener | undefined;
			return {
				profileVersion: profile.version,
				close: async () => {
					closes++;
				},
				worker: {
					onEvent: (callback: RpcEventListener) => {
						eventListener = callback;
						return () => {
							eventListener = undefined;
						};
					},
					start: async () => rpcState,
					state: async () => rpcState,
					steer: async () => {},
					followUp: async () => {},
					stop: async () => {},
					abort: async () => {
						aborts++;
					},
					usageSnapshot: () => ({ ...total }),
					onUsage: (callback) => {
						listener = callback;
						return () => {
							listener = undefined;
						};
					},
					run: async (prompt) => {
						if (options.reuse)
							eventListener?.({
								type: "tool_execution_start",
								toolCallId: "read-call",
								toolName: "read",
								args: { path: "src/index.txt" },
							});
						const step = steps[calls.length];
						assert.ok(step, "the phase cap must prevent unallocated Pi calls");
						assert.equal(profile.name, step.profile ?? "planner");
						calls.push({ profile: profile.name, prompt });
						step.before?.(kernel);
						if (step.error) throw step.error;
						const usage = { ...zero(), ...step.usage };
						for (const key of Object.keys(total) as Array<keyof PiUsage>) total[key] += usage[key];
						listener?.({ ...total });
						return { state: rpcState, lastAssistantText: step.text ?? "Investigation is unfinished", usage };
					},
				},
			};
		},
	} as unknown as PiWorkerLauncher;
	// A resumed runtime may load different local settings. The frozen run contract still controls fallback.
	const localConfig = options.changeLocalPolicy
		? {
				...config,
				candidateChecks: [check("local-candidate")],
				integrationChecks: [check("local-integration")],
				reviewRequiredFor: [],
			}
		: config;
	const explorer = new PiExplorer(kernel, catalog, workspaces, launcher, resources, paths, localConfig);
	const planner = new PiPlanner(kernel, catalog, workspaces, launcher, explorer, resources, paths, localConfig);
	const plan = () =>
		planner.plan({ runId: "run", objective, inputCommit: baseline.commitHash, repositoryRoot: repository });
	return {
		explorer,
		repository,
		baseline,
		database,
		kernel,
		catalog,
		config,
		frozenGoal,
		calls,
		paths,
		resources,
		plan,
		aborts: () => aborts,
		closes: () => closes,
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function usageRows(state: Fixture) {
	return state.database.sql
		.prepare("SELECT phase,input_tokens,tool_calls,details_json FROM usage_records ORDER BY rowid")
		.all<{ phase: string; input_tokens: number; tool_calls: number; details_json: string }>();
}

function assertNoFallback(state: Fixture) {
	assert.equal(state.catalog.listTasks("run").length, 0);
	assert.equal(state.catalog.listControlActions("run", "PLANNING_FALLBACK").length, 0);
	assert.equal(
		state.database.sql.prepare("SELECT state FROM attempts WHERE workflow_function='PLAN'").get<{ state: string }>()
			?.state,
		"FAILED",
	);
}

for (const reviewRequiredFor of [undefined, ["MEDIUM", "NORMAL", "HIGH"]]) {
	test(`planning exhaustion preserves the full frozen goal and NORMAL review (${reviewRequiredFor ? "legacy risk alias" : "default review"})`, async (context) => {
		const state = await fixture(context, [{ usage: { inputTokens: 40, toolCalls: 4 } }], {
			reviewRequiredFor,
			changeLocalPolicy: true,
		});
		assert.deepEqual(state.config.reviewRequiredFor, ["NORMAL", "HIGH"]);
		const plan = await state.plan();
		assert.equal(plan.tasks.length, 1);
		assert.deepEqual(plan.dependencies, []);
		const task = state.catalog.listTasks("run")[0];
		assert.ok(task);
		assert.equal(task.objective, objective);
		assert.deepEqual(task.scope, scope);
		assert.equal(task.riskClass, "NORMAL");
		assert.deepEqual(
			task.acceptanceContract,
			JSON.parse(
				JSON.stringify({
					candidateChecks: state.frozenGoal.taskAcceptancePolicy.candidateChecks,
					integrationChecks: state.frozenGoal.taskAcceptancePolicy.integrationChecks,
					requireReview: true,
				}),
			),
		);
		assert.deepEqual(state.catalog.getRun("run").goalContract, JSON.parse(JSON.stringify(state.frozenGoal)));
		assert.equal(state.catalog.getRun("run").objective, objective);
		assert.equal(
			state.database.sql.prepare("SELECT state FROM attempts WHERE workflow_function='PLAN'").get<{ state: string }>()
				?.state,
			"FAILED",
		);
		assert.equal(
			state.database.sql.prepare("SELECT exit_code FROM executions").get<{ exit_code: number }>()?.exit_code,
			1,
		);
		const fallback = state.catalog.listControlActions("run", "PLANNING_FALLBACK");
		assert.equal(fallback.length, 1);
		const detail = JSON.parse(fallback[0]?.detail_json ?? "{}");
		assert.equal(detail.source, "frozen-user-objective");
		assert.equal(detail.planningUsage.toolCalls, 4);
		assert.equal(detail.planningUsage.tokens, 40);
		assert.equal(state.kernel.computeSnapshot("run").unavailableReason, null);
		assert.equal(state.calls.length, 1);
		assert.equal(state.aborts(), 1);
		assert.equal(state.closes(), 1);
		assert.equal(state.resources.snapshot().activeByLane.INTERACTIVE, 0);
		assert.deepEqual(await readdir(state.paths.worktrees), []);
	});
}

test("correction uses the remaining cumulative planning allocation capped at twenty percent of total tokens", async (context) => {
	const state = await fixture(
		context,
		[{ text: "not valid JSON", usage: { inputTokens: 120 } }, { usage: { inputTokens: 80 } }],
		{ policy: { tokenLimit: 1000, reservationTokens: 100, maxPlanningTokens: 9000 } },
	);
	await state.plan();
	assert.equal(state.calls.length, 2);
	assert.equal(state.catalog.planningUsage("run").tokens, 200);
	const rows = usageRows(state);
	assert.deepEqual(
		rows.map((row) => row.phase),
		["PLAN", "PLAN_CORRECTION"],
	);
	assert.deepEqual(
		rows.map((row) => JSON.parse(row.details_json).phaseBudget.tokenLimit),
		[200, 80],
	);
	assert.equal(state.catalog.listControlActions("run", "PLANNING_FALLBACK").length, 1);
	assert.ok(state.kernel.computeSnapshot("run").tokens + state.kernel.computeSnapshot("run").reservedTokens < 1000);
});

test("exploration observation reuse bypasses a second Pi invocation and records revalidation provenance", async (context) => {
	const state = await fixture(context, [{ profile: "explorer", text: "src/index.txt contains the public baseline." }], {
		reuse: true,
	});
	state.kernel.startAuxiliaryAttempt({
		id: "parent-plan",
		runId: "run",
		workflowFunction: "PLAN",
		baseCommit: state.baseline.commitHash,
		profileName: "planner",
		profileVersion: "offline",
		actor,
	});
	const input = {
		runId: "run",
		plannerAttemptId: "parent-plan",
		objective,
		question: "What does src/index.txt say?",
		baseCommit: state.baseline.commitHash,
		repositoryRoot: state.repository,
	};
	const first = await state.explorer.explore(input);
	const second = await state.explorer.explore(input);
	assert.equal(first.attemptId, second.attemptId);
	assert.equal(state.calls.length, 1);
	assert.match(second.report, /Revalidated repository observation/);
	assert.equal(state.catalog.listControlActions("run", "EXPLORATION_REUSED").length, 1);
});

test("planner exploration and post-exploration planning share one tool allocation", async (context) => {
	const state = await fixture(
		context,
		[
			{
				text: JSON.stringify({ explorationRequests: [{ question: "Which public file owns the requested behavior?" }] }),
				usage: { toolCalls: 1 },
			},
			{ profile: "explorer", usage: { toolCalls: 2 } },
		],
		{ policy: { maxPlanningToolCalls: 3 } },
	);
	await state.plan();
	assert.deepEqual(
		state.calls.map((call) => call.profile),
		["planner", "explorer"],
	);
	assert.equal(state.catalog.planningUsage("run").toolCalls, 3);
	const rows = usageRows(state);
	assert.deepEqual(
		rows.map((row) => row.phase),
		["PLAN", "PLAN_EXPLORATION"],
	);
	assert.deepEqual(
		rows.map((row) => JSON.parse(row.details_json).phaseBudget.toolCallLimit),
		[3, 2],
	);
	assert.equal(state.catalog.listControlActions("run", "PLANNING_FALLBACK").length, 1);
});

test("a small total token budget still leaves unused tokens for the fallback writer with default reservations", async (context) => {
	const state = await fixture(context, [{ usage: { inputTokens: 200 } }], { policy: { tokenLimit: 1000 } });
	await state.plan();
	assert.equal(state.catalog.listTasks("run").length, 1);
	const budget = state.kernel.computeSnapshot("run");
	assert.equal(budget.tokens, 200);
	assert.ok(
		budget.tokens + budget.reservedTokens < 1000,
		"terminated planning must not reserve all implementation tokens",
	);
	assert.equal(budget.unavailableReason, null);
});

test("exhausting the run budget does not authorize a planning fallback", async (context) => {
	const state = await fixture(context, [{ usage: { inputTokens: 1000 } }], {
		policy: { tokenLimit: 1000, reservationTokens: 100 },
	});
	await assert.rejects(state.plan(), { code: "BUDGET_EXHAUSTED" });
	assertNoFallback(state);
	assert.equal(state.kernel.computeSnapshot("run").tokens, 1000);
	assert.match(state.kernel.computeSnapshot("run").unavailableReason ?? "", /token budget/);
});

test("an outstanding authority decision prevents fallback despite unused run budget", async (context) => {
	const state = await fixture(context, [
		{
			usage: { inputTokens: 40, toolCalls: 4 },
			before: (kernel) => {
				kernel.createDecisionRequest({
					runId: "run",
					kind: "AUTHORITY_EXPANSION",
					question: "May the task change files beyond its frozen scope?",
					options: ["Keep the frozen scope", "Authorize another directory"],
					actor,
				});
			},
		},
	]);
	await assert.rejects(state.plan(), { code: "PHASE_BUDGET_EXHAUSTED" });
	assertNoFallback(state);
	assert.equal(state.catalog.listOpenDecisionRequests("run").length, 1);
	assert.equal(state.kernel.computeSnapshot("run").unavailableReason, null);
});

test("provider failures are retained and do not masquerade as a planning allocation fallback", async (context) => {
	const state = await fixture(context, [{ error: new Error("offline provider disconnected") }]);
	await assert.rejects(state.plan(), /offline provider disconnected/);
	assertNoFallback(state);
	assert.equal(state.closes(), 1);
});

test("invalid planning output after its correction falls back without weakening frozen acceptance", async (context) => {
	const state = await fixture(
		context,
		[
			{ text: "not a JSON object", usage: { inputTokens: 20 } },
			{ text: JSON.stringify({ tasks: [], dependencies: [] }), usage: { inputTokens: 30 } },
		],
		{ changeLocalPolicy: true },
	);
	await state.plan();
	assert.equal(state.calls.length, 2);
	assert.deepEqual(
		usageRows(state).map((row) => row.phase),
		["PLAN", "PLAN_CORRECTION"],
	);
	const task = state.catalog.listTasks("run")[0];
	assert.ok(task);
	assert.equal(task.objective, objective);
	assert.deepEqual(task.scope, scope);
	assert.equal(task.riskClass, "NORMAL");
	assert.deepEqual(
		task.acceptanceContract,
		JSON.parse(
			JSON.stringify({
				candidateChecks: state.frozenGoal.taskAcceptancePolicy.candidateChecks,
				integrationChecks: state.frozenGoal.taskAcceptancePolicy.integrationChecks,
				requireReview: true,
			}),
		),
	);
	assert.equal(state.catalog.listControlActions("run", "PLANNING_FALLBACK").length, 1);
	assert.equal(
		state.database.sql.prepare("SELECT state FROM attempts WHERE workflow_function='PLAN'").get<{ state: string }>()
			?.state,
		"FAILED",
	);
});
