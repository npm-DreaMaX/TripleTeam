import { clean, fit, paint, section } from "./theme.ts";

export interface OutputOptions {
	json: boolean;
	plain: boolean;
	color: boolean;
	watch: boolean;
	args: string[];
}

export function parseOutputOptions(
	argv: string[],
	tty = Boolean(process.stdout.isTTY),
	environment = process.env,
): OutputOptions {
	let explicitJson = false;
	let plain = false;
	let watch = false;
	let literal = false;
	const args: string[] = [];
	for (const arg of argv) {
		if (literal) args.push(arg);
		else if (arg === "--") literal = true;
		else if (arg === "--json") explicitJson = true;
		else if (arg === "--plain") plain = true;
		else if (arg === "--watch" || arg === "-w") watch = true;
		else args.push(arg);
	}
	if (explicitJson && plain) throw new Error("Choose --json or --plain, not both");
	if (watch && (explicitJson || plain || !tty || environment.TERM === "dumb"))
		throw new Error("--watch needs an interactive terminal; use status --json for automation");
	return {
		args,
		json: explicitJson || (!tty && !plain),
		plain,
		watch,
		color: tty && !plain && environment.NO_COLOR === undefined && environment.TERM !== "dumb",
	};
}

export function renderResult(value: unknown, title: string, color: boolean, width = 100): string {
	const lines: string[] = [];
	function visit(item: unknown, label: string, depth: number): void {
		if (Array.isArray(item)) {
			lines.push(paint(`${"  ".repeat(depth)}${clean(label)}  ${item.length} entries`, "accent", color, true));
			if (!item.length) lines.push(paint("  ".repeat(depth + 1) + "Nothing to show.", "muted", color));
			for (const entry of item) visit(entry, "", depth + 1);
			return;
		}
		if (item && typeof item === "object") {
			if (label) lines.push(paint("  ".repeat(depth) + clean(label), "accent", color, true));
			for (const [key, entry] of Object.entries(item))
				visit(entry, key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "), Math.min(depth + 1, 4));
			return;
		}
		lines.push(paint("  ".repeat(depth) + (label ? clean(label) + "  " : ""), "muted", color) + clean(item ?? "—"));
	}
	visit(value, "", 0);
	const rendered =
		"\n" +
		paint("  ▰▰▰  TripleTeam", "accent", color, true) +
		"\n\n" +
		section(title.toUpperCase(), lines, Math.max(28, Math.min(width - 4, 120)), color)
			.map((line) => "  " + line)
			.join("\n") +
		"\n";
	return rendered
		.split("\n")
		.map((line) => fit(line, Math.max(0, width)))
		.join("\n");
}

export function renderHelp(usage: string, color: boolean): string {
	return (
		"\n" +
		paint("  ▰▰▰  TripleTeam", "accent", color, true) +
		"\n" +
		paint("  Long tasks. Adaptive execution. Checked delivery.", "muted", color) +
		"\n\n" +
		usage
			.split("\n")
			.map((line) => "  " + (line.endsWith(":") ? paint(line, "accent", color, true) : line))
			.join("\n") +
		"\n"
	);
}

export function renderError(error: unknown, color: boolean): string {
	return paint("TripleTeam · ", "error", color, true) + fit(clean(error instanceof Error ? error.message : error), 600);
}
