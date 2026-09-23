import { matchesKey, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { DashboardSnapshot } from "./dashboard-data.ts";
import type { ShellDocument } from "./shell-commands.ts";
import { overviewDocument, tasksDocument } from "./shell-view.ts";
import { clean, fit, formatTokens, paint, wrap } from "./theme.ts";

export interface DashboardView {
	width: number;
	height: number;
	color: boolean;
	tab?: number;
	offset?: number;
	error?: string;
	loading?: string;
	watch?: boolean;
}

/** The same quiet, single-column presentation as the interactive shell. */
export function renderDashboard(snapshot: DashboardSnapshot, view: DashboardView): string[] {
	const width = Math.max(0, Math.floor(view.width));
	const height = Math.max(0, Math.floor(view.height));
	if (!width || !height) return [];
	const margin = width >= 32 ? "  " : "";
	const contentWidth = Math.max(1, Math.min(104, width - margin.length * 2));
	const p = (text: string, tone: "text" | "muted" | "accent" | "error" = "text", bold = false) =>
		paint(clean(text), tone, view.color, bold);
	const rows = [
		p("TripleTeam", "accent", true) +
			"  " +
			p(snapshot.sample ? "PREVIEW / SAMPLE DATA" : snapshot.repository, "muted"),
		"",
	];
	const document: ShellDocument =
		view.tab === 1
			? tasksDocument(snapshot)
			: view.tab === 2
				? {
						title: "Recent activity",
						lines: snapshot.events.length
							? snapshot.events.flatMap((event) => [
									{ text: event.time.slice(11, 19) + "  " + event.type },
									{ text: event.detail, tone: "muted" as const },
									{ text: "" },
								])
							: [{ text: "No activity yet.", tone: "muted" }],
					}
				: overviewDocument(snapshot, Boolean(view.loading));
	if (view.loading && !snapshot.run) document.title = view.loading;
	const content: string[] = [...wrap(document.title, contentWidth).map((line) => p(line, "text", true)), ""];
	for (const line of document.lines)
		content.push(...(line.text ? wrap(line.text, contentWidth).map((text) => p(text, line.tone)) : [""]));
	if (view.error)
		content.unshift(
			...wrap(view.error, contentWidth)
				.slice(0, 2)
				.map((line) => p(line, "error")),
			"",
		);
	const available = Math.max(0, height - rows.length - 3);
	const offset = Math.min(Math.max(0, view.offset ?? 0), Math.max(0, content.length - available));
	rows.push(...content.slice(offset, offset + available));
	while (rows.length < height - 3) rows.push("");
	rows.push(p("─".repeat(contentWidth), "muted"));
	rows.push(
		p(
			snapshot.sample
				? "Sample workspace · no model calls or files changed"
				: snapshot.usage.tokens
					? `${formatTokens(snapshot.usage.tokens)} tokens · $${snapshot.usage.cost.toFixed(2)} recorded`
					: "Local workspace",
			"muted",
		),
	);
	rows.push(
		p(
			view.watch
				? "1 overview · 2 tasks · 3 activity · j/k scroll · q close"
				: "tripleteam · interactive shell    --json · machine output",
			"muted",
		),
	);
	return rows.slice(-height).map((line) => fit(margin + fit(line, contentWidth), width));
}

/** Product-owned layout and navigation over Pi's public terminal primitives. */
export class DashboardScreen {
	private readonly terminal = new ProcessTerminal();
	private readonly ui = new TuiAltScreen(this.terminal, false, undefined, { mouse: false });
	private tab = 0;
	private offset = 0;
	private stopped = false;
	private error: string | undefined;
	private onClose: (() => void) | undefined;
	private readonly interrupt = () => {
		this.stop();
		process.kill(process.pid, "SIGINT");
	};
	private readonly terminate = () => {
		this.stop();
		process.kill(process.pid, "SIGTERM");
	};
	private readonly exit = () => this.stop();

	constructor(
		private snapshot: DashboardSnapshot,
		private readonly color: boolean,
		private readonly loading?: string,
	) {
		this.ui.setLayoutRoot({
			render: (width) =>
				renderDashboard(this.snapshot, {
					width,
					height: this.terminal.rows,
					color: this.color,
					tab: this.tab,
					offset: this.offset,
					error: this.error,
					loading: this.snapshot.run ? undefined : this.loading,
					watch: true,
				}),
			invalidate() {},
		});
		this.ui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				this.interrupt();
				return { consume: true };
			}
			if (data === "q" || matchesKey(data, "escape")) {
				this.stop();
				return { consume: true };
			}
			if (["1", "2", "3"].includes(data) || matchesKey(data, "tab")) {
				this.tab = data === "\t" || matchesKey(data, "tab") ? (this.tab + 1) % 3 : Number(data) - 1;
				this.offset = 0;
			} else if (data === "j" || matchesKey(data, "down")) {
				this.offset = Math.min(
					Math.max(0, (this.tab === 1 ? this.snapshot.tasks : this.snapshot.events).length - 1),
					this.offset + 1,
				);
			} else if (data === "k" || matchesKey(data, "up")) {
				this.offset = Math.max(0, this.offset - 1);
			}
			this.ui.requestRender();
			return { consume: true };
		});
	}

	start(onClose: () => void): void {
		this.onClose = onClose;
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

	update(snapshot: DashboardSnapshot): void {
		if (this.stopped) return;
		this.snapshot = snapshot;
		this.error = undefined;
		this.ui.requestRender();
	}

	showError(error: unknown): void {
		this.error = error instanceof Error ? error.message : String(error);
		this.ui.requestRender();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		process.off("SIGINT", this.interrupt);
		process.off("SIGTERM", this.terminate);
		process.off("exit", this.exit);
		this.ui.stop();
		this.onClose?.();
	}
}
