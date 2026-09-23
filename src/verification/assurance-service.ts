import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executionPolicyFor } from "../config/execution.ts";
import type { ProjectPaths } from "../config/paths.ts";
import {
	type CheckCommand,
	checkCommandVersion,
	evidenceClassForCheck,
	type ProjectConfig,
} from "../config/project.ts";
import type { ControlCatalog, TaskDefinition } from "../control/catalog.ts";
import { allocateVerification } from "../control/compute-allocation.ts";
import type { ControlKernel } from "../control/kernel.ts";
import type { LocalResourceGovernor } from "../control/resource-governor.ts";
import { DomainInvariantError } from "../domain/model.ts";
import {
	assertFrozenProfile,
	constrainProfileTools,
	type ManagedPiWorker,
	type PiWorkerLauncher,
} from "../runtime/pi/launcher.ts";
import type { LiveAttemptRegistry } from "../runtime/pi/live-attempts.ts";
import { runMetered } from "../runtime/pi/metered-run.ts";
import type { GitWorkspaceManager, ManagedWorktree } from "../workspace/git.ts";
import {
	type AssuranceDefinition,
	type AssurancePlan,
	agentJson,
	assurancePolicyFor,
	type DiscriminatingProbe,
	definitionHash,
	parseAssuranceDefinition,
	probeSpecification,
	probesForSubject,
} from "./assurance-types.ts";
import type { CheckRunner } from "./check-runner.ts";

export interface AssuranceOutcome {
	status: "PASSED" | "FAILED" | "ERROR";
	checkIds: string[];
	detail: string;
}
interface Services {
	kernel: ControlKernel;
	catalog: ControlCatalog;
	workspaces: GitWorkspaceManager;
	launcher: PiWorkerLauncher;
	checks: CheckRunner;
	resources: LocalResourceGovernor;
	paths: ProjectPaths;
	config: ProjectConfig;
	liveAttempts?: LiveAttemptRegistry;
}
type Subject = "CANDIDATE" | "INTEGRATION" | "RUN";
const actor = { kind: "SYSTEM", id: "independent-assurance" } as const;
interface DesignFeedback {
	reason: string;
	definition?: unknown;
	baselineCommit?: string;
	rawResponse?: { text: string; originalBytes: number; truncated: boolean };
}
// Preserve complete proposals for repair; oversized responses are rejected, never silently truncated.
const MAX_DESIGN_DEFINITION_BYTES = 1024 * 1024;

function boundedRawResponse(text: string): NonNullable<DesignFeedback["rawResponse"]> {
	const bytes = Buffer.from(text);
	let end = Math.min(bytes.length, MAX_DESIGN_DEFINITION_BYTES);
	if (end < bytes.length) while (((bytes[end] as number) & 0xc0) === 0x80) end--;
	return {
		text: bytes.length <= MAX_DESIGN_DEFINITION_BYTES ? text : bytes.subarray(0, end).toString("utf8"),
		originalBytes: bytes.length,
		truncated: bytes.length > MAX_DESIGN_DEFINITION_BYTES,
	};
}

/** All inference uses the existing Pi launcher and shared metering. Test programs never enter the candidate. */
export class AssuranceService {
	constructor(private readonly services: Services) {}

