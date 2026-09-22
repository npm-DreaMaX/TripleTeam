// Audit probes for revision 4690901a390878593aa41e2fd25b98e8831b9578.
// Run from the repository root: node --import tsx docs/reviews/2026-09-22/reproduce.mjs
// These assertions reproduce defects; passing is NOT a correctness gate.
// No model calls. All runtime state and Git mutations are confined to temporary directories.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalOrchestrator } from "../../../src/app/orchestrator.ts";
import { evidenceClassForCheck } from "../../../src/config/project.ts";
import { ControlCatalog } from "../../../src/control/catalog.ts";
import { FailurePolicy } from "../../../src/control/failure-policy.ts";
import { ControlKernel } from "../../../src/control/kernel.ts";
import { BoundedTaskProposalPolicy } from "../../../src/control/task-proposal-policy.ts";
import { DeliveryReporter } from "../../../src/delivery/reporter.ts";
import { AdaptiveExplorationCoordinator } from "../../../src/exploration/explorer.ts";
import { openControlDatabase } from "../../../src/store/database.ts";
import { CheckRunner } from "../../../src/verification/check-runner.ts";
import { RunVerifier } from "../../../src/verification/run-verifier.ts";

const execFileAsync = promisify(execFile);
const actor = { kind: "SYSTEM", id: "audit" };
const check = { name: "test", argv: ["npm", "test"], timeoutMs: 5000, lane: "HEAVY_CHECK" };
const contract = { candidateChecks: [check], integrationChecks: [check], requireReview: false };
const config = {
  maxAttemptsPerTask: 4, maxPlannerExplorations: 3, maxDiverseExplorations: 2,
  maxRepeatedFailureFingerprints: 2, workerTimeoutMs: 5000,
  candidateChecks: [check], integrationChecks: [check], runChecks: [check], reviewRequiredFor: [],
  profiles: { explorer: "explorer", planner: "planner", implementer: "implementer", reviewer: "reviewer" },
};
const observations = [];
function observe(id, data) { observations.push({ id, ...data }); }
function task(kernel, runId, id) {
  kernel.createTask({ id, runId, title: id, objective: id, scope: ["src"],
    constraints: [], acceptanceContract: contract, riskClass: "LOW", actor });
  kernel.markTaskReady(id, actor);
}
async function memory() {
  const database = await openControlDatabase(":memory:");
  const kernel = new ControlKernel(database);
  const catalog = new ControlCatalog(database);
  kernel.createRun({ id: "run", repositoryRoot: "/repo", inputCommit: "base",
    integrationRef: "refs/audit/run", actor });
  return { database, kernel, catalog };
}
function attempt(kernel, taskId = "task") {
  kernel.startAttempt({ id: "attempt", taskId, baseCommit: "base",
    profileName: "implementer", profileVersion: "1", actor });
}
function proposal(kernel, scope, linked) {
  return kernel.proposeTaskChanges({ runId: "run", changes: {
    additions: [{ key: "new", title: "Prerequisite", objective: "Prerequisite", scope,
      constraints: [], acceptanceContract: contract, riskClass: "LOW", priority: 0 }],
    revisions: [], cancellations: [],
    dependencies: linked ? [{ task: { taskId: "task" }, dependsOn: { newTaskKey: "new" }, kind: "REQUIRES" }] : [],
  }, actor: { kind: "ATTEMPT", id: "attempt" } });
}
async function git(cwd, args) {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}
async function localFixture(root, name, runChecks) {
  const repo = join(root, name);
  await mkdir(repo);
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["config", "user.name", "Audit"]);
  await git(repo, ["config", "user.email", "audit@example.invalid"]);
  await writeFile(join(repo, "value.txt"), "bad\n");
  if (runChecks) await writeFile(join(repo, ".tripleteam.json"), JSON.stringify({ runChecks }));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "audit fixture"]);
  const app = await LocalOrchestrator.open(repo);
  const initialized = await app.initialize("Audit terminal verification");
  // Same no-op task cancellation setup as test/delivery/reporter.test.ts.
  const taskId = app.kernel.createTask({ runId: initialized.runId, title: "No-op", objective: "No-op",
    scope: [], constraints: [], acceptanceContract: contract, riskClass: "LOW", actor });
  const id = app.kernel.proposeTaskChanges({ runId: initialized.runId, changes: {
    additions: [], revisions: [], dependencies: [],
    cancellations: [{ taskId, expectedVersion: 1, reason: "No-op audit setup" }],
  }, actor });
  app.kernel.acceptTaskChanges(id, actor);
  return { app, repo, runId: initialized.runId };
}
async function finish(app, runId) {
  const verifier = new RunVerifier(app.kernel, app.catalog, app.workspaces,
    new CheckRunner(app.resources), app.paths, app.config);
  const verified = await verifier.verify(runId);
  assert.equal(verified.status, "PASSED");
  app.kernel.completeRun({ runId, treeHash: verified.treeHash }, actor);
  const report = await new DeliveryReporter(app.kernel, app.catalog, app.workspaces, app.paths).ensure(runId);
  return { verified, report };
}

