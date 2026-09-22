import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type FSWatcher, watch } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CheckCommand } from "../config/project.ts";

const execFileAsync = promisify(execFile);

export class CheckIntegrityError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CheckIntegrityError";
	}
}

interface TreeEntry {
	mode: string;
	object: string;
	path: string;
}

export interface CheckIntegrity {
	subjectCommit: string;
	subjectTree: string;
	oracleVersion?: string;
	isolation: "LOCAL_MONITORED" | "DOCKER_READ_ONLY";
	watcherActive: boolean;
	violations: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const result = await execFileAsync(
		"git",
		["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
		},
	);
	return result.stdout;
}

async function treeEntries(cwd: string, commit: string): Promise<TreeEntry[]> {
	const output = await git(cwd, ["ls-tree", "-rz", "--full-tree", commit]);
	return output
		.split("\0")
		.filter(Boolean)
		.map((entry) => {
			const tab = entry.indexOf("\t");
			const [mode, _kind, object] = entry.slice(0, tab).split(" ");
			const path = entry.slice(tab + 1);
			if (!mode || !object || tab < 0 || !path || path.startsWith("/") || path.split("/").includes("..")) {
				throw new CheckIntegrityError("INVALID_GIT_TREE", "Git tree contains an unsupported entry");
			}
			return { mode, object, path };
		});
}

function containsPath(scope: string, path: string): boolean {
	const normalized = scope.replace(/\/+$/, "");
	return normalized === "." || path === normalized || path.startsWith(normalized + "/");
}

async function oracleVersion(
	cwd: string,
	baseline: string,
	entries: TreeEntry[],
	specification: CheckCommand,
): Promise<string | undefined> {
	if (!specification.oracle) return undefined;
	const original = await treeEntries(cwd, baseline);
	const paths = specification.oracle.protectedPaths;
	for (const path of paths) {
		if (!original.some((entry) => containsPath(path, entry.path))) {
			throw new CheckIntegrityError("ORACLE_MISSING", "Protected oracle path is absent from the run input: " + path);
		}
	}
	const select = (input: TreeEntry[]) => input.filter((entry) => paths.some((path) => containsPath(path, entry.path)));
	const protectedEntries = select(original);
	if (JSON.stringify(protectedEntries) !== JSON.stringify(select(entries))) {
		throw new CheckIntegrityError("ORACLE_CHANGED", "Protected oracle files differ from the frozen run input");
	}
	// npm executes scripts from package.json. Freezing argv alone does not freeze this oracle launcher.
	const packageScripts: Array<{ path: string; scripts: unknown }> = [];
	for (const entry of original.filter(
		(value) => value.path === "package.json" || value.path.endsWith("/package.json"),
	)) {
		const current = entries.find((value) => value.path === entry.path);
		const parseScripts = async (object: string): Promise<unknown> => {
			const manifest = JSON.parse(await git(cwd, ["cat-file", "blob", object])) as { scripts?: unknown };
			const scripts = manifest.scripts;
			return scripts && typeof scripts === "object" && !Array.isArray(scripts)
				? Object.fromEntries(Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right)))
				: (scripts ?? {});
		};
		const scripts = await parseScripts(entry.object);
		if (
			!current ||
			current.mode === "120000" ||
			JSON.stringify(scripts) !== JSON.stringify(await parseScripts(current.object))
		) {
			throw new CheckIntegrityError(
				"ORACLE_LAUNCHER_CHANGED",
				"Package scripts differ from the frozen run input: " + entry.path,
			);
		}
		packageScripts.push({ path: entry.path, scripts });
	}
	return createHash("sha256").update(JSON.stringify({ paths, protectedEntries, packageScripts })).digest("hex");
}

async function fileFingerprint(cwd: string, entry: TreeEntry, algorithm: string): Promise<string> {
	const path = join(cwd, entry.path);
	const information = await lstat(path, { bigint: true });
	const metadata = [
		information.dev,
		information.ino,
		information.mode,
		information.size,
		information.mtimeNs,
		information.ctimeNs,
	]
		.map(String)
		.join(":");
	const hash = createHash(algorithm);
	if (entry.mode === "120000") {
		if (!information.isSymbolicLink())
			throw new CheckIntegrityError("TREE_MISMATCH", "Expected a symbolic link: " + entry.path);
		const content = await readlink(path, { encoding: "buffer" });
		hash.update(`blob ${content.length}\0`).update(content);
	} else if (entry.mode === "100644" || entry.mode === "100755") {
		if (!information.isFile()) throw new CheckIntegrityError("TREE_MISMATCH", "Expected a regular file: " + entry.path);
		if (process.platform !== "win32" && Boolean(information.mode & 0o111n) !== (entry.mode === "100755")) {
			throw new CheckIntegrityError("TREE_MISMATCH", "File executable mode differs from the Git tree: " + entry.path);
		}
		hash.update(`blob ${information.size}\0`);
		for await (const chunk of createReadStream(path)) hash.update(chunk);
	} else {
		throw new CheckIntegrityError(
			"UNSUPPORTED_TREE_ENTRY",
			"Verification requires materialized tracked files; unsupported entry: " + entry.path,
		);
	}
	if (hash.digest("hex") !== entry.object) {
		throw new CheckIntegrityError("TREE_MISMATCH", "Working file differs from the exact Git tree: " + entry.path);
	}
	return metadata;
}

