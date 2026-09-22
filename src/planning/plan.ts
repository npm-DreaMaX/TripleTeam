import { createHash, randomUUID } from "node:crypto";
import { executionPolicyFor } from "../config/execution.ts";
import type { ProjectPaths } from "../config/paths.ts";
import { acceptancePolicyForRun, type FrozenAcceptancePolicy, type ProjectConfig } from "../config/project.ts";
import type { ControlCatalog } from "../control/catalog.ts";
import { type ContractObligation, parseObligations } from "../control/contract-types.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { LocalResourceGovernor } from "../control/resource-governor.ts";
import type { CoordinationLevel } from "../domain/model.ts";
import type { ExplorationReport, PiExplorer } from "../exploration/explorer.ts";
import { AttemptControlBridge } from "../runtime/pi/control-bridge.ts";
import {
	assertFrozenProfile,
	constrainProfileTools,
	type ManagedPiWorker,
	type PiWorkerLauncher,
} from "../runtime/pi/launcher.ts";
import type { LiveAttemptRegistry } from "../runtime/pi/live-attempts.ts";
import { runMetered } from "../runtime/pi/metered-run.ts";
import type { GitWorkspaceManager, ManagedWorktree } from "../workspace/git.ts";

export interface PlannedTask {
	key: string;
	title: string;
	objective: string;
	scope: string[];
	constraints: string[];
	riskClass: "LOW" | "NORMAL" | "HIGH";
	priority: number;
	coordination: {
		decomposability: CoordinationLevel;
		sequentiality: CoordinationLevel;
		semanticCoupling: CoordinationLevel;
		integrationCost: CoordinationLevel;
		uncertainty: CoordinationLevel;
		rationale: string;
		evidenceRefs: string[];
		explorationQuestions: Array<{ key: string; hypothesis: string; question: string }>;
	};
	interface: {
		obligations?: ContractObligation[];
		provides: string[];
		requires: string[];
		assumptions: string[];
		interfaces: string[];
		evidenceRefs: string[];
	};
}

export interface PlannedDependency {
	task: string;
	dependsOn: string;
	kind: "REQUIRES" | "CONSUMES";
}

export interface TaskPlan {
	tasks: PlannedTask[];
	dependencies: PlannedDependency[];
}

export interface ExplorationRequest {
	question: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(label + " must be a string array");
	}
	return value;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(label + " must be a non-empty string");
	return value.trim();
}

function coordinationLevel(value: unknown, label: string): CoordinationLevel {
	if (value !== "LOW" && value !== "MEDIUM" && value !== "HIGH") {
		throw new Error(label + " must be LOW, MEDIUM, or HIGH");
	}
	return value;
}

function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const source = fenced?.[1]?.trim() ?? text.trim();
	try {
		return JSON.parse(source) as unknown;
	} catch (firstError) {
		const start = source.indexOf("{");
		const end = source.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1)) as unknown;
		throw firstError;
	}
}

