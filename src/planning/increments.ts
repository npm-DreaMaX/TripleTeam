import { checkCommandVersion, type FrozenAcceptancePolicy } from "../config/project.ts";
import { normalizeTaskScope, scopesOverlap } from "../control/scope.ts";
import type { BaselineReceipt } from "../verification/baseline.ts";
import type { PlannedTask, TaskPlan } from "./plan.ts";

/** Compile a proposed DAG into independently verifiable increments without dropping obligations. */
export function compileIncrements(
	plan: TaskPlan,
	policy: FrozenAcceptancePolicy,
	baseline?: BaselineReceipt | null,
): {
	plan: TaskPlan;
	groups: string[][];
	reasons: string[];
} {
	const parents = new Map(plan.tasks.map((task) => [task.key, task.key]));
	const root = (key: string): string => {
		const parent = parents.get(key);
		if (parent === undefined) throw new Error("Unknown task in increment graph: " + key);
		if (parent === key) return key;
		const resolved = root(parent);
		parents.set(key, resolved);
		return resolved;
	};
	const union = (keys: string[]) => {
		const first = keys[0];
		if (first) for (const key of keys.slice(1)) parents.set(root(key), root(first));
	};
	const reasons: string[] = [];
	for (const check of [...policy.candidateChecks, ...policy.integrationChecks]) {
		const failed = baseline?.checks.some(
			(item) => item.name === check.name && item.version === checkCommandVersion(check) && item.state === "FAILED",
		);
		if (!check.atomic && !failed) continue;
		const keys = plan.tasks.filter((task) => !check.scope || scopesOverlap(check.scope, task.scope)).map((t) => t.key);
		if (keys.length > 1) {
			union(keys);
			reasons.push(
				`${check.name}: ${check.atomic ? "frozen atomic check scope" : "baseline fails; intermediate acceptance is not established"}`,
			);
		}
	}
	// Contracting non-adjacent DAG vertices can introduce a cycle. Close over the intervening vertices.
	for (;;) {
		const edges = new Map<string, string[]>();
		for (const task of plan.tasks) edges.set(root(task.key), []);
		for (const edge of plan.dependencies) {
			const a = root(edge.task),
				b = root(edge.dependsOn);
			if (a !== b) edges.get(a)?.push(b);
		}
		const done = new Set<string>();
		let cycle: string[] | undefined;
		const visit = (key: string, path: string[]) => {
			if (cycle) return;
			const index = path.indexOf(key);
			if (index >= 0) {
				cycle = path.slice(index);
				return;
			}
			if (done.has(key)) return;
			for (const next of edges.get(key) ?? []) visit(next, [...path, key]);
			done.add(key);
		};
		for (const key of edges.keys()) visit(key, []);
		if (!cycle) break;
		union(cycle);
		reasons.push("Closed an atomic increment over its dependency path");
	}
	const groups = [...new Set(plan.tasks.map((task) => root(task.key)))].map((key) =>
		plan.tasks.filter((task) => root(task.key) === key),
	);
	const unique = (values: string[]) => [...new Set(values)];
	const tasks = groups.map((members): PlannedTask => {
		const first = members[0] as PlannedTask;
		if (members.length === 1) return first;
		const provides = unique(members.flatMap((task) => task.interface.provides));
		const obligations = new Map<string, NonNullable<PlannedTask["interface"]["obligations"]>[number]>();
		for (const obligation of members.flatMap((task) => task.interface.obligations ?? [])) {
			const previous = obligations.get(obligation.key);
			obligations.set(obligation.key, {
				key: obligation.key,
				artifactPaths: unique([...(previous?.artifactPaths ?? []), ...obligation.artifactPaths]),
				checkNames: unique([...(previous?.checkNames ?? []), ...obligation.checkNames]),
			});
		}
		const requires = unique(members.flatMap((task) => task.interface.requires)).filter(
			(key) => !provides.includes(key),
		);
		const risks = ["LOW", "NORMAL", "HIGH"] as const;
		return {
			key: root(first.key),
			title: members
				.map((t) => t.title)
				.join(" + ")
				.slice(0, 500),
			objective: members.map((t) => `Increment ${t.key}: ${t.objective}`).join("\n\n"),
			scope: members.some((t) => normalizeTaskScope(t.scope).length === 0)
				? ["."]
				: unique(members.flatMap((t) => t.scope)),
			constraints: unique(members.flatMap((t) => t.constraints)),
			riskClass: risks[Math.max(...members.map((t) => risks.indexOf(t.riskClass)))] as PlannedTask["riskClass"],
			priority: Math.max(...members.map((t) => t.priority)),
			coordination: {
				decomposability: "LOW",
				sequentiality: "HIGH",
				semanticCoupling: "HIGH",
				integrationCost: "MEDIUM",
				uncertainty: members.some((t) => t.coordination.uncertainty === "HIGH") ? "HIGH" : "MEDIUM",
				rationale: "One acceptance unit for coupled changes: " + members.map((t) => t.key).join(", "),
				evidenceRefs: unique(members.flatMap((t) => t.coordination.evidenceRefs)),
				explorationQuestions: [],
			},
			interface: {
				provides,
				requires,
				assumptions: unique(members.flatMap((t) => t.interface.assumptions)),
				interfaces: unique(members.flatMap((t) => t.interface.interfaces)),
				evidenceRefs: unique(members.flatMap((t) => t.interface.evidenceRefs)),
				obligations: [...obligations.values()],
			},
		};
	});
	const dependencies = plan.dependencies
		.map((edge) => ({ ...edge, task: root(edge.task), dependsOn: root(edge.dependsOn) }))
		.filter(
			(edge, index, all) =>
				edge.task !== edge.dependsOn &&
				all.findIndex(
					(other) => other.task === edge.task && other.dependsOn === edge.dependsOn && other.kind === edge.kind,
				) === index,
		);
	return {
		plan: { tasks, dependencies },
		groups: groups.filter((g) => g.length > 1).map((g) => g.map((t) => t.key)),
		reasons,
	};
}
