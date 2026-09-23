import type { ExecutionPolicy } from "../config/execution.ts";
import type { AssurancePolicy } from "../verification/assurance-types.ts";
import type { ControlKernel } from "./kernel.ts";

export interface VerificationAllocation {
	required: boolean;
	action: "SPECIFY_AND_CRITIQUE" | "IMPLEMENT_WITH_FROZEN_CHECKS";
	reason: string;
	estimator: "remaining-delivery-value/v1";
	calibrated: false;
	estimates: Record<string, number | boolean>;
}

/** Compare optional assurance with preserving compute for implementation and mandatory delivery gates.
 * This is an explicit, uncalibrated value-of-information heuristic, not a correctness oracle. */
export function allocateVerification(input: {
	policy: ExecutionPolicy;
	assurance: AssurancePolicy;
	budget: ReturnType<ControlKernel["computeSnapshot"]>;
	risk: string;
	uncertainty: string;
	protectedBehavior: boolean;
	reviewRequired: boolean;
	remainingTasks: number;
	remainingReviews?: number;
	successes: number;
	failures: number;
	writerMs?: number;
	writerUsd?: number;
	auxiliaryMs?: number;
	auxiliaryUsd?: number;
}): VerificationAllocation {
	const { policy, budget } = input;
	const writerMs = input.writerMs || 600_000,
		writerUsd = input.writerUsd || policy.reservationUsd;
	const auxiliaryMs = input.auxiliaryMs || 90_000,
		auxiliaryUsd = input.auxiliaryUsd || writerUsd * 0.2;
	const reviewCalls = input.reviewRequired ? 1 : 0;
	const deliveryWriters = Math.max(1, input.remainingTasks);
	const deliveryReviews = input.remainingReviews ?? deliveryWriters * reviewCalls;
	const deliveryCalls = deliveryWriters + deliveryReviews;
	const deliveryUsd = deliveryWriters * writerUsd + deliveryReviews * auxiliaryUsd;
	// Conservative serial estimate: an optional call cannot rely on unobserved parallel speedup.
	const deliveryMs = deliveryWriters * writerMs + deliveryReviews * auxiliaryMs + 30_000;
	const repairMs = writerMs + auxiliaryMs * reviewCalls + 30_000;
	const repairUsd = writerUsd + auxiliaryUsd * reviewCalls;
	const errorProbability = (2 + input.failures) / (4 + input.successes + input.failures);
	const detectionFraction = input.uncertainty === "HIGH" ? 0.8 : 0.65;
	const avoidedMs = repairMs * errorProbability * detectionFraction;
	const avoidedUsd = repairUsd * errorProbability * detectionFraction;
	const designMs = 2 * auxiliaryMs,
		designUsd = 2 * auxiliaryUsd;
	const affordable =
		policy.maxExecutions - budget.executions >= deliveryCalls + 2 &&
		(policy.costLimitUsd === undefined ||
			policy.costLimitUsd - budget.costUsd - budget.reservedUsd >= designUsd + deliveryUsd) &&
		(policy.tokenLimit === undefined ||
			policy.tokenLimit - budget.tokens - budget.reservedTokens >= policy.reservationTokens * (2 + deliveryCalls)) &&
		(budget.remainingMs === null || budget.remainingMs > designMs + deliveryMs);
	const value = (avoidedUsd - designUsd) / Math.max(repairUsd, 0.000001) + (avoidedMs - designMs) / repairMs;
	let required = false,
		reason: string;
	if (input.assurance.mode === "off") reason = "Independent design is disabled by the frozen policy";
	else if (input.assurance.mode === "required" || input.risk === "HIGH") {
		required = true;
		reason = "Frozen assurance policy or high task risk requires independent design";
	} else if (input.protectedBehavior && input.failures === 0 && input.uncertainty !== "HIGH") {
		reason = "Protected behavior checks already gate this increment; preserve compute for implementation";
	} else if (!affordable) {
		reason = "Preserve the remaining allocation for writers, mandatory reviews and final checks";
	} else {
		required = value > 0;
		reason = required
			? "Estimated avoided repair exceeds independent design and critique overhead"
			: "Additional design has non-positive estimated value; use the existing frozen checks";
	}
	return {
		required,
		action: required ? "SPECIFY_AND_CRITIQUE" : "IMPLEMENT_WITH_FROZEN_CHECKS",
		reason,
		estimator: "remaining-delivery-value/v1",
		calibrated: false,
		estimates: {
			writerMs,
			writerUsd,
			auxiliaryMs,
			auxiliaryUsd,
			deliveryCalls,
			deliveryUsd,
			deliveryMs,
			errorProbability,
			detectionFraction,
			avoidedMs,
			avoidedUsd,
			designMs,
			designUsd,
			affordable,
			value,
		},
	};
}
