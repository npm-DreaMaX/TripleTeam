import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectPaths } from "../config/paths.ts";
import { resolveRepositoryRoot } from "../workspace/git.ts";
import type { DaemonEndpoint } from "./server.ts";

interface SubmittedJob {
	id: string;
	state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
	result?: unknown;
	error?: string;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function validEndpoint(value: unknown, repositoryRoot: string): value is DaemonEndpoint {
	if (typeof value !== "object" || value === null) return false;
	const endpoint = value as Record<string, unknown>;
	return (
		typeof endpoint.pid === "number" &&
		endpoint.host === "127.0.0.1" &&
		typeof endpoint.port === "number" &&
		typeof endpoint.token === "string" &&
		endpoint.repositoryRoot === repositoryRoot
	);
}

export class DaemonClient {
	private constructor(readonly endpoint: DaemonEndpoint) {}

	static async discover(repositoryPath: string): Promise<DaemonClient | null> {
		const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryPath));
		const endpointFile = projectPaths(repositoryRoot).daemon;
		try {
			const value: unknown = JSON.parse(await readFile(endpointFile, "utf8"));
			if (!validEndpoint(value, repositoryRoot) || !processExists(value.pid)) return null;
			const client = new DaemonClient(value);
			const health = await fetch(client.origin + "/health");
			return health.ok ? client : null;
		} catch {
			return null;
		}
	}

	async run(objective: string): Promise<unknown> {
		const submission = await this.request<{ job: SubmittedJob }>("POST", "/v1/runs", { objective });
		return this.wait(submission.job.id);
	}

	async continue(runId: string): Promise<unknown> {
		const submission = await this.request<{ job: SubmittedJob }>(
			"POST",
			"/v1/runs/" + encodeURIComponent(runId) + "/continue",
		);
		return this.wait(submission.job.id);
	}

	async retry(taskId: string): Promise<unknown> {
		const submission = await this.request<{ job: SubmittedJob }>(
			"POST",
			"/v1/tasks/" + encodeURIComponent(taskId) + "/retry",
		);
		return this.wait(submission.job.id);
	}

	cancel(runId: string, reason: string): Promise<unknown> {
		return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`, { reason });
	}

	profiles(): Promise<unknown> {
		return this.request("GET", "/v1/profiles");
	}

	collection(runId: string, name: "events" | "messages" | "proposals" | "decisions" | "artifacts"): Promise<unknown> {
		return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/${name}`);
	}

	async resolveDecision(requestId: string, selectedOption: string, rationale: string): Promise<unknown> {
		const response = await this.request<{ resolution: unknown; job?: SubmittedJob }>(
			"POST",
			`/v1/decisions/${encodeURIComponent(requestId)}/resolve`,
			{ selectedOption, rationale },
		);
		return response.job
			? { resolution: response.resolution, continuation: await this.wait(response.job.id) }
			: response.resolution;
	}

	result(runId: string): Promise<unknown> {
		return this.request("GET", `/v1/runs/${encodeURIComponent(runId)}/result`);
	}

	message(attemptId: string, body: string): Promise<unknown> {
		return this.request("POST", `/v1/attempts/${encodeURIComponent(attemptId)}/messages`, { body });
	}

	async acceptProposal(proposalId: string): Promise<unknown> {
		const submission = await this.request<{ job: SubmittedJob; addedTasks: Record<string, string> }>(
			"POST",
			`/v1/proposals/${encodeURIComponent(proposalId)}/accept`,
		);
		return { addedTasks: submission.addedTasks, continuation: await this.wait(submission.job.id) };
	}

	async rejectProposal(proposalId: string, reason: string): Promise<unknown> {
		const submission = await this.request<{ job: SubmittedJob; proposalId: string; state: string }>(
			"POST",
			`/v1/proposals/${encodeURIComponent(proposalId)}/reject`,
			{ reason },
		);
		return {
			proposalId: submission.proposalId,
			state: submission.state,
			continuation: await this.wait(submission.job.id),
		};
	}

	pause(): Promise<unknown> {
		return this.request("POST", "/v1/control/pause");
	}

	resume(): Promise<unknown> {
		return this.request("POST", "/v1/control/resume");
	}

	private get origin(): string {
		return `http://${this.endpoint.host}:${this.endpoint.port}`;
	}

	private async wait(jobId: string): Promise<unknown> {
		while (true) {
			const response = await this.request<{ job: SubmittedJob }>("GET", "/v1/jobs/" + encodeURIComponent(jobId));
			if (response.job.state === "COMPLETED") return response.job.result;
			if (response.job.state === "FAILED") throw new Error(response.job.error ?? "Daemon job failed");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
	}

	private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(this.origin + path, {
			method,
			headers: {
				authorization: "Bearer " + this.endpoint.token,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const value = (await response.json()) as { error?: unknown };
		if (!response.ok)
			throw new Error(typeof value.error === "string" ? value.error : `Daemon returned HTTP ${response.status}`);
		return value as T;
	}
}
