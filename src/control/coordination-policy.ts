import { executionPolicyFor } from "../config/execution.ts";
import type { ExecutionMode } from "../domain/model.ts";
import type { ControlCatalog, CoordinationAssessment, CoordinationContract, TaskDefinition } from "./catalog.ts";
import { pendingExplorationQuestions } from "./exploration-policy.ts";
import type { ControlKernel } from "./kernel.ts";
import type { LocalResourceGovernor } from "./resource-governor.ts";
import { scopesOverlap } from "./scope.ts";

export interface ExecutionDecision {
	id: string;
	mode: ExecutionMode;
	tasks: TaskDefinition[];
	rationale: string;
}

interface TaskSignals {
	task: TaskDefinition;
	assessment: CoordinationAssessment | null;
	contract: CoordinationContract | null;
	verifiedRequirements?: boolean;
}

function intersects(left: string[], right: string[]): boolean {
	const normalized = new Set(left.map((value) => value.trim().toLowerCase()).filter(Boolean));
	return right.some((value) => normalized.has(value.trim().toLowerCase()));
}

function independentlyExecutable(signals: TaskSignals): boolean {
	const assessment = signals.assessment;
	const contract = signals.contract;
	return Boolean(
		assessment &&
			contract &&
			contract.state !== "INVALIDATED" &&
			assessment.decomposability !== "LOW" &&
			assessment.sequentiality === "LOW" &&
			(assessment.semanticCoupling === "LOW" ||
				(assessment.semanticCoupling === "MEDIUM" && signals.verifiedRequirements)) &&
			assessment.integrationCost !== "HIGH" &&
			assessment.uncertainty !== "HIGH",
	);
}

function semanticallyIndependent(left: TaskSignals, right: TaskSignals): boolean {
	if (!independentlyExecutable(left) || !independentlyExecutable(right)) return false;
	const a = left.contract as CoordinationContract;
	const b = right.contract as CoordinationContract;
	if (intersects(a.requires, b.provides) || intersects(b.requires, a.provides)) return false;
	const sharedInterfaces = a.interfaces.filter((name) => intersects([name], b.interfaces));
	if (
		sharedInterfaces.length > 0 &&
		!(
			left.verifiedRequirements &&
			right.verifiedRequirements &&
			sharedInterfaces.every((name) => a.requires.includes(name) && b.requires.includes(name))
		)
	)
		return false;
	return !scopesOverlap(left.task.scope, right.task.scope);
}

