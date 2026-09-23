import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
	createFindTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { registerWorkspaceSearchPolicy } from "../../src/runtime/pi/search-policy.ts";

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "tripleteam-search-policy-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, "worktree");
	const sibling = join(directory, "worktree-other");
	await mkdir(join(cwd, "src"), { recursive: true });
	await mkdir(join(cwd, "space dir"));
	await mkdir(sibling);
	await writeFile(join(cwd, "src", "index.txt"), "public fixture\n");
	await writeFile(join(sibling, "outside.txt"), "outside worktree\n");
	let hook: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined;
	let registrations = 0;
	registerWorkspaceSearchPolicy({
		on: (name: string, handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) => {
			assert.equal(name, "tool_call");
			registrations++;
			hook = handler;
			return () => {};
		},
	} as ExtensionAPI);
	assert.equal(registrations, 1, "the policy must use Pi's public tool hook without registering replacement tools");
	assert.ok(hook);
	const call = async (toolName: string, path?: unknown, from = cwd) => {
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "search-fixture",
			toolName,
			input: path === undefined ? { pattern: "fixture" } : { pattern: "fixture", path },
		};
		const original = structuredClone(event);
		const result = await hook?.(event, { cwd: from } as ExtensionContext);
		assert.deepEqual(event, original, "the policy must leave Pi's tool arguments unchanged");
		return result ?? undefined;
	};
	return { cwd, sibling, directory, call };
}

function blocked(result: ToolCallEventResult | undefined) {
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /current worktree/);
	assert.match(result?.reason ?? "", /relative path/);
	assert.equal(result?.terminate, undefined, "a bad search path should leave Pi able to correct the call");
}

for (const toolName of ["grep", "find"]) {
	test(`${toolName} rejects filesystem roots, parent traversal and sibling-prefix paths`, async (context) => {
		const state = await fixture(context);
		for (const path of [
			parse(state.cwd).root,
			"..",
			"../worktree-other",
			state.sibling,
			join(state.sibling, "outside.txt"),
			"src/../..",
		])
			blocked(await state.call(toolName, path));
	});

	test(`${toolName} allows defaults, contained absolute paths, ordinary files and normalized relative paths`, async (context) => {
		const state = await fixture(context);
		for (const path of [undefined, "", ".", "src", "src/../src", "src/index.txt", state.cwd, join(state.cwd, "src")])
			assert.equal(await state.call(toolName, path), undefined, `expected ordinary worktree path ${path} to pass`);
	});

	test(`${toolName} resolves explicit symlinks and permits only destinations inside its worktree`, async (context) => {
		const state = await fixture(context);
		await symlink(state.sibling, join(state.cwd, "outside-link"), "dir");
		await symlink(join(state.cwd, "src"), join(state.cwd, "inside-link"), "dir");
		await symlink(join(state.sibling, "outside.txt"), join(state.cwd, "outside-file"), "file");
		for (const path of ["outside-link", "outside-link/outside.txt", "outside-file", join(state.cwd, "outside-link")])
			blocked(await state.call(toolName, path));
		assert.equal(await state.call(toolName, "inside-link"), undefined);
		assert.equal(await state.call(toolName, "inside-link/index.txt"), undefined);
	});
}

test("search normalization agrees with the pinned Pi public find tool for @, tilde and Unicode spaces", async (context) => {
	const state = await fixture(context);
	for (const [path, expected] of [
		["@src", join(state.cwd, "src")],
		[`@${join(state.cwd, "src")}`, join(state.cwd, "src")],
		["space\u00a0dir", join(state.cwd, "space dir")],
		["@space\u202fdir", join(state.cwd, "space dir")],
		["~", homedir()],
		["@~/", homedir()],
	] as const) {
		const resolved: string[] = [];
		// Public custom operations observe Pi's own path resolution without spawning fd or an agent.
		const piFind = createFindTool(state.cwd, {
			operations: {
				exists: async () => true,
				glob: async (_pattern, cwd) => {
					resolved.push(cwd);
					return [];
				},
			},
		});
		await piFind.execute("path-contract", { pattern: "*", path });
		assert.deepEqual(resolved, [expected]);
		for (const toolName of ["grep", "find"]) {
			if (path.includes("~")) blocked(await state.call(toolName, path));
			else assert.equal(await state.call(toolName, path), undefined);
		}
	}
	blocked(await state.call("grep", "@/"));
	blocked(await state.call("find", `@${state.sibling}`));
});

test("the current context worktree and its real path determine search scope for each call", async (context) => {
	const state = await fixture(context);
	const alias = join(state.directory, "worktree-alias");
	await symlink(state.cwd, alias, "dir");
	assert.equal(await state.call("find", ".", alias), undefined);
	assert.equal(await state.call("grep", await realpath(join(state.cwd, "src")), alias), undefined);
	blocked(await state.call("find", state.cwd, state.sibling));
	assert.equal(await state.call("find", ".", state.sibling), undefined);
});

test("unresolvable paths and nonordinary path forms are rejected with corrective search guidance", async (context) => {
	const state = await fixture(context);
	await symlink(join(state.directory, "missing-outside"), join(state.cwd, "dangling"), "dir");
	for (const path of [
		"missing",
		"dangling",
		"src\0ignored",
		null,
		1,
		{},
		pathToFileURL(state.cwd).href,
		"@file:///",
		"https://example.invalid/source",
	])
		blocked(await state.call("grep", path));
});

test("read, bash, ls and custom tools keep their Pi behavior", async (context) => {
	const state = await fixture(context);
	for (const toolName of ["read", "bash", "ls", "edit", "write", "powershell", "custom-search"])
		assert.equal(await state.call(toolName, "/", join(state.directory, "nonexistent-cwd")), undefined);
});
