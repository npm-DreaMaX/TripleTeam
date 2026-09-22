function invalid(label: string, detail: string): Error {
	return new Error(`${label} ${detail}`);
}

export function normalizeRepositoryPath(value: string, label = "repository path"): string {
	const path = value.trim();
	if (!path) throw invalid(label, "cannot be empty");
	if (path.includes("\0")) throw invalid(label, "cannot contain NUL");
	if (path.includes("\\")) throw invalid(label, "must use forward slashes");
	if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
		throw invalid(label, "must be repository-relative");
	}
	const withoutPrefix = path.startsWith("./") ? path.slice(2) : path;
	const withoutSuffix = withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
	if (withoutSuffix === ".") return "";
	const segments = withoutSuffix.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw invalid(label, "must be a canonical path prefix without empty, dot, or parent segments");
	}
	return segments.join("/");
}

export function normalizeTaskScope(value: unknown, label = "task scope"): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw invalid(label, "must be a string array");
	}
	const normalized = [...new Set(value.map((entry, index) => normalizeRepositoryPath(entry, `${label}[${index}]`)))];
	return normalized.includes("") ? [] : normalized;
}

function contains(scope: string, path: string): boolean {
	return path === scope || path.startsWith(scope + "/");
}

export function scopesOverlap(left: unknown, right: unknown): boolean {
	const leftPaths = normalizeTaskScope(left, "left task scope");
	const rightPaths = normalizeTaskScope(right, "right task scope");
	if (leftPaths.length === 0 || rightPaths.length === 0) return true;
	return leftPaths.some((leftPath) =>
		rightPaths.some((rightPath) => contains(leftPath, rightPath) || contains(rightPath, leftPath)),
	);
}

export function candidateScopeViolations(changedPaths: string[], scope: unknown): string[] {
	const allowed = normalizeTaskScope(scope);
	if (allowed.length === 0) return [];
	return changedPaths.filter((path, index) => {
		const normalized = normalizeRepositoryPath(path, `changed path[${index}]`);
		return !allowed.some((prefix) => contains(prefix, normalized));
	});
}

export function scopeContains(parent: unknown, child: unknown): boolean {
	const outer = normalizeTaskScope(parent);
	const inner = normalizeTaskScope(child);
	return (
		outer.length === 0 || (inner.length > 0 && inner.every((path) => outer.some((prefix) => contains(prefix, path))))
	);
}
