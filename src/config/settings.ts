import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersistentSessionGuard } from "../runtime/pi/upstream.ts";
import { resolveRepositoryRoot } from "../workspace/git.ts";
import { AGENT_ROLES } from "./execution.ts";
import { projectPaths } from "./paths.ts";
import { type ProjectConfig, resolveProjectConfig } from "./project.ts";

export interface SettingDefinition {
	key: string;
	label: string;
	description: string;
	type: "string" | "number" | "boolean" | "json";
	choices?: string[];
}
export interface SettingGroup {
	id: string;
	title: string;
	settings: SettingDefinition[];
}
export interface SettingsSnapshot {
	file: string;
	values: ProjectConfig;
	explicit: string[];
	groups: SettingGroup[];
	appliesTo: "new-runs";
}

const choices: Record<string, string[]> = {
	"execution.policy": ["ADAPTIVE", "SINGLE", "HEURISTIC", "FIXED"],
	"execution.decisionMode": ["interactive", "noninteractive"],
	"execution.reasoning": ["off", "minimal", "low", "medium", "high", "xhigh"],
	"assurance.mode": ["adaptive", "required", "off"],
};
const hints: Record<string, string> = {
	"execution.provider": "Provider ID from your Pi model registry; credentials stay in environment variables.",
	"execution.model": "Default model ID; individual roles can override it.",
	"execution.reasoning": "Reasoning level supported by the selected model.",
	"execution.policy": "How TripleTeam chooses single, parallel or investigative work.",
	"execution.maxParallelism": "Maximum simultaneous writer tasks, subject to dependency and resource checks.",
	"execution.costLimitUsd": "Shared model cost limit in USD, based on configured model prices.",
	"execution.tokenLimit": "Shared token allowance, including cache token observations.",
	"execution.deadlineMs": "Whole-run time limit in milliseconds.",
	"execution.decisionMode": "Whether human answers and steering are allowed for the new run.",
	"execution.enableContracts": "Require artifact-backed coordination contracts.",
	"execution.enableFailureAdaptation": "Let failure evidence change the next execution strategy.",
	"execution.enableComputeAllocation":
		"Allocate optional verification work using the remaining delivery budget; required gates stay frozen.",
	"execution.enableEvidenceReuse":
		"Reuse repository observations only when the question, profile, context and read dependencies still match.",
	"assurance.mode": "Independent verification design before implementation.",
	"assurance.isolation": "Optional DOCKER configuration with an installed immutable image digest.",
	candidateChecks: "JSON array of commands to check each immutable candidate.",
	integrationChecks: "JSON array of commands to check a proposed integration tree.",
	runChecks: "JSON array of commands required on the final delivery tree.",
	reviewRequiredFor: "Risk levels that require review: LOW, NORMAL, HIGH.",
	workerTimeoutMs: "Maximum duration of one Pi execution, in milliseconds.",
	"baseline.enabled": "Check the frozen integration gates on the input tree before buying model compute.",
	"baseline.timeoutMs": "Time allowance for baseline environment and regression diagnosis.",
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, path: string): unknown {
	let result = value;
	for (const key of path.split(".")) result = record(result) ? result[key] : undefined;
	return result;
}

