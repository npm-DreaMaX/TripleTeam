import { createHash, randomUUID } from "node:crypto";
import { executionPolicyFor, remainingPlanningBudget } from "../config/execution.ts";
import type { ProjectPaths } from "../config/paths.ts";
import type { ProjectConfig } from "../config/project.ts";
import type { ControlCatalog } from "../control/catalog.ts";
import { pendingExplorationQuestions } from "../control/exploration-policy.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { LocalResourceGovernor } from "../control/resource-governor.ts";
import { AttemptControlBridge } from "../runtime/pi/control-bridge.ts";
import {
	assertFrozenProfile,
	constrainProfileTools,
	type ManagedPiWorker,
	type PiWorkerLauncher,
} from "../runtime/pi/launcher.ts";
import type { LiveAttemptRegistry } from "../runtime/pi/live-attempts.ts";
import { runMetered } from "../runtime/pi/metered-run.ts";
import {
	explorationContextVersion,
	observationsUnchanged,
	type ReadObservation,
	ReadObservationCollector,
} from "../runtime/pi/read-observations.ts";
import type { GitWorkspaceManager, ManagedWorktree } from "../workspace/git.ts";

export interface ExplorationReport {
	attemptId: string;
	question: string;
	report: string;
}

function explorationPrompt(objective: string, question: string, hypothesis?: string, feedback?: string): string {
	return `You are a read-only repository explorer supporting an adaptive coding runtime. Investigate the requested question with repository tools. Do not edit files, run mutating commands, or claim task completion.

Overall objective:
${objective}

Investigation question:
${question}

Hypothesis to test (actively seek supporting and contradicting evidence):
${hypothesis ?? "No hypothesis supplied; identify the evidence needed to resolve the question."}

Prior authoritative evidence:
${feedback ?? "None supplied."}

Return a concise evidence-backed report. Cite paths and symbols, separate inspected facts from inference, and identify uncertainty.`;
}

