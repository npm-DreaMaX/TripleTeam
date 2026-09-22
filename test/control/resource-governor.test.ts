import assert from "node:assert/strict";
import test from "node:test";
import { LocalResourceGovernor, type ResourcePolicy } from "../../src/control/resource-governor.ts";

const policy: ResourcePolicy = {
	capacity: 3,
	lanes: {
		INTERACTIVE: { limit: 2, weight: 1, priority: 100 },
		CODING: { limit: 2, weight: 2, priority: 60 },
		LIGHT_CHECK: { limit: 2, weight: 1, priority: 50 },
		HEAVY_CHECK: { limit: 1, weight: 3, priority: 40 },
		INTEGRATION: { limit: 1, weight: 1, priority: 80 },
	},
};

test("resource governor enforces weighted capacity and lane limits", async () => {
	const governor = new LocalResourceGovernor(policy);
	const releaseCoding = await governor.acquire("CODING");
	const pendingCoding = governor.acquire("CODING");
	assert.equal(governor.snapshot().activeByLane.CODING, 1);
	assert.equal(governor.snapshot().queued, 1);

	const releaseInteractive = await governor.acquire("INTERACTIVE");
	assert.equal(governor.snapshot().used, 3);
	releaseCoding();

	const releaseSecondCoding = await pendingCoding;
	assert.equal(governor.snapshot().activeByLane.CODING, 1);
	releaseInteractive();
	releaseSecondCoding();
	assert.equal(governor.snapshot().used, 0);
});

test("pause stops new work and abort removes a queued request", async () => {
	const governor = new LocalResourceGovernor(policy);
	governor.pause();
	const controller = new AbortController();
	const request = governor.acquire("INTEGRATION", controller.signal);
	assert.equal(governor.snapshot().queued, 1);
	controller.abort();
	await assert.rejects(request, /aborted/);
	assert.equal(governor.snapshot().queued, 0);
	governor.resume();
});