function definitions(config: ProjectConfig): SettingGroup[] {
	const define = (key: string, value: unknown, forceType?: SettingDefinition["type"]): SettingDefinition => ({
		key,
		label: (key.split(".").at(-1) ?? key).replace(/([a-z])([A-Z])/g, "$1 $2"),
		description: hints[key] ?? (key.endsWith("Ms") ? "Duration in milliseconds." : "Applies to new runs."),
		type:
			forceType ??
			(["string", "number", "boolean"].includes(typeof value)
				? (typeof value as "string" | "number" | "boolean")
				: ["provider", "model", "reasoning"].includes(key.split(".").at(-1) ?? "")
					? "string"
					: key.endsWith("isolation") || Array.isArray(value)
						? "json"
						: "number"),
		choices: choices[key],
	});
	const entries = (prefix: string, value: object | undefined) =>
		Object.entries(value ?? {})
			.filter(([key]) => key !== "roles")
			.map(([key, entry]) => define(`${prefix}.${key}`, entry));
	return [
		{ id: "execution", title: "Models, coordination and budget", settings: entries("execution", config.execution) },
		{
			id: "roles",
			title: "Model overrides by role",
			settings: AGENT_ROLES.flatMap((role) =>
				["provider", "model", "reasoning"].map((key) => ({
					...define(`execution.roles.${role}.${key}`, undefined, "string"),
					label: `${role} ${key}`,
					description: `Override ${key} for ${role}. Unset fields inherit the global selection.`,
					choices: key === "reasoning" ? choices["execution.reasoning"] : undefined,
				})),
			),
		},
		{ id: "assurance", title: "Independent verification", settings: entries("assurance", config.assurance) },
		{ id: "baseline", title: "Repository baseline", settings: entries("baseline", config.baseline) },
		{
			id: "checks",
			title: "Checks and review",
			settings: ["candidateChecks", "integrationChecks", "runChecks", "reviewRequiredFor"].map((key) =>
				define(key, at(config, key), "json"),
			),
		},
		{ id: "profiles", title: "Agent profiles", settings: entries("profiles", config.profiles) },
		{
			id: "recovery",
			title: "Execution and recovery limits",
			settings: Object.entries(config)
				.filter(
					([key]) =>
						!["execution", "assurance", "profiles", "baseline"].includes(key) && !Array.isArray(at(config, key)),
				)
				.map(([key, value]) => define(key, value)),
		},
	];
}

async function rawConfig(file: string): Promise<Record<string, unknown>> {
	try {
		if (!(await lstat(file)).isFile()) throw new Error("Settings require a regular .tripleteam.json file");
		const raw: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!record(raw)) throw new Error(".tripleteam.json must contain an object");
		return raw;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function snapshot(file: string, raw: Record<string, unknown>, values: ProjectConfig): SettingsSnapshot {
	const groups = definitions(values);
	return {
		file,
		values,
		groups,
		explicit: groups.flatMap((g) => g.settings.filter((d) => at(raw, d.key) !== undefined).map((d) => d.key)),
		appliesTo: "new-runs",
	};
}

export async function loadSettings(repository: string): Promise<SettingsSnapshot> {
	const root = await resolveRepositoryRoot(repository);
	const file = join(root, ".tripleteam.json");
	const raw = await rawConfig(file);
	return snapshot(file, raw, await resolveProjectConfig(root, raw));
}

/** Values are never interpreted as shell text or JavaScript. */
export function parseSettingValue(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function validateValue(key: string, value: unknown, known: Map<string, SettingDefinition>): void {
	if (key.split(".").some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part)))
		throw new Error("Invalid setting path");
	const definition = known.get(key);
	if (definition) {
		if (value === null || value === undefined) throw new Error(`Use reset to clear ${key}`);
		if (definition.type !== "json" && typeof value !== definition.type)
			throw new Error(`${key} requires ${definition.type}`);
		if (definition.choices && !definition.choices.includes(String(value)))
			throw new Error(`${key} must be one of ${definition.choices.join(", ")}`);
		if (definition.type === "json") {
			const fields = (entry: unknown, allowed: string[], label: string): void => {
				if (!record(entry)) throw new Error(`${label} requires an object`);
				for (const name of Object.keys(entry))
					if (!allowed.includes(name)) throw new Error(`Unsupported setting field: ${label}.${name}`);
			};
			const isolation = (entry: unknown, label: string) => fields(entry, ["kind", "image", "memoryMb", "cpus"], label);
			if (key === "assurance.isolation") isolation(value, key);
			else if (key !== "reviewRequiredFor") {
				if (!Array.isArray(value)) throw new Error(`${key} requires a JSON array`);
				for (const [index, check] of value.entries()) {
					const label = `${key}[${index}]`;
					fields(
						check,
						[
							"name",
							"argv",
							"timeoutMs",
							"lane",
							"evidenceClass",
							"oracle",
							"isolation",
							"scope",
							"atomic",
							"preparation",
						],
						label,
					);
					const entry = check as Record<string, unknown>;
					if (entry.oracle !== undefined) fields(entry.oracle, ["protectedPaths"], label + ".oracle");
					if (entry.isolation !== undefined) isolation(entry.isolation, label + ".isolation");
					if (entry.preparation !== undefined)
						fields(entry.preparation, ["commands", "timeoutMs"], label + ".preparation");
				}
			}
		}
		return;
	}
	if (![...known.keys()].some((name) => name.startsWith(key + ".")) || !record(value))
		throw new Error(`Unknown setting: ${key}. Use settings to list supported fields.`);
	for (const [child, entry] of Object.entries(value)) validateValue(`${key}.${child}`, entry, known);
}

