import { matchesKey, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { DashboardSnapshot } from "./dashboard-data.ts";
import { clean, fit, formatTokens, pad, paint, sanitizeText, section, stateTone, wrap } from "./theme.ts";

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

function taskLines(
	snapshot: DashboardSnapshot,
	width: number,
	limit: number,
	offset = 0,
	detail = false,
	color = false,
): string[] {
	const tasks = snapshot.tasks.slice(offset, offset + limit);
	if (!tasks.length) return [paint("Waiting for the task graph…", "muted", color)];
	return tasks.flatMap((task) => {
		const state = task.state === "PROPOSED" ? "WAITING" : clean(task.state);
		const symbol = state === "ACCEPTED" ? "+" : state === "ACTIVE" ? ">" : state === "BLOCKED" ? "!" : "·";
		const line =
			paint(pad(`${symbol} ${state}`, 13), stateTone(state), color) + fit(clean(task.title), Math.max(1, width - 13));
		return detail
			? [
					line,
					paint(
						fit(
							`  ${clean(task.scope)}   ·   attempt ${task.epoch}   ·   ${clean(task.risk).toLowerCase()} risk`,
							width,
						),
						"muted",
						color,
					),
					paint(fit(`  ${clean(task.id)}`, width), "muted", color),
					"",
				]
			: [line];
	});
}

function eventLines(snapshot: DashboardSnapshot, width: number, limit: number, offset = 0, color = false): string[] {
	const events = snapshot.events.slice(offset, offset + limit);
	return events.length
		? events.flatMap((event) => [
				paint(clean(event.time.slice(11, 19)) + "  ", "muted", color) +
					paint(fit(clean(event.type), Math.max(1, width - 10)), "text", color),
				...wrap(event.detail, Math.max(1, width - 2))
					.slice(0, 2)
					.map((line) => paint("  " + line, "muted", color)),
			])
		: [paint("Activity will appear as the run progresses.", "muted", color)];
}

export function renderDashboard(snapshot: DashboardSnapshot, view: DashboardView): string[] {
	const width = Math.max(12, Math.min(view.width - 4, 124));
	const height = Math.max(5, view.height);
	const color = view.color;
	const tab = view.tab ?? 0;
	const offset = view.offset ?? 0;
	const p = (text: string, tone: Parameters<typeof paint>[1] = "text", bold = false) =>
		paint(sanitizeText(text), tone, color, bold);
	const result: string[] = [];
	const right = snapshot.sample ? "PREVIEW / SAMPLE DATA" : snapshot.run ? clean(snapshot.run.state) : "READY";
	const brand = p("▰▰▰  TripleTeam", "accent", true);
	result.push(
		brand + " ".repeat(Math.max(2, width - 18 - right.length)) + p(right, snapshot.sample ? "warning" : "muted"),
	);
	result.push(p(fit(clean(snapshot.repository), width), "muted"));
	result.push("");
	result.push(
		p(
			fit(
				clean(view.loading ?? snapshot.run?.objective ?? "Turn an engineering goal into a checked Git delivery."),
				width,
			),
			"text",
			true,
		),
	);
	result.push("");
	result.push(
		["1 Overview", "2 Tasks", "3 Activity"]
			.map((title, index) =>
				p(`${index === tab ? "▸" : " "} ${title}`, index === tab ? "accent" : "muted", index === tab),
			)
			.join("     "),
	);
	result.push(p("─".repeat(width), "border"));
	if (view.error)
		result.push(
			...wrap(`Refresh paused: ${view.error}`, width)
				.slice(0, 2)
				.map((line) => p(line, "warning")),
		);
	if (!snapshot.run) {
		result.push("", p("A workspace for the whole task.", "text", true), "");
		result.push(
			...wrap(
				"Give TripleTeam a goal. Follow the plan, inspect the evidence, and pick up the final Git delivery here.",
				width,
			).map((line) => p(line, "muted")),
			"",
		);
		result.push(p('  tripleteam run "your engineering goal"', "accent"), "");
		result.push(p("  tripleteam doctor       Check your installation", "muted"));
		result.push(p("  tripleteam profiles     Inspect role configuration", "muted"));
		result.push(p("  tripleteam demo         Explore the terminal UI", "muted"));
	} else {
		const accepted = snapshot.tasks.filter((task) => task.state === "ACCEPTED").length;
		const eligible = snapshot.tasks.filter((task) => task.state !== "CANCELLED").length;
		const active = snapshot.tasks.filter((task) => task.state === "ACTIVE").length;
		const cost = snapshot.sample
			? "— preview"
			: `$${snapshot.usage.cost.toFixed(3)} recorded${snapshot.usage.unsettled ? " *" : ""}`;
		const metrics = [`${accepted}/${eligible} accepted`, `${active} active tasks`, cost];
		result.push(
			...(width >= 70
				? [metrics.map((metric) => p(metric, "text", true)).join(p("    /    ", "border"))]
				: metrics.map((metric) => p(metric, "text", true))),
		);
		result.push(
			p(
				`${snapshot.policy}  ·  ${snapshot.maxParallelism} writer slots  ·  ${snapshot.sample ? "no API calls" : formatTokens(snapshot.usage.tokens) + " recorded tokens"}`,
				"muted",
			),
		);
		result.push("");
		if (tab === 1) {
			result.push(
				...taskLines(snapshot, width, Math.max(1, Math.floor((height - result.length - 4) / 4)), offset, true, color),
			);
		} else if (tab === 2) {
			result.push(
				...eventLines(snapshot, width, Math.max(1, Math.floor((height - result.length - 4) / 3)), offset, color),
			);
		} else {
			const rows = Math.max(2, Math.min(7, height - result.length - 9));
			const passed = snapshot.checks.PASSED ?? 0;
			const failed = (snapshot.checks.FAILED ?? 0) + (snapshot.checks.ERROR ?? 0);
			const evidence = `${passed} passed  ·  ${failed} failed  ·  ${snapshot.checks.RUNNING ?? 0} running`;
			if (width >= 92) {
				const leftWidth = Math.floor(width * 0.58);
				const rightWidth = width - leftWidth - 2;
				const left = section("TASKS", taskLines(snapshot, leftWidth - 4, rows, 0, false, color), leftWidth, color);
				const info = [
					p(clean(snapshot.coordination?.mode ?? "PLANNING"), "accent", true),
					...wrap(
						snapshot.coordination?.rationale ?? "Inspecting the repository and preparing the next action.",
						rightWidth - 4,
					).slice(0, Math.max(1, rows - 4)),
					"",
					p(`${snapshot.contracts.satisfied}/${snapshot.contracts.total} contracts satisfied`, "muted"),
					p(evidence, failed ? "warning" : "muted"),
				];
				const rightPanel = section("COORDINATION", info.slice(0, rows), rightWidth, color);
				for (let index = 0; index < Math.max(left.length, rightPanel.length); index++)
					result.push(pad(left[index] ?? "", leftWidth) + "  " + (rightPanel[index] ?? ""));
			} else {
				result.push(
					...taskLines(snapshot, width, rows, 0, false, color),
					"",
					p(clean(snapshot.coordination?.mode ?? "PLANNING"), "accent"),
				);
				result.push(p(evidence, failed ? "warning" : "muted"));
			}
			if (snapshot.delivery) {
				result.push("", p(clean(snapshot.delivery.result), stateTone(snapshot.delivery.result), true));
				result.push(p(fit(clean(snapshot.delivery.ref ?? snapshot.run.reason), width), "muted"));
			} else if (snapshot.decisions[0]) {
				result.push(
					"",
					p("YOUR DECISION", "warning", true),
					...wrap(snapshot.decisions[0].question, width).slice(0, 2),
				);
				result.push(p("tripleteam decisions  ·  inspect options and respond", "muted"));
			} else if (snapshot.run.reason) {
				result.push(
					"",
					...wrap(snapshot.run.reason, width)
						.slice(0, 2)
						.map((line) => p(line, "warning")),
				);
			} else if (height > 28) {
				result.push("", p("LATEST ACTIVITY", "muted"), ...eventLines(snapshot, width, 1, 0, color));
			}
		}
	}
	const footer = snapshot.sample
		? "Sample workspace · no model calls or files changed"
		: snapshot.run
			? `run ${snapshot.run.id.slice(0, 12)}  ·  head ${snapshot.run.integrationHead.slice(0, 10)}`
			: "Local workspace · your provider · ordinary Git";
	const controls = view.watch
		? "1/2/3 views   j/k scroll   q close view"
		: "tripleteam dashboard · live view    --json · machine output";
	const body = result.slice(0, Math.max(1, height - 3));
	while (body.length < height - 3) body.push("");
	body.push(p("─".repeat(width), "border"), p(fit(footer, width), "muted"), p(fit(controls, width), "muted"));
	return body.slice(0, Math.max(0, view.height)).map((line) => fit("  " + fit(line, width), Math.max(0, view.width)));
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
