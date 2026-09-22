import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkRepositoryKey } from "../../src/verification/check-integrity.ts";
import { reconcileCheckContainers } from "../../src/verification/container-recovery.ts";

const execFileAsync = promisify(execFile);

test(
	"Docker recovery removes only expired dead-owner containers for this repository",
	{ skip: !process.env.TRIPLETEAM_TEST_DOCKER_IMAGE },
	async (context) => {
		const directory = await mkdtemp(join(tmpdir(), "tripleteam-container-recovery-"));
		context.after(() => rm(directory, { recursive: true, force: true }));
		await execFileAsync("git", ["init", directory]);
		await writeFile(join(directory, "file.txt"), "fixture");
		const repositoryKey = await checkRepositoryKey(directory);
		const image = process.env.TRIPLETEAM_TEST_DOCKER_IMAGE as string;
		const ids: string[] = [];
		context.after(async () => {
			for (const id of ids) {
				try {
					await execFileAsync("docker", ["rm", "--force", id], { timeout: 10_000 });
				} catch {
					/* Already recovered. */
				}
			}
		});
		async function container(repository: string, owner: number, expires: number): Promise<string> {
			const { stdout } = await execFileAsync(
				"docker",
				[
					"run",
					"--detach",
					"--pull=never",
					"--name",
					"tripleteam-check-" + randomUUID(),
					"--label",
					"io.tripleteam.kind=verification",
					"--label",
					"io.tripleteam.repository=" + repository,
					"--label",
					"io.tripleteam.owner-pid=" + owner,
					"--label",
					"io.tripleteam.expires-at=" + expires,
					"--network=none",
					"--read-only",
					"--entrypoint",
					"python3",
					image,
					"-c",
					"import time; time.sleep(60)",
				],
				{ encoding: "utf8", timeout: 10_000 },
			);
			const id = stdout.trim();
			ids.push(id);
			return id;
		}
		const expired = await container(repositoryKey, 2_147_483_647, Date.now() - 1_000);
		const live = await container(repositoryKey, process.pid, Date.now() - 1_000);
		const unexpired = await container(repositoryKey, 2_147_483_647, Date.now() + 60_000);
		const other = await container("another-repository", 2_147_483_647, Date.now() - 1_000);
		const result = await reconcileCheckContainers(directory);
		assert.equal(result.error, undefined);
		assert.equal(result.removedIds.length, 1);
		assert.ok(expired.startsWith(result.removedIds[0] as string));
		assert.equal(result.skippedIds.length, 2);
		for (const id of [live, unexpired, other]) {
			assert.equal(
				(
					await execFileAsync("docker", ["inspect", "--format", "{{.State.Running}}", id], { encoding: "utf8" })
				).stdout.trim(),
				"true",
			);
		}
	},
);
