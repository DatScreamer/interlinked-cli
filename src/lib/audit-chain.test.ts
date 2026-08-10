import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalJson,
	computeEntryHash,
	GENESIS_HASH,
	verifyAuditChain,
} from "./audit-chain.js";

type ChainedRecordType = "guard_block" | "guard_warn" | "guard_allow" | "session_end";

function makeEntry(opts: {
	previousHash: string;
	type?: ChainedRecordType;
	ts?: string;
	tool?: string;
	reason?: string;
}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		schema_version: 3,
		ts: opts.ts ?? "2026-05-26T10:00:00.000Z",
		agent: "claude",
		type: opts.type ?? "guard_allow",
		tool: opts.tool ?? "Bash",
		summary: opts.reason ?? "ok",
		previousHash: opts.previousHash,
	};
	base.hash = computeEntryHash(base);
	return base;
}

function makeSessionEndEntry(opts: {
	previousHash: string;
	ts?: string;
	reason?: string;
}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		schema_version: 4,
		ts: opts.ts ?? "2026-05-26T10:30:00.000Z",
		agent: "claude",
		type: "session_end",
		reason: opts.reason ?? "prompt_input_exit",
		previousHash: opts.previousHash,
	};
	base.hash = computeEntryHash(base);
	return base;
}

function writeJsonl(path: string, records: Record<string, unknown>[]): void {
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const text = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	writeFileSync(path, text);
}

describe("canonicalJson", () => {
	it("sorts top-level keys", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts nested-object keys recursively", () => {
		expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
	});

	it("preserves array order", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	it("renders null as the literal 'null' (not the object branch)", () => {
		expect(canonicalJson(null)).toBe("null");
	});
});

describe("computeEntryHash", () => {
	it("ignores the hash field when computing", () => {
		const a = { a: 1, b: 2 };
		const b = { ...a, hash: "ffff" };
		expect(computeEntryHash(a)).toBe(computeEntryHash(b));
	});

	it("matches a sha256 of canonical JSON minus the hash field", () => {
		const record = { ts: "2026-05-26", type: "guard_block", previousHash: GENESIS_HASH };
		const expected = createHash("sha256").update(canonicalJson(record)).digest("hex");
		expect(computeEntryHash(record)).toBe(expected);
	});
});