export function parseTaskPlan(text: string): TaskPlan {
	const value = extractJson(text);
	if (!isRecord(value) || !Array.isArray(value.tasks) || !Array.isArray(value.dependencies)) {
		throw new Error("Plan must contain tasks and dependencies arrays");
	}
	if (value.tasks.length < 1 || value.tasks.length > 32) throw new Error("Plan must contain between 1 and 32 tasks");
	const keys = new Set<string>();
	const tasks = value.tasks.map((entry, index): PlannedTask => {
		if (!isRecord(entry)) throw new Error(`tasks[${index}] must be an object`);
		for (const field of ["key", "title", "objective"] as const) {
			if (typeof entry[field] !== "string" || entry[field].trim() === "") {
				throw new Error(`tasks[${index}].${field} must be a non-empty string`);
			}
		}
		const key = entry.key as string;
		if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`tasks[${index}].key contains unsupported characters`);
		if (keys.has(key)) throw new Error("Duplicate task key: " + key);
		keys.add(key);
		if (entry.riskClass !== "LOW" && entry.riskClass !== "NORMAL" && entry.riskClass !== "HIGH") {
			throw new Error(`tasks[${index}].riskClass must be LOW, NORMAL, or HIGH`);
		}
		const priority = entry.priority ?? 0;
		if (!Number.isSafeInteger(priority)) throw new Error(`tasks[${index}].priority must be an integer`);
		if (!isRecord(entry.coordination)) throw new Error(`tasks[${index}].coordination must be an object`);
		if (!isRecord(entry.interface)) throw new Error(`tasks[${index}].interface must be an object`);
		const questions = entry.coordination.explorationQuestions ?? [];
		if (!Array.isArray(questions) || questions.length > 3) {
			throw new Error(`tasks[${index}].coordination.explorationQuestions must contain at most three entries`);
		}
		return {
			key,
			title: entry.title as string,
			objective: entry.objective as string,
			scope: stringArray(entry.scope ?? [], `tasks[${index}].scope`),
			constraints: stringArray(entry.constraints ?? [], `tasks[${index}].constraints`),
			riskClass: entry.riskClass,
			priority: priority as number,
			coordination: {
				decomposability: coordinationLevel(
					entry.coordination.decomposability,
					`tasks[${index}].coordination.decomposability`,
				),
				sequentiality: coordinationLevel(
					entry.coordination.sequentiality,
					`tasks[${index}].coordination.sequentiality`,
				),
				semanticCoupling: coordinationLevel(
					entry.coordination.semanticCoupling,
					`tasks[${index}].coordination.semanticCoupling`,
				),
				integrationCost: coordinationLevel(
					entry.coordination.integrationCost,
					`tasks[${index}].coordination.integrationCost`,
				),
				uncertainty: coordinationLevel(entry.coordination.uncertainty, `tasks[${index}].coordination.uncertainty`),
				rationale: nonEmptyString(entry.coordination.rationale, `tasks[${index}].coordination.rationale`),
				evidenceRefs: stringArray(entry.coordination.evidenceRefs ?? [], `tasks[${index}].coordination.evidenceRefs`),
				explorationQuestions: questions.map((question, questionIndex) => {
					if (!isRecord(question)) {
						throw new Error(`tasks[${index}].coordination.explorationQuestions[${questionIndex}] is invalid`);
					}
					return {
						key: nonEmptyString(
							question.key,
							`tasks[${index}].coordination.explorationQuestions[${questionIndex}].key`,
						),
						hypothesis: nonEmptyString(
							question.hypothesis,
							`tasks[${index}].coordination.explorationQuestions[${questionIndex}].hypothesis`,
						),
						question: nonEmptyString(
							question.question,
							`tasks[${index}].coordination.explorationQuestions[${questionIndex}].question`,
						),
					};
				}),
			},
			interface: {
				obligations: parseObligations(entry.interface.obligations),
				provides: stringArray(entry.interface.provides ?? [], `tasks[${index}].interface.provides`),
				requires: stringArray(entry.interface.requires ?? [], `tasks[${index}].interface.requires`),
				assumptions: stringArray(entry.interface.assumptions ?? [], `tasks[${index}].interface.assumptions`),
				interfaces: stringArray(entry.interface.interfaces ?? [], `tasks[${index}].interface.interfaces`),
				evidenceRefs: stringArray(entry.interface.evidenceRefs ?? [], `tasks[${index}].interface.evidenceRefs`),
			},
		};
	});
	const dependencies = value.dependencies.map((entry, index): PlannedDependency => {
		if (!isRecord(entry)) throw new Error(`dependencies[${index}] must be an object`);
		if (typeof entry.task !== "string" || !keys.has(entry.task))
			throw new Error(`dependencies[${index}].task is unknown`);
		if (typeof entry.dependsOn !== "string" || !keys.has(entry.dependsOn)) {
			throw new Error(`dependencies[${index}].dependsOn is unknown`);
		}
		if (entry.task === entry.dependsOn) throw new Error(`dependencies[${index}] is self-referential`);
		const kind = entry.kind ?? "REQUIRES";
		if (kind !== "REQUIRES" && kind !== "CONSUMES") throw new Error(`dependencies[${index}].kind is invalid`);
		return { task: entry.task, dependsOn: entry.dependsOn, kind };
	});

	for (const task of tasks)
		for (const key of [...task.interface.provides, ...task.interface.assumptions]) {
			if (!task.interface.obligations?.some((obligation) => obligation.key === key))
				throw new Error(`Contract ${key} must name artifactPaths and checkNames; remove uncheckable promises`);
		}
	for (const consumer of tasks)
		for (const requirement of consumer.interface.requires) {
			const providers = tasks.filter((task) => task.interface.provides.includes(requirement));
			if (providers.length !== 1 || !providers[0] || providers[0].key === consumer.key)
				throw new Error(`Requirement ${requirement} must resolve to one other producer task`);
			const producer = providers[0];
			if (!dependencies.some((edge) => edge.task === consumer.key && edge.dependsOn === producer.key))
				dependencies.push({ task: consumer.key, dependsOn: producer.key, kind: "CONSUMES" });
		}
	const outgoing = new Map<string, string[]>();
	for (const key of keys) outgoing.set(key, []);
	for (const dependency of dependencies) outgoing.get(dependency.task)?.push(dependency.dependsOn);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string): void => {
		if (visiting.has(key)) throw new Error("Plan contains a dependency cycle");
		if (visited.has(key)) return;
		visiting.add(key);
		for (const next of outgoing.get(key) ?? []) visit(next);
		visiting.delete(key);
		visited.add(key);
	};
	for (const key of keys) visit(key);
	return { tasks, dependencies };
}

