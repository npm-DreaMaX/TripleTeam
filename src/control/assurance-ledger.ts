import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@earendil-works/pi-session-backend-sqlite-node";
import { executionPolicyFor } from "../config/execution.ts";
import { type CheckCommand, checkCommandVersion, evidenceClassForCheck } from "../config/project.ts";
import { DomainInvariantError } from "../domain/model.ts";
import {
	type AssurancePlan,
	assurancePolicyFor,
	definitionHash,
	parseAssuranceDefinition,
	probeSpecification,
	probesForSubject,
} from "../verification/assurance-types.ts";

type Subject = "CANDIDATE" | "INTEGRATION" | "RUN";

/** Specification provenance and test definitions are frozen independently of writer candidates. */
export class AssuranceLedger {
	constructor(private readonly db: SqliteDatabase) {}

	required(taskId: string): boolean {
		const row = this.db
			.prepare(
				"SELECT t.risk_class,r.goal_contract_json,tr.acceptance_contract_json FROM tasks t JOIN runs r ON r.id=t.run_id JOIN task_revisions tr ON tr.id=t.current_revision_id WHERE t.id=?",
			)
			.get<{ risk_class: string; goal_contract_json: string; acceptance_contract_json: string }>(taskId);
		if (!row) throw new Error("Unknown assurance task " + taskId);
		const policy = assurancePolicyFor(JSON.parse(row.goal_contract_json));
		if (policy.mode === "off") return false;
		if (policy.mode === "required" || row.risk_class === "HIGH" || this.get(taskId)) return true;
		const decision = this.allocation(taskId);
		if (decision) return decision.required;
		if (row.risk_class !== "LOW") return true;
		const checks =
			(JSON.parse(row.acceptance_contract_json) as { integrationChecks?: CheckCommand[] }).integrationChecks ?? [];
		return !checks.some((check) => ["BEHAVIORAL", "EXTERNAL"].includes(evidenceClassForCheck(check)));
	}

	allocation(taskId: string): { required: boolean; revision: string; tokenLimit?: number; durationMs?: number } | null {
		const row = this.db
			.prepare(
				"SELECT t.current_revision_id,r.goal_contract_json FROM tasks t JOIN runs r ON r.id=t.run_id WHERE t.id=?",
			)
			.get<{ current_revision_id: string; goal_contract_json: string }>(taskId);
		if (!row) return null;
		const goal = JSON.parse(row.goal_contract_json);
		if (goal.verificationPolicyVersion !== 1 || !executionPolicyFor(goal).enableComputeAllocation) return null;
		for (const action of this.db
			.prepare(
				"SELECT detail_json FROM control_actions WHERE task_id=? AND kind='VERIFICATION_ALLOCATION' ORDER BY rowid",
			)
			.all<{ detail_json: string }>(taskId)) {
			const decision = JSON.parse(action.detail_json);
			if (decision.revision === row.current_revision_id) return decision;
		}
		return null;
	}

	get(taskId: string): AssurancePlan | null {
		const row = this.db
			.prepare(
				"SELECT p.plan_json FROM assurance_plans p JOIN tasks t ON t.current_revision_id=p.task_revision_id WHERE t.id=?",
			)
			.get<{ plan_json: string }>(taskId);
		return row ? (JSON.parse(row.plan_json) as AssurancePlan) : null;
	}

	list(runId: string): AssurancePlan[] {
		return this.db
			.prepare(
				"SELECT p.plan_json FROM assurance_plans p JOIN tasks t ON t.current_revision_id=p.task_revision_id WHERE p.run_id=? AND t.state <> 'CANCELLED' ORDER BY p.created_at,p.id",
			)
			.all<{ plan_json: string }>(runId)
			.map((row) => JSON.parse(row.plan_json) as AssurancePlan);
	}

