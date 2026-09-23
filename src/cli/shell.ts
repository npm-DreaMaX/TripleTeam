import { resolve } from "node:path";
import { Container, Input, matchesKey, ProcessTerminal, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { projectPaths } from "../config/paths.ts";
import { resolveRepositoryRoot } from "../workspace/git.ts";
import { demoDashboard, emptyDashboard, readDashboard } from "./dashboard-data.ts";
import { ShellDiagnostics } from "./diagnostics.ts";
import type { OutputOptions } from "./output.ts";
import { WorkspaceShellBackend } from "./shell-actions.ts";
import { SHELL_COMMANDS, type ShellBackend, ShellSession } from "./shell-commands.ts";
import { explanationDocument, renderShell, tasksDocument } from "./shell-view.ts";
import { paint, sanitizeText } from "./theme.ts";

class SafeInput extends Input {
	override handleInput(data: string): void {
		super.handleInput(data);
		const value = this.getValue();
		const safe = sanitizeText(value);
		if (safe !== value) super.setValue(safe);
	}
	override setValue(value: string): void {
		super.setValue(sanitizeText(value));
	}
}

/** Product-owned interaction using Pi's public input and terminal renderer. */
export class ShellScreen {
	readonly input: Input;
	private readonly ui: TuiMainScreen;
	private history: string[] = [];
	private historyIndex = 0;
	private draft = "";
	private closed = false;
	private userQuit = false;
	private interruption: "SIGINT" | "SIGTERM" | undefined;
	get exitCode(): number | undefined {
		return this.interruption === "SIGINT" ? 130 : this.interruption === "SIGTERM" ? 143 : undefined;
	}
	get requestedQuit(): boolean {
		return this.userQuit;
	}
	private done: (() => void) | undefined;
	private readonly interrupt = () => {
		this.interruption = "SIGINT";
		this.stop();
	};
	private readonly terminate = () => {
		this.interruption = "SIGTERM";
		this.stop();
	};
	private readonly exit = () => this.stop();
	constructor(
		readonly session: ShellSession,
		readonly color: boolean,
		readonly terminal: Terminal = new ProcessTerminal(),
	) {
		this.ui = new TuiMainScreen(terminal, true);
		this.input = new SafeInput({
			prompt: "› ",
			placeholder: "Type a goal or /help",
			placeholderStyle: (text) => paint(text, "muted", color),
		});
		const root = new Container();
		root.addChild(this.input);
		root.render = (width) => {
			const margin = width >= 32 ? 4 : 0;
			const input = this.input.render(Math.max(1, Math.min(104, width - margin)))[0] ?? "";
			return renderShell(session.state, { width, height: Math.max(1, terminal.rows - 1), color, input });
		};
		this.ui.addChild(root);
		this.ui.setFocus(this.input);
		this.ui.setClearOnShrink(true);
		this.session.onChange = () => {
			if (!this.closed) this.ui.requestRender();
		};
		this.session.onQuit = () => {
			this.userQuit = true;
			this.stop();
		};
		this.input.onSubmit = (line) => {
			if (!line.trim()) return;
			this.history.push(line);
			if (this.history.length > 100) this.history.shift();
			this.historyIndex = this.history.length;
			this.draft = "";
			this.input.setValue("");
			void this.session.submit(line);
		};
		this.input.onEscape = () => {
			this.input.setValue("");
			this.ui.requestRender();
		};
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				this.interrupt();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d") && !this.input.getValue()) {
				void this.session.submit("/quit");
				return { consume: true };
			}
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.session.state.offset = Math.max(
					0,
					this.session.state.offset + (matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, terminal.rows - 10),
				);
				this.ui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				if (this.historyIndex === this.history.length) this.draft = this.input.getValue();
				this.historyIndex = Math.max(
					0,
					Math.min(this.history.length, this.historyIndex + (matchesKey(data, "up") ? -1 : 1)),
				);
				this.input.setValue(this.history[this.historyIndex] ?? this.draft);
				this.input.handleInput("\x05");
				this.ui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "tab") && /^\/\S*$/.test(this.input.getValue())) {
				const prefix = this.input.getValue().slice(1).toLowerCase();
				const matches = SHELL_COMMANDS.filter((command) => command.name.startsWith(prefix));
				if (matches.length === 1) {
					this.input.setValue(`/${matches[0]?.name} `);
					this.input.handleInput("\x05");
				} else
					this.session.state.notice = matches.length
						? matches
								.slice(0, 7)
								.map((command) => `/${command.name}`)
								.join("  ")
						: "No matching command. Use /help.";
				this.ui.requestRender();
				return { consume: true };
			}
			return undefined;
		});
	}
	start(done: () => void): void {
		this.done = done;
		process.once("SIGINT", this.interrupt);
		process.once("SIGTERM", this.terminate);
		process.once("exit", this.exit);
		try {
			this.ui.start();
		} catch (error) {
			this.stop();
			throw error;
		}
	}
	stop(): void {
		if (this.closed) return;
		this.closed = true;
		process.off("SIGINT", this.interrupt);
		process.off("SIGTERM", this.terminate);
		process.off("exit", this.exit);
		try {
			this.ui.stop();
		} finally {
			this.done?.();
		}
	}
}

