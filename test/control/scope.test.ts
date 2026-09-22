import assert from "node:assert/strict";
import test from "node:test";
import { candidateScopeViolations, normalizeTaskScope, scopesOverlap } from "../../src/control/scope.ts";

test("repository-relative task scopes enforce ownership without weakening global tasks", () => {
	assert.deepEqual(normalizeTaskScope(["./src/api/", "test/api"]), ["src/api", "test/api"]);
	assert.deepEqual(normalizeTaskScope(["."]), []);
	assert.equal(scopesOverlap(["src/api"], ["src/api/routes"]), true);
	assert.equal(scopesOverlap(["src/api"], ["docs"]), false);
	assert.equal(scopesOverlap([], ["docs"]), true);
	assert.deepEqual(
		candidateScopeViolations(["src/api/index.ts", "test/api/index.test.ts"], ["src/api", "test/api"]),
		[],
	);
	assert.deepEqual(candidateScopeViolations(["src/api/index.ts", "package.json"], ["src/api"]), ["package.json"]);
	assert.throws(() => normalizeTaskScope(["../outside"]), /parent segments/);
	assert.throws(() => normalizeTaskScope(["/absolute"]), /repository-relative/);
});
