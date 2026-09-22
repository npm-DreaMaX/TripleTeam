import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckCommand } from "../../config/project.ts";
import type { ControlCatalog } from "../../control/catalog.ts";
import { currentExplorationMessages } from "../../control/exploration-policy.ts";
import type {
	ControlKernel,
	MessageKind,
	MessageRecipientKind,
	MessageReference,
	TaskChangeSet,
} from "../../control/kernel.ts";
import type { LiveAttemptRegistry } from "./live-attempts.ts";

export const CONTROL_TOOL_NAMES = [
	"orchestrator_context",
	"orchestrator_send_message",
	"orchestrator_propose_task_changes",
	"orchestrator_request_decision",
] as const;

export interface PiControlEndpoint {
	url: string;
	token: string;
}

export interface AttemptControlIdentity {
	runId: string;
	attemptId: string;
	taskId?: string;
}

export interface TaskProposalDefaults {
	candidateChecks: CheckCommand[];
	integrationChecks: CheckCommand[];
	reviewRequiredFor: string[];
}

function send(response: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
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
		if (size > 256 * 1024) throw new Error("Control request exceeds 256 KiB");
		chunks.push(buffer);
	}
	const value: unknown = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Control request body must be an object");
	}
	return value as Record<string, unknown>;
}

function messageKind(value: unknown): MessageKind {
	if (
		value !== "QUESTION" &&
		value !== "ANSWER" &&
		value !== "OBSERVATION" &&
		value !== "HELP_REQUEST" &&
		value !== "PROPOSAL" &&
		value !== "HANDOFF"
	) {
		throw new Error("Unsupported message kind");
	}
	return value;
}

function recipientKind(value: unknown): MessageRecipientKind {
	if (value !== "TASK" && value !== "ATTEMPT" && value !== "SYSTEM") {
		throw new Error("Agent messages may target TASK, ATTEMPT, or SYSTEM");
	}
	return value;
}

function references(value: unknown): MessageReference[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Message references must be an array");
	return value.map((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error("Each message reference must be an object");
		}
		const reference = item as Record<string, unknown>;
		if (
			reference.kind !== "TASK" &&
			reference.kind !== "ATTEMPT" &&
			reference.kind !== "CANDIDATE" &&
			reference.kind !== "CHECK" &&
			reference.kind !== "REVIEW" &&
			reference.kind !== "PROPOSAL"
		) {
			throw new Error("Unsupported message reference kind");
		}
		if (typeof reference.id !== "string" || reference.id.trim() === "") {
			throw new Error("Message reference id is required");
		}
		return { kind: reference.kind, id: reference.id };
	});
}

export function controlExtensionPath(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	const built = join(directory, "control-extension.js");
	return existsSync(built) ? built : join(directory, "control-extension.ts");
}

export class AttemptControlBridge {
	private readonly token = randomBytes(32).toString("base64url");
	private server: Server | undefined;

	constructor(
		private readonly kernel: ControlKernel,
		private readonly catalog: ControlCatalog,
		private readonly identity: AttemptControlIdentity,
		private readonly liveAttempts?: LiveAttemptRegistry,
		private readonly proposalDefaults?: TaskProposalDefaults,
	) {}