export class AdaptiveCoordinationPolicy {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly resources: LocalResourceGovernor,
	) {}

	decide(runId: string, ready: TaskDefinition[], active: TaskDefinition[] = []): ExecutionDecision {
		if (ready.length === 0) throw new Error("Adaptive coordination requires at least one ready task");
		const run = this.catalog.getRun(runId);
		const policy = executionPolicyFor(run.goalContract);
		const limit = Math.max(
			0,
			Math.min(this.resources.policy.lanes.CODING.limit, policy.maxParallelism) - active.length,
		);
		const providers = this.catalog
			.listTasks(runId)
			.filter((task) => task.state !== "CANCELLED")
			.map((t) => ({ task: t, contract: this.catalog.getCoordinationContract(t.id) }));
		const verified = (task: TaskDefinition): boolean => {
			const contract = this.catalog.getCoordinationContract(task.id);
			const requirements = contract?.requires ?? [];
			return (
				policy.enableContracts &&
				requirements.length > 0 &&
				Boolean(contract?.interfaces.length) &&
				Boolean(contract?.interfaces.every((name) => requirements.includes(name))) &&
				requirements.every((key) => {
					const matches = providers.filter((provider) => provider.contract?.provides.includes(key));
					const producer = matches[0];
					if (matches.length !== 1 || producer?.task.state !== "ACCEPTED" || producer.contract?.state !== "SATISFIED")
						return false;
					const obligation = producer.contract.obligations.find((entry) => entry.key === key);
					return Boolean(
						obligation &&
							this.catalog
								.listContractEvidence(producer.contract.id)
								.some(
									(evidence) =>
										evidence.version === producer.contract?.version &&
										evidence.obligation === key &&
										evidence.checkIds.length > 0 &&
										obligation.artifactPaths.every((path) =>
											evidence.artifacts.some((artifact) => artifact.path === path),
										),
								),
					);
				})
			);
		};
		const history = this.catalog.performanceHistory(runId);
		const observed = history.filter((item) => item.writerSamples > 0);
		const mean = (
			field: "durationMs" | "costUsd" | "checksMs" | "auxiliaryMs" | "auxiliaryCostUsd",
			fallback: number,
		) => {
			const samples = observed.reduce((sum, item) => sum + item.writerSamples, 0);
			return samples ? observed.reduce((sum, item) => sum + item[field] * item.writerSamples, 0) / samples : fallback;
		};
		const duration = mean("durationMs", 600_000);
		const cost = mean("costUsd", policy.reservationUsd);
		const checks = mean("checksMs", 30_000);
		const auxiliary = mean("auxiliaryMs", duration * 0.15);
		const auxiliaryCost = mean("auxiliaryCostUsd", policy.reservationUsd * 0.5);
		const successes = history.reduce((sum, item) => sum + item.successes, 0);
		const failures = history.reduce((sum, item) => sum + item.failures, 0);
		const reliability = (taskId: string) => {
			const local = history.find((entry) => entry.taskId === taskId);
			const otherSuccesses = successes - (local?.successes ?? 0);
			const otherFailures = failures - (local?.failures ?? 0);
			const otherCount = otherSuccesses + otherFailures;
			// Cap cross-task transfer: tasks in one run are not exchangeable experiments.
			const transfer = otherCount ? Math.min(4, otherCount) / otherCount : 0;
			const alpha = 2 + (local?.successes ?? 0) + transfer * otherSuccesses;
			const beta = 2 + (local?.failures ?? 0) + transfer * otherFailures;
			const average = alpha / (alpha + beta);
			const deviation = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
			return {
				successProbability: average,
				conservativeSuccessScore: Math.max(0, average - deviation),
				localOutcomes: (local?.successes ?? 0) + (local?.failures ?? 0),
				transferredOutcomes: Math.min(4, otherCount),
			};
		};
		const dependencies = this.catalog.listDependencies(runId);
		const scores = new Map<string, number>();
		const visiting = new Set<string>();
		const critical = (id: string): number => {
			const cached = scores.get(id);
			if (cached !== undefined) return cached;
			if (visiting.has(id)) return 0;
			visiting.add(id);
			const own = history.find((h) => h.taskId === id)?.durationMs || duration;
			const tail = Math.max(
				0,
				...dependencies.filter((edge) => edge.dependsOnTaskId === id).map((edge) => critical(edge.taskId)),
			);
			visiting.delete(id);
			scores.set(id, own + tail);
			return own + tail;
		};
		if (policy.policy === "ADAPTIVE")
			ready = [...ready].sort((a, b) => critical(b.id) + b.priority * 1000 - (critical(a.id) + a.priority * 1000));
		const budget = this.kernel.computeSnapshot(runId);
		const signals = ready.map((task) => ({
			task,
			assessment: this.catalog.getCoordinationAssessment(task.id),
			contract: this.catalog.getCoordinationContract(task.id),
			verifiedRequirements: verified(task),
		}));

		const activeSignals = active.map((task) => ({
			task,
			assessment: this.catalog.getCoordinationAssessment(task.id),
			contract: this.catalog.getCoordinationContract(task.id),
			verifiedRequirements: verified(task),
		}));
		if (limit === 0) return this.persist(run, "SERIALIZE", [], "All compute slots are occupied", signals);
		if (policy.policy === "SINGLE")
			return this.persist(
				run,
				"SINGLE",
				active.length ? [] : ready.slice(0, 1),
				"Frozen strong single-writer baseline",
				signals,
			);
		if (policy.policy === "FIXED") {
			const tasks: TaskDefinition[] = [];
			for (const item of signals) {
				const selectedSignals = signals.filter((s) => tasks.some((t) => t.id === s.task.id));
				if (
					tasks.length < limit &&
					[...activeSignals, ...selectedSignals].every((other) => semanticallyIndependent(item, other))
				)
					tasks.push(item.task);
			}
			return this.persist(
				run,
				tasks.length > 1 ? "PARALLEL_TASKS" : "SINGLE",
				tasks,
				"Frozen fixed parallelism baseline; same ownership and verification gates",
				signals,
			);
		}
		const explorationEstimates: Array<Record<string, unknown>> = [];
		const exploration = signals.find((item) => {
			if (!item.assessment) return false;
			const explicitlyRequested = this.catalog.latestFailureDiagnosis(item.task.id)?.disposition === "DIVERSE_EXPLORE";
			if (item.assessment.uncertainty !== "HIGH" && !explicitlyRequested) return false;
			const pending = pendingExplorationQuestions(
				item.task,
				this.catalog.listExplorations(item.task.id, run.integrationHead),
				item.assessment.explorationQuestions,
				policy.maxExplorationAttempts,
			);
			if (!pending.length) return false;
			const local = history.find((entry) => entry.taskId === item.task.id);
			const risk = 1 - reliability(item.task.id).successProbability;
			const sessions = Math.min(pending.length, this.resources.policy.lanes.INTERACTIVE.limit);
			const avoidableFraction = explicitlyRequested ? 0.8 : 0.65;
			const avoidedRework = (local?.durationMs || duration) * risk * avoidableFraction;
			const estimatedExplore = (local?.explorationMs || duration * 0.2) * sessions;
			const exploreCost = (local?.explorationCostUsd || cost * 0.2) * sessions;
			const selected =
				policy.policy === "HEURISTIC" ||
				(avoidedRework > estimatedExplore &&
					(budget.remainingMs === null || budget.remainingMs > estimatedExplore + duration + checks) &&
					(policy.costLimitUsd === undefined ||
						policy.costLimitUsd - budget.costUsd - budget.reservedUsd > cost + auxiliaryCost + exploreCost));
			explorationEstimates.push({
				taskId: item.task.id,
				avoidedReworkMs: avoidedRework,
				estimatedExploreMs: estimatedExplore,
				exploreCostUsd: exploreCost,
				sessions,
				observedSessions: local?.explorationSamples ?? 0,
				avoidableFraction,
				selected,
			});
			return selected;
		});
		if (explorationEstimates.length)
			this.kernel.recordControlAction({
				runId,
				kind: "EXPLORATION_ESTIMATE",
				detail: {
					model: "bounded-value-of-information/v2",
					calibrated: false,
					budget,
					estimates: explorationEstimates,
				},
			});
		if (exploration && active.length === 0) {
			return this.persist(
				run,
				"DIVERSE_EXPLORATION",
				[exploration.task],
				"High task uncertainty has unresolved, non-duplicate hypotheses; investigate before spending a writer attempt.",
				signals,
			);
		}

		if (ready.length === 1 && active.length === 0) {
			return this.persist(
				run,
				"SINGLE",
				[ready[0] as TaskDefinition],
				"Only one dependency-ready task exists.",
				signals,
			);
		}

		const estimates = signals.map((item) => {
			const h = history.find((entry) => entry.taskId === item.task.id);
			const coupling =
				item.assessment?.semanticCoupling === "LOW" ||
				(item.assessment?.semanticCoupling === "MEDIUM" && item.verifiedRequirements)
					? 0.05
					: item.assessment?.semanticCoupling === "MEDIUM"
						? 0.3
						: 0.6;
			const success = reliability(item.task.id);
			const writerDuration = h?.durationMs || duration;
			const duplicateCost = writerDuration * (item.assessment?.decomposability === "HIGH" ? 0.05 : 0.2);
			const verificationCost = (h?.checksMs || checks) * (1 + this.resources.snapshot().activeByLane.HEAVY_CHECK);
			const auxiliaryMs = h?.auxiliaryMs || auxiliary;
			return {
				taskId: item.task.id,
				criticalPathMs: critical(item.task.id),
				estimatedCostUsd: (h?.costUsd || cost) + (h?.auxiliaryCostUsd || auxiliaryCost),
				estimatedDurationMs: writerDuration,
				...success,
				writerSamples: h?.writerSamples ?? 0,
				duplicateCostMs: duplicateCost,
				verificationCostMs: verificationCost,
				auxiliaryCostMs: auxiliaryMs,
				marginalUsefulMs:
					writerDuration * success.conservativeSuccessScore * (1 - coupling) -
					duplicateCost -
					verificationCost -
					auxiliaryMs,
			};
		});
		this.kernel.recordControlAction({
			runId,
			kind: "COMPUTE_ESTIMATE",
			detail: {
				model: "phase-aware-shrinkage-estimator/v2",
				calibrated: false,
				source: observed.length ? "runtime-history-with-priors" : "uncalibrated-priors",
				budget,
				estimates,
			},
		});
		const selected: TaskSignals[] = [];
		let selectedCost = 0;
		for (const candidate of signals) {
			if (selected.length >= limit) break;
			const estimate = estimates.find((entry) => entry.taskId === candidate.task.id);
			if (!estimate) continue;
			const affordable =
				policy.costLimitUsd === undefined ||
				estimate.estimatedCostUsd + selectedCost <= policy.costLimitUsd - budget.costUsd - budget.reservedUsd;
			const worthwhile = policy.policy === "HEURISTIC" || (estimate.marginalUsefulMs > 0 && affordable);
			if (
				worthwhile &&
				independentlyExecutable(candidate) &&
				[...activeSignals, ...selected].every((other) => semanticallyIndependent(candidate, other))
			) {
				selected.push(candidate);
				selectedCost += estimate.estimatedCostUsd;
			}
		}
		if (selected.length >= 2 || (selected.length === 1 && active.length > 0)) {
			return this.persist(
				run,
				"PARALLEL_TASKS",
				selected.map((item) => item.task),
				"Selected tasks are dependency-ready, path-disjoint, semantically uncoupled, and bounded in integration cost.",
				signals,
			);
		}

		return this.persist(
			run,
			"SERIALIZE",
			active.length ? [] : [ready[0] as TaskDefinition],
			"Ready tasks lack sufficient evidence of semantic independence or have sequential/integration risk; serialize conservatively.",
			signals,
		);
	}

	private persist(
		run: ReturnType<ControlCatalog["getRun"]>,
		mode: ExecutionMode,
		tasks: TaskDefinition[],
		rationale: string,
		signals: TaskSignals[],
	): ExecutionDecision {
		const snapshot = this.resources.snapshot();
		const id = this.kernel.recordCoordinationDecision({
			runId: run.id,
			expectedRunVersion: run.version,
			integrationHead: run.integrationHead,
			mode,
			taskIds: tasks.map((task) => task.id),
			policyInputs: {
				resourceBudget: snapshot,
				computeBudget: this.kernel.computeSnapshot(run.id),
				policy: executionPolicyFor(run.goalContract),
				tasks: signals.map((item) => ({
					taskId: item.task.id,
					scope: item.task.scope,
					assessment: item.assessment,
					contract: item.contract,
				})),
			},
			rationale,
			actor: { kind: "SYSTEM", id: "adaptive-coordination-policy" },
		});
		return { id, mode, tasks, rationale };
	}
}
