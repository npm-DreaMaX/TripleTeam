import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getAgentDir,
	ProjectTrustStore,
	type RpcEventListener,
	type RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { type AgentRole, type ExecutionPolicy, modelSelectionFor } from "../../config/execution.ts";
import { DomainInvariantError } from "../../domain/model.ts";
import { CONTROL_TOOL_NAMES, controlExtensionPath, type PiControlEndpoint } from "./control-bridge.ts";
import { PiRpcWorker, type PiRunResult, type PiUsage, type PiWorkerConfig } from "./rpc-worker.ts";
import { checkPiSearchTools } from "./tool-preflight.ts";
import { discoverPiAgents, PersistentSessionGuard } from "./upstream.ts";

export interface PiWorkerRequest {
	cwd: string;
	sessionDirectory: string;
	sessionId: string;
	sessionName: string;
	profileName: string;
	defaultTools: string[];
	control?: PiControlEndpoint;
}

export interface ManagedPiWorker {
	worker: PiWorkerController;
	profileVersion: string;
	close(): Promise<void>;
}

export interface PiWorkerController {
	onEvent?(listener: RpcEventListener): () => void;
	onUsage?(listener: (usage: PiUsage) => void): () => void;
	usageSnapshot?(): PiUsage;
	start(): Promise<RpcSessionState>;
	run(prompt: string, timeoutMs?: number): Promise<PiRunResult>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	state(): Promise<RpcSessionState>;
	stop(): Promise<void>;
}

export interface ResolvedPiProfile {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	provider?: string;
	reasoning?: ExecutionPolicy["reasoning"];
	version: string;
	source: "builtin" | "user" | "project";
}

export interface PiProfileSummary {
	name: string;
	description: string;
	tools: string[];
	source: ResolvedPiProfile["source"];
}

export type PiProfileRole = "PLAN" | "EXPLORE" | "IMPLEMENT" | "REVIEW" | "VERIFY";
export type FrozenPiProfiles = Record<PiProfileRole, { name: string; version: string }>;

const READ_ONLY_PROFILE_TOOLS = ["read", "grep", "find", "ls"];
const WRITER_PROFILE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Record effective authority after applying the same tool restrictions used by each role. */
export function freezePiProfiles(
	launcher: PiWorkerLauncher,
	cwd: string,
	names: { planner: string; explorer: string; implementer: string; reviewer: string; verifier?: string },
	execution: ExecutionPolicy,
): FrozenPiProfiles {
	const resolve = (name: string, readOnly: boolean, role: AgentRole) => {
		const resolved = launcher.resolveProfile(
			cwd,
			name,
			readOnly ? READ_ONLY_PROFILE_TOOLS : WRITER_PROFILE_TOOLS,
			execution,
			role,
		);
		const effective = readOnly ? constrainProfileTools(resolved, READ_ONLY_PROFILE_TOOLS) : resolved;
		return { name: effective.name, version: effective.version };
	};
	return {
		PLAN: resolve(names.planner, true, "planner"),
		EXPLORE: resolve(names.explorer, true, "explorer"),
		IMPLEMENT: resolve(names.implementer, false, "implementer"),
		REVIEW: resolve(names.reviewer, true, "reviewer"),
		VERIFY: resolve(names.verifier ?? "verifier", true, "verifier"),
	};
}

/** Legacy runs retain their per-Attempt resume check; only newly initialized runs bind every future Attempt. */
export function assertFrozenProfile(goal: unknown, role: PiProfileRole, profile: ResolvedPiProfile): void {
	if (!goal || typeof goal !== "object" || !("piProfiles" in goal)) return;
	const frozen = (goal as { piProfiles?: Partial<FrozenPiProfiles> }).piProfiles?.[role];
	if (!frozen || frozen.name !== profile.name || frozen.version !== profile.version) {
		throw new DomainInvariantError(
			"FROZEN_PI_PROFILE_MISMATCH",
			`Pi ${role} profile changed after run initialization; restore its frozen prompt, tools, model, provider and reasoning settings or start a new run`,
		);
	}
}

interface BuiltinProfile {
	description: string;
	tools: string[];
	systemPrompt: string;
}

// Pi's official subagent example ships the same four functional defaults as
// scout/planner/worker/reviewer. Names here follow this product's vocabulary;
// user- or trusted project-level Pi definitions can override every one.
const BUILTIN_PROFILES: Readonly<Record<string, BuiltinProfile>> = Object.freeze({
	verifier: {
		description: "Independent specification discovery and executable counterexample design",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"Work read-only from the public goal and repository evidence. Derive behavior obligations and design executable discriminating tests. Cite exact source quotations. Distinguish explicit requirements from unresolved assumptions. You cannot change acceptance criteria or declare delivery.",
	},
	explorer: {
		description: "Read-only repository reconnaissance and evidence-backed handoff",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"Work read-only. Locate the relevant files, symbols, tests, and dependencies. Separate inspected facts from inference and return concise path-based findings for another agent.",
	},
	planner: {
		description: "Read-only task decomposition and dependency planning",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"Work read-only. Produce a concrete, dependency-aware implementation plan grounded in the repository. Do not edit files or claim completion.",
	},
	implementer: {
		description: "General-purpose implementation in an isolated worktree",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		systemPrompt:
			"Implement the assigned task autonomously inside the provided worktree. Respect the task scope and report changed paths and verification observations without claiming authoritative acceptance.",
	},
	reviewer: {
		description: "Independent read-only review of an immutable candidate",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"Review read-only for correctness, regression risk, security, and contract compliance. Cite specific evidence and distinguish blocking findings from suggestions.",
	},
});

