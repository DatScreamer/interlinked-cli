// ===========================================
// Durable mutation journal — authoritative manifest head
// ===========================================

import {
	asRow,
	changes,
	inTransaction,
	numberField,
	parsedJson,
	requireTimestamp,
	stableJson,
	stableJsonHash,
	stringField,
	validateManifestAuthority,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import type {
	InitializeManifestHeadOutcome,
	InitializeMutationManifestHead,
	JournalManifestHead,
	MutationManifestAuthority,
} from "./mutation-journal-types.js";

function headFromRow(value: unknown): JournalManifestHead {
	const row = asRow(value, "manifest head");
	const snapshotJson = stringField(row, "snapshot_json");
	const storedHash = stringField(row, "snapshot_sha256");
	if (stableJsonHash(snapshotJson) !== storedHash) {
		throw new Error("mutation manifest head hash does not match its stored snapshot");
	}
	return Object.freeze({
		version: numberField(row, "version"),
		snapshot: parsedJson(snapshotJson),
		hash: storedHash,
	});
}

export function readManifestHead(
	db: SqliteDatabase,
	authority: MutationManifestAuthority,
): JournalManifestHead | null {
	validateManifestAuthority(authority);
	const row = db.prepare(`SELECT version, snapshot_json, snapshot_sha256
		FROM mutation_manifest_heads_v3
		WHERE tenant_id = ? AND project_id = ? AND repository_id = ?`)
		.get(authority.tenant, authority.project, authority.repository);
	return row === undefined ? null : headFromRow(row);
}

export function initializeManifestHead(
	db: SqliteDatabase,
	input: InitializeMutationManifestHead,
): InitializeManifestHeadOutcome {
	validateManifestAuthority(input.authority);
	requireTimestamp(input.initializedAtMs, "initializedAtMs");
	const snapshot = stableJson(input.snapshot);
	const hash = stableJsonHash(snapshot);
	return inTransaction(db, () => {
		const current = readManifestHead(db, input.authority);
		if (current !== null) return { kind: "existing", head: current };
		db.prepare(`INSERT INTO mutation_manifest_heads_v3
			(tenant_id, project_id, repository_id, version, snapshot_json, snapshot_sha256, updated_at_ms)
			VALUES (?, ?, ?, 0, ?, ?, ?)`).run(
			input.authority.tenant,
			input.authority.project,
			input.authority.repository,
			snapshot,
			hash,
			input.initializedAtMs,
		);
		const head = readManifestHead(db, input.authority);
		if (head === null) throw new Error("mutation manifest head initialization was not visible");
		return { kind: "initialized", head };
	});
}

export function advanceManifestHead(input: {
	db: SqliteDatabase;
	authority: MutationManifestAuthority;
	expectedVersion: number;
	snapshotJson: string;
	snapshotHash: string;
	updatedAtMs: number;
}): number {
	validateManifestAuthority(input.authority);
	if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
		throw new Error("expectedManifestVersion must be a non-negative safe integer");
	}
	const committedVersion = input.expectedVersion + 1;
	if (!Number.isSafeInteger(committedVersion)) throw new Error("manifest version overflow");
	const result = input.db.prepare(`UPDATE mutation_manifest_heads_v3
		SET version = ?, snapshot_json = ?, snapshot_sha256 = ?, updated_at_ms = ?
		WHERE tenant_id = ? AND project_id = ? AND repository_id = ? AND version = ?`).run(
		committedVersion,
		input.snapshotJson,
		input.snapshotHash,
		input.updatedAtMs,
		input.authority.tenant,
		input.authority.project,
		input.authority.repository,
		input.expectedVersion,
	);
	if (changes(result) === 1) return committedVersion;
	const current = readManifestHead(input.db, input.authority);
	if (current === null) throw new Error("mutation manifest head is not initialized");
	throw new Error(
		`stale mutation manifest head: expected version ${input.expectedVersion}, current version ${current.version}`,
	);
}
