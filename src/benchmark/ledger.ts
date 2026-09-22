import type { LocalOrchestrator } from "../app/orchestrator.ts";
import { canonicalJson, type FrozenBenchmarkManifest } from "./manifest.ts";
import type { BenchmarkTrial } from "./metrics.ts";

export interface TrialMapping {
	manifest_hash: string;
	instance_id: string;
	run_id: string;
	started_at: string;
	input_hash: string;
	result_json: string | null;
	submitted: number;
}

/** Adapter metadata shares the repository's authoritative SQLite database. */
export class BenchmarkLedger {
	constructor(private readonly orchestrator: LocalOrchestrator) {
		orchestrator.database.sql.exec(`
CREATE TABLE IF NOT EXISTS benchmark_manifests (
 hash TEXT PRIMARY KEY, manifest_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS benchmark_trials (
 manifest_hash TEXT NOT NULL REFERENCES benchmark_manifests(hash),
 instance_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
 started_at TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT,
 submitted INTEGER NOT NULL DEFAULT 0 CHECK(submitted IN (0,1)),
 PRIMARY KEY(manifest_hash, instance_id)
) STRICT;
CREATE TABLE IF NOT EXISTS benchmark_campaigns (
 manifest_hash TEXT PRIMARY KEY REFERENCES benchmark_manifests(hash),
 current_head TEXT NOT NULL, started_at TEXT NOT NULL
) STRICT;`);
	}

	register(frozen: FrozenBenchmarkManifest): void {
		const encoded = canonicalJson(frozen.manifest);
		this.orchestrator.database.sql
			.prepare("INSERT OR IGNORE INTO benchmark_manifests(hash,manifest_json) VALUES (?,?)")
			.run(frozen.sha256, encoded);
		const stored = this.orchestrator.database.sql
			.prepare("SELECT manifest_json FROM benchmark_manifests WHERE hash = ?")
			.get<{ manifest_json: string }>(frozen.sha256);
		if (stored?.manifest_json !== encoded) throw new Error("Benchmark manifest identity mismatch");
	}

	get(manifestHash: string, instanceId: string): TrialMapping | undefined {
		return this.orchestrator.database.sql
			.prepare("SELECT * FROM benchmark_trials WHERE manifest_hash = ? AND instance_id = ?")
			.get<TrialMapping>(manifestHash, instanceId);
	}

	list(manifestHash: string): TrialMapping[] {
		return this.orchestrator.database.sql
			.prepare("SELECT * FROM benchmark_trials WHERE manifest_hash = ? ORDER BY started_at, instance_id")
			.all<TrialMapping>(manifestHash);
	}

	attach(manifestHash: string, instanceId: string, runId: string, inputHash: string): TrialMapping {
		this.orchestrator.database.sql
			.prepare(
				"INSERT INTO benchmark_trials(manifest_hash,instance_id,run_id,started_at,input_hash) VALUES (?,?,?,?,?)",
			)
			.run(manifestHash, instanceId, runId, new Date().toISOString(), inputHash);
		return this.get(manifestHash, instanceId) as TrialMapping;
	}

	recordResult(trial: BenchmarkTrial): BenchmarkTrial {
		const current = this.get(trial.manifestHash, trial.instanceId);
		if (!current || current.run_id !== trial.runId) throw new Error("Trial result has no matching durable run mapping");
		if (current.result_json) return JSON.parse(current.result_json) as BenchmarkTrial;
		this.orchestrator.database.sql
			.prepare("UPDATE benchmark_trials SET result_json = ? WHERE manifest_hash = ? AND instance_id = ?")
			.run(canonicalJson(trial), trial.manifestHash, trial.instanceId);
		return trial;
	}

	campaign(manifestHash: string, initialHead: string): { currentHead: string; startedAt: string } {
		this.orchestrator.database.sql
			.prepare("INSERT OR IGNORE INTO benchmark_campaigns VALUES (?,?,?)")
			.run(manifestHash, initialHead, new Date().toISOString());
		const row = this.orchestrator.database.sql
			.prepare("SELECT current_head, started_at FROM benchmark_campaigns WHERE manifest_hash = ?")
			.get<{ current_head: string; started_at: string }>(manifestHash);
		if (!row) throw new Error("Campaign failed to initialize");
		return { currentHead: row.current_head, startedAt: row.started_at };
	}

	advance(manifestHash: string, instanceId: string, expectedHead: string, submittedCommit: string): void {
		const sql = this.orchestrator.database.sql;
		sql.transaction(() => {
			const updated = sql
				.prepare("UPDATE benchmark_campaigns SET current_head = ? WHERE manifest_hash = ? AND current_head = ?")
				.run(submittedCommit, manifestHash, expectedHead);
			if (updated.changes !== 1) throw new Error("Campaign integration head changed before checkpoint submission");
			sql
				.prepare("UPDATE benchmark_trials SET submitted = 1 WHERE manifest_hash = ? AND instance_id = ?")
				.run(manifestHash, instanceId);
		});
	}
}
