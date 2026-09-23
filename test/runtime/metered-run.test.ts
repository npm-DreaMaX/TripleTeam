import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ExecutionPolicy } from "../../src/config/execution.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { DomainInvariantError } from "../../src/domain/model.ts";
import type { PiWorkerController } from "../../src/runtime/pi/launcher.ts";
import { runMetered } from "../../src/runtime/pi/metered-run.ts";
import { PiProviderUnavailableError } from "../../src/runtime/pi/provider-error.ts";
import { type PiUsage, usageFromPiEvent } from "../../src/runtime/pi/rpc-worker.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const actor = { kind: "SYSTEM", id: "meter-test" } as const;
const zero = (): PiUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	toolCalls: 0,
});
const state = {
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

async function fixture(context: TestContext, policy: Partial<ExecutionPolicy> = {}) {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run",
		repositoryRoot: "/fixture",
		inputCommit: "base",
		integrationRef: "refs/run",
		goalContract: { executionPolicy: policy },
		actor,
	});
	const execution = (id: string) => {
		const attemptId = kernel.startAuxiliaryAttempt({
			id: "attempt-" + id,
			runId: "run",
			workflowFunction: "PLAN",
			baseCommit: "base",
			profileName: "planner",
			profileVersion: "1",
			actor,
		});
		const executionId = kernel.createExecution({
			id,
			attemptId,
			piSessionId: "session-" + id,
			contextManifestHash: "context",
			actor,
		});
		kernel.markExecutionLive({ executionId, actor });
		return { kernel, catalog, runId: "run", attemptId, executionId, phase: "PLAN", prompt: "task", timeoutMs: 5_000 };
	};
	return { database, kernel, catalog, execution };
}

function worker(run: (emit: (usage: PiUsage) => void) => Promise<PiUsage>, initial = zero()) {
	let listener: ((usage: PiUsage) => void) | undefined;
	let aborts = 0;
	let unsubscribeCount = 0;
	const controller: PiWorkerController = {
		start: async () => state,
		state: async () => state,
		steer: async () => {},
		followUp: async () => {},
		stop: async () => {},
		abort: async () => {
			aborts++;
		},
		usageSnapshot: () => initial,
		onUsage: (registered) => {
			listener = registered;
			return () => {
				listener = undefined;
				unsubscribeCount++;
			};
		},
		run: async () => ({ state, lastAssistantText: "result", usage: await run((usage) => listener?.(usage)) }),
	};
	return { controller, aborts: () => aborts, unsubscribed: () => unsubscribeCount };
}

test("concurrent executions share one reservation budget and actual usage is not double-counted", async (context) => {
	const { kernel, execution } = await fixture(context, {
		costLimitUsd: 1,
		tokenLimit: 1_000,
		reservationUsd: 0.6,
		reservationTokens: 600,
	});
	const first = execution("first");
	const second = execution("second");
	const third = execution("third");
	kernel.reserveCompute({ id: "r1", runId: "run", executionId: first.executionId });
	kernel.reserveCompute({ id: "r2", runId: "run", executionId: second.executionId });
	assert.equal(kernel.computeSnapshot("run").reservedUsd, 1);
	assert.equal(kernel.computeSnapshot("run").reservedTokens, 1_000);
	assert.throws(() => kernel.reserveCompute({ id: "r3", runId: "run", executionId: third.executionId }), {
		code: "BUDGET_EXHAUSTED",
	});
	const timestamp = new Date().toISOString();
	kernel.recordUsage({
		id: "r1",
		runId: "run",
		attemptId: first.attemptId,
		kind: "AGENT",
		phase: "PLAN",
		startedAt: timestamp,
		finishedAt: timestamp,
		inputTokens: 200,
		outputTokens: 0,
		costUsd: 0.2,
	});
	kernel.checkComputeReservation("r1", 0.2, 200);
	assert.ok(Math.abs(kernel.computeSnapshot("run").reservedUsd - 0.8) < 1e-9);
	assert.equal(kernel.computeSnapshot("run").tokens + kernel.computeSnapshot("run").reservedTokens, 1_000);
	kernel.checkComputeReservation("r1", 0.2, 200);
	assert.ok(Math.abs(kernel.computeSnapshot("run").reservedUsd - 0.8) < 1e-9);
	kernel.releaseCompute("r1");
	kernel.reserveCompute({ id: "r3", runId: "run", executionId: third.executionId });
	assert.ok(kernel.computeSnapshot("run").costUsd + kernel.computeSnapshot("run").reservedUsd <= 1 + 1e-9);
});

