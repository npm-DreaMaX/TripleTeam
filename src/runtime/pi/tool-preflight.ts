import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runProbe(script: string, directory: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: directory,
			env: { ...process.env, PI_OFFLINE: "1" },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let failure: Error | undefined;
		const stop = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// The group can already have disappeared after normal tool completion.
			}
		};
		const timeout = setTimeout(() => {
			failure = new Error("Pi search preflight exceeded 30000 ms");
			stop();
		}, 30_000);
		const receive = (stream: "stdout" | "stderr") => (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > 64 * 1024) {
				failure = new Error("Pi search preflight output exceeded 64 KiB");
				stop();
			} else if (stream === "stdout") stdout += chunk;
			else stderr += chunk;
		};
		child.stdout.setEncoding("utf8").on("data", receive("stdout"));
		child.stderr.setEncoding("utf8").on("data", receive("stderr"));
		child.once("error", (error) => {
			failure = error;
		});
		child.once("exit", stop);
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			if (code === 0 && !failure) resolve(stdout);
			else
				reject(
					new Error(
						[stderr.trim(), stdout.trim(), failure?.message ?? `Search subprocess exited with ${code ?? signal}`]
							.filter(Boolean)
							.join("\n"),
					),
				);
		});
	});
}

/** Exercise the pinned Pi public tools before spending model compute on an unusable environment. */
export async function checkPiSearchTools(toolNames: string[]): Promise<{ grep?: "ok"; find?: "ok" }> {
	const required = [...new Set(toolNames.filter((name) => name === "grep" || name === "find"))];
	if (required.length === 0) return {};
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-pi-preflight-"));
	try {
		const filename = "tripleteam-search-sentinel.txt";
		const marker = "tripleteam-search-" + randomUUID();
		await writeFile(join(directory, filename), marker + "\n");
		const script = String.raw`
try {
  const { createGrepTool, createFindTool } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
  const result = {};
  for (const name of ${JSON.stringify(required)}) {
    const tool = name === 'grep' ? createGrepTool(process.cwd()) : createFindTool(process.cwd());
    const input = name === 'grep'
      ? { pattern: ${JSON.stringify(marker)}, path: '.', literal: true }
      : { pattern: ${JSON.stringify(filename)}, path: '.' };
    const output = await tool.execute('tripleteam-preflight-' + name, input, AbortSignal.timeout(25000));
    const text = output.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const found = name === 'grep'
      ? text.includes(${JSON.stringify(filename + ":1: " + marker)})
      : text.split('\n').includes(${JSON.stringify(filename)});
    if (output.isError || !found) throw new Error(name + ' could not retrieve its sentinel: ' + text);
    result[name] = 'ok';
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
		const stdout = await runProbe(script, directory);
		const result: unknown = JSON.parse(stdout);
		if (
			!result ||
			typeof result !== "object" ||
			required.some((name) => (result as Record<string, unknown>)[name] !== "ok")
		)
			throw new Error("Pi search preflight returned an invalid result");
		return result as { grep?: "ok"; find?: "ok" };
	} catch (error) {
		throw new Error(
			`Pi search tool preflight failed for ${required.join(", ")} (offline, 30s timeout). Install ripgrep (rg) and fd/fdfind, or prepare Pi's tool cache before starting an Agent.\n` +
				(error instanceof Error ? error.message : String(error)),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
