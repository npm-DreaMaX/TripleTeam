import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executionPolicyFor, writerAttemptLimit } from "../config/execution.ts";
import type { ProjectPaths } from "../config/paths.ts";
import {
	acceptancePolicyForRun,
	type CheckCommand,
	checkCommandVersion,
	evidenceClassForCheck,
	type ProjectConfig,
	parseCheckCommand,
} from "../config/project.ts";
import { PiExplorer } from "../exploration/explorer.ts";
import type { PiReviewer } from "../review/reviewer.ts";
import { AttemptControlBridge, type TaskProposalDefaults } from "../runtime/pi/control-bridge.ts";
import { assertFrozenProfile, type PiWorkerLauncher } from "../runtime/pi/launcher.ts";
import type { LiveAttemptRegistry } from "../runtime/pi/live-attempts.ts";
import { runMetered } from "../runtime/pi/metered-run.ts";
import type { CheckRunner } from "../verification/check-runner.ts";
import type { GitWorkspaceManager, ManagedWorktree, SealedCandidate } from "../workspace/git.ts";
import type { ControlCatalog, TaskDefinition } from "./catalog.ts";
import { ContractVerifier } from "./contract-verifier.ts";
import { currentExplorationMessages } from "./exploration-policy.ts";
import { type FailureDiagnosis, FailurePolicy } from "./failure-policy.ts";
import type { ControlKernel } from "./kernel.ts";
import type { OperationJournal } from "./operation-journal.ts";
import type { LocalResourceGovernor } from "./resource-governor.ts";
import { candidateScopeViolations } from "./scope.ts";

interface AcceptanceContract {
	candidateChecks: CheckCommand[];
	integrationChecks: CheckCommand[];
	requireReview: boolean;
}

type VerificationOutcome = "PASSED" | "FAILED" | "ERROR";

export function verificationDisposition(
	status: Exclude<VerificationOutcome, "PASSED">,
	retryAllowed: boolean,
): { retryTask: boolean; outcome: Exclude<TaskExecutionOutcome, "ACCEPTED"> } {
	if (status === "ERROR") return { retryTask: false, outcome: "BLOCKED" };
	return { retryTask: retryAllowed, outcome: retryAllowed ? "RETRY" : "BLOCKED" };
}

export type TaskExecutionOutcome = "ACCEPTED" | "RETRY" | "BLOCKED";

export class ReconciliationRequiredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReconciliationRequiredError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheck(value: unknown, label: string): CheckCommand {
	return parseCheckCommand(value, label);
}

function parseContract(value: unknown): AcceptanceContract {
	if (!isRecord(value) || !Array.isArray(value.candidateChecks) || !Array.isArray(value.integrationChecks)) {
		throw new Error("Task acceptance contract is invalid");
	}
	if (value.candidateChecks.length === 0 || value.integrationChecks.length === 0) {
		throw new Error("Task acceptance contract requires candidate and integration checks");
	}
	if (typeof value.requireReview !== "boolean") throw new Error("Task acceptance review gate is invalid");
	return {
		candidateChecks: value.candidateChecks.map((item, index) => parseCheck(item, `candidateChecks[${index}]`)),
		integrationChecks: value.integrationChecks.map((item, index) => parseCheck(item, `integrationChecks[${index}]`)),
		requireReview: value.requireReview,
	};
}

function writerPrompt(task: TaskDefinition, feedback: string): string {
	return `You are the implementation worker for one authoritative task. Work only inside the provided isolated Git worktree. Implement the task completely, inspect existing conventions, and run focused checks when useful. Do not modify files outside this worktree. Do not manipulate orchestrator refs or state. Your natural-language claim of completion is not authoritative; the control plane will seal and verify the resulting tree.

Task: ${task.title}
Objective: ${task.objective}
Authoritative repository-relative ownership scope: ${JSON.stringify(task.scope)}
Constraints: ${JSON.stringify(task.constraints)}
Acceptance contract: ${JSON.stringify(task.acceptanceContract)}

${feedback}

The coordination contract in the authoritative feedback is binding. Treat provides/requires/assumptions/interfaces as checkable commitments, not chat. Re-read orchestrator_context before relying on a peer handoff; stale messages do not update the contract.

Use orchestrator_context when peer/task state matters. Use orchestrator_send_message for scoped questions, observations, handoffs, or HELP_REQUEST; a message never changes task truth. If a newly discovered prerequisite makes the authoritative task graph wrong, submit a bounded proposal with orchestrator_propose_task_changes and make this task depend on every added prerequisite. The control plane supplies acceptance policy. Submitting a graph proposal intentionally ends this implementation attempt so the graph can be decided before work resumes.

Changes outside the authoritative scope will be rejected before Candidate submission. If the task genuinely requires a wider scope, submit a task-change proposal instead of silently editing outside ownership.

Make the required repository changes. When finished, summarize what changed and any important verification observations.`;
}

function scopeFailure(task: TaskDefinition, candidate: SealedCandidate): string | null {
	const violations = candidateScopeViolations(candidate.changedPaths, task.scope);
	return violations.length === 0
		? null
		: `Candidate changed paths outside authoritative task scope: ${violations.slice(0, 20).join(", ")}`;
}

