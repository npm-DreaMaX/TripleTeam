import { access } from "node:fs/promises";
import { join } from "node:path";
import { getPackageDir, RpcClient, type RpcEventListener, type RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ExecutionPolicy } from "../../config/execution.ts";

export interface PiWorkerConfig {
	cwd: string;
	sessionDirectory: string;
	sessionId: string;
	sessionName: string;
	systemPromptFile?: string;
	disableExtensionDiscovery?: boolean;
	extensionPaths?: string[];
	tools?: string[];
	provider?: string;
	model?: string;
	reasoning?: ExecutionPolicy["reasoning"];
	environment?: Record<string, string>;
}

export interface PiRunResult {
	state: RpcSessionState;
	lastAssistantText: string | null;
	usage: PiUsage;
}

export interface PiUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
}

export function resolvePiCliPath(): string {
	return join(getPackageDir(), "dist", "bundle", "cli.js");
}

export class PiRpcWorker {
	private readonly client: RpcClient;
	private started = false;
	private readonly usageListeners = new Set<(usage: PiUsage) => void>();
	private usage: PiUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
	};

	constructor(readonly config: PiWorkerConfig) {
		const args = [
			"--session-dir",
			config.sessionDirectory,
			"--session-id",
			config.sessionId,
			"--name",
			config.sessionName,
		];
		if (config.systemPromptFile) args.push("--append-system-prompt", config.systemPromptFile);
		if (config.disableExtensionDiscovery ?? true) args.push("--no-extensions");
		for (const extensionPath of config.extensionPaths ?? []) {
			args.push("--extension", extensionPath);
		}
		if (config.tools) {
			args.push("--tools", config.tools.join(","));
		}

		this.client = new RpcClient({
			cliPath: resolvePiCliPath(),
			cwd: config.cwd,
			env: config.environment,
			provider: config.provider,
			model: config.model,
			args,
		});
		this.client.onEvent((event) => {
			const usage = usageFromPiEvent(event);
			if (usage) {
				this.usage.inputTokens += usage.input;
				this.usage.outputTokens += usage.output;
				this.usage.cacheReadTokens += usage.cacheRead;
				this.usage.cacheWriteTokens += usage.cacheWrite;
				this.usage.costUsd += usage.cost.total;
			}
			if (event.type === "tool_execution_end") this.usage.toolCalls++;
			if (usage || event.type === "tool_execution_end")
				for (const listener of this.usageListeners) listener(this.usageSnapshot());
		});
	}

	onUsage(listener: (usage: PiUsage) => void): () => void {
		this.usageListeners.add(listener);
		return () => {
			this.usageListeners.delete(listener);
		};
	}

	usageSnapshot(): PiUsage {
		return { ...this.usage };
	}

	async start(): Promise<RpcSessionState> {
		if (this.started) throw new Error("Pi worker is already started");
		await access(resolvePiCliPath());
		await this.client.start();
		this.started = true;
		if (this.config.reasoning !== undefined) await this.client.setThinkingLevel(this.config.reasoning);
		const state = await this.client.getState();
		if (this.config.provider && this.config.model) {
			const requested = this.config.model.replace(this.config.provider + "/", "");
			if (state.model?.provider !== this.config.provider || state.model.id !== requested)
				throw new Error("Pi resolved a different model from the frozen provider/model selection");
		}
		if (this.config.reasoning !== undefined && state.thinkingLevel !== this.config.reasoning)
			throw new Error("Pi does not support the frozen reasoning level for this model");
		return state;
	}

	onEvent(listener: RpcEventListener): () => void {
		return this.client.onEvent(listener);
	}

	async run(prompt: string, timeoutMs?: number): Promise<PiRunResult> {
		this.assertStarted();
		const before = { ...this.usage };
		const prior = await this.client.getSessionStats();
		try {
			await this.client.promptAndWait(prompt, undefined, timeoutMs);
		} finally {
			// Public Pi statistics include compaction, cache warming and tool-reported usage.
			// Reconcile the invocation delta; resumed history must not be charged again.
			try {
				const after = await this.client.getSessionStats();
				for (const [target, source] of [
					["inputTokens", "input"],
					["outputTokens", "output"],
					["cacheReadTokens", "cacheRead"],
					["cacheWriteTokens", "cacheWrite"],
				] as const)
					this.usage[target] = Math.max(
						this.usage[target],
						before[target] + after.tokens[source] - prior.tokens[source],
					);
				this.usage.costUsd = Math.max(this.usage.costUsd, before.costUsd + after.cost - prior.cost);
				for (const listener of this.usageListeners) listener(this.usageSnapshot());
			} catch {
				// Live event accounting remains a lower bound if the RPC process is gone.
			}
		}
		return {
			state: await this.client.getState(),
			lastAssistantText: await this.client.getLastAssistantText(),
			usage: {
				inputTokens: this.usage.inputTokens - before.inputTokens,
				outputTokens: this.usage.outputTokens - before.outputTokens,
				cacheReadTokens: this.usage.cacheReadTokens - before.cacheReadTokens,
				cacheWriteTokens: this.usage.cacheWriteTokens - before.cacheWriteTokens,
				costUsd: this.usage.costUsd - before.costUsd,
				toolCalls: this.usage.toolCalls - before.toolCalls,
			},
		};
	}

	async steer(message: string): Promise<void> {
		this.assertStarted();
		await this.client.steer(message);
	}

	async followUp(message: string): Promise<void> {
		this.assertStarted();
		await this.client.followUp(message);
	}

	async abort(): Promise<void> {
		if (!this.started) return;
		await this.client.abort();
	}

	async state(): Promise<RpcSessionState> {
		this.assertStarted();
		return this.client.getState();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		await this.client.stop();
		this.started = false;
	}

	private assertStarted(): void {
		if (!this.started) throw new Error("Pi worker has not been started");
	}
}

/** Each billable entry has exactly one event path; message entries are counted at message_end. */
export function usageFromPiEvent(event: Parameters<RpcEventListener>[0]) {
	if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "toolResult"))
		return event.message.usage;
	if (event.type === "entry_appended" && ["usage", "compaction", "branch_summary"].includes(event.entry.type)) {
		const entry = event.entry;
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
	}
	return undefined;
}
