import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { type ExecutionPolicy, parseExecutionPolicy } from "../../src/config/execution.ts";
import type { CheckCommand } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import type { PiWorkerController } from "../../src/runtime/pi/launcher.ts";
import { runMetered } from "../../src/runtime/pi/metered-run.ts";
import type { PiUsage } from "../../src/runtime/pi/rpc-worker.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const actor = { kind: "SYSTEM", id: "phase-budget-test" } as const;
const rpcState = { thinkingLevel: "off", sessionId: "offline-phase-budget" } as RpcSessionState;
const zero = (): PiUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	toolCalls: 0,
});
const phaseBudget = { tokenLimit: 1000, toolCallLimit: 10, durationMs: 60_000, label: "Planning" };

async function fixture(context: TestContext, policy: Partial<ExecutionPolicy> = {}) {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run",
		repositoryRoot: "/offline-fixture",
		inputCommit: "base",
		integrationRef: "refs/test/phase-budget",
		goalContract: { executionPolicy: { tokenLimit: 10_000, reservationTokens: 100, ...policy } },
		actor,
	});
	const execution = (id: string, writer = false) => {
		let attemptId: string;
		if (writer) {
			const check: CheckCommand = {
				name: "check",
				argv: ["git", "diff", "--check"],
				timeoutMs: 1000,
				lane: "LIGHT_CHECK",
			};
			kernel.createTask({
				id: "writer-task",
				runId: "run",
				title: "Implement the original goal",
				objective: "Implement the original goal after bounded planning",
				scope: ["src"],
				constraints: [],
				riskClass: "NORMAL",
				acceptanceContract: { candidateChecks: [check], integrationChecks: [check], requireReview: true },
				actor,
			});
			kernel.markTaskReady("writer-task", actor);
			attemptId = kernel.startAttempt({
				taskId: "writer-task",
				baseCommit: "base",
				profileName: "writer",
				profileVersion: "offline",
				actor,
			}).attemptId;
		} else {
			attemptId = kernel.startAuxiliaryAttempt({
				runId: "run",
				workflowFunction: "PLAN",
				baseCommit: "base",
				profileName: "planner",
				profileVersion: "offline",
				actor,
			});
		}
		const executionId = kernel.createExecution({
			id,
			attemptId,
			piSessionId: `session-${id}`,
			contextManifestHash: "fixture",
			actor,
		});
		kernel.markExecutionLive({ executionId, actor });
		return {
			kernel,
			catalog,
			runId: "run",
			attemptId,
			executionId,
			taskId: writer ? "writer-task" : undefined,
			phase: writer ? "IMPLEMENT" : "PLAN",
			prompt: "offline task",
			timeoutMs: 5000,
		};
	};
	return { database, kernel, catalog, execution };
}