export function parseExplorationRequests(text: string, maximum: number): ExplorationRequest[] {
	const value = extractJson(text);
	if (!isRecord(value) || !Array.isArray(value.explorationRequests)) {
		throw new Error("Planning response is neither a task plan nor an exploration request");
	}
	if (value.explorationRequests.length < 1 || value.explorationRequests.length > maximum) {
		throw new Error(`Planner may request between 1 and ${maximum} explorations`);
	}
	const seen = new Set<string>();
	return value.explorationRequests.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.question !== "string" || entry.question.trim() === "") {
			throw new Error(`explorationRequests[${index}].question must be a non-empty string`);
		}
		const question = entry.question.trim();
		if (question.length > 2_000) throw new Error(`explorationRequests[${index}].question is too long`);
		if (seen.has(question)) throw new Error("Exploration questions must be unique");
		seen.add(question);
		return { question };
	});
}

export function applyTaskPlan(input: {
	plan: TaskPlan;
	runId: string;
	sourceAttemptId: string;
	kernel: ControlKernel;
	acceptancePolicy: FrozenAcceptancePolicy;
	actor: { kind: "USER" | "SYSTEM"; id: string };
}): Map<string, string> {
	const ids = input.kernel.acceptInitialTaskGraph({
		runId: input.runId,
		sourceAttemptId: input.sourceAttemptId,
		tasks: input.plan.tasks.map((task) => ({
			key: task.key,
			title: task.title,
			objective: task.objective,
			scope: task.scope,
			constraints: task.constraints,
			acceptanceContract: {
				candidateChecks: input.acceptancePolicy.candidateChecks,
				integrationChecks: input.acceptancePolicy.integrationChecks,
				requireReview: input.acceptancePolicy.reviewRequiredFor.includes(task.riskClass),
			},
			riskClass: task.riskClass,
			priority: task.priority,
			coordination: {
				assessment: task.coordination,
				contract: {
					...task.interface,
					ownedScope: task.scope,
				},
			},
		})),
		dependencies: input.plan.dependencies,
		actor: input.actor,
	});
	return ids;
}

