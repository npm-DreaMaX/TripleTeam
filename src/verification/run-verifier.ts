import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProjectPaths } from "../config/paths.ts";
import {
	checkCommandVersion,
	evidenceClassForCheck,
	type ProjectConfig,
	parseCheckCommand,
} from "../config/project.ts";
import type { ControlCatalog } from "../control/catalog.ts";
import { ContractVerifier } from "../control/contract-verifier.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { GitWorkspaceManager } from "../workspace/git.ts";
import type { AssuranceService } from "./assurance-service.ts";
import type { CheckRunner } from "./check-runner.ts";

export interface RunVerificationResult {
	status: "PASSED" | "FAILED" | "ERROR";
	treeHash: string;
	checkIds: string[];
}

export class RunVerifier {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly workspaces: GitWorkspaceManager,
		private readonly checks: CheckRunner,
		private readonly paths: ProjectPaths,
		private readonly config: ProjectConfig,
		private readonly assurance?: AssuranceService,
	) {}

	async verify(runId: string): Promise<RunVerificationResult> {
		const run = this.catalog.getRun(runId);
		const contract = run.goalContract as { runChecks?: unknown };
		const specifications = Array.isArray(contract?.runChecks)
			? contract.runChecks.map((value, index) => parseCheckCommand(value, `goalContract.runChecks[${index}]`))
			: this.config.runChecks;
		if (specifications.length === 0) throw new Error("Final verification requires at least one frozen check");
		const publishedHead = await this.workspaces.resolveRef(run.integrationRef);
		if (publishedHead !== run.integrationHead) {
			throw new Error("Integration ref diverged from authoritative run state before final verification");
		}
		const treeHash = await this.workspaces.treeHash(run.integrationHead);
		this.kernel.bindIntegrationTree(runId, run.integrationHead, treeHash);
		await new ContractVerifier(this.kernel, this.catalog, this.workspaces).assertPreserved(runId, run.integrationHead);
		const checkIds: string[] = [];
		for (const specification of specifications) {
			const worktree = await this.workspaces.createWorktree("run-check-" + randomUUID(), run.integrationHead);
			try {
				const remainingMs = this.kernel.computeSnapshot(runId).remainingMs;
				if (remainingMs === 0) throw new Error("Run deadline exhausted before final verification");
				const signal = remainingMs === null ? undefined : AbortSignal.timeout(Math.max(1, remainingMs));
				const startedAt = new Date().toISOString();
				const executed = await this.checks.run(
					specification,
					{
						cwd: worktree.path,
						baseCommit: run.inputCommit,
						subjectCommit: run.integrationHead,
						runInputCommit: run.inputCommit,
						artifactDirectory: join(this.paths.artifacts, run.id, "run-final"),
					},
					signal,
				);
				const finishedAt = new Date().toISOString();
				const checkId = this.kernel.recordCheckResult({
					runId: run.id,
					subjectKind: "RUN",
					subjectId: run.id,
					treeHash,
					checkKind: specification.name,
					checkVersion: checkCommandVersion(specification),
					evidenceClass: evidenceClassForCheck(specification),
					command: executed.command,
					environmentHash: executed.environmentHash,
					state: executed.state,
					exitCode: executed.exitCode,
					stdoutPath: executed.stdoutPath,
					stderrPath: executed.stderrPath,
					result: executed.result,
					artifacts: [
						{ ...executed.stdoutArtifact, kind: "CHECK_STDOUT", storageKind: "LOCAL_FILE" as const },
						{ ...executed.stderrArtifact, kind: "CHECK_STDERR", storageKind: "LOCAL_FILE" as const },
					].map(({ path, ...artifact }) => ({ ...artifact, storageLocator: path })),
					actor: { kind: "SYSTEM", id: "run-verification-service" },
				});
				checkIds.push(checkId);
				this.kernel.recordUsage({
					runId: run.id,
					kind: "CHECK",
					phase: `RUN:${specification.name}`,
					startedAt,
					finishedAt,
					details: { checkId, state: executed.state },
				});
				if (executed.state !== "PASSED") return { status: executed.state, treeHash, checkIds };
			} finally {
				await this.workspaces.removeWorktree(worktree);
			}
		}
		if (this.assurance) {
			const independent = await this.assurance.evaluate(
				this.catalog.listTasks(runId, ["ACCEPTED"]).map((t) => t.id),
				run.integrationHead,
				"RUN",
				run.id,
			);
			checkIds.push(...independent.checkIds);
			if (independent.status !== "PASSED") return { status: independent.status, treeHash, checkIds };
		}
		if (
			this.catalog.getRun(runId).integrationHead !== run.integrationHead ||
			(await this.workspaces.resolveRef(run.integrationRef)) !== run.integrationHead
		) {
			throw new Error("Integration head moved during final verification");
		}
		return { status: "PASSED", treeHash, checkIds };
	}
}
