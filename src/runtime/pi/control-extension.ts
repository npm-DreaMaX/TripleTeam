import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkspaceSearchPolicy } from "./search-policy.ts";

const controlUrl = process.env.TRIPLETEAM_CONTROL_URL;
const controlToken = process.env.TRIPLETEAM_CONTROL_TOKEN;

async function request(path: string, init?: RequestInit): Promise<unknown> {
	if (!controlUrl || !controlToken) throw new Error("Agent control capability is not configured");
	const response = await fetch(controlUrl + path, {
		...init,
		headers: {
			...(init?.body ? { "content-type": "application/json" } : {}),
			authorization: `Bearer ${controlToken}`,
		},
		signal: AbortSignal.timeout(15_000),
	});
	const body = (await response.json()) as unknown;
	if (!response.ok) {
		const message =
			typeof body === "object" && body !== null && "error" in body
				? String((body as { error: unknown }).error)
				: response.statusText;
		throw new Error(message);
	}
	return body;
}

function result(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

const Reference = Type.Object({
	kind: Type.Union([
		Type.Literal("TASK"),
		Type.Literal("ATTEMPT"),
		Type.Literal("CANDIDATE"),
		Type.Literal("CHECK"),
		Type.Literal("REVIEW"),
		Type.Literal("PROPOSAL"),
	]),
	id: Type.String(),
});

const TaskSpec = {
	title: Type.String({ minLength: 1 }),
	objective: Type.String({ minLength: 1 }),
	scope: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	riskClass: Type.Union([Type.Literal("LOW"), Type.Literal("NORMAL"), Type.Literal("HIGH")]),
	priority: Type.Integer(),
	requiredCapabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
};

const TaskReference = Type.Union([
	Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ newTaskKey: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

const TaskChangeSet = Type.Object(
	{
		additions: Type.Array(
			Type.Object({ key: Type.String({ minLength: 1 }), ...TaskSpec }, { additionalProperties: false }),
			{ maxItems: 32 },
		),
		revisions: Type.Array(
			Type.Object(
				{ taskId: Type.String({ minLength: 1 }), expectedVersion: Type.Integer({ minimum: 1 }), ...TaskSpec },
				{ additionalProperties: false },
			),
			{ maxItems: 32 },
		),
		dependencies: Type.Array(
			Type.Object(
				{
					task: TaskReference,
					dependsOn: TaskReference,
					kind: Type.Union([Type.Literal("REQUIRES"), Type.Literal("CONSUMES")]),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 128 },
		),
		cancellations: Type.Array(
			Type.Object(
				{
					taskId: Type.String({ minLength: 1 }),
					expectedVersion: Type.Integer({ minimum: 1 }),
					reason: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 32 },
		),
	},
	{ additionalProperties: false },
);

export default function controlExtension(pi: ExtensionAPI) {
	registerWorkspaceSearchPolicy(pi);
	if (!controlUrl || !controlToken) return;
	pi.registerTool(
		defineTool({
			name: "orchestrator_context",
			label: "Coordination Context",
			description:
				"Read authoritative task states, active attempt addresses, and scoped mailbox messages. Use this before coordinating with another agent; returned state is read-only.",
			parameters: Type.Object({}),
			async execute() {
				return result(await request("/v1/context"));
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "orchestrator_send_message",
			label: "Send Coordination Message",
			description:
				"Send a durable, scoped coordination message. Messages are observations only and never change task completion. Use HELP_REQUEST when blocked, QUESTION/ANSWER for coordination, OBSERVATION for facts, PROPOSAL to point at a proposal, and HANDOFF for bounded results.",
			parameters: Type.Object({
				recipientKind: Type.Union([Type.Literal("TASK"), Type.Literal("ATTEMPT"), Type.Literal("SYSTEM")]),
				recipientId: Type.String({
					description: "Task/attempt id from orchestrator_context, or control-plane for SYSTEM.",
				}),
				kind: Type.Union([
					Type.Literal("QUESTION"),
					Type.Literal("ANSWER"),
					Type.Literal("OBSERVATION"),
					Type.Literal("HELP_REQUEST"),
					Type.Literal("PROPOSAL"),
					Type.Literal("HANDOFF"),
				]),
				body: Type.String({ description: "Compact message body; put large outputs in artifacts, not messages." }),
				references: Type.Optional(Type.Array(Reference)),
				replyToId: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params) {
				return result(
					await request("/v1/messages", {
						method: "POST",
						body: JSON.stringify(params),
					}),
				);
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "orchestrator_propose_task_changes",
			label: "Propose Task Graph Changes",
			description:
				"Submit a non-authoritative, versioned task-graph proposal. The control plane owns acceptance checks and review policy; do not supply them. changes must contain additions, revisions, dependencies, and cancellations arrays. New/revised tasks include title, objective, scope, constraints, riskClass, and priority; revisions/cancellations also include expectedVersion. A bounded prerequisite refinement may be accepted automatically only when the current task depends on every added task. Submitting a proposal relinquishes the current implementation attempt so the graph can be decided safely. Dependency endpoints are {taskId} or {newTaskKey}.",
			parameters: Type.Object({ changes: TaskChangeSet }, { additionalProperties: false }),
			async execute(_toolCallId, params) {
				return result(
					await request("/v1/proposals", {
						method: "POST",
						body: JSON.stringify(params),
					}),
				);
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "orchestrator_request_decision",
			label: "Request Human Decision",
			description:
				"Stop and request a first-class human decision only when repository/spec/evidence cannot uniquely determine product semantics, an irreversible action, or a cross-task semantic contract. Do not use this for ordinary engineering uncertainty; investigate, replan, or request peer help instead.",
			parameters: Type.Object(
				{
					kind: Type.Union([
						Type.Literal("REQUIREMENT_CHOICE"),
						Type.Literal("IRREVERSIBLE_ACTION"),
						Type.Literal("SEMANTIC_CONTRACT"),
					]),
					question: Type.String({ minLength: 1 }),
					options: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 5 }),
					recommendedOption: Type.Optional(Type.String({ minLength: 1 })),
					evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, params) {
				return result(
					await request("/v1/decisions", {
						method: "POST",
						body: JSON.stringify(params),
					}),
				);
			},
		}),
	);
}
