import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type ExecutionPolicy, parseExecutionPolicy } from "../config/execution.ts";
import { type ProjectPaths, projectPaths } from "../config/paths.ts";
import { loadProjectConfig, type ProjectConfig, parseProjectConfig } from "../config/project.ts";
import { ControlCatalog } from "../control/catalog.ts";
import { AdaptiveCoordinationPolicy } from "../control/coordination-policy.ts";
import { ControlKernel } from "../control/kernel.ts";
import { OperationJournal } from "../control/operation-journal.ts";
import { Reconciler, type ReconciliationReport } from "../control/reconciler.ts";
import { LocalResourceGovernor } from "../control/resource-governor.ts";
import { RunScheduler, type SchedulerResult } from "../control/scheduler.ts";
import { TaskExecutor } from "../control/task-executor.ts";
import { BoundedTaskProposalPolicy } from "../control/task-proposal-policy.ts";
import { type DeliveryReport, DeliveryReporter } from "../delivery/reporter.ts";
import { AdaptiveExplorationCoordinator, PiExplorer } from "../exploration/explorer.ts";
import { PiPlanner } from "../planning/plan.ts";
import { PiReviewer } from "../review/reviewer.ts";
import { freezePiProfiles, PiWorkerLauncher } from "../runtime/pi/launcher.ts";
import { LiveAttemptRegistry } from "../runtime/pi/live-attempts.ts";
import { PersistentSessionGuard } from "../runtime/pi/upstream.ts";
import { type ControlDatabase, openControlDatabase } from "../store/database.ts";
import { AssuranceService } from "../verification/assurance-service.ts";
import { BaselineVerifier } from "../verification/baseline.ts";
import { CheckRunner } from "../verification/check-runner.ts";
import { RunVerifier } from "../verification/run-verifier.ts";
import { GitWorkspaceManager, type RepositorySnapshot, resolveRepositoryRoot } from "../workspace/git.ts";

export interface InitializedRun {
	runId: string;
	repositoryRoot: string;
	stateDirectory: string;
	inputCommit: string;
	inputTree: string;
	capturedDirtyState: boolean;
	integrationRef: string;
}

export interface RunResult extends InitializedRun {
	state: SchedulerResult["state"];
	integrationHead: string;
	delivery: DeliveryReport;
}

export interface InitializeOptions {
	inputCommit?: string;
	/** Per-campaign limits may only tighten the repository policy. */
	budget?: Pick<ExecutionPolicy, "costLimitUsd" | "tokenLimit" | "deadlineMs"> & { maxExecutions?: number };
}

export class LocalOrchestrator {
	readonly repositoryRoot: string;
	readonly paths: ProjectPaths;
	readonly config: ProjectConfig;
	readonly database: ControlDatabase;
	readonly kernel: ControlKernel;
	readonly catalog: ControlCatalog;
	readonly resources: LocalResourceGovernor;
	readonly workspaces: GitWorkspaceManager;

	private readonly planner: PiPlanner;
	private readonly executor: TaskExecutor;
	private readonly scheduler: RunScheduler;
	private readonly reconciler: Reconciler;
	private readonly reporter: DeliveryReporter;
	private readonly liveAttempts: LiveAttemptRegistry;
	private readonly controlGuard: PersistentSessionGuard;
	private executing = false;

	private constructor(input: {
		repositoryRoot: string;
		paths: ProjectPaths;
		config: ProjectConfig;
		database: ControlDatabase;
		kernel: ControlKernel;
		catalog: ControlCatalog;
		resources: LocalResourceGovernor;
		workspaces: GitWorkspaceManager;
		planner: PiPlanner;
		executor: TaskExecutor;
		scheduler: RunScheduler;
		reconciler: Reconciler;
		reporter: DeliveryReporter;
		liveAttempts: LiveAttemptRegistry;
		controlGuard: PersistentSessionGuard;
	}) {
		this.repositoryRoot = input.repositoryRoot;
		this.paths = input.paths;
		this.config = input.config;
		this.database = input.database;
		this.kernel = input.kernel;
		this.catalog = input.catalog;
		this.resources = input.resources;
		this.workspaces = input.workspaces;
		this.planner = input.planner;
		this.executor = input.executor;
		this.scheduler = input.scheduler;
		this.reconciler = input.reconciler;
		this.reporter = input.reporter;
		this.liveAttempts = input.liveAttempts;
		this.controlGuard = input.controlGuard;
	}