describe("verifyAuditChain", () => {
	let tmp: string;
	let activityPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-"));
		activityPath = join(tmp, ".interlinked", "activity.jsonl");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns valid + zero counts when activity.jsonl is missing", () => {
		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(0);
		expect(res.guard_events).toBe(0);
		expect(res.chained_events).toBe(0);
	});

	it("verifies a single entry chained from genesis", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		writeJsonl(activityPath, [e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(1);
		expect(res.chained_events).toBe(1);
		expect(res.last_hash).toBe(e1.hash as string);
	});

	it("verifies a 3-entry chain end-to-end", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			type: "guard_block",
			ts: "2026-05-26T10:00:01.000Z",
		});
		const e3 = makeEntry({
			previousHash: e2.hash as string,
			type: "guard_warn",
			ts: "2026-05-26T10:00:02.000Z",
		});
		writeJsonl(activityPath, [e1, e2, e3]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(3);
		expect(res.last_hash).toBe(e3.hash as string);
	});

	it("detects a tampered payload field", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeEntry({ previousHash: e1.hash as string, ts: "2026-05-26T10:00:01.000Z" });
		// Tamper: rewrite reason but keep stored hash — verify must recompute and fail.
		const tampered = { ...e2, summary: "altered" };
		writeJsonl(activityPath, [e1, tampered]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/hash mismatch/);
	});

	it("detects a broken previousHash link", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		// Wrong previousHash. Recompute hash so the *entry's own* hash matches its
		// claimed payload — verify must still fail because the link is wrong.
		const linkBroken = makeEntry({
			previousHash: "deadbeef".repeat(8),
			ts: "2026-05-26T10:00:01.000Z",
		});
		writeJsonl(activityPath, [e1, linkBroken]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
	});

	it("counts non-guard records but does not chain them", () => {
		const transcript = {
			ts: "2026-05-26T10:00:00.000Z",
			agent: "claude",
			type: "post_tool_use",
			tool: "Read",
			summary: "transcript line",
		};
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:01.000Z" });
		writeJsonl(activityPath, [transcript, e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(2);
		expect(res.guard_events).toBe(1);
		expect(res.chained_events).toBe(1);
	});

	it("counts hashless legacy guard entries as unchained, not tamper", () => {
		const legacy = {
			ts: "2026-05-26T10:00:00.000Z",
			agent: "claude",
			type: "guard_block",
			tool: "Bash",
			summary: "legacy entry without hash",
		};
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:01.000Z" });
		writeJsonl(activityPath, [legacy, e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(2);
		expect(res.chained_events).toBe(1);
		expect(res.unchained_guard_events).toBe(1);
	});

	it("chains a session_end record from a guard_allow predecessor", () => {
		const e1 = makeEntry({
			previousHash: GENESIS_HASH,
			type: "guard_allow",
			ts: "2026-05-26T10:00:00.000Z",
		});
		const e2 = makeSessionEndEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:30:00.000Z",
			reason: "prompt_input_exit",
		});
		writeJsonl(activityPath, [e1, e2]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.guard_events).toBe(2);
		expect(res.chained_events).toBe(2);
		expect(res.last_hash).toBe(e2.hash as string);
	});

	it("detects a session_end record whose reason was rewritten post-hash", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeSessionEndEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:30:00.000Z",
			reason: "logout",
		});
		// Tamper: rewrite reason after the hash was computed.
		const tampered = { ...e2, reason: "other" };
		writeJsonl(activityPath, [e1, tampered]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_index).toBe(1);
		expect(res.first_bad_reason).toMatch(/hash mismatch/);
	});

	it("tolerates malformed JSONL lines without breaking the chain", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const broken = "{not valid json";
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			ts: "2026-05-26T10:00:01.000Z",
		});
		// Manually compose so we control line order
		const dir = join(tmp, ".interlinked");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			activityPath,
			`${JSON.stringify(e1)}\n${broken}\n${JSON.stringify(e2)}\n`,
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(2);
	});

	it("ignores a record whose type field is not a string (falls through to '')", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const nonStringType = { ...e1, type: 42 };
		writeJsonl(activityPath, [nonStringType]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(1);
		expect(res.guard_events).toBe(0);
	});

	it("N1: treats a line that parses to valid JSON but not a keyed object (array/number) as unchained, not a crash", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH });
		const e2 = makeEntry({ previousHash: e1.hash as string, ts: "2026-05-26T10:00:01.000Z" });
		const dir = join(tmp, ".interlinked");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(
			activityPath,
			`${JSON.stringify(e1)}\n[1,2,3]\n42\n${JSON.stringify(e2)}\n`,
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		// The array/number lines count toward total_events (they parsed fine)
		// but never toward guard_events — they can't carry a chained `type`.
		expect(res.total_events).toBe(4);
		expect(res.guard_events).toBe(2);
		expect(res.chained_events).toBe(2);
	});

	it("P1: a record carrying only the fields computeEntryHash expects still chains and hashes byte-identically", () => {
		// Pins that narrowing the parsed JSON via isJsonObject is a pure
		// pass-through: every field on the original record — not just the
		// ones this module happens to read — survives into the hash input.
		const e1: Record<string, unknown> = {
			ts: "2026-05-26T10:00:00.000Z",
			type: "guard_block",
			previousHash: GENESIS_HASH,
			extra_field_untouched_by_any_reader: { nested: [1, 2, 3] },
		};
		e1.hash = computeEntryHash(e1);
		writeJsonl(activityPath, [e1]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(1);
		expect(res.last_hash).toBe(e1.hash);
	});

	it("treats a chained record with a missing previousHash as a mismatch and reports '(missing)'", () => {
		const record = { type: "guard_allow", hash: "a".repeat(64) };
		writeJsonl(activityPath, [record]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
		expect(res.first_bad_reason).toMatch(/\(missing\)/);
	});

	it("treats a same-length-but-unequal-byte-length previousHash as a mismatch (safeEqualHex catch path)", () => {
		// A 32-codepoint astral-plane string has JS .length === 64 (surrogate
		// pairs) but encodes to 128 UTF-8 bytes — Buffer.from(...).length
		// differs even though the .length guard passed, so
		// node:crypto.timingSafeEqual throws and safeEqualHex's catch
		// returns false rather than propagating.
		const astral64 = "\u{1D7D9}".repeat(32);
		expect(astral64.length).toBe(64);
		const record = { type: "guard_allow", hash: "b".repeat(64), previousHash: astral64 };
		writeJsonl(activityPath, [record]);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
	});

	it("fails closed with a reason when activity.jsonl exists but cannot be read as a file", () => {
		mkdirSync(activityPath, { recursive: true }); // a directory in place of the file
		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/^activity\.jsonl unreadable:/);
	});
});

describe("verifyAuditChain — archived segments (readArchivedAuditLines)", () => {
	let tmp: string;
	let dataDir: string;
	let archiveDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "audit-chain-archive-"));
		dataDir = join(tmp, ".interlinked");
		archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("treats a non-array segments field as no archived segments", () => {
		writeFileSync(join(archiveDir, "manifest.json"), JSON.stringify({ segments: "oops" }));

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(0);
	});

	it("returns no archived lines when manifest.json is not valid JSON", () => {
		writeFileSync(join(archiveDir, "manifest.json"), "{not valid json");

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.total_events).toBe(0);
	});

	it("sorts segments missing 'seq' first (nullish default 0) and skips a segment with no 'file'", () => {
		const e1 = makeEntry({ previousHash: GENESIS_HASH, ts: "2026-05-26T10:00:00.000Z" });
		const e2 = makeEntry({
			previousHash: e1.hash as string,
			type: "guard_block",
			ts: "2026-05-26T10:00:01.000Z",
		});

		writeFileSync(join(archiveDir, "seg-a.jsonl.gz"), gzipSync(`${JSON.stringify(e1)}\n`));
		writeFileSync(join(archiveDir, "seg-b.jsonl.gz"), gzipSync(`${JSON.stringify(e2)}\n`));

		writeFileSync(
			join(archiveDir, "manifest.json"),
			JSON.stringify({
				segments: [
					// No `seq` — defaults to 0 via `?? 0`, sorts before seq: 1.
					{ file: "seg-a.jsonl.gz" },
					{ file: "seg-b.jsonl.gz", seq: 1 },
					// No `file` field — must be skipped (continue), not crash.
					{ seq: 5 },
				],
			}),
		);

		const res = verifyAuditChain(tmp);
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(2);
		expect(res.last_hash).toBe(e2.hash as string);
	});
});