function plannerPrompt(objective: string): string {
	return `You are the planning stage of a verified runtime for long-horizon repository changes. Inspect the repository read-only and decompose the user's goal into independently executable coding tasks with explicit dependencies. The control plane may schedule one or several workers depending on the graph; do not create tasks merely to increase parallelism.

User goal:
${objective}

If a small number of focused, independent repository investigations would materially reduce uncertainty, return this JSON shape instead of guessing:
{
  "explorationRequests": [
    { "question": "one concrete repository question" }
  ]
}

Request exploration only when it is genuinely useful. You get one round with at most three focused questions. Otherwise return JSON only, with this exact task-plan shape:
{
  "tasks": [
    {
      "key": "stable-short-key",
      "title": "short title",
      "objective": "observable implementation outcome",
      "scope": ["repository/relative/path-prefix"],
      "constraints": ["important invariant"],
      "riskClass": "LOW|NORMAL|HIGH",
      "priority": 0,
      "coordination": {
        "decomposability": "LOW|MEDIUM|HIGH",
        "sequentiality": "LOW|MEDIUM|HIGH",
        "semanticCoupling": "LOW|MEDIUM|HIGH",
        "integrationCost": "LOW|MEDIUM|HIGH",
        "uncertainty": "LOW|MEDIUM|HIGH",
        "rationale": "repository-grounded explanation for this classification",
        "evidenceRefs": ["repository-relative file or symbol"],
        "explorationQuestions": [
          { "key": "stable-question-key", "hypothesis": "falsifiable hypothesis", "question": "focused repository question" }
        ]
      },
      "interface": {
        "provides": ["stable-interface-key"],
        "obligations": [{"key":"stable-interface-key","artifactPaths":["src/interface.ts"],"checkNames":["an available frozen integration check name"]}],
        "requires": ["capability or artifact required from an upstream task"],
        "assumptions": ["explicit assumption that may become stale"],
        "interfaces": ["API, schema, protocol, or shared semantic boundary"],
        "evidenceRefs": ["repository-relative file or symbol supporting the contract"]
      }
    }
  ],
  "dependencies": [
    { "task": "downstream-key", "dependsOn": "upstream-key", "kind": "REQUIRES" }
  ]
}

Only list provides/assumptions that have an obligation with concrete artifactPaths and checkNames from the available frozen integration checks. Requirements must exactly match one producer provides key; existing repository facts belong in evidenceRefs. Use empty arrays when no cross-task interface is needed. A shared schema/type can be a prerequisite task whose verified artifact enables later independent implementation; choose this only when integration checks can verify the intermediate state.

Scopes are authoritative ownership boundaries, not hints. Use canonical repository-relative file or directory prefixes, include implementation, test, documentation, and configuration paths the task may need, and use ["."] only when a task must own the whole repository. Assess semantic coupling and integration/reverification cost independently from path overlap. Parallel-safe tasks need low sequentiality, low semantic coupling, bounded integration cost, and explicit provides/requires/assumptions. Use explorationQuestions only for genuine unresolved uncertainty. Use the smallest task graph that preserves isolated ownership and meaningful verification. Do not claim work is complete and do not edit files.`;
}

function explorationFollowUp(reports: ExplorationReport[], failures: string[]): string {
	return `The control plane completed your one allowed exploration round. Use these reports as non-authoritative observations and now return the task-plan JSON object only. Do not request more exploration.

Reports:
${reports
	.map(
		(report, index) =>
			`[${index + 1}] Question: ${report.question}\nExplorer attempt: ${report.attemptId}\n${report.report.slice(0, 16_000)}`,
	)
	.join("\n\n")}
${failures.length > 0 ? `\nFailed investigations:\n${failures.join("\n")}` : ""}`;
}