	static async open(repositoryPath: string): Promise<LocalOrchestrator> {
		const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryPath));
		const paths = projectPaths(repositoryRoot);
		const controlGuard = PersistentSessionGuard.acquire(
			{
				sessionId: "control-plane",
				lockRoot: resolve(paths.root, "locks"),
				agent: "local-control-plane",
				cwd: repositoryRoot,
			},
			{ recoverDeadOwner: true },
		);
		let database: ControlDatabase | undefined;
		try {
			const config = await loadProjectConfig(repositoryRoot);
			database = await openControlDatabase(paths.database);
			const kernel = new ControlKernel(database);
			const catalog = new ControlCatalog(database);
			const journal = new OperationJournal(database);
			const resources = new LocalResourceGovernor();
			const workspaces = await GitWorkspaceManager.open(repositoryRoot, paths.worktrees);
			const launcher = new PiWorkerLauncher();
			const liveAttempts = new LiveAttemptRegistry();
			const checks = new CheckRunner(resources);
			const assurance = new AssuranceService({
				kernel,
				catalog,
				workspaces,
				launcher,
				checks,
				resources,
				paths,
				config,
				liveAttempts,
			});
			const finalVerifier = new RunVerifier(kernel, catalog, workspaces, checks, paths, config, assurance);
			const reviewer = new PiReviewer(kernel, catalog, workspaces, launcher, resources, paths, config, liveAttempts);
			const explorer = new PiExplorer(kernel, catalog, workspaces, launcher, resources, paths, config, liveAttempts);
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
				liveAttempts,
			);
			const planner = new PiPlanner(
				kernel,
				catalog,
				workspaces,
				launcher,
				explorer,
				resources,
				paths,
				config,
				liveAttempts,
			);
			const proposalPolicy = new BoundedTaskProposalPolicy(kernel, catalog, config);
			const coordinationPolicy = new AdaptiveCoordinationPolicy(kernel, catalog, resources);
			const explorationCoordinator = new AdaptiveExplorationCoordinator(kernel, catalog, explorer, config);
			const scheduler = new RunScheduler(
				kernel,
				catalog,
				executor,
				finalVerifier,
				resources,
				proposalPolicy,
				coordinationPolicy,
				explorationCoordinator,
			);
			const reconciler = new Reconciler(database, kernel, catalog, journal, workspaces, config);
			const reporter = new DeliveryReporter(kernel, catalog, workspaces, paths);
			return new LocalOrchestrator({
				repositoryRoot,
				paths,
				config,
				database,
				kernel,
				catalog,
				resources,
				workspaces,
				planner,
				executor,
				scheduler,
				reconciler,
				reporter,
				liveAttempts,
				controlGuard,
			});
		} catch (error) {
			database?.close();
			controlGuard.release();
			throw error;
		}
	}

	async initialize(objective = "", options: InitializeOptions = {}): Promise<InitializedRun> {
		const configuration = await loadProjectConfig(this.repositoryRoot);
		const executionPolicy = parseExecutionPolicy(configuration.execution);
		for (const key of ["costLimitUsd", "tokenLimit", "deadlineMs", "maxExecutions"] as const) {
			const requested = options.budget?.[key];
			if (requested !== undefined) executionPolicy[key] = Math.min(executionPolicy[key] ?? requested, requested);
		}
		parseExecutionPolicy(executionPolicy);
		const piProfiles = freezePiProfiles(
			new PiWorkerLauncher(),
			this.repositoryRoot,
			configuration.profiles,
			executionPolicy,
		);
		const runId = randomUUID();
		const snapshot = options.inputCommit
			? {
					commitHash: await this.workspaces.resolveRef(options.inputCommit + "^{commit}"),
					treeHash: await this.workspaces.treeHash(options.inputCommit),
					ref: "",
					dirty: false,
				}
			: await this.workspaces.snapshot(runId);
		const integrationRef = await this.workspaces.initializeIntegrationRef(runId, snapshot.commitHash);
		this.kernel.createRun({
			id: runId,
			repositoryRoot: this.repositoryRoot,
			objective,
			inputCommit: snapshot.commitHash,
			inputTreeHash: snapshot.treeHash,
			integrationRef,
			goalContract: {
				schema: "goal-contract/v3",
				verificationPolicyVersion: 1,
				baselinePolicy: configuration.baseline,
				assurancePolicy: configuration.assurance ?? { mode: "off" },
				executionPolicy,
				runtimeConfiguration: configuration,
				runtimeConfigurationHash: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
				piProfiles,
				authorizedScope: ["."],
				objective,
				inputCommit: snapshot.commitHash,
				runChecks: configuration.runChecks,
				taskAcceptancePolicy: {
					candidateChecks: configuration.candidateChecks,
					integrationChecks: configuration.integrationChecks,
					reviewRequiredFor: configuration.reviewRequiredFor,
				},
				coordinationPolicy: {
					modes: ["SINGLE", "PARALLEL_TASKS", "SERIALIZE", "DIVERSE_EXPLORATION"],
					maxDiverseExplorations: configuration.maxDiverseExplorations ?? 2,
					maxRepeatedFailureFingerprints: configuration.maxRepeatedFailureFingerprints ?? 2,
					parallelismRequiresExplicitSemanticIndependence: true,
				},
				completionInvariants: [
					"all-tasks-accepted-or-cancelled",
					"no-live-attempts-or-executions",
					"fresh-checks-on-exact-final-tree",
					"kernel-derives-required-evidence-from-frozen-contract",
				],
			},
			actor: { kind: "USER", id: "local-user" },
		});
		return this.initializedRun(runId, snapshot, integrationRef);
	}

	async run(objective: string, options: InitializeOptions = {}): Promise<RunResult> {
		return this.withExecution(async () => {
			if (!objective.trim()) throw new Error("A non-empty coding objective is required");
			const initialized = await this.initialize(objective, options);
			await this.restoreRunConfiguration(initialized.runId);
			await this.planOrBlock({
				runId: initialized.runId,
				objective,
				inputCommit: initialized.inputCommit,
				repositoryRoot: initialized.repositoryRoot,
			});
			const result = await this.scheduler.runUntilSettled(initialized.runId);
			const delivery = await this.reporter.ensure(initialized.runId);
			return { ...initialized, state: result.state, integrationHead: result.integrationHead, delivery };
		});
	}

	async continue(
		runId?: string,
	): Promise<{ result: SchedulerResult; reconciliation: ReconciliationReport; delivery: DeliveryReport }> {
		return this.withExecution(() => this.continueRun(runId));
	}

	private async continueRun(
		runId?: string,
	): Promise<{ result: SchedulerResult; reconciliation: ReconciliationReport; delivery: DeliveryReport }> {
		const run = runId ? this.catalog.getRun(runId) : this.catalog.latestRun();
		if (!run) throw new Error("No run exists for this repository");
		if (run.state === "COMPLETED" || run.state === "CANCELLED") {
			throw new Error(`Run ${run.id} is terminal (${run.state}) and cannot be continued`);
		}
		await this.restoreRunConfiguration(run.id);
		if (run.state === "BLOCKED") {
			const blockedTasks = this.catalog.listTasks(run.id, ["BLOCKED"]);
			const pendingProposals = this.catalog.listTaskChangeProposals(run.id, ["PROPOSED"]);
			const pendingDecisions = this.catalog.listOpenDecisionRequests(run.id);
			if (blockedTasks.length > 0 || pendingProposals.length > 0 || pendingDecisions.length > 0) {
				throw new Error(
					`Run is blocked; resolve proposals or retry blocked tasks first (tasks: ${
						blockedTasks.map((task) => task.id).join(", ") || "none"
					}; proposals: ${pendingProposals.map((proposal) => proposal.id).join(", ") || "none"}; decisions: ${
						pendingDecisions.map((decision) => decision.id).join(", ") || "none"
					})`,
				);
			}
			this.kernel.resumeRun(run.id, { kind: "USER", id: "local-user" });
		}
		this.kernel.bindIntegrationTree(run.id, run.integrationHead, await this.workspaces.treeHash(run.integrationHead));
		const reconciliation = await this.reconciler.reconcile(run.id);
		await Promise.all(reconciliation.resumableAttemptIds.map((attemptId) => this.executor.resume(attemptId)));
		const currentTasks = this.catalog.listTasks(run.id);
		if (currentTasks.length === 0) {
			if (!run.objective.trim()) throw new Error("Run has no objective to reconstruct its task graph");
			await this.planOrBlock({
				runId: run.id,
				objective: run.objective,
				inputCommit: run.inputCommit,
				repositoryRoot: run.repositoryRoot,
			});
		}
		const result = await this.scheduler.runUntilSettled(run.id);
		const delivery = await this.reporter.ensure(run.id);
		return { result, reconciliation, delivery };
	}

	async retry(taskId: string): Promise<{ result: SchedulerResult; reconciliation: ReconciliationReport }> {
		this.assertIdle();
		const task = this.catalog.getTask(taskId);
		const run = this.catalog.getRun(task.runId);
		this.kernel.retryBlockedTask(taskId, { kind: "USER", id: "local-user" });
		if (run.state === "BLOCKED") this.kernel.resumeRun(run.id, { kind: "USER", id: "local-user" });
		return this.continue(run.id);
	}

	listProfiles(): ReturnType<PiWorkerLauncher["listProfiles"]> {
		return new PiWorkerLauncher().listProfiles(this.repositoryRoot);
	}

	acceptTaskProposal(proposalId: string): Map<string, string> {
		return this.kernel.atomic(() => {
			const proposal = this.catalog.getTaskChangeProposal(proposalId);
			const sourceTaskId = this.proposalSourceTaskId(proposal.sourceActorKind, proposal.sourceActorId);
			const added = this.kernel.acceptTaskChanges(proposalId, { kind: "USER", id: "local-user" });
			const request = this.catalog
				.listOpenDecisionRequests(proposal.runId)
				.find((candidate) => candidate.sourceKind === "TASK_CHANGE_PROPOSAL" && candidate.sourceId === proposalId);
			if (request) {
				this.kernel.resolveDecisionRequest({
					requestId: request.id,
					selectedOption: "ACCEPT_PROPOSAL",
					rationale: "User explicitly accepted the linked task-graph proposal",
					actor: { kind: "USER", id: "local-user" },
				});
			}
			this.releaseProposalBlock(proposal.runId, sourceTaskId, `Proposal ${proposalId} was accepted`);
			return added;
		});
	}

	rejectTaskProposal(proposalId: string, reason: string): void {
		this.kernel.atomic(() => {
			const proposal = this.catalog.getTaskChangeProposal(proposalId);
			const sourceTaskId = this.proposalSourceTaskId(proposal.sourceActorKind, proposal.sourceActorId);
			this.kernel.rejectTaskChanges(proposalId, reason, { kind: "USER", id: "local-user" });
			const request = this.catalog
				.listOpenDecisionRequests(proposal.runId)
				.find((candidate) => candidate.sourceKind === "TASK_CHANGE_PROPOSAL" && candidate.sourceId === proposalId);
			if (request) {
				this.kernel.resolveDecisionRequest({
					requestId: request.id,
					selectedOption: "REJECT_PROPOSAL",
					rationale: reason,
					actor: { kind: "USER", id: "local-user" },
				});
			}
			this.releaseProposalBlock(proposal.runId, sourceTaskId, `Proposal ${proposalId} was rejected`);
		});
	}

	resolveDecision(
		requestId: string,
		selectedOption: string,
		rationale: string,
	): { runId: string; selectedOption: string; mayContinue: boolean } {
		if (!rationale.trim()) throw new Error("A decision rationale is required");
		return this.kernel.atomic(() => {
			const request = this.catalog.getDecisionRequest(requestId);
			if (request.state !== "OPEN") throw new Error("Decision request is not open: " + requestId);
			if (request.sourceKind === "TASK_CHANGE_PROPOSAL" && request.sourceId) {
				if (selectedOption === "ACCEPT_PROPOSAL") this.acceptTaskProposal(request.sourceId);
				else if (selectedOption === "REJECT_PROPOSAL") this.rejectTaskProposal(request.sourceId, rationale);
				else throw new Error("Unsupported proposal decision option: " + selectedOption);
				return { runId: request.runId, selectedOption, mayContinue: true };
			}
			this.kernel.resolveDecisionRequest({
				requestId,
				selectedOption,
				rationale,
				actor: { kind: "USER", id: "local-user" },
			});
			const mayContinue = selectedOption !== "KEEP_BLOCKED";
			if (mayContinue && request.taskId) {
				this.kernel.sendMessage({
					runId: request.runId,
					taskId: request.taskId,
					recipientKind: "TASK",
					recipientId: request.taskId,
					kind: "ANSWER",
					body: JSON.stringify({ requestId, question: request.question, selectedOption, rationale }),
					references: [{ kind: "TASK", id: request.taskId }],
					actor: { kind: "USER", id: "local-user" },
				});
				if (
					this.catalog.getTask(request.taskId).state === "BLOCKED" &&
					!this.catalog.listOpenDecisionRequests(request.runId).some((open) => open.taskId === request.taskId)
				) {
					this.kernel.releaseBlockedTask(request.taskId, `Decision ${requestId} supplied user direction`, {
						kind: "USER",
						id: "local-user",
					});
				}
			}
			if (
				mayContinue &&
				this.catalog.getRun(request.runId).state === "BLOCKED" &&
				this.catalog.listOpenDecisionRequests(request.runId).length === 0
			) {
				this.kernel.resumeRun(request.runId, { kind: "USER", id: "local-user" });
			}
			return { runId: request.runId, selectedOption, mayContinue };
		});
	}

	async result(runId?: string): Promise<DeliveryReport> {
		const run = runId ? this.catalog.getRun(runId) : this.catalog.latestRun();
		if (!run) throw new Error("No run exists for this repository");
		return this.reporter.ensure(run.id);
	}

	async cancel(
		runId: string,
		reason: string,
	): Promise<{ runId: string; state: "CANCELLED"; fencedAttemptIds: string[] }> {
		this.catalog.getRun(runId);
		const attempts = this.kernel.cancelRun(runId, reason, { kind: "USER", id: "local-user" });
		await Promise.allSettled(attempts.map((attemptId) => this.liveAttempts.abort(attemptId)));
		return { runId, state: "CANCELLED", fencedAttemptIds: attempts };
	}

	async sendUserMessage(
		attemptId: string,
		body: string,
		kind: "QUESTION" | "ANSWER" | "OBSERVATION" | "HELP_REQUEST" | "PROPOSAL" | "HANDOFF" = "OBSERVATION",
	): Promise<{ messageId: string; deliveredLive: boolean; deliveryError?: string }> {
		const attempt = this.catalog.getAttempt(attemptId);
		const messageId = this.kernel.sendMessage({
			runId: attempt.runId,
			taskId: attempt.taskId ?? undefined,
			recipientKind: "ATTEMPT",
			recipientId: attempt.id,
			kind,
			body,
			actor: { kind: "USER", id: "local-user" },
		});
		try {
			const deliveredLive = await this.liveAttempts.deliver({
				messageId,
				senderKind: "USER",
				senderId: "local-user",
				recipientKind: "ATTEMPT",
				recipientId: attempt.id,
				kind,
				body,
			});
			return { messageId, deliveredLive };
		} catch (error) {
			return {
				messageId,
				deliveredLive: false,
				deliveryError: error instanceof Error ? error.message : String(error),
			};
		}
	}

	close(): void {
		try {
			this.database.close();
		} finally {
			this.controlGuard.release();
		}
	}

	private assertIdle(): void {
		if (this.executing) throw new Error("A run is already executing in this workspace; wait or cancel it first");
	}

	private async withExecution<T>(work: () => Promise<T>): Promise<T> {
		this.assertIdle();
		this.executing = true;
		try {
			return await work();
		} finally {
			this.executing = false;
		}
	}

	private async restoreRunConfiguration(runId: string): Promise<void> {
		const goal = this.catalog.getRun(runId).goalContract as {
			runtimeConfiguration?: unknown;
			runtimeConfigurationHash?: string;
		};
		const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		let selected: ProjectConfig;
		if (goal.runtimeConfiguration !== undefined) {
			if (!goal.runtimeConfigurationHash || hash(goal.runtimeConfiguration) !== goal.runtimeConfigurationHash)
				throw new Error("Frozen runtime configuration does not match its recorded hash");
			selected = parseProjectConfig(goal.runtimeConfiguration, []);
		} else {
			selected = await loadProjectConfig(this.repositoryRoot);
			if (goal.runtimeConfigurationHash && hash(selected) !== goal.runtimeConfigurationHash)
				throw new Error(
					"This legacy run stores only a configuration hash; restore its original configuration before continuing",
				);
		}
		// Services hold this shared configuration object. Change it only before exclusive run execution.
		Object.assign(this.config, selected);
	}

	private async planOrBlock(input: Parameters<PiPlanner["plan"]>[0]): Promise<void> {
		let phase: "BASELINE" | "PLANNING" = "BASELINE";
		try {
			await new BaselineVerifier(
				this.kernel,
				this.catalog,
				this.workspaces,
				new CheckRunner(this.resources),
				this.paths,
				this.config,
			).verify(input.runId);
			phase = "PLANNING";
			await this.planner.plan(input);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.kernel.recordControlAction({
				runId: input.runId,
				kind: `${phase}_FAILURE`,
				state: "FAILED",
				detail: { reason },
			});
			if (this.catalog.getRun(input.runId).state === "OPEN")
				this.kernel.blockRun(
					input.runId,
					`${phase === "BASELINE" ? "Baseline environment check failed" : "Planning could not produce an executable graph"}: ${reason}`,
					{
						kind: "SYSTEM",
						id: "planner-boundary",
					},
				);
		}
	}

	private initializedRun(runId: string, snapshot: RepositorySnapshot, integrationRef: string): InitializedRun {
		return {
			runId,
			repositoryRoot: this.repositoryRoot,
			stateDirectory: this.paths.root,
			inputCommit: snapshot.commitHash,
			inputTree: snapshot.treeHash,
			capturedDirtyState: snapshot.dirty,
			integrationRef,
		};
	}

	private proposalSourceTaskId(kind: string, sourceId: string): string | null {
		if (kind !== "ATTEMPT") return null;
		return this.catalog.getAttempt(sourceId).taskId;
	}

	private releaseProposalBlock(runId: string, taskId: string | null, reason: string): void {
		if (taskId && this.catalog.getTask(taskId).state === "BLOCKED") {
			this.kernel.releaseBlockedTask(taskId, reason, { kind: "USER", id: "local-user" });
		}
		if (this.catalog.getRun(runId).state === "BLOCKED") {
			this.kernel.resumeRun(runId, { kind: "USER", id: "local-user" });
		}
	}
}
