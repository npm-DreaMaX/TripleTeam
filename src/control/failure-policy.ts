import { createHash } from "node:crypto";
import { executionPolicyFor, writerAttemptLimit } from "../config/execution.ts";
import type { ProjectConfig } from "../config/project.ts";
import type { FailureDisposition } from "../domain/model.ts";
import type { ControlCatalog } from "./catalog.ts";
import { pendingExplorationQuestions } from "./exploration-policy.ts";
import type { ControlKernel } from "./kernel.ts";

export type FailureClassification =
	| "INFRASTRUCTURE"
	| "VERIFICATION"
	| "REVIEW"
	| "STALE_BASE"
	| "INTEGRATION_CONFLICT"
	| "CONTRACT_VIOLATION"
	| "NO_PROGRESS"
	| "AMBIGUITY"
	| "RESOURCE"
	| "UNKNOWN";

export interface FailureDiagnosis {
	id: string;
	fingerprint: string;
	occurrence: number;
	classification: FailureClassification;
	disposition: FailureDisposition;
	retryTask: boolean;
}

function normalizedFailure(detail: string): string {
	return detail
		.toLowerCase()
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
		.replace(/\b[0-9a-f]{40,64}\b/g, "<hash>")
		.replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z\b/g, "<timestamp>")
		.replace(/:\d+:\d+\b/g, ":<line>:<column>")
		.replace(/\bline \d+\b/g, "line <line>")
		.replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds|milliseconds)\b/g, "<duration>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 16_000);
}

export function failureFingerprint(
	phase: string,
	classification: FailureClassification,
	detail: string,
	evidenceIdentity = "",
): string {
	return createHash("sha256")
		.update(`${phase}\0${classification}\0${evidenceIdentity}\0${normalizedFailure(detail)}`)
		.digest("hex");
}

export class FailurePolicy {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly config: ProjectConfig,
	) {}

	diagnose(input: {
		runId: string;
		taskId: string;
		attemptId?: string;
		phase: string;
		classification: FailureClassification;
		detail: string;
		evidenceIdentity?: string;
		evidenceRefs?: string[];
		proposalAvailable?: boolean;
		/** The failed stage already consumed its own bounded recovery allowance. */
		recoveryExhausted?: boolean;
	}): FailureDiagnosis {
		const fingerprint = failureFingerprint(input.phase, input.classification, input.detail, input.evidenceIdentity);
		const occurrence = this.catalog.countFailureFingerprint(input.runId, fingerprint, input.taskId) + 1;
		const attemptsRemain =
			this.catalog.countAttempts(input.taskId) <
			writerAttemptLimit(this.catalog.getRun(input.runId).goalContract, this.config.maxAttemptsPerTask);
		const repeatedLimit = this.config.maxRepeatedFailureFingerprints ?? 2;
		const assessment = this.catalog.getCoordinationAssessment(input.taskId);
		const task = this.catalog.getTask(input.taskId);
		const run = this.catalog.getRun(input.runId);
		const canExplore = Boolean(
			assessment &&
				pendingExplorationQuestions(
					task,
					this.catalog.listExplorations(input.taskId, run.integrationHead),
					assessment.explorationQuestions,
					this.config.maxExplorationAttempts ?? 2,
				).length,
		);
		let disposition: FailureDisposition;
		if (input.recoveryExhausted) disposition = "BLOCK";
		else if (!executionPolicyFor(run.goalContract).enableFailureAdaptation) {
			const infrastructure = input.classification === "INFRASTRUCTURE" || input.classification === "RESOURCE";
			const retryAllowed = attemptsRemain || (infrastructure && input.phase.endsWith("_CHECK_RUNTIME"));
			disposition =
				retryAllowed && occurrence <= repeatedLimit && input.classification !== "AMBIGUITY"
					? infrastructure
						? "INFRA_RETRY"
						: "RETRY"
					: "BLOCK";
		} else if (input.proposalAvailable) disposition = attemptsRemain ? "DELEGATE" : "BLOCK";
		else if (input.classification === "AMBIGUITY") disposition = "ESCALATE";
		else if (input.classification === "INFRASTRUCTURE" || input.classification === "RESOURCE") {
			const inPlaceVerificationRetry = input.phase.endsWith("_CHECK_RUNTIME");
			disposition =
				occurrence <= repeatedLimit && (inPlaceVerificationRetry || attemptsRemain) ? "INFRA_RETRY" : "BLOCK";
		} else if (input.classification === "STALE_BASE" || input.classification === "INTEGRATION_CONFLICT") {
			disposition = attemptsRemain ? "REBASE_REVERIFY" : "BLOCK";
		} else if (input.classification === "CONTRACT_VIOLATION" || input.classification === "NO_PROGRESS") {
			disposition =
				occurrence === 1 && attemptsRemain ? "REPLAN" : canExplore && attemptsRemain ? "DIVERSE_EXPLORE" : "BLOCK";
		} else if (input.classification === "VERIFICATION" || input.classification === "REVIEW") {
			disposition =
				occurrence === 1 && attemptsRemain
					? "RETRY"
					: occurrence <= repeatedLimit && attemptsRemain
						? "REPLAN"
						: canExplore && attemptsRemain
							? "DIVERSE_EXPLORE"
							: "BLOCK";
		} else {
			disposition = occurrence === 1 && attemptsRemain ? "RETRY" : "BLOCK";
		}
		if (occurrence > repeatedLimit + 1 && disposition !== "ESCALATE") disposition = "BLOCK";
		const recorded = this.kernel.recordFailureDiagnosis({
			runId: input.runId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			phase: input.phase,
			classification: input.classification,
			fingerprint,
			disposition,
			detail: input.detail,
			evidenceRefs: input.evidenceRefs,
			actor: { kind: "SYSTEM", id: "failure-policy" },
		});
		if (disposition === "ESCALATE") {
			this.kernel.createDecisionRequest({
				runId: input.runId,
				taskId: input.taskId,
				kind: input.classification === "AMBIGUITY" ? "REQUIREMENT_CHOICE" : "BUDGET_EXTENSION",
				question:
					input.classification === "AMBIGUITY"
						? `Repository evidence cannot resolve this product or requirement decision: ${input.detail}`
						: `The same infrastructure failure repeated ${recorded.occurrence} times. Should execution be retried?`,
				options: ["RETRY_WITH_USER_DIRECTION", "KEEP_BLOCKED"],
				recommendedOption: "KEEP_BLOCKED",
				evidenceRefs: input.evidenceRefs,
				sourceKind: "FAILURE_DIAGNOSIS",
				sourceId: recorded.id,
				actor: { kind: "SYSTEM", id: "failure-policy" },
			});
		}
		return {
			id: recorded.id,
			fingerprint,
			occurrence: recorded.occurrence,
			classification: input.classification,
			disposition,
			retryTask: ["RETRY", "REPLAN", "DELEGATE", "DIVERSE_EXPLORE", "REBASE_REVERIFY", "INFRA_RETRY"].includes(
				disposition,
			),
		};
	}
}
