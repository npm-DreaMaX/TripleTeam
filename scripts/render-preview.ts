import { mkdir, writeFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDashboard } from "../src/cli/dashboard.ts";
import { demoDashboard } from "../src/cli/dashboard-data.ts";
import { PALETTE } from "../src/cli/theme.ts";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const lines = renderDashboard(demoDashboard(), { width: 120, height: 30, color: true, watch: true });
const cell = 9.3;
const texts: string[] = [];
for (const [row, line] of lines.entries()) {
	let x = 14;
	let color: string = PALETTE.text;
	let weight = 400;
	for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
		if (token.startsWith("\x1b[")) {
			const parts = token.slice(2, -1).split(";").map(Number);
			if (parts[0] === 0) { color = PALETTE.text; weight = 400; }
			if (parts[0] === 1) weight = 600;
			const index = parts.indexOf(38);
			if (index >= 0 && parts[index + 1] === 2) color = `rgb(${parts.slice(index + 2, index + 5).join(",")})`;
		} else if (token) {
			texts.push(`<text x="${x.toFixed(1)}" y="${77 + row * 23}" fill="${color}" font-weight="${weight}">${escape(token)}</text>`);
			x += visibleWidth(token) * cell;
		}
	}
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1150" height="780" viewBox="0 0 1150 780" role="img" aria-labelledby="title desc">
<title id="title">TripleTeam terminal workspace</title><desc id="desc">The actual dashboard renderer displaying labeled sample data. No benchmark or performance result is shown.</desc>
<rect width="1150" height="780" rx="16" fill="${PALETTE.background}"/>
<path d="M0 47H1150" stroke="${PALETTE.border}"/>
<g><circle cx="25" cy="24" r="5" fill="#FF9292"/><circle cx="43" cy="24" r="5" fill="#F1CD7B"/><circle cx="61" cy="24" r="5" fill="#59E3BB"/></g>
<text x="575" y="29" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${PALETTE.muted}">tripleteam demo · interactive UI preview</text>
<g font-family="JetBrains Mono, DejaVu Sans Mono, Consolas, monospace" font-size="15.5" xml:space="preserve">${texts.join("\n")}</g></svg>\n`;
await mkdir("docs/assets", { recursive: true });
await writeFile("docs/assets/terminal.svg", svg);
console.log("Rendered docs/assets/terminal.svg from the actual dashboard component.");