function assertJsonValue(value: unknown): void {
	if (value === null || value === undefined)
		throw new Error("Use reset to clear a setting; null is not a setting value");
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Settings numbers must be finite");
	if (Array.isArray(value)) value.forEach(assertJsonValue);
	else if (record(value)) {
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			throw new Error("Settings require plain JSON objects");
		for (const [key, child] of Object.entries(value)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid setting field");
			assertJsonValue(child);
		}
	} else if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Settings require JSON values");
}

async function change(repository: string, key: string, value: unknown, reset: boolean): Promise<SettingsSnapshot> {
	const root = await resolveRepositoryRoot(repository);
	const file = join(root, ".tripleteam.json");
	const guard = PersistentSessionGuard.acquire(
		{ sessionId: "project-settings", lockRoot: join(projectPaths(root).root, "locks"), agent: "settings", cwd: root },
		{ recoverDeadOwner: true },
	);
	const temporary = file + "." + randomUUID() + ".tmp";
	try {
		let mode = 0o600;
		try {
			const stat = await lstat(file);
			if (!stat.isFile()) throw new Error("Settings writes require a regular .tripleteam.json file");
			mode = stat.mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const raw = await rawConfig(file);
		const defaults = await resolveProjectConfig(root, {});
		const known = new Map(definitions(defaults).flatMap((g) => g.settings.map((d) => [d.key, d] as const)));
		if (reset) {
			if (!known.has(key) && ![...known.keys()].some((name) => name.startsWith(key + ".")))
				throw new Error(`Unknown setting: ${key}`);
		} else {
			assertJsonValue(value);
			validateValue(key, value, known);
		}
		const parts = key.split(".");
		let target = raw;
		for (const part of parts.slice(0, -1)) {
			if (!record(target[part])) target[part] = {};
			target = target[part] as Record<string, unknown>;
		}
		const leaf = parts.at(-1) as string;
		if (reset) delete target[leaf];
		else target[leaf] = value;
		const values = await resolveProjectConfig(root, raw);
		if (values.reviewRequiredFor.some((risk) => !["LOW", "NORMAL", "HIGH"].includes(risk)))
			throw new Error("reviewRequiredFor must use LOW, NORMAL or HIGH");
		await writeFile(temporary, JSON.stringify(raw, null, 2) + "\n", { mode, flag: "wx" });
		await rename(temporary, file);
		return snapshot(file, raw, values);
	} finally {
		try {
			await rm(temporary, { force: true });
		} finally {
			guard.release();
		}
	}
}

export const updateSetting = (repository: string, key: string, value: unknown): Promise<SettingsSnapshot> =>
	change(repository, key, value, false);
export const resetSetting = (repository: string, key: string): Promise<SettingsSnapshot> =>
	change(repository, key, undefined, true);