	async ensure(task: TaskDefinition): Promise<AssurancePlan | null> {
		const { kernel, catalog } = this.services;
		this.allocate(task);
		if (!kernel.assurance.required(task.id)) return null;
		const previous = kernel.assurance.get(task.id);
		if (previous) return previous;
		const run = catalog.getRun(task.runId);
		const policy = assurancePolicyFor(run.goalContract);
		const assessment = catalog.getCoordinationAssessment(task.id);
		const outcomes = catalog.listControlActions(run.id).filter((a) => a.kind === "ASSURANCE_OUTCOME");
		const discoveries = outcomes.filter((a) => JSON.parse(a.detail_json).status === "FAILED").length;
		const uncertainty = assessment?.uncertainty ?? "HIGH";
		const desired =
			task.riskClass === "HIGH" || uncertainty === "HIGH" || discoveries > 0
				? 3
				: ["NORMAL", "MEDIUM"].includes(task.riskClass)
					? 2
					: 1;
		const maxProbes = policy.mode === "required" ? policy.maxProbes : Math.min(policy.maxProbes, desired);
		kernel.recordControlAction({
			runId: run.id,
			taskId: task.id,
			kind: "COMPUTE_ALLOCATION",
			detail: {
				action: "SPECIFICATION_AND_PROBES",
				alternatives: ["IMPLEMENT", "INVESTIGATE", "VERIFY"],
				reason: "Independent behavior evidence is required before accepting writer output",
				risk: task.riskClass,
				uncertainty,
				maxProbes,
				observations: outcomes.length,
				discoveries,
				estimator: "risk-rule-with-observed-counterexamples/v1",
				calibrated: false,
				budget: kernel.computeSnapshot(run.id),
			},
		});
		const history = catalog
			.listControlActions(run.id)
			.filter((action) => action.task_id === task.id && action.kind.startsWith("ASSURANCE_DESIGN_"))
			.map((action) => ({
				kind: action.kind,
				detail: JSON.parse(action.detail_json) as {
					revision?: string;
					attempt: number;
					reason?: string;
					definition?: unknown;
					baselineCommit?: string;
					rawResponse?: DesignFeedback["rawResponse"];
				},
			}))
			.filter((action) => action.detail.revision === task.revisionId)
			.sort((left, right) => left.detail.attempt - right.detail.attempt);
		const prior = history.filter((action) => action.kind === "ASSURANCE_DESIGN_ATTEMPT").length;
		const rejected = history.findLast((action) => action.kind === "ASSURANCE_DESIGN_REJECTED");
		const proposed = history.findLast((action) => action.kind === "ASSURANCE_DESIGN_PROPOSED");
		const retained = history.findLast((action) => action.detail.definition != null);
		let feedback: DesignFeedback | undefined = rejected
			? {
					reason: rejected.detail.reason ?? "Previous design rejected without a recorded reason",
					definition: rejected.detail.definition ?? retained?.detail.definition,
					baselineCommit:
						rejected.detail.definition == null ? retained?.detail.baselineCommit : rejected.detail.baselineCommit,
					rawResponse: rejected.detail.rawResponse,
				}
			: undefined;
		if (proposed && proposed.detail.attempt > (rejected?.detail.attempt ?? 0)) {
			feedback = {
				reason:
					"The previous design was interrupted before validation completed. Revalidate and repair it. " +
					(feedback?.reason ?? ""),
				definition: proposed.detail.definition ?? feedback?.definition,
				baselineCommit: proposed.detail.definition == null ? feedback?.baselineCommit : proposed.detail.baselineCommit,
			};
		}
		for (let attempt = prior; attempt < policy.maxDesignAttempts; attempt++) {
			kernel.recordControlAction({
				runId: run.id,
				taskId: task.id,
				kind: "ASSURANCE_DESIGN_ATTEMPT",
				detail: { revision: task.revisionId, attempt: attempt + 1 },
			});
			let proposedDefinition: unknown;
			let rawResponse: DesignFeedback["rawResponse"];
			try {
				const design = await this.ask(
					task,
					run.integrationHead,
					"SPECIFICATION_DESIGN",
					this.designPrompt(task, maxProbes, feedback),
					false,
				);
				let parsed: unknown;
				try {
					parsed = agentJson(design.text);
				} catch (error) {
					rawResponse = boundedRawResponse(design.text);
					throw new Error(
						"Invalid verification design JSON: " + (error instanceof Error ? error.message : String(error)),
						{ cause: error },
					);
				}
				if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_DESIGN_DEFINITION_BYTES)
					throw new Error("Verification definition exceeds 1 MiB; return a smaller complete plan");
				proposedDefinition = parsed;
				kernel.recordControlAction({
					runId: run.id,
					taskId: task.id,
					kind: "ASSURANCE_DESIGN_PROPOSED",
					detail: {
						revision: task.revisionId,
						attempt: attempt + 1,
						baselineCommit: run.integrationHead,
						definition: proposedDefinition,
					},
				});
				const definition = parseAssuranceDefinition(proposedDefinition, { ...policy, maxProbes });
				await this.bindSources(task, run.integrationHead, definition);
				const plan: AssurancePlan = {
					id: randomUUID(),
					runId: run.id,
					taskId: task.id,
					taskRevisionId: task.revisionId,
					baselineCommit: run.integrationHead,
					definition,
					designAttemptId: design.attemptId,
					criticAttemptId: "",
					controlCheckIds: [],
				};
				// Reject deterministic probe defects before allocating an independent model critique.
				// The draft has no critic authority and cannot pass the kernel's freeze gate.
				for (const probe of definition.probes) {
					const control = await this.runProbe(plan, probe, run.integrationHead, "RUN", run.id, 0, true);
					if (control.status !== "PASSED")
						throw new Error("Contrast is non-discriminating or invalid: " + control.detail);
					plan.controlCheckIds.push(...control.checkIds);
				}
				const critique = await this.ask(
					task,
					run.integrationHead,
					"PROBE_CRITIQUE",
					`Independently review this proposed verification plan using ONLY the public goal and baseline repository. No writer implementation exists in your input.\nRun goal: ${run.objective}\nTask: ${task.objective}\nConstraints: ${JSON.stringify(task.constraints)}\n${this.stageContext(task)}\nPlan: ${JSON.stringify(definition)}\nCheck each obligation against its quoted sources, check coverage of the task's core behaviors, and check exact expected outputs rather than only self-roundtrips. Assumptions are unresolved questions, not authority. Reject unsupported expectations, TASK probes that require downstream implementations, unsupported FINAL expectations, vacuous tests, tests that merely assert file existence for a behavioral feature, setup that fakes the actual implementation, and contrasts that raise errors instead of plausibly implementing the wrong behavior. The same assertions must accept a correct implementation and reject the contrasted wrong implementation. Python setup/assertions must execute directly; JavaScript must use await import, not static import. Return a compact verdict under 150 words; cite only decisive defects within the selected obligations. Return JSON only: {"approved":true,"reason":"source-grounded justification"}. Use false with concrete corrections if uncertain.`,
					true,
				);
				const verdict = agentJson(critique.text) as { approved?: unknown; reason?: unknown };
				if (verdict.approved !== true || typeof verdict.reason !== "string" || !verdict.reason.trim())
					throw new Error("Independent probe critique: " + String(verdict.reason));
				plan.criticAttemptId = critique.attemptId;
				kernel.assurance.freeze(plan);
				kernel.recordControlAction({
					runId: run.id,
					taskId: task.id,
					kind: "ASSURANCE_PLAN_FROZEN",
					detail: {
						planId: plan.id,
						definitionHash: definitionHash(definition),
						obligations: definition.obligations.length,
						probes: definition.probes.length,
						critic: verdict.reason,
					},
				});
				return plan;
			} catch (error) {
				feedback = {
					reason: error instanceof Error ? error.message : String(error),
					definition: proposedDefinition ?? feedback?.definition,
					baselineCommit: proposedDefinition == null ? feedback?.baselineCommit : run.integrationHead,
					rawResponse,
				};
				kernel.recordControlAction({
					runId: run.id,
					taskId: task.id,
					kind: "ASSURANCE_DESIGN_REJECTED",
					state: "REJECTED",
					detail: { revision: task.revisionId, attempt: attempt + 1, ...feedback },
				});
				if (kernel.computeSnapshot(run.id).unavailableReason) throw error;
			}
		}
		throw new DomainInvariantError(
			"ASSURANCE_DESIGN_EXHAUSTED",
			"Independent verification design exhausted its bounded attempts; " +
				(feedback?.reason ?? "Previous design attempts were interrupted before a rejection reason was recorded"),
		);
	}

	private allocate(task: TaskDefinition): void {
		const { kernel, catalog } = this.services;
		const run = catalog.getRun(task.runId);
		const goal = run.goalContract as { verificationPolicyVersion?: number };
		const policy = executionPolicyFor(goal);
		if (goal.verificationPolicyVersion !== 1 || !policy.enableComputeAllocation || kernel.assurance.allocation(task.id))
			return;
		kernel.atomic(() => {
			if (kernel.assurance.allocation(task.id)) return;
			const history = catalog.performanceHistory(run.id).filter((item) => item.writerSamples > 0);
			const samples = history.reduce((sum, item) => sum + item.writerSamples, 0);
			const mean = (key: "durationMs" | "costUsd" | "auxiliaryMs" | "auxiliaryCostUsd") =>
				samples ? history.reduce((sum, item) => sum + item[key] * item.writerSamples, 0) / samples : undefined;
			const contract = task.acceptanceContract as { integrationChecks: CheckCommand[]; requireReview: boolean };
			const budget = kernel.computeSnapshot(run.id);
			const assurance = assurancePolicyFor(goal);
			const remaining = catalog.listTasks(run.id).filter((t) => !["ACCEPTED", "CANCELLED"].includes(t.state));
			const decision = allocateVerification({
				policy,
				assurance,
				budget,
				risk: task.riskClass,
				uncertainty: catalog.getCoordinationAssessment(task.id)?.uncertainty ?? "MEDIUM",
				protectedBehavior: contract.integrationChecks.some((check) =>
					["BEHAVIORAL", "EXTERNAL"].includes(evidenceClassForCheck(check)),
				),
				reviewRequired: contract.requireReview,
				remainingTasks: remaining.length,
				remainingReviews: remaining.filter((t) => (t.acceptanceContract as { requireReview?: boolean }).requireReview)
					.length,
				successes: history.reduce((sum, item) => sum + item.successes, 0),
				failures: history.reduce((sum, item) => sum + item.failures, 0),
				writerMs: mean("durationMs"),
				writerUsd: mean("costUsd"),
				auxiliaryMs: mean("auxiliaryMs"),
				auxiliaryUsd: mean("auxiliaryCostUsd"),
			});
			kernel.recordControlAction({
				runId: run.id,
				taskId: task.id,
				kind: "VERIFICATION_ALLOCATION",
				detail: {
					...decision,
					revision: task.revisionId,
					budget,
					tokenLimit: Math.min(
						assurance.maxDesignTokens,
						policy.tokenLimit === undefined
							? Infinity
							: Math.max(1, Math.floor((policy.tokenLimit - budget.tokens - budget.reservedTokens) * 0.15)),
					),
					durationMs: Math.min(
						assurance.maxDesignMs,
						budget.remainingMs === null ? Infinity : Math.max(1, Math.floor(budget.remainingMs * 0.15)),
					),
				},
			});
		});
	}

	private designPrompt(task: TaskDefinition, maxProbes: number, feedback?: DesignFeedback): string {
		const run = this.services.catalog.getRun(task.runId);
		const policy = assurancePolicyFor(run.goalContract);
		const stageContext = this.stageContext(task);
		return `Derive a small independent executable verification plan BEFORE the implementation attempt. You see the baseline, public requirements and repository conventions, never the writer's explanation. Work read-only.\nRun goal: ${run.objective}\nTask: ${task.objective}\nScope: ${JSON.stringify(task.scope)}\nConstraints: ${JSON.stringify(task.constraints)}\n${stageContext}\nUse at most ${policy.maxObligations} obligations and ${maxProbes} probes. These are upper bounds, not quotas. Prefer 1–3 narrowly worded obligations and short programs; keep the complete JSON under 6000 characters. Focus on distinct compatibility risks, boundaries and error behavior. Every obligation must cite an EXACT, short, contiguous substring of one goal/task/constraint (kind GOAL) or a baseline file (kind FILE), and have a probe. Complete GOAL source example: {"kind":"GOAL","quote":"exact goal/task/constraint quotation"}. Complete FILE source example: {"kind":"FILE","path":"README.md","quote":"exact baseline file quotation"}. FILE requires the field named path (never source); use a literal path relative to the repository root, with no absolute path, .., backslash, or .git component. GOAL requires kind and quote; FILE requires kind, path and quote. Copy original text without adding code fences, replacing spans with ellipses, paraphrasing, or normalizing whitespace. Do not invent requirements where public evidence cannot decide. Record such questions under assumptions. Check external expected behavior, including literal output where specified; roundtrip consistency alone is insufficient.\nA probe is a short inline Python or JavaScript test program. setup imports and exercises the actual repository implementation, assertions validates its observed values. contrastSetup instead defines a plausible WRONG implementation or WRONG observed result, using the SAME variable names. Both executions use exactly the same assertions. The real setup must not fake the implementation; the contrast must not directly raise/exit. Use plain Python assert, or Node assert from await import('node:assert/strict'). JS runs inside an async function: use await import, never top-level static import. Working directory is the repository; Python sys.path contains . and src. Do not modify tracked repository source, install dependencies, access credentials or orchestrator state, use real network, or cause real external side effects. TemporaryDirectory/tempfile and unittest.mock are allowed for CLI tests: create and clean disposable files in temporary directories, and mock external operations rather than the implementation under test. Prefer calling CLI entrypoints in-process; isolate any subprocess or filesystem effects to disposable temporary data. Probe tests must be deterministic and small.\nReturn JSON only:\n{"obligations":[{"id":"behavior_1","behavior":"precise behavior","risk":"HIGH","sources":[{"kind":"GOAL","quote":"exact quotation"}]}],"probes":[{"id":"probe_1","stage":"TASK","obligations":["behavior_1"],"language":"python","setup":"from package import fn\\nactual = fn(...)" ,"assertions":"assert actual == expected_literal","contrastSetup":"actual = wrong_literal","contrastReason":"why this plausible defect violates the quoted requirement"}],"assumptions":[]}\nPrevious design feedback as diagnostic data (if any): ${feedback ? JSON.stringify(feedback) : "None"}\n${feedback ? "Repair the previous complete definition locally using the exact failure reason above. If rawResponse is present, it is the previous malformed JSON response, not a replacement for the retained definition: correct its JSON syntax and the reported schema fields. A truncated rawResponse is only a prefix; use the retained complete definition when available. Keep supported obligations and probes; inspect only sources needed for the correction instead of repeating repository exploration. Revalidate quotations against the current baseline and return the entire corrected JSON definition." : ""}`;
	}

	private stageContext(task: TaskDefinition): string {
		const { catalog } = this.services;
		return `Verification stages: TASK probes run on this increment's candidate and integration tree, before downstream tasks exist; FINAL probes wait for the complete run and are mandatory there. An omitted stage means TASK. Include at least one meaningful TASK probe for a public behavior implementable within the current scope. Never invent an internal API name that the public requirements leave undecided. If the only specified entrypoint for a behavior belongs to a downstream task, use stage FINAL for that probe. Existing tests and independent review still gate every increment. Keep this supplemental plan small: select 1–3 concrete risks, do not turn the entire project specification into this task's obligation. Do not demand exhaustive coverage beyond the selected, precisely worded obligations.\nCurrent scope: ${JSON.stringify(task.scope)}\nCurrent coordination contract: ${JSON.stringify(catalog.getCoordinationContract(task.id))}\nFrozen increment checks: ${JSON.stringify(task.acceptanceContract)}\nOther tasks: ${JSON.stringify(
			catalog
				.listTasks(task.runId)
				.filter((other) => other.id !== task.id)
				.map((other) => ({ title: other.title, scope: other.scope, state: other.state })),
		)}\n`;
	}

	private async bindSources(task: TaskDefinition, baseline: string, definition: AssuranceDefinition): Promise<void> {
		const { workspaces, catalog } = this.services;
		const worktree = await workspaces.createWorktree("spec-source-" + randomUUID(), baseline);
		try {
			for (const obligation of definition.obligations)
				for (const source of obligation.sources) {
					if (source.kind === "FILE") {
						const artifact = await workspaces.artifactEntry(baseline, source.path as string);
						if (!["100644", "100755"].includes(artifact.mode))
							throw new Error("Specification source must be a regular tracked file");
						source.blobHash = artifact.blobHash;
					}
					const sources =
						source.kind === "GOAL"
							? [
									catalog.getRun(task.runId).objective,
									task.objective,
									...(Array.isArray(task.constraints) ? task.constraints : [task.constraints]).map(
										(constraint: unknown) =>
											typeof constraint === "string" ? constraint : (JSON.stringify(constraint) ?? ""),
									),
								]
							: [await readFile(join(worktree.path, source.path as string), "utf8")];
					if (!sources.some((content) => content.includes(source.quote)))
						throw new Error(
							`Untraceable specification quotation for obligation ${obligation.id}, source ${source.kind}${source.kind === "FILE" ? " " + JSON.stringify(source.path) : ""}: ${JSON.stringify(source.quote)}. Copy a short, contiguous substring of the original source exactly; do not add code fences, replace spans with ellipses, paraphrase, or normalize whitespace.`,
						);
				}
		} finally {
			await workspaces.removeWorktree(worktree);
		}
	}

	async evaluate(taskIds: string[], commit: string, subject: Subject, subjectId: string): Promise<AssuranceOutcome> {
		const { kernel, catalog } = this.services;
		const all: AssuranceOutcome = { status: "PASSED", checkIds: [], detail: "Independent probes passed" };
		for (const taskId of taskIds) {
			if (!kernel.assurance.required(taskId)) continue;
			const plan = kernel.assurance.get(taskId);
			if (!plan) return { ...all, status: "ERROR", detail: "Missing frozen specification plan for " + taskId };
			const policy = assurancePolicyFor(catalog.getRun(plan.runId).goalContract);
			const treeHash = await this.services.workspaces.treeHash(commit);
			const evaluationId = kernel.assurance.beginEvaluation(plan, treeHash, subject, subjectId);
			let completed = false;
			try {
				for (const probe of probesForSubject(plan, subject)) {
					const results: AssuranceOutcome[] = [];
					for (let repeat = 0; repeat < policy.repetitions; repeat++)
						results.push(await this.runProbe(plan, probe, commit, subject, subjectId, repeat, false, evaluationId));
					all.checkIds.push(...results.flatMap((r) => r.checkIds));
					const states = new Set(results.map((r) => r.status));
					const status = states.size > 1 || states.has("ERROR") ? "ERROR" : (results[0]?.status ?? "ERROR");
					kernel.recordControlAction({
						runId: plan.runId,
						taskId,
						kind: "ASSURANCE_OUTCOME",
						state: status,
						detail: {
							planId: plan.id,
							evaluationId,
							probeId: probe.id,
							subject,
							subjectId,
							treeHash,
							status,
							flaky: states.size > 1,
							checkIds: results.flatMap((r) => r.checkIds),
						},
					});
					if (status !== "PASSED") {
						kernel.assurance.finishEvaluation(evaluationId, status);
						completed = true;
						return {
							...all,
							status,
							detail:
								(states.size > 1 ? "Inconsistent probe outcomes; no product verdict. " : "") +
								results.map((r) => r.detail).join("\n"),
						};
					}
				}
				kernel.assurance.finishEvaluation(evaluationId, "PASSED");
				completed = true;
			} finally {
				if (!completed) kernel.assurance.finishEvaluation(evaluationId, "ERROR");
			}
		}
		return all;
	}

	private async runProbe(
		plan: AssurancePlan,
		probe: DiscriminatingProbe,
		commit: string,
		subject: Subject,
		subjectId: string,
		repeat: number,
		control: boolean,
		evaluationId?: string,
	): Promise<AssuranceOutcome> {
		const { kernel, catalog, workspaces, checks, paths } = this.services;
		const run = catalog.getRun(plan.runId);
		const policy = assurancePolicyFor(run.goalContract);
		const worktree = await workspaces.createWorktree("probe-" + randomUUID(), commit);
		const specification = probeSpecification(plan, probe, policy, repeat, control);
		const startedAt = new Date().toISOString();
		try {
			const remaining = kernel.computeSnapshot(run.id).remainingMs;
			if (remaining === 0) throw new Error("Run deadline exhausted before independent verification");
			const result = await checks.run(
				specification,
				{
					cwd: worktree.path,
					baseCommit: plan.baselineCommit,
					subjectCommit: commit,
					runInputCommit: run.inputCommit,
					artifactDirectory: join(paths.artifacts, run.id, "assurance", plan.id),
				},
				remaining === null ? undefined : AbortSignal.timeout(Math.max(1, remaining)),
			);
			const stdout = await readFile(result.stdoutPath, "utf8"),
				stderr = await readFile(result.stderrPath, "utf8");
			const assertion =
				result.state === "FAILED" && result.exitCode === 1 && stderr.includes("TRIPLETEAM_PROBE_ASSERTION");
			const pass = result.state === "PASSED" && stdout.includes("TRIPLETEAM_PROBE_PASSED");
			const state = control ? (assertion ? "PASSED" : "ERROR") : pass ? "PASSED" : assertion ? "FAILED" : "ERROR";
			const treeHash = await workspaces.treeHash(commit);
			const id = kernel.recordCheckResult({
				runId: run.id,
				taskId: plan.taskId,
				subjectKind: subject,
				subjectId,
				treeHash,
				checkKind: specification.name,
				checkVersion: checkCommandVersion(specification),
				evidenceClass: "BUILD",
				command: result.command,
				environmentHash: result.environmentHash,
				state,
				exitCode: result.exitCode,
				stdoutPath: result.stdoutPath,
				stderrPath: result.stderrPath,
				result: {
					...result.result,
					assurance: {
						control,
						evaluationId,
						probeId: probe.id,
						definitionHash: definitionHash(plan.definition),
						origin: "MODEL_DERIVED_SUPPLEMENT",
						observedState: result.state,
					},
				},
				artifacts: [
					{ ...result.stdoutArtifact, kind: "CHECK_STDOUT" },
					{ ...result.stderrArtifact, kind: "CHECK_STDERR" },
				].map(({ path, ...entry }) => ({ ...entry, storageLocator: path, storageKind: "LOCAL_FILE" as const })),
				actor,
			});
			kernel.recordUsage({
				runId: run.id,
				taskId: plan.taskId,
				kind: "CHECK",
				phase: control ? "PROBE_CONTROL" : "INDEPENDENT_PROBE",
				startedAt,
				finishedAt: new Date().toISOString(),
				details: { checkId: id, probeId: probe.id, state },
			});
			return {
				status: state,
				checkIds: [id],
				detail: `${probe.id}: ${state}\n${stderr.slice(-8000)}\n${stdout.slice(-2000)}`,
			};
		} finally {
			await workspaces.removeWorktree(worktree);
		}
	}

	private async ask(
		task: TaskDefinition,
		baseline: string,
		phase: string,
		prompt: string,
		critic: boolean,
	): Promise<{ text: string; attemptId: string }> {
		const { kernel, catalog, launcher, resources, workspaces, paths, config, liveAttempts } = this.services;
		return resources.run("INTERACTIVE", async () => {
			const run = catalog.getRun(task.runId);
			const policy = assurancePolicyFor(run.goalContract);
			const tools = ["read", "grep", "find", "ls"];
			const role = critic ? "reviewer" : "verifier";
			const profile = constrainProfileTools(
				launcher.resolveProfile(
					run.repositoryRoot,
					critic ? config.profiles.reviewer : (config.profiles.verifier ?? "verifier"),
					tools,
					executionPolicyFor(run.goalContract),
					role,
				),
				tools,
			);
			assertFrozenProfile(run.goalContract, critic ? "REVIEW" : "VERIFY", profile);
			const attemptId = randomUUID();
			kernel.startAuxiliaryAttempt({
				id: attemptId,
				runId: run.id,
				taskId: task.id,
				workflowFunction: "REVIEW",
				baseCommit: baseline,
				profileName: profile.name,
				profileVersion: profile.version,
				actor,
			});
			let worktree: ManagedWorktree | undefined,
				managed: ManagedPiWorker | undefined,
				executionId: string | undefined,
				unregister: (() => void) | undefined;
			try {
				worktree = await workspaces.createWorktree(attemptId, baseline);
				const sessionId = "assurance-" + attemptId;
				executionId = kernel.createExecution({
					attemptId,
					piSessionId: sessionId,
					contextManifestHash: definitionHash(prompt),
					actor,
				});
				managed = await launcher.create(
					{
						cwd: worktree.path,
						sessionDirectory: paths.sessions,
						sessionId,
						sessionName: phase + " " + task.title.slice(0, 60),
						profileName: profile.name,
						defaultTools: profile.tools,
					},
					profile,
				);
				const state = await managed.worker.start();
				kernel.markExecutionLive({ executionId, sessionFile: state.sessionFile, actor });
				unregister = liveAttempts?.register(attemptId, task.id, managed.worker);
				const allocation = {
					tokenLimit: kernel.assurance.allocation(task.id)?.tokenLimit ?? policy.maxDesignTokens,
					toolCallLimit: policy.maxDesignToolCalls,
					durationMs: kernel.assurance.allocation(task.id)?.durationMs ?? policy.maxDesignMs,
					label: critic ? "Assurance probe critique" : "Assurance specification design",
				};
				const started = Date.now();
				let response = await runMetered(managed.worker, {
					kernel,
					catalog,
					runId: run.id,
					taskId: task.id,
					attemptId,
					executionId,
					phase,
					prompt,
					timeoutMs: Math.min(config.workerTimeoutMs, policy.maxDesignMs),
					phaseBudget: allocation,
				});
				if (critic) {
					let invalid: string | undefined;
					try {
						const verdict = agentJson(response.lastAssistantText ?? "") as {
							approved?: unknown;
							reason?: unknown;
						} | null;
						if (
							!verdict ||
							typeof verdict.approved !== "boolean" ||
							typeof verdict.reason !== "string" ||
							!verdict.reason.trim()
						)
							invalid = "Expected boolean approved and nonempty reason";
					} catch (error) {
						invalid = error instanceof Error ? error.message : String(error);
					}
					if (invalid) {
						const usage = response.usage;
						kernel.recordControlAction({
							runId: run.id,
							taskId: task.id,
							kind: "ASSURANCE_CRITIQUE_FORMAT_REPAIR",
							detail: {
								revision: task.revisionId,
								attemptId,
								reason: invalid,
								stopReason: response.stopReason,
								rawResponse: boundedRawResponse(response.lastAssistantText ?? ""),
							},
						});
						response = await runMetered(managed.worker, {
							kernel,
							catalog,
							runId: run.id,
							taskId: task.id,
							attemptId,
							executionId,
							phase: "PROBE_CRITIQUE_FORMAT_REPAIR",
							prompt: `Your verdict was missing or invalid (${invalid}; stop reason ${response.stopReason ?? "unknown"}). Use the evidence already inspected. Return one compact JSON object now, with boolean approved and a nonempty reason of at most 150 words. Do not repeat the plan, redesign tests, or perform new repository exploration. If evidence is insufficient, approved must be false and reason must identify the specific missing evidence. A valid negative verdict is preferable to unfinished analysis.`,
							timeoutMs: Math.min(config.workerTimeoutMs, allocation.durationMs - (Date.now() - started)),
							phaseBudget: {
								...allocation,
								tokenLimit:
									allocation.tokenLimit -
									usage.inputTokens -
									usage.outputTokens -
									usage.cacheReadTokens -
									usage.cacheWriteTokens,
								toolCallLimit: allocation.toolCallLimit - usage.toolCalls,
								durationMs: allocation.durationMs - (Date.now() - started),
							},
						});
					}
				}
				kernel.finishExecution({ executionId, state: "EXITED", exitCode: 0, actor });
				kernel.completeAuxiliaryAttempt(attemptId, actor);
				return { attemptId, text: response.lastAssistantText ?? "" };
			} catch (error) {
				if (executionId) {
					try {
						kernel.finishExecution({ executionId, state: "EXITED", exitCode: 1, actor });
					} catch {
						/* Preserve primary error. */
					}
				}
				try {
					kernel.failAttempt({ attemptId, reason: String(error), retryTask: false, actor });
				} catch {
					/* Already settled. */
				}
				throw error;
			} finally {
				unregister?.();
				await managed?.close();
				if (worktree) await workspaces.removeWorktree(worktree);
			}
		});
	}
}
