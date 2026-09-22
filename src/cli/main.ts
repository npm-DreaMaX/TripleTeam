#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { LocalOrchestrator } from "../app/orchestrator.ts";
import { AGENT_ROLES } from "../config/execution.ts";
import { projectPaths } from "../config/paths.ts";
import { loadProjectConfig } from "../config/project.ts";
import { ControlCatalog } from "../control/catalog.ts";
import { DaemonClient } from "../daemon/client.ts";
import { PiWorkerLauncher } from "../runtime/pi/launcher.ts";
import { resolvePiCliPath } from "../runtime/pi/rpc-worker.ts";
import { openControlDatabase } from "../store/database.ts";
import { resolveRepositoryRoot } from "../workspace/git.ts";
import { renderDashboard } from "./dashboard.ts";
import { readDashboard } from "./dashboard-data.ts";
import { showDashboard, withLiveDashboard } from "./monitor.ts";
import { type OutputOptions, parseOutputOptions, renderError, renderHelp, renderResult } from "./output.ts";

const execFileAsync = promisify(execFile);
let outputOptions: OutputOptions = parseOutputOptions([]);
let outputTitle = "Workspace";
let pendingOutput: string[] | null = null;
async function observed(
	repository: string | undefined,
	work: () => Promise<void>,
	input: { fresh?: boolean; runId?: string; label?: string } = {},
): Promise<void> {
	pendingOutput = [];
	try {
		await withLiveDashboard(outputOptions, repository, work, input);
	} finally {
		const values = pendingOutput;
		pendingOutput = null;
		for (const value of values) output(value);
	}
}

function output(value: string): void {
	if (pendingOutput) {
		pendingOutput.push(value);
		return;
	}
	if (outputOptions.json) {
		console.log(value);
		return;
	}
	try {
		console.log(renderResult(JSON.parse(value), outputTitle, outputOptions.color, process.stdout.columns || 100));
	} catch {
		console.log(value);
	}
}

function usage(): string {
	return [
		"Usage:",
		"  tripleteam                       Open the workspace dashboard",
		"  tripleteam demo                  Explore the UI without an API key",
		"  tripleteam dashboard [repository] [run-id]",
		"  tripleteam init [repository]",
		'  tripleteam run "<objective>" [repository]',
		"  tripleteam continue [repository] [run-id]",
		"  tripleteam retry <task-id> [repository]",
		'  tripleteam cancel "<reason>" [repository] [run-id]',
		"  tripleteam pause [repository]",
		"  tripleteam resume [repository]",
		"  tripleteam status [repository] [run-id]",
		"  tripleteam profiles [repository]",
		"  tripleteam models [filter]",
		"  tripleteam events [repository] [run-id]",
		"  tripleteam messages [repository] [run-id]",
		"  tripleteam proposals [repository] [run-id]",
		"  tripleteam decisions [repository] [run-id]",
		"  tripleteam artifacts [repository] [run-id]",
		"  tripleteam result [repository] [run-id]",
		'  tripleteam message <attempt-id> "<body>" [repository]',
		"  tripleteam proposal accept <proposal-id> [repository]",
		'  tripleteam proposal reject <proposal-id> "<reason>" [repository]',
		'  tripleteam decision <request-id> <option> "<rationale>" [repository]',
		"  tripleteam doctor",
		"",
		"Output:",
		"  --json    Structured output for scripts (automatic when piped)",
		"  --plain   Human-readable output without color or live redraw",
		"  --watch   Live dashboard for status; close with q",
		"  NO_COLOR  Disable color while keeping the interactive dashboard",
		"",
		"Commands:",
		"  init     Freeze the current repository state and create an authoritative run",
		"  run      Plan and execute a coding objective through evidence-gated acceptance",
		"  continue Reconcile interrupted state and continue an open run",
		"  retry    Explicitly reopen one blocked task and continue its run",
		"  cancel   Fence live Attempts, abort reachable Pi workers, and record a terminal report",
		"  pause    Pause new daemon work without killing active processes",
		"  resume   Resume daemon resource dispatch",
		"  status   Show a run and its authoritative task states",
		"  profiles Show built-in and trusted user/project Pi Agent profiles",
		"  models   List registered model IDs and configured authentication, without inference",
		"  events   Show the append-only domain event trail",
		"  messages Show typed durable messages without treating them as truth",
		"  proposals Show pending and decided task-graph changes",
		"  decisions Show open Human-on-Exception requests",
		"  artifacts Show content-addressed verification artifacts",
		"  result   Materialize and show the terminal delivery or blocked report",
		"  message  Persist a user message and deliver it to the live Pi session when available",
		"  proposal Explicitly accept or reject a proposed task-graph change",
		"  decision Record an explicit choice for a first-class decision request",
		"  doctor   Verify Git, Pi and SQLite runtime dependencies",
	].join("\n");
}

