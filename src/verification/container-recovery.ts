import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRepositoryKey } from "./check-integrity.ts";

const execFileAsync = promisify(execFile);

export interface CheckContainerRecovery {
	removedIds: string[];
	skippedIds: string[];
	error?: string;
}

function hasLiveOwner(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Only expired verification containers from this host/repository with a dead owner are eligible. */
export async function reconcileCheckContainers(repositoryRoot: string): Promise<CheckContainerRecovery> {
	const report: CheckContainerRecovery = { removedIds: [], skippedIds: [] };
	try {
		const repositoryKey = await checkRepositoryKey(repositoryRoot);
		const { stdout } = await execFileAsync(
			"docker",
			[
				"ps",
				"--all",
				"--quiet",
				"--filter",
				"label=io.tripleteam.kind=verification",
				"--filter",
				"label=io.tripleteam.repository=" + repositoryKey,
			],
			{ encoding: "utf8", timeout: 5_000 },
		);
		const ids = stdout.trim().split(/\s+/).filter(Boolean);
		for (const id of ids) {
			if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Docker returned an invalid verification container ID");
			const { stdout: inspected } = await execFileAsync("docker", ["inspect", id], {
				encoding: "utf8",
				timeout: 5_000,
			});
			const container = (
				JSON.parse(inspected) as Array<{ Name?: string; Config?: { Labels?: Record<string, string> } }>
			)[0];
			const labels = container?.Config?.Labels;
			const owner = Number(labels?.["io.tripleteam.owner-pid"]);
			const expires = Number(labels?.["io.tripleteam.expires-at"]);
			if (
				labels?.["io.tripleteam.kind"] !== "verification" ||
				labels?.["io.tripleteam.repository"] !== repositoryKey ||
				!container?.Name?.startsWith("/tripleteam-check-") ||
				!Number.isSafeInteger(owner) ||
				owner <= 0 ||
				!Number.isSafeInteger(expires) ||
				expires <= 0 ||
				expires > Date.now() ||
				hasLiveOwner(owner)
			) {
				report.skippedIds.push(id);
				continue;
			}
			await execFileAsync("docker", ["rm", "--force", id], { encoding: "utf8", timeout: 10_000 });
			report.removedIds.push(id);
		}
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
	}
	return report;
}