function previewBackend(): ShellBackend {
	const snapshot = demoDashboard();
	return {
		snapshot: async () => snapshot,
		localWorkActive: () => false,
		execute: async (request) => {
			if (request.name === "why") return { document: explanationDocument(snapshot) };
			if (request.name === "status") return { overview: true };
			if (request.name === "tasks") return { document: tasksDocument(snapshot, request.args[0]) };
			if (request.name === "events")
				return {
					document: { title: "Sample activity", lines: snapshot.events.map((event) => ({ text: event.detail })) },
				};
			return { notice: "This is a preview. Start tripleteam in your repository to use this command." };
		},
	};
}

export async function showShell(
	options: OutputOptions,
	repository?: string,
	demo = false,
): Promise<{ detached: boolean; exitCode?: number }> {
	if (!process.stdin.isTTY || !process.stdout.isTTY || options.json || options.plain || process.env.TERM === "dumb")
		throw new Error("The interactive shell needs a TTY. Use help, status --json or status --plain for static output.");
	const requested = resolve(repository ?? process.cwd());
	const root = demo ? "sample" : await resolveRepositoryRoot(requested).catch(() => requested);
	const backend = demo ? previewBackend() : new WorkspaceShellBackend(root);
	let snapshot = demo ? demoDashboard() : emptyDashboard(root);
	let error: string | undefined;
	try {
		if (!demo) snapshot = await readDashboard(root);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	const session = new ShellSession(backend, snapshot);
	session.state.error = error;
	const diagnostics = demo ? undefined : new ShellDiagnostics(projectPaths(root).logs);
	if (diagnostics) session.diagnostics = () => diagnostics.document();
	const screen = new ShellScreen(session, options.color);
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	try {
		diagnostics?.attach(
			() => {
				session.state.diagnostics = true;
				session.onChange();
			},
			(error) => {
				session.state.error = `Diagnostic log unavailable: ${error.message}`;
				session.onChange();
			},
		);
		let finish: (() => void) | undefined;
		const finished = new Promise<void>((done) => {
			finish = done;
		});
		// Use the public terminal primitive to start the viewport below startup diagnostics.
		screen.terminal.clearScreen();
		screen.start(() => {
			closed = true;
			clearTimeout(timer);
			diagnostics?.restore();
			finish?.();
		});
		const refresh = async () => {
			await session.refresh();
			if (!closed) timer = setTimeout(() => void refresh(), 1000);
		};
		if (!demo && !closed) timer = setTimeout(() => void refresh(), 1000);
		await finished;
	} finally {
		closed = true;
		diagnostics?.restore();
		clearTimeout(timer);
	}
	console.log(
		screen.exitCode
			? "Interrupted. Use /continue when you return to the workspace."
			: demo
				? "Preview closed."
				: "Workspace closed.",
	);
	if (diagnostics?.savedFile) console.log("Diagnostics: " + diagnostics.savedFile);
	return {
		detached: screen.requestedQuit && session.state.busy && !backend.localWorkActive(),
		exitCode: screen.exitCode,
	};
}
