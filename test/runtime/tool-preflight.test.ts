import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkPiSearchTools } from "../../src/runtime/pi/tool-preflight.ts";

const execFileAsync = promisify(execFile);
const originalToolDirectory = join(getAgentDir(), "bin");
const originalPath = process.env.PATH ?? "";
const extension = process.platform === "win32" ? ".exe" : "";

async function installedBinary(name: "rg" | "fd"): Promise<string | null> {
	const names = name === "fd" ? ["fd", "fdfind"] : ["rg"];
	const candidates = [
		join(originalToolDirectory, name + extension),
		...originalPath
			.split(delimiter)
			.filter(Boolean)
			.flatMap((directory) => names.map((item) => join(directory, item + extension))),
	];
	for (const candidate of candidates) {
		try {
			await execFileAsync(candidate, ["--version"], { timeout: 2_000 });
			return candidate;
		} catch {
			// No downloads: success cases require an existing local executable.
		}
	}
	return null;
}

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "tripleteam-preflight-test-"));
	const agent = join(root, "pi");
	const temporary = join(root, "temporary");
	const binaries = join(root, "path");
	await Promise.all([mkdir(agent), mkdir(temporary), mkdir(binaries)]);
	const environment = {
		PI_CODING_AGENT_DIR: agent,
		PI_OFFLINE: "0", // The adapter must independently force offline mode in its child.
		PATH: binaries,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	context.after(async () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	return { root, agent, temporary, binaries };
}

async function cacheBinary(agent: string, name: string, source: string) {
	const cache = join(agent, "bin");
	await mkdir(cache, { recursive: true });
	const target = join(cache, name + extension);
	await copyFile(source, target);
	await chmod(target, 0o755);
}

test("Pi public grep and find retrieve real sentinel data from an isolated tool cache", async (context) => {
	const [rg, fd] = await Promise.all([installedBinary("rg"), installedBinary("fd")]);
	if (!rg || !fd)
		return context.skip("Install ripgrep and fd/fdfind or prepare Pi's cache to exercise real search tools");
	const { agent, temporary } = await fixture(context);
	await cacheBinary(agent, "rg", rg);
	await cacheBinary(agent, "fd", fd);
	assert.deepEqual(await checkPiSearchTools(["read", "grep", "find", "grep"]), { grep: "ok", find: "ok" });
	assert.deepEqual(await readdir(temporary), []);
	assert.equal(process.env.PI_OFFLINE, "0");
});

test("a grep-only role does not require fd", async (context) => {
	const rg = await installedBinary("rg");
	if (!rg) return context.skip("Install ripgrep or prepare Pi's cache to exercise real grep");
	const { agent, temporary } = await fixture(context);
	await cacheBinary(agent, "rg", rg);
	assert.deepEqual(await checkPiSearchTools(["grep"]), { grep: "ok" });
	assert.deepEqual(await readdir(temporary), []);
});

test("a find-only role accepts Pi's documented fdfind alternative on PATH", async (context) => {
	const fd = await installedBinary("fd");
	if (!fd) return context.skip("Install fd/fdfind or prepare Pi's cache to exercise real find");
	const { agent, binaries, temporary } = await fixture(context);
	const target = join(binaries, "fdfind" + extension);
	await copyFile(fd, target);
	await chmod(target, 0o755);
	assert.deepEqual(await checkPiSearchTools(["find"]), { find: "ok" });
	assert.deepEqual(await readdir(agent), []);
	assert.deepEqual(await readdir(temporary), []);
});

test("missing tools fail offline without fetching or populating the isolated Pi registry", async (context) => {
	const { root, agent, temporary } = await fixture(context);
	const marker = join(root, "unexpected-network");
	const preload = join(root, "block-network.mjs");
	await writeFile(
		preload,
		`import {appendFileSync} from 'node:fs'; globalThis.fetch = () => { appendFileSync(${JSON.stringify(marker)}, 'network requested'); throw new Error('Unexpected network access'); };`,
	);
	const previous = process.env.NODE_OPTIONS;
	process.env.NODE_OPTIONS = "--import=" + pathToFileURL(preload).href;
	context.after(() => {
		if (previous === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = previous;
	});
	for (const name of ["grep", "find"]) {
		await assert.rejects(checkPiSearchTools([name]), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /offline/);
			assert.match(error.message, /Install ripgrep \(rg\) and fd\/fdfind/);
			assert.match(error.message, /not available/);
			assert.doesNotMatch(error.message, /Unexpected network access/);
			return true;
		});
		await assert.rejects(access(marker), { code: "ENOENT" });
		assert.deepEqual(await readdir(agent), []);
		assert.deepEqual(await readdir(temporary), []);
	}
});

test("roles without grep or find skip subprocess and temporary workspace creation", async (context) => {
	const { agent, temporary } = await fixture(context);
	assert.deepEqual(await checkPiSearchTools([]), {});
	assert.deepEqual(await checkPiSearchTools(["read", "write", "ls"]), {});
	assert.deepEqual(await readdir(agent), []);
	assert.deepEqual(await readdir(temporary), []);
});

test(
	"an executable that returns no sentinel cannot pass and tool error output is preserved",
	{ skip: process.platform === "win32" },
	async (context) => {
		const { agent, temporary } = await fixture(context);
		const cache = join(agent, "bin");
		await mkdir(cache);
		const tool = join(cache, "fd");
		await writeFile(tool, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
		await assert.rejects(checkPiSearchTools(["find"]), /could not retrieve its sentinel/);
		await writeFile(tool, `#!${process.execPath}\nprocess.stderr.write('fixture-fd-failure'); process.exit(2);\n`);
		await assert.rejects(checkPiSearchTools(["find"]), /fixture-fd-failure/);
		assert.deepEqual(await readdir(temporary), []);
	},
);
