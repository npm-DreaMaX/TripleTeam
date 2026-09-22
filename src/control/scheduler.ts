import { readFile } from "node:fs/promises";
import { type ExecutionPolicy, executionPolicyFor } from "../config/execution.ts";
import { type CheckCommand, checkCommandVersion, parseCheckCommand } from "../config/project.ts";
import type { AdaptiveExplorationCoordinator } from "../exploration/explorer.ts";
import type { RunVerificationResult, RunVerifier } from "../verification/run-verifier.ts";
import type { ControlCatalog, TaskDefinition } from "./catalog.ts";
import { AdaptiveCoordinationPolicy, type ExecutionDecision } from "./coordination-policy.ts";
import type { ControlKernel } from "./kernel.ts";
import type { LocalResourceGovernor } from "./resource-governor.ts";
import { scopesOverlap } from "./scope.ts";
import type { TaskExecutor } from "./task-executor.ts";
import type { BoundedTaskProposalPolicy } from "./task-proposal-policy.ts";

interface RunningWork {
	task: TaskDefinition;
	promise: Promise<{ taskId: string; error?: unknown }>;
}

const actor = { kind: "SYSTEM", id: "scheduler" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseChecks(value: unknown, name: string): CheckCommand[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`Frozen ${name} is unavailable for final repair`);
	return value.map((check, index) => parseCheckCommand(check, `${name}[${index}]`));
}

function combinedChecks(taskChecks: CheckCommand[], finalChecks: CheckCommand[]): CheckCommand[] {
	const checks = [...taskChecks];
	for (const final of finalChecks) {
		if (checks.some((check) => checkCommandVersion(check) === checkCommandVersion(final))) continue;
		let name = final.name;
		while (checks.some((check) => check.name === name)) name = "final:" + name;
		checks.push({ ...final, name });
	}
	return checks;
}

export interface SchedulerResult {
	runId: string;
	state: "COMPLETED" | "BLOCKED" | "CANCELLED";
	integrationHead: string;
}

export function selectParallelTasks(ready: TaskDefinition[], limit: number): TaskDefinition[] {
	const selected: TaskDefinition[] = [];
	for (const task of ready) {
		if (selected.length >= limit) break;
		if (selected.every((other) => !scopesOverlap(task.scope, other.scope))) selected.push(task);
	}
	return selected.length > 0 ? selected : ready.slice(0, 1);
}

