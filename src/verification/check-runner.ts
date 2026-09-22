import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type CheckCommand, parseCheckCommand } from "../config/project.ts";
import type { LocalResourceGovernor } from "../control/resource-governor.ts";
import {
	type CheckIntegrity,
	CheckIntegrityError,
	CheckSourceGuard,
	checkGitMount,
	checkRepositoryKey,
} from "./check-integrity.ts";

const execFileAsync = promisify(execFile);

export interface CheckContext {
	cwd: string;
	baseCommit: string;
	subjectCommit: string;
	runInputCommit: string;
	artifactDirectory: string;
}

export interface ExecutedCheck {
	state: "PASSED" | "FAILED" | "ERROR";
	exitCode?: number;
	stdoutPath: string;
	stderrPath: string;
	stdoutArtifact: OutputArtifact;
	stderrArtifact: OutputArtifact;
	environmentHash: string;
	command: string[];
	result: {
		durationMs: number;
		timedOut: boolean;
		integrity?: CheckIntegrity;
		errorCode?: string;
	};
}

export interface OutputArtifact {
	path: string;
	contentHash: string;
	sizeBytes: number;
	mediaType: "text/plain; charset=utf-8";
}

function expand(argv: string[], context: CheckContext): string[] {
	const replacements: Record<string, string> = {
		$BASE: context.baseCommit,
		$SUBJECT: context.subjectCommit,
		$RUN_INPUT: context.runInputCommit,
	};
	return argv.map((argument) => {
		let result = argument;
		for (const [token, value] of Object.entries(replacements)) result = result.replaceAll(token, value);
		return result;
	});
}

async function environmentHash(
	cwd: string,
	command: string[],
	specification: CheckCommand,
	integrity?: CheckIntegrity,
): Promise<string> {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify({
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			command,
			isolation: specification.isolation ?? "LOCAL_MONITORED",
			sourceTree: integrity?.subjectTree,
			oracleVersion: integrity?.oracleVersion,
		}),
	);
	for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Cargo.lock"]) {
		try {
			hash.update(name);
			hash.update(await readFile(join(cwd, name)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return hash.digest("hex");
}

interface CommandOutput {
	state: ExecutedCheck["state"];
	exitCode?: number;
	stdout: string;
	stderr: string;
}

async function execute(command: string[], cwd: string, signal: AbortSignal): Promise<CommandOutput> {
	signal.throwIfAborted();
	return new Promise((resolveOutput) => {
		const child = spawn(command[0] as string, command.slice(1), {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let error: Error | undefined;
		const kill = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (failure) {
				if ((failure as NodeJS.ErrnoException).code !== "ESRCH") error ??= failure as Error;
			}
		};
		const receive = (target: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= 32 * 1024 * 1024) target.push(chunk);
			else {
				error = new Error("Check output exceeded 32 MiB");
				kill();
			}
		};
		child.stdout.on("data", receive(stdout));
		child.stderr.on("data", receive(stderr));
		child.on("error", (failure) => {
			error = failure;
		});
		child.once("exit", kill); // A completed check must not leave descendants mutating its workspace.
		const onAbort = () => {
			error = new Error("Check aborted");
			kill();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		child.once("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			resolveOutput({
				state: error || code === null ? "ERROR" : code === 0 ? "PASSED" : "FAILED",
				exitCode: error || code === null ? undefined : code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8") + (error ? "\n" + error.message : ""),
			});
		});
	});
}

