import type { DashboardSnapshot } from "./dashboard-data.ts";

export const SHELL_COMMANDS = [
	{ name: "new", args: "[objective]", group: "Work", description: "Start a new goal" },
	{ name: "continue", args: "[run-id]", group: "Work", description: "Recover and continue a saved run" },
	{ name: "status", args: "[run-id]", group: "Work", description: "Show progress and the next action" },
	{ name: "tasks", args: "[number]", group: "Work", description: "List tasks or inspect one" },
	{ name: "why", args: "", group: "Work", description: "Explain scheduling, compute allocation and remaining checks" },
	{ name: "delivery", args: "", group: "Work", description: "Show the Git delivery and evidence" },
	{ name: "pause", args: "", group: "Control", description: "Pause new dispatch; active work continues" },
	{ name: "resume", args: "", group: "Control", description: "Resume paused dispatch" },
	{ name: "cancel", args: "reason", group: "Control", description: "End the selected run" },
	{ name: "retry", args: "task-number-or-id", group: "Control", description: "Retry a blocked task" },
	{ name: "decisions", args: "", group: "Control", description: "Show choices that need your input" },
	{ name: "decision", args: 'number option "reason"', group: "Control", description: "Answer a pending decision" },
	{ name: "models", args: "[filter]", group: "Configure", description: "Find models in the local Pi registry" },
	{
		name: "model",
		args: "role provider/model [reasoning]",
		group: "Configure",
		description: "Choose a model for the next run",
	},
	{ name: "settings", args: "[key [value]]", group: "Configure", description: "Browse or change next-run settings" },
	{ name: "profiles", args: "", group: "Configure", description: "Inspect role and profile selection" },
	{ name: "doctor", args: "", group: "Configure", description: "Check local dependencies" },
	{ name: "events", args: "", group: "Inspect", description: "Inspect the recorded event history" },
	{ name: "diagnostics", args: "", group: "Inspect", description: "Read local subprocess diagnostics" },
	{ name: "messages", args: "", group: "Inspect", description: "Read coordination messages" },
	{ name: "message", args: 'attempt-id "body"', group: "Inspect", description: "Send direction to a live attempt" },
	{ name: "proposals", args: "", group: "Inspect", description: "Inspect task changes" },
	{
		name: "proposal",
		args: 'accept|reject id ["reason"]',
		group: "Inspect",
		description: "Decide a proposed task change",
	},
	{ name: "artifacts", args: "", group: "Inspect", description: "List verification artifacts" },
	{ name: "init", args: "", group: "Inspect", description: "Snapshot this repository without starting work" },
	{ name: "help", args: "[group or command]", group: "Session", description: "Show commands and examples" },
	{ name: "quit", args: "", group: "Session", description: "Close this interface" },
] as const;

export interface ShellRequest {
	name: string;
	args: string[];
	text: string;
}
export interface ShellLine {
	text: string;
	tone?: "text" | "muted" | "accent" | "error";
}
export interface ShellDocument {
	title: string;
	lines: ShellLine[];
}
export interface ShellReply {
	document?: ShellDocument;
	notice?: string;
	overview?: boolean;
}
export interface ShellBackend {
	snapshot(): Promise<DashboardSnapshot>;
	execute(request: ShellRequest): Promise<ShellReply>;
	localWorkActive(): boolean;
}
export interface ShellState {
	snapshot: DashboardSnapshot;
	document?: ShellDocument;
	notice?: string;
	error?: string;
	busy: boolean;
	paused: boolean;
	offset: number;
	sample?: boolean;
	diagnostics?: boolean;
}

/** Parse arguments as data. No shell expansion or command execution is involved. */
export function splitArguments(text: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote = "";
	let escaped = false;
	let present = false;
	for (const character of text) {
		if (escaped) {
			current += character;
			escaped = false;
			present = true;
		} else if (character === "\\" && quote !== "'") escaped = true;
		else if (quote) {
			if (character === quote) quote = "";
			else current += character;
		} else if (character === '"' || character === "'") {
			quote = character;
			present = true;
		} else if (/\s/u.test(character)) {
			if (present) {
				result.push(current);
				current = "";
				present = false;
			}
		} else {
			current += character;
			present = true;
		}
	}
	if (quote) throw new Error("Close the quoted argument before submitting.");
	if (escaped) current += "\\";
	if (present || current) result.push(current);
	return result;
}

export function parseShellRequest(line: string): ShellRequest {
	const text = line.trim();
	if (!text.startsWith("/")) return { name: "new", args: text ? [text] : [], text };
	const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text);
	let name = (match?.[1] || "help").toLowerCase();
	if (name === "run") name = "new";
	if (name === "result") name = "delivery";
	if (name === "exit") name = "quit";
	const rest = match?.[2]?.trim() ?? "";
	if (name === "new" || name === "cancel") return { name, args: rest ? [rest] : [], text };
	if (name === "settings") {
		const parts = /^(\S+)\s*([\s\S]*)$/.exec(rest);
		return { name, args: parts ? [parts[1] as string, ...(parts[2] ? [parts[2]] : [])] : [], text };
	}
	return { name, args: splitArguments(rest), text };
}

