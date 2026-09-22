import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceClass } from "../domain/model.ts";
import { type ExecutionPolicy, parseExecutionPolicy } from "./execution.ts";

export type CheckLane = "LIGHT_CHECK" | "HEAVY_CHECK";

export interface CheckOracle {
	/** Literal repository-relative files/directories, frozen at the run input commit. */
	protectedPaths: string[];
}

export interface CheckIsolation {
	kind: "DOCKER";
	/** Immutable image ID or registry digest. Images must already be installed. */
	image: string;
	memoryMb?: number;
	cpus?: number;
}

export interface CheckCommand {
	name: string;
	argv: string[];
	timeoutMs: number;
	lane: CheckLane;
	evidenceClass?: EvidenceClass;
	oracle?: CheckOracle;
	isolation?: CheckIsolation;
}

export interface ProjectConfig {
	execution?: ExecutionPolicy;
	maxExplorationAttempts?: number;
	maxAttemptsPerTask: number;
	maxPlannerExplorations: number;
	maxDiverseExplorations?: number;
	maxRepeatedFailureFingerprints?: number;
	workerTimeoutMs: number;
	candidateChecks: CheckCommand[];
	integrationChecks: CheckCommand[];
	runChecks: CheckCommand[];
	reviewRequiredFor: string[];
	profiles: {
		explorer: string;
		planner: string;
		implementer: string;
		reviewer: string;
	};
}

type CheckIdentity = Omit<CheckCommand, "argv" | "oracle"> & {
	argv: readonly string[];
	oracle?: { protectedPaths: readonly string[] };
};

export function isPinnedCheckImage(image: string): boolean {
	return /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(image);
}

export function evidenceClassForCheck(check: CheckIdentity): EvidenceClass {
	const declared = check.evidenceClass ?? "STRUCTURAL";
	if (declared !== "BEHAVIORAL" && declared !== "EXTERNAL") return declared;
	// A command name or a mutable local test script cannot establish verified delivery.
	return check.oracle?.protectedPaths.length &&
		check.isolation?.kind === "DOCKER" &&
		isPinnedCheckImage(check.isolation.image)
		? declared
		: "BUILD";
}

export function checkCommandVersion(check: CheckIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				name: check.name,
				argv: check.argv,
				timeoutMs: check.timeoutMs,
				lane: check.lane,
				evidenceClass: evidenceClassForCheck(check),
				oracle: check.oracle ? { protectedPaths: [...check.oracle.protectedPaths].sort() } : undefined,
				isolation: check.isolation
					? {
							kind: check.isolation.kind,
							image: check.isolation.image,
							memoryMb: check.isolation.memoryMb ?? 2048,
							cpus: check.isolation.cpus ?? 2,
						}
					: undefined,
			}),
		)
		.digest("hex");
}

export interface FrozenAcceptancePolicy {
	candidateChecks: CheckCommand[];
	integrationChecks: CheckCommand[];
	reviewRequiredFor: string[];
}

const CONFIG_FILE = ".tripleteam.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(field + " must be a positive integer");
	}
	return value as number;
}

