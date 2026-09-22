import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalOrchestrator } from "../app/orchestrator.ts";

export interface DaemonEndpoint {
	pid: number;
	host: "127.0.0.1";
	port: number;
	token: string;
	repositoryRoot: string;
	startedAt: string;
}

interface Job {
	id: string;
	kind: string;
	state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
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

function send(response: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body, null, 2);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(data),
		"cache-control": "no-store",
	});
	response.end(data);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("JSON body must be an object");
	return value as Record<string, unknown>;
}

export class LocalControlDaemon {
	private readonly token = randomBytes(32).toString("base64url");
	private readonly jobs = new Map<string, Job>();
	private server: Server | undefined;
	private endpoint: DaemonEndpoint | undefined;
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;

	private constructor(private readonly orchestrator: LocalOrchestrator) {}

	get endpointFilePath(): string {
		return this.orchestrator.paths.daemon;
	}

	static async create(repositoryPath: string): Promise<LocalControlDaemon> {
		return new LocalControlDaemon(await LocalOrchestrator.open(repositoryPath));
	}

	async start(port = 0): Promise<DaemonEndpoint> {
		if (this.server) throw new Error("Daemon is already started");
		try {
			this.server = createServer((request, response) => {
				void this.handle(request, response).catch((error) => {
					if (!response.headersSent)
						send(response, 500, { error: error instanceof Error ? error.message : String(error) });
					else response.destroy(error instanceof Error ? error : new Error(String(error)));
				});
			});
			await new Promise<void>((resolve, reject) => {
				this.server?.once("error", reject);
				this.server?.listen(port, "127.0.0.1", () => {
					this.server?.off("error", reject);
					resolve();
				});
			});
			const address = this.server.address();
			if (!address || typeof address === "string") throw new Error("Daemon did not bind a TCP endpoint");
			this.endpoint = {
				pid: process.pid,
				host: "127.0.0.1",
				port: address.port,
				token: this.token,
				repositoryRoot: this.orchestrator.repositoryRoot,
				startedAt: new Date().toISOString(),
			};
			await this.claimEndpointFile(this.endpoint);
			return this.endpoint;
		} catch (error) {
			if (this.server?.listening) {
				await new Promise<void>((resolve) => this.server?.close(() => resolve()));
			}
			this.server = undefined;
			this.stopped = true;
			this.orchestrator.close();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			if (this.server) {
				await new Promise<void>((resolve, reject) =>
					this.server?.close((error) => (error ? reject(error) : resolve())),
				);
				this.server = undefined;
			}
			await this.queue.catch(() => undefined);
			if (this.endpoint) {
				try {
					const stored = JSON.parse(await readFile(this.orchestrator.paths.daemon, "utf8")) as { token?: unknown };
					if (stored.token === this.endpoint.token) await rm(this.orchestrator.paths.daemon, { force: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} finally {
			this.orchestrator.close();
		}
	}

	private authorized(request: IncomingMessage): boolean {
		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ")) return false;
		const supplied = Buffer.from(header.slice("Bearer ".length));
		const expected = Buffer.from(this.token);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && url.pathname === "/health") {
			send(response, 200, { status: "ok", pid: process.pid, repositoryRoot: this.orchestrator.repositoryRoot });
			return;
		}
		if (!this.authorized(request)) {
			send(response, 401, { error: "Unauthorized" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/runs") {
			const body = await jsonBody(request);
			if (typeof body.objective !== "string" || body.objective.trim() === "") {
				send(response, 400, { error: "objective must be a non-empty string" });
				return;
			}
			const initialized = await this.orchestrator.initialize(body.objective);
			const job = this.enqueue("RUN", () => this.orchestrator.continue(initialized.runId));
			send(response, 202, { run: initialized, job });
			return;
		}
		if (request.method === "GET" && url.pathname === "/v1/profiles") {
			send(response, 200, { profiles: this.orchestrator.listProfiles() });
			return;
		}
		const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && runMatch?.[1]) {
			const runId = decodeURIComponent(runMatch[1]);
			send(response, 200, {
				run: this.orchestrator.catalog.getRun(runId),
				tasks: this.orchestrator.catalog.listTasks(runId),
				resources: this.orchestrator.resources.snapshot(),
			});
			return;
		}
		const runCollectionMatch = /^\/v1\/runs\/([^/]+)\/(events|messages|proposals|decisions|artifacts)$/.exec(
			url.pathname,
		);
		if (request.method === "GET" && runCollectionMatch?.[1] && runCollectionMatch[2]) {
			const runId = decodeURIComponent(runCollectionMatch[1]);
			this.orchestrator.catalog.getRun(runId);
			const collection = runCollectionMatch[2];
			const value =
				collection === "events"
					? this.orchestrator.catalog.listEvents(runId)
					: collection === "messages"
						? this.orchestrator.catalog.listMessages({ runId })
						: collection === "proposals"
							? this.orchestrator.catalog.listTaskChangeProposals(runId)
							: collection === "decisions"
								? this.orchestrator.catalog.listOpenDecisionRequests(runId)
								: this.orchestrator.catalog.listArtifacts(runId);
			send(response, 200, { [collection]: value });
			return;
		}
		const resultMatch = /^\/v1\/runs\/([^/]+)\/result$/.exec(url.pathname);
		if (request.method === "GET" && resultMatch?.[1]) {
			const runId = decodeURIComponent(resultMatch[1]);
			send(response, 200, { delivery: await this.orchestrator.result(runId) });
			return;
		}
		const messageMatch = /^\/v1\/attempts\/([^/]+)\/messages$/.exec(url.pathname);
		if (request.method === "POST" && messageMatch?.[1]) {
			const body = await jsonBody(request);
			if (typeof body.body !== "string" || !body.body.trim()) {
				send(response, 400, { error: "body must be a non-empty string" });
				return;
			}
			const kind = body.kind ?? "OBSERVATION";
			if (
				kind !== "QUESTION" &&
				kind !== "ANSWER" &&
				kind !== "OBSERVATION" &&
				kind !== "HELP_REQUEST" &&
				kind !== "PROPOSAL" &&
				kind !== "HANDOFF"
			) {
				send(response, 400, { error: "kind is unsupported" });
				return;
			}
			send(
				response,
				200,
				await this.orchestrator.sendUserMessage(decodeURIComponent(messageMatch[1]), body.body, kind),
			);
			return;
		}
		const continueMatch = /^\/v1\/runs\/([^/]+)\/continue$/.exec(url.pathname);
		if (request.method === "POST" && continueMatch?.[1]) {
			const runId = decodeURIComponent(continueMatch[1]);
			this.orchestrator.catalog.getRun(runId);
			const job = this.enqueue("CONTINUE", () => this.orchestrator.continue(runId));
			send(response, 202, { job });
			return;
		}
		const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
		if (request.method === "POST" && cancelMatch?.[1]) {
			const body = await jsonBody(request);
			if (typeof body.reason !== "string" || !body.reason.trim()) {
				send(response, 400, { error: "reason must be a non-empty string" });
				return;
			}
			const runId = decodeURIComponent(cancelMatch[1]);
			const cancellation = await this.orchestrator.cancel(runId, body.reason);
			await this.queue.catch(() => undefined);
			send(response, 200, { cancellation, delivery: await this.orchestrator.result(runId) });
			return;
		}
		const retryMatch = /^\/v1\/tasks\/([^/]+)\/retry$/.exec(url.pathname);
		if (request.method === "POST" && retryMatch?.[1]) {
			const taskId = decodeURIComponent(retryMatch[1]);
			this.orchestrator.catalog.getTask(taskId);
			const job = this.enqueue("RETRY", () => this.orchestrator.retry(taskId));
			send(response, 202, { job });
			return;
		}
		const proposalMatch = /^\/v1\/proposals\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
		if (request.method === "POST" && proposalMatch?.[1] && proposalMatch[2]) {
			const proposalId = decodeURIComponent(proposalMatch[1]);
			const runId = this.orchestrator.catalog.getTaskChangeProposal(proposalId).runId;
			if (proposalMatch[2] === "accept") {
				const addedTasks = Object.fromEntries(this.orchestrator.acceptTaskProposal(proposalId));
				const job = this.enqueue("CONTINUE_AFTER_PROPOSAL", () => this.orchestrator.continue(runId));
				send(response, 202, { addedTasks, job });
			} else {
				const body = await jsonBody(request);
				if (typeof body.reason !== "string" || !body.reason.trim()) {
					send(response, 400, { error: "reason must be a non-empty string" });
					return;
				}
				this.orchestrator.rejectTaskProposal(proposalId, body.reason);
				const job = this.enqueue("CONTINUE_AFTER_PROPOSAL", () => this.orchestrator.continue(runId));
				send(response, 202, { proposalId, state: "REJECTED", job });
			}
			return;
		}
		const decisionMatch = /^\/v1\/decisions\/([^/]+)\/resolve$/.exec(url.pathname);
		if (request.method === "POST" && decisionMatch?.[1]) {
			const body = await jsonBody(request);
			if (typeof body.selectedOption !== "string" || typeof body.rationale !== "string" || !body.rationale.trim()) {
				send(response, 400, { error: "selectedOption and non-empty rationale are required" });
				return;
			}
			const resolution = this.orchestrator.resolveDecision(
				decodeURIComponent(decisionMatch[1]),
				body.selectedOption,
				body.rationale,
			);
			const job = resolution.mayContinue
				? this.enqueue("CONTINUE_AFTER_DECISION", () => this.orchestrator.continue(resolution.runId))
				: undefined;
			send(response, job ? 202 : 200, { resolution, job });
			return;
		}
		const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
		if (request.method === "GET" && jobMatch?.[1]) {
			const job = this.jobs.get(decodeURIComponent(jobMatch[1]));
			if (!job) send(response, 404, { error: "Job not found" });
			else send(response, 200, { job });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/control/pause") {
			this.orchestrator.resources.pause();
			send(response, 200, { resources: this.orchestrator.resources.snapshot() });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/control/resume") {
			this.orchestrator.resources.resume();
			send(response, 200, { resources: this.orchestrator.resources.snapshot() });
			return;
		}
		send(response, 404, { error: "Not found" });
	}

	private enqueue(kind: string, work: () => Promise<unknown>): Job {
		const job: Job = { id: randomUUID(), kind, state: "QUEUED", createdAt: new Date().toISOString() };
		this.jobs.set(job.id, job);
		this.queue = this.queue
			.catch(() => undefined)
			.then(async () => {
				job.state = "RUNNING";
				job.startedAt = new Date().toISOString();
				try {
					job.result = await work();
					job.state = "COMPLETED";
				} catch (error) {
					job.error = error instanceof Error ? error.message : String(error);
					job.state = "FAILED";
				} finally {
					job.finishedAt = new Date().toISOString();
				}
			});
		return job;
	}

	private async claimEndpointFile(endpoint: DaemonEndpoint): Promise<void> {
		try {
			const existing = JSON.parse(await readFile(this.orchestrator.paths.daemon, "utf8")) as { pid?: unknown };
			if (typeof existing.pid === "number" && processExists(existing.pid)) {
				throw new Error("A control daemon is already running for this repository");
			}
			await rm(this.orchestrator.paths.daemon, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await writeFile(this.orchestrator.paths.daemon, JSON.stringify(endpoint, null, 2), {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
	}
}
