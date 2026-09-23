import { createHash } from "node:crypto";
import { type CheckCommand, type CheckIsolation, parseCheckCommand } from "../config/project.ts";

export interface AssurancePolicy {
	mode: "adaptive" | "required" | "off";
	maxObligations: number;
	maxProbes: number;
	maxDesignAttempts: number;
	maxDesignTokens: number;
	maxDesignToolCalls: number;
	maxDesignMs: number;
	repetitions: number;
	probeTimeoutMs: number;
	isolation?: CheckIsolation;
}

export function parseAssurancePolicy(value: unknown = {}): AssurancePolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assurance must be an object");
	const raw = value as Record<string, unknown>;
	const mode = raw.mode === undefined ? "adaptive" : raw.mode;
	if (mode !== "adaptive" && mode !== "required" && mode !== "off") throw new Error("Invalid assurance.mode");
	const number = (key: string, fallback: number, max: number) => {
		const n = raw[key] === undefined ? fallback : raw[key];
		if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max)
			throw new Error(`assurance.${key} must be an integer between 1 and ${max}`);
		return n as number;
	};
	return {
		mode,
		maxObligations: number("maxObligations", 8, 24),
		maxProbes: number("maxProbes", 3, 8),
		maxDesignAttempts: number("maxDesignAttempts", 2, 4),
		maxDesignTokens: number("maxDesignTokens", 300_000, 3_000_000),
		maxDesignToolCalls: number("maxDesignToolCalls", 40, 400),
		maxDesignMs: number("maxDesignMs", 180_000, 1_800_000),
		repetitions: number("repetitions", 2, 3),
		probeTimeoutMs: number("probeTimeoutMs", 30_000, 300_000),
		isolation:
			raw.isolation === undefined
				? undefined
				: parseCheckCommand({ name: "assurance", argv: ["true"], isolation: raw.isolation }, "assurance").isolation,
	};
}

/** Old runs retain their frozen semantics; new runs explicitly freeze this policy. */
export function assurancePolicyFor(goal: unknown): AssurancePolicy {
	const value = goal as { assurancePolicy?: unknown } | null;
	return parseAssurancePolicy(value?.assurancePolicy === undefined ? { mode: "off" } : value.assurancePolicy);
}

export interface SpecificationSource {
	kind: "GOAL" | "FILE";
	path?: string;
	quote: string;
	blobHash?: string;
}

export interface BehaviorObligation {
	id: string;
	behavior: string;
	risk: "LOW" | "MEDIUM" | "HIGH";
	sources: SpecificationSource[];
}

export interface DiscriminatingProbe {
	id: string;
	/** Omitted on legacy plans: execute at every gate. FINAL waits for the complete run tree. */
	stage?: "TASK" | "FINAL";
	obligations: string[];
	language: "python" | "javascript";
	setup: string;
	assertions: string;
	contrastSetup: string;
	contrastReason: string;
}

export interface AssuranceDefinition {
	obligations: BehaviorObligation[];
	probes: DiscriminatingProbe[];
	assumptions: string[];
}

export interface AssurancePlan {
	id: string;
	runId: string;
	taskId: string;
	taskRevisionId: string;
	baselineCommit: string;
	definition: AssuranceDefinition;
	designAttemptId: string;
	criticAttemptId: string;
	controlCheckIds: string[];
}

export function probesForSubject(plan: AssurancePlan, subject: "CANDIDATE" | "INTEGRATION" | "RUN") {
	return plan.definition.probes.filter((probe) => subject === "RUN" || probe.stage !== "FINAL");
}

export function probeSpecification(
	plan: AssurancePlan,
	probe: DiscriminatingProbe,
	policy: AssurancePolicy,
	repeat: number,
	control = false,
): CheckCommand {
	return {
		name: `assurance:${plan.id}:${probe.id}:${control ? "control" : repeat}`,
		argv: probeArgv(probe, control),
		timeoutMs: policy.probeTimeoutMs,
		lane: "HEAVY_CHECK",
		evidenceClass: "BUILD",
		isolation: policy.isolation,
	};
}

export function agentJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		// Quotes and probe programs can contain backticks inside valid JSON strings.
		// Only treat a fence around the whole response as response formatting.
	}
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	const source = fenced?.[1] ?? trimmed;
	const start = source.indexOf("{"),
		end = source.lastIndexOf("}");
	return JSON.parse(start >= 0 && end >= start ? source.slice(start, end + 1) : source) as unknown;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 16_000): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
		throw new Error(`Invalid ${label}`);
	return value;
}
function array(value: unknown, label: string, max: number): unknown[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`Invalid ${label}`);
	return value;
}
function identifier(value: unknown): string {
	const id = string(value, "identifier", 64);
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid identifier");
	return id;
}
function unique(ids: string[]): void {
	if (new Set(ids).size !== ids.length) throw new Error("Duplicate obligation or probe identifier");
}

