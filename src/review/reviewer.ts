import { createHash, randomUUID } from "node:crypto";
import { executionPolicyFor } from "../config/execution.ts";
import type { ProjectPaths } from "../config/paths.ts";
import type { ProjectConfig } from "../config/project.ts";
import type { ControlCatalog, TaskDefinition } from "../control/catalog.ts";
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
import type { GitWorkspaceManager, ManagedWorktree } from "../workspace/git.ts";

export interface ReviewFinding {
	severity: "INFO" | "WARNING" | "BLOCKING";
	title: string;
	detail: string;
	references: unknown[];
}

export interface ReviewResult {
	decision: "APPROVED" | "CHANGES_REQUESTED" | "ABSTAINED";
	summary: string;
	findings: ReviewFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const source = fenced?.[1]?.trim() ?? text.trim();
	try {
		return JSON.parse(source) as unknown;
	} catch (firstError) {
		const start = source.indexOf("{");
		const end = source.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1)) as unknown;
		throw firstError;
	}
}

export function parseReviewResult(text: string): ReviewResult {
	const value = extractJson(text);
	if (!isRecord(value)) throw new Error("Review must be a JSON object");
	if (value.decision !== "APPROVED" && value.decision !== "CHANGES_REQUESTED" && value.decision !== "ABSTAINED") {
		throw new Error("Review decision is invalid");
	}
	if (typeof value.summary !== "string" || value.summary.trim() === "") throw new Error("Review summary is required");
	if (!Array.isArray(value.findings)) throw new Error("Review findings must be an array");
	const findings = value.findings.map((finding, index): ReviewFinding => {
		if (!isRecord(finding)) throw new Error(`findings[${index}] must be an object`);
		if (finding.severity !== "INFO" && finding.severity !== "WARNING" && finding.severity !== "BLOCKING") {
			throw new Error(`findings[${index}].severity is invalid`);
		}
		if (typeof finding.title !== "string" || typeof finding.detail !== "string") {
			throw new Error(`findings[${index}] requires title and detail`);
		}
		if (finding.references !== undefined && !Array.isArray(finding.references)) {
			throw new Error(`findings[${index}].references must be an array`);
		}
		return {
			severity: finding.severity,
			title: finding.title,
			detail: finding.detail,
			references: finding.references ?? [],
		};
	});
	if (value.decision === "APPROVED" && findings.some((finding) => finding.severity === "BLOCKING")) {
		throw new Error("An approved review cannot contain blocking findings");
	}
	return { decision: value.decision, summary: value.summary, findings };
}

function prompt(task: TaskDefinition, diff: string): string {
	const limitedDiff = diff.length > 200_000 ? diff.slice(0, 200_000) + "\n[diff truncated]" : diff;
	return `You are an independent code reviewer in a verified coding system. Review the immutable candidate against the task contract. You have read-only tools. Do not edit files and do not claim task completion.

Task: ${task.title}
Objective: ${task.objective}
Scope: ${JSON.stringify(task.scope)}
Constraints: ${JSON.stringify(task.constraints)}
Acceptance contract: ${JSON.stringify(task.acceptanceContract)}

Candidate diff:
${limitedDiff}

Return JSON only:
{
  "decision": "APPROVED|CHANGES_REQUESTED|ABSTAINED",
  "summary": "concise evidence-backed assessment",
  "findings": [
    {
      "severity": "INFO|WARNING|BLOCKING",
      "title": "finding title",
      "detail": "specific explanation",
      "references": ["path:line"]
    }
  ]
}`;
}

export class PiReviewer {
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