export class PiExplorer {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly workspaces: GitWorkspaceManager,
		private readonly launcher: PiWorkerLauncher,
		private readonly resources: LocalResourceGovernor,
		private readonly paths: ProjectPaths,
		private readonly config: ProjectConfig,
		private readonly liveAttempts?: LiveAttemptRegistry,
	) {}

	async explore(input: {
		runId: string;
		plannerAttemptId?: string;
		taskId?: string;
		objective: string;
		question: string;
		hypothesis?: string;
		feedback?: string;
		purpose?: "REPLAN" | "EXPLORE";
		baseCommit: string;
		coordinationBaselineCommit?: string;
		repositoryRoot: string;
	}): Promise<ExplorationReport> {
		if ((input.plannerAttemptId === undefined) === (input.taskId === undefined)) {
			throw new Error("Exploration requires exactly one planner attempt or task recipient");
		}
		return this.resources.run("INTERACTIVE", async () => {
			const actor = { kind: "SYSTEM", id: "exploration-service" } as const;
			const allowedTools = ["read", "grep", "find", "ls"];
			const profile = constrainProfileTools(
				this.launcher.resolveProfile(
					input.repositoryRoot,
					input.purpose === "REPLAN" ? this.config.profiles.planner : this.config.profiles.explorer,
					allowedTools,
					executionPolicyFor(this.catalog.getRun(input.runId).goalContract),
					input.purpose === "REPLAN" ? "planner" : "explorer",
				),
				allowedTools,
			);
			assertFrozenProfile(
				this.catalog.getRun(input.runId).goalContract,
				input.purpose === "REPLAN" ? "PLAN" : "EXPLORE",
				profile,
			);
			const taskRevisionId = input.taskId ? this.catalog.getTask(input.taskId).revisionId : null;
			const goal = this.catalog.getRun(input.runId).goalContract as { verificationPolicyVersion?: number };
			const contextVersion =
				goal.verificationPolicyVersion === 1 && executionPolicyFor(goal).enableEvidenceReuse
					? await explorationContextVersion(this.paths.worktrees)
					: null;
			const reuse = contextVersion !== null;
			const queryHash = createHash("sha256")
				.update(
					JSON.stringify({
						objective: input.objective,
						question: input.question,
						hypothesis: input.hypothesis,
						feedback: input.feedback,
						purpose: input.purpose,
						taskRevisionId,
						profileVersion: profile.version,
						contextVersion,
					}),
				)
				.digest("hex");
			if (reuse) {
				for (const action of this.catalog
					.listControlActions(input.runId)
					.filter((a) => a.kind === "EXPLORATION_OBSERVATION")
					.reverse()) {
					const stored = JSON.parse(action.detail_json) as {
						queryHash: string;
						attemptId: string;
						baselineCommit: string;
						report: string;
						observations: ReadObservation[];
					};
					if (stored.queryHash !== queryHash || this.catalog.getAttempt(stored.attemptId).state !== "SUBMITTED")
						continue;
					if (!(await observationsUnchanged(this.workspaces, input.baseCommit, stored.observations))) continue;
					this.kernel.recordControlAction({
						runId: input.runId,
						taskId: input.taskId,
						kind: "EXPLORATION_REUSED",
						detail: {
							sourceActionId: action.id,
							sourceAttemptId: stored.attemptId,
							inspectedCommit: stored.baselineCommit,
							revalidatedCommit: input.baseCommit,
							queryHash,
							observations: stored.observations,
						},
					});
					return {
						attemptId: stored.attemptId,
						question: input.question,
						report: `Revalidated repository observation from ${stored.baselineCommit}; read dependencies unchanged on ${input.baseCommit}. This report is an observation, not acceptance evidence.\n${stored.report}`,
					};
				}
			}
			const attemptId = randomUUID();
			this.kernel.startAuxiliaryAttempt({
				id: attemptId,
				runId: input.runId,
				workflowFunction: "EXPLORE",
				taskId: input.taskId,
				baseCommit: input.baseCommit,
				profileName: profile.name,
				profileVersion: profile.version,
				actor,
			});
			let worktree: ManagedWorktree | undefined;
			let managed: ManagedPiWorker | undefined;
			let bridge: AttemptControlBridge | undefined;
			let executionId: string | undefined;
			let unregister: (() => void) | undefined;
			let stopObserving: (() => void) | undefined;
			try {
				worktree = await this.workspaces.createWorktree(attemptId, input.baseCommit);
				const prompt = explorationPrompt(input.objective, input.question, input.hypothesis, input.feedback);
				const sessionId = "explore-" + attemptId;
				executionId = this.kernel.createExecution({
					attemptId,
					piSessionId: sessionId,
					contextManifestHash: createHash("sha256").update(prompt).digest("hex"),
					actor,
				});
				bridge = new AttemptControlBridge(
					this.kernel,
					this.catalog,
					{
						runId: input.runId,
						attemptId,
						taskId: input.taskId,
					},
					this.liveAttempts,
				);
				const control = await bridge.start();
				managed = await this.launcher.create(
					{
						cwd: worktree.path,
						sessionDirectory: this.paths.sessions,
						sessionId,
						sessionName: "Explore " + input.question.slice(0, 80),
						profileName: profile.name,
						defaultTools: profile.tools,
						control,
					},
					profile,
				);
				const state = await managed.worker.start();
				const observations = new ReadObservationCollector(worktree.path);
				stopObserving = managed.worker.onEvent?.(observations.onEvent);
				this.kernel.markExecutionLive({ executionId, sessionFile: state.sessionFile, actor });
				unregister = this.liveAttempts?.register(attemptId, null, managed.worker);
				const response = await runMetered(managed.worker, {
					kernel: this.kernel,
					catalog: this.catalog,
					runId: input.runId,
					taskId: input.taskId,
					attemptId,
					executionId,
					phase: input.purpose === "REPLAN" ? "REPLAN" : input.taskId ? "DIVERSE_EXPLORATION" : "PLAN_EXPLORATION",
					phaseBudget: input.plannerAttemptId
						? remainingPlanningBudget(
								executionPolicyFor(this.catalog.getRun(input.runId).goalContract),
								this.catalog.planningUsage(input.runId),
							)
						: undefined,
					prompt,
					timeoutMs: this.config.workerTimeoutMs,
				});
				const report = (response.lastAssistantText ?? "").trim();
				if (!report) throw new Error("Explorer returned an empty report");
				this.kernel.sendMessage({
					runId: input.runId,
					taskId: input.taskId,
					recipientKind: input.taskId ? "TASK" : "ATTEMPT",
					recipientId: input.taskId ?? (input.plannerAttemptId as string),
					kind: "HANDOFF",
					body: JSON.stringify({
						purpose: input.purpose ?? "EXPLORE",
						baselineCommit: input.coordinationBaselineCommit ?? input.baseCommit,
						inspectedCommit: input.baseCommit,
						taskRevisionId,
						report: report.slice(0, 5_000),
					}),
					references: [{ kind: "ATTEMPT", id: attemptId }],
					actor: { kind: "ATTEMPT", id: attemptId },
				});
				this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor });
				this.kernel.completeAuxiliaryAttempt(attemptId, actor);
				const dependencies = reuse ? await observations.freeze(this.workspaces, input.baseCommit) : null;
				if (dependencies)
					this.kernel.recordControlAction({
						runId: input.runId,
						taskId: input.taskId,
						kind: "EXPLORATION_OBSERVATION",
						detail: {
							queryHash,
							attemptId,
							baselineCommit: input.baseCommit,
							report: report.slice(0, 16_000),
							observations: dependencies,
						},
					});
				return { attemptId, question: input.question, report };
			} catch (error) {
				if (executionId) {
					try {
						this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor });
					} catch {
						// Preserve the primary exploration failure.
					}
				}
				try {
					this.kernel.failAttempt({
						attemptId,
						reason: error instanceof Error ? error.message : String(error),
						retryTask: false,
						actor,
					});
				} catch {
					// The attempt may already be durably terminal.
				}
				throw error;
			} finally {
				stopObserving?.();
				unregister?.();
				await managed?.close();
				await bridge?.stop();
				if (worktree) await this.workspaces.removeWorktree(worktree);
			}
		});
	}
}