	freeze(plan: AssurancePlan): void {
		const goal = this.db
			.prepare("SELECT goal_contract_json FROM runs WHERE id=?")
			.get<{ goal_contract_json: string }>(plan.runId);
		const policy = assurancePolicyFor(JSON.parse(goal?.goal_contract_json ?? "{}"));
		parseAssuranceDefinition(plan.definition, policy);
		const task = this.db
			.prepare("SELECT t.current_revision_id,t.run_id,r.state FROM tasks t JOIN runs r ON r.id=t.run_id WHERE t.id=?")
			.get<{ current_revision_id: string; run_id: string; state: string }>(plan.taskId);
		if (
			!task ||
			task.current_revision_id !== plan.taskRevisionId ||
			task.run_id !== plan.runId ||
			task.state !== "OPEN"
		)
			throw new DomainInvariantError("STALE_ASSURANCE_PLAN", "Specification plan authority changed");
		if (plan.designAttemptId === plan.criticAttemptId)
			throw new Error("Specification design and critique require independent attempts");
		for (const id of [plan.designAttemptId, plan.criticAttemptId]) {
			const attempt = this.db
				.prepare("SELECT state,task_id,base_commit,workflow_function FROM attempts WHERE id=?")
				.get<{ state: string; task_id: string; base_commit: string; workflow_function: string }>(id);
			if (
				!attempt ||
				attempt.state !== "SUBMITTED" ||
				attempt.task_id !== plan.taskId ||
				attempt.base_commit !== plan.baselineCommit ||
				attempt.workflow_function !== "REVIEW"
			)
				throw new Error("Assurance requires completed independent review attempts on the frozen baseline");
		}
		if (
			plan.controlCheckIds.length !== plan.definition.probes.length ||
			new Set(plan.controlCheckIds).size !== plan.controlCheckIds.length
		)
			throw new Error("Missing or duplicate discriminating controls");
		for (const [index, id] of plan.controlCheckIds.entries()) {
			const check = this.db
				.prepare(
					"SELECT run_id,task_id,state,check_kind,check_version,command_json,subject_kind,subject_id,result_json FROM check_runs WHERE id=?",
				)
				.get<{
					run_id: string;
					task_id: string;
					state: string;
					check_kind: string;
					check_version: string;
					command_json: string;
					subject_kind: string;
					subject_id: string;
					result_json: string;
				}>(id);
			const probe = plan.definition.probes[index];
			if (!probe) throw new Error("Unknown assurance probe");
			const specification = probeSpecification(plan, probe, policy, 0, true);
			const result = check
				? (JSON.parse(check.result_json) as {
						assurance?: { control?: boolean; probeId?: string; definitionHash?: string };
					})
				: null;
			if (
				!check ||
				check.run_id !== plan.runId ||
				check.subject_kind !== "RUN" ||
				check.subject_id !== plan.runId ||
				check.task_id !== plan.taskId ||
				check.check_version !== checkCommandVersion(specification) ||
				check.command_json !== JSON.stringify(specification.argv) ||
				check.state !== "PASSED" ||
				!result?.assurance?.control ||
				result.assurance.probeId !== plan.definition.probes[index]?.id ||
				check.check_kind !== `assurance:${plan.id}:${plan.definition.probes[index]?.id}:control` ||
				result.assurance.definitionHash !== definitionHash(plan.definition)
			)
				throw new Error("Contrast did not demonstrate an assertion failure for this exact definition");
		}
		this.db
			.prepare(
				"INSERT INTO assurance_plans (id,run_id,task_id,task_revision_id,baseline_commit,plan_json,created_at) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				plan.id,
				plan.runId,
				plan.taskId,
				plan.taskRevisionId,
				plan.baselineCommit,
				JSON.stringify(plan),
				new Date().toISOString(),
			);
	}

	beginEvaluation(plan: AssurancePlan, treeHash: string, subject: Subject, subjectId: string): string {
		if (this.get(plan.taskId)?.id !== plan.id) throw new Error("Stale assurance revision");
		const id = randomUUID();
		this.db
			.prepare("INSERT INTO assurance_evaluations VALUES (?,?,?,?,?,'STARTED',?)")
			.run(id, plan.id, treeHash, subject, subjectId, new Date().toISOString());
		return id;
	}

	finishEvaluation(id: string, state: "PASSED" | "FAILED" | "ERROR"): void {
		const updated = this.db
			.prepare("UPDATE assurance_evaluations SET state=? WHERE id=? AND state='STARTED'")
			.run(state, id);
		if (updated.changes !== 1) throw new Error("Assurance evaluation is already settled or missing");
	}

	assertPassed(taskId: string, treeHash: string, subject: Subject, subjectId: string): void {
		if (!this.required(taskId)) return;
		const plan = this.get(taskId);
		if (!plan)
			throw new DomainInvariantError(
				"ASSURANCE_REQUIRED",
				"Independent specification and probes are missing for " + taskId,
			);
		const evaluation = this.db
			.prepare(
				"SELECT id,state FROM assurance_evaluations WHERE plan_id=? AND tree_hash=? AND subject_kind=? AND subject_id=? ORDER BY rowid DESC LIMIT 1",
			)
			.get<{ id: string; state: string }>(plan.id, treeHash, subject, subjectId);
		if (evaluation?.state !== "PASSED")
			throw new DomainInvariantError(
				"ASSURANCE_UNSATISFIED",
				"Latest independent verification batch is incomplete or failed",
			);
		const row = this.db
			.prepare("SELECT r.goal_contract_json FROM runs r WHERE id=?")
			.get<{ goal_contract_json: string }>(plan.runId);
		const policy = assurancePolicyFor(JSON.parse(row?.goal_contract_json ?? "{}"));
		const repetitions = policy.repetitions;
		for (const probe of probesForSubject(plan, subject)) {
			for (let repeat = 0; repeat < repetitions; repeat++) {
				const check = this.db
					.prepare(
						"SELECT state,check_version,command_json,result_json FROM check_runs WHERE task_id=? AND tree_hash=? AND subject_kind=? AND subject_id=? AND check_kind=? ORDER BY rowid DESC LIMIT 1",
					)
					.get<{ state: string; check_version: string; command_json: string; result_json: string }>(
						taskId,
						treeHash,
						subject,
						subjectId,
						`assurance:${plan.id}:${probe.id}:${repeat}`,
					);
				const specification = probeSpecification(plan, probe, policy, repeat);
				const result = check
					? (JSON.parse(check.result_json) as {
							assurance?: { definitionHash?: string; control?: boolean; evaluationId?: string };
						})
					: null;
				if (
					!check ||
					check.state !== "PASSED" ||
					check.check_version !== checkCommandVersion(specification) ||
					check.command_json !== JSON.stringify(specification.argv) ||
					result?.assurance?.control !== false ||
					result.assurance.evaluationId !== evaluation.id ||
					result.assurance.definitionHash !== definitionHash(plan.definition)
				)
					throw new DomainInvariantError(
						"ASSURANCE_UNSATISFIED",
						`Probe ${probe.id} has no stable passing evidence on the exact ${subject} tree`,
					);
			}
		}
	}
}