function profileVersion(
	systemPrompt: string,
	tools: string[],
	model?: string,
	provider?: string,
	reasoning?: string,
): string {
	return createHash("sha256").update(JSON.stringify({ systemPrompt, tools, model, provider, reasoning })).digest("hex");
}

export function constrainProfileTools(profile: ResolvedPiProfile, allowedTools: readonly string[]): ResolvedPiProfile {
	const tools = profile.tools.filter((tool) => allowedTools.includes(tool));
	return {
		...profile,
		tools,
		version: profileVersion(profile.systemPrompt, tools, profile.model, profile.provider, profile.reasoning),
	};
}

export class PiWorkerLauncher {
	listProfiles(cwd: string): PiProfileSummary[] {
		const trusted = new ProjectTrustStore(getAgentDir()).get(cwd) === true;
		const discovery = discoverPiAgents(cwd, { scope: "both", includeProjectAgents: trusted });
		const profiles = new Map<string, PiProfileSummary>();
		for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
			profiles.set(name, { name, description: profile.description, tools: profile.tools, source: "builtin" });
		}
		for (const profile of discovery.agents) {
			profiles.set(profile.name, {
				name: profile.name,
				description: profile.description,
				tools: profile.noTools ? [] : (profile.tools ?? BUILTIN_PROFILES[profile.name]?.tools ?? []),
				source: profile.source,
			});
		}
		return [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	resolveProfile(
		cwd: string,
		name: string,
		defaultTools: string[],
		execution?: ExecutionPolicy,
		role?: AgentRole,
	): ResolvedPiProfile {
		const trusted = new ProjectTrustStore(getAgentDir()).get(cwd) === true;
		const discovery = discoverPiAgents(cwd, { scope: "both", includeProjectAgents: trusted });
		const profile = discovery.agents.find((agent) => agent.name === name);
		const builtin = BUILTIN_PROFILES[name];
		const systemPrompt = profile?.systemPrompt ?? builtin?.systemPrompt ?? "";
		const tools = profile?.noTools ? [] : (profile?.tools ?? builtin?.tools ?? defaultTools);
		const selection = modelSelectionFor(execution, role);
		const model = selection.model ?? profile?.model;
		return {
			name,
			description: profile?.description ?? builtin?.description ?? "User-selected Pi agent profile",
			systemPrompt,
			tools,
			model,
			provider: selection.provider,
			reasoning: selection.reasoning,
			version: profileVersion(systemPrompt, tools, model, selection.provider, selection.reasoning),
			source: profile?.source ?? "builtin",
		};
	}

	async create(request: PiWorkerRequest, resolved?: ResolvedPiProfile): Promise<ManagedPiWorker> {
		const profile = resolved ?? this.resolveProfile(request.cwd, request.profileName, request.defaultTools);
		if (profile.name !== request.profileName) throw new Error("Resolved Pi profile does not match the worker request");
		await checkPiSearchTools(profile.tools);
		let systemPromptFile: string | undefined;
		if (profile.systemPrompt.trim()) {
			const promptDirectory = join(request.sessionDirectory, "system-prompts");
			await mkdir(promptDirectory, { recursive: true });
			systemPromptFile = join(promptDirectory, "profile-" + profile.version + ".md");
			await writeFile(systemPromptFile, profile.systemPrompt, { mode: 0o600 });
		}
		const guard = PersistentSessionGuard.acquire(
			{
				sessionId: request.sessionId,
				lockRoot: join(request.sessionDirectory, "locks"),
				agent: request.profileName,
				cwd: request.cwd,
			},
			{ recoverDeadOwner: true },
		);
		let worker: PiRpcWorker;
		try {
			const tools = request.control ? [...new Set([...profile.tools, ...CONTROL_TOOL_NAMES])] : profile.tools;
			const config: PiWorkerConfig = {
				cwd: request.cwd,
				sessionDirectory: request.sessionDirectory,
				sessionId: request.sessionId,
				sessionName: request.sessionName,
				systemPromptFile,
				disableExtensionDiscovery: true,
				extensionPaths: [controlExtensionPath()],
				tools,
				model: profile.model,
				provider: profile.provider,
				reasoning: profile.reasoning,
				environment: request.control
					? {
							TRIPLETEAM_CONTROL_URL: request.control.url,
							TRIPLETEAM_CONTROL_TOKEN: request.control.token,
						}
					: undefined,
			};
			worker = new PiRpcWorker(config);
		} catch (error) {
			guard.release();
			throw error;
		}
		let closed = false;
		return {
			worker,
			profileVersion: profile.version,
			close: async () => {
				if (closed) return;
				closed = true;
				try {
					await worker.stop();
				} finally {
					guard.release();
				}
			},
		};
	}
}