export class AdaptiveExplorationCoordinator {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly explorer: PiExplorer,
		private readonly config: ProjectConfig,
	) {}

	async explore(taskId: string): Promise<void> {
		const task = this.catalog.getTask(taskId);
		const run = this.catalog.getRun(task.runId);
		const assessment = this.catalog.getCoordinationAssessment(taskId);
		if (!assessment) throw new Error("Task has no coordination assessment: " + taskId);
		const questions = pendingExplorationQuestions(
			task,
			this.catalog.listExplorations(taskId, run.integrationHead),
			assessment.explorationQuestions,
			this.config.maxExplorationAttempts ?? 2,
		).slice(0, this.config.maxDiverseExplorations ?? 2);
		if (questions.length === 0) return;
		await Promise.all(
			questions.map(async (question) => {
				const explorationId = this.kernel.beginExploration({
					taskId,
					baselineCommit: run.integrationHead,
					investigationKey: question.key,
					hypothesis: question.hypothesis,
					question: question.question,
					maxExecutions: this.config.maxExplorationAttempts ?? 2,
					actor: { kind: "SYSTEM", id: "adaptive-exploration-coordinator" },
				});
				try {
					const report = await this.explorer.explore({
						runId: run.id,
						taskId,
						objective: task.objective,
						question: question.question,
						hypothesis: question.hypothesis,
						baseCommit: run.integrationHead,
						repositoryRoot: run.repositoryRoot,
					});
					this.kernel.finishExploration({
						explorationId,
						attemptId: report.attemptId,
						state: "COMPLETED",
						report: report.report,
						actor: { kind: "SYSTEM", id: "adaptive-exploration-coordinator" },
					});
				} catch (error) {
					this.kernel.finishExploration({
						explorationId,
						state: "FAILED",
						report: error instanceof Error ? error.message : String(error),
						actor: { kind: "SYSTEM", id: "adaptive-exploration-coordinator" },
					});
				}
			}),
		);
	}
}
