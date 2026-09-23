import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createNodeSqliteFactory } from "@earendil-works/pi-session-backend-sqlite-node";
import { LocalOrchestrator } from "../app/orchestrator.ts";
import { AGENT_ROLES, type AgentRole } from "../config/execution.ts";
import { projectPaths } from "../config/paths.ts";
import { loadProjectConfig } from "../config/project.ts";
import {
	loadSettings,
	parseSettingValue,
	resetSetting,
	type SettingDefinition,
	type SettingsSnapshot,
	updateSetting,
} from "../config/settings.ts";
import { ControlCatalog } from "../control/catalog.ts";
import { DaemonClient } from "../daemon/client.ts";
import { PiWorkerLauncher } from "../runtime/pi/launcher.ts";
import { resolvePiCliPath } from "../runtime/pi/rpc-worker.ts";
import { checkPiSearchTools } from "../runtime/pi/tool-preflight.ts";
import { readDashboard } from "./dashboard-data.ts";
import type { ShellBackend, ShellDocument, ShellLine, ShellReply, ShellRequest } from "./shell-commands.ts";
import { explanationDocument, readableState, tasksDocument } from "./shell-view.ts";
import { clean } from "./theme.ts";

const execFileAsync = promisify(execFile);
const settingNotice = "Saved for the next run. Existing runs keep their frozen models, budgets and checks.";

function valueAt(object: unknown, key: string): unknown {
	return key
		.split(".")
		.reduce<unknown>(
			(value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined),
			object,
		);
}

function settingSummary(value: unknown): string {
	if (value === undefined || value === null) return "default";
	if (Array.isArray(value))
		return value.every((item) => typeof item === "string")
			? value.join(", ") || "none"
			: `${value.length} configured entries`;
	if (typeof value === "object") {
		const selection = value as { provider?: unknown; model?: unknown; reasoning?: unknown };
		if (typeof selection.model === "string")
			return [selection.provider, selection.model, selection.reasoning].filter(Boolean).join(" / ");
		return "configured object";
	}
	return String(value);
}

export function settingsDocument(settings: SettingsSnapshot, key?: string): ShellDocument {
	const lines: ShellLine[] = [
		{ text: "Changes apply to new runs. Existing runs keep their frozen configuration.", tone: "muted" },
		{ text: "" },
	];
	if (!key) {
		for (const [label, path] of [
			["Strategy", "execution.policy"],
			["Parallel writers", "execution.maxParallelism"],
			["Token budget", "execution.tokenLimit"],
			["Cost budget (USD)", "execution.costLimitUsd"],
			["Verification", "assurance.mode"],
		])
			lines.push({ text: `${label}  ${settingSummary(valueAt(settings.values, path as string))}` });
		lines.push({ text: "Models  /models", tone: "muted" }, { text: "" }, { text: "Browse a group", tone: "accent" });
		for (const group of settings.groups) lines.push({ text: `/settings ${group.id}  ${group.title}` });
		lines.push(
			{ text: "" },
			{ text: "/settings all · /settings <key> <value> · /settings reset <key>", tone: "muted" },
		);
		return { title: "Settings for the next run", lines };
	}
	let matched = false;
	for (const group of settings.groups) {
		const entries: SettingDefinition[] = group.settings.filter(
			(entry) => key === "all" || entry.key === key || group.id === key || entry.key.startsWith(key + "."),
		);
		if (!entries.length) continue;
		matched = true;
		lines.push({ text: group.title, tone: "accent" });
		for (const entry of entries) {
			const value = valueAt(settings.values, entry.key);
			lines.push({ text: `${entry.key}  ${settingSummary(value)}` });
			if (key === entry.key) {
				lines.push({ text: entry.description, tone: "muted" });
				if (entry.choices) lines.push({ text: `Choices: ${entry.choices.join(", ")}`, tone: "muted" });
				if (value && typeof value === "object")
					lines.push(
						{ text: "" },
						...JSON.stringify(value, null, 2)
							.split("\n")
							.map((text) => ({ text })),
					);
			}
		}
		lines.push({ text: "" });
	}
	if (!matched) throw new Error("Setting not found. Use /settings to browse the available keys.");
	lines.push({ text: "/settings <key> <value> · /settings reset <key>", tone: "muted" });
	lines.push({ text: "Values accept numbers, booleans, strings or JSON. Checks use JSON arrays.", tone: "muted" });
	return { title: key ? `Settings · ${key}` : "Settings for the next run", lines };
}