export function parseCheckCommand(entry: unknown, field: string): CheckCommand {
	if (!isRecord(entry)) throw new Error(`${field} must be an object`);
	if (typeof entry.name !== "string" || entry.name.trim() === "") {
		throw new Error(`${field}.name must be a non-empty string`);
	}
	if (
		!Array.isArray(entry.argv) ||
		entry.argv.length === 0 ||
		!entry.argv.every((item) => typeof item === "string" && !item.includes("\0")) ||
		!(entry.argv[0] as string).trim()
	) {
		throw new Error(`${field}.argv must be a non-empty string array`);
	}
	const lane = entry.lane ?? "HEAVY_CHECK";
	if (lane !== "LIGHT_CHECK" && lane !== "HEAVY_CHECK") {
		throw new Error(`${field}.lane must be LIGHT_CHECK or HEAVY_CHECK`);
	}
	const evidenceClass = entry.evidenceClass;
	if (
		evidenceClass !== undefined &&
		evidenceClass !== "STRUCTURAL" &&
		evidenceClass !== "BUILD" &&
		evidenceClass !== "BEHAVIORAL" &&
		evidenceClass !== "EXTERNAL"
	) {
		throw new Error(`${field}.evidenceClass is invalid`);
	}
	let oracle: CheckOracle | undefined;
	if (entry.oracle !== undefined) {
		const value = entry.oracle;
		if (
			!isRecord(value) ||
			!Array.isArray(value.protectedPaths) ||
			value.protectedPaths.length === 0 ||
			!value.protectedPaths.every(
				(path) =>
					typeof path === "string" &&
					path.length > 0 &&
					!path.startsWith("/") &&
					!path.includes("\\") &&
					!path.includes("\0") &&
					!path.split("/").some((part) => part === ".." || part === ".git") &&
					!path.startsWith(":") &&
					!/[\r\n]/.test(path),
			)
		) {
			throw new Error(`${field}.oracle.protectedPaths must contain literal repository-relative paths`);
		}
		oracle = { protectedPaths: [...new Set(value.protectedPaths as string[])].sort() };
	}
	let isolation: CheckIsolation | undefined;
	if (entry.isolation !== undefined) {
		const value = entry.isolation;
		if (
			!isRecord(value) ||
			value.kind !== "DOCKER" ||
			typeof value.image !== "string" ||
			!isPinnedCheckImage(value.image)
		) {
			throw new Error(`${field}.isolation requires DOCKER and an immutable sha256 image digest`);
		}
		const cpus = value.cpus ?? 2;
		if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0) {
			throw new Error(`${field}.isolation.cpus must be positive`);
		}
		isolation = {
			kind: "DOCKER",
			image: value.image,
			memoryMb: positiveInteger(value.memoryMb, 2048, `${field}.isolation.memoryMb`),
			cpus,
		};
	}
	return {
		name: entry.name,
		argv: entry.argv as string[],
		timeoutMs: positiveInteger(entry.timeoutMs, 15 * 60_000, `${field}.timeoutMs`),
		lane,
		evidenceClass: evidenceClass as EvidenceClass | undefined,
		oracle,
		isolation,
	};
}

function parseChecks(value: unknown, fallback: CheckCommand[], field: string): CheckCommand[] {
	if (value === undefined) return fallback;
	if (!Array.isArray(value) || value.length === 0) throw new Error(field + " must be a non-empty array");
	const checks = value.map((entry, index) => parseCheckCommand(entry, `${field}[${index}]`));
	if (new Set(checks.map((check) => check.name)).size !== checks.length) {
		throw new Error(field + " must contain unique check names");
	}
	return checks;
}

async function detectedIntegrationChecks(repositoryRoot: string): Promise<CheckCommand[]> {
	try {
		const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		const scripts = packageJson.scripts ?? {};
		const checks: CheckCommand[] = [];
		if (typeof scripts.check === "string") {
			checks.push({
				name: "project-check",
				argv: ["npm", "run", "check"],
				timeoutMs: 15 * 60_000,
				lane: "HEAVY_CHECK",
				evidenceClass: "BUILD",
			});
		}
		if (typeof scripts.test === "string") {
			checks.push({
				name: "project-test",
				argv: ["npm", "test"],
				timeoutMs: 20 * 60_000,
				lane: "HEAVY_CHECK",
				evidenceClass: "BUILD",
			});
		}
		if (checks.length > 0) return checks;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw new Error("Invalid package.json while detecting checks", { cause: error });
	}
	return [
		{
			name: "integration-diff-safety",
			argv: ["git", "diff", "--check", "$RUN_INPUT", "$SUBJECT"],
			timeoutMs: 60_000,
			lane: "LIGHT_CHECK",
			evidenceClass: "STRUCTURAL",
		},
	];
}

