import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { RpcClient, type RpcEventListener } from "@earendil-works/pi-coding-agent";
import { PiProviderUnavailableError, permanentProviderError } from "../../src/runtime/pi/provider-error.ts";
import { PiRpcWorker } from "../../src/runtime/pi/rpc-worker.ts";

// A real child process speaking Pi's public JSONL protocol, with no model/provider.
const fixture = `
import { createInterface } from "node:readline";
const mode = process.env.TRIPLETEAM_RPC_FIXTURE_MODE;
let tokens = 100;
let cost = 1;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  const reply = (data) => send({ type: "response", id: command.id, command: command.type, success: true, data });
  switch (command.type) {
    case "get_state":
      reply({ thinkingLevel: "off", isStreaming: false });
      break;
    case "get_session_stats":
      reply({ tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, cost });
      break;
    case "get_last_assistant_text":
      reply({ text: "fixture completed" });
      break;
    case "prompt":
      if (mode === "prompt-exit") process.exit(9);
      reply();
      send({ type: "agent_start" });
      tokens += 10;
      cost += 0.1;
      send({ type: "message_end", message: { role: "assistant", stopReason: mode.startsWith("provider-") ? "error" : "stop", errorMessage: mode === "provider-billing" ? '402: {"message":"Insufficient Balance","echo":"private-credential"}' : undefined, usage: {
        input: 10, output: 0, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 }
      } } });
      if (mode === "complete" || mode.startsWith("provider-")) {
        // Session statistics also include work absent from the streamed message.
        tokens += 10;
        cost += 0.2;
        send({ type: "agent_settled" });
      }
      break;
    case "abort":
      reply();
      if (mode === "abort-settled") send({ type: "agent_settled" });
      break;
    default:
      reply();
  }
});
`;

class ObservedRpcClient extends RpcClient {
	liveListeners = 0;

	override onEvent(listener: RpcEventListener): () => void {
		this.liveListeners++;
		const unsubscribe = super.onEvent(listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.liveListeners--;
			unsubscribe();
		};
	}
}

async function fixtureFile(context: TestContext): Promise<{ directory: string; cliPath: string }> {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-rpc-cancellation-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const cliPath = join(directory, "fixture.mjs");
	await writeFile(cliPath, fixture);
	return { directory, cliPath };
}

async function workerFixture(context: TestContext, mode: string) {
	const { directory, cliPath } = await fixtureFile(context);
	const client = new ObservedRpcClient({ cliPath, env: { TRIPLETEAM_RPC_FIXTURE_MODE: mode } });
	const worker = new PiRpcWorker(
		{ cwd: directory, sessionDirectory: directory, sessionId: "fixture", sessionName: "fixture" },
		client,
	);
	context.after(() => worker.stop());
	await worker.start();
	return { worker, client };
}

function promptStarted(worker: PiRpcWorker): Promise<void> {
	return new Promise((resolveStarted) => {
		const unsubscribe = worker.onEvent((event) => {
			if (event.type !== "agent_start") return;
			// Defer unsubscription until public RpcClient finishes its event dispatch.
			queueMicrotask(unsubscribe);
			resolveStarted();
		});
	});
}

test("RPC natural completion releases its wait and reconciles only new session usage", async (context) => {
	const { worker, client } = await workerFixture(context, "complete");
	const result = await worker.run("complete", 600_000);
	assert.equal(result.lastAssistantText, "fixture completed");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.usage.inputTokens, 20);
	assert.ok(Math.abs(result.usage.costUsd - 0.3) < 1e-9);
	assert.equal(client.liveListeners, 1, "only the worker's live usage subscription remains");
	await worker.stop();
	assert.equal(client.liveListeners, 0);
});

test("RPC billing failure preserves usage and exposes a classified error without the provider body", async (context) => {
	const { worker, client } = await workerFixture(context, "provider-billing");
	await assert.rejects(worker.run("fail", 600_000), (error) => {
		assert.ok(error instanceof PiProviderUnavailableError);
		assert.equal(error.category, "BILLING");
		assert.match(error.message, /402/);
		assert.ok(!error.message.includes("private-credential"));
		return true;
	});
	assert.equal(worker.usageSnapshot().inputTokens, 20);
	assert.equal(client.liveListeners, 1);
});

