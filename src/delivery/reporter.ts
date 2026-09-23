import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectPaths } from "../config/paths.ts";
import type { ControlCatalog } from "../control/catalog.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { DeliveryResult } from "../domain/model.ts";
import type { GitWorkspaceManager } from "../workspace/git.ts";

export interface DeliveryReport {
	reportId: string;
	runId: string;
	result: DeliveryResult;
	finalCommit: string;
	finalTreeHash: string;
	deliveryRef: string | null;
	manifestPath: string;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, null, 2) + "\n";
}

async function writeImmutable(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		const existing = await readFile(path, "utf8");
		if (existing !== content) throw new Error("Existing terminal manifest differs from authoritative state");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = path + ".tmp-" + process.pid;
	await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
}

export class DeliveryReporter {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly workspaces: GitWorkspaceManager,
		private readonly paths: ProjectPaths,
	) {}

	async ensure(runId: string): Promise<DeliveryReport> {
		const run = this.catalog.getRun(runId);
		if (run.state === "OPEN") throw new Error("An open run has no terminal delivery report");
		const finalTreeHash = await this.workspaces.treeHash(run.integrationHead);
		const runEvidence = this.catalog.listPassedRunEvidence(run.id, finalTreeHash);
		const result: DeliveryResult =
			run.state === "COMPLETED"
				? runEvidence.some(
						(evidence) => evidence.evidenceClass === "BEHAVIORAL" || evidence.evidenceClass === "EXTERNAL",
					)
					? "VERIFIED_DELIVERY"
					: "STRUCTURAL_HANDOFF"
				: run.state;
		const deliveryRef =
			result === "VERIFIED_DELIVERY" || result === "STRUCTURAL_HANDOFF"
				? await this.workspaces.publishDeliveryRef(run.id, run.integrationHead)
				: null;
		const tasks = this.catalog.listTasks(run.id).map((task) => ({
			id: task.id,
			title: task.title,
			state: task.state,
			revision: task.revision,
			attemptEpoch: task.attemptEpoch,
		}));
		const proposals = this.catalog.listTaskChangeProposals(run.id).map((proposal) => ({
			id: proposal.id,
			state: proposal.state,
			sourceActorKind: proposal.sourceActorKind,
			decisionReason: proposal.decisionReason,
		}));
		const evidenceEvents = this.catalog
			.listEvents(run.id, 5_000)
			.filter(
				(event) =>
					event.eventType.startsWith("Check") ||
					event.eventType.startsWith("Review") ||
					event.eventType.startsWith("Integration") ||
					event.eventType === "TaskAccepted" ||
					event.eventType === "RunCompleted" ||
					event.eventType === "RunBlocked" ||
					event.eventType === "RunCancelled",
			)
			.map((event) => ({
				id: event.id,
				type: event.eventType,
				aggregateType: event.aggregateType,
				aggregateId: event.aggregateId,
				payload: event.payload,
				createdAt: event.createdAt,
			}));
		const summary = {
			schema: "verified-delivery/v2",
			run: {
				id: run.id,
				version: run.version,
				objective: run.objective,
				goalContract: run.goalContract,
				result,
				terminalReason: run.terminalReason,
				inputCommit: run.inputCommit,
				finalCommit: run.integrationHead,
				finalTreeHash,
				deliveryRef,
			},
			tasks,
			proposals,
			accounting: {
				...this.catalog.usageSummary(run.id),
				scope: "Recorded model API usage; durationMs sums overlapping phase records, not wall time",
				missingUsage: "UNKNOWN",
			},
			coordination: {
				assurancePlans: this.kernel.assurance.list(run.id),
				contracts: tasks
					.map((task) => {
						const contract = this.catalog.getCoordinationContract(task.id);
						return contract ? { ...contract, evidence: this.catalog.listContractEvidence(contract.id) } : null;
					})
					.filter((contract) => contract !== null),
				actions: this.catalog
					.listControlActions(run.id)
					.map(({ detail_json, ...action }) => ({ ...action, detail: JSON.parse(detail_json) })),
			},
			evidence: {
				runChecks: runEvidence,
				events: evidenceEvents,
				artifacts: this.catalog.listArtifacts(run.id, 5_000),
			},
		};
		const manifestPath = join(this.paths.artifacts, run.id, `terminal-${run.version}.json`);
		await writeImmutable(manifestPath, stableJson(summary));
		const reportId = createHash("sha256").update(`${run.id}:${run.version}`).digest("hex");
		this.kernel.recordRunReport({
			id: reportId,
			runId: run.id,
			runVersion: run.version,
			result,
			finalCommit: run.integrationHead,
			finalTreeHash,
			deliveryRef: deliveryRef ?? undefined,
			manifestPath,
			summary,
			actor: { kind: "SYSTEM", id: "delivery-reporter" },
		});
		return {
			reportId,
			runId: run.id,
			result,
			finalCommit: run.integrationHead,
			finalTreeHash,
			deliveryRef,
			manifestPath,
		};
	}
}