export class TaskExecutor {
	private readonly failurePolicy: FailurePolicy;

	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly journal: OperationJournal,
		private readonly workspaces: GitWorkspaceManager,
		private readonly launcher: PiWorkerLauncher,
		private readonly reviewer: PiReviewer,
		private readonly checks: CheckRunner,
		private readonly resources: LocalResourceGovernor,
		private readonly paths: ProjectPaths,
		private readonly config: ProjectConfig,
		private readonly liveAttempts?: LiveAttemptRegistry,
	) {
		this.failurePolicy = new FailurePolicy(kernel, catalog, config);
	}

	async execute(taskId: string): Promise<TaskExecutionOutcome> {
		const actor = { kind: "SYSTEM", id: "task-executor" } as const;
		const task = this.catalog.getTask(taskId);
		const run = this.catalog.getRun(task.runId);
		const contract = parseContract(task.acceptanceContract);
		const proposalDefaults = acceptancePolicyForRun(run.goalContract, this.config);
		let feedback = await this.failureFeedback(task.id);
		const priorDiagnosis = this.catalog.latestFailureDiagnosis(task.id);
		const profile = this.launcher.resolveProfile(
			run.repositoryRoot,
			this.config.profiles.implementer,
			["read", "bash", "edit", "write", "grep", "find", "ls"],
			executionPolicyFor(run.goalContract),
			"implementer",
		);
		assertFrozenProfile(run.goalContract, "IMPLEMENT", profile);
		const attemptId = randomUUID();
		const attempt = this.kernel.startAttempt({
			id: attemptId,
			taskId,
			baseCommit: run.integrationHead,
			profileName: profile.name,
			profileVersion: profile.version,
			actor,
		});
		const retryAllowed =
			this.catalog.countAttempts(taskId) < writerAttemptLimit(run.goalContract, this.config.maxAttemptsPerTask);
		let worktree: ManagedWorktree | undefined;
		let candidate: SealedCandidate | undefined;
		let candidateId: string | undefined;
		try {
			await new ContractVerifier(this.kernel, this.catalog, this.workspaces).bindRequirements(
				task.id,
				attemptId,
				run.integrationHead,
			);
			worktree = await this.createWriterWorktree(attemptId, run.integrationHead);
			const priorCandidate = this.catalog.latestCandidate(task.id);
			if (priorCandidate && candidateScopeViolations(priorCandidate.changedPaths, task.scope).length === 0) {
				const restored = await this.workspaces.restoreCandidate(worktree, priorCandidate.commitHash);
				const provenance = {
					action: priorDiagnosis?.disposition === "REBASE_REVERIFY" ? "REBASE_REVERIFY" : "PRESERVE_CANDIDATE",
					candidateId: priorCandidate.id,
					candidateCommit: priorCandidate.commitHash,
					candidateTree: priorCandidate.treeHash,
					previousBaseline: priorCandidate.baseCommit,
					currentBaseline: run.integrationHead,
					...restored,
				};
				this.kernel.sendMessage({
					runId: run.id,
					taskId: task.id,
					recipientKind: "TASK",
					recipientId: task.id,
					kind: "HANDOFF",
					body: JSON.stringify(provenance),
					references: [
						{ kind: "CANDIDATE", id: priorCandidate.id },
						{ kind: "ATTEMPT", id: attemptId },
					],
					actor,
				});
				feedback += `\nThe prior immutable candidate is already replayed in your worktree. Preserve valid changes, resolve listed conflicts, and repair the evidence-backed defect. New checks and review are required.\n${JSON.stringify(provenance)}`;
			}
			if (executionPolicyFor(run.goalContract).enableFailureAdaptation && priorDiagnosis?.disposition === "REPLAN") {
				const explorer = new PiExplorer(
					this.kernel,
					this.catalog,
					this.workspaces,
					this.launcher,
					this.resources,
					this.paths,
					this.config,
					this.liveAttempts,
				);
				const plan = await explorer.explore({
					runId: run.id,
					taskId: task.id,
					objective: task.objective,
					question:
						"Diagnose the failed approach before another implementation. Identify the incorrect assumption, propose an ordered correction plan and focused verification, and identify any missing prerequisite that requires a bounded task-graph proposal. Preserve the frozen scope and acceptance contract. Cite repository evidence; do not merely ask the writer to try again.",
					hypothesis:
						"The previous implementation strategy is incomplete or incorrect; inspect alternatives before spending the next writer execution.",
					feedback,
					purpose: "REPLAN",
					baseCommit: priorCandidate?.commitHash ?? run.integrationHead,
					coordinationBaselineCommit: run.integrationHead,
					repositoryRoot: run.repositoryRoot,
				});
				feedback += `\nRead-only replanning report from attempt ${plan.attemptId}:\n${plan.report}`;
			}
			await this.resources.run("CODING", () =>
				this.runWriter({
					task,
					attemptId,
					worktree: worktree as ManagedWorktree,
					profile,
					feedback,
					proposalDefaults,
				}),
			);
			const yielded = this.processWorkerRequests(task, attemptId);
			if (yielded) return yielded;
			candidate = await this.seal(run.id, attemptId, worktree, task.title);
			if (candidate.changedPaths.length === 0) {
				const reason = "Worker produced no repository changes";
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: task.id,
					attemptId,
					phase: "IMPLEMENT",
					classification: "NO_PROGRESS",
					detail: reason,
				});
				this.kernel.failAttempt({
					attemptId,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			const ownershipFailure = scopeFailure(task, candidate);
			if (ownershipFailure) {
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: task.id,
					attemptId,
					phase: "CANDIDATE_SEAL",
					classification: "CONTRACT_VIOLATION",
					detail: ownershipFailure,
				});
				this.kernel.failAttempt({ attemptId, reason: ownershipFailure, retryTask: diagnosis.retryTask, actor });
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			candidateId = this.kernel.submitCandidate({
				taskId: task.id,
				attemptId,
				attemptEpoch: attempt.epoch,
				baseCommit: run.integrationHead,
				commitHash: candidate.commitHash,
				treeHash: candidate.treeHash,
				changedPaths: candidate.changedPaths,
				note: "Sealed by the control plane after Pi worker exit",
				actor: { kind: "ATTEMPT", id: attemptId },
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const diagnosis = this.failurePolicy.diagnose({
				runId: run.id,
				taskId: task.id,
				attemptId,
				phase: "IMPLEMENT_RUNTIME",
				classification: "INFRASTRUCTURE",
				detail,
			});
			this.tryFailRunningAttempt(attemptId, error, diagnosis.retryTask);
			return diagnosis.retryTask ? "RETRY" : "BLOCKED";
		} finally {
			if (worktree) await this.removeWorktree(attemptId, worktree);
		}

		if (!candidate || !candidateId) throw new Error("Candidate sealing did not produce an identity");
		return this.verifyCandidate({
			task,
			run,
			candidate,
			candidateId,
			contract,
			retryAllowed,
		});
	}

	async resume(attemptId: string): Promise<TaskExecutionOutcome> {
		const actor = { kind: "SYSTEM", id: "recovery-service" } as const;
		const attempt = this.catalog.getAttempt(attemptId);
		if (
			attempt.workflowFunction !== "IMPLEMENT" ||
			attempt.state !== "RUNNING" ||
			attempt.taskId === null ||
			attempt.epoch === null ||
			attempt.piSessionId === null
		) {
			throw new Error("Attempt is not a resumable implementation execution: " + attemptId);
		}
		const task = this.catalog.getTask(attempt.taskId);
		const run = this.catalog.getRun(attempt.runId);
		if (task.state !== "ACTIVE" || task.activeAttemptId !== attempt.id || task.attemptEpoch !== attempt.epoch) {
			throw new Error("Attempt no longer owns the authoritative task epoch");
		}
		const contract = parseContract(task.acceptanceContract);
		const proposalDefaults = acceptancePolicyForRun(run.goalContract, this.config);
		const feedback = await this.failureFeedback(task.id, attempt.id);
		const profile = this.launcher.resolveProfile(
			run.repositoryRoot,
			attempt.profileName,
			["read", "bash", "edit", "write", "grep", "find", "ls"],
			executionPolicyFor(run.goalContract),
			"implementer",
		);
		try {
			assertFrozenProfile(run.goalContract, "IMPLEMENT", profile);
			if (profile.version !== attempt.profileVersion)
				throw new Error("Recorded Agent profile changed; refusing to resume with different authority");
		} catch (error) {
			this.kernel.failAttempt({
				attemptId,
				reason: error instanceof Error ? error.message : String(error),
				retryTask: false,
				actor,
			});
			return "BLOCKED";
		}
		const retryAllowed =
			this.catalog.countAttempts(task.id) < writerAttemptLimit(run.goalContract, this.config.maxAttemptsPerTask);
		let worktree: ManagedWorktree | undefined;
		let candidate: SealedCandidate | undefined;
		let candidateId: string | undefined;
		try {
			await new ContractVerifier(this.kernel, this.catalog, this.workspaces).bindRequirements(
				task.id,
				attempt.id,
				attempt.baseCommit,
			);
			worktree = await this.workspaces.recoverWorktree(attempt.id, attempt.baseCommit);
			const startOperation = this.journal.find("START_WORKER", attempt.id);
			if (startOperation?.phase !== "COMPLETED") {
				await this.resources.run("CODING", () =>
					this.runWriter({
						task,
						attemptId: attempt.id,
						worktree: worktree as ManagedWorktree,
						profile,
						feedback,
						proposalDefaults,
						resume: true,
					}),
				);
			}
			const yielded = this.processWorkerRequests(task, attempt.id);
			if (yielded) return yielded;
			candidate = await this.seal(run.id, attempt.id, worktree, task.title);
			if (candidate.changedPaths.length === 0) {
				const reason = "Recovered worker produced no repository changes";
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: task.id,
					attemptId,
					phase: "IMPLEMENT",
					classification: "NO_PROGRESS",
					detail: reason,
				});
				this.kernel.failAttempt({
					attemptId,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			const ownershipFailure = scopeFailure(task, candidate);
			if (ownershipFailure) {
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: task.id,
					attemptId,
					phase: "CANDIDATE_SEAL",
					classification: "CONTRACT_VIOLATION",
					detail: ownershipFailure,
				});
				this.kernel.failAttempt({
					attemptId: attempt.id,
					reason: ownershipFailure,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			candidateId = this.kernel.submitCandidate({
				taskId: task.id,
				attemptId: attempt.id,
				attemptEpoch: attempt.epoch,
				baseCommit: attempt.baseCommit,
				commitHash: candidate.commitHash,
				treeHash: candidate.treeHash,
				changedPaths: candidate.changedPaths,
				note: "Sealed after resuming the original Pi session in a new execution",
				actor: { kind: "ATTEMPT", id: attempt.id },
			});
		} catch (error) {
			const diagnosis = this.failurePolicy.diagnose({
				runId: run.id,
				taskId: task.id,
				attemptId,
				phase: "IMPLEMENT_RUNTIME",
				classification: "INFRASTRUCTURE",
				detail: error instanceof Error ? error.message : String(error),
			});
			this.tryFailRunningAttempt(attempt.id, error, diagnosis.retryTask);
			return diagnosis.retryTask ? "RETRY" : "BLOCKED";
		} finally {
			if (worktree) await this.removeWorktree(attempt.id, worktree);
		}
		if (!candidate || !candidateId) throw new Error("Recovered attempt did not produce a candidate identity");
		return this.verifyCandidate({ task, run, candidate, candidateId, contract, retryAllowed });
	}

	private processWorkerRequests(task: TaskDefinition, attemptId: string): TaskExecutionOutcome | null {
		const actor = { kind: "SYSTEM", id: "task-executor" } as const;
		const proposedChanges = this.catalog
			.listTaskChangeProposals(task.runId, ["PROPOSED"])
			.filter((proposal) => proposal.sourceActorKind === "ATTEMPT" && proposal.sourceActorId === attemptId);
		if (proposedChanges.length > 0) {
			const adaptation = executionPolicyFor(this.catalog.getRun(task.runId).goalContract).enableFailureAdaptation;
			const reason = adaptation
				? `Attempt yielded task-graph proposal ${proposedChanges.map((proposal) => proposal.id).join(", ")}`
				: "Failure adaptation is disabled by the frozen run policy; graph-change proposals were rejected. Continue the original task within its existing scope and acceptance contract.";
			if (!adaptation)
				for (const proposal of proposedChanges) this.kernel.rejectTaskChanges(proposal.id, reason, actor);
			const diagnosis = this.failurePolicy.diagnose({
				runId: task.runId,
				taskId: task.id,
				attemptId,
				phase: "IMPLEMENT",
				classification: "UNKNOWN",
				detail: reason,
				proposalAvailable: true,
				evidenceRefs: proposedChanges.map((proposal) => proposal.id),
			});
			this.kernel.failAttempt({ attemptId, reason, retryTask: diagnosis.retryTask, actor });
			return diagnosis.retryTask ? "RETRY" : "BLOCKED";
		}
		const decisionRequests = this.catalog
			.listOpenDecisionRequests(task.runId)
			.filter((request) => request.sourceKind === "ATTEMPT" && request.sourceId === attemptId);
		if (decisionRequests.length > 0) {
			const reason = `Attempt requested human decision ${decisionRequests.map((request) => request.id).join(", ")}`;
			this.kernel.recordFailureDiagnosis({
				runId: task.runId,
				taskId: task.id,
				attemptId,
				phase: "IMPLEMENT",
				classification: "AMBIGUITY",
				fingerprint: createHash("sha256").update(reason).digest("hex"),
				disposition: "ESCALATE",
				detail: reason,
				evidenceRefs: decisionRequests.map((request) => request.id),
				actor,
			});
			this.kernel.failAttempt({ attemptId, reason, retryTask: false, actor });
			return "BLOCKED";
		}
		return null;
	}

	private async verifyCandidate(input: {
		task: TaskDefinition;
		run: ReturnType<ControlCatalog["getRun"]>;
		candidate: SealedCandidate;
		candidateId: string;
		contract: AcceptanceContract;
		retryAllowed: boolean;
	}): Promise<TaskExecutionOutcome> {
		const { task, run, candidate, candidateId, contract, retryAllowed } = input;
		const actor = { kind: "SYSTEM", id: "task-executor" } as const;
		try {
			const candidateChecks = await this.runChecks({
				runId: run.id,
				taskId: task.id,
				subjectKind: "CANDIDATE",
				subjectId: candidateId,
				subjectCommit: candidate.commitHash,
				treeHash: candidate.treeHash,
				baseCommit: run.integrationHead,
				runInputCommit: run.inputCommit,
				checks: contract.candidateChecks,
			});
			if (candidateChecks.status !== "PASSED") {
				const infrastructureError = candidateChecks.status === "ERROR";
				const reason = infrastructureError
					? "Candidate verification infrastructure failed"
					: "Candidate verification failed";
				const diagnosis =
					candidateChecks.diagnosis ??
					this.failurePolicy.diagnose({
						runId: run.id,
						taskId: task.id,
						phase: "CANDIDATE_VERIFY",
						classification: infrastructureError ? "INFRASTRUCTURE" : "VERIFICATION",
						detail: reason,
						evidenceRefs: candidateChecks.checkIds,
					});
				this.kernel.rejectCandidate({
					candidateId,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}

			const reviewIds: string[] = [];
			if (contract.requireReview) {
				const review = await this.reviewer.review({
					runId: run.id,
					task,
					candidateId,
					baseCommit: run.integrationHead,
					candidateCommit: candidate.commitHash,
					repositoryRoot: run.repositoryRoot,
				});
				reviewIds.push(review.reviewId);
				if (review.result.decision !== "APPROVED") {
					const diagnosis = this.failurePolicy.diagnose({
						runId: run.id,
						taskId: task.id,
						phase: "REVIEW",
						classification: "REVIEW",
						detail: JSON.stringify({ summary: review.result.summary, findings: review.result.findings }),
						evidenceRefs: [review.reviewId],
					});
					this.kernel.rejectCandidate({
						candidateId,
						reason: "Independent review did not approve the candidate",
						retryTask: diagnosis.retryTask,
						actor,
					});
					return diagnosis.retryTask ? "RETRY" : "BLOCKED";
				}
			}
			this.kernel.markCandidateEligible(candidateId, actor);
			return await this.integrateAndAccept({
				runId: run.id,
				taskId: task.id,
				candidateId,
				candidateCommit: candidate.commitHash,
				contract,
				reviewIds,
				retryAllowed,
			});
		} catch (error) {
			if (error instanceof ReconciliationRequiredError) throw error;
			try {
				this.kernel.rejectCandidate({
					candidateId,
					reason: error instanceof Error ? error.message : String(error),
					retryTask: false,
					actor,
				});
			} catch {
				// A more specific terminal transition may already have been recorded.
			}
			return "BLOCKED";
		}
	}

	private async runWriter(input: {
		task: TaskDefinition;
		attemptId: string;
		worktree: ManagedWorktree;
		profile: ReturnType<PiWorkerLauncher["resolveProfile"]>;
		feedback: string;
		proposalDefaults: TaskProposalDefaults;
		resume?: boolean;
	}): Promise<void> {
		const actor = { kind: "SYSTEM", id: "task-executor" } as const;
		const prompt = writerPrompt(input.task, input.feedback);
		const originalAttempt = this.catalog.getAttempt(input.attemptId);
		const sessionId = input.resume ? originalAttempt.piSessionId : "implement-" + input.attemptId;
		if (!sessionId || (input.resume && !originalAttempt.contextManifestHash)) {
			throw new Error("Recovery is missing the original Pi session or authoritative context binding");
		}
		const executionId = this.kernel.createExecution({
			attemptId: input.attemptId,
			piSessionId: sessionId,
			contextManifestHash: input.resume
				? (originalAttempt.contextManifestHash as string)
				: createHash("sha256").update(prompt).digest("hex"),
			actor,
		});
		const operation = this.journal.ensure({
			kind: "START_WORKER",
			aggregateType: "ATTEMPT",
			aggregateId: input.attemptId,
			desiredState: { sessionId, worktree: input.worktree.path },
			idempotencyKey: "start-worker:" + input.attemptId,
		});
		const bridge = new AttemptControlBridge(
			this.kernel,
			this.catalog,
			{
				runId: input.task.runId,
				attemptId: input.attemptId,
				taskId: input.task.id,
			},
			this.liveAttempts,
			input.proposalDefaults,
		);
		const control = await bridge.start();
		let managed: Awaited<ReturnType<PiWorkerLauncher["create"]>> | undefined;
		let unregister: (() => void) | undefined;
		try {
			const activeWorker = await this.launcher.create(
				{
					cwd: input.worktree.path,
					sessionDirectory: this.paths.sessions,
					sessionId,
					sessionName: "Implement " + input.task.title.slice(0, 80),
					profileName: input.profile.name,
					defaultTools: input.profile.tools,
					control,
				},
				input.profile,
			);
			managed = activeWorker;
			await this.journal.execute(operation, async () => {
				const state = await activeWorker.worker.start();
				this.kernel.markExecutionLive({ executionId, sessionFile: state.sessionFile, actor });
				unregister = this.liveAttempts?.register(input.attemptId, input.task.id, activeWorker.worker);
				await runMetered(activeWorker.worker, {
					kernel: this.kernel,
					catalog: this.catalog,
					runId: input.task.runId,
					taskId: input.task.id,
					attemptId: input.attemptId,
					executionId,
					phase: input.resume ? "IMPLEMENT_RESUME" : "IMPLEMENT",
					prompt: input.resume
						? `The prior process was interrupted. Reinspect the current worktree, preserve valid work already present, and continue the same assigned task. The original session identity is unchanged. Reconcile the following new observations against the task contract before acting:\n${input.feedback}`
						: prompt,
					timeoutMs: this.config.workerTimeoutMs,
				});
				return { sessionId };
			});
			this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor });
		} catch (error) {
			this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor });
			throw error;
		} finally {
			unregister?.();
			await managed?.close();
			await bridge.stop();
		}
	}

	private async failureFeedback(taskId: string, currentAttemptId?: string): Promise<string> {
		const task = this.catalog.getTask(taskId);
		const run = this.catalog.getRun(task.runId);
		const packet = this.catalog.getTaskFeedback(taskId, currentAttemptId ? 4 : 3);
		const attempts = packet.attempts.filter((attempt) => attempt.id !== currentAttemptId).slice(0, 3);
		const relevantChecks = packet.checks.filter((check) => check.state !== "PASSED").slice(0, 8);
		const checks = await Promise.all(
			relevantChecks.map(async (check) => ({
				id: check.id,
				subjectKind: check.subjectKind,
				checkKind: check.checkKind,
				state: check.state,
				exitCode: check.exitCode,
				result: check.result,
				stdoutTail: await this.readEvidenceTail(check.stdoutPath),
				stderrTail: await this.readEvidenceTail(check.stderrPath),
			})),
		);
		const feedback = {
			coordination: {
				assessment: this.catalog.getCoordinationAssessment(taskId),
				contract: this.catalog.getCoordinationContract(taskId),
				explorations: this.catalog
					.listExplorations(taskId, run.integrationHead)
					.filter((record) => record.taskRevisionId === task.revisionId && record.state === "COMPLETED"),
				latestFailureDisposition: this.catalog.latestFailureDiagnosis(taskId),
			},
			attempts,
			failedChecks: checks,
			reviews: packet.reviews,
			failedIntegrations: packet.integrations.filter(
				(integration) => integration.state === "FAILED" || integration.state === "CONFLICTED",
			),
			messages: currentExplorationMessages(this.catalog, task, run.integrationHead, packet.messages).slice(-20),
		};
		return `Authoritative coordination and evidence packet follows. Treat it as required correction input; do not repeat a failed approach without addressing the cited cause.\n${JSON.stringify(feedback, null, 2)}`;
	}

	private async readEvidenceTail(path: string | null): Promise<string | null> {
		if (!path) return null;
		try {
			const content = await readFile(path, "utf8");
			return content.length > 8_000 ? content.slice(-8_000) : content;
		} catch (error) {
			return `[evidence unavailable: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}

	private async createWriterWorktree(attemptId: string, baseCommit: string): Promise<ManagedWorktree> {
		const operation = this.journal.ensure({
			kind: "CREATE_WORKTREE",
			aggregateType: "ATTEMPT",
			aggregateId: attemptId,
			desiredState: { baseCommit },
			idempotencyKey: "create-worktree:" + attemptId,
		});
		const result = await this.journal.execute(operation, () => this.workspaces.createWorktree(attemptId, baseCommit));
		if (!result) throw new Error("Worktree operation completed without a recoverable result");
		return result;
	}

	private async seal(
		runId: string,
		attemptId: string,
		worktree: ManagedWorktree,
		title: string,
	): Promise<SealedCandidate> {
		const operation = this.journal.ensure({
			kind: "SEAL_CANDIDATE",
			aggregateType: "ATTEMPT",
			aggregateId: attemptId,
			desiredState: { runId, baseCommit: worktree.baseCommit },
			idempotencyKey: "seal-candidate:" + attemptId,
		});
		const result = await this.journal.execute(operation, () =>
			this.workspaces.sealCandidate(runId, worktree, "tripleteam: " + title),
		);
		if (!result) throw new Error("Candidate sealing completed without a recoverable result");
		return result;
	}

	private async removeWorktree(attemptId: string, worktree: ManagedWorktree): Promise<void> {
		const operation = this.journal.ensure({
			kind: "REMOVE_WORKTREE",
			aggregateType: "ATTEMPT",
			aggregateId: attemptId,
			desiredState: { path: worktree.path },
			idempotencyKey: "remove-worktree:" + attemptId,
		});
		try {
			await this.journal.execute(operation, async () => {
				await this.workspaces.removeWorktree(worktree);
				return { removed: true };
			});
		} catch {
			// The reconciler retains the failed cleanup operation for retry.
		}
	}

	private async runChecks(input: {
		runId: string;
		taskId: string;
		subjectKind: "CANDIDATE" | "INTEGRATION";
		subjectId: string;
		subjectCommit: string;
		treeHash: string;
		baseCommit: string;
		runInputCommit: string;
		checks: CheckCommand[];
	}): Promise<{ status: VerificationOutcome; checkIds: string[]; diagnosis?: FailureDiagnosis }> {
		const actor = { kind: "SYSTEM", id: "verification-service" } as const;
		const checkIds: string[] = [];
		for (const specification of input.checks) {
			let infrastructureRetries = 0;
			while (true) {
				const remainingMs = this.kernel.computeSnapshot(input.runId).remainingMs;
				if (remainingMs === 0) throw new Error("Run deadline exhausted before verification");
				const signal = remainingMs === null ? undefined : AbortSignal.timeout(Math.max(1, remainingMs));
				const startedAt = new Date().toISOString();
				const worktree = await this.workspaces.createWorktree("verify-" + randomUUID(), input.subjectCommit);
				let executed: Awaited<ReturnType<CheckRunner["run"]>>;
				try {
					executed = await this.checks.run(
						specification,
						{
							cwd: worktree.path,
							baseCommit: input.baseCommit,
							subjectCommit: input.subjectCommit,
							runInputCommit: input.runInputCommit,
							artifactDirectory: join(this.paths.artifacts, input.runId, input.taskId, input.subjectId),
						},
						signal,
					);
				} finally {
					await this.workspaces.removeWorktree(worktree);
				}
				const finishedAt = new Date().toISOString();
				const checkId = this.kernel.recordCheckResult({
					runId: input.runId,
					taskId: input.taskId,
					subjectKind: input.subjectKind,
					subjectId: input.subjectId,
					treeHash: input.treeHash,
					checkKind: specification.name,
					checkVersion: checkCommandVersion(specification),
					evidenceClass: evidenceClassForCheck(specification),
					command: executed.command,
					environmentHash: executed.environmentHash,
					state: executed.state,
					exitCode: executed.exitCode,
					stdoutPath: executed.stdoutPath,
					stderrPath: executed.stderrPath,
					result: executed.result,
					artifacts: [
						{ ...executed.stdoutArtifact, kind: "CHECK_STDOUT", storageKind: "LOCAL_FILE" as const },
						{ ...executed.stderrArtifact, kind: "CHECK_STDERR", storageKind: "LOCAL_FILE" as const },
					].map(({ path, ...artifact }) => ({ ...artifact, storageLocator: path })),
					actor,
				});
				checkIds.push(checkId);
				this.kernel.recordUsage({
					runId: input.runId,
					taskId: input.taskId,
					kind: "CHECK",
					phase: `${input.subjectKind}:${specification.name}`,
					startedAt,
					finishedAt,
					details: { checkId, state: executed.state, subjectId: input.subjectId },
				});
				const failureDetail =
					executed.state === "PASSED"
						? ""
						: JSON.stringify({
								checkKind: specification.name,
								checkVersion: checkCommandVersion(specification),
								command: specification.argv,
								exitCode: executed.exitCode,
								timedOut: executed.result.timedOut,
								stdout: await this.readEvidenceTail(executed.stdoutPath),
								stderr: await this.readEvidenceTail(executed.stderrPath),
								runtimeEvidence: Object.fromEntries(
									Object.entries(executed.result).filter(([key]) => key !== "durationMs"),
								),
							});
				if (executed.state === "ERROR") {
					const diagnosis = this.failurePolicy.diagnose({
						runId: input.runId,
						taskId: input.taskId,
						phase: `${input.subjectKind}_CHECK_RUNTIME`,
						classification: "INFRASTRUCTURE",
						detail: failureDetail,
						evidenceIdentity: checkCommandVersion(specification),
						evidenceRefs: [checkId],
					});
					if (
						diagnosis.disposition === "INFRA_RETRY" &&
						infrastructureRetries < (this.config.maxRepeatedFailureFingerprints ?? 2)
					) {
						infrastructureRetries++;
						continue;
					}
					return { status: "ERROR", checkIds, diagnosis };
				}
				if (executed.state === "FAILED") {
					const diagnosis = this.failurePolicy.diagnose({
						runId: input.runId,
						taskId: input.taskId,
						phase: `${input.subjectKind}_VERIFY`,
						classification: "VERIFICATION",
						detail: failureDetail,
						evidenceIdentity: checkCommandVersion(specification),
						evidenceRefs: [checkId],
					});
					return { status: "FAILED", checkIds, diagnosis };
				}
				break;
			}
		}
		return { status: "PASSED", checkIds };
	}

	private async integrateAndAccept(input: {
		runId: string;
		taskId: string;
		candidateId: string;
		candidateCommit: string;
		contract: AcceptanceContract;
		reviewIds: string[];
		retryAllowed: boolean;
	}): Promise<TaskExecutionOutcome> {
		const actor = { kind: "SYSTEM", id: "integration-service" } as const;
		return this.resources.run("INTEGRATION", async () => {
			const run = this.catalog.getRun(input.runId);
			const integrationId = this.kernel.queueIntegration({
				candidateId: input.candidateId,
				expectedHead: run.integrationHead,
				actor,
			});
			this.kernel.markIntegrationApplying(integrationId, actor);
			let prepared: { commitHash: string; treeHash: string };
			try {
				prepared = await this.workspaces.prepareIntegration({
					runId: run.id,
					integrationRef: run.integrationRef,
					expectedHead: run.integrationHead,
					candidateCommit: input.candidateCommit,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: input.taskId,
					phase: "INTEGRATION_PREPARE",
					classification: "INTEGRATION_CONFLICT",
					detail: reason,
				});
				this.kernel.failIntegration({
					integrationId,
					conflicted: true,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			let integrationChecks: { status: VerificationOutcome; checkIds: string[]; diagnosis?: FailureDiagnosis };
			try {
				integrationChecks = await this.runChecks({
					runId: run.id,
					taskId: input.taskId,
					subjectKind: "INTEGRATION",
					subjectId: integrationId,
					subjectCommit: prepared.commitHash,
					treeHash: prepared.treeHash,
					baseCommit: run.integrationHead,
					runInputCommit: run.inputCommit,
					checks: input.contract.integrationChecks,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: input.taskId,
					phase: "INTEGRATION_VERIFY_RUNTIME",
					classification: "INFRASTRUCTURE",
					detail: reason,
				});
				this.kernel.failIntegration({
					integrationId,
					conflicted: false,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			if (integrationChecks.status !== "PASSED") {
				const infrastructureError = integrationChecks.status === "ERROR";
				const reason = infrastructureError
					? "Post-merge verification infrastructure failed"
					: "Post-merge verification failed";
				const diagnosis =
					integrationChecks.diagnosis ??
					this.failurePolicy.diagnose({
						runId: run.id,
						taskId: input.taskId,
						phase: "INTEGRATION_VERIFY",
						classification: infrastructureError ? "INFRASTRUCTURE" : "VERIFICATION",
						detail: reason,
						evidenceRefs: integrationChecks.checkIds,
					});
				this.kernel.failIntegration({
					integrationId,
					conflicted: false,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			try {
				const contracts = new ContractVerifier(this.kernel, this.catalog, this.workspaces);
				const affected = await contracts.reverificationTasks(run.id, prepared.commitHash);
				const reverified: Array<{ taskId: string; checkIds: string[] }> = [];
				for (const previousTask of affected) {
					const verification = await this.runChecks({
						runId: run.id,
						taskId: input.taskId,
						subjectKind: "INTEGRATION",
						subjectId: integrationId,
						subjectCommit: prepared.commitHash,
						treeHash: prepared.treeHash,
						baseCommit: run.integrationHead,
						runInputCommit: run.inputCommit,
						checks: parseContract(previousTask.acceptanceContract).integrationChecks,
					});
					if (verification.status !== "PASSED")
						throw new Error(
							`Contract update breaks prior task ${previousTask.id}; checks ${verification.checkIds.join(", ")} did not pass`,
						);
					reverified.push({ taskId: previousTask.id, checkIds: verification.checkIds });
				}
				// Publish proofs only after the whole affected closure passes. They are immutable,
				// tree-bound evidence; prospective proofs never replace valid baseline proofs.
				for (const previousTask of reverified)
					await contracts.verify(previousTask.taskId, prepared.commitHash, prepared.treeHash, previousTask.checkIds);
				if (reverified.length)
					this.kernel.recordControlAction({
						runId: run.id,
						taskId: input.taskId,
						kind: "CONTRACT_REVERIFY",
						detail: { integrationId, treeHash: prepared.treeHash, tasks: reverified },
					});
				await contracts.assertPreserved(run.id, prepared.commitHash);
				await contracts.verify(input.taskId, prepared.commitHash, prepared.treeHash, integrationChecks.checkIds);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const diagnosis = this.failurePolicy.diagnose({
					runId: run.id,
					taskId: input.taskId,
					phase: "INTEGRATION_CONTRACT",
					classification: "CONTRACT_VIOLATION",
					detail: reason,
					evidenceRefs: integrationChecks.checkIds,
				});
				this.kernel.failIntegration({
					integrationId,
					conflicted: false,
					reason,
					retryTask: diagnosis.retryTask,
					actor,
				});
				return diagnosis.retryTask ? "RETRY" : "BLOCKED";
			}
			const operation = this.journal.ensure({
				kind: "UPDATE_INTEGRATION_REF",
				aggregateType: "INTEGRATION",
				aggregateId: integrationId,
				desiredState: {
					ref: run.integrationRef,
					expectedHead: run.integrationHead,
					resultCommit: prepared.commitHash,
					resultTreeHash: prepared.treeHash,
				},
				idempotencyKey: "publish-integration:" + integrationId,
			});
			try {
				this.kernel.assertIntegrationPublishable(integrationId);
				await this.journal.execute(operation, async () => {
					await this.workspaces.publishIntegration({
						integrationRef: run.integrationRef,
						expectedHead: run.integrationHead,
						resultCommit: prepared.commitHash,
					});
					return { commitHash: prepared.commitHash, treeHash: prepared.treeHash };
				});
				this.kernel.commitIntegration({
					integrationId,
					resultCommit: prepared.commitHash,
					resultTreeHash: prepared.treeHash,
					actor,
				});
				this.kernel.acceptTask({
					taskId: input.taskId,
					integrationId,
					actor,
				});
			} catch (error) {
				throw new ReconciliationRequiredError(
					"Integration reached its durable publish boundary but authoritative completion did not finish",
					{ cause: error },
				);
			}
			return "ACCEPTED";
		});
	}

	private tryFailRunningAttempt(attemptId: string, error: unknown, retryTask: boolean): void {
		try {
			this.kernel.failAttempt({
				attemptId,
				reason: error instanceof Error ? error.message : String(error),
				retryTask,
				actor: { kind: "SYSTEM", id: "task-executor" },
			});
		} catch {
			// Preserve the original failure; reconciliation will inspect inconsistent state.
		}
	}
}
