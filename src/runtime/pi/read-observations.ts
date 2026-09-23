import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { DefaultResourceLoader, getAgentDir, type RpcEventListener } from "@earendil-works/pi-coding-agent";
import type { GitWorkspaceManager } from "../../workspace/git.ts";

export interface ReadObservation {
	path: string;
	identity: string;
}

/** Pi resolves user/ancestor context; repository resources are covered separately by Git observations. */
export async function explorationContextVersion(worktreeParent: string): Promise<string | null> {
	try {
		const resources = new DefaultResourceLoader({
			cwd: worktreeParent,
			agentDir: getAgentDir(),
			noExtensions: true,
			noThemes: true,
		});
		await resources.reload();
		return createHash("sha256")
			.update(
				JSON.stringify({
					context: resources.getAgentsFiles(),
					system: resources.getSystemPrompt(),
					append: resources.getAppendSystemPrompt(),
					skills: resources.getSkills(),
					prompts: resources.getPrompts(),
				}),
			)
			.digest("hex");
	} catch {
		return null;
	}
}

/** Observe public Pi tool events; no tool, session or context implementation is replaced. */
export class ReadObservationCollector {
	private readonly paths = new Set<string>([
		"AGENTS.md",
		"AGENTS.override.md",
		"AGENTS.MD",
		"CLAUDE.md",
		"CLAUDE.MD",
		"GEMINI.md",
		"CONTEXT.md",
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
		".pi",
		".gitignore",
		".ignore",
		".rgignore",
	]);
	private safe = true;
	private seen = false;
	constructor(private readonly cwd: string) {}
	readonly onEvent: RpcEventListener = (event) => {
		if (event.type !== "tool_execution_start") return;
		this.seen = true;
		if (!["read", "grep", "find", "ls"].includes(event.toolName)) {
			this.safe = false;
			return;
		}
		const raw = event.args?.path ?? (event.toolName === "read" ? undefined : ".");
		if (typeof raw !== "string") {
			this.safe = false;
			return;
		}
		const path = relative(this.cwd, resolve(this.cwd, raw)).split(sep).join("/") || ".";
		if (path === ".." || path.startsWith("../") || path.split("/").includes(".git") || this.paths.size >= 128) {
			this.safe = false;
			return;
		}
		this.paths.add(path);
	};
	async freeze(git: GitWorkspaceManager, commit: string): Promise<ReadObservation[] | null> {
		if (!this.safe || !this.seen) return null;
		try {
			for (const path of await git.contextPaths(commit)) this.paths.add(path);
			const result: ReadObservation[] = [];
			for (const path of this.paths) {
				const absolute = resolve(this.cwd, path);
				try {
					if ((await realpath(absolute)) !== absolute) return null;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
				}
				result.push({ path, identity: await git.observationIdentity(commit, path) });
			}
			return result;
		} catch {
			return null;
		}
	}
}

export async function observationsUnchanged(
	git: GitWorkspaceManager,
	commit: string,
	observations: ReadObservation[],
): Promise<boolean> {
	if (!observations.length || observations.length > 256) return false;
	try {
		const recorded = new Set(observations.map((entry) => entry.path));
		if ((await git.contextPaths(commit)).some((path) => !recorded.has(path))) return false;
		for (const entry of observations)
			if ((await git.observationIdentity(commit, entry.path)) !== entry.identity) return false;
		return true;
	} catch {
		return false;
	}
}