test("permanent provider failure stops subsequent compute until explicit continuation without resetting usage", async (context) => {
	const { kernel, catalog, execution } = await fixture(context);
	const failing = worker(async (emit) => {
		emit({ ...zero(), inputTokens: 12, costUsd: 0.1 });
		throw new PiProviderUnavailableError("BILLING");
	});
	const first = execution("billing");
	await assert.rejects(runMetered(failing.controller, first), PiProviderUnavailableError);
	assert.match(kernel.computeSnapshot("run").unavailableReason ?? "", /402/);
	assert.equal(catalog.listControlActions("run", "PROVIDER_UNAVAILABLE").length, 1);
	let calls = 0;
	const next = worker(async () => {
		calls++;
		return zero();
	});
	const second = execution("no-extra-inference");
	await assert.rejects(runMetered(next.controller, second), /402/);
	assert.equal(calls, 0);
	for (const input of [first, second]) {
		kernel.finishExecution({ executionId: input.executionId, state: "EXITED", exitCode: 1, actor });
		kernel.failAttempt({ attemptId: input.attemptId, reason: "Provider unavailable", retryTask: false, actor });
	}
	kernel.blockRun("run", "Provider unavailable", actor);
	kernel.resumeRun("run", actor);
	const after = kernel.computeSnapshot("run");
	assert.equal(after.unavailableReason, null);
	assert.equal(after.tokens, 12);
	assert.equal(after.costUsd, 0.1);
	assert.equal(catalog.listControlActions("run", "PROVIDER_RECOVERY_REQUESTED").length, 1);
});

test("a streaming failure retains observed cost and an interrupted reservation", async (context) => {
	const { database, execution } = await fixture(context, { costLimitUsd: 2, reservationUsd: 1 });
	const fake = worker(async (emit) => {
		emit({ ...zero(), inputTokens: 100, outputTokens: 20, costUsd: 0.4 });
		throw new Error("provider disconnected");
	});
	await assert.rejects(runMetered(fake.controller, execution("stream")), /provider disconnected/);
	const row = database.sql
		.prepare("SELECT cost_usd, input_tokens, output_tokens, details_json FROM usage_records WHERE kind='AGENT'")
		.get<{ cost_usd: number; input_tokens: number; output_tokens: number; details_json: string }>();
	assert.equal(row?.cost_usd, 0.4);
	assert.equal(row?.input_tokens, 100);
	assert.equal(row?.output_tokens, 20);
	assert.equal(JSON.parse(row?.details_json ?? "{}").complete, false);
	assert.equal(JSON.parse(row?.details_json ?? "{}").unreportedInFlight, true);
	assert.equal(
		database.sql.prepare("SELECT state FROM compute_reservations").get<{ state: string }>()?.state,
		"INTERRUPTED",
	);
	assert.equal(fake.unsubscribed(), 1);
});

test("final usage enforces cost limits even when the worker emitted no usage event", async (context) => {
	const { database, execution } = await fixture(context, { costLimitUsd: 0.5 });
	const fake = worker(async () => ({ ...zero(), inputTokens: 100, outputTokens: 20, costUsd: 0.6 }));
	await assert.rejects(runMetered(fake.controller, execution("final-only")), { code: "BUDGET_EXHAUSTED" });
	assert.equal(database.sql.prepare("SELECT cost_usd FROM usage_records").get<{ cost_usd: number }>()?.cost_usd, 0.6);
	assert.equal(fake.aborts(), 1);
});