export function parseAssuranceDefinition(value: unknown, policy: AssurancePolicy): AssuranceDefinition {
	const raw = object(value);
	const obligations = array(raw.obligations, "obligations", policy.maxObligations).map(
		(item, obligationIndex): BehaviorObligation => {
			const o = object(item);
			if (!["LOW", "MEDIUM", "HIGH"].includes(String(o.risk))) throw new Error("Invalid obligation risk");
			return {
				id: identifier(o.id),
				behavior: string(o.behavior, "behavior", 3000),
				risk: o.risk as BehaviorObligation["risk"],
				sources: array(o.sources, "sources", 5).map((item, sourceIndex): SpecificationSource => {
					try {
						const s = object(item);
						if (s.kind !== "GOAL" && s.kind !== "FILE") throw new Error("Invalid source kind");
						const path = s.kind === "FILE" ? string(s.path, "source path", 500) : undefined;
						if (
							path &&
							(/^(?:[/:]|[a-zA-Z]:)/.test(path) ||
								/[\\\r\n]/.test(path) ||
								path.split("/").some((p) => ["..", ".git", "."].includes(p)))
						)
							throw new Error("Source must be a literal repository-relative path without traversal or .git access");
						return { kind: s.kind, path, quote: string(s.quote, "source quote", 3000) };
					} catch (error) {
						const keys = item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : [];
						throw new Error(
							`Invalid source at obligations[${obligationIndex}].sources[${sourceIndex}] (obligation ${JSON.stringify(o.id)}): ${error instanceof Error ? error.message : String(error)}. Actual field keys: ${JSON.stringify(keys)}. GOAL requires kind and quote; example: {"kind":"GOAL","quote":"exact goal quotation"}. FILE requires kind, path and quote; example: {"kind":"FILE","path":"README.md","quote":"exact file quotation"}. Use the field path, not source, for a literal repository-relative file path; no absolute paths, .., backslashes or .git components.`,
							{ cause: error },
						);
					}
				}),
			};
		},
	);
	unique(obligations.map((o) => o.id));
	const probes = array(raw.probes, "probes", policy.maxProbes).map((item): DiscriminatingProbe => {
		const p = object(item);
		if (p.stage !== undefined && p.stage !== "TASK" && p.stage !== "FINAL")
			throw new Error("Probe stage must be TASK or FINAL");
		if (p.language !== "python" && p.language !== "javascript") throw new Error("Unsupported probe language");
		const covered = array(p.obligations, "probe obligations", policy.maxObligations).map(identifier);
		unique(covered);
		if (covered.some((id) => !obligations.some((o) => o.id === id))) throw new Error("Unknown probe obligation");
		const probe = {
			id: identifier(p.id),
			...(p.stage === undefined ? {} : { stage: p.stage as "TASK" | "FINAL" }),
			obligations: covered,
			language: p.language,
			setup: string(p.setup, "probe setup"),
			assertions: string(p.assertions, "probe assertions"),
			contrastSetup: string(p.contrastSetup, "contrast setup"),
			contrastReason: string(p.contrastReason, "contrast reason", 3000),
		};
		if (probe.setup === probe.contrastSetup) throw new Error("Contrast must represent a distinct incorrect behavior");
		return probe as DiscriminatingProbe;
	});
	unique(probes.map((p) => p.id));
	if (!probes.some((probe) => probe.stage !== "FINAL"))
		throw new Error("At least one TASK probe must verify the current increment before integration");
	if (obligations.some((o) => !probes.some((p) => p.obligations.includes(o.id))))
		throw new Error("Uncovered specification obligation");
	if (
		!Array.isArray(raw.assumptions) ||
		raw.assumptions.some((v) => typeof v !== "string") ||
		raw.assumptions.length > 12
	)
		throw new Error("assumptions must be a bounded string array");
	return { obligations, probes, assumptions: raw.assumptions.map((value) => string(value, "assumption", 3000)) };
}

export function definitionHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Both executions use the identical assertion body. Only the implementation setup differs. */
export function probeArgv(probe: DiscriminatingProbe, contrast = false): string[] {
	const setup = contrast ? probe.contrastSetup : probe.setup;
	if (probe.language === "python")
		return [
			"python3",
			"-B",
			"-c",
			`import sys, traceback\nsys.path[:0] = ['.', 'src']\nscope = {}\ntry:\n    exec(compile(${JSON.stringify(setup)}, '<tripleteam-setup>', 'exec'), scope)\nexcept BaseException:\n    traceback.print_exc()\n    sys.exit(2)\ntry:\n    exec(compile(${JSON.stringify(probe.assertions)}, '<tripleteam-assertions>', 'exec'), scope)\nexcept AssertionError:\n    traceback.print_exc()\n    print('TRIPLETEAM_PROBE_ASSERTION', file=sys.stderr)\n    sys.exit(1)\nexcept BaseException:\n    traceback.print_exc()\n    sys.exit(2)\nprint('TRIPLETEAM_PROBE_PASSED')`,
		];
	return [
		"node",
		"--input-type=module",
		"-e",
		`try { await (async () => {\n${setup}\ntry {\n${probe.assertions}\n} catch (error) { if(error?.code === 'ERR_ASSERTION') { console.error(error); console.error('TRIPLETEAM_PROBE_ASSERTION'); process.exitCode=1; return; } throw error; } console.log('TRIPLETEAM_PROBE_PASSED'); })(); } catch(error) { console.error(error); process.exitCode=2; }`,
	];
}
