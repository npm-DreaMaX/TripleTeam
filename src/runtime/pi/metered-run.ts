import { randomUUID } from "node:crypto";
import { executionPolicyFor } from "../../config/execution.ts";
import type { ControlCatalog } from "../../control/catalog.ts";
import type { ControlKernel } from "../../control/kernel.ts";
import { DomainInvariantError } from "../../domain/model.ts";
import type { PiWorkerController } from "./launcher.ts";
import type { PiRunResult, PiUsage } from "./rpc-worker.ts";

const zero = (): PiUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	toolCalls: 0,
});

/** A task-budget adapter around Pi's public events. Pi still owns inference and cancellation. */
export async function runMetered(
	worker: PiWorkerController,
	input: {
		kernel: ControlKernel;
		catalog: ControlCatalog;
		runId: string;
		taskId?: string;
		attemptId: string;
		executionId: string;
		phase: string;
		prompt: string;
		timeoutMs: number;
	},
): Promise<PiRunResult> {
	const id = randomUUID();
	const startedAt = new Date().toISOString();
	const policy = executionPolicyFor(input.catalog.getRun(input.runId).goalContract);
	input.kernel.reserveCompute({ id, runId: input.runId, executionId: input.executionId });
	const initial = worker.usageSnapshot?.() ?? zero();
	let usage = zero();
	let completed = false;
	let observed = false;
	let stopped: Error | undefined;
	let resolvedModel: unknown = null;
	let rejectBudget: (error: Error) => void = () => {};
	const budgetFailure = new Promise<never>((_, reject) => {
		rejectBudget = reject;
	});
	void budgetFailure.catch(() => {});
	const persist = (final = false): void => {
		input.kernel.recordUsage({
			id,
			runId: input.runId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			kind: "AGENT",
			phase: input.phase,
			startedAt,
			finishedAt: new Date().toISOString(),
			...(observed ? usage : {}),
			details: {
				executionId: input.executionId,
				complete: completed,
				final,
				source: "pi-public-events",
				usageObserved: observed,
				unreportedInFlight: final && !completed,
				budgetStop: stopped?.message ?? null,
				resolvedModel,
			},
		});
	};
	const enforce = (): void => {
		if (stopped) return;
		try {
			const run = input.catalog.getRun(input.runId);
			if (run.state !== "OPEN") throw new Error(`Run authority ended: ${run.state}`);
			input.kernel.checkComputeReservation(
				id,
				usage.costUsd,
				usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
			);
			if (
				policy.costLimitUsd !== undefined &&
				observed &&
				usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0 &&
				usage.costUsd === 0
			) {
				throw new DomainInvariantError(
					"UNKNOWN_MODEL_PRICE",
					"A cost-limited run requires a configured Pi model price; zero/unreported price cannot be treated as free compute",
				);
			}
		} catch (error) {
			stopped = error instanceof Error ? error : new Error(String(error));
			void worker.abort().catch(() => {});
			rejectBudget(stopped);
		}
	};
	const unsubscribe = worker.onUsage?.((total) => {
		usage = Object.fromEntries(
			Object.keys(initial).map((key) => [
				key,
				Math.max(0, total[key as keyof PiUsage] - initial[key as keyof PiUsage]),
			]),
		) as unknown as PiUsage;
		observed = true;
		try {
			persist();
			enforce();
		} catch (error) {
			stopped = error instanceof Error ? error : new Error(String(error));
			void worker.abort().catch(() => {});
			rejectBudget(stopped);
		}
	});
	const watchdog = setInterval(enforce, 200);
	watchdog.unref();
	try {
		persist();
		const runtime = await Promise.race([worker.state(), budgetFailure]);
		resolvedModel = {
			provider: runtime.model?.provider ?? null,
			model: runtime.model?.id ?? null,
			reasoning: runtime.thinkingLevel,
		};
		const snapshot = input.kernel.computeSnapshot(input.runId);
		const timeout = Math.min(input.timeoutMs, snapshot.remainingMs ?? input.timeoutMs);
		const result = await Promise.race([worker.run(input.prompt, Math.max(1, timeout)), budgetFailure]);
		usage = result.usage;
		observed = true;
		persist();
		enforce();
		if (stopped) throw stopped;
		completed = true;
		return result;
	} finally {
		clearInterval(watchdog);
		unsubscribe?.();
		try {
			persist(true);
		} finally {
			input.kernel.releaseCompute(id, !completed);
		}
	}
}