	async review(input: {
		runId: string;
		task: TaskDefinition;
		candidateId: string;
		baseCommit: string;
		candidateCommit: string;
		repositoryRoot: string;
	}): Promise<{ reviewId: string; result: ReviewResult }> {
		return this.resources.run("INTERACTIVE", async () => {
			const actor = { kind: "SYSTEM", id: "review-service" } as const;
			const profile = constrainProfileTools(
				this.launcher.resolveProfile(
					input.repositoryRoot,
					this.config.profiles.reviewer,
					["read", "grep", "find", "ls"],
					executionPolicyFor(this.catalog.getRun(input.runId).goalContract),
					"reviewer",
				),
				["read", "grep", "find", "ls"],
			);
			assertFrozenProfile(this.catalog.getRun(input.runId).goalContract, "REVIEW", profile);
			const attemptId = randomUUID();
			this.kernel.startAuxiliaryAttempt({
				id: attemptId,
				runId: input.runId,
				taskId: input.task.id,
				workflowFunction: "REVIEW",
				baseCommit: input.candidateCommit,
				profileName: profile.name,
				profileVersion: profile.version,
				actor,
			});
			let worktree: ManagedWorktree | undefined;
			let managed: ManagedPiWorker | undefined;
			let bridge: AttemptControlBridge | undefined;
			let executionId: string | undefined;
			let unregister: (() => void) | undefined;
			try {
				worktree = await this.workspaces.createWorktree(attemptId, input.candidateCommit);
				const reviewPrompt = prompt(input.task, await this.workspaces.diff(input.baseCommit, input.candidateCommit));
				const sessionId = "review-" + attemptId;
				executionId = this.kernel.createExecution({
					attemptId,
					piSessionId: sessionId,
					contextManifestHash: createHash("sha256").update(reviewPrompt).digest("hex"),
					actor,
				});
				bridge = new AttemptControlBridge(
					this.kernel,
					this.catalog,
					{
						runId: input.runId,
						attemptId,
						taskId: input.task.id,
					},
					this.liveAttempts,
				);
				const control = await bridge.start();
				managed = await this.launcher.create(
					{
						cwd: worktree.path,
						sessionDirectory: this.paths.sessions,
						sessionId,
						sessionName: "Review " + input.task.title.slice(0, 80),
						profileName: profile.name,
						defaultTools: profile.tools,
						control,
					},
					profile,
				);
				const state = await managed.worker.start();
				this.kernel.markExecutionLive({ executionId, sessionFile: state.sessionFile, actor });
				unregister = this.liveAttempts?.register(attemptId, input.task.id, managed.worker);
				const reviewerWorker = managed.worker;
				const runReviewer = async (text: string, phase: string) => {
					const response = await runMetered(reviewerWorker, {
						kernel: this.kernel,
						catalog: this.catalog,
						runId: input.runId,
						taskId: input.task.id,
						attemptId,
						executionId: executionId as string,
						phase,
						prompt: text,
						timeoutMs: this.config.workerTimeoutMs,
					});
					return response;
				};
				let response = await runReviewer(reviewPrompt, "REVIEW");
				let result: ReviewResult;
				try {
					result = parseReviewResult(response.lastAssistantText ?? "");
				} catch (error) {
					response = await runReviewer(
						"Your previous review failed deterministic validation: " +
							(error instanceof Error ? error.message : String(error)) +
							". Return one corrected JSON object only.",
						"REVIEW_CORRECTION",
					);
					result = parseReviewResult(response.lastAssistantText ?? "");
				}
				this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor });
				this.kernel.completeAuxiliaryAttempt(attemptId, actor);
				const reviewId = this.kernel.recordReview({
					candidateId: input.candidateId,
					reviewerAttemptId: attemptId,
					state: result.decision,
					summary: result.summary,
					findings: result.findings,
					actor,
				});
				return { reviewId, result };
			} catch (error) {
				if (executionId) {
					try {
						this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor });
					} catch {
						// Preserve the primary reviewer failure.
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
					// The review may already be durably recorded.
				}
				throw error;
			} finally {
				unregister?.();
				await managed?.close();
				await bridge?.stop();
				if (worktree) await this.workspaces.removeWorktree(worktree);
			}
		});
	}
}