async function init(repositoryArgument?: string): Promise<void> {
	const orchestrator = await LocalOrchestrator.open(repositoryArgument ?? process.cwd());
	try {
		output(JSON.stringify(await orchestrator.initialize(), null, 2));
	} finally {
		orchestrator.close();
	}
}

async function run(objective: string | undefined, repositoryArgument?: string): Promise<void> {
	if (!objective) throw new Error("run requires a quoted coding objective");
	const repository = repositoryArgument ?? process.cwd();
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.run(objective), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		output(JSON.stringify(await orchestrator.run(objective), null, 2));
	} finally {
		orchestrator.close();
	}
}

async function continueRun(repositoryArgument?: string, runId?: string): Promise<void> {
	const repository = repositoryArgument ?? process.cwd();
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.continue(runId ?? (await latestRunId(repository))), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		output(JSON.stringify(await orchestrator.continue(runId), null, 2));
	} finally {
		orchestrator.close();
	}
}

async function latestRunId(repositoryArgument?: string): Promise<string> {
	const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryArgument ?? process.cwd()));
	const database = await openControlDatabase(projectPaths(repositoryRoot).database);
	try {
		const run = new ControlCatalog(database).latestRun();
		if (!run) throw new Error("No run exists for this repository");
		return run.id;
	} finally {
		database.close();
	}
}

async function retry(taskId: string | undefined, repositoryArgument?: string): Promise<void> {
	if (!taskId) throw new Error("retry requires a task id");
	const repository = repositoryArgument ?? process.cwd();
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.retry(taskId), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		output(JSON.stringify(await orchestrator.retry(taskId), null, 2));
	} finally {
		orchestrator.close();
	}
}

async function cancel(reason: string | undefined, repositoryArgument?: string, runId?: string): Promise<void> {
	if (!reason?.trim()) throw new Error("cancel requires a non-empty quoted reason");
	const repository = repositoryArgument ?? process.cwd();
	const selectedRunId = runId ?? (await latestRunId(repository));
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.cancel(selectedRunId, reason), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		const cancellation = await orchestrator.cancel(selectedRunId, reason);
		output(JSON.stringify({ cancellation, delivery: await orchestrator.result(selectedRunId) }, null, 2));
	} finally {
		orchestrator.close();
	}
}

async function control(command: "pause" | "resume", repositoryArgument?: string): Promise<void> {
	const daemon = await DaemonClient.discover(repositoryArgument ?? process.cwd());
	if (!daemon) throw new Error("No live control daemon exists for this repository");
	output(JSON.stringify(command === "pause" ? await daemon.pause() : await daemon.resume(), null, 2));
}

async function status(repositoryArgument?: string, runId?: string): Promise<void> {
	if (outputOptions.watch) {
		await showDashboard(outputOptions, repositoryArgument, runId);
		return;
	}
	if (!outputOptions.json) {
		const root = await resolveRepositoryRoot(resolve(repositoryArgument ?? process.cwd()));
		const snapshot = await readDashboard(root, runId);
		console.log(
			renderDashboard(snapshot, { width: process.stdout.columns || 100, height: 30, color: outputOptions.color }).join(
				"\n",
			),
		);
		return;
	}
	const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryArgument ?? process.cwd()));
	const paths = projectPaths(repositoryRoot);
	const database = await openControlDatabase(paths.database);
	try {
		const selected =
			runId === undefined
				? database.sql
						.prepare(
							"SELECT id, state, terminal_reason, input_commit, integration_head, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT 1",
						)
						.get<Record<string, unknown>>()
				: database.sql
						.prepare(
							"SELECT id, state, terminal_reason, input_commit, integration_head, created_at, updated_at FROM runs WHERE id = ?",
						)
						.get<Record<string, unknown>>(runId);
		if (!selected || typeof selected.id !== "string") {
			throw new Error("No matching run exists for this repository");
		}
		const tasks = database.sql
			.prepare(
				"SELECT id, state, priority, risk_class, active_attempt_id, attempt_epoch, version FROM tasks WHERE run_id = ? ORDER BY priority DESC, created_at",
			)
			.all<Record<string, unknown>>(selected.id);
		output(JSON.stringify({ run: selected, tasks }, null, 2));
	} finally {
		database.close();
	}
}

