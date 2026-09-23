import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const guidance = "Search from the current worktree using a relative path such as '.' or 'src'.";

function block(reason: string): ToolCallEventResult {
	return { block: true, reason: `${reason} ${guidance}` };
}

function searchPath(input: unknown): string | undefined {
	if (input === undefined || input === "") return ".";
	if (typeof input !== "string" || input.includes("\0")) return undefined;
	// Pi 0.86.1 uses these normalizations for grep/find, but its path helpers are not public exports.
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	// Keep this adapter limited to native filesystem paths; do not interpret URL or Windows shell aliases.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
	if (process.platform === "win32" && !path.includes("\\") && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(path))
		return undefined;
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
		return join(homedir(), path.slice(2));
	return path;
}

/** A search-scope check through Pi's public hook, not an OS sandbox or a replacement search tool. */
export function registerWorkspaceSearchPolicy(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "grep" && event.toolName !== "find") return;
		const path = searchPath(event.input.path);
		if (path === undefined) return block("This search path form is unsupported; use an ordinary filesystem path.");
		try {
			const [root, target] = await Promise.all([realpath(ctx.cwd), realpath(resolve(ctx.cwd, path))]);
			const fromRoot = relative(root, target);
			if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
				return block("The search path resolves outside the current worktree.");
		} catch {
			return block("The search path could not be resolved to an existing location inside the current worktree.");
		}
		// Leave arguments and execution with Pi, including its normal search and error handling.
		return undefined;
	});
}
