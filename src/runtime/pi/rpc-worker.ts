import { access } from "node:fs/promises";
import { join } from "node:path";
import { getPackageDir, RpcClient, type RpcEventListener, type RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ExecutionPolicy } from "../../config/execution.ts";
import { type PiProviderUnavailableError, permanentProviderError } from "./provider-error.ts";

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
	stopReason?: string;
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
	private stopping?: Promise<void>;
	private activeRun?: AbortController;
	private unsubscribeUsage?: () => void;
	private lastAssistantStopReason?: string;
	private lastProviderError?: PiProviderUnavailableError;
	private readonly usageListeners = new Set<(usage: PiUsage) => void>();
	private usage: PiUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
	};

	constructor(
		readonly config: PiWorkerConfig,
		client?: RpcClient,
	) {
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

		this.client =
			client ??
			new RpcClient({
				cliPath: resolvePiCliPath(),
				cwd: config.cwd,
				env: config.environment,
				provider: config.provider,
				model: config.model,
				args,
			});
		this.subscribeUsage();
	}

	private subscribeUsage(): void {
		if (this.unsubscribeUsage) return;
		this.unsubscribeUsage = this.client.onEvent((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				this.lastAssistantStopReason = event.message.stopReason;
				this.lastProviderError =
					event.message.stopReason === "error" ? permanentProviderError(event.message.errorMessage) : undefined;
			}
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
		if (this.started || this.stopping) throw new Error("Pi worker is already started or stopping");
		await access(resolvePiCliPath());
		this.subscribeUsage();
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
		if (this.activeRun) throw new Error("Pi worker already has an active run");
		const controller = new AbortController();
		this.activeRun = controller;
		this.lastAssistantStopReason = undefined;
		this.lastProviderError = undefined;
		const before = { ...this.usage };
		try {
			const prior = await this.client.getSessionStats();
			controller.signal.throwIfAborted();
			try {
				await this.waitForSettlement(prompt, timeoutMs, controller.signal);
			} finally {
				// Public Pi statistics include compaction, cache warming and tool-reported usage.
				// Reconcile the invocation delta; resumed history must not be charged again.
				try {
					if (this.started) {
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
					}
				} catch {
					// Live event accounting remains a lower bound if the RPC process is gone.
				}
			}
			controller.signal.throwIfAborted();
			const state = await this.client.getState();
			const lastAssistantText = await this.client.getLastAssistantText();
			controller.signal.throwIfAborted();
			if (this.lastProviderError) throw this.lastProviderError;
			if (this.lastAssistantStopReason === "error" || this.lastAssistantStopReason === "aborted")
				throw new Error(
					`Pi assistant stopped with ${this.lastAssistantStopReason}; the execution did not produce a completed response`,
				);
			return {
				state,
				lastAssistantText,
				stopReason: this.lastAssistantStopReason,
				usage: {
					inputTokens: this.usage.inputTokens - before.inputTokens,
					outputTokens: this.usage.outputTokens - before.outputTokens,
					cacheReadTokens: this.usage.cacheReadTokens - before.cacheReadTokens,
					cacheWriteTokens: this.usage.cacheWriteTokens - before.cacheWriteTokens,
					costUsd: this.usage.costUsd - before.costUsd,
					toolCalls: this.usage.toolCalls - before.toolCalls,
				},
			};
		} finally {
			this.activeRun = undefined;
		}
	}

	/** Pi owns the run; this only owns a disposable wait on its public transport. */
	private waitForSettlement(prompt: string, timeoutMs = 60_000, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			let finished = false;
			let acknowledged = false;
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe = () => {};
			const finish = (error?: unknown): void => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				unsubscribe();
				signal.removeEventListener("abort", cancelled);
				if (error !== undefined) reject(error);
				else resolve();
			};
			const cancelled = () => finish(signal.reason);
			if (signal.aborted) {
				cancelled();
				return;
			}
			signal.addEventListener("abort", cancelled, { once: true });
			try {
				unsubscribe = this.client.onEvent((event) => {
					if (event.type !== "agent_settled") return;
					settled = true;
					if (acknowledged) finish();
				});
				timer = setTimeout(() => finish(new Error("Timeout waiting for Pi agent to settle")), timeoutMs);
				void this.client.prompt(prompt).then(
					() => {
						acknowledged = true;
						if (settled) finish();
					},
					(error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
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
		this.activeRun?.abort(new DOMException("Pi worker run aborted", "AbortError"));
		if (!this.started) return;
		await this.client.abort();
	}

	async state(): Promise<RpcSessionState> {
		this.assertStarted();
		return this.client.getState();
	}

	async stop(): Promise<void> {
		this.activeRun?.abort(new DOMException("Pi worker stopped before run completed", "AbortError"));
		this.unsubscribeUsage?.();
		this.unsubscribeUsage = undefined;
		if (this.stopping) return this.stopping;
		if (!this.started) return;
		this.started = false;
		this.stopping = this.client.stop();
		try {
			await this.stopping;
		} finally {
			this.stopping = undefined;
		}
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
