import { executionPolicyFor } from "../config/execution.ts";
import { DomainInvariantError } from "../domain/model.ts";
import type { GitWorkspaceManager } from "../workspace/git.ts";
import type { ControlCatalog, CoordinationContract, TaskDefinition } from "./catalog.ts";
import type { ControlKernel } from "./kernel.ts";

export class ContractVerifier {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly git: GitWorkspaceManager,
	) {}

	async verify(taskId: string, commitHash: string, treeHash: string, checkIds: string[]): Promise<void> {
		const task = this.catalog.getTask(taskId);
		if (!executionPolicyFor(this.catalog.getRun(task.runId).goalContract).enableContracts) return;
		if ((await this.git.treeHash(commitHash)) !== treeHash)
			throw new DomainInvariantError(
				"CONTRACT_TREE_MISMATCH",
				"Contract artifacts and checks must describe the same Git tree",
			);
		const contract = this.catalog.getCoordinationContract(taskId);
		if (!contract) return;
		for (const key of [...contract.provides, ...contract.assumptions]) {
			const obligation = contract.obligations.find((o) => o.key === key);
			if (!obligation)
				throw new DomainInvariantError("UNPROVEN_CONTRACT", `Contract ${key} lacks artifact paths and check bindings`);
			const artifacts = await Promise.all(
				obligation.artifactPaths.map(async (path) => ({
					path,
					...(await this.git.artifactEntry(commitHash, path)),
				})),
			);
			this.kernel.recordContractEvidence({ taskId, obligation: key, commitHash, treeHash, artifacts, checkIds });
		}
		this.kernel.satisfyCoordinationContract(taskId, treeHash);
	}

	/** A compatible implementation update pays for the affected accepted dependency closure. */
	async reverificationTasks(runId: string, commit: string): Promise<TaskDefinition[]> {
		if (!executionPolicyFor(this.catalog.getRun(runId).goalContract).enableContracts) return [];
		const accepted = this.catalog.listTasks(runId, ["ACCEPTED"]);
		const affected = new Set<string>();
		for (const task of accepted) {
			const contract = this.catalog.getCoordinationContract(task.id);
			if (!contract) continue;
			for (const key of [...contract.provides, ...contract.assumptions]) {
				try {
					await this.currentProof(contract, commit, key);
				} catch {
					affected.add(task.id);
					break;
				}
			}
		}
		const dependencies = this.catalog.listDependencies(runId);
		let previous = -1;
		while (previous !== affected.size) {
			previous = affected.size;
			for (const edge of dependencies)
				if (affected.has(edge.dependsOnTaskId) && accepted.some((task) => task.id === edge.taskId))
					affected.add(edge.taskId);
		}
		return accepted.filter((task) => affected.has(task.id));
	}

	async bindRequirements(taskId: string, attemptId: string, baseline: string) {
		const task = this.catalog.getTask(taskId);
		const bindings: Array<{
			requirement: string;
			contractId: string;
			version: number;
			baseline: string;
			evidence: ReturnType<ControlCatalog["listContractEvidence"]>;
		}> = [];
		if (!executionPolicyFor(this.catalog.getRun(task.runId).goalContract).enableContracts) return bindings;
		const contract = this.catalog.getCoordinationContract(taskId);
		for (const requirement of contract?.requires ?? []) {
			const providers = this.catalog
				.listTasks(task.runId)
				.map((t) => ({ task: t, contract: this.catalog.getCoordinationContract(t.id) }))
				.filter((p) => p.task.state !== "CANCELLED" && p.contract?.provides.includes(requirement));
			if (providers.length !== 1 || providers[0]?.task.state !== "ACCEPTED")
				throw new DomainInvariantError(
					"UNRESOLVED_CONTRACT",
					`Required interface ${requirement} has no unique accepted producer`,
				);
			const provider = providers[0].contract as CoordinationContract;
			const proof = await this.currentProof(provider, baseline, requirement);
			this.kernel.bindContractConsumption(attemptId, provider.id, provider.version, baseline, proof);
			bindings.push({
				requirement,
				contractId: provider.id,
				version: provider.version,
				baseline,
				evidence: this.catalog.listContractEvidence(provider.id).filter((entry) => proof.includes(entry.id)),
			});
		}
		return bindings;
	}

	/** Frozen published interfaces cannot silently change while their consumers keep old authority. */
	async assertPreserved(runId: string, commit: string): Promise<void> {
		if (!executionPolicyFor(this.catalog.getRun(runId).goalContract).enableContracts) return;
		for (const task of this.catalog.listTasks(runId, ["ACCEPTED"])) {
			const contract = this.catalog.getCoordinationContract(task.id);
			if (!contract) continue;
			for (const key of [...contract.provides, ...contract.assumptions]) await this.currentProof(contract, commit, key);
		}
	}

	private async currentProof(contract: CoordinationContract, commit: string, key: string): Promise<string[]> {
		if (contract.state !== "SATISFIED") throw new DomainInvariantError("UNPROVEN_CONTRACT", key);
		const proofs = this.catalog
			.listContractEvidence(contract.id)
			.filter((e) => e.version === contract.version && e.obligation === key && e.artifacts.length);
		if (!proofs.length) throw new DomainInvariantError("MISSING_CONTRACT_EVIDENCE", key);
		for (const evidence of proofs) {
			let matches = true;
			for (const artifact of evidence.artifacts) {
				try {
					const current = await this.git.artifactEntry(commit, artifact.path);
					const recordedMode = artifact.mode ?? (await this.git.artifactEntry(evidence.commitHash, artifact.path)).mode;
					if (current.blobHash !== artifact.blobHash || current.mode !== recordedMode) {
						matches = false;
						break;
					}
				} catch {
					matches = false;
					break;
				}
			}
			if (matches) return [evidence.id];
		}
		this.kernel.recordControlAction({
			runId: contract.runId,
			taskId: contract.taskId,
			kind: "CONTRACT_INVALIDATION",
			state: "REJECTED",
			detail: { key, contractId: contract.id, version: contract.version, commit },
		});
		throw new DomainInvariantError(
			"STALE_CONTRACT_ARTIFACT",
			`Published artifact for ${key} changed; producer and affected consumers require new exact-tree checks under the frozen contract`,
		);
	}
}
