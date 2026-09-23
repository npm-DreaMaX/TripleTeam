import { acceptancePolicyForRun, type ProjectConfig, taskAcceptanceForScope } from "../config/project.ts";
import type { ControlCatalog, TaskChangeProposalRecord } from "./catalog.ts";
import type { ControlKernel, TaskChangeReference, TaskChangeSet } from "./kernel.ts";
import { scopeContains } from "./scope.ts";

export interface ProposalPolicyResult {
	accepted: string[];
	rejected: string[];
	requiresUser: Array<{ proposalId: string; taskId: string | null; reason: string }>;
}

function referenceKey(reference: TaskChangeReference): string {
	return "taskId" in reference ? "task:" + reference.taskId : "new:" + reference.newTaskKey;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export class BoundedTaskProposalPolicy {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly config: ProjectConfig,
	) {}

	process(runId: string): ProposalPolicyResult {
		const result: ProposalPolicyResult = { accepted: [], rejected: [], requiresUser: [] };
		for (const proposal of this.catalog.listTaskChangeProposals(runId, ["PROPOSED"])) {
			if (!this.kernel.taskProposalIsCurrent(proposal.id)) {
				this.kernel.rejectTaskChanges(
					proposal.id,
					"Proposal became stale after another authoritative task-graph change",
					{ kind: "SYSTEM", id: "bounded-replan-policy" },
				);
				result.rejected.push(proposal.id);
				continue;
			}
			const decision = this.autoAcceptable(proposal);
			if (decision.accept) {
				this.kernel.acceptTaskChanges(proposal.id, { kind: "SYSTEM", id: "bounded-replan-policy" });
				result.accepted.push(proposal.id);
				continue;
			}
			if (decision.taskId) {
				const task = this.catalog.getTask(decision.taskId);
				if (task.state === "READY") {
					this.kernel.blockReadyTask(
						task.id,
						`Task-graph proposal ${proposal.id} requires user authority: ${decision.reason}`,
						{ kind: "SYSTEM", id: "bounded-replan-policy" },
					);
				}
			}
			const existing = this.catalog
				.listOpenDecisionRequests(runId)
				.find((request) => request.sourceKind === "TASK_CHANGE_PROPOSAL" && request.sourceId === proposal.id);
			if (!existing) {
				this.kernel.createDecisionRequest({
					runId,
					taskId: decision.taskId ?? undefined,
					kind: decision.reason.includes("acceptance policy") ? "ACCEPTANCE_CHANGE" : "AUTHORITY_EXPANSION",
					question: `Task-graph proposal ${proposal.id} requires user authority: ${decision.reason}`,
					options: ["ACCEPT_PROPOSAL", "REJECT_PROPOSAL"],
					recommendedOption: "REJECT_PROPOSAL",
					evidenceRefs: [proposal.id],
					sourceKind: "TASK_CHANGE_PROPOSAL",
					sourceId: proposal.id,
					actor: { kind: "SYSTEM", id: "bounded-replan-policy" },
				});
			}
			result.requiresUser.push({ proposalId: proposal.id, taskId: decision.taskId, reason: decision.reason });
		}
		return result;
	}

	private autoAcceptable(
		proposal: TaskChangeProposalRecord,
	): { accept: true; taskId: string } | { accept: false; taskId: string | null; reason: string } {
		if (proposal.sourceActorKind !== "ATTEMPT") {
			return {
				accept: false,
				taskId: null,
				reason: "only a scoped Agent attempt may request bounded autonomous refinement",
			};
		}
		const source = this.catalog.getAttempt(proposal.sourceActorId);
		if (source.workflowFunction !== "IMPLEMENT" || source.taskId === null) {
			return { accept: false, taskId: source.taskId, reason: "only an implementation owner may refine its task" };
		}
		const changes = proposal.proposal as TaskChangeSet;
		if (changes.revisions.length > 0 || changes.cancellations.length > 0) {
			return { accept: false, taskId: source.taskId, reason: "revision or cancellation changes user-visible intent" };
		}
		if (changes.additions.length < 1 || changes.additions.length > 8) {
			return {
				accept: false,
				taskId: source.taskId,
				reason: "autonomous refinement must add between one and eight tasks",
			};
		}
		const sourceTask = this.catalog.getTask(source.taskId);
		const policy = acceptancePolicyForRun(this.catalog.getRun(proposal.runId).goalContract, this.config);
		for (const addition of changes.additions) {
			if (
				!scopeContains(sourceTask.scope, addition.scope) ||
				!(sourceTask.constraints as string[]).every((constraint) =>
					(addition.constraints as string[]).includes(constraint),
				)
			) {
				return {
					accept: false,
					taskId: source.taskId,
					reason: `added task ${addition.key} expands scope or drops a source constraint`,
				};
			}
			const expectedContract = taskAcceptanceForScope(policy, addition.scope as string[], addition.riskClass);
			if (!sameJson(addition.acceptanceContract, expectedContract)) {
				return {
					accept: false,
					taskId: source.taskId,
					reason: `added task ${addition.key} changes the system-owned acceptance policy`,
				};
			}
			if (
				(addition.requiredCapabilities ?? []).some(
					(capability) => !sourceTask.requiredCapabilities.includes(capability),
				)
			) {
				return {
					accept: false,
					taskId: source.taskId,
					reason: `added task ${addition.key} requires authority not granted to its source task`,
				};
			}
		}
		const allowedExisting = "task:" + source.taskId;
		const edges = new Map<string, string[]>();
		for (const dependency of changes.dependencies) {
			const downstream = referenceKey(dependency.task);
			const upstream = referenceKey(dependency.dependsOn);
			for (const reference of [downstream, upstream]) {
				if (reference.startsWith("task:") && reference !== allowedExisting) {
					return { accept: false, taskId: source.taskId, reason: "proposal changes ownership outside its source task" };
				}
			}
			const values = edges.get(downstream) ?? [];
			values.push(upstream);
			edges.set(downstream, values);
		}
		const reachable = new Set<string>();
		const visit = (key: string): void => {
			if (reachable.has(key)) return;
			reachable.add(key);
			for (const upstream of edges.get(key) ?? []) visit(upstream);
		};
		visit(allowedExisting);
		for (const addition of changes.additions) {
			if (!reachable.has("new:" + addition.key)) {
				return {
					accept: false,
					taskId: source.taskId,
					reason: `added task ${addition.key} is not a prerequisite reachable from the source task`,
				};
			}
		}
		return { accept: true, taskId: source.taskId };
	}
}
