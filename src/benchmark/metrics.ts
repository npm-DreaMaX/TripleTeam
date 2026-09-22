import type { LocalOrchestrator } from "../app/orchestrator.ts";
import type { FrozenBenchmarkManifest } from "./manifest.ts";

export interface TrialUsage {
	knownCostUsd: number;
	costComplete: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	toolCalls: number;
	agentExecutions: number;
	unknownUsageRecords: number;
	phaseDurationMs: Record<string, number>;
}

export interface BenchmarkTrial {
	schema: "tripleteam-benchmark-trial/v1";
	manifestHash: string;
	instanceId: string;
	runId: string | null;
	state: "SUBMITTED" | "BLOCKED" | "CANCELLED" | "ERROR";
	deliveryResult: string | null;
	commit: string | null;
	tree: string | null;
	startedAt: string;
	finishedAt: string;
	error: string | null;
	usage: TrialUsage;
}

interface UsageRow {
	kind: string;
	phase: string;
	duration_ms: number;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_usd: number | null;
	tool_calls: number | null;
	details_json: string;
}

export function readTrialUsage(orchestrator: LocalOrchestrator, runId: string): TrialUsage {
	const rows = orchestrator.database.sql
		.prepare("SELECT * FROM usage_records WHERE run_id = ? ORDER BY started_at, id")
		.all<UsageRow>(runId);
	const executionIds = orchestrator.database.sql
		.prepare("SELECT e.id FROM executions e JOIN attempts a ON a.id = e.attempt_id WHERE a.run_id = ?")
		.all<{ id: string }>(runId)
		.map((row) => row.id);
	return aggregateUsage(rows, executionIds.length, executionIds);
}

export function aggregateUsage(rows: UsageRow[], executions: number, executionIds?: readonly string[]): TrialUsage {
	const result: TrialUsage = {
		knownCostUsd: 0,
		costComplete: true,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolCalls: 0,
		agentExecutions: executions,
		unknownUsageRecords: 0,
		phaseDurationMs: {},
	};
	let agentRows = 0;
	const meteredExecutions = new Set<string>();
	for (const row of rows) {
		result.phaseDurationMs[row.phase] = (result.phaseDurationMs[row.phase] ?? 0) + row.duration_ms;
		// Pi metering records every model invocation as AGENT, including planning/review/exploration.
		if (row.kind !== "AGENT") continue;
		agentRows++;
		const details = JSON.parse(row.details_json) as Record<string, unknown>;
		if (typeof details.executionId === "string") meteredExecutions.add(details.executionId);
		if (row.cost_usd === null || details.usageComplete === false || details.complete === false) {
			result.unknownUsageRecords++;
		}
		result.knownCostUsd += row.cost_usd ?? 0;
		result.inputTokens += row.input_tokens ?? 0;
		result.outputTokens += row.output_tokens ?? 0;
		result.cacheReadTokens += row.cache_read_tokens ?? 0;
		result.cacheWriteTokens += row.cache_write_tokens ?? 0;
		result.toolCalls += row.tool_calls ?? 0;
	}
	// A missing crash record must never become a free invocation in a cost claim.
	result.unknownUsageRecords += executionIds
		? executionIds.filter((id) => !meteredExecutions.has(id)).length
		: Math.max(0, executions - agentRows);
	result.costComplete = result.unknownUsageRecords === 0;
	return result;
}

/** External verdicts are offline summary inputs only; no runtime accepts them as feedback. */
export interface ExternalVerdict {
	instanceId: string;
	manifestHash: string;
	tree: string;
	resolved: boolean;
	passed?: number;
	total?: number;
}

export function summarizeTrials(
	frozen: FrozenBenchmarkManifest,
	trials: BenchmarkTrial[],
	verdicts: ExternalVerdict[] = [],
) {
	const trialMap = new Map<string, BenchmarkTrial>();
	for (const trial of trials) {
		if (trial.manifestHash !== frozen.sha256 || !frozen.manifest.instanceIds.includes(trial.instanceId)) {
			throw new Error("Trial does not belong to the frozen experiment");
		}
		if (trialMap.has(trial.instanceId)) throw new Error("Repeated trials require separate frozen replicate manifests");
		if (!Number.isFinite(Date.parse(trial.startedAt)) || !Number.isFinite(Date.parse(trial.finishedAt))) {
			throw new Error("Trial timestamps are invalid");
		}
		if (Date.parse(trial.finishedAt) < Date.parse(trial.startedAt)) throw new Error("Trial ended before it started");
		trialMap.set(trial.instanceId, trial);
	}
	const verdictMap = new Map<string, ExternalVerdict>();
	for (const verdict of verdicts) {
		const trial = trialMap.get(verdict.instanceId);
		if (
			!trial ||
			verdict.manifestHash !== frozen.sha256 ||
			!trial.tree ||
			verdict.tree !== trial.tree ||
			typeof verdict.resolved !== "boolean"
		) {
			throw new Error("External verdict must match the exact submitted tree and experiment");
		}
		if (verdictMap.has(verdict.instanceId)) throw new Error("Duplicate external verdict");
		verdictMap.set(verdict.instanceId, verdict);
	}
	const missing = frozen.manifest.instanceIds.filter((id) => !trialMap.has(id));
	const knownCostUsd = trials.reduce((sum, trial) => sum + trial.usage.knownCostUsd, 0);
	const costComplete = missing.length === 0 && trials.every((trial) => trial.usage.costComplete);
	const resolved = verdicts.filter((verdict) => verdict.resolved).length;
	const claimed = trials.filter((trial) => trial.deliveryResult === "VERIFIED_DELIVERY");
	const assessedClaims = claimed.filter((trial) => verdictMap.has(trial.instanceId));
	const falseClaims = assessedClaims.filter((trial) => !verdictMap.get(trial.instanceId)?.resolved).length;
	const observedDurations = trials.map((trial) => Date.parse(trial.finishedAt) - Date.parse(trial.startedAt));
	return {
		schema: "tripleteam-benchmark-summary/v1",
		manifestHash: frozen.sha256,
		planned: frozen.manifest.instanceIds.length,
		recorded: trials.length,
		missingInstanceIds: missing,
		externallyAssessed: verdicts.length,
		resolved,
		// Unknown or missing goals remain in the denominator. This is a lower bound until all verdicts arrive.
		resolveRateLowerBound:
			frozen.manifest.benchmark === "featurebench" ? resolved / frozen.manifest.instanceIds.length : null,
		instanceResolutionLowerBound: resolved / frozen.manifest.instanceIds.length,
		officialScoring:
			frozen.manifest.benchmark === "swe-milestone"
				? "Use the official evolution-range/repository macro average; the instance fraction here is diagnostic only"
				: "One final submission per planned instance",
		resolutionComplete: verdicts.length === frozen.manifest.instanceIds.length,
		costScope: frozen.manifest.accounting.costScope,
		knownCostUsd,
		costComplete,
		costPerResolvedUsd:
			costComplete && verdicts.length === frozen.manifest.instanceIds.length && resolved > 0
				? knownCostUsd / resolved
				: null,
		verifiedClaims: claimed.length,
		assessedVerifiedClaims: assessedClaims.length,
		falseVerifiedClaims: falseClaims,
		falseAcceptanceRate: assessedClaims.length > 0 ? falseClaims / assessedClaims.length : null,
		observedRunDurationMs: observedDurations,
		stateCounts: Object.fromEntries(
			["SUBMITTED", "BLOCKED", "CANCELLED", "ERROR"].map((state) => [
				state,
				trials.filter((trial) => trial.state === state).length,
			]),
		),
	};
}
