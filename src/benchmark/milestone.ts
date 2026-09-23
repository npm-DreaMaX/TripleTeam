import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { LocalOrchestrator } from "../app/orchestrator.ts";
import { authoritativeArtifact, publishMilestoneTag } from "./artifact.ts";
import { assertBenchmarkConfiguration } from "./featurebench.ts";
import { BenchmarkLedger } from "./ledger.ts";
import { type FrozenBenchmarkManifest, hashJson, writeImmutableJson } from "./manifest.ts";
import { type BenchmarkTrial, readTrialUsage } from "./metrics.ts";

export interface ReleasedMilestone {
	id: string;
	statementPath: string;
}

/** Match the pinned harness's public queue format; never scan its future SRS directory. */
export function parseMilestoneQueue(text: string): ReleasedMilestone[] {
	if (!text.startsWith("# Task Queue\n") || !text.includes("## Available Tasks\n")) {
		throw new Error("Unsupported SWE-Milestone public queue format");
	}
	const result: ReleasedMilestone[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("- ")) continue;
		const match = /^- ([A-Za-z0-9._-]+): See SRS at (.+)$/.exec(line);
		if (!match?.[1] || !match[2] || basename(match[2]) !== `${match[1]}_SRS.md`) {
			throw new Error("Malformed released milestone entry");
		}
		if (result.some((entry) => entry.id === match[1])) throw new Error("Duplicate milestone queue entry");
		result.push({ id: match[1], statementPath: match[2] });
	}
	return result;
}

export async function readReleasedMilestones(
	queuePath: string,
): Promise<Array<ReleasedMilestone & { statement: string }>> {
	const allowed = await realpath(join(dirname(queuePath), "srs"));
	const released = parseMilestoneQueue(await readFile(queuePath, "utf8"));
	const result: Array<ReleasedMilestone & { statement: string }> = [];
	for (const entry of released) {
		const actual = await realpath(entry.statementPath);
		if (!actual.startsWith(allowed + sep) || dirname(actual) !== allowed) {
			throw new Error("Released SRS path escapes the public specification directory");
		}
		const statement = await readFile(actual, "utf8");
		if (!statement.trim()) throw new Error("Released milestone has an empty specification");
		result.push({ ...entry, statement });
	}
	return result;
}

export type MilestoneStepResult =
	| { state: "WAITING" | "DONE" | "BUDGET_EXHAUSTED"; reason: string }
	| { state: "SUBMITTED"; trial: BenchmarkTrial; tag: string };

/**
 * One released milestone becomes one frozen GoalContract. The previous submitted
 * integration commit is the next input; the official watcher alone unlocks tasks.
 */
