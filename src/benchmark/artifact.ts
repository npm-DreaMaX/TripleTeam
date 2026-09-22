import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalOrchestrator } from "../app/orchestrator.ts";

const execFileAsync = promisify(execFile);

export async function benchmarkGit(repository: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return result.stdout;
}

export interface BenchmarkArtifact {
	runId: string;
	baseCommit: string;
	commit: string;
	tree: string;
	integrationRef: string;
	state: string;
}

/** Only SQLite + the CAS integration ref can identify a benchmark submission. */
export async function authoritativeArtifact(
	orchestrator: LocalOrchestrator,
	runId: string,
): Promise<BenchmarkArtifact> {
	const run = orchestrator.catalog.getRun(runId);
	if (run.state === "OPEN") throw new Error("An open run cannot be exported as a final benchmark submission");
	const commit = await orchestrator.workspaces.resolveRef(run.integrationRef);
	if (commit !== run.integrationHead) throw new Error("Integration ref disagrees with authoritative SQLite state");
	const tree = await orchestrator.workspaces.treeHash(commit);
	return {
		runId,
		baseCommit: run.inputCommit,
		commit,
		tree,
		integrationRef: run.integrationRef,
		state: run.state,
	};
}

export async function artifactPatch(
	repository: string,
	baseCommit: string,
	artifact: BenchmarkArtifact,
): Promise<string> {
	for (const commit of [baseCommit, artifact.commit]) {
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Patch endpoints must be exact Git object identifiers");
	}
	await benchmarkGit(repository, ["merge-base", "--is-ancestor", baseCommit, artifact.commit]);
	return benchmarkGit(repository, [
		"diff",
		"--binary",
		"--full-index",
		"--no-ext-diff",
		baseCommit,
		artifact.commit,
		"--",
	]);
}

/** Idempotent CAS: benchmark tags never move after this adapter has submitted them. */
export async function publishMilestoneTag(repository: string, milestoneId: string, commit: string): Promise<string> {
	if (!/^[A-Za-z0-9._-]+$/.test(milestoneId)) throw new Error("Invalid milestone identifier");
	if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Submission must reference an exact commit");
	const tag = "refs/tags/agent-impl-" + milestoneId;
	let current: string | undefined;
	try {
		current = (await benchmarkGit(repository, ["rev-parse", "--verify", tag])).trim();
	} catch (error) {
		if ((error as { code?: number }).code !== 128) throw error;
	}
	if (current === commit) return tag;
	if (current) throw new Error(`Milestone tag already points to another artifact: ${milestoneId}`);
	await benchmarkGit(repository, ["update-ref", tag, commit, "0".repeat(commit.length)]);
	return tag;
}
