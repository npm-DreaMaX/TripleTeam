import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectPaths {
	root: string;
	database: string;
	worktrees: string;
	sessions: string;
	artifacts: string;
	logs: string;
	daemon: string;
}

export function stateHome(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.TRIPLETEAM_STATE_DIR) return environment.TRIPLETEAM_STATE_DIR;
	if (environment.XDG_STATE_HOME) return join(environment.XDG_STATE_HOME, "tripleteam");
	return join(homedir(), ".local", "state", "tripleteam");
}

export function projectPaths(repositoryRoot: string, environment?: NodeJS.ProcessEnv): ProjectPaths {
	const key = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 24);
	const root = join(stateHome(environment), "projects", key);
	return {
		root,
		database: join(root, "state.db"),
		worktrees: join(root, "worktrees"),
		sessions: join(root, "sessions"),
		artifacts: join(root, "artifacts"),
		logs: join(root, "logs"),
		daemon: join(root, "daemon.json"),
	};
}
