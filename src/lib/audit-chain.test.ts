import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalJson,
	computeEntryHash,
	GENESIS_HASH,
	verifyAuditChain,
} from "./audit-chain.js";

function makeEntry(opts: {
	previousHash: string;
	type?: "guard_block" | "guard_warn" | "guard_allow";
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
});
