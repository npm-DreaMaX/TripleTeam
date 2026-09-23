import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ShellDocument } from "./shell-commands.ts";
import { clean } from "./theme.ts";

const maximumLogBytes = 2 * 1024 * 1024;

/** Keep subprocess stderr from corrupting the active terminal renderer. */
export class ShellDiagnostics {
	readonly file: string;
	private recent = "";
	private bytes = 0;
	private clipped = false;
	private written = false;
	private restoreWrite: (() => void) | undefined;
	constructor(private readonly directory: string) {
		this.file = join(directory, `terminal-${Date.now()}-${process.pid}.log`);
	}
	get hasOutput(): boolean {
		return Boolean(this.recent);
	}
	get savedFile(): string | undefined {
		return this.written ? this.file : undefined;
	}

	attach(onOutput: () => void, onFailure: (error: Error) => void, stream = process.stderr): void {
		if (this.restoreWrite) throw new Error("Diagnostic capture is already active");
		const original = stream.write;
		const capture = (
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			const text =
				typeof chunk === "string"
					? chunk
					: Buffer.from(chunk).toString(typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8");
			const finished = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			this.recent = (this.recent + text).slice(-16000);
			try {
				if (!this.written) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
				const remaining = Math.max(0, maximumLogBytes - this.bytes);
				if (remaining) {
					const data = Buffer.from(text).subarray(0, remaining);
					appendFileSync(this.file, data, { mode: 0o600 });
					this.written = true;
					this.bytes += data.length;
				}
				if (Buffer.byteLength(text) > remaining && !this.clipped) {
					appendFileSync(this.file, "\n[Terminal diagnostic log reached its 2 MiB limit.]\n");
					this.clipped = true;
				}
			} catch (cause) {
				this.restore();
				onFailure(cause instanceof Error ? cause : new Error(String(cause)));
				return original.call(stream, chunk, encodingOrCallback as BufferEncoding, callback);
			}
			onOutput();
			if (finished) queueMicrotask(() => finished());
			return true;
		};
		stream.write = capture as typeof stream.write;
		this.restoreWrite = () => {
			if (stream.write === capture) stream.write = original;
		};
	}
	restore(): void {
		this.restoreWrite?.();
		this.restoreWrite = undefined;
	}
	document(): ShellDocument {
		return {
			title: "Diagnostics",
			lines: this.hasOutput
				? [
						{
							text: this.savedFile ? `Local log  ${this.savedFile}` : "Diagnostic log could not be saved.",
							tone: "muted",
						},
						{ text: "Recent subprocess output. Request failures also appear in the main view.", tone: "muted" },
						...(this.clipped
							? [
									{
										text: "The log reached its size limit; this view keeps the most recent output.",
										tone: "muted" as const,
									},
								]
							: []),
						{ text: "" },
						...this.recent
							.split(/\r?\n/)
							.slice(-60)
							.map((line) => ({ text: clean(line) })),
					]
				: [{ text: "No diagnostic output in this session.", tone: "muted" }],
		};
	}
}