async function profiles(repositoryArgument?: string): Promise<void> {
	const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryArgument ?? process.cwd()));
	const config = await loadProjectConfig(repositoryRoot);
	const launcher = new PiWorkerLauncher();
	const roles = AGENT_ROLES.map((role) => {
		const profile = launcher.resolveProfile(repositoryRoot, config.profiles[role], [], config.execution, role);
		return {
			role,
			profile: profile.name,
			provider: profile.provider ?? "Pi default",
			model: profile.model ?? "Pi default",
			reasoning: profile.reasoning ?? "Pi default",
		};
	});
	output(JSON.stringify({ roles, profiles: launcher.listProfiles(repositoryRoot) }, null, 2));
}

async function models(filter?: string): Promise<void> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
	if (runtime.getError()) throw new Error(runtime.getError());
	const needle = (filter ?? "").toLowerCase();
	const registered = runtime
		.getModels()
		.filter((model) => `${model.provider} ${model.id}`.toLowerCase().includes(needle))
		.map((model) => ({
			provider: model.provider,
			model: model.id,
			api: model.api,
			reasoning: model.reasoning,
			authConfigured: runtime.hasConfiguredAuth(model.provider),
		}))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
	output(
		JSON.stringify(
			{
				configuration: getAgentDir(),
				note: "Local registry only; authentication presence does not test API connectivity.",
				models: registered,
			},
			null,
			2,
		),
	);
}

async function collection(
	name: "events" | "messages" | "proposals" | "decisions" | "artifacts",
	repositoryArgument?: string,
	runId?: string,
): Promise<void> {
	const repositoryRoot = await resolveRepositoryRoot(resolve(repositoryArgument ?? process.cwd()));
	const selectedRunId = runId ?? (await latestRunId(repositoryRoot));
	const daemon = await DaemonClient.discover(repositoryRoot);
	if (daemon) {
		output(JSON.stringify(await daemon.collection(selectedRunId, name), null, 2));
		return;
	}
	const database = await openControlDatabase(projectPaths(repositoryRoot).database);
	try {
		const catalog = new ControlCatalog(database);
		catalog.getRun(selectedRunId);
		const value =
			name === "events"
				? catalog.listEvents(selectedRunId)
				: name === "messages"
					? catalog.listMessages({ runId: selectedRunId })
					: name === "proposals"
						? catalog.listTaskChangeProposals(selectedRunId)
						: name === "decisions"
							? catalog.listOpenDecisionRequests(selectedRunId)
							: catalog.listArtifacts(selectedRunId);
		output(JSON.stringify({ [name]: value }, null, 2));
	} finally {
		database.close();
	}
}

async function decideRequest(
	requestId: string | undefined,
	selectedOption: string | undefined,
	rationale: string | undefined,
	repositoryArgument?: string,
): Promise<void> {
	if (!requestId || !selectedOption || !rationale?.trim()) {
		throw new Error("decision requires a request id, option, and non-empty quoted rationale");
	}
	const repository = repositoryArgument ?? process.cwd();
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.resolveDecision(requestId, selectedOption, rationale), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		const resolution = orchestrator.resolveDecision(requestId, selectedOption, rationale);
		output(
			JSON.stringify(
				resolution.mayContinue
					? { resolution, continuation: await orchestrator.continue(resolution.runId) }
					: { resolution },
				null,
				2,
			),
		);
	} finally {
		orchestrator.close();
	}
}

async function decideProposal(
	decision: string | undefined,
	proposalId: string | undefined,
	reasonOrRepository?: string,
	repositoryAfterReason?: string,
): Promise<void> {
	if (!proposalId || (decision !== "accept" && decision !== "reject")) {
		throw new Error("proposal requires accept|reject and a proposal id");
	}
	const reason = decision === "reject" ? reasonOrRepository : undefined;
	if (decision === "reject" && !reason?.trim()) throw new Error("proposal reject requires a non-empty reason");
	const repository =
		decision === "accept" ? (reasonOrRepository ?? process.cwd()) : (repositoryAfterReason ?? process.cwd());
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(
			JSON.stringify(
				decision === "accept"
					? await daemon.acceptProposal(proposalId)
					: await daemon.rejectProposal(proposalId, reason as string),
				null,
				2,
			),
		);
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		const runId = orchestrator.catalog.getTaskChangeProposal(proposalId).runId;
		if (decision === "accept") {
			const addedTasks = Object.fromEntries(orchestrator.acceptTaskProposal(proposalId));
			output(JSON.stringify({ addedTasks, continuation: await orchestrator.continue(runId) }, null, 2));
		} else {
			orchestrator.rejectTaskProposal(proposalId, reason as string);
			output(
				JSON.stringify({ proposalId, state: "REJECTED", continuation: await orchestrator.continue(runId) }, null, 2),
			);
		}
	} finally {
		orchestrator.close();
	}
}

