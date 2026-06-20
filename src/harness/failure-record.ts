// ===========================================
// Phase 1 — Failure record persistence
// ===========================================
// Disk substrate for the local failure-recovery channel. Each tool failure
// gets one canonical record at `.interlinked/failures/<failure_id>.json`
// holding all five Channel outputs (recurrence count, triage, recovery,
// rollback, explanation). A single append-only index at
// `.interlinked/failures/index.jsonl` lets `interlinked failures list`
// (future CLI surface) walk the records in O(events).
//
// Phase 2 cloud receipts at `.interlinked/checks/<receipt_id>.json` will
// reference `failure_id` rather than duplicating the contents — Phase 1
// stands alone, Phase 2 augments.
//
// File-id generation uses UUID v7 for deterministic time-ordering when
// listing records. v7 is standardized in IETF rfc4122-bis (April 2024) and
// available via Node 21+'s `crypto.randomUUID({ disableEntropyCache: true })`
// without a third-party dep, but for older Node and to keep the runtime
// dependency surface zero, we hand-roll a v7 generator below.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomFillSync } from "node:crypto";

import type { FailureRecord } from "./types.js";
import { nonNull } from "../lib/non-null.js";

const FAILURES_DIR = ".interlinked/failures";

/** Public API — persist a failure record to disk. Side effects only;
 *  storage failures are surfaced as exceptions so the caller (which fires
 *  on the PostToolUse hot path) can swallow them defensively without
 *  this module embedding the policy. */
export function writeFailureRecord(record: FailureRecord, cwd: string): void {
	const failuresDir = join(cwd, FAILURES_DIR);
	mkdirSync(failuresDir, { recursive: true });
	const recordPath = join(failuresDir, `${record.failure_id}.json`);
	writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf-8");

	const indexPath = join(failuresDir, "index.jsonl");
	const indexRow = {
		failure_id: record.failure_id,
		session_id: record.session_id,
		signature: record.signature,
		tool_name: record.tool_name,
		ts: record.timestamp,
	};
	appendFileSync(indexPath, `${JSON.stringify(indexRow)}\n`, "utf-8");
}

/** Public API — generate a UUIDv7 prefixed with `fail_`. Sortable by
 *  creation time (Unix ms milliseconds in the high 48 bits), 74 bits of
 *  randomness for collision resistance. */
export function mintFailureId(now: number = Date.now()): string {
	const bytes = new Uint8Array(16);
	randomFillSync(bytes);

	// Bytes 0-5: 48-bit Unix timestamp (ms), big-endian.
	const ts = BigInt(now);
	bytes[0] = Number((ts >> 40n) & 0xffn);
	bytes[1] = Number((ts >> 32n) & 0xffn);
	bytes[2] = Number((ts >> 24n) & 0xffn);
	bytes[3] = Number((ts >> 16n) & 0xffn);
	bytes[4] = Number((ts >> 8n) & 0xffn);
	bytes[5] = Number(ts & 0xffn);

	// Byte 6: version 7 in the top 4 bits, random in the low 4.
	bytes[6] = (nonNull(bytes[6]) & 0x0f) | 0x70;
	// Byte 8: variant 10xx in the top 2 bits.
	bytes[8] = (nonNull(bytes[8]) & 0x3f) | 0x80;

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const formatted =
		`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
		`${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	return `fail_${formatted}`;
}

/** Public API — used by callers that want to point at the on-disk record
 *  in user-facing output (e.g. the channel summary line). Returns the
 *  cwd-relative path so output is portable across machines. */
export function failureRecordRelPath(failureId: string): string {
	return join(FAILURES_DIR, `${failureId}.json`);
}

/** Test seam: makes the v7 byte layout assertable without forcing a real
 *  random source. Returns the same UUID-shaped string but with all-zero
 *  randomness — useful for golden-file tests. */
export function mintFailureIdFromTimestamp(timestampMs: number, randomBytes: Uint8Array): string {
	if (randomBytes.length !== 10) {
		throw new Error(`mintFailureIdFromTimestamp expects 10 random bytes (got ${randomBytes.length})`);
	}
	const bytes = new Uint8Array(16);
	const ts = BigInt(timestampMs);
	bytes[0] = Number((ts >> 40n) & 0xffn);
	bytes[1] = Number((ts >> 32n) & 0xffn);
	bytes[2] = Number((ts >> 24n) & 0xffn);
	bytes[3] = Number((ts >> 16n) & 0xffn);
	bytes[4] = Number((ts >> 8n) & 0xffn);
	bytes[5] = Number(ts & 0xffn);
	for (let i = 0; i < 10; i++) bytes[6 + i] = nonNull(randomBytes[i]);
	bytes[6] = (nonNull(bytes[6]) & 0x0f) | 0x70;
	bytes[8] = (nonNull(bytes[8]) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	const formatted =
		`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
		`${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	return `fail_${formatted}`;
}

