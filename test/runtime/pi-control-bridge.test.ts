import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { CheckCommand } from "../../src/config/project.ts";
import { ControlCatalog } from "../../src/control/catalog.ts";
import { ControlKernel } from "../../src/control/kernel.ts";
import { AttemptControlBridge, controlExtensionPath } from "../../src/runtime/pi/control-bridge.ts";
import { openControlDatabase } from "../../src/store/database.ts";

const system = { kind: "SYSTEM", id: "test" } as const;
const check: CheckCommand = { name: "test", argv: ["npm", "test"], timeoutMs: 60_000, lane: "HEAVY_CHECK" };
const acceptanceContract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };

test("Pi control bridge exposes scoped messages and proposals without granting authoritative mutation", async (context) => {
	const database = await openControlDatabase(":memory:");
	context.after(() => database.close());
	const kernel = new ControlKernel(database);
	const catalog = new ControlCatalog(database);
	kernel.createRun({
		id: "run-1",
		repositoryRoot: "/repo",
		inputCommit: "base",
		integrationRef: "refs/tripleteam/runs/run-1/integration",
		actor: system,
	});
	kernel.createTask({
		id: "task-1",
		runId: "run-1",
		title: "Implement",
		objective: "Make the change",
		scope: ["src"],
		constraints: [],
		acceptanceContract,
		riskClass: "LOW",
		actor: system,
	});
	kernel.markTaskReady("task-1", system);
	kernel.startAttempt({
		id: "attempt-1",
		taskId: "task-1",
		baseCommit: "base",
		profileName: "implementer",
		profileVersion: "1",
		actor: system,
	});
	const bridge = new AttemptControlBridge(
		kernel,
		catalog,
		{
			runId: "run-1",
			taskId: "task-1",
			attemptId: "attempt-1",
		},
		undefined,
		{ candidateChecks: [check], integrationChecks: [check], reviewRequiredFor: [] },
	);
	const endpoint = await bridge.start();
	context.after(() => bridge.stop());

	assert.equal((await fetch(endpoint.url + "/v1/context")).status, 401);
	const headers = { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" };
	const contextResponse = await fetch(endpoint.url + "/v1/context", { headers });
	assert.equal(contextResponse.status, 200);
	const coordination = (await contextResponse.json()) as { peers: Array<{ id: string }>; task: { id: string } };
	assert.equal(coordination.task.id, "task-1");
	assert.deepEqual(
		coordination.peers.map((peer) => peer.id),
		["attempt-1"],
	);

	const messageResponse = await fetch(endpoint.url + "/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			recipientKind: "TASK",
			recipientId: "task-1",
			kind: "HELP_REQUEST",
			body: "Need the API contract clarified",
		}),
	});
	assert.equal(messageResponse.status, 200);
	assert.equal(catalog.listMessages({ runId: "run-1" })[0]?.senderId, "attempt-1");
	assert.equal(kernel.getTask("task-1").state, "ACTIVE");
	assert.equal((await fetch(endpoint.url + "/v1/context", { headers })).status, 200);
	assert.ok(catalog.listMessages({ runId: "run-1" })[0]?.readAt);

	const decisionResponse = await fetch(endpoint.url + "/v1/decisions", {
		method: "POST",
		headers,
		body: JSON.stringify({
			kind: "REQUIREMENT_CHOICE",
			question: "Which externally visible behavior is authoritative?",
			options: ["preserve-v1", "adopt-v2"],
			recommendedOption: "preserve-v1",
			evidenceRefs: ["src/public-api.ts"],
		}),
	});
	assert.equal(decisionResponse.status, 200);
	assert.equal(catalog.listOpenDecisionRequests("run-1")[0]?.sourceId, "attempt-1");
	assert.equal(kernel.getTask("task-1").state, "ACTIVE");

	const proposalResponse = await fetch(endpoint.url + "/v1/proposals", {
		method: "POST",
		headers,
		body: JSON.stringify({
			changes: {
				additions: [
					{
						key: "follow-up",
						title: "Add a follow-up test",
						objective: "Cover the discovered edge case",
						scope: ["test"],
						constraints: [],
						riskClass: "LOW",
						priority: 0,
					},
				],
				revisions: [],
				dependencies: [],
				cancellations: [],
			},
		}),
	});
	assert.equal(proposalResponse.status, 200);
	assert.equal(catalog.listTaskChangeProposals("run-1")[0]?.state, "PROPOSED");
	assert.deepEqual(
		(catalog.listTaskChangeProposals("run-1")[0]?.proposal as { additions: Array<{ acceptanceContract: unknown }> })
			.additions[0]?.acceptanceContract,
		acceptanceContract,
	);
	assert.equal(catalog.listTasks("run-1").length, 1);
	assert.equal(existsSync(controlExtensionPath()), true);
});