	async start(): Promise<PiControlEndpoint> {
		if (this.server) throw new Error("Attempt control bridge is already started");
		this.catalog.getRun(this.identity.runId);
		const attempt = this.catalog.getAttempt(this.identity.attemptId);
		if (attempt.runId !== this.identity.runId || attempt.taskId !== (this.identity.taskId ?? null)) {
			throw new Error("Attempt control capability does not match authoritative identity");
		}
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				if (!response.headersSent)
					send(response, 400, { error: error instanceof Error ? error.message : String(error) });
				else response.destroy(error instanceof Error ? error : new Error(String(error)));
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, "127.0.0.1", () => {
				this.server?.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Attempt control bridge did not bind");
		return { url: `http://127.0.0.1:${address.port}`, token: this.token };
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	private authorized(request: IncomingMessage): boolean {
		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ")) return false;
		const supplied = Buffer.from(header.slice("Bearer ".length));
		const expected = Buffer.from(this.token);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.authorized(request)) {
			send(response, 401, { error: "Unauthorized" });
			return;
		}
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && url.pathname === "/v1/context") {
			const taskRevisionId = this.identity.taskId ? this.catalog.getTask(this.identity.taskId).revisionId : null;
			const direct = this.catalog.listMessages({
				runId: this.identity.runId,
				recipientKind: "ATTEMPT",
				recipientId: this.identity.attemptId,
				limit: 200,
			});
			const taskMessages = this.identity.taskId
				? this.catalog.listMessages({
						runId: this.identity.runId,
						recipientKind: "TASK",
						recipientId: this.identity.taskId,
						limit: 200,
					})
				: [];
			let messages = [...new Map([...direct, ...taskMessages].map((message) => [message.id, message])).values()].sort(
				(left, right) => left.createdAt.localeCompare(right.createdAt),
			);
			if (this.identity.taskId)
				messages = currentExplorationMessages(
					this.catalog,
					this.catalog.getTask(this.identity.taskId),
					this.catalog.getAttempt(this.identity.attemptId).baseCommit,
					messages,
				);
			for (const message of messages) {
				if (message.readAt) continue;
				this.kernel.markMessageRead({
					messageId: message.id,
					recipientKind: message.recipientKind,
					recipientId: message.recipientId,
					actor: { kind: "ATTEMPT", id: this.identity.attemptId },
				});
			}
			send(response, 200, {
				attempt: this.catalog.getAttempt(this.identity.attemptId),
				task: this.identity.taskId ? this.catalog.getTask(this.identity.taskId) : null,
				tasks: this.catalog.listTasks(this.identity.runId),
				peers: this.catalog.listRunningAttempts(this.identity.runId).map((peer) => ({
					id: peer.id,
					taskId: peer.taskId,
					workflowFunction: peer.workflowFunction,
					profileName: peer.profileName,
				})),
				messages,
				coordination: this.identity.taskId
					? {
							assessment: this.catalog.getCoordinationAssessment(this.identity.taskId),
							contract: this.catalog.getCoordinationContract(this.identity.taskId),
							explorations: this.catalog
								.listExplorations(this.identity.taskId, this.catalog.getAttempt(this.identity.attemptId).baseCommit)
								.filter((record) => record.taskRevisionId === taskRevisionId),
						}
					: null,
				decisionRequests: this.catalog.listOpenDecisionRequests(this.identity.runId),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/messages") {
			const body = await jsonBody(request);
			const recipient = recipientKind(body.recipientKind);
			if (typeof body.recipientId !== "string" || body.recipientId.trim() === "") {
				throw new Error("Message recipientId is required");
			}
			if (typeof body.body !== "string") throw new Error("Message body must be a string");
			const id = this.kernel.sendMessage({
				runId: this.identity.runId,
				taskId: this.identity.taskId,
				recipientKind: recipient,
				recipientId: body.recipientId,
				kind: messageKind(body.kind),
				body: body.body,
				references: references(body.references),
				replyToId: typeof body.replyToId === "string" ? body.replyToId : undefined,
				actor: { kind: "ATTEMPT", id: this.identity.attemptId },
			});
			let deliveredLive = false;
			let deliveryError: string | undefined;
			try {
				deliveredLive =
					(await this.liveAttempts?.deliver({
						messageId: id,
						senderKind: "ATTEMPT",
						senderId: this.identity.attemptId,
						recipientKind: recipient,
						recipientId: body.recipientId,
						kind: messageKind(body.kind),
						body: body.body,
					})) ?? false;
			} catch (error) {
				deliveryError = error instanceof Error ? error.message : String(error);
			}
			send(response, 200, { messageId: id, deliveredLive, deliveryError });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/proposals") {
			const body = await jsonBody(request);
			if (typeof body.changes !== "object" || body.changes === null || Array.isArray(body.changes)) {
				throw new Error("Task proposal changes must be an object");
			}
			if (!this.proposalDefaults) throw new Error("This Agent role cannot propose task-graph changes");
			const changes = structuredClone(body.changes) as Record<string, unknown>;
			for (const field of ["additions", "revisions"] as const) {
				if (!Array.isArray(changes[field])) throw new Error(`Task proposal ${field} must be an array`);
				for (const entry of changes[field]) {
					if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
						throw new Error(`Task proposal ${field} entries must be objects`);
					}
					const task = entry as Record<string, unknown>;
					if (task.riskClass !== "LOW" && task.riskClass !== "NORMAL" && task.riskClass !== "HIGH") {
						throw new Error(`Task proposal ${field} entry has an invalid riskClass`);
					}
					task.acceptanceContract = {
						candidateChecks: this.proposalDefaults.candidateChecks,
						integrationChecks: this.proposalDefaults.integrationChecks,
						requireReview: this.proposalDefaults.reviewRequiredFor.includes(task.riskClass),
					};
				}
			}
			const id = this.kernel.proposeTaskChanges({
				runId: this.identity.runId,
				changes: changes as unknown as TaskChangeSet,
				actor: { kind: "ATTEMPT", id: this.identity.attemptId },
			});
			send(response, 200, { proposalId: id, state: "PROPOSED" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/decisions") {
			if (!this.identity.taskId) throw new Error("Only a task-scoped Agent may request a user decision");
			const body = await jsonBody(request);
			if (
				body.kind !== "REQUIREMENT_CHOICE" &&
				body.kind !== "IRREVERSIBLE_ACTION" &&
				body.kind !== "SEMANTIC_CONTRACT"
			) {
				throw new Error("Agent may request only requirement, irreversible-action, or semantic-contract decisions");
			}
			if (typeof body.question !== "string" || !body.question.trim()) throw new Error("Decision question is required");
			if (!Array.isArray(body.options) || !body.options.every((option) => typeof option === "string")) {
				throw new Error("Decision options must be a string array");
			}
			const id = this.kernel.createDecisionRequest({
				runId: this.identity.runId,
				taskId: this.identity.taskId,
				kind: body.kind,
				question: body.question,
				options: body.options as string[],
				recommendedOption: typeof body.recommendedOption === "string" ? body.recommendedOption : undefined,
				evidenceRefs:
					Array.isArray(body.evidenceRefs) && body.evidenceRefs.every((value) => typeof value === "string")
						? (body.evidenceRefs as string[])
						: [],
				sourceKind: "ATTEMPT",
				sourceId: this.identity.attemptId,
				actor: { kind: "ATTEMPT", id: this.identity.attemptId },
			});
			send(response, 200, { decisionRequestId: id, state: "OPEN" });
			return;
		}
		send(response, 404, { error: "Not found" });
	}
}
