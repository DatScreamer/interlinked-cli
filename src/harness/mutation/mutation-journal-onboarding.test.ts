// test-contract: integration — prepared onboarding bytes stay unclaimable
// until authenticated acceptance activates the normal job atomically.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqlite } from "./mutation-journal-driver.js";
import { MUTATION_JOURNAL_SCHEMA_VERSION } from "./mutation-journal-schema.js";
import { mutationJournalPath, openMutationJournal } from "./mutation-journal-sqlite.js";
import type {
	MutationJournal,
	PrepareMutationOnboardingIntent,
} from "./mutation-journal-types.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { deriveAdmission, parseMutationJobRequestV3 } from "./protocol-v3/request.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const JOB_KEY = `job_onboard_${"a".repeat(64)}`;
const ACCEPTANCE_HASH = "b".repeat(64);
const AUTHORITY = Object.freeze({
	tenant: "tenant-1",
	project: "project-1",
	repository: "github.com/example/repo",
});
const ONBOARDING_BINDING = Object.freeze({
	...AUTHORITY,
	commit: COMMIT,
	targetFile: "src/answer.ts",
});

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface IntentOptions {
	jobKey?: string;
	createdAtMs?: number;
	targetText?: string;
	sourceText?: string;
	testFiles?: string[];
	tenant?: string;
	project?: string;
}

function onboardingIntent(options: IntentOptions = {}): PrepareMutationOnboardingIntent {
	const jobKey = options.jobKey ?? JOB_KEY;
	const targetBytes = Buffer.from(options.targetText ?? "export const answer = 42;\n", "utf8");
	const sourceArtifactBytes = Buffer.from(options.sourceText ?? "deterministic git archive bytes", "utf8");
	const targetSha256 = digest(targetBytes);
	const sourceArtifactSha256 = digest(sourceArtifactBytes);
	const parsed = parseMutationJobRequestV3({
		request_version: "1",
		protocol_version: "interlinked-mutation/3.0",
		job: {
			tenant: options.tenant ?? AUTHORITY.tenant,
			project: options.project ?? AUTHORITY.project,
			repository: "github.com/example/repo",
			commit: COMMIT,
			target_file: "src/answer.ts",
			target_content_hash: targetSha256,
			job_key: jobKey,
		},
		source_artifact: {
			format: "git-archive-tar-v1",
			artifact_id: `src_git_archive_v1_${sourceArtifactSha256}`,
			sha256: sourceArtifactSha256,
			bytes: sourceArtifactBytes.byteLength,
		},
		scope_mode: "import_graph",
		test_files: options.testFiles ?? ["src/answer.test.ts"],
		changeset: [{ path: "src/answer.ts", content_hash: targetSha256 }],
	});
	if (!parsed.ok) throw new Error(parsed.reason);
	const requestBytes = Buffer.from(canonicalJson(parsed.request), "utf8");
	const admission = deriveAdmission(parsed.request);
	return {
		formatVersion: 1,
		jobKey,
		tenant: parsed.request.job.tenant,
		project: parsed.request.job.project,
		repository: parsed.request.job.repository,
		commit: parsed.request.job.commit,
		targetFile: parsed.request.job.target_file,
		requestBytes,
		requestSha256: digest(requestBytes),
		sourceArtifactId: parsed.request.source_artifact.artifact_id,
		sourceArtifactFormat: "git-archive-tar-v1",
		sourceArtifactBytes,
		sourceArtifactSha256,
		targetBytes,
		targetSha256,
		requestHash: admission.request_hash,
		changesetHash: admission.changeset_hash,
		createdAtMs: options.createdAtMs ?? 100,
	};
}

let root = "";
let journal: MutationJournal | null = null;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-journal-"));
});

afterEach(() => {
	journal?.close();
	journal = null;
	rmSync(root, { recursive: true, force: true });
});

