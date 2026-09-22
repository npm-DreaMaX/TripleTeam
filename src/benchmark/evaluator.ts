import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureBenchPrediction } from "./featurebench.ts";
import type { FrozenBenchmarkManifest } from "./manifest.ts";
import type { ExternalVerdict } from "./metrics.ts";

/** Offline only: bind official reports to the exact exported patch, never to an agent's claim. */
export async function importFeatureBenchVerdicts(input: {
	frozen: FrozenBenchmarkManifest;
	predictionDirectory: string;
	evaluationDirectory: string;
}): Promise<{ verdicts: ExternalVerdict[]; missingInstanceIds: string[] }> {
	if (input.frozen.manifest.benchmark !== "featurebench") throw new Error("Expected a FeatureBench experiment");
	const verdicts: ExternalVerdict[] = [];
	const missingInstanceIds: string[] = [];
	for (const instanceId of input.frozen.manifest.instanceIds) {
		try {
			const prediction = JSON.parse(
				await readFile(join(input.predictionDirectory, instanceId, "prediction.json"), "utf8"),
			) as FeatureBenchPrediction;
			if (prediction.instance_id !== instanceId || prediction.task_metadata.manifest_hash !== input.frozen.sha256) {
				throw new Error("Prediction belongs to another frozen experiment");
			}
			const directory = join(input.evaluationDirectory, "eval_outputs", instanceId, "attempt-1");
			const patch = await readFile(join(directory, "patch.diff"), "utf8");
			if (patch !== prediction.model_patch) throw new Error(`Evaluator tested another patch for ${instanceId}`);
			const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8")) as Record<
				string,
				{ n_attempt?: number; featurebench_eval_completed?: boolean; resolved?: boolean }
			>;
			const instance = report[instanceId];
			if (
				instance?.n_attempt !== 1 ||
				instance.featurebench_eval_completed !== true ||
				typeof instance.resolved !== "boolean"
			) {
				throw new Error(`Official evaluator report is incomplete or has an unsupported schema: ${instanceId}`);
			}
			verdicts.push({
				instanceId,
				manifestHash: input.frozen.sha256,
				tree: prediction.task_metadata.submitted_tree,
				resolved: instance.resolved,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			missingInstanceIds.push(instanceId);
		}
	}
	return { verdicts, missingInstanceIds };
}
