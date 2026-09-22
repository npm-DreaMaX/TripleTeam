export const AGENT_ROLES = ["planner", "explorer", "implementer", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export interface ModelSelection {
	model?: string;
	provider?: string;
	reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ExecutionPolicy extends ModelSelection {
	decisionMode: "interactive" | "noninteractive";
	policy: "ADAPTIVE" | "HEURISTIC" | "SINGLE" | "FIXED";
	maxParallelism: number;
	maxExecutions: number;
	costLimitUsd?: number;
	tokenLimit?: number;
	deadlineMs?: number;
	reservationUsd: number;
	reservationTokens: number;
	maxFinalRepairs: number;
	maxExplorationAttempts: number;
	enableContracts: boolean;
	enableFailureAdaptation: boolean;
	roles?: Partial<Record<AgentRole, ModelSelection>>;
}

export function parseExecutionPolicy(value: unknown = {}): ExecutionPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("execution must be an object");
	const input = value as Record<string, unknown>;
	const number = (key: string, fallback?: number, integer = true, minimum = 1): number | undefined => {
		const n = input[key] ?? fallback;
		if (n === undefined) return undefined;
		if (typeof n !== "number" || !Number.isFinite(n) || n < minimum || (integer && !Number.isSafeInteger(n))) {
			throw new Error(`execution.${key} must be a finite ${integer ? "integer" : "number"} >= ${minimum}`);
		}
		return n;
	};
	const choice = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
		const v = input[key] === undefined ? fallback : input[key];
		if (!values.includes(v as T)) throw new Error(`Invalid execution.${key}`);
		return v as T;
	};
	const flag = (key: string): boolean => {
		if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Invalid execution.${key}`);
		return input[key] !== false;
	};
	const text = (key: string): string | undefined => {
		const v = input[key];
		if (v === undefined) return undefined;
		if (typeof v !== "string" || !v.trim()) throw new Error(`Invalid execution.${key}`);
		return v;
	};
	let roles: ExecutionPolicy["roles"];
	if (input.roles !== undefined) {
		if (!input.roles || typeof input.roles !== "object" || Array.isArray(input.roles))
			throw new Error("execution.roles must be an object");
		roles = {};
		for (const [role, raw] of Object.entries(input.roles)) {
			if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`Unknown execution role: ${role}`);
			if (!raw || typeof raw !== "object" || Array.isArray(raw))
				throw new Error(`execution.roles.${role} must be an object`);
			for (const key of Object.keys(raw))
				if (!["provider", "model", "reasoning"].includes(key))
					throw new Error(
						`Unsupported execution.roles.${role}.${key}; configure API endpoints and credentials in the provider registry`,
					);
			const entry = raw as ModelSelection;
			if (entry.provider !== undefined && entry.model === undefined)
				throw new Error(`execution.roles.${role} requires a model when overriding the provider`);
			const parsed = parseExecutionPolicy(raw);
			roles[role as AgentRole] = { provider: parsed.provider, model: parsed.model, reasoning: parsed.reasoning };
		}
	}
	return {
		...(roles ? { roles } : {}),
		decisionMode: choice("decisionMode", ["interactive", "noninteractive"], "interactive"),
		policy: choice("policy", ["ADAPTIVE", "HEURISTIC", "SINGLE", "FIXED"], "ADAPTIVE"),
		maxParallelism: number("maxParallelism", 4) as number,
		maxExecutions: number("maxExecutions", 64) as number,
		costLimitUsd: number("costLimitUsd", undefined, false, 0.000001),
		tokenLimit: number("tokenLimit"),
		deadlineMs: number("deadlineMs"),
		reservationUsd: number("reservationUsd", 1, false, 0.000001) as number,
		reservationTokens: number("reservationTokens", 32_000) as number,
		maxFinalRepairs: number("maxFinalRepairs", 2, true, 0) as number,
		maxExplorationAttempts: number("maxExplorationAttempts", 2) as number,
		enableContracts: flag("enableContracts"),
		enableFailureAdaptation: flag("enableFailureAdaptation"),
		model: text("model"),
		provider: text("provider"),
		reasoning:
			input.reasoning === undefined
				? undefined
				: choice("reasoning", ["off", "minimal", "low", "medium", "high", "xhigh"] as const, "medium"),
	};
}

/** Role settings override global defaults; credentials stay with Pi's provider registry. */
export function modelSelectionFor(execution: ExecutionPolicy | undefined, role?: AgentRole): ModelSelection {
	const selected = role ? execution?.roles?.[role] : undefined;
	return {
		provider: selected?.provider ?? execution?.provider,
		model: selected?.model ?? execution?.model,
		reasoning: selected?.reasoning ?? execution?.reasoning,
	};
}

export function executionPolicyFor(goalContract: unknown): ExecutionPolicy {
	const goal = goalContract as { executionPolicy?: unknown } | null;
	return parseExecutionPolicy(goal?.executionPolicy ?? {});
}

/** A whole-goal baseline may use the shared compute cap, with identical no-progress stops. */
export function writerAttemptLimit(goalContract: unknown, perTaskLimit: number): number {
	const policy = executionPolicyFor(goalContract);
	return policy.policy === "SINGLE" ? policy.maxExecutions : perTaskLimit;
}