export async function runMilestoneStep(input: {
	orchestrator: LocalOrchestrator;
	queuePath: string;
	frozen: FrozenBenchmarkManifest;
	outputDirectory: string;
}): Promise<MilestoneStepResult> {
	const { orchestrator, frozen, outputDirectory } = input;
	assertBenchmarkConfiguration(orchestrator, frozen);
	if (frozen.manifest.benchmark !== "swe-milestone") throw new Error("Expected a SWE-Milestone manifest");
	const ledger = new BenchmarkLedger(orchestrator);
	ledger.register(frozen);
	await writeImmutableJson(join(outputDirectory, "manifest.json"), frozen);
	const campaign = ledger.campaign(frozen.sha256, await orchestrator.workspaces.resolveRef("HEAD"));
	const mappings = ledger.list(frozen.sha256);
	if (mappings.filter((mapping) => mapping.submitted === 1).length === frozen.manifest.instanceIds.length) {
		return { state: "DONE", reason: "All scheduled milestones were submitted; external scores remain independent" };
	}
	// Finish a crash-interrupted publication even if the official queue has already moved on.
	let mapping = mappings.find((candidate) => candidate.submitted === 0);
	if (!mapping) {
		if (Date.now() - Date.parse(campaign.startedAt) >= frozen.manifest.budget.deadlineMs) {
			return { state: "BUDGET_EXHAUSTED", reason: "Campaign deadline expired while waiting for the official queue" };
		}
		const released = await readReleasedMilestones(resolve(input.queuePath));
		const next = released.find(
			(candidate) =>
				frozen.manifest.instanceIds.includes(candidate.id) &&
				!mappings.some((entry) => entry.instance_id === candidate.id),
		);
		if (!next)
			return { state: "WAITING", reason: "The official public task queue has not released another planned goal" };
		assertBenchmarkConfiguration(orchestrator, frozen, next.id);
		const usage = mappings.map((candidate) => readTrialUsage(orchestrator, candidate.run_id));
		if (usage.some((record) => !record.costComplete)) {
			return {
				state: "BUDGET_EXHAUSTED",
				reason: "Prior invocation cost is unknown; cannot authorize additional compute",
			};
		}
		const budget = {
			costLimitUsd: frozen.manifest.budget.costUsd - usage.reduce((sum, item) => sum + item.knownCostUsd, 0),
			tokenLimit:
				frozen.manifest.budget.tokens -
				usage.reduce(
					(sum, item) => sum + item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens,
					0,
				),
			deadlineMs: frozen.manifest.budget.deadlineMs - (Date.now() - Date.parse(campaign.startedAt)),
			maxExecutions: frozen.manifest.budget.maxExecutions - usage.reduce((sum, item) => sum + item.agentExecutions, 0),
		};
		if (Object.values(budget).some((remaining) => remaining <= 0)) {
			return { state: "BUDGET_EXHAUSTED", reason: "Campaign has exhausted its frozen total budget" };
		}
		const initialized = await orchestrator.initialize(next.statement, { inputCommit: campaign.currentHead, budget });
		mapping = ledger.attach(
			frozen.sha256,
			next.id,
			initialized.runId,
			hashJson({ id: next.id, statement: next.statement }),
		);
	}
	let failure: string | null = null;
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
	const artifact = await authoritativeArtifact(orchestrator, mapping.run_id);
	const runtime = (orchestrator.catalog.getRun(mapping.run_id).goalContract as { runtimeConfiguration?: unknown })
		.runtimeConfiguration;
	if (
		frozen.manifest.runtimeConfigHashes &&
		(!runtime || hashJson(runtime) !== frozen.manifest.runtimeConfigHashes[mapping.instance_id])
	)
		throw new Error("Milestone did not use its frozen runtime configuration");
	if (artifact.baseCommit !== campaign.currentHead)
		throw new Error("Milestone did not build on the campaign integration head");
	const delivery = await orchestrator.result(mapping.run_id);
	const trial = ledger.recordResult({
		schema: "tripleteam-benchmark-trial/v1",
		manifestHash: frozen.sha256,
		instanceId: mapping.instance_id,
		runId: mapping.run_id,
		state: failure
			? "ERROR"
			: artifact.state === "COMPLETED"
				? "SUBMITTED"
				: artifact.state === "BLOCKED"
					? "BLOCKED"
					: "CANCELLED",
		deliveryResult: delivery.result,
		commit: artifact.commit,
		tree: artifact.tree,
		startedAt: mapping.started_at,
		finishedAt: new Date().toISOString(),
		error: failure,
		usage: readTrialUsage(orchestrator, mapping.run_id),
	});
	// A submission tag denotes an attempted artifact. It does not mark internal or external acceptance.
	const tag = await publishMilestoneTag(orchestrator.repositoryRoot, mapping.instance_id, artifact.commit);
	await writeImmutableJson(join(outputDirectory, mapping.instance_id, "trial.json"), trial);
	ledger.advance(frozen.sha256, mapping.instance_id, campaign.currentHead, artifact.commit);
	return { state: "SUBMITTED", trial, tag };
}