async function result(repositoryArgument?: string, runId?: string): Promise<void> {
	const repository = repositoryArgument ?? process.cwd();
	const selectedRunId = runId ?? (await latestRunId(repository));
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.result(selectedRunId), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		output(JSON.stringify({ delivery: await orchestrator.result(selectedRunId) }, null, 2));
	} finally {
		orchestrator.close();
	}
}

async function message(
	attemptId: string | undefined,
	body: string | undefined,
	repositoryArgument?: string,
): Promise<void> {
	if (!attemptId || !body?.trim()) throw new Error("message requires an attempt id and a non-empty quoted body");
	const repository = repositoryArgument ?? process.cwd();
	const daemon = await DaemonClient.discover(repository);
	if (daemon) {
		output(JSON.stringify(await daemon.message(attemptId, body), null, 2));
		return;
	}
	const orchestrator = await LocalOrchestrator.open(repository);
	try {
		output(JSON.stringify(await orchestrator.sendUserMessage(attemptId, body), null, 2));
	} finally {
		orchestrator.close();
	}
}

async function doctor(): Promise<void> {
	const git = await execFileAsync("git", ["--version"], { encoding: "utf8" });
	const piCli = resolvePiCliPath();
	await access(piCli);
	const database = await openControlDatabase(":memory:");
	database.close();
	output(
		JSON.stringify(
			{
				node: process.version,
				git: git.stdout.trim(),
				piCli,
				sqlite: "ok",
			},
			null,
			2,
		),
	);
}

async function main(argv: string[]): Promise<void> {
	outputOptions = parseOutputOptions(argv);
	const [command, ...args] = outputOptions.args;
	outputTitle = command ?? "Workspace";
	if (outputOptions.watch && command !== "status" && command !== "dashboard")
		throw new Error("--watch is available for status and dashboard");
	switch (command) {
		case "dashboard":
			await showDashboard(outputOptions, args[0], args[1]);
			return;
		case "demo":
			await showDashboard(outputOptions, undefined, undefined, true);
			return;
		case "init":
			await init(args[0]);
			return;
		case "run":
			await observed(args[1], () => run(args[0], args[1]), { fresh: true, label: args[0] });
			return;
		case "continue":
			await observed(args[0], () => continueRun(args[0], args[1]), { runId: args[1] });
			return;
		case "retry":
			await observed(args[1], () => retry(args[0], args[1]));
			return;
		case "cancel":
			await cancel(args[0], args[1], args[2]);
			return;
		case "pause":
			await control("pause", args[0]);
			return;
		case "resume":
			await control("resume", args[0]);
			return;
		case "status":
			await status(args[0], args[1]);
			return;
		case "profiles":
			await profiles(args[0]);
			return;
		case "models":
			await models(args[0]);
			return;
		case "events":
		case "messages":
		case "proposals":
		case "decisions":
		case "artifacts":
			await collection(command, args[0], args[1]);
			return;
		case "result":
			await result(args[0], args[1]);
			return;
		case "message":
			await message(args[0], args[1], args[2]);
			return;
		case "proposal":
			await decideProposal(args[0], args[1], args[2], args[3]);
			return;
		case "decision":
			await decideRequest(args[0], args[1], args[2], args[3]);
			return;
		case "doctor":
			await doctor();
			return;
		case undefined:
			if (process.stdout.isTTY && process.stdin.isTTY && !outputOptions.json && !outputOptions.plain) {
				await showDashboard(outputOptions);
				return;
			}
			console.log(renderHelp(usage(), outputOptions.color));
			return;
		case "help":
		case "--help":
		case "-h":
			console.log(renderHelp(usage(), outputOptions.color));
			return;
		default:
			throw new Error("Unknown command: " + command + "\n\n" + usage());
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(renderError(error, outputOptions.color));
	process.exitCode = 1;
});