export class PiPlanner {
	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly workspaces: GitWorkspaceManager,
		private readonly launcher: PiWorkerLauncher,
		private readonly explorer: PiExplorer,
		private readonly resources: LocalResourceGovernor,
		private readonly paths: ProjectPaths,
		private readonly config: ProjectConfig,
		private readonly liveAttempts?: LiveAttemptRegistry,
	) {}

	async plan(input: {
		runId: string;
		objective: string;
		inputCommit: string;
		repositoryRoot: string;
	}): Promise<TaskPlan> {
		const goal = this.catalog.getRun(input.runId).goalContract;
		if (executionPolicyFor(goal).policy === "SINGLE") {
			const acceptance = acceptancePolicyForRun(goal, this.config);
			const scope = (goal as { authorizedScope?: string[] }).authorizedScope ?? ["."];
			const task: PlannedTask = {
				key: "goal",
				title: input.objective.slice(0, 120),
				objective: input.objective,
				scope,
				constraints: [],
				riskClass: "NORMAL",
				priority: 0,
				coordination: {
					decomposability: "LOW",
					sequentiality: "HIGH",
					semanticCoupling: "HIGH",
					integrationCost: "LOW",
					uncertainty: "MEDIUM",
					rationale: "Frozen single-agent baseline receives the full objective and repository context",
					evidenceRefs: [],
					explorationQuestions: [],
				},
				interface: { provides: [], requires: [], assumptions: [], interfaces: [], evidenceRefs: [], obligations: [] },
			};
			this.kernel.atomic(() => {
				this.kernel.createTask({
					runId: input.runId,
					title: task.title,
					objective: task.objective,
					scope,
					constraints: [],
					riskClass: task.riskClass,
					acceptanceContract: {
						candidateChecks: acceptance.candidateChecks,
						integrationChecks: acceptance.integrationChecks,
						requireReview: acceptance.reviewRequiredFor.includes(task.riskClass),
					},
					actor: { kind: "SYSTEM", id: "single-task-initializer" },
				});
				this.kernel.recordControlAction({
					runId: input.runId,
					kind: "SINGLE_TASK_INITIALIZATION",
					detail: { source: "frozen-user-objective", modelPlanningCalls: 0 },
				});
			});
			return { tasks: [task], dependencies: [] };
		}
		return this.resources.run("INTERACTIVE", async () => {
			const actor = { kind: "SYSTEM", id: "planner-service" } as const;
			const acceptancePolicy = acceptancePolicyForRun(this.catalog.getRun(input.runId).goalContract, this.config);
			const profile = constrainProfileTools(
				this.launcher.resolveProfile(
					input.repositoryRoot,
					this.config.profiles.planner,
					["read", "grep", "find", "ls"],
					executionPolicyFor(this.catalog.getRun(input.runId).goalContract),
					"planner",
				),
				["read", "grep", "find", "ls"],
			);
			assertFrozenProfile(goal, "PLAN", profile);
			const attemptId = randomUUID();
			this.kernel.startAuxiliaryAttempt({
				id: attemptId,
				runId: input.runId,
				workflowFunction: "PLAN",
				baseCommit: input.inputCommit,
				profileName: profile.name,
				profileVersion: profile.version,
				actor,
			});
			let worktree: ManagedWorktree | undefined;
			let managed: ManagedPiWorker | undefined;
			let bridge: AttemptControlBridge | undefined;
			let executionId: string | undefined;
			let unregister: (() => void) | undefined;
			try {
				worktree = await this.workspaces.createWorktree(attemptId, input.inputCommit);
				const sessionId = "planner-" + attemptId;
				const prompt =
					plannerPrompt(input.objective) +
					"\nFrozen available checks: " +
					JSON.stringify(acceptancePolicy.integrationChecks);
				executionId = this.kernel.createExecution({
					attemptId,
					piSessionId: sessionId,
					contextManifestHash: createHash("sha256").update(prompt).digest("hex"),
					actor,
				});
				bridge = new AttemptControlBridge(
					this.kernel,
					this.catalog,
					{
						runId: input.runId,
						attemptId,
					},
					this.liveAttempts,
				);
				const control = await bridge.start();
				managed = await this.launcher.create(
					{
						cwd: worktree.path,
						sessionDirectory: this.paths.sessions,
						sessionId,
						sessionName: "Plan " + input.objective.slice(0, 80),
						profileName: profile.name,
						defaultTools: profile.tools,
						control,
					},
					profile,
				);
				const state = await managed.worker.start();
				this.kernel.markExecutionLive({ executionId, sessionFile: state.sessionFile, actor });
				unregister = this.liveAttempts?.register(attemptId, null, managed.worker);
				const plannerWorker = managed.worker;
				const runPlanner = async (text: string, phase: string) => {
					const result = await runMetered(plannerWorker, {
						kernel: this.kernel,
						catalog: this.catalog,
						runId: input.runId,
						attemptId,
						executionId: executionId as string,
						phase,
						prompt: text,
						timeoutMs: this.config.workerTimeoutMs,
					});
					return result;
				};
				let response = await runPlanner(prompt, "PLAN");
				let plan: TaskPlan | undefined;
				try {
					plan = parseTaskPlan(response.lastAssistantText ?? "");
				} catch (planError) {
					let requests: ExplorationRequest[] | undefined;
					try {
						requests = parseExplorationRequests(response.lastAssistantText ?? "", this.config.maxPlannerExplorations);
					} catch {
						response = await runPlanner(
							"Your previous response failed deterministic validation: " +
								(planError instanceof Error ? planError.message : String(planError)) +
								". Return one corrected task-plan JSON object only.",
							"PLAN_CORRECTION",
						);
						plan = parseTaskPlan(response.lastAssistantText ?? "");
					}
					if (requests) {
						const reports: ExplorationReport[] = [];
						const failures: string[] = [];
						for (const request of requests) {
							try {
								reports.push(
									await this.explorer.explore({
										runId: input.runId,
										plannerAttemptId: attemptId,
										objective: input.objective,
										question: request.question,
										baseCommit: input.inputCommit,
										repositoryRoot: input.repositoryRoot,
									}),
								);
							} catch (error) {
								failures.push(`${request.question}: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
						response = await runPlanner(explorationFollowUp(reports, failures), "PLAN_AFTER_EXPLORATION");
						try {
							plan = parseTaskPlan(response.lastAssistantText ?? "");
						} catch (error) {
							response = await runPlanner(
								"Your post-exploration response failed deterministic validation: " +
									(error instanceof Error ? error.message : String(error)) +
									". Return one corrected task-plan JSON object only; exploration is closed.",
								"PLAN_CORRECTION",
							);
							plan = parseTaskPlan(response.lastAssistantText ?? "");
						}
					}
				}
				if (!plan) throw new Error("Planner did not produce an authoritative task plan");
				this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor });
				this.kernel.completeAuxiliaryAttempt(attemptId, actor);
				applyTaskPlan({
					plan,
					runId: input.runId,
					sourceAttemptId: attemptId,
					kernel: this.kernel,
					acceptancePolicy,
					actor,
				});
				return plan;
			} catch (error) {
				if (executionId) {
					try {
						this.kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor });
					} catch {
						// Preserve the primary planner failure.
					}
				}
				try {
					this.kernel.failAttempt({
						attemptId,
						reason: error instanceof Error ? error.message : String(error),
						retryTask: false,
						actor,
					});
				} catch {
					// The attempt may already be durably submitted with its task graph.
				}
				throw error;
			} finally {
				unregister?.();
				await managed?.close();
				await bridge?.stop();
				if (worktree) await this.workspaces.removeWorktree(worktree);
			}
		});
	}
}
