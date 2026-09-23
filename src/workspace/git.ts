import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositorySnapshot {
	commitHash: string;
	treeHash: string;
	ref: string;
	dirty: boolean;
}

export interface ManagedWorktree {
	attemptId: string;
	path: string;
	baseCommit: string;
}

export interface SealedCandidate {
	commitHash: string;
	treeHash: string;
	ref: string;
	changedPaths: string[];
}

export interface IntegrationResult {
	commitHash: string;
	treeHash: string;
}

export class GitCommandError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
	) {
		super(message);
		this.name = "GitCommandError";
	}
}

function assertSafeId(id: string, label: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) {
		throw new Error(label + " contains unsupported characters");
	}
}

function assertContained(root: string, target: string): void {
	const rel = relative(resolve(root), resolve(target));
	if (rel === ".." || rel.startsWith(".." + sep) || resolve(root) === resolve(target)) {
		throw new Error("Managed path escapes its root");
	}
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env: { ...process.env, ...env },
			maxBuffer: 16 * 1024 * 1024,
		});
		return result.stdout.trim();
	} catch (error) {
		const detail = error as { message?: string; stderr?: string };
		throw new GitCommandError(
			"git " + args[0] + " failed in " + basename(cwd) + ": " + (detail.message ?? "unknown error"),
			detail.stderr ?? "",
		);
	}
}

export class GitWorkspaceManager {
	readonly repositoryRoot: string;
	readonly worktreeRoot: string;

	private constructor(repositoryRoot: string, worktreeRoot: string) {
		this.repositoryRoot = repositoryRoot;
		this.worktreeRoot = worktreeRoot;
	}

	static async open(repositoryPath: string, worktreeRoot: string): Promise<GitWorkspaceManager> {
		const topLevel = await resolveRepositoryRoot(repositoryPath);
		const manager = new GitWorkspaceManager(resolve(topLevel), resolve(worktreeRoot));
		if (manager.repositoryRoot === manager.worktreeRoot) {
			throw new Error("Managed worktrees cannot use the repository root");
		}
		await mkdir(manager.worktreeRoot, { recursive: true });
		return manager;
	}

	async initializeIntegrationRef(runId: string, commitHash: string): Promise<string> {
		assertSafeId(runId, "run id");
		await this.run(["cat-file", "-e", commitHash + "^{commit}"]);
		const ref = "refs/tripleteam/runs/" + runId + "/integration";
		await this.run(["update-ref", ref, commitHash, ""]);
		return ref;
	}