function outcome(value: unknown): string {
	const object = value as { state?: string; result?: { state?: string }; delivery?: { result?: string } } | null;
	return object?.delivery?.result
		? `${readableState(object.delivery.result)}. Use /delivery for details.`
		: object?.state || object?.result?.state
			? `${readableState(object.state ?? object.result?.state ?? "")}. Use /status for progress.`
			: "Request completed. Use /status to inspect the workspace.";
}

/** Calls the existing control plane directly. It never evaluates shell command text. */
export class WorkspaceShellBackend implements ShellBackend {
	private selectedRunId: string | undefined;
	private local: LocalOrchestrator | undefined;
	private opening: Promise<LocalOrchestrator> | undefined;
	private executionMayBeLocal = false;
	constructor(readonly repository: string) {}
	localWorkActive(): boolean {
		return Boolean(this.local || this.opening || this.executionMayBeLocal);
	}
	snapshot() {
		return readDashboard(this.repository, this.selectedRunId);
	}
	private async runId(): Promise<string> {
		const id = (await this.snapshot()).run?.id;
		if (!id) throw new Error("No saved run. Type an objective to start one.");
		return id;
	}
	private async withLocal<T>(work: (orchestrator: LocalOrchestrator) => Promise<T> | T): Promise<T> {
		if (this.local) return work(this.local);
		if (this.opening) return work(await this.opening);
		this.opening = LocalOrchestrator.open(this.repository);
		try {
			this.local = await this.opening;
			return await work(this.local);
		} finally {
			this.local?.close();
			this.local = undefined;
			this.opening = undefined;
		}
	}
	private async catalog<T>(read: (catalog: ControlCatalog) => T): Promise<T> {
		const path = projectPaths(this.repository).database;
		const sql = await createNodeSqliteFactory().openReadOnly(path);
		try {
			return read(new ControlCatalog({ sql, path, close: () => sql.close() }));
		} finally {
			sql.close();
		}
	}
	async execute(request: ShellRequest): Promise<ShellReply> {
		const execution = ["new", "continue", "retry", "decision", "proposal", "init"].includes(request.name);
		if (execution) this.executionMayBeLocal = true;
		try {
			return await this.perform(request);
		} finally {
			if (execution) this.executionMayBeLocal = false;
		}
	}
	private async perform(request: ShellRequest): Promise<ShellReply> {
		const { name, args } = request;
		if (name === "why") return { document: explanationDocument(await this.snapshot()) };
		if (name === "status") {
			if (args[0]) this.selectedRunId = args[0];
			await this.snapshot();
			return { overview: true };
		}
		if (name === "tasks") {
			const snapshot = await this.snapshot();
			const document = tasksDocument(snapshot, args[0]);
			if (args[0]) {
				const task = snapshot.tasks.find((task, index) => String(index + 1) === args[0] || task.id === args[0]);
				if (task) {
					const attempt = await this.catalog((catalog) => catalog.getTask(task.id).activeAttemptId);
					if (attempt) document.lines.push({ text: `Active attempt  ${attempt}`, tone: "muted" });
				}
			}
			return { document };
		}
		if (name === "settings") {
			if (args[0] === "reset") {
				if (!args[1]) throw new Error("Use /settings reset <key>.");
				return { document: settingsDocument(await resetSetting(this.repository, args[1])), notice: settingNotice };
			}
			if (args[0] && args[1] !== undefined)
				return {
					document: settingsDocument(
						await updateSetting(this.repository, args[0], parseSettingValue(args[1])),
						args[0],
					),
					notice: settingNotice,
				};
			return { document: settingsDocument(await loadSettings(this.repository), args[0]) };
		}
		if (name === "model") {
			if (!args.length) return this.profiles();
			const [role, model, reasoning] = args;
			if (role !== "all" && !AGENT_ROLES.includes(role as AgentRole))
				throw new Error(`Choose a role: ${AGENT_ROLES.join(", ")}, or all.`);
			if (!model) throw new Error("Use /model <role> <provider>/<model> [reasoning]. Find IDs with /models.");
			if (model === "default")
				return {
					document: settingsDocument(
						await resetSetting(this.repository, role === "all" ? "execution.roles" : `execution.roles.${role}`),
						"execution",
					),
					notice: settingNotice,
				};
			const slash = model.indexOf("/");
			if (slash < 1 || slash === model.length - 1)
				throw new Error(
					"Include both provider and model, for example provider/model. Use /models to inspect registered IDs.",
				);
			const selected = {
				provider: model.slice(0, slash),
				model: model.slice(slash + 1),
				...(reasoning ? { reasoning } : {}),
			};
			if (role === "all") {
				await updateSetting(
					this.repository,
					"execution.roles",
					Object.fromEntries(AGENT_ROLES.map((item) => [item, selected])),
				);
			} else await updateSetting(this.repository, `execution.roles.${role}`, selected);
			return { ...(await this.profiles()), notice: settingNotice };
		}
		if (name === "profiles") return this.profiles(true);
		if (name === "models") {
			if (!args.length) return this.profiles();
			const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
			if (runtime.getError()) throw new Error(runtime.getError());
			const filter = args.join(" ").toLowerCase();
			const models = runtime
				.getModels()
				.filter((model) => `${model.provider} ${model.id}`.toLowerCase().includes(filter));
			return {
				document: {
					title: "Models",
					lines: [
						{ text: "Use /models <filter>, then /model <role> <provider>/<model> [reasoning].", tone: "muted" },
						{ text: "Local registry; authentication presence does not test connectivity.", tone: "muted" },
						{ text: "" },
						...models.map((model) => ({
							text: `${model.provider}/${model.id}  ${runtime.hasConfiguredAuth(model.provider) ? "auth configured" : "auth needed"}`,
						})),
						...(models.length
							? []
							: [{ text: "No matching models. Configure providers in Pi's model registry.", tone: "muted" as const }]),
						{ text: "" },
						{ text: `Provider configuration: ${getAgentDir()}`, tone: "muted" },
					],
				},
			};
		}
		if (name === "doctor") {
			const git = await execFileAsync("git", ["--version"], { encoding: "utf8" });
			await access(resolvePiCliPath());
			const tools = await checkPiSearchTools(["grep", "find"]);
			return {
				document: {
					title: "Installation",
					lines: [
						{ text: `Node  ${process.version}` },
						{ text: git.stdout.trim() },
						{ text: "Pi  available" },
						{ text: `Search tools  ${Object.keys(tools).join(", ") || "ready"}` },
					],
				},
			};
		}
		if (name === "events") {
			const snapshot = await this.snapshot();
			return {
				document: {
					title: "Recent activity",
					lines: snapshot.events.length
						? snapshot.events.flatMap((event) => [
								{ text: `${event.time.slice(11, 19)}  ${event.type}` },
								{ text: event.detail, tone: "muted" as const },
							])
						: [{ text: "No activity yet.", tone: "muted" }],
				},
			};
		}
		if (name === "decisions") {
			const snapshot = await this.snapshot();
			return {
				document: {
					title: "Your decisions",
					lines: snapshot.decisions.length
						? snapshot.decisions.flatMap((decision, index) => [
								{ text: `${index + 1}. ${decision.question}`, tone: "accent" as const },
								...decision.options.map((option, optionIndex) => ({ text: `   ${optionIndex + 1}. ${option}` })),
								{ text: `/decision ${index + 1} <option-number> "reason"`, tone: "muted" as const },
								{ text: "" },
							])
						: [{ text: "No decisions waiting for you.", tone: "muted" }],
				},
			};
		}
		const daemon = await DaemonClient.discover(this.repository);
		if (daemon && name !== "init" && ["new", "continue", "retry", "decision", "proposal"].includes(name))
			this.executionMayBeLocal = false;
		if (name === "new") {
			if (!args[0]?.trim()) throw new Error("Describe the goal you want to start.");
			this.selectedRunId = undefined;
			const value = daemon
				? await daemon.run(args[0])
				: await this.withLocal((orchestrator) => orchestrator.run(args[0] as string));
			return { overview: true, notice: outcome(value) };
		}
		if (name === "init") {
			const initialized = await this.withLocal((orchestrator) => orchestrator.initialize());
			this.selectedRunId = initialized.runId;
			return { overview: true, notice: "Repository snapshot saved. Type an objective to start a new run." };
		}
		if (name === "continue") {
			if (args[0]) this.selectedRunId = args[0];
			const value = daemon
				? await daemon.continue(this.selectedRunId ?? (await this.runId()))
				: await this.withLocal((orchestrator) => orchestrator.continue(this.selectedRunId));
			return { overview: true, notice: outcome(value) };
		}
		if (name === "pause" || name === "resume") {
			if (daemon) await (name === "pause" ? daemon.pause() : daemon.resume());
			else {
				const local = this.local ?? (this.opening ? await this.opening : undefined);
				if (!local) throw new Error("No work is running in this shell. Use /continue to resume a saved run.");
				if (name === "pause") local.resources.pause();
				else local.resources.resume();
			}
			return {
				notice:
					name === "pause"
						? "New dispatch paused. Active work continues. /resume to continue dispatch."
						: "Dispatch resumed.",
			};
		}
		if (name === "cancel") {
			if (!args[0]?.trim()) throw new Error("Use /cancel <reason> to end the selected run.");
			const id = await this.runId();
			if (daemon) await daemon.cancel(id, args[0]);
			else await this.withLocal((orchestrator) => orchestrator.cancel(id, args[0] as string));
			return { overview: true, notice: "Run cancelled. /delivery shows the recorded result." };
		}
		if (name === "retry") {
			const task = (await this.snapshot()).tasks.find(
				(task, index) => task.id === args[0] || String(index + 1) === args[0],
			);
			if (!task) throw new Error("Use /tasks, then /retry <task-number-or-id>.");
			const value = daemon
				? await daemon.retry(task.id)
				: await this.withLocal((orchestrator) => orchestrator.retry(task.id));
			return { overview: true, notice: outcome(value) };
		}
		if (name === "decision") {
			const request = (await this.snapshot()).decisions.find(
				(item, index) => item.id === args[0] || String(index + 1) === args[0],
			);
			if (!request || !args[1] || !args[2]?.trim())
				throw new Error('Use /decisions, then /decision <number> <option-number> "reason".');
			const option = request.options[Number(args[1]) - 1] ?? args[1];
			const value = daemon
				? await daemon.resolveDecision(request.id, option, args[2])
				: await this.withLocal(async (orchestrator) => {
						const resolution = orchestrator.resolveDecision(request.id, option, args[2] as string);
						return resolution.mayContinue ? orchestrator.continue(resolution.runId) : resolution;
					});
			return { overview: true, notice: outcome(value) };
		}
		if (name === "delivery") {
			const snapshot = await this.snapshot();
			if (!snapshot.run || snapshot.run.state === "OPEN")
				return {
					document: {
						title: "Delivery",
						lines: [{ text: "No terminal delivery yet. /status shows the current progress.", tone: "muted" }],
					},
				};
			if (daemon) await daemon.result(snapshot.run.id);
			else await this.withLocal((orchestrator) => orchestrator.result(snapshot.run?.id));
			const current = await this.snapshot();
			const delivery = current.delivery;
			return {
				document: {
					title: delivery ? readableState(delivery.result) : "Delivery",
					lines: delivery
						? [
								...(delivery.ref
									? [{ text: `Git ref  ${delivery.ref}` }]
									: [
											{ text: current.run?.reason || "No deliverable ref was produced." },
											{
												text:
													current.run?.state === "CANCELLED"
														? "Use /new to start another goal."
														: "Use /tasks to inspect the blocker, then /continue to recover.",
												tone: "muted" as const,
											},
											{ text: "" },
										]),
								{ text: `Tree  ${delivery.tree}` },
								{ text: `Evidence  ${delivery.manifest}` },
								{ text: "" },
								...(delivery.ref
									? [{ text: "Review the delivery ref in your usual Git workflow.", tone: "muted" as const }]
									: []),
							]
						: [{ text: "No report is available yet.", tone: "muted" }],
				},
			};
		}
		if (name === "message") {
			if (!args[0] || !args[1]?.trim())
				throw new Error('Use /message <attempt-id> "body". /tasks <number> shows the active attempt.');
			if (daemon) await daemon.message(args[0], args[1]);
			else await this.withLocal((orchestrator) => orchestrator.sendUserMessage(args[0] as string, args[1] as string));
			return { notice: "Message recorded and offered to the live attempt." };
		}
		if (name === "proposal") {
			if (!args[1] || !["accept", "reject"].includes(args[0] ?? "") || (args[0] === "reject" && !args[2]?.trim()))
				throw new Error('Use /proposal accept <id> or /proposal reject <id> "reason".');
			if (daemon)
				await (args[0] === "accept"
					? daemon.acceptProposal(args[1])
					: daemon.rejectProposal(args[1], args[2] as string));
			else
				await this.withLocal(async (orchestrator) => {
					const id = orchestrator.catalog.getTaskChangeProposal(args[1] as string).runId;
					if (args[0] === "accept") orchestrator.acceptTaskProposal(args[1] as string);
					else orchestrator.rejectTaskProposal(args[1] as string, args[2] as string);
					return orchestrator.continue(id);
				});
			return { overview: true, notice: "Proposal decision recorded." };
		}
		const id = await this.runId();
		if (["messages", "proposals", "artifacts"].includes(name)) {
			const records = await this.catalog((catalog) =>
				name === "messages"
					? catalog.listMessages({ runId: id })
					: name === "proposals"
						? catalog.listTaskChangeProposals(id)
						: catalog.listArtifacts(id),
			);
			const lines: ShellLine[] = records.flatMap((item) => {
				const record = item as unknown as Record<string, unknown>;
				return [
					{ text: clean(record.kind ?? record.state ?? record.type ?? name), tone: "accent" as const },
					{
						text: clean(
							record.body ??
								record.question ??
								record.storageLocator ??
								record.path ??
								record.summary ??
								(record.proposal ? JSON.stringify(record.proposal) : ""),
						),
					},
					{ text: `ID  ${clean(record.id)}`, tone: "muted" as const },
					{ text: "" },
				];
			});
			return {
				document: {
					title: name[0]?.toUpperCase() + name.slice(1),
					lines: lines.length ? lines : [{ text: "Nothing recorded yet.", tone: "muted" }],
				},
			};
		}
		throw new Error(`Unsupported command /${name}.`);
	}
	private async profiles(detail = false): Promise<ShellReply> {
		const config = await loadProjectConfig(this.repository);
		const launcher = new PiWorkerLauncher();
		return {
			document: {
				title: detail ? "Profiles for the next run" : "Models for the next run",
				lines: [
					{ text: "Saved role selections. Existing runs keep their frozen models.", tone: "muted" },
					{ text: "" },
					...AGENT_ROLES.map((role) => {
						const profile = launcher.resolveProfile(
							this.repository,
							config.profiles[role] ?? role,
							[],
							config.execution,
							role,
						);
						return {
							text: `${role}  ${profile.provider ?? "Pi"}/${profile.model ?? "default"} · ${profile.reasoning ?? "default"} reasoning`,
						};
					}),
					{ text: "" },
					{ text: "/model <role|all> <provider>/<model> [reasoning]", tone: "muted" },
					{ text: "/model <role> default restores inheritance. /models <filter> finds model IDs.", tone: "muted" },
					...(detail
						? [
								{ text: "" },
								{ text: "Assigned profiles", tone: "accent" as const },
								...AGENT_ROLES.map((role) => ({ text: `${role}  ${config.profiles[role] ?? role}` })),
								{ text: "" },
								{ text: "Available profiles", tone: "accent" as const },
								...launcher
									.listProfiles(this.repository)
									.flatMap((profile) => [
										{ text: `${profile.name}  ${profile.description}` },
										{ text: `${profile.source} · ${profile.tools.join(", ") || "no tools"}`, tone: "muted" as const },
									]),
								{ text: "" },
								{ text: "/settings profiles.<role> <profile-name> changes the next run.", tone: "muted" as const },
							]
						: []),
				],
			},
		};
	}
}
