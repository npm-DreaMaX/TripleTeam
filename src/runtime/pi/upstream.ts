import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentScope,
	discoverAgents,
	discoverAgentsWithStarter,
} from "@mjakl/pi-subagent/agents.ts";
import {
	acquireSessionLock,
	releaseSessionLocks,
	type SessionLock,
	type SessionLockTarget,
} from "@mjakl/pi-subagent/session-lock.ts";

export type { AgentConfig, AgentDiscoveryResult, AgentScope };

export function discoverPiAgents(
	cwd: string,
	options: { scope?: AgentScope; includeProjectAgents?: boolean; createStarter?: boolean } = {},
): AgentDiscoveryResult {
	const includeProjectAgents = options.includeProjectAgents ?? false;
	if (options.createStarter) {
		const result = discoverAgentsWithStarter(cwd, includeProjectAgents);
		if (result.error) throw new Error(result.error);
		return result.discovery;
	}
	return discoverAgents(cwd, options.scope ?? "both", includeProjectAgents);
}

export class PersistentSessionGuard {
	readonly lock: SessionLock;
	private released = false;

	private constructor(lock: SessionLock) {
		this.lock = lock;
	}

	static acquire(target: SessionLockTarget, options: { recoverDeadOwner?: boolean } = {}): PersistentSessionGuard {
		let result = acquireSessionLock(target);
		if (!result.lock && options.recoverDeadOwner && removeDeadOwnerLock(target)) {
			result = acquireSessionLock(target);
		}
		if (!result.lock) {
			throw new Error(result.error ?? "Failed to acquire Pi session lock");
		}
		return new PersistentSessionGuard(result.lock);
	}

	release(): void {
		if (this.released) return;
		releaseSessionLocks([this.lock]);
		this.released = true;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function removeDeadOwnerLock(target: SessionLockTarget): boolean {
	const lockPath = join(target.lockRoot, target.sessionId + ".lock");
	const ownerPath = join(lockPath, "owner.json");
	try {
		const first = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
		if (typeof first.pid !== "number" || processExists(first.pid) || typeof first.token !== "string") return false;
		const second = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
		if (second.pid !== first.pid || second.token !== first.token) return false;
		rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
