import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const PALETTE = {
	background: "#171819",
	surface: "#222426",
	border: "#45494d",
	text: "#eceeed",
	muted: "#a9aeaf",
	accent: "#b5cba5",
	blue: "#eceeed",
	warning: "#eceeed",
	error: "#e6a09a",
} as const;

export type Tone = keyof typeof PALETTE;

export function sanitizeText(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

/** Repository and model text are data, never terminal control sequences. */
export function clean(value: unknown): string {
	return sanitizeText(value).replace(/\s+/g, " ").trim();
}

export function paint(text: string, tone: Tone, color: boolean, bold = false): string {
	if (!color) return text;
	const hex = PALETTE[tone].slice(1);
	const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
	return `\x1b[${bold ? "1;" : ""}38;2;${rgb.join(";")}m${text}\x1b[0m`;
}

export function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}

export function pad(text: string, width: number): string {
	const result = fit(text, width);
	return result + " ".repeat(Math.max(0, width - visibleWidth(result)));
}

export function wrap(text: string, width: number): string[] {
	return wrapTextWithAnsi(clean(text), Math.max(1, width));
}

export function stateTone(state: string): Tone {
	if (["ACCEPTED", "PASSED", "COMPLETED", "VERIFIED_DELIVERY", "APPROVED"].includes(state)) return "accent";
	if (["FAILED", "ERROR", "BLOCKED", "CHANGES_REQUESTED"].includes(state)) return "error";
	if (["ACTIVE", "RUNNING", "LIVE", "OPEN"].includes(state)) return "blue";
	if (["STRUCTURAL_HANDOFF", "READY", "PENDING"].includes(state)) return "warning";
	return "muted";
}

export function section(title: string, lines: string[], width: number, color: boolean): string[] {
	const inside = Math.max(1, width - 4);
	const label = ` ${clean(title)} `;
	const top = "╭─" + fit(label, Math.max(0, width - 4));
	return [
		paint(top + "─".repeat(Math.max(0, width - visibleWidth(top) - 1)) + "╮", "border", color),
		...lines.map((line) => paint("│", "border", color) + " " + pad(line, inside) + " " + paint("│", "border", color)),
		paint("╰" + "─".repeat(Math.max(0, width - 2)) + "╯", "border", color),
	];
}

export function formatTokens(value: number): string {
	return value >= 1_000_000
		? `${(value / 1_000_000).toFixed(1)}m`
		: value >= 1000
			? `${(value / 1000).toFixed(1)}k`
			: String(value);
}

export function formatDuration(milliseconds: number): string {
	const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
