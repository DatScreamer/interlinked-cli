// ===========================================
// Hash-chained audit verification for guard decision events
// ===========================================
// Borrowed from Microsoft Agent Governance Toolkit's audit.mjs pattern
// (`agent-governance-claude-code/lib/audit.mjs`, MIT). Maps to OWASP ASI11
// "Agent Untraceability" — tamper-evident decision audit.
//
// Scope: the chain covers `guard_block` / `guard_warn` / `guard_allow`
// records written by the hook template's `appendGuardDecision`, PLUS
// `session_end` records written by `appendLocal` (which applies chain
// fields when the event type is session_end so the chain captures *how*
// the session ended via Claude Code's `reason` field). All chained
// records live in .interlinked/activity.jsonl
// (src/lib/hook-template-chunks/session-state.ts).
//
// Non-decision entries (other event_types written by `appendLocal`)
// share the same file but live outside the chain by design — the chain's
// `previousHash` walks back to the most recent chained entry of any
// supported type, skipping transcript noise.
//
// This module is the verifier. The writer is inlined in the hook template
// so the generated .mjs stays self-contained per CLAUDE.md.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getDataDir } from "./config.js";

export const GENESIS_HASH = "0".repeat(64);
// Record types that participate in the hash chain. Originally guard_* only;
// session_end was added 2026-05 so the audit chain captures *how* sessions
// terminate (Claude Code's `reason` field). The set name is historical —
// kept for back-compat with consumers reading the field name; semantically
// these are "chained record types," not just guard decisions.
const GUARD_DECISION_TYPES = new Set([
	"guard_block",
	"guard_warn",
	"guard_allow",
	"session_end",
]);

export interface GuardChainEntry {
	ts?: string;
	type?: string;
	previousHash?: string;
	hash?: string;
	[k: string]: unknown;
}

export interface AuditVerifyResult {
	valid: boolean;
	total_events: number;
	guard_events: number;
	chained_events: number;
	unchained_guard_events: number;
	first_bad_index?: number;
	first_bad_reason?: string;
	first_bad_line_number?: number;
	last_hash?: string;
}

/**
 * Canonical JSON for a record so hash inputs are stable across re-serializations
 * (V8 preserves insertion order, but engines aren't strictly required to — we
 * don't rely on that). Keys at every level are sorted lexicographically.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Hash for one guard-decision record. The `hash` field itself is excluded
 * (recursive otherwise) but every other field — including `previousHash` —
 * is in the canonical payload. Any mutation of any captured field breaks
 * the chain at that entry.
 */
export function computeEntryHash(record: GuardChainEntry): string {
	const { hash: _ignored, ...rest } = record;
	return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}

export function getActivityPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "activity.jsonl");
}

/**
 * Read archived audit lines (compacted segments) in manifest order, gunzipped.
 * `interlinked compact` moves a synced, pre-audit-tail PREFIX of activity.jsonl
 * into .interlinked/archive/<seq>.jsonl.gz; the hash chain spans those segments
 * plus the live file, so verification must read them first. The writer is
 * src/commands/compact.ts.
 */
function readArchivedAuditLines(cwd: string): string[] {
	const dir = join(getDataDir(cwd), "archive");
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) return [];
	let parsed: { segments?: Array<{ file?: string; seq?: number }> };
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch {
		return [];
	}
	const segments = Array.isArray(parsed.segments) ? [...parsed.segments] : [];
	segments.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	const lines: string[] = [];
	for (const seg of segments) {
		if (typeof seg.file !== "string") continue;
		try {
			const text = gunzipSync(readFileSync(join(dir, seg.file))).toString("utf-8");
			for (const ln of text.split("\n")) {
				if (ln.trim()) lines.push(ln);
			}
		} catch {
			/* intentional: skip an unreadable segment rather than abort verify */
		}
	}
	return lines;
}

/**
 * Walk activity.jsonl forward, treating guard_* entries with a `hash` field
 * as chain links. Returns the first integrity failure (or success at end).
 *
 * Mixed-file tolerant: non-guard records and hashless legacy guards count
 * in `total_events` / `unchained_guard_events` but don't break the chain.
 */
export function verifyAuditChain(cwd: string = process.cwd()): AuditVerifyResult {
	const path = getActivityPath(cwd);
	const archivedLines = readArchivedAuditLines(cwd);

	let liveLines: string[] = [];
	if (existsSync(path)) {
		try {
			liveLines = readFileSync(path, "utf-8").split("\n");
		} catch (err) {
			return {
				valid: false,
				total_events: 0,
				guard_events: 0,
				chained_events: 0,
				unchained_guard_events: 0,
				first_bad_reason: `activity.jsonl unreadable: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	const lines = [...archivedLines, ...liveLines];
	let totalEvents = 0;
	let guardEvents = 0;
	let chainedEvents = 0;
	let unchainedGuardEvents = 0;
	let expectedPrev = GENESIS_HASH;
	let lastHash: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].trim();
		if (!raw) continue;
		totalEvents += 1;

		let record: GuardChainEntry;
		try {
			record = JSON.parse(raw) as GuardChainEntry;
		} catch {
			// Malformed JSONL line: a transcript writer crashed mid-write or
			// something corrupted the file. The chain itself doesn't reach
			// across non-decision noise, so we keep walking.
			continue;
		}

		const type = typeof record.type === "string" ? record.type : "";
		if (!GUARD_DECISION_TYPES.has(type)) continue;
		guardEvents += 1;

		const hasHash = typeof record.hash === "string" && record.hash.length === 64;
		if (!hasHash) {
			unchainedGuardEvents += 1;
			continue;
		}

		const previousHash =
			typeof record.previousHash === "string" ? record.previousHash : "";

		if (!safeEqualHex(previousHash, expectedPrev)) {
			return {
				valid: false,
				total_events: totalEvents,
				guard_events: guardEvents,
				chained_events: chainedEvents,
				unchained_guard_events: unchainedGuardEvents,
				first_bad_index: chainedEvents,
				first_bad_line_number: i + 1,
				first_bad_reason: `previousHash mismatch at chained event #${chainedEvents}: expected ${expectedPrev.slice(0, 12)}…, got ${previousHash.slice(0, 12) || "(missing)"}…`,
				last_hash: lastHash,
			};
		}

		const expectedHash = computeEntryHash(record);
		if (!safeEqualHex(record.hash as string, expectedHash)) {
			return {
				valid: false,
				total_events: totalEvents,
				guard_events: guardEvents,
				chained_events: chainedEvents,
				unchained_guard_events: unchainedGuardEvents,
				first_bad_index: chainedEvents,
				first_bad_line_number: i + 1,
				first_bad_reason: `hash mismatch at chained event #${chainedEvents}: payload yields ${expectedHash.slice(0, 12)}…, stored ${String(record.hash).slice(0, 12)}…`,
				last_hash: lastHash,
			};
		}

		chainedEvents += 1;
		expectedPrev = record.hash as string;
		lastHash = record.hash as string;
	}

	return {
		valid: true,
		total_events: totalEvents,
		guard_events: guardEvents,
		chained_events: chainedEvents,
		unchained_guard_events: unchainedGuardEvents,
		last_hash: lastHash,
	};
}