describe("SQLite mutation onboarding journal", () => {
	it("migrates v6 through a compatible precreated v8 table and rolls back a conflicting v7 table", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const path = mutationJournalPath(root);
		const v6 = openNodeSqlite(path);
		v6.exec("DROP TABLE mutation_onboarding_intents; PRAGMA user_version = 6;");
		v6.close();
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const migrated = openNodeSqlite(path);
		// SAFETY: SQLite's PRAGMA user_version returns exactly one integer field.
		const version = migrated.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(version.user_version).toBe(MUTATION_JOURNAL_SCHEMA_VERSION);
		migrated.exec(`DROP TABLE mutation_onboarding_intents;
			CREATE TABLE mutation_onboarding_intents (sentinel TEXT NOT NULL);
			PRAGMA user_version = 6;`);
		migrated.close();
		expect(() => openMutationJournal(root)).toThrow(/mutation_onboarding_intents already exists/);
		const rolledBack = openNodeSqlite(path);
		// SAFETY: SQLite's PRAGMA user_version returns exactly one integer field.
		const rolledBackVersion = rolledBack.prepare("PRAGMA user_version").get() as { user_version: number };
		// SAFETY: PRAGMA table_info returns SQLite's documented name field.
		const columns = rolledBack.prepare("PRAGMA table_info(mutation_onboarding_intents)").all() as Array<{
			name: string;
		}>;
		expect(rolledBackVersion.user_version).toBe(6);
		expect(columns.map(({ name }) => name)).toEqual(["sentinel"]);
		rolledBack.close();
	});

	it("refuses an incompatible precreated v8 table without advancing or replacing it", () => {
		journal = openMutationJournal(root);
		journal.close();
		journal = null;
		const path = mutationJournalPath(root);
		const raw = openNodeSqlite(path);
		raw.exec(`DROP TABLE mutation_manifest_heads_v3;
			CREATE TABLE mutation_manifest_heads_v3 (sentinel TEXT NOT NULL);
			PRAGMA user_version = 7;`);
		raw.close();

		expect(() => openMutationJournal(root)).toThrow(
			"mutation_manifest_heads_v3 already exists with an incompatible schema",
		);
		const preserved = openNodeSqlite(path);
		// SAFETY: SQLite's PRAGMA user_version returns exactly one integer field.
		const version = preserved.prepare("PRAGMA user_version").get() as { user_version: number };
		// SAFETY: PRAGMA table_info returns SQLite's documented name field.
		const columns = preserved.prepare("PRAGMA table_info(mutation_manifest_heads_v3)").all() as Array<{
			name: string;
		}>;
		expect(version.user_version).toBe(7);
		expect(columns.map(({ name }) => name)).toEqual(["sentinel"]);
		preserved.close();
	});

	it("migrates v8 onboarding rows under their already-persisted full authority", () => {
		journal = openMutationJournal(root);
		const original = onboardingIntent();
		journal.prepareOnboardingIntent(original);
		journal.close();
		journal = null;
		const path = mutationJournalPath(root);
		const raw = openNodeSqlite(path);
		// SAFETY: sqlite_master returns the exact CREATE statement for this
		// repository-owned table, which the test rewrites into its v8 shape.
		const schema = raw.prepare(`SELECT sql FROM sqlite_master
			WHERE type = 'table' AND name = 'mutation_onboarding_intents'`).get() as { sql: string };
		const v8Sql = schema.sql
			.replace(/^CREATE TABLE "?mutation_onboarding_intents"?/, "CREATE TABLE mutation_onboarding_intents_v8")
			.replace(
				"UNIQUE(tenant, project, repository, commit_sha, target_file)",
				"UNIQUE(repository, commit_sha, target_file)",
			);
		if (v8Sql === schema.sql || !v8Sql.includes("UNIQUE(repository, commit_sha, target_file)")) {
			throw new Error("fixture could not derive the v8 onboarding schema");
		}
		raw.exec(`${v8Sql};
			INSERT INTO mutation_onboarding_intents_v8 SELECT * FROM mutation_onboarding_intents;
			DROP TABLE mutation_onboarding_intents;
			ALTER TABLE mutation_onboarding_intents_v8 RENAME TO mutation_onboarding_intents;
			PRAGMA user_version = 8;`);
		raw.close();

		journal = openMutationJournal(root);
		const migrated = journal.getOnboardingIntent(ONBOARDING_BINDING);
		expect(migrated).toMatchObject({
			jobKey: original.jobKey,
			tenant: original.tenant,
			project: original.project,
			state: "prepared",
		});
		expect(Buffer.from(migrated?.requestBytes ?? [])).toEqual(Buffer.from(original.requestBytes));
		const foreign = onboardingIntent({
			jobKey: `job_onboard_${"d".repeat(64)}`,
			tenant: "tenant-2",
			project: "project-2",
		});
		expect(journal.prepareOnboardingIntent(foreign).kind).toBe("prepared");
	});

	it("keeps prepared rows unclaimable and preserves exact BLOBs across reopen", () => {
		journal = openMutationJournal(root);
		const input = onboardingIntent();
		const expectedRequest = Buffer.from(input.requestBytes);
		const expectedArtifact = Buffer.from(input.sourceArtifactBytes);
		const expectedTarget = Buffer.from(input.targetBytes);
		expect(journal.prepareOnboardingIntent(input).kind).toBe("prepared");
		input.requestBytes.fill(0);
		input.sourceArtifactBytes.fill(0);
		input.targetBytes.fill(0);
		expect(journal.claimNext({ authority: AUTHORITY, owner: "worker", nowMs: 100, leaseMs: 1_000 })).toBeNull();
		journal.close();
		journal = openMutationJournal(root);
		const stored = journal.getOnboardingIntent(ONBOARDING_BINDING);
		expect(stored?.state).toBe("prepared");
		expect(Buffer.from(stored?.requestBytes ?? [])).toEqual(expectedRequest);
		expect(Buffer.from(stored?.sourceArtifactBytes ?? [])).toEqual(expectedArtifact);
		expect(Buffer.from(stored?.targetBytes ?? [])).toEqual(expectedTarget);
	});

	it("scopes onboarding identity and lookup to the full authority tuple", () => {
		journal = openMutationJournal(root);
		const local = onboardingIntent();
		const foreign = onboardingIntent({
			jobKey: `job_onboard_${"c".repeat(64)}`,
			tenant: "tenant-2",
			project: "project-2",
		});
		expect(journal.prepareOnboardingIntent(local).kind).toBe("prepared");
		expect(journal.prepareOnboardingIntent(foreign).kind).toBe("prepared");
		expect(journal.getOnboardingIntent(ONBOARDING_BINDING)?.jobKey).toBe(local.jobKey);
		expect(journal.getOnboardingIntent({
			...ONBOARDING_BINDING,
			tenant: foreign.tenant,
			project: foreign.project,
		})?.jobKey).toBe(foreign.jobKey);
		expect(journal.getOnboardingIntent({
			...ONBOARDING_BINDING,
			tenant: "tenant-missing",
			project: "project-missing",
		})).toBeNull();
	});

	it("replays only exact prepared bytes and metadata", () => {
		journal = openMutationJournal(root);
		const input = onboardingIntent();
		journal.prepareOnboardingIntent(input);
		expect(journal.prepareOnboardingIntent(onboardingIntent())).toMatchObject({ kind: "replay" });
		for (const drift of [
			onboardingIntent({ createdAtMs: 101 }),
			onboardingIntent({ sourceText: "different deterministic archive" }),
			onboardingIntent({ targetText: "export const answer = 43;\n" }),
			onboardingIntent({ testFiles: ["src/different.test.ts"] }),
			onboardingIntent({ jobKey: `job_onboard_${"c".repeat(64)}` }),
		]) {
			expect(() => journal?.prepareOnboardingIntent(drift)).toThrow("differs from its exact prepared bytes or metadata");
		}
	});

	it("activates adopt_current atomically and fences activation replay", () => {
		journal = openMutationJournal(root);
		journal.prepareOnboardingIntent(onboardingIntent());
		expect(journal.activateOnboardingIntent({
			kind: "accept",
			jobKey: JOB_KEY,
			acceptanceReceiptHash: ACCEPTANCE_HASH,
		})).toEqual({ kind: "accepted", jobId: JOB_KEY });
		expect(journal.claimNext({ authority: AUTHORITY, owner: "worker", nowMs: 199, leaseMs: 1_000 })).toBeNull();
		expect(journal.activateOnboardingIntent({
			kind: "activate",
			jobKey: JOB_KEY,
			activatedAtMs: 200,
		})).toEqual({ kind: "activated", jobId: JOB_KEY });
		const claimed = journal.claimNext({ authority: AUTHORITY, owner: "worker", nowMs: 200, leaseMs: 1_000 });
		expect(claimed).toMatchObject({
			jobId: JOB_KEY,
			remoteJobId: JOB_KEY,
			acceptanceReceiptHash: ACCEPTANCE_HASH,
			baselineIntent: "adopt_current",
		});
		journal.release({ jobId: JOB_KEY, leaseToken: claimed?.leaseToken ?? "missing", nowMs: 201 });
		expect(journal.activateOnboardingIntent({
			kind: "activate",
			jobKey: JOB_KEY,
			activatedAtMs: 200,
		})).toEqual({ kind: "replay", jobId: JOB_KEY, state: "activated" });
		expect(() => journal?.activateOnboardingIntent({
			kind: "accept",
			jobKey: JOB_KEY,
			acceptanceReceiptHash: "d".repeat(64),
		})).toThrow("acceptance replay differs");
		expect(() => journal?.activateOnboardingIntent({
			kind: "activate",
			jobKey: JOB_KEY,
			activatedAtMs: 201,
		})).toThrow("activation replay differs");
	});

	it("rolls back job insertion when activation faults and recovers after reopen", () => {
		journal = openMutationJournal(root, {
			faultInjector: (point) => {
				if (point === "inside_onboarding_activation") throw new Error("activation crash");
			},
		});
		journal.prepareOnboardingIntent(onboardingIntent());
		journal.activateOnboardingIntent({
			kind: "accept",
			jobKey: JOB_KEY,
			acceptanceReceiptHash: ACCEPTANCE_HASH,
		});
		expect(() => journal?.activateOnboardingIntent({
			kind: "activate",
			jobKey: JOB_KEY,
			activatedAtMs: 200,
		})).toThrow("activation crash");
		expect(journal.claimNext({ authority: AUTHORITY, owner: "worker", nowMs: 200, leaseMs: 1_000 })).toBeNull();
		journal.close();
		journal = openMutationJournal(root);
		expect(journal.getOnboardingIntent(ONBOARDING_BINDING)?.state).toBe("accepted");
		expect(journal.activateOnboardingIntent({
			kind: "activate",
			jobKey: JOB_KEY,
			activatedAtMs: 200,
		}).kind).toBe("activated");
	});

	it("detects exact retained-byte tampering on read", () => {
		journal = openMutationJournal(root);
		journal.prepareOnboardingIntent(onboardingIntent());
		journal.close();
		journal = null;
		const raw = openNodeSqlite(mutationJournalPath(root));
		raw.prepare("UPDATE mutation_onboarding_intents SET target_bytes = ? WHERE job_key = ?")
			.run(Buffer.from("tampered", "utf8"), JOB_KEY);
		raw.close();
		journal = openMutationJournal(root);
		expect(() => journal?.getOnboardingIntent(ONBOARDING_BINDING))
			.toThrow("target sha256 differs from requestBytes");
	});
});
