import assert from "node:assert/strict";
import test from "node:test";
import type { PiWorkerController } from "../../src/runtime/pi/launcher.ts";
import { LiveAttemptRegistry } from "../../src/runtime/pi/live-attempts.ts";

test("durable coordination messages can be pushed into the addressed live Pi session", async () => {
	const received: string[] = [];
	let aborted = false;
	const worker = {
		followUp: async (message: string) => {
			received.push(message);
		},
		abort: async () => {
			aborted = true;
		},
	} as unknown as PiWorkerController;
	const registry = new LiveAttemptRegistry();
	const unregister = registry.register("attempt-1", "task-1", worker);
	assert.equal(
		await registry.deliver({
			messageId: "message-1",
			senderKind: "ATTEMPT",
			senderId: "attempt-2",
			recipientKind: "TASK",
			recipientId: "task-1",
			kind: "HELP_REQUEST",
			body: "Please confirm the shared interface",
		}),
		true,
	);
	assert.match(received[0] ?? "", /message-1/);
	assert.match(received[0] ?? "", /orchestrator_context/);
	assert.equal(await registry.abort("attempt-1"), true);
	assert.equal(aborted, true);
	unregister();
	assert.equal(
		await registry.deliver({
			messageId: "message-2",
			senderKind: "USER",
			senderId: "local-user",
			recipientKind: "ATTEMPT",
			recipientId: "attempt-1",
			kind: "OBSERVATION",
			body: "No longer live",
		}),
		false,
	);
});
