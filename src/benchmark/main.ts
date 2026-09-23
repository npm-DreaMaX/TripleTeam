#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalOrchestrator } from "../app/orchestrator.ts";
import { loadProjectConfig } from "../config/project.ts";
import { compareFeatureBench, type ExperimentResults } from "./comparison.ts";
import { importFeatureBenchVerdicts } from "./evaluator.ts";
import { collectFeatureBench, exportFeatureBench, parseFeatureBenchTask } from "./featurebench.ts";
import { freezeManifest, hashJson, readFrozenManifest, writeImmutableJson } from "./manifest.ts";
import { type BenchmarkTrial, type ExternalVerdict, summarizeTrials } from "./metrics.ts";
import { runMilestoneStep } from "./milestone.ts";
import { runFeatureBench } from "./runner.ts";

const HELP = `TripleTeam benchmark adapter (model execution is explicit)

  config-hash REPOSITORY
  freeze MANIFEST_INPUT_JSON FROZEN_OUTPUT_JSON
  featurebench-run REPOSITORY PUBLIC_TASK_JSON FROZEN_MANIFEST OUTPUT_DIRECTORY
  featurebench-export REPOSITORY RUN_ID PUBLIC_TASK_JSON FROZEN_MANIFEST OUTPUT_DIRECTORY
  featurebench-collect FROZEN_MANIFEST OUTPUT_DIRECTORY OUTPUT_JSONL
  featurebench-verdicts FROZEN_MANIFEST OUTPUT_DIRECTORY EVALUATION_DIRECTORY VERDICTS_JSON
  milestone-step REPOSITORY TASK_QUEUE_MD FROZEN_MANIFEST OUTPUT_DIRECTORY
  milestone-watch REPOSITORY TASK_QUEUE_MD FROZEN_MANIFEST OUTPUT_DIRECTORY
  summarize FROZEN_MANIFEST OUTPUT_DIRECTORY [EXTERNAL_VERDICTS_JSON]
  compare-featurebench LEFT_MANIFEST LEFT_OUTPUT LEFT_VERDICTS RIGHT_MANIFEST RIGHT_OUTPUT RIGHT_VERDICTS

Only featurebench-run / milestone-step / milestone-watch may call models.
SWE-Milestone queue unlock and hidden evaluation remain in the official harness.
`;

function arg(args: string[], index: number): string {
	const value = args[index];
	if (!value) throw new Error("Missing command argument.\n" + HELP);
	return value;
}

async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readExperiment(manifest: string, directory: string, verdictFile?: string): Promise<ExperimentResults> {
	const frozen = await readFrozenManifest(manifest);
	const trials: BenchmarkTrial[] = [];
	for (const id of frozen.manifest.instanceIds) {
		try {
			trials.push((await json(join(directory, id, "trial.json"))) as BenchmarkTrial);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return { frozen, trials, verdicts: verdictFile ? ((await json(verdictFile)) as ExternalVerdict[]) : [] };
}

async function main(args: string[]): Promise<void> {
	const command = args[0];
	if (!command || command === "--help" || command === "help") {
		process.stdout.write(HELP);
		return;
	}
	if (command === "config-hash") {
		const config = await loadProjectConfig(arg(args, 1));
		const execution = JSON.parse(JSON.stringify(config.execution));
		process.stdout.write(
			JSON.stringify(
				{
					execution,
					executionConfigHash: hashJson(execution),
					runtimeConfigHash: hashJson(JSON.parse(JSON.stringify(config))),
				},
				null,
				2,
			) + "\n",
		);
		return;
	}
	if (command === "freeze") {
		const frozen = freezeManifest(await json(arg(args, 1)));
		await writeImmutableJson(arg(args, 2), frozen);
		process.stdout.write(JSON.stringify(frozen) + "\n");
		return;
	}
	if (command === "featurebench-collect") {
		const frozen = await readFrozenManifest(arg(args, 1));
		const output = await collectFeatureBench(frozen, arg(args, 2));
		const destination = arg(args, 3);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, output, { flag: "wx", mode: 0o600 });
		process.stdout.write(JSON.stringify({ output: destination, planned: frozen.manifest.instanceIds.length }) + "\n");
		return;
	}
	if (command === "featurebench-verdicts") {
		const result = await importFeatureBenchVerdicts({
			frozen: await readFrozenManifest(arg(args, 1)),
			predictionDirectory: arg(args, 2),
			evaluationDirectory: arg(args, 3),
		});
		await writeImmutableJson(arg(args, 4), result.verdicts);
		process.stdout.write(
			JSON.stringify({ imported: result.verdicts.length, missingInstanceIds: result.missingInstanceIds }) + "\n",
		);
		return;
	}
	if (command === "summarize") {
		const { frozen, trials, verdicts } = await readExperiment(arg(args, 1), arg(args, 2), args[3]);
		process.stdout.write(JSON.stringify(summarizeTrials(frozen, trials, verdicts), null, 2) + "\n");
		return;
	}
	if (command === "compare-featurebench") {
		const left = await readExperiment(arg(args, 1), arg(args, 2), arg(args, 3));
		const right = await readExperiment(arg(args, 4), arg(args, 5), arg(args, 6));
		process.stdout.write(JSON.stringify(compareFeatureBench(left, right), null, 2) + "\n");
		return;
	}
	if (!["featurebench-run", "featurebench-export", "milestone-step", "milestone-watch"].includes(command)) {
		throw new Error("Unknown benchmark command: " + command);
	}
	const repository = arg(args, 1);
	const exporting = command === "featurebench-export";
	const source = arg(args, exporting ? 3 : 2);
	const frozen = await readFrozenManifest(arg(args, exporting ? 4 : 3));
	const outputDirectory = arg(args, exporting ? 5 : 4);
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		if (command === "featurebench-run" || exporting) {
			const task = parseFeatureBenchTask(await json(source));
			if (exporting) {
				const runId = arg(args, 2);
				const row = orchestrator.database.sql
					.prepare("SELECT created_at, updated_at FROM runs WHERE id = ?")
					.get<{ created_at: string; updated_at: string }>(runId);
				if (!row) throw new Error("Run does not exist");
				const result = await exportFeatureBench({
					orchestrator,
					runId,
					task,
					frozen,
					outputDirectory,
					startedAt: row.created_at,
					finishedAt: row.updated_at,
				});
				process.stdout.write(JSON.stringify(result.trial) + "\n");
			} else {
				const result = await runFeatureBench({ orchestrator, task, frozen, outputDirectory });
				process.stdout.write(JSON.stringify(result.trial) + "\n");
			}
			return;
		}
		for (;;) {
			const result = await runMilestoneStep({ orchestrator, queuePath: source, frozen, outputDirectory });
			process.stdout.write(JSON.stringify(result) + "\n");
			if (command === "milestone-step" || result.state === "DONE" || result.state === "BUDGET_EXHAUSTED") return;
			if (result.state === "WAITING") await sleep(2_000);
		}
	} finally {
		orchestrator.close();
	}
}

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
	process.exitCode = 1;
});
