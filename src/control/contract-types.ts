import { normalizeRepositoryPath } from "./scope.ts";

export interface ContractObligation {
	key: string;
	artifactPaths: string[];
	checkNames: string[];
}

export function parseObligations(value: unknown): ContractObligation[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Contract obligations must be an array");
	const keys = new Set<string>();
	return value.map((item) => {
		if (!item || typeof item !== "object" || typeof item.key !== "string" || !item.key.trim() || keys.has(item.key))
			throw new Error("Contract obligation keys must be unique nonempty strings");
		keys.add(item.key);
		for (const field of ["artifactPaths", "checkNames"])
			if (
				!Array.isArray(item[field]) ||
				item[field].length === 0 ||
				!item[field].every((v: unknown) => typeof v === "string" && v.trim())
			)
				throw new Error(`Obligation ${item.key} requires ${field}`);
		const artifactPaths = (item.artifactPaths as string[]).map((path) => {
			const normalized = normalizeRepositoryPath(path);
			if (!normalized || normalized.startsWith(".git/") || normalized === ".git")
				throw new Error("An obligation must name a repository artifact file");
			return normalized;
		});
		return { key: item.key, artifactPaths, checkNames: [...new Set(item.checkNames as string[])] };
	});
}
