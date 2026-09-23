import { basename } from "node:path";
import type { DashboardSnapshot } from "./dashboard-data.ts";
import type { ShellDocument, ShellLine, ShellState } from "./shell-commands.ts";
import { clean, fit, formatTokens, paint, sanitizeText, wrap } from "./theme.ts";

export function readableState(value: string): string {
	const names: Record<string, string> = {
		OPEN: "In progress",
		ACTIVE: "Working",
		PROPOSED: "Waiting",
		READY: "Ready",
		BLOCKED: "Needs attention",
		ACCEPTED: "Done",
		COMPLETED: "Complete",
		CANCELLED: "Cancelled",
		VERIFIED_DELIVERY: "Verified delivery",
		STRUCTURAL_HANDOFF: "Delivery needs behavioral verification",
		RUNNING: "Running",
		PASSED: "Passed",
		FAILED: "Failed",
	};
	return names[value] ?? clean(value).toLowerCase().replaceAll("_", " ");
}

export function overviewDocument(snapshot: DashboardSnapshot, busy = false): ShellDocument {
	if (!snapshot.run)
		return {
			title: "What would you like to build?",
			lines: [
				{ text: "Describe a change. TripleTeam plans, implements and checks it in Git worktrees.", tone: "muted" },
				{ text: "" },
				{ text: "Start     Type an objective below" },
				{ text: "Resume    /continue" },
				{ text: "Configure /models or /settings" },
				{ text: "Explore   /help" },
			],
		};
	const done = snapshot.tasks.filter((task) => task.state === "ACCEPTED").length;
	const total = snapshot.tasks.filter((task) => task.state !== "CANCELLED").length;
	const active = snapshot.tasks.filter((task) => task.state === "ACTIVE");
	const lines: ShellLine[] = [
		{
			text:
				readableState(snapshot.run.state) +
				(total ? ` · ${done} of ${total} tasks done` : busy ? " · Planning" : " · No task graph yet"),
			tone: "accent",
		},
		{ text: "" },
	];
	for (const task of active.slice(0, 3)) lines.push({ text: `Working  ${task.title}` });
	if (snapshot.coordination)
		lines.push({
			text: `${readableState(snapshot.coordination.mode)} · ${snapshot.explanation.liveWriters} live writers · /why`,
			tone: "muted",
		});
	if (active.length > 3) lines.push({ text: `+ ${active.length - 3} more active tasks · /tasks`, tone: "muted" });
	if (!active.length && total)
		lines.push({ text: `${snapshot.checks.PASSED ?? 0} checks passed · /tasks for the plan`, tone: "muted" });
	if (snapshot.decisions.length)
		lines.push(
			{ text: "" },
			{
				text: `${snapshot.decisions.length} decision${snapshot.decisions.length === 1 ? "" : "s"} waiting for you`,
				tone: "accent",
			},
			{ text: snapshot.decisions[0]?.question ?? "" },
			{ text: "Use /decisions to review the options.", tone: "muted" },
		);
	else if (snapshot.delivery)
		lines.push(
			{ text: "" },
			{ text: readableState(snapshot.delivery.result) },
			{ text: "Use /delivery for the Git ref and evidence.", tone: "muted" },
		);
	else if (snapshot.run.reason)
		lines.push(
			{ text: "" },
			{ text: snapshot.run.reason },
			{ text: "Use /tasks or /decisions to inspect the blocker.", tone: "muted" },
		);
	else if (!busy && !snapshot.usage.live && snapshot.run.state === "OPEN")
		lines.push({ text: "" }, { text: "Saved run · /continue to resume execution", tone: "muted" });
	return { title: snapshot.run.objective || "Workspace", lines };
}

export function explanationDocument(snapshot: DashboardSnapshot): ShellDocument {
	return {
		title: "Why this execution strategy?",
		lines: [
			{ text: snapshot.coordination?.mode ?? "Awaiting task graph", tone: "accent" },
			{
				text:
					snapshot.coordination?.rationale ??
					"The runtime chooses a strategy after inspecting the goal and its checks.",
			},
			{
				text: `${snapshot.explanation.liveWriters} live writer processes · limit ${snapshot.maxParallelism}`,
				tone: "muted",
			},
			{ text: "" },
			{ text: "Verification", tone: "accent" },
			{ text: `Baseline  ${snapshot.explanation.baseline}` },
			...snapshot.explanation.finalChecks.map((check) => ({ text: `${readableState(check.state)}  ${check.name}` })),
			{
				text: "Final checks refer to the current integration tree. Task review and independent probes also remain required.",
				tone: "muted",
			},
			{ text: "" },
			{ text: "Compute decisions", tone: "accent" },
			...snapshot.explanation.allocations.flatMap((entry) => [
				{ text: `${entry.task} · ${readableState(entry.action)}` },
				{ text: entry.reason, tone: "muted" as const },
			]),
			{
				text: `${snapshot.explanation.observationsReused} repository observations reused after dependency validation`,
				tone: "muted",
			},
		],
	};
}