export function shellHelp(filter = ""): ShellDocument {
	const query = filter.replace(/^\//, "").toLowerCase();
	if (!query)
		return {
			title: "Commands",
			lines: [
				{ text: "Type an objective to start. /new starts another goal.", tone: "muted" },
				{ text: "" },
				{ text: "Work", tone: "accent" },
				{ text: "/status  /tasks  /why  /continue  /delivery" },
				{ text: "" },
				{ text: "Configure · next run", tone: "accent" },
				{ text: "/models  /model  /settings  /profiles  /doctor" },
				{ text: "" },
				{ text: "Control", tone: "accent" },
				{ text: "/pause  /resume  /cancel  /retry  /decisions  /decision" },
				{ text: "" },
				{ text: "Inspect", tone: "accent" },
				{ text: "/events  /diagnostics  /messages  /message  /proposals  /proposal  /artifacts  /init" },
				{ text: "" },
				{ text: "/help <command or group> for syntax · /quit to close", tone: "muted" },
				{ text: "Tab completes commands · Up/Down recalls input · PgUp/PgDn scrolls", tone: "muted" },
			],
		};
	const commands = SHELL_COMMANDS.filter(
		(entry) => !query || entry.group.toLowerCase() === query || entry.name === query,
	);
	if (!commands.length) throw new Error(`No command or group named ${filter}. Use /help.`);
	const lines: ShellLine[] = [
		{ text: "Type an objective to start. Slash commands control the workspace.", tone: "muted" },
		{ text: "" },
	];
	let group = "";
	for (const command of commands) {
		if (group !== command.group) {
			if (group) lines.push({ text: "" });
			group = command.group;
			lines.push({ text: group, tone: "accent" });
		}
		lines.push(
			{ text: `/${command.name}${command.args ? " " + command.args : ""}` },
			{ text: `  ${command.description}`, tone: "muted" },
		);
	}
	lines.push(
		{ text: "" },
		{ text: "Tab completes commands. Up/Down recalls input. PgUp/PgDn scrolls details.", tone: "muted" },
	);
	lines.push({
		text: "Examples: /model implementer openai/gpt-5  ·  /settings execution.maxParallelism 2",
		tone: "muted",
	});
	lines.push({
		text: "Use /settings reset <key> to restore a default. Model and setting edits apply to new runs.",
		tone: "muted",
	});
	return { title: query ? `Help · ${filter}` : "Commands", lines };
}

const executionCommands = new Set(["new", "continue", "retry", "decision", "proposal", "init"]);

/** Async control-plane requests; Pi remains the sole owner of every agent loop. */
export class ShellSession {
	readonly state: ShellState;
	onChange: () => void = () => {};
	onQuit: () => void = () => {};
	diagnostics: () => ShellDocument = () => ({
		title: "Diagnostics",
		lines: [{ text: "No diagnostic output in this session.", tone: "muted" }],
	});
	private refreshing = false;
	private viewVersion = 0;
	constructor(
		private readonly backend: ShellBackend,
		snapshot: DashboardSnapshot,
	) {
		this.state = { snapshot, busy: false, paused: false, offset: 0, sample: snapshot.sample };
	}
	async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			this.state.snapshot = await this.backend.snapshot();
		} catch (error) {
			this.state.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			this.onChange();
		}
	}
	async submit(line: string): Promise<void> {
		let request: ShellRequest;
		try {
			request = parseShellRequest(line);
		} catch (error) {
			this.state.error = String(error instanceof Error ? error.message : error);
			this.onChange();
			return;
		}
		this.state.error = undefined;
		this.state.offset = 0;
		const version = ++this.viewVersion;
		if (request.name === "quit") {
			if (this.backend.localWorkActive()) {
				this.state.notice =
					"Work is running here. Use /cancel <reason> to end it, or Ctrl+C to interrupt and /continue later.";
				this.onChange();
				return;
			}
			this.onQuit();
			return;
		}
		if (request.name === "help") {
			try {
				this.state.document = shellHelp(request.args[0]);
				this.state.notice = undefined;
			} catch (error) {
				this.state.error = (error as Error).message;
			}
			this.onChange();
			return;
		}
		if (request.name === "new" && !request.args.length) {
			this.state.document = undefined;
			this.state.notice = "Type your next objective below and press Enter.";
			this.onChange();
			return;
		}
		if (request.name === "diagnostics") {
			this.state.document = this.diagnostics();
			this.state.notice = undefined;
			this.onChange();
			return;
		}
		if (!SHELL_COMMANDS.some((command) => command.name === request.name)) {
			this.state.error = `Unknown command /${request.name}. Use /help to see available commands.`;
			this.onChange();
			return;
		}
		const executes = executionCommands.has(request.name);
		if (executes && this.state.busy) {
			this.state.notice = "A request is still running. /status, /tasks, /pause and /cancel remain available.";
			this.onChange();
			return;
		}
		if (executes) {
			this.state.busy = true;
			this.state.document = undefined;
			this.state.notice = "Working. You can keep using commands below.";
		}
		this.onChange();
		try {
			const reply = await this.backend.execute(request);
			if (version === this.viewVersion) {
				if (reply.overview) this.state.document = undefined;
				else if (reply.document) this.state.document = reply.document;
			}
			this.state.notice = reply.notice;
			if (request.name === "pause") this.state.paused = true;
			if (request.name === "resume") this.state.paused = false;
		} catch (error) {
			this.state.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (executes) {
				this.state.busy = false;
				this.state.paused = false;
			}
			await this.refresh();
		}
	}
}
