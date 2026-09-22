import { join } from "node:path";
import type { LocalOrchestrator } from "../app/orchestrator.ts";
import { assertBenchmarkConfiguration, exportFeatureBench, type FeatureBenchTask } from "./featurebench.ts";
import { BenchmarkLedger } from "./ledger.ts";
import { type FrozenBenchmarkManifest, hashJson, writeImmutableJson } from "./manifest.ts";

/** Only invoked by an explicit `featurebench-run` command; exports and tests never start a model. */
export async function runFeatureBench(input: {
	orchestrator: LocalOrchestrator;
	task: FeatureBenchTask;
	frozen: FrozenBenchmarkManifest;
	outputDirectory: string;
}) {
	const { orchestrator, task, frozen, outputDirectory } = input;
	assertBenchmarkConfiguration(orchestrator, frozen);
	if (frozen.manifest.benchmark !== "featurebench" || !frozen.manifest.instanceIds.includes(task.instance_id)) {
		throw new Error("Task does not belong to this FeatureBench experiment");
	}
	if ((await orchestrator.workspaces.treeHash(task.prepared_base_commit)) !== task.prepared_base_tree) {
		throw new Error("Prepared task baseline changed");
	}
	await writeImmutableJson(join(outputDirectory, "manifest.json"), frozen);
	const ledger = new BenchmarkLedger(orchestrator);
	ledger.register(frozen);
	const inputHash = hashJson(task);
	let mapping = ledger.get(frozen.sha256, task.instance_id);
	if (mapping && mapping.input_hash !== inputHash) throw new Error("Public task changed after the run started");
	if (!mapping) {
		const initialized = await orchestrator.initialize(task.problem_statement, {
			inputCommit: task.prepared_base_commit,
		});
		mapping = ledger.attach(frozen.sha256, task.instance_id, initialized.runId, inputHash);
	}
	let failure: string | undefined;
	if (!mapping.result_json && orchestrator.catalog.getRun(mapping.run_id).state === "OPEN") {
		try {
			await orchestrator.continue(mapping.run_id);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			if (orchestrator.catalog.getRun(mapping.run_id).state === "OPEN") {
				await orchestrator.cancel(mapping.run_id, "Benchmark execution failed: " + failure);
			}
		}
	}
	// Completed output is idempotent across process restarts; timestamps are taken from the ledger.
	const previous = mapping.result_json
		? (JSON.parse(mapping.result_json) as { finishedAt: string; error: string | null })
		: null;
	const result = await exportFeatureBench({
		orchestrator,
		runId: mapping.run_id,
		task,
		frozen,
		outputDirectory,
		startedAt: mapping.started_at,
		finishedAt: previous?.finishedAt,
		error: previous?.error ?? failure,
		persistTrial: (trial) => ledger.recordResult(trial),
	});
	return result;
}