function mount(source: string, destination: string): string {
	return ["type=bind", "src=" + source, "dst=" + destination, "readonly"]
		.map((field) => (/[,"\r\n]/.test(field) ? '"' + field.replaceAll('"', '""') + '"' : field))
		.join(",");
}

async function dockerCommand(
	specification: CheckCommand,
	context: CheckContext,
	command: string[],
	name: string,
): Promise<string[]> {
	const isolation = specification.isolation;
	if (!isolation) return command;
	const commonGit = await checkGitMount(context.cwd);
	const repositoryKey = await checkRepositoryKey(context.cwd);
	const { stdout: imageDescription } = await execFileAsync("docker", ["image", "inspect", isolation.image], {
		encoding: "utf8",
		timeout: 10_000,
	});
	const image = (JSON.parse(imageDescription) as Array<{ Config?: { Volumes?: Record<string, unknown> } }>)[0];
	for (const volume of Object.keys(image?.Config?.Volumes ?? {})) {
		if (
			volume === "/workspace" ||
			volume.startsWith("/workspace/") ||
			(commonGit && (volume === commonGit || volume.startsWith(commonGit + "/")))
		) {
			throw new Error(
				"Verifier image declares a volume that would shadow the immutable source or Git metadata: " + volume,
			);
		}
	}
	const uid = process.getuid?.() || 65534;
	const gid = process.getgid?.() || 65534;
	return [
		"docker",
		"run",
		"--rm",
		"--pull=never",
		"--name",
		name,
		"--label",
		"io.tripleteam.kind=verification",
		"--label",
		"io.tripleteam.repository=" + repositoryKey,
		"--label",
		"io.tripleteam.owner-pid=" + process.pid,
		"--label",
		"io.tripleteam.expires-at=" + (Date.now() + specification.timeoutMs),
		"--read-only",
		"--network=none",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--pids-limit=256",
		"--memory",
		String(isolation.memoryMb ?? 2048) + "m",
		"--cpus",
		String(isolation.cpus ?? 2),
		"--user",
		`${uid}:${gid}`,
		"--workdir",
		"/workspace",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=512m",
		"--env",
		"HOME=/tmp",
		"--env",
		"TMPDIR=/tmp",
		"--env",
		"PYTHONDONTWRITEBYTECODE=1",
		"--env",
		"GIT_OPTIONAL_LOCKS=0",
		"--env",
		"GIT_CONFIG_COUNT=1",
		"--env",
		"GIT_CONFIG_KEY_0=safe.directory",
		"--env",
		"GIT_CONFIG_VALUE_0=/workspace",
		"--mount",
		mount(resolve(context.cwd), "/workspace"),
		...(commonGit ? ["--mount", mount(commonGit, commonGit)] : []),
		"--entrypoint",
		command[0] as string,
		isolation.image,
		...command.slice(1),
	];
}

export class CheckRunner {
	constructor(private readonly resources: LocalResourceGovernor) {}

	async run(specification: CheckCommand, context: CheckContext, signal?: AbortSignal): Promise<ExecutedCheck> {
		specification = parseCheckCommand(specification, "check");
		return this.resources.run(
			specification.lane,
			async () => {
				const command = expand(specification.argv, context);
				const executable = command[0];
				if (!executable) throw new Error("Check command is empty");
				const artifactsRelative = relative(resolve(context.cwd), resolve(context.artifactDirectory));
				if (!artifactsRelative.startsWith(".." + sep) && artifactsRelative !== "..") {
					throw new Error("Check artifacts must be outside the verification workspace");
				}
				await mkdir(context.artifactDirectory, { recursive: true });
				const artifactId = specification.name.replace(/[^A-Za-z0-9._-]/g, "-") + "-" + randomUUID();
				const started = Date.now();
				const timeout = AbortSignal.timeout(specification.timeoutMs);
				const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
				let state: ExecutedCheck["state"] = "PASSED";
				let exitCode: number | undefined = 0;
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				let guard: CheckSourceGuard | undefined;
				let integrity: CheckIntegrity | undefined;
				let errorCode: string | undefined;
				let environment = "";
				const containerName = specification.isolation ? "tripleteam-check-" + randomUUID() : undefined;
				try {
					guard = await CheckSourceGuard.open(
						context.cwd,
						context.subjectCommit,
						context.runInputCommit,
						specification,
					);
					integrity = guard.integrity;
					environment = await environmentHash(context.cwd, command, specification, integrity);
					const invocation = containerName
						? await dockerCommand(specification, context, command, containerName)
						: command;
					const result = await execute(invocation, context.cwd, combined);
					stdout = result.stdout;
					stderr = result.stderr;
					state = result.state;
					exitCode = result.exitCode;
					if (containerName && [125, 126, 127].includes(exitCode ?? -1)) {
						state = "ERROR";
						errorCode = "DOCKER_EXECUTION_ERROR";
					}
					await guard.finish();
					if (combined.aborted) {
						state = "ERROR";
						exitCode = undefined;
						errorCode = "CHECK_ABORTED";
					}
				} catch (error) {
					state = error instanceof CheckIntegrityError ? "FAILED" : "ERROR";
					exitCode = undefined;
					errorCode = error instanceof CheckIntegrityError ? error.code : "CHECK_RUNTIME_ERROR";
					stderr += "\n" + (error instanceof Error ? error.message : String(error));
				} finally {
					guard?.close();
					timedOut = timeout.aborted;
					if (containerName) {
						try {
							await execFileAsync("docker", ["rm", "--force", containerName], { encoding: "utf8", timeout: 10_000 });
						} catch (error) {
							if (!String((error as { stderr?: string }).stderr).includes("No such container")) {
								state = "ERROR";
								errorCode = "DOCKER_CLEANUP_ERROR";
								stderr += "\nUnable to confirm verification container cleanup: " + String(error);
							}
						}
					}
				}
				const stdoutHash = createHash("sha256").update(stdout).digest("hex");
				const stderrHash = createHash("sha256").update(stderr).digest("hex");
				const stdoutPath = join(context.artifactDirectory, artifactId + ".stdout-" + stdoutHash + ".log");
				const stderrPath = join(context.artifactDirectory, artifactId + ".stderr-" + stderrHash + ".log");
				await Promise.all([
					writeFile(stdoutPath, stdout, { flag: "wx", mode: 0o600 }),
					writeFile(stderrPath, stderr, { flag: "wx", mode: 0o600 }),
				]);
				return {
					state,
					exitCode,
					stdoutPath,
					stderrPath,
					stdoutArtifact: {
						path: stdoutPath,
						contentHash: stdoutHash,
						sizeBytes: Buffer.byteLength(stdout),
						mediaType: "text/plain; charset=utf-8",
					},
					stderrArtifact: {
						path: stderrPath,
						contentHash: stderrHash,
						sizeBytes: Buffer.byteLength(stderr),
						mediaType: "text/plain; charset=utf-8",
					},
					environmentHash:
						environment || createHash("sha256").update(JSON.stringify({ command, errorCode })).digest("hex"),
					command,
					result: { durationMs: Date.now() - started, timedOut, integrity, errorCode },
				};
			},
			signal,
		);
	}
}
