import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const BENCHMARK_REVISIONS = {
	featurebench: "8d4e347ec57546685c5a87e8676bf575db022ea6",
	"swe-milestone": "17a8f1593e172e26b36cea15e2b30fb9536c93f5",
} as const;

export interface BenchmarkManifest {
	schema: "tripleteam-benchmark/v1";
	benchmark: keyof typeof BENCHMARK_REVISIONS;
	evaluatorCommit: string;
	datasetRevision: string;
	datasetDigest: string;
	split: string;
	instanceIds: string[];
	systemCommit: string;
	model: string;
	provider: string;
	replicate: string;
	executionConfigHash: string;
	budget: { costUsd: number; tokens: number; deadlineMs: number; maxExecutions: number };
	protocol: {
		humanMode: "DISABLED";
		hiddenFeedback: "FORBIDDEN";
		submissionSelection: "FINAL";
		networkPolicy: string;
		containerImages: Record<string, string>;
		earlyUnblock?: boolean;
	};
	accounting: { priceSnapshot: string; costScope: "MODEL_API_ONLY"; missingUsage: "UNKNOWN" };
}

export interface FrozenBenchmarkManifest {
	manifest: BenchmarkManifest;
	sha256: string;
}

/** Stable serialization is shared by manifest and exact policy identity checks. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return (
			"{" +
			Object.keys(record)
				.sort()
				.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
				.join(",") +
			"}"
		);
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Manifest cannot contain undefined values");
	return encoded;
}

export function hashJson(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function nonempty(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

export function validateManifest(value: unknown): BenchmarkManifest {
	if (!value || typeof value !== "object") throw new Error("Invalid benchmark manifest");
	const manifest = value as BenchmarkManifest;
	if (manifest.schema !== "tripleteam-benchmark/v1") throw new Error("Unsupported benchmark manifest schema");
	if (!Object.hasOwn(BENCHMARK_REVISIONS, manifest.benchmark)) throw new Error("Unsupported benchmark");
	if (manifest.evaluatorCommit !== BENCHMARK_REVISIONS[manifest.benchmark]) {
		throw new Error("Evaluator commit does not match the adapter's contract-tested revision");
	}
	for (const key of ["datasetRevision", "systemCommit"] as const) {
		if (!/^[a-f0-9]{40}$/.test(manifest[key])) throw new Error(`${key} must be an immutable Git revision`);
	}
	for (const key of ["datasetDigest", "executionConfigHash"] as const) {
		if (!/^[a-f0-9]{64}$/.test(manifest[key])) throw new Error(`${key} must be a SHA-256 digest`);
	}
	for (const key of ["split", "model", "provider", "replicate"] as const) nonempty(manifest[key], key);
	if (
		!Array.isArray(manifest.instanceIds) ||
		manifest.instanceIds.length === 0 ||
		manifest.instanceIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._-]+$/.test(id)) ||
		new Set(manifest.instanceIds).size !== manifest.instanceIds.length
	) {
		throw new Error("instanceIds must contain unique, non-empty benchmark identifiers");
	}
	for (const key of ["costUsd", "tokens", "deadlineMs", "maxExecutions"] as const) {
		if (!Number.isFinite(manifest.budget?.[key]) || manifest.budget[key] <= 0) {
			throw new Error(`budget.${key} must be positive and finite`);
		}
		if (key !== "costUsd" && !Number.isSafeInteger(manifest.budget[key])) {
			throw new Error(`budget.${key} must be an integer`);
		}
	}
	if (
		manifest.protocol?.humanMode !== "DISABLED" ||
		manifest.protocol.hiddenFeedback !== "FORBIDDEN" ||
		manifest.protocol.submissionSelection !== "FINAL"
	) {
		throw new Error("Autonomous evaluation requires no human/hidden feedback and one final submission");
	}
	nonempty(manifest.protocol.networkPolicy, "protocol.networkPolicy");
	if (!manifest.protocol.containerImages || typeof manifest.protocol.containerImages !== "object") {
		throw new Error("protocol.containerImages is required");
	}
	for (const image of Object.values(manifest.protocol.containerImages)) {
		if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Container images must use content digests");
	}
	if (Object.keys(manifest.protocol.containerImages).length === 0) throw new Error("At least one image is required");
	if (manifest.benchmark === "swe-milestone" && typeof manifest.protocol.earlyUnblock !== "boolean") {
		throw new Error("SWE-Milestone must freeze the official earlyUnblock setting");
	}
	if (manifest.accounting?.costScope !== "MODEL_API_ONLY" || manifest.accounting.missingUsage !== "UNKNOWN") {
		throw new Error("Cost scope and missing usage policy must be explicit");
	}
	nonempty(manifest.accounting.priceSnapshot, "accounting.priceSnapshot");
	return manifest;
}

export function freezeManifest(value: unknown): FrozenBenchmarkManifest {
	const manifest = validateManifest(value);
	return { manifest, sha256: hashJson(manifest) };
}

export async function readFrozenManifest(path: string): Promise<FrozenBenchmarkManifest> {
	const value = JSON.parse(await readFile(path, "utf8")) as FrozenBenchmarkManifest;
	const frozen = freezeManifest(value.manifest);
	if (value.sha256 !== frozen.sha256) throw new Error("Frozen benchmark manifest was modified");
	return frozen;
}

export async function writeImmutableJson(path: string, value: unknown): Promise<void> {
	const encoded = canonicalJson(value) + "\n";
	await mkdir(dirname(path), { recursive: true });
	const temporary = path + ".pending-" + randomUUID();
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(encoded);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			// An atomic no-replace publication avoids both partial JSON and concurrent overwrite.
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if ((await readFile(path, "utf8")) !== encoded) throw new Error(`Immutable benchmark output differs: ${path}`);
		}
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