export class RunScheduler {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly executor: TaskExecutor,
		private readonly finalVerifier: RunVerifier,
		private readonly resources: LocalResourceGovernor,
		private readonly proposalPolicy?: BoundedTaskProposalPolicy,
		private readonly coordinationPolicy?: AdaptiveCoordinationPolicy,
		private readonly explorationCoordinator?: AdaptiveExplorationCoordinator,
	) {}

	async runUntilSettled(runId: string, signal?: AbortSignal): Promise<SchedulerResult> {
		const running = new Map<string, RunningWork>();
		const coordination =
			this.coordinationPolicy ?? new AdaptiveCoordinationPolicy(this.kernel, this.catalog, this.resources);
		const waitForProgress = async (): Promise<void> => {
			const finished = await Promise.race([...running.values()].map((work) => work.promise));
			running.delete(finished.taskId);
			if ("error" in finished) throw finished.error;
		};
		const launch = (task: TaskDefinition, decision: ExecutionDecision): void => {
			const startedAt = new Date().toISOString();
			const concurrentTaskIds = [...running.keys(), task.id];
			const promise = Promise.resolve()
				.then(async () => {
					try {
						if (decision.mode === "DIVERSE_EXPLORATION") {
							if (!this.explorationCoordinator) throw new Error("Adaptive exploration is not configured");
							await this.explorationCoordinator.explore(task.id);
						} else await this.executor.execute(task.id);
						return { taskId: task.id };
					} catch (error) {
						return { taskId: task.id, error };
					} finally {
						this.kernel.recordUsage({
							runId,
							taskId: task.id,
							kind: "COORDINATION",
							phase: decision.mode,
							startedAt,
							finishedAt: new Date().toISOString(),
							details: { decisionId: decision.id, concurrentTaskIds, dispatch: "event-driven" },
						});
					}
				})
				.catch((error: unknown) => ({ taskId: task.id, error }));
			running.set(task.id, { task, promise });
		};
		try {
			while (true) {
				if (signal?.aborted) throw new Error("Run scheduling aborted");
				const run = this.catalog.getRun(runId);
				if (run.state === "COMPLETED" || run.state === "BLOCKED" || run.state === "CANCELLED") {
					return { runId, state: run.state, integrationHead: run.integrationHead };
				}
				const proposals = this.proposalPolicy?.process(runId);
				for (const task of this.catalog.listUnblockedProposed(runId)) {
					this.kernel.markTaskReady(task.id, actor);
				}
				const outstanding = this.catalog.listOpenDecisionRequests(runId);
				for (const task of this.catalog.listTasks(runId, ["READY"])) {
					if (outstanding.some((request) => request.taskId === null || request.taskId === task.id)) {
						this.kernel.blockReadyTask(task.id, "Execution waits for the outstanding authoritative decision", actor);
					}
				}
				const ready = this.catalog.listRunnableReady(runId).filter((task) => !running.has(task.id));
				if (ready.length === 0 && running.size === 0) {
					const openDecisions = this.catalog.listOpenDecisionRequests(runId);
					if (!this.catalog.hasUnfinishedTasks(runId)) {
						if (openDecisions.length || proposals?.requiresUser.length) {
							return this.block(runId, "Final acceptance waits for the outstanding human or task-graph decision");
						}
						// Finished engineering work may still be verified after its Agent budget is consumed.
						const result = await this.verifyOrRepair(runId);
						if (result) return result;
						continue;
					}
					const proposalReason = openDecisions.length
						? `Human-on-Exception decision required: ${openDecisions.map((decision) => decision.id).join(", ")}`
						: proposals?.requiresUser.length
							? `Task-graph proposal requires user decision: ${proposals.requiresUser
									.map((proposal) => `${proposal.proposalId} (${proposal.reason})`)
									.join("; ")}`
							: "No runnable tasks remain; at least one task or dependency is blocked";
					return this.block(runId, proposalReason);
				}
				const budget = this.kernel.computeSnapshot(runId);
				if (budget.unavailableReason) {
					if (running.size > 0) {
						await waitForProgress();
						continue;
					}
					return this.block(runId, budget.unavailableReason);
				}
				const policy = executionPolicyFor(run.goalContract);
				const parallelism =
					policy.policy === "SINGLE" ? 1 : Math.min(policy.maxParallelism, this.resources.policy.lanes.CODING.limit);
				let slots = Math.max(0, Math.min(parallelism - running.size, policy.maxExecutions - budget.executions));
				// Reserve room for workers still creating their worktrees before Pi metering starts.
				// The runtime reservation is authoritative; this estimate avoids dispatching work
				// that can only fail because a sibling already owns the available compute.
				for (const [limit, spent, reserved, quantum] of [
					[policy.costLimitUsd, budget.costUsd, budget.reservedUsd, policy.reservationUsd],
					[policy.tokenLimit, budget.tokens, budget.reservedTokens, policy.reservationTokens],
				] as const) {
					if (limit === undefined) continue;
					const available = limit - spent - Math.max(reserved, running.size * quantum);
					const capacity = available <= 0 ? 0 : Math.max(running.size === 0 ? 1 : 0, Math.floor(available / quantum));
					slots = Math.min(slots, capacity);
				}
				if (ready.length > 0 && slots > 0) {
					const active = [...running.values()].map((work) => work.task);
					const decision = coordination.decide(runId, ready, active);
					const selected: TaskDefinition[] = [];
					for (const task of decision.tasks) {
						if (selected.length >= slots) break;
						if (!ready.some((item) => item.id === task.id)) continue;
						if ([...active, ...selected].some((other) => scopesOverlap(task.scope, other.scope))) continue;
						selected.push(task);
					}
					for (const task of selected) launch(task, decision);
				}
				if (running.size > 0) {
					await waitForProgress();
					continue;
				}
				return this.block(runId, "No task can be dispatched within the frozen coordination policy");
			}
		} finally {
			// A rejected sibling, cancellation, or observer error must never orphan live work.
			await Promise.allSettled([...running.values()].map((work) => work.promise));
		}
	}

	private block(runId: string, reason: string): SchedulerResult {
		const current = this.catalog.getRun(runId);
		if (current.state !== "OPEN") return { runId, state: current.state, integrationHead: current.integrationHead };
		for (const task of this.catalog.listTasks(runId, ["READY"])) this.kernel.blockReadyTask(task.id, reason, actor);
		this.kernel.blockRun(runId, reason, actor);
		const run = this.catalog.getRun(runId);
		return { runId, state: "BLOCKED", integrationHead: run.integrationHead };
	}

	private async verifyOrRepair(runId: string): Promise<SchedulerResult | null> {
		const run = this.catalog.getRun(runId);
		const goal = isRecord(run.goalContract) ? run.goalContract : {};
		const policy = executionPolicyFor(goal);
		let verification: RunVerificationResult;
		try {
			verification = await this.finalVerifier.verify(runId);
		} catch (error) {
			return this.retryFinalInfrastructure(
				runId,
				run.integrationHead,
				[],
				error instanceof Error ? error.message : String(error),
			);
		}
		const current = this.catalog.getRun(runId);
		if (current.state !== "OPEN") return { runId, state: current.state, integrationHead: current.integrationHead };
		if (verification.status === "PASSED") {
			this.kernel.completeRun({ runId, treeHash: verification.treeHash }, actor);
			return { runId, state: "COMPLETED", integrationHead: this.catalog.getRun(runId).integrationHead };
		}
		if (verification.status === "ERROR") {
			return this.retryFinalInfrastructure(
				runId,
				run.integrationHead,
				verification.checkIds,
				"Final verification infrastructure failed",
			);
		}
		const budget = this.kernel.computeSnapshot(runId);
		if (budget.unavailableReason) return this.block(runId, `Final verification failed; ${budget.unavailableReason}`);
		if (!policy.enableFailureAdaptation)
			return this.block(runId, "Final verification failed; automatic repair is disabled by the frozen policy");
		try {
			const repaired = await this.createFinalRepair(runId, verification, policy);
			if (repaired) return null;
			return this.block(runId, "Final verification failed; final repair budget exhausted");
		} catch (error) {
			return this.block(
				runId,
				`Final verification failed; safe repair could not be constructed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private retryFinalInfrastructure(
		runId: string,
		baseline: string,
		checkIds: string[],
		detail: string,
	): SchedulerResult | null {
		const goal = this.catalog.getRun(runId).goalContract;
		const configuration = isRecord(goal) && isRecord(goal.coordinationPolicy) ? goal.coordinationPolicy : {};
		const configuredLimit = configuration.maxRepeatedFailureFingerprints;
		const limit =
			typeof configuredLimit === "number" && Number.isSafeInteger(configuredLimit) && configuredLimit >= 0
				? configuredLimit
				: 2;
		const prior = this.catalog
			.listControlActions(runId, "FINAL_INFRA_RETRY")
			.filter((action) => (JSON.parse(action.detail_json) as { baseline?: string }).baseline === baseline);
		if (prior.length >= limit) return this.block(runId, `${detail}; same-tree infrastructure retry budget exhausted`);
		this.kernel.recordControlAction({
			runId,
			kind: "FINAL_INFRA_RETRY",
			detail: { baseline, checkIds, detail, occurrence: prior.length + 1 },
		});
		return null;
	}

	private async createFinalRepair(
		runId: string,
		verification: RunVerificationResult,
		policy: ExecutionPolicy,
	): Promise<boolean> {
		const run = this.catalog.getRun(runId);
		const tasks = this.catalog.listTasks(runId);
		const prefix = `${runId}:final-repair:`;
		// Task identity makes the limit durable even if a crash interrupts action logging.
		const repairs = tasks.filter((task) => task.id.startsWith(prefix));
		if (repairs.length >= policy.maxFinalRepairs) return false;
		const goal = isRecord(run.goalContract) ? run.goalContract : {};
		if (!isRecord(goal.taskAcceptancePolicy)) throw new Error("Frozen task acceptance policy is missing");
		const finalChecks = parseChecks(goal.runChecks, "goalContract.runChecks");
		const candidateChecks = combinedChecks(
			parseChecks(goal.taskAcceptancePolicy.candidateChecks, "candidateChecks"),
			finalChecks,
		);
		const integrationChecks = combinedChecks(
			parseChecks(goal.taskAcceptancePolicy.integrationChecks, "integrationChecks"),
			finalChecks,
		);
		const scope = goal.authorizedScope ?? [
			...new Set(
				tasks
					.filter((task) => task.state === "ACCEPTED")
					.flatMap((task) => (Array.isArray(task.scope) ? task.scope : [])),
			),
		];
		if (!Array.isArray(scope) || !scope.every((item) => typeof item === "string") || scope.length === 0)
			throw new Error("No frozen scope is available for a final repair");
		const evidence = this.catalog
			.checkEvidence(verification.checkIds)
			.filter(
				(check) =>
					check.runId === runId &&
					check.subjectKind === "RUN" &&
					check.subjectId === runId &&
					check.treeHash === verification.treeHash &&
					check.state === "FAILED",
			);
		if (evidence.length === 0) throw new Error("Final verifier returned no matching failed exact-tree evidence");
		const tail = async (path: string | null): Promise<string | null> => {
			if (!path) return null;
			try {
				return (await readFile(path, "utf8")).slice(-2_000);
			} catch {
				return "Evidence file unavailable; inspect the durable check record.";
			}
		};
		const packet = await Promise.all(
			evidence.slice(-4).map(async (check) => ({
				...check,
				stdoutTail: await tail(check.stdoutPath),
				stderrTail: await tail(check.stderrPath),
			})),
		);
		const taskId = this.kernel.createTask({
			id: prefix + (repairs.length + 1),
			runId,
			title: `Repair final verification ${repairs.length + 1}`,
			objective: `Preserve the original goal and previously accepted behavior. Repair the failure on integration commit ${run.integrationHead}, tree ${verification.treeHash}, without weakening any acceptance criteria.\nOriginal goal: ${run.objective}\nIndependent final-check evidence:\n${JSON.stringify(packet)}`,
			scope,
			constraints: [
				"Preserve the frozen GoalContract, protected oracle files, prior accepted functionality and all required checks.",
				"Do not change product requirements or broaden scope; diagnose and repair the failing implementation from the supplied evidence.",
			],
			acceptanceContract: {
				candidateChecks,
				integrationChecks,
				requireReview:
					Array.isArray(goal.taskAcceptancePolicy.reviewRequiredFor) &&
					goal.taskAcceptancePolicy.reviewRequiredFor.includes("HIGH"),
			},
			riskClass: "HIGH",
			priority: 1000,
			actor,
		});
		this.kernel.recordControlAction({
			runId,
			taskId,
			kind: "FINAL_REPAIR",
			detail: {
				baseline: run.integrationHead,
				treeHash: verification.treeHash,
				checkIds: verification.checkIds,
				occurrence: repairs.length + 1,
			},
		});
		this.kernel.sendMessage({
			runId,
			taskId,
			recipientKind: "TASK",
			recipientId: taskId,
			kind: "HANDOFF",
			body: `The final acceptance gate failed. Repair the original engineering goal; no human decision or acceptance change has been authorized. See this task's objective for exact-tree check evidence.`,
			references: evidence.map((check) => ({ kind: "CHECK" as const, id: check.id })),
			actor,
		});
		return true;
	}
}
