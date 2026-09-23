import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type CheckCommand, isPinnedCheckImage, structuralCheck } from "../config/project.ts";

const exec = promisify(execFile);
const files = [
	"SPEC.md",
	"showcase.py",
	"atlas/__init__.py",
	"atlas/contracts.py",
	"atlas/jobs.py",
	"atlas/api.py",
	"atlas/client.py",
	"tests/__init__.py",
	"tests/test_contracts.py",
	"tests/test_jobs.py",
	"tests/test_api.py",
	"tests/test_client.py",
	"tests/test_workflow.py",
	"tests/test_concurrency.py",
];
export const DEMO_OBJECTIVE =
	"Implement the asynchronous report export workflow in SPEC.md across contracts, jobs, HTTP API and SDK. Preserve all existing behavior and pass the frozen final acceptance checks. Keep the supplied tests unchanged.";

/** Creates an independent source repository. No model invocation, solution patch or fake completion. */
export async function createDemoProject(destination: string, image?: string) {
	if (image && !isPinnedCheckImage(image))
		throw new Error("Demo image must be an installed immutable sha256 ID or repo@sha256 digest");
	const repository = resolve(destination);
	let template: string | undefined;
	for (const relative of ["../examples/export-workflow", "../../examples/export-workflow"]) {
		const candidate = resolve(dirname(fileURLToPath(import.meta.url)), relative);
		try {
			await access(join(candidate, "SPEC.md"));
			template = candidate;
			break;
		} catch {
			/* Try source layout. */
		}
	}
	if (!template) throw new Error("Demo templates are missing from this installation");
	const source = await Promise.all(
		files.map(async (name) => ({ name, content: await readFile(join(template as string, name)) })),
	);
	await mkdir(repository); // Deliberately refuses an existing directory.
	for (const { name, content } of source) {
		await mkdir(dirname(join(repository, name)), { recursive: true });
		await writeFile(join(repository, name), content, { flag: "wx" });
	}
	await writeFile(join(repository, ".gitignore"), "__pycache__/\n*.pyc\n");
	const check = (name: string, modules: string[], scope?: string[]): CheckCommand => ({
		name,
		argv: ["python3", "-B", "-m", "unittest", ...modules],
		timeoutMs: 30_000,
		lane: "LIGHT_CHECK",
		evidenceClass: "BEHAVIORAL",
		scope,
		oracle: { protectedPaths: ["tests"] },
		...(image ? { isolation: { kind: "DOCKER" as const, image } } : {}),
	});
	const integrationChecks = ["contracts", "jobs", "api", "client"].map((module) =>
		check(module + "-regression", ["tests.test_" + module], ["atlas/" + module + ".py"]),
	);
	await writeFile(
		join(repository, ".tripleteam.json"),
		JSON.stringify(
			{
				candidateChecks: [structuralCheck("candidate")],
				integrationChecks,
				runChecks: [
					check("existing-behavior", [
						"tests.test_contracts",
						"tests.test_jobs",
						"tests.test_api",
						"tests.test_client",
					]),
					check("export-workflow", ["tests.test_workflow", "tests.test_concurrency"]),
				],
				execution: {
					policy: "ADAPTIVE",
					maxParallelism: 3,
					tokenLimit: 2_000_000,
					costLimitUsd: 5,
					deadlineMs: 1_200_000,
					maxExecutions: 30,
				},
				assurance: { mode: "adaptive", ...(image ? { isolation: { kind: "DOCKER", image } } : {}) },
			},
			null,
			2,
		) + "\n",
	);
	const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args])).stdout.trim();
	await git("init", "-b", "main");
	await git("config", "user.name", "TripleTeam Demo");
	await git("config", "user.email", "demo@example.test");
	await git("add", ".");
	await git("commit", "-m", "Atlas reporting service with public feature specification");
	return {
		repository,
		inputCommit: await git("rev-parse", "HEAD"),
		objective: DEMO_OBJECTIVE,
		verification: image
			? "Pinned Docker behavioral checks"
			: "Native checks; delivery is STRUCTURAL_HANDOFF until protected isolation is configured",
		next: [
			"Configure models with tripleteam model all provider/model inside this repository",
			"Run tripleteam run with the objective above",
			"Inspect /why, /tasks and /delivery in the interactive CLI",
		],
	};
}