test("provider account errors are distinguished from transient rate limits and outages", () => {
	assert.equal(permanentProviderError('429: {"code":"insufficient_quota"}')?.category, "BILLING");
	assert.equal(permanentProviderError("401: invalid_api_key")?.category, "AUTHENTICATION");
	assert.equal(permanentProviderError("HTTP 403 forbidden")?.category, "PERMISSION");
	assert.equal(permanentProviderError("429 rate limit; retry after 402 seconds"), undefined);
	assert.equal(permanentProviderError("503 server unavailable"), undefined);
});

test("RPC settled provider failure cannot be reported as a completed model response", async (context) => {
	const { worker, client } = await workerFixture(context, "provider-error");
	await assert.rejects(worker.run("fail", 600_000), /stopped with error/);
	assert.ok(worker.usageSnapshot().inputTokens > 0);
	assert.equal(client.liveListeners, 1);
});

test("RPC prompt transport rejection releases the settlement listener", async (context) => {
	const { worker, client } = await workerFixture(context, "prompt-exit");
	await assert.rejects(worker.run("reject", 600_000), /Agent process exited/);
	assert.equal(client.liveListeners, 1);
	await worker.stop();
	assert.equal(client.liveListeners, 0);
});

test("RPC abort remains a failure even when Pi subsequently emits agent_settled", async (context) => {
	const { worker, client } = await workerFixture(context, "abort-settled");
	const ready = promptStarted(worker);
	const rejected = assert.rejects(worker.run("abort", 600_000), { name: "AbortError" });
	await ready;
	await worker.abort();
	await rejected;
	assert.equal(client.liveListeners, 1);
	assert.equal(worker.usageSnapshot().inputTokens, 10, "interrupted observed usage is retained");
	await worker.stop();
	assert.equal(client.liveListeners, 0);
});

test("RPC stop rejects an active wait and releases adapter subscriptions", async (context) => {
	const { worker, client } = await workerFixture(context, "wait");
	const ready = promptStarted(worker);
	const rejected = assert.rejects(worker.run("stop", 600_000), { name: "AbortError" });
	await ready;
	await Promise.all([worker.stop(), worker.stop()]);
	await rejected;
	assert.equal(client.liveListeners, 0);
});

test("RPC timeout rejects and detaches its wait without inventing a completion event", async (context) => {
	const { worker, client } = await workerFixture(context, "wait");
	let settledEvents = 0;
	const unsubscribe = worker.onEvent((event) => {
		if (event.type === "agent_settled") settledEvents++;
	});
	await assert.rejects(worker.run("timeout", 40), /Timeout waiting for Pi agent to settle/);
	assert.equal(settledEvents, 0);
	assert.equal(client.liveListeners, 2, "timeout leaves only usage and this test's explicit observer");
	unsubscribe();
	await worker.stop();
	assert.equal(client.liveListeners, 0);
});

test("abort followed by stop lets a standalone process exit without the ten-minute wait timer", async (context) => {
	const { directory, cliPath } = await fixtureFile(context);
	const driver = join(directory, "driver.mjs");
	const adapter = pathToFileURL(resolve("src/runtime/pi/rpc-worker.ts")).href;
	const upstream = pathToFileURL(resolve("vendor/pi/pi-coding-agent/dist/index.js")).href;
	await writeFile(
		driver,
		`import assert from "node:assert/strict";
import { PiRpcWorker } from ${JSON.stringify(adapter)};
import { RpcClient } from ${JSON.stringify(upstream)};
const client = new RpcClient({ cliPath: ${JSON.stringify(cliPath)}, env: { TRIPLETEAM_RPC_FIXTURE_MODE: "wait" } });
const worker = new PiRpcWorker({ cwd: ${JSON.stringify(directory)}, sessionDirectory: ${JSON.stringify(directory)}, sessionId: "exit-check", sessionName: "exit-check" }, client);
try {
  await worker.start();
  const ready = new Promise((resolve) => {
    const unsubscribe = worker.onEvent((event) => {
      if (event.type === "agent_start") { queueMicrotask(unsubscribe); resolve(); }
    });
  });
  const rejected = assert.rejects(worker.run("cancel", 600000), { name: "AbortError" });
  await ready;
  await worker.abort();
  await worker.stop();
  await rejected;
  console.log("cancelled-and-stopped");
} finally {
  await worker.stop();
}
`,
	);
	const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", driver], {
		cwd: process.cwd(),
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	assert.match(stdout, /cancelled-and-stopped/);
});