	async snapshot(runId: string): Promise<RepositorySnapshot> {
		assertSafeId(runId, "run id");
		const head = await this.run(["rev-parse", "HEAD"]);
		const headTree = await this.run(["rev-parse", "HEAD^{tree}"]);
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "tripleteam-index-"));
		const indexPath = join(temporaryDirectory, "index");
		const env = { GIT_INDEX_FILE: indexPath };
		try {
			await this.run(["read-tree", "HEAD"], env);
			await this.run(["add", "-A"], env);
			const treeHash = await this.run(["write-tree"], env);
			const dirty = treeHash !== headTree;
			const commitHash = dirty ? await this.commitTree(treeHash, head, "tripleteam: input snapshot") : head;
			const ref = "refs/tripleteam/runs/" + runId + "/input";
			await this.run(["update-ref", ref, commitHash]);
			return { commitHash, treeHash, ref, dirty };
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	async createWorktree(attemptId: string, baseCommit: string): Promise<ManagedWorktree> {
		assertSafeId(attemptId, "attempt id");
		await this.run(["cat-file", "-e", baseCommit + "^{commit}"]);
		const path = join(this.worktreeRoot, attemptId);
		assertContained(this.worktreeRoot, path);
		await this.run(["worktree", "add", "--detach", path, baseCommit]);
		const actualHead = await runGit(path, ["rev-parse", "HEAD"]);
		if (actualHead !== baseCommit) {
			await this.removeWorktree({ attemptId, path, baseCommit });
			throw new Error("Created worktree at an unexpected commit");
		}
		return { attemptId, path, baseCommit };
	}

	async recoverWorktree(attemptId: string, baseCommit: string): Promise<ManagedWorktree> {
		assertSafeId(attemptId, "attempt id");
		const path = join(this.worktreeRoot, attemptId);
		assertContained(this.worktreeRoot, path);
		const inside = await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
		if (inside !== "true") throw new Error("Recovered path is not a Git worktree");
		await this.run(["cat-file", "-e", baseCommit + "^{commit}"]);
		return { attemptId, path, baseCommit };
	}

	async restoreCandidate(
		worktree: ManagedWorktree,
		candidateCommit: string,
	): Promise<{ state: "APPLIED" | "CONFLICTED"; conflicts: string[] }> {
		this.assertManagedWorktree(worktree);
		await this.run(["cat-file", "-e", candidateCommit + "^{commit}"]);
		const head = await runGit(worktree.path, ["rev-parse", "HEAD"]);
		const dirty = await runGit(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
		if (head !== worktree.baseCommit || dirty) {
			throw new Error("Candidate recovery requires a fresh worktree at the intended integration baseline");
		}
		try {
			await runGit(worktree.path, ["cherry-pick", "--no-commit", candidateCommit]);
			return { state: "APPLIED", conflicts: [] };
		} catch (error) {
			const conflicts = (await runGit(worktree.path, ["diff", "--name-only", "--diff-filter=U", "-z"]))
				.split("\0")
				.filter(Boolean);
			if (conflicts.length === 0) throw error;
			// Preserve both sides and conflict markers for the fenced resolution writer.
			// Quit only the Git sequencer; sealing still requires resolving the index.
			await runGit(worktree.path, ["cherry-pick", "--quit"]);
			return { state: "CONFLICTED", conflicts };
		}
	}

	async sealCandidate(runId: string, worktree: ManagedWorktree, message: string): Promise<SealedCandidate> {
		assertSafeId(runId, "run id");
		this.assertManagedWorktree(worktree);
		await runGit(worktree.path, ["add", "-A"]);
		const treeHash = await runGit(worktree.path, ["write-tree"]);
		const commitHash = await this.commitTree(treeHash, worktree.baseCommit, message);
		const ref = "refs/tripleteam/runs/" + runId + "/attempts/" + worktree.attemptId;
		await this.run(["update-ref", ref, commitHash]);
		const changed = await this.run(["diff", "--name-only", "-z", worktree.baseCommit, commitHash]);
		return {
			commitHash,
			treeHash,
			ref,
			changedPaths: changed.split("\0").filter(Boolean),
		};
	}

	async integrate(input: {
		runId: string;
		integrationRef: string;
		expectedHead: string;
		candidateCommit: string;
	}): Promise<IntegrationResult> {
		const result = await this.prepareIntegration(input);
		await this.publishIntegration({
			integrationRef: input.integrationRef,
			expectedHead: input.expectedHead,
			resultCommit: result.commitHash,
		});
		return result;
	}

	async prepareIntegration(input: {
		runId: string;
		integrationRef: string;
		expectedHead: string;
		candidateCommit: string;
	}): Promise<IntegrationResult> {
		assertSafeId(input.runId, "run id");
		const integrationDirectory = join(this.worktreeRoot, "integration-" + input.runId + "-" + randomUUID());
		assertContained(this.worktreeRoot, integrationDirectory);
		const current = await this.run(["rev-parse", input.integrationRef]);
		if (current !== input.expectedHead) {
			throw new Error("Integration ref moved before apply");
		}
		await this.run(["worktree", "add", "--detach", integrationDirectory, input.expectedHead]);
		try {
			await runGit(integrationDirectory, ["cherry-pick", input.candidateCommit]);
			const commitHash = await runGit(integrationDirectory, ["rev-parse", "HEAD"]);
			const treeHash = await runGit(integrationDirectory, ["rev-parse", "HEAD^{tree}"]);
			return { commitHash, treeHash };
		} catch (error) {
			try {
				await runGit(integrationDirectory, ["cherry-pick", "--abort"]);
			} catch {
				// The failed operation may not have created cherry-pick state.
			}
			throw error;
		} finally {
			await this.run(["worktree", "remove", "--force", integrationDirectory]);
		}
	}

	async publishIntegration(input: {
		integrationRef: string;
		expectedHead: string;
		resultCommit: string;
	}): Promise<void> {
		await this.run(["cat-file", "-e", input.resultCommit + "^{commit}"]);
		await this.run(["update-ref", input.integrationRef, input.resultCommit, input.expectedHead]);
	}

	async publishDeliveryRef(runId: string, commitHash: string): Promise<string> {
		assertSafeId(runId, "run id");
		await this.run(["cat-file", "-e", commitHash + "^{commit}"]);
		const ref = "refs/heads/tripleteam-deliveries/" + runId;
		let current: string | undefined;
		try {
			current = await this.run(["rev-parse", "--verify", ref]);
		} catch (error) {
			if (!(error instanceof GitCommandError)) throw error;
		}
		if (current === commitHash) return ref;
		if (current !== undefined) throw new Error("Delivery ref already points at a different commit");
		await this.run(["update-ref", ref, commitHash, "0".repeat(commitHash.length)]);
		return ref;
	}

	async resolveRef(ref: string): Promise<string> {
		return this.run(["rev-parse", ref]);
	}

	async artifactIdentity(commit: string, path: string): Promise<string> {
		return (await this.artifactEntry(commit, path)).blobHash;
	}

	async artifactEntry(commit: string, path: string): Promise<{ blobHash: string; mode: string }> {
		const { normalizeRepositoryPath } = await import("../control/scope.ts");
		const normalized = normalizeRepositoryPath(path);
		if (!normalized) throw new Error("Contract artifact must be a file");
		const row = await this.run(["--literal-pathspecs", "ls-tree", commit, "--", normalized]);
		const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(row);
		if (!match?.[2]) throw new Error(`Contract artifact is missing or not a regular Git blob: ${path}`);
		return { blobHash: match[2], mode: match[1] as string };
	}

	/** A Git-backed read dependency, including absence and directory listings. */
	async observationIdentity(commit: string, path: string): Promise<string> {
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Observation requires an immutable commit");
		if (path === ".") return "tree:" + (await this.treeHash(commit));
		if (
			!path ||
			/[\0\r\n\\:*?[\]]/.test(path) ||
			path.startsWith("/") ||
			path.split("/").some((p) => [".", "..", ".git"].includes(p))
		)
			throw new Error("Observation requires a literal repository-relative path");
		return (await runGit(this.repositoryRoot, ["ls-tree", "-z", commit, "--", path])).trim() || "ABSENT";
	}

	async contextPaths(commit: string): Promise<string[]> {
		return (await runGit(this.repositoryRoot, ["ls-tree", "-rz", "--name-only", commit]))
			.split("\0")
			.filter((path) =>
				/(?:^|\/)(?:(?:AGENTS(?:\.override)?|CLAUDE|GEMINI|CONTEXT|SYSTEM|APPEND_SYSTEM)\.md|\.gitignore|\.ignore|\.rgignore)$/i.test(
					path,
				),
			);
	}

	async treeHash(commitHash: string): Promise<string> {
		return this.run(["rev-parse", commitHash + "^{tree}"]);
	}

	async diff(baseCommit: string, subjectCommit: string): Promise<string> {
		return this.run(["diff", "--no-ext-diff", "--unified=40", baseCommit, subjectCommit]);
	}

	async removeWorktree(worktree: ManagedWorktree): Promise<void> {
		this.assertManagedWorktree(worktree);
		await this.run(["worktree", "remove", "--force", worktree.path]);
	}

	async prune(): Promise<void> {
		await this.run(["worktree", "prune"]);
	}

	private assertManagedWorktree(worktree: ManagedWorktree): void {
		assertSafeId(worktree.attemptId, "attempt id");
		const expected = join(this.worktreeRoot, worktree.attemptId);
		if (resolve(worktree.path) !== resolve(expected)) {
			throw new Error("Worktree path does not match its attempt identity");
		}
		assertContained(this.worktreeRoot, worktree.path);
	}

	private async commitTree(treeHash: string, parent: string, message: string): Promise<string> {
		return this.run(["commit-tree", treeHash, "-p", parent, "-m", message], {
			GIT_AUTHOR_NAME: "Agent Orchestrator",
			GIT_AUTHOR_EMAIL: "tripleteam@localhost",
			GIT_COMMITTER_NAME: "Agent Orchestrator",
			GIT_COMMITTER_EMAIL: "tripleteam@localhost",
		});
	}

	private run(args: string[], env?: Record<string, string>): Promise<string> {
		return runGit(this.repositoryRoot, args, env);
	}
}

export async function resolveRepositoryRoot(repositoryPath: string): Promise<string> {
	return resolve(await runGit(repositoryPath, ["rev-parse", "--show-toplevel"]));
}