function worker(body: (emit: (total: PiUsage) => void) => Promise<PiUsage>, initial = zero()) {
	let listener: ((total: PiUsage) => void) | undefined;
	const signals = { aborts: 0, states: 0, runs: 0, unsubscribed: 0, steers: [] as string[] };
	const emit = (total: PiUsage) => listener?.(total);
	const controller: PiWorkerController = {
		start: async () => rpcState,
		state: async () => {
			signals.states++;
			return rpcState;
		},
		steer: async (message) => {
			signals.steers.push(message);
		},
		followUp: async () => {},
		stop: async () => {},
		abort: async () => {
			signals.aborts++;
		},
		usageSnapshot: () => initial,
		onUsage: (callback) => {
			listener = callback;
			return () => {
				listener = undefined;
				signals.unsubscribed++;
			};
		},
		run: async () => {
			signals.runs++;
			return { state: rpcState, lastAssistantText: "Offline result", usage: await body(emit) };
		},
	};
	return { controller, signals, emit };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function usageRow(state: Fixture, phase = "PLAN") {
	const row = state.database.sql
		.prepare(
			"SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,tool_calls,details_json FROM usage_records WHERE phase=?",
		)
		.get<{
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cache_write_tokens: number;
			cost_usd: number;
			tool_calls: number;
			details_json: string;
		}>(phase);
	assert.ok(row);
	return row;
}

test("planning allocations have finite defaults and reject zero, negative or non-finite limits", () => {
	const defaults = parseExecutionPolicy();
	assert.equal(defaults.maxPlanningTokens, 250_000);
	assert.equal(defaults.maxPlanningToolCalls, 24);
	assert.equal(defaults.maxPlanningMs, 120_000);
	for (const key of ["maxPlanningTokens", "maxPlanningToolCalls", "maxPlanningMs"])
		for (const value of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => parseExecutionPolicy({ [key]: value }));
});

for (const dimension of ["tokens", "tools", "elapsed"] as const) {
	test(`the ${dimension} soft limit steers once at seventy percent and leaves Pi running`, async (context) => {
		const state = await fixture(context);
		let elapsed = 0;
		if (dimension === "elapsed") {
			const realNow = Date.now.bind(Date);
			context.mock.method(Date, "now", () => realNow() + elapsed);
		}
		const fake = worker(async (emit) => {
			const at = (fraction: number) => {
				if (dimension === "elapsed") elapsed = fraction * phaseBudget.durationMs;
				const usage = {
					...zero(),
					inputTokens: dimension === "tokens" ? Math.round(fraction * phaseBudget.tokenLimit) : 0,
					toolCalls: dimension === "tools" ? Math.floor(fraction * phaseBudget.toolCallLimit) : 0,
				};
				emit(usage);
				return usage;
			};
			at(0.69);
			assert.equal(fake.signals.steers.length, 0);
			at(0.7);
			assert.equal(fake.signals.steers.length, 1);
			return at(0.85);
		});
		await runMetered(fake.controller, { ...state.execution("soft"), phaseBudget });
		assert.equal(fake.signals.steers.length, 1);
		assert.match(fake.signals.steers[0] ?? "", /return the requested final structured result now/);
		assert.equal(fake.signals.aborts, 0);
		assert.equal(fake.signals.unsubscribed, 1);
		assert.equal(JSON.parse(usageRow(state).details_json).complete, true);
		assert.equal(state.kernel.computeSnapshot("run").reservedTokens, 0);
	});
}

test("the hard token cap counts all token classes, preserves observed usage and leaves the writer its remaining budget", async (context) => {
	const state = await fixture(context);
	const initial = { ...zero(), inputTokens: 50_000, costUsd: 5, toolCalls: 100 };
	const delta = {
		...zero(),
		inputTokens: 200,
		outputTokens: 100,
		cacheReadTokens: 300,
		cacheWriteTokens: 400,
		costUsd: 0.25,
		toolCalls: 2,
	};
	const fake = worker(async (emit) => {
		const total = { ...initial };
		for (const key of Object.keys(total) as Array<keyof PiUsage>) total[key] += delta[key];
		emit(total);
		return new Promise<PiUsage>(() => {});
	}, initial);
	const planning = state.execution("planning");
	await assert.rejects(runMetered(fake.controller, { ...planning, phaseBudget }), { code: "PHASE_BUDGET_EXHAUSTED" });
	const row = usageRow(state);
	assert.equal(row.input_tokens, 200);
	assert.equal(row.output_tokens, 100);
	assert.equal(row.cache_read_tokens, 300);
	assert.equal(row.cache_write_tokens, 400);
	assert.equal(row.cost_usd, 0.25);
	assert.equal(row.tool_calls, 2);
	assert.equal(JSON.parse(row.details_json).complete, false);
	assert.equal(JSON.parse(row.details_json).usageObserved, true);
	assert.match(JSON.parse(row.details_json).budgetStop, /Planning exhausted/);
	assert.equal(fake.signals.aborts, 1);
	assert.equal(fake.signals.unsubscribed, 1);
	assert.equal(state.kernel.computeSnapshot("run").tokens, 1000);
	state.kernel.finishExecution({ executionId: planning.executionId, state: "KILLED", actor });
	state.kernel.failAttempt({
		attemptId: planning.attemptId,
		retryTask: false,
		reason: "Planning allocation exhausted",
		actor,
	});
	const writer = worker(async () => ({ ...zero(), inputTokens: 8000, costUsd: 0.5 }));
	await runMetered(writer.controller, state.execution("writer", true));
	assert.equal(writer.signals.aborts, 0);
	assert.equal(usageRow(state, "IMPLEMENT").input_tokens, 8000);
	assert.equal(state.kernel.computeSnapshot("run").tokens, 9000);
	assert.equal(state.kernel.computeSnapshot("run").costUsd, 0.75);
	assert.equal(state.kernel.computeSnapshot("run").unavailableReason, null);
});

test("final-only tool usage cannot bypass the hard phase limit", async (context) => {
	const state = await fixture(context);
	const fake = worker(async () => ({ ...zero(), inputTokens: 20, toolCalls: 10, costUsd: 0.1 }));
	await assert.rejects(runMetered(fake.controller, { ...state.execution("tools"), phaseBudget }), {
		code: "PHASE_BUDGET_EXHAUSTED",
	});
	assert.equal(fake.signals.aborts, 1);
	assert.equal(usageRow(state).tool_calls, 10);
	assert.equal(usageRow(state).input_tokens, 20);
	assert.equal(state.kernel.computeSnapshot("run").tokens, 20);
});

test("an interrupted planning phase retains uncertainty without reserving the writer's monetary budget", async (context) => {
	const state = await fixture(context, { costLimitUsd: 1, reservationUsd: 1, reservationTokens: 32_000 });
	const fake = worker(async (emit) => {
		emit({ ...zero(), inputTokens: 10, costUsd: 0.05, toolCalls: 10 });
		return new Promise<PiUsage>(() => {});
	});
	const planning = state.execution("monetary-planning");
	await assert.rejects(runMetered(fake.controller, { ...planning, phaseBudget }), {
		code: "PHASE_BUDGET_EXHAUSTED",
	});
	const budget = state.kernel.computeSnapshot("run");
	assert.equal(budget.costUsd, 0.05);
	assert.ok(budget.reservedUsd > 0, "unknown in-flight compute still needs an interrupted reservation");
	assert.ok(Math.abs(budget.costUsd + budget.reservedUsd - 0.2) < 1e-9);
	assert.equal(budget.tokens + budget.reservedTokens, phaseBudget.tokenLimit);
	assert.equal(budget.unavailableReason, null);
	state.kernel.finishExecution({ executionId: planning.executionId, state: "KILLED", actor });
	state.kernel.failAttempt({
		attemptId: planning.attemptId,
		retryTask: false,
		reason: "Phase allocation exhausted",
		actor,
	});
	const writer = worker(async () => ({ ...zero(), inputTokens: 7000, costUsd: 0.7 }));
	await runMetered(writer.controller, state.execution("monetary-writer", true));
	assert.equal(writer.signals.aborts, 0);
	assert.equal(state.kernel.computeSnapshot("run").costUsd, 0.75);
	assert.equal(state.kernel.computeSnapshot("run").tokens, 7010);
	assert.equal(state.kernel.computeSnapshot("run").unavailableReason, null);
});

for (const stalled of ["state", "run"] as const) {
	test(
		`the phase deadline aborts a silent ${stalled} RPC and removes listeners`,
		{ timeout: 3000 },
		async (context) => {
			const state = await fixture(context);
			// A real Pi RPC holds a process handle; keep this silent fake alive until the 200 ms watchdog runs.
			const rpcHandle = setInterval(() => {}, 1000);
			context.after(() => clearInterval(rpcHandle));
			let advance = false;
			const realNow = Date.now.bind(Date);
			context.mock.method(Date, "now", () => realNow() + (advance ? phaseBudget.durationMs + 1 : 0));
			const fake = worker(async () => {
				advance = true;
				return new Promise<PiUsage>(() => {});
			});
			if (stalled === "state")
				fake.controller.state = () => {
					advance = true;
					return new Promise<RpcSessionState>(() => {});
				};
			await assert.rejects(runMetered(fake.controller, { ...state.execution(`silent-${stalled}`), phaseBudget }), {
				code: "PHASE_BUDGET_EXHAUSTED",
			});
			assert.equal(fake.signals.runs, stalled === "run" ? 1 : 0);
			assert.equal(fake.signals.aborts, 1);
			assert.equal(fake.signals.unsubscribed, 1);
			fake.emit({ ...zero(), inputTokens: 50_000 });
			assert.equal(fake.signals.aborts, 1);
			assert.equal(state.kernel.computeSnapshot("run").tokens, 0);
			assert.equal(JSON.parse(usageRow(state).details_json).usageObserved, false);
		},
	);
}

test("a previously exhausted phase allocation cannot launch another Pi run", async (context) => {
	const state = await fixture(context);
	const fake = worker(async () => zero());
	await assert.rejects(
		runMetered(fake.controller, {
			...state.execution("already-exhausted"),
			phaseBudget: { ...phaseBudget, toolCallLimit: 0 },
		}),
		{ code: "PHASE_BUDGET_EXHAUSTED" },
	);
	assert.equal(fake.signals.runs, 0);
	assert.equal(fake.signals.unsubscribed, 0, "preflight rejection must not subscribe to Pi usage");
	assert.equal(state.kernel.computeSnapshot("run").tokens, 0);
});