export function tasksDocument(snapshot: DashboardSnapshot, detail?: string): ShellDocument {
	const selected = detail
		? snapshot.tasks.find((task, index) => String(index + 1) === detail || task.id === detail)
		: undefined;
	if (detail && !selected) throw new Error("Task not found. Use /tasks, then /tasks <number>.");
	return selected
		? {
				title: selected.title,
				lines: [
					{ text: readableState(selected.state), tone: "accent" },
					{ text: `Scope  ${selected.scope}` },
					{ text: `Risk  ${selected.risk.toLowerCase()} · attempt ${selected.epoch}` },
					{ text: `Task  ${selected.id}`, tone: "muted" },
					{ text: "" },
					{ text: "Use /retry <task-number> to retry a blocked task.", tone: "muted" },
				],
			}
		: {
				title: "Tasks",
				lines: snapshot.tasks.length
					? [
							...snapshot.tasks.map((task, index) => ({
								text: `${index + 1}. ${readableState(task.state)}  ${task.title}`,
							})),
							{ text: "" },
							{ text: "/tasks <number> shows scope, attempt and task ID.", tone: "muted" },
						]
					: [{ text: "No tasks yet. Type a goal or use /continue.", tone: "muted" }],
			};
}

export function renderShell(
	state: ShellState,
	view: { width: number; height: number; color: boolean; input?: string },
): string[] {
	const width = Math.max(0, Math.floor(view.width));
	const height = Math.max(0, Math.floor(view.height));
	if (!width || !height) return [];
	const margin = width >= 32 ? "  " : "";
	const contentWidth = Math.max(1, Math.min(104, width - margin.length * 2));
	const p = (text: unknown, tone: ShellLine["tone"] = "text", bold = false) =>
		paint(sanitizeText(text), tone ?? "text", view.color, bold);
	const rows = [
		p("TripleTeam", "accent", true) +
			p(state.sample ? "  Preview / sample data" : `  ${basename(state.snapshot.repository)}`, "muted"),
		"",
	];
	const doc = state.document ?? overviewDocument(state.snapshot, state.busy);
	const content: string[] = [];
	for (const title of wrap(doc.title, contentWidth).slice(0, 3)) content.push(p(title, "text", true));
	content.push("");
	for (const line of doc.lines) {
		if (!line.text) content.push("");
		else for (const piece of wrap(line.text, contentWidth)) content.push(p(piece, line.tone));
	}
	const notice = state.error ?? state.notice;
	const noticeLines = notice ? wrap(notice, contentWidth).slice(0, Math.max(1, Math.min(3, height - 10))) : [];
	const reserved = 5 + (notice ? noticeLines.length + 1 : 0);
	const available = Math.max(0, height - rows.length - reserved);
	const offset = Math.min(Math.max(0, state.offset), Math.max(0, content.length - available));
	rows.push(...content.slice(offset, offset + available));
	while (rows.length < height - reserved) rows.push("");
	if (notice) rows.push(...noticeLines.map((line) => p(line, state.error ? "error" : "muted")), "");
	rows.push(p("─".repeat(contentWidth), "muted"));
	rows.push(view.input ?? p("› ", "accent") + p("Type a goal or /help", "muted"));
	rows.push("");
	const run = state.snapshot.run;
	const status = state.paused
		? "Dispatch paused"
		: state.busy || state.snapshot.usage.live
			? "Working"
			: run?.state === "BLOCKED"
				? "Needs attention"
				: "Ready";
	const tokens = state.snapshot.usage.tokens;
	const usage = tokens ? ` · ${formatTokens(tokens)} tokens · $${state.snapshot.usage.cost.toFixed(2)} recorded` : "";
	rows.push(
		p(
			state.sample
				? "Sample data · no model calls or files changed"
				: `${status}${usage}${state.diagnostics ? " · /diagnostics" : ""}`,
			"muted",
		),
	);
	rows.push(
		p(
			content.length > available
				? "/help · Tab complete · PgUp/PgDn details"
				: "/help · Tab complete · Ctrl+C interrupt",
			"muted",
		),
	);
	return rows.slice(-height).map((line) => fit(margin + fit(line, contentWidth), width));
}