export class CheckSourceGuard {
	readonly integrity: CheckIntegrity;
	private readonly fingerprints = new Map<string, string>();
	private readonly observed = new Set<string>();
	private watcher?: FSWatcher;

	private constructor(
		private readonly cwd: string,
		private readonly entries: TreeEntry[],
		private readonly algorithm: string,
		integrity: CheckIntegrity,
	) {
		this.integrity = integrity;
	}

	static async open(
		cwd: string,
		subject: string,
		baseline: string,
		specification: CheckCommand,
	): Promise<CheckSourceGuard> {
		if (!/^[a-f0-9]{40,64}$/.test(subject) || !/^[a-f0-9]{40,64}$/.test(baseline)) {
			throw new CheckIntegrityError("INVALID_SUBJECT", "Verification requires immutable commit hashes");
		}
		const subjectCommit = (await git(cwd, ["rev-parse", "--verify", subject + "^{commit}"])).trim();
		if ((await git(cwd, ["rev-parse", "HEAD"])).trim() !== subjectCommit) {
			throw new CheckIntegrityError("HEAD_MISMATCH", "Verification workspace HEAD differs from the subject commit");
		}
		const subjectTree = (await git(cwd, ["rev-parse", subjectCommit + "^{tree}"])).trim();
		const entries = await treeEntries(cwd, subjectCommit);
		const algorithm = (await git(cwd, ["rev-parse", "--show-object-format"])).trim();
		const guard = new CheckSourceGuard(cwd, entries, algorithm, {
			subjectCommit,
			subjectTree,
			oracleVersion: await oracleVersion(cwd, baseline, entries, specification),
			isolation: specification.isolation ? "DOCKER_READ_ONLY" : "LOCAL_MONITORED",
			watcherActive: false,
			violations: [],
		});
		try {
			const tracked = new Set(entries.map((entry) => entry.path));
			guard.watcher = watch(cwd, { recursive: true }, (_event, filename) => {
				const path = filename?.toString().split(sep).join("/");
				if (!path || path === ".git" || path.startsWith(".git/")) return;
				if (tracked.has(path) || entries.some((entry) => entry.path.startsWith(path + "/"))) guard.observed.add(path);
			});
			guard.watcher.on("error", (error) => guard.observed.add("watcher failure: " + error.message));
			guard.integrity.watcherActive = true;
		} catch {
			// File bytes and inode/ctime are still checked; local execution never yields behavioral authority.
		}
		try {
			await guard.assertClean();
			for (const entry of entries) guard.fingerprints.set(entry.path, await fileFingerprint(cwd, entry, algorithm));
			return guard;
		} catch (error) {
			guard.close();
			throw error;
		}
	}

	private async assertClean(): Promise<void> {
		const directories = new Set(this.entries.map((entry) => dirname(entry.path)));
		for (const directory of directories) {
			let current = directory;
			while (current !== ".") {
				if (!(await lstat(join(this.cwd, current))).isDirectory()) {
					throw new CheckIntegrityError("TREE_MISMATCH", "Tracked directory was replaced: " + current);
				}
				current = dirname(current);
			}
		}
		const untracked = await git(this.cwd, [
			"ls-files",
			"--others",
			...(this.integrity.isolation === "LOCAL_MONITORED" ? ["--exclude-standard"] : []),
			"-z",
		]);
		if (untracked)
			throw new CheckIntegrityError(
				"UNTRACKED_SOURCE",
				"Verification workspace contains untracked files: " +
					untracked.split("\0").filter(Boolean).slice(0, 5).join(", "),
			);
		if (
			(await git(this.cwd, ["rev-parse", "HEAD"])).trim() !== this.integrity.subjectCommit ||
			(await git(this.cwd, ["write-tree"])).trim() !== this.integrity.subjectTree
		) {
			throw new CheckIntegrityError("TREE_MISMATCH", "Verification HEAD or index no longer matches the subject tree");
		}
	}

	async finish(): Promise<CheckIntegrity> {
		try {
			await this.assertClean();
			for (const entry of this.entries) {
				const fingerprint = await fileFingerprint(this.cwd, entry, this.algorithm);
				if (fingerprint !== this.fingerprints.get(entry.path)) this.observed.add(entry.path);
			}
			// Flush queued filesystem notifications before closing the watcher.
			await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
			if (this.observed.size > 0)
				throw new CheckIntegrityError(
					"SOURCE_MUTATED",
					"Check modified its source view, including restored changes: " + [...this.observed].slice(0, 10).join(", "),
				);
		} catch (error) {
			this.integrity.violations.push(error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			this.close();
		}
		return this.integrity;
	}

	close(): void {
		this.watcher?.close();
	}
}

export async function checkGitMount(cwd: string): Promise<string> {
	const common = resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim());
	const rel = relative(cwd, common);
	return rel.startsWith(".." + sep) || rel === ".." ? common : "";
}

export async function checkRepositoryKey(cwd: string): Promise<string> {
	const common = await realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()));
	return createHash("sha256")
		.update(JSON.stringify({ host: hostname(), gitDirectory: common }))
		.digest("hex");
}