export async function loadProjectConfig(repositoryRoot: string): Promise<ProjectConfig> {
	const detected = await detectedIntegrationChecks(repositoryRoot);
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(join(repositoryRoot, CONFIG_FILE), "utf8"));
		if (!isRecord(parsed)) throw new Error(CONFIG_FILE + " must contain an object");
		raw = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const profiles = raw.profiles;
	if (profiles !== undefined && !isRecord(profiles)) throw new Error("profiles must be an object");
	const profileRecord = (profiles ?? {}) as Record<string, unknown>;
	const profile = (name: string, fallback: string): string => {
		const value = profileRecord[name];
		if (value === undefined) return fallback;
		if (typeof value !== "string" || value.trim() === "") throw new Error(`profiles.${name} must be a string`);
		return value;
	};
	const reviewRequiredFor = raw.reviewRequiredFor ?? ["HIGH"];
	if (!Array.isArray(reviewRequiredFor) || !reviewRequiredFor.every((item) => typeof item === "string")) {
		throw new Error("reviewRequiredFor must be a string array");
	}
	return {
		execution: parseExecutionPolicy(raw.execution),
		maxExplorationAttempts: positiveInteger(raw.maxExplorationAttempts, 2, "maxExplorationAttempts"),
		maxAttemptsPerTask: positiveInteger(raw.maxAttemptsPerTask, 3, "maxAttemptsPerTask"),
		maxPlannerExplorations: positiveInteger(raw.maxPlannerExplorations, 3, "maxPlannerExplorations"),
		maxDiverseExplorations: positiveInteger(raw.maxDiverseExplorations, 2, "maxDiverseExplorations"),
		maxRepeatedFailureFingerprints: positiveInteger(
			raw.maxRepeatedFailureFingerprints,
			2,
			"maxRepeatedFailureFingerprints",
		),
		workerTimeoutMs: positiveInteger(raw.workerTimeoutMs, 45 * 60_000, "workerTimeoutMs"),
		candidateChecks: parseChecks(
			raw.candidateChecks,
			[
				{
					name: "candidate-diff-safety",
					argv: ["git", "diff", "--check", "$BASE", "$SUBJECT"],
					timeoutMs: 60_000,
					lane: "LIGHT_CHECK",
				},
			],
			"candidateChecks",
		),
		integrationChecks: parseChecks(raw.integrationChecks, detected, "integrationChecks"),
		runChecks: parseChecks(raw.runChecks, detected, "runChecks"),
		reviewRequiredFor: reviewRequiredFor as string[],
		profiles: {
			explorer: profile("explorer", "explorer"),
			planner: profile("planner", "planner"),
			implementer: profile("implementer", "implementer"),
			reviewer: profile("reviewer", "reviewer"),
		},
	};
}

export function acceptancePolicyForRun(goalContract: unknown, fallback: ProjectConfig): FrozenAcceptancePolicy {
	if (!isRecord(goalContract) || !isRecord(goalContract.taskAcceptancePolicy)) {
		return {
			candidateChecks: fallback.candidateChecks,
			integrationChecks: fallback.integrationChecks,
			reviewRequiredFor: fallback.reviewRequiredFor,
		};
	}
	const policy = goalContract.taskAcceptancePolicy;
	const reviewRequiredFor = policy.reviewRequiredFor;
	if (!Array.isArray(reviewRequiredFor) || !reviewRequiredFor.every((item) => typeof item === "string")) {
		throw new Error("Pinned goal contract has an invalid review policy");
	}
	return {
		candidateChecks: parseChecks(policy.candidateChecks, fallback.candidateChecks, "goalContract.candidateChecks"),
		integrationChecks: parseChecks(
			policy.integrationChecks,
			fallback.integrationChecks,
			"goalContract.integrationChecks",
		),
		reviewRequiredFor: reviewRequiredFor as string[],
	};
}
