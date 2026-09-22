import { resolve } from "node:path";
import { resolveRepositoryRoot } from "../workspace/git.ts";
import { DashboardScreen, renderDashboard } from "./dashboard.ts";
import { type DashboardSnapshot, demoDashboard, emptyDashboard, readDashboard } from "./dashboard-data.ts";
import type { OutputOptions } from "./output.ts";

export async function showDashboard(
	options: OutputOptions,
	repository?: string,
	runId?: string,
	demo = false,
): Promise<void> {
	const root = demo ? "sample" : await resolveRepositoryRoot(resolve(repository ?? process.cwd()));
	const read = () => (demo ? Promise.resolve(demoDashboard()) : readDashboard(root, runId));
	const initial = await read();
	if (options.json) {
		console.log(JSON.stringify(initial, null, 2));
		return;
	}
	if (options.plain || !process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
		console.log(
			renderDashboard(initial, { width: process.stdout.columns || 100, height: 32, color: false }).join("\n"),
		);
		return;
	}
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	const screen = new DashboardScreen(initial, options.color);
	await new Promise<void>((done) => {
		screen.start(() => {
			stopped = true;
			clearTimeout(timer);
			done();
		});
		const refresh = async () => {
			try {
				screen.update(await read());
			} catch (error) {
				if (!stopped) screen.showError(error);
			}
			if (!stopped) timer = setTimeout(() => void refresh(), 1000);
		};
		if (!demo) timer = setTimeout(() => void refresh(), 1000);
	});
	console.log(
		demo
			? "Preview closed. Run tripleteam help to get started."
			: "View closed. The run is unchanged; use tripleteam status to inspect it.",
	);
}

/** Observation only: execution and cancellation stay with the existing orchestrator. */
export async function withLiveDashboard<T>(
	options: OutputOptions,
	repository: string | undefined,
	work: () => Promise<T>,
	input: { fresh?: boolean; runId?: string; label?: string } = {},
): Promise<T> {
	if (options.json || options.plain || !process.stdout.isTTY || !process.stdin.isTTY || process.env.TERM === "dumb")
		return work();
	const root = await resolveRepositoryRoot(resolve(repository ?? process.cwd()));
	// A view must never block reconciliation/migration or change command success.
	let before: DashboardSnapshot;
	try {
		before = await readDashboard(root, input.runId);
	} catch {
		return work();
	}
	const screen = new DashboardScreen(
		input.fresh ? emptyDashboard(root) : before,
		options.color,
		input.label ?? "Preparing your engineering task…",
	);
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	try {
		screen.start(() => {
			stopped = true;
			clearTimeout(timer);
		});
	} catch {
		return work();
	}
	const refresh = async () => {
		try {
			const snapshot = await readDashboard(root, input.runId);
			if (!input.fresh || snapshot.run?.id !== before.run?.id) screen.update(snapshot);
		} catch (error) {
			if (!stopped) screen.showError(error);
		}
		if (!stopped) timer = setTimeout(() => void refresh(), 1000);
	};
	timer = setTimeout(() => void refresh(), 300);
	try {
		return await work();
	} finally {
		screen.stop();
	}
}
