import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProjectPaths } from "../config/paths.ts";
import {
	acceptancePolicyForRun,
	checkCommandVersion,
	evidenceClassForCheck,
	type ProjectConfig,
} from "../config/project.ts";
import type { ControlCatalog } from "../control/catalog.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { GitWorkspaceManager } from "../workspace/git.ts";
import type { CheckRunner } from "./check-runner.ts";

export interface BaselineReceipt {
	inputCommit: string;
	treeHash: string;
	policyHash: string;
	checks: {
		name: string;
		version: string;
		scope?: string[];
		state: "PASSED" | "FAILED" | "ERROR";
		checkId: string;
		errorCode?: string;
	}[];
}

export function baselineReceipt(catalog: ControlCatalog, runId: string): BaselineReceipt | null {
	const action = catalog.listControlActions(runId).findLast((entry) => entry.kind === "BASELINE_VERIFIED");
	return action ? (JSON.parse(action.detail_json) as BaselineReceipt) : null;
}

/** Baseline observations inform decomposition; they never satisfy candidate or final checks. */
export class BaselineVerifier {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly git: GitWorkspaceManager,
		private readonly runner: CheckRunner,
		private readonly paths: ProjectPaths,
		private readonly config: ProjectConfig,
	) {}

	async verify(runId: string): Promise<BaselineReceipt | null> {
		const run = this.catalog.getRun(runId);
		const goal = run.goalContract as { baselinePolicy?: ProjectConfig["baseline"] };
		if (!goal.baselinePolicy?.enabled) return null; // Old runs retain their frozen protocol.
		const checks = acceptancePolicyForRun(run.goalContract, this.config).integrationChecks;
		const policyHash = createHash("sha256")
			.update(JSON.stringify(checks.map(checkCommandVersion)))
			.digest("hex");
		const previous = baselineReceipt(this.catalog, runId);
		if (
			previous?.inputCommit === run.inputCommit &&
			previous.policyHash === policyHash &&
			previous.checks.every((check) => check.state !== "ERROR" && !check.errorCode)
		) {
			return previous;
		}
		if (previous)
			this.kernel.recordControlAction({
				runId,
				kind: "BASELINE_RECHECK",
				detail: {
					previousPolicyHash: previous.policyHash,
					reason: "Recheck unusable environment on explicit run continuation",
				},
			});
		const receipt: BaselineReceipt = {
			inputCommit: run.inputCommit,
			treeHash: await this.git.treeHash(run.inputCommit),
			policyHash,
			checks: [],
		};
		const remainingMs = this.kernel.computeSnapshot(runId).remainingMs;
		const signal = AbortSignal.timeout(Math.max(1, Math.min(goal.baselinePolicy.timeoutMs, remainingMs ?? Infinity)));
		this.kernel.recordControlAction({
			runId,
			kind: "BASELINE_STARTED",
			detail: { inputCommit: run.inputCommit, policyHash },
		});
		for (const specification of checks) {
			const workspace = await this.git.createWorktree("baseline-" + randomUUID(), run.inputCommit);
			try {
				const startedAt = new Date().toISOString();
				const executed = await this.runner.run(
					specification,
					{
						cwd: workspace.path,
						baseCommit: run.inputCommit,
						subjectCommit: run.inputCommit,
						runInputCommit: run.inputCommit,
						artifactDirectory: join(this.paths.artifacts, runId, "baseline"),
					},
					signal,
				);
				const id = this.kernel.recordCheckResult({
					runId,
					subjectKind: "RUN",
					subjectId: runId,
					treeHash: receipt.treeHash,
					checkKind: "baseline:" + specification.name,
					checkVersion: checkCommandVersion(specification),
					evidenceClass: evidenceClassForCheck(specification),
					command: executed.command,
					environmentHash: executed.environmentHash,
					state: executed.state,
					exitCode: executed.exitCode,
					stdoutPath: executed.stdoutPath,
					stderrPath: executed.stderrPath,
					result: { ...executed.result, baseline: true },
					artifacts: [
						{ ...executed.stdoutArtifact, kind: "CHECK_STDOUT", storageKind: "LOCAL_FILE" as const },
						{ ...executed.stderrArtifact, kind: "CHECK_STDERR", storageKind: "LOCAL_FILE" as const },
					].map(({ path, ...artifact }) => ({ ...artifact, storageLocator: path })),
					actor: { kind: "SYSTEM", id: "baseline-verifier" },
				});
				receipt.checks.push({
					name: specification.name,
					version: checkCommandVersion(specification),
					...(specification.scope ? { scope: specification.scope } : {}),
					state: executed.state,
					checkId: id,
					...(executed.result.errorCode ? { errorCode: executed.result.errorCode } : {}),
				});
				this.kernel.recordUsage({
					runId,
					kind: "CHECK",
					phase: "BASELINE:" + specification.name,
					startedAt,
					finishedAt: new Date().toISOString(),
					details: { checkId: id, state: executed.state },
				});
			} finally {
				await this.git.removeWorktree(workspace);
			}
		}
		this.kernel.recordControlAction({ runId, kind: "BASELINE_VERIFIED", detail: receipt });
		this.assertUsable(receipt);
		return receipt;
	}

	private assertUsable(receipt: BaselineReceipt) {
		const broken = receipt.checks.filter((check) => check.state === "ERROR" || check.errorCode);
		if (broken.length)
			throw new Error(
				"Baseline environment or integrity is unusable: " +
					broken.map((c) => `${c.name} (${c.errorCode ?? c.state}, evidence ${c.checkId})`).join(", "),
			);
	}
}