test("unreported pricing cannot make a cost-limited execution appear free", async (context) => {
	const { execution } = await fixture(context, { costLimitUsd: 1 });
	const fake = worker(async () => ({ ...zero(), inputTokens: 100, outputTokens: 20 }));
	await assert.rejects(runMetered(fake.controller, execution("unpriced")), { code: "UNKNOWN_MODEL_PRICE" });
});

test("cache-only usage also requires known pricing under a monetary budget", async (context) => {
	const { execution } = await fixture(context, { costLimitUsd: 1 });
	const fake = worker(async () => ({ ...zero(), cacheReadTokens: 100, cacheWriteTokens: 20 }));
	await assert.rejects(runMetered(fake.controller, execution("unpriced-cache")), { code: "UNKNOWN_MODEL_PRICE" });
});

test("resumed session totals exclude history and final reconciliation replaces the same usage row", async (context) => {
	const { database, execution } = await fixture(context, { costLimitUsd: 1 });
	const history = { ...zero(), inputTokens: 10_000, costUsd: 5 };
	const fake = worker(async (emit) => {
		emit({ ...history, inputTokens: 10_100, costUsd: 5.2 });
		return { ...zero(), inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, costUsd: 0.25 };
	}, history);
	await runMetered(fake.controller, execution("resumed"));
	assert.equal(database.sql.prepare("SELECT COUNT(*) AS n FROM usage_records").get<{ n: number }>()?.n, 1);
	const row = database.sql
		.prepare("SELECT input_tokens,output_tokens,cache_read_tokens,cost_usd,details_json FROM usage_records")
		.get<{
			input_tokens: number;
			output_tokens: number;
			cache_read_tokens: number;
			cost_usd: number;
			details_json: string;
		}>();
	assert.equal(row?.input_tokens, 100);
	assert.equal(row?.output_tokens, 20);
	assert.equal(row?.cache_read_tokens, 30);
	assert.equal(row?.cost_usd, 0.25);
	assert.equal(JSON.parse(row?.details_json ?? "{}").complete, true);
	assert.equal(
		database.sql.prepare("SELECT state FROM compute_reservations").get<{ state: string }>()?.state,
		"RELEASED",
	);
});

test(
	"deadline cancellation also covers a worker whose state RPC never resolves",
	{ timeout: 3_000 },
	async (context) => {
		const { execution } = await fixture(context, { deadlineMs: 500 });
		const rpcHandle = setInterval(() => {}, 1_000);
		context.after(() => clearInterval(rpcHandle));
		let ran = false;
		const fake = worker(async () => {
			ran = true;
			return zero();
		});
		fake.controller.state = () => new Promise<RpcSessionState>(() => {});
		await assert.rejects(
			runMetered(fake.controller, execution("state-hung")),
			(error) => error instanceof DomainInvariantError && error.code === "BUDGET_EXHAUSTED",
		);
		assert.equal(ran, false);
		assert.equal(fake.aborts(), 1);
	},
);

test("Pi event accounting includes tool and auxiliary usage and excludes duplicate message entries", () => {
	type Event = Parameters<typeof usageFromPiEvent>[0];
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 10,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
	for (const role of ["assistant", "toolResult"]) {
		assert.deepEqual(usageFromPiEvent({ type: "message_end", message: { role, usage } } as unknown as Event), usage);
	}
	for (const type of ["usage", "compaction", "branch_summary"]) {
		assert.deepEqual(usageFromPiEvent({ type: "entry_appended", entry: { type, usage } } as unknown as Event), usage);
	}
	assert.equal(
		usageFromPiEvent({
			type: "entry_appended",
			entry: { type: "message", message: { role: "assistant", usage } },
		} as unknown as Event),
		undefined,
	);
	assert.equal(
		usageFromPiEvent({ type: "message_end", message: { role: "user", usage } } as unknown as Event),
		undefined,
	);
});