const root = await mkdtemp(join(tmpdir(), "tripleteam-audit-"));
const previousStateDir = process.env.TRIPLETEAM_STATE_DIR;
process.env.TRIPLETEAM_STATE_DIR = join(root, "state");
try {
  {
    const { app, runId } = await localFixture(root, "fallback");
    try {
      const { report } = await finish(app, runId);
      assert.equal(app.config.runChecks[0].name, "integration-diff-safety");
      assert.equal(evidenceClassForCheck(app.config.runChecks[0]), "BEHAVIORAL");
      assert.equal(report.result, "VERIFIED_DELIVERY");
      observe("R1", { check: app.config.runChecks[0].argv, evidenceClass: "BEHAVIORAL", delivery: report.result });
    } finally { await app.close(); }
  }
  {
    const runChecks = [{ name: "behavior-test", lane: "LIGHT_CHECK", timeoutMs: 5000, evidenceClass: "BEHAVIORAL",
      argv: [process.execPath, "-e", "const fs=require('node:fs');fs.writeFileSync('value.txt','good\\n');if(fs.readFileSync('value.txt','utf8')!=='good\\n')process.exit(1)"] }];
    const { app, repo, runId } = await localFixture(root, "mutating-check", runChecks);
    try {
      const { report } = await finish(app, runId);
      const committedValue = await git(repo, ["show", report.finalCommit + ":value.txt"]);
      assert.equal(committedValue, "bad");
      assert.equal(report.result, "VERIFIED_DELIVERY");
      observe("R2", { delivery: report.result, testedValue: "good", deliveredValue: committedValue });
    } finally { await app.close(); }
  }
  {
    const { database, kernel, catalog } = await memory();
    try {
      const policy = new FailurePolicy(kernel, catalog, config);
      const diagnoses = ["task-a", "task-b", "task-c"].map((id) => {
        task(kernel, "run", id);
        return policy.diagnose({ runId: "run", taskId: id, phase: "CANDIDATE_VERIFY",
          classification: "VERIFICATION", detail: "Candidate verification failed", evidenceRefs: [id + "-different-assertion"] });
      });
      assert.deepEqual(diagnoses.map((d) => d.disposition), ["RETRY", "REPLAN", "BLOCK"]);
      observe("R3", { separateTasksFirstFailure: diagnoses.map(({ occurrence, disposition }) => ({ occurrence, disposition })) });
    } finally { database.close(); }
  }
  {
    const { database, kernel, catalog } = await memory();
    try {
      task(kernel, "run", "task"); attempt(kernel);
      const id = proposal(kernel, ["."], true);
      kernel.failAttempt({ attemptId: "attempt", reason: "refine", retryTask: true, actor });
      const result = new BoundedTaskProposalPolicy(kernel, catalog, config).process("run");
      assert.deepEqual(result.accepted, [id]);
      observe("R4", { sourceScope: ["src"], automaticallyAcceptedChildScope: catalog.listTasks("run").find((t) => t.id !== "task").scope });
    } finally { database.close(); }
  }
  {
    const { database, kernel, catalog } = await memory();
    try {
      task(kernel, "run", "task"); attempt(kernel);
      const id = proposal(kernel, ["other"], false);
      kernel.failAttempt({ attemptId: "attempt", reason: "need decision", retryTask: true, actor });
      const result = new BoundedTaskProposalPolicy(kernel, catalog, config).process("run");
      assert.equal(result.requiresUser.length, 1);
      kernel.blockRun("run", "Waiting for the proposal decision", actor);
      assert.throws(() => kernel.acceptTaskChanges(id, { kind: "USER", id: "audit" }), (e) => e.code === "STALE_TASK_PROPOSAL");
      observe("R5", { after: "proposal -> decision request -> blockRun -> user accepts", error: "STALE_TASK_PROPOSAL" });
    } finally { database.close(); }
  }
  {
    const { database, kernel, catalog } = await memory();
    try {
      task(kernel, "run", "task"); attempt(kernel);
      const id = kernel.createDecisionRequest({ runId: "run", taskId: "task", kind: "REQUIREMENT_CHOICE",
        question: "A or B?", options: ["A", "B"], sourceKind: "ATTEMPT", sourceId: "attempt",
        actor: { kind: "ATTEMPT", id: "attempt" } });
      kernel.failAttempt({ attemptId: "attempt", reason: "need choice", retryTask: false, actor });
      kernel.blockRun("run", "Waiting for choice", actor);
      // Invoke the actual application resolver without starting a daemon or model.
      const result = LocalOrchestrator.prototype.resolveDecision.call({ kernel, catalog }, id, "A", "Use A");
      assert.equal(result.mayContinue, false);
      assert.equal(catalog.getDecisionRequest(id).state, "DECIDED");
      assert.equal(catalog.getTask("task").state, "BLOCKED");
      assert.equal(catalog.listMessages({ runId: "run" }).length, 0);
      observe("R6", { selected: "A", request: "DECIDED", task: "BLOCKED", mayContinue: false, answerMessages: 0 });
    } finally { database.close(); }
  }
  {
    const { database, kernel, catalog } = await memory();
    try {
      task(kernel, "run", "task");
      kernel.recordTaskCoordination({ taskId: "task", assessment: {
        decomposability: "HIGH", sequentiality: "LOW", semanticCoupling: "LOW", integrationCost: "LOW",
        uncertainty: "HIGH", rationale: "Audit", evidenceRefs: [],
        explorationQuestions: [{ key: "design", hypothesis: "A", question: "Which design?" }],
      }, contract: { provides: [], requires: [], assumptions: [], ownedScope: ["src"], interfaces: [], evidenceRefs: [] }, actor });
      let calls = 0;
      const explorer = { explore: async () => { calls++; throw new Error("Transient exploration failure"); } };
      const coordinator = new AdaptiveExplorationCoordinator(kernel, catalog, explorer, config);
      await coordinator.explore("task");
      assert.equal(catalog.listExplorations("task")[0].state, "FAILED");
      await assert.rejects(() => coordinator.explore("task"), (e) => e.code === "DUPLICATE_EXPLORATION");
      assert.equal(calls, 1);
      observe("R7", { first: "FAILED", second: "DUPLICATE_EXPLORATION", actualExplorerCalls: calls });
    } finally { database.close(); }
  }
  process.stdout.write(JSON.stringify({ reviewedRevision: "4690901a390878593aa41e2fd25b98e8831b9578", observations }, null, 2) + "\n");
} finally {
  if (previousStateDir === undefined) delete process.env.TRIPLETEAM_STATE_DIR;
  else process.env.TRIPLETEAM_STATE_DIR = previousStateDir;
  await rm(root, { recursive: true, force: true });
}
