import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalOrchestrator } from "../app/orchestrator.ts";
import { artifactPatch, authoritativeArtifact } from "./artifact.ts";
import { type FrozenBenchmarkManifest, hashJson, writeImmutableJson } from "./manifest.ts";
import { type BenchmarkTrial, readTrialUsage } from "./metrics.ts";

/** Only these public fields cross from evaluator preparation into agent execution. */
export interface FeatureBenchTask {
	instance_id: string;
	problem_statement: string;
	repo: string;
	image_name: string;
	prepared_base_commit: string;
	prepared_base_tree: string;
}

export function parseFeatureBenchTask(value: unknown): FeatureBenchTask {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid public task envelope");
	const task = value as Record<string, unknown>;
	const allowed = new Set([
		"instance_id",
		"problem_statement",
		"repo",
		"image_name",
		"prepared_base_commit",
		"prepared_base_tree",
	]);
	if (Object.keys(task).some((key) => !allowed.has(key))) {
		throw new Error("Task envelope contains non-public or unsupported fields; do not pass the raw benchmark row");
	}
	for (const key of allowed) {
		if (typeof task[key] !== "string" || !task[key].trim()) throw new Error(`Public task lacks ${key}`);
	}
	if (!/^[A-Za-z0-9._-]+$/.test(task.instance_id as string)) throw new Error("Invalid instance identifier");
	for (const key of ["prepared_base_commit", "prepared_base_tree"]) {
		if (!/^[a-f0-9]{40,64}$/.test(task[key] as string)) throw new Error(`${key} must be an exact object identifier`);
	}
	return task as unknown as FeatureBenchTask;
}

export interface FeatureBenchPrediction {
	instance_id: string;
	model_name_or_path: string;
	model_patch: string;
	agent: "tripleteam";
	model: string;
	n_attempt: 1;
	success: boolean;
	error: string | null;
	agent_exit_status: string;
	task_metadata: { manifest_hash: string; run_id: string; submitted_commit: string; submitted_tree: string };
}

export function assertBenchmarkConfiguration(orchestrator: LocalOrchestrator, frozen: FrozenBenchmarkManifest): void {
	const execution = orchestrator.config.execution;
	if (!execution || execution.decisionMode !== "noninteractive") {
		throw new Error("Benchmark runtime requires execution.decisionMode=noninteractive");
	}
	const manifest = frozen.manifest;
	if (hashJson(JSON.parse(JSON.stringify(execution))) !== manifest.executionConfigHash) {
		throw new Error("Runtime execution policy differs from the frozen manifest");
	}
	if (execution.model !== manifest.model || execution.provider !== manifest.provider) {
		throw new Error("Runtime model/provider differs from the frozen manifest");
	}
	if (
		execution.costLimitUsd !== manifest.budget.costUsd ||
		execution.tokenLimit !== manifest.budget.tokens ||
		execution.deadlineMs !== manifest.budget.deadlineMs ||
		execution.maxExecutions !== manifest.budget.maxExecutions
	) {
		throw new Error("Runtime budget differs from the frozen manifest");
	}
}

export async function exportFeatureBench(input: {
	orchestrator: LocalOrchestrator;
	runId: string;
	task: FeatureBenchTask;
	frozen: FrozenBenchmarkManifest;
	outputDirectory: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	persistTrial?: (trial: BenchmarkTrial) => BenchmarkTrial;
}): Promise<{ prediction: FeatureBenchPrediction; trial: BenchmarkTrial }> {
	const { orchestrator, task, frozen } = input;
	if (frozen.manifest.benchmark !== "featurebench" || !frozen.manifest.instanceIds.includes(task.instance_id)) {
		throw new Error("Task is not in this FeatureBench manifest");
	}
	const artifact = await authoritativeArtifact(orchestrator, input.runId);
	const contract = orchestrator.catalog.getRun(input.runId).goalContract as { executionPolicy?: unknown };
	if (!contract.executionPolicy || hashJson(contract.executionPolicy) !== frozen.manifest.executionConfigHash) {
		throw new Error("Submitted run did not use the frozen execution policy");
	}
	if (artifact.baseCommit !== task.prepared_base_commit) throw new Error("Run used a different masked task baseline");
	if ((await orchestrator.workspaces.treeHash(task.prepared_base_commit)) !== task.prepared_base_tree) {
		throw new Error("Prepared task tree does not match its frozen identity");
	}
	const report = await orchestrator.result(input.runId);
	const prediction: FeatureBenchPrediction = {
		instance_id: task.instance_id,
		model_name_or_path: `tripleteam/${frozen.manifest.model}`,
		model_patch: await artifactPatch(orchestrator.repositoryRoot, task.prepared_base_commit, artifact),
		agent: "tripleteam",
		model: frozen.manifest.model,
		n_attempt: 1,
		success: artifact.state === "COMPLETED" && !input.error,
		error: input.error ?? (artifact.state === "COMPLETED" ? null : artifact.state),
		agent_exit_status: report.result,
		task_metadata: {
			manifest_hash: frozen.sha256,
			run_id: input.runId,
			submitted_commit: artifact.commit,
			submitted_tree: artifact.tree,
		},
	};
	const trial: BenchmarkTrial = {
		schema: "tripleteam-benchmark-trial/v1",
		manifestHash: frozen.sha256,
		instanceId: task.instance_id,
		runId: input.runId,
		state: input.error
			? "ERROR"
			: artifact.state === "COMPLETED"
				? "SUBMITTED"
				: artifact.state === "CANCELLED"
					? "CANCELLED"
					: "BLOCKED",
		deliveryResult: report.result,
		commit: artifact.commit,
		tree: artifact.tree,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt ?? new Date().toISOString(),
		error: prediction.error,
		usage: readTrialUsage(orchestrator, input.runId),
	};
	const persistedTrial = input.persistTrial?.(trial) ?? trial;
	if (persistedTrial.commit !== artifact.commit || persistedTrial.tree !== artifact.tree) {
		throw new Error("Previously sealed trial differs from the authoritative submission");
	}
	const directory = join(input.outputDirectory, task.instance_id);
	await writeImmutableJson(join(directory, "task.json"), task);
	await writeImmutableJson(join(directory, "prediction.json"), prediction);
	await writeImmutableJson(join(directory, "trial.json"), persistedTrial);
	return { prediction, trial: persistedTrial };
}

/** The returned JSONL has every planned goal, including never-started/failed goals. */
export async function collectFeatureBench(frozen: FrozenBenchmarkManifest, outputDirectory: string): Promise<string> {
	if (frozen.manifest.benchmark !== "featurebench") throw new Error("Expected a FeatureBench manifest");
	const predictions: unknown[] = [];
	for (const instanceId of frozen.manifest.instanceIds) {
		try {
			const prediction = JSON.parse(await readFile(join(outputDirectory, instanceId, "prediction.json"), "utf8"));
			if (prediction.instance_id !== instanceId || prediction.task_metadata?.manifest_hash !== frozen.sha256) {
				throw new Error("Prediction belongs to another experiment");
			}
			predictions.push(prediction);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			predictions.push({
				instance_id: instanceId,
				model_name_or_path: `tripleteam/${frozen.manifest.model}`,
				model_patch: "",
				agent: "tripleteam",
				model: frozen.manifest.model,
				n_attempt: 1,
				success: false,
				error: "MISSING_TRIAL",
				agent_exit_status: "Missing",
			});
		}
	}
	return predictions.map((prediction) => JSON.stringify(prediction)).join("\n") + "\n";
}
