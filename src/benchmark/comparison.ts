import { type FrozenBenchmarkManifest, hashJson } from "./manifest.ts";
import { type BenchmarkTrial, type ExternalVerdict, summarizeTrials } from "./metrics.ts";

export interface ExperimentResults {
	frozen: FrozenBenchmarkManifest;
	trials: BenchmarkTrial[];
	verdicts: ExternalVerdict[];
}

/** Offline comparison only. Evaluator verdicts never enter an active model's context. */
export function compareFeatureBench(left: ExperimentResults, right: ExperimentResults) {
	const a = left.frozen.manifest,
		b = right.frozen.manifest;
	if (a.benchmark !== "featurebench" || b.benchmark !== "featurebench")
		throw new Error("Use the official macro scoring for SWE-Milestone; this comparison is for FeatureBench");
	const common = (m: typeof a) => ({
		evaluatorCommit: m.evaluatorCommit,
		datasetRevision: m.datasetRevision,
		datasetDigest: m.datasetDigest,
		split: m.split,
		instances: [...m.instanceIds].sort(),
		budget: m.budget,
		protocol: m.protocol,
		costScope: m.accounting.costScope,
		replicate: m.replicate,
	});
	if (hashJson(common(a)) !== hashJson(common(b)))
		throw new Error("Comparison requires the same frozen tasks, environment, protocol, replicate and budget");
	const leftSummary = summarizeTrials(left.frozen, left.trials, left.verdicts);
	const rightSummary = summarizeTrials(right.frozen, right.trials, right.verdicts);
	const lm = new Map(left.verdicts.map((v) => [v.instanceId, v.resolved]));
	const rm = new Map(right.verdicts.map((v) => [v.instanceId, v.resolved]));
	const allAssessed = a.instanceIds.every((id) => lm.has(id) && rm.has(id));
	const paired = a.instanceIds.filter((id) => lm.has(id) && rm.has(id));
	const wins = paired.filter((id) => lm.get(id) && !rm.get(id)).length;
	const losses = paired.filter((id) => !lm.get(id) && rm.get(id)).length;
	// FeatureBench's stable ID starts with owner__repo. Cluster related tasks together.
	const clusters = new Map<string, number[]>();
	for (const id of a.instanceIds) {
		const key = id.split(".")[0] as string;
		const values = clusters.get(key) ?? [];
		values.push(Number(lm.get(id)) - Number(rm.get(id)));
		clusters.set(key, values);
	}
	let interval: [number, number] | null = null;
	if (allAssessed && clusters.size >= 2) {
		let seed = 20260923;
		const random = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 4294967296;
		};
		const groups = [...clusters.values()],
			samples: number[] = [];
		for (let i = 0; i < 4000; i++) {
			let sum = 0,
				count = 0;
			for (let j = 0; j < groups.length; j++)
				for (const value of groups[Math.floor(random() * groups.length)] ?? []) {
					sum += value;
					count++;
				}
			samples.push(sum / count);
		}
		samples.sort((x, y) => x - y);
		interval = [samples[99] as number, samples[3899] as number];
	}
	const costKnown = leftSummary.costComplete && rightSummary.costComplete;
	return {
		schema: "tripleteam-featurebench-comparison/v1",
		left: leftSummary,
		right: rightSummary,
		interpretation:
			a.model === b.model && a.provider === b.provider
				? "Same declared model/provider; verify endpoint, reasoning, tools and prices before attributing differences to the runtime"
				: "Product-plus-model comparison; not a causal estimate of coordination policy",
		paired: {
			planned: a.instanceIds.length,
			assessed: paired.length,
			leftOnlyResolved: wins,
			rightOnlyResolved: losses,
			bothResolved: paired.filter((id) => lm.get(id) && rm.get(id)).length,
			allAssessed,
			resolveRateDifference: allAssessed ? (wins - losses) / a.instanceIds.length : null,
			repositoryClusterBootstrap95: interval,
			clusters: clusters.size,
			resamples: 4000,
			seed: 20260923,
		},
		cost: {
			complete: costKnown,
			totalDifferenceUsd: costKnown ? leftSummary.knownCostUsd - rightSummary.knownCostUsd : null,
			leftCostPerResolvedUsd: leftSummary.costPerResolvedUsd,
			rightCostPerResolvedUsd: rightSummary.costPerResolvedUsd,
			includesFailedAttempts: true,
		},
		note: "Positive resolution difference favors left; negative cost difference favors left. Few repository clusters give weak uncertainty estimates. Missing verdicts suppress comparative accuracy and confidence intervals. Missing usage suppresses cost comparisons. Publish the full budget curve; a single point does not establish general superiority.",
	};
}
