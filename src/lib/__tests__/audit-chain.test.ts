import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeEntryHash, verifyAuditChain } from "../audit-chain.js";

function writeChain(records: unknown[]): string {
	const tempDir = mkdtempSync(join(tmpdir(), "interlinked-audit-"));
	const dataDir = join(tempDir, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "activity.jsonl"),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return tempDir;
}

describe("verifyAuditChain — per-segment validation", () => {
	it("validates a single continuous chain (non-chained records ignored)", () => {
		const a = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const af = { ...a, hash: computeEntryHash(a) };
		const b = { type: "guard_warn", previousHash: af.hash, n: 2 };
		const bf = { ...b, hash: computeEntryHash(b) };
		const res = verifyAuditChain(writeChain([af, { type: "tool_use", n: 9 }, bf]));
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(2);
	});

	it("validates multiple GENESIS-rooted segments (per-session restarts)", () => {
		// Segment 1
		const a = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const af = { ...a, hash: computeEntryHash(a) };
		const b = { type: "guard_allow", previousHash: af.hash, n: 2 };
		const bf = { ...b, hash: computeEntryHash(b) };
		// Segment 2 — restarts at GENESIS (a new session), valid by design.
		const c = { type: "guard_allow", previousHash: GENESIS_HASH, n: 3 };
		const cf = { ...c, hash: computeEntryHash(c) };
		const d = { type: "session_end", previousHash: cf.hash, n: 4 };
		const df = { ...d, hash: computeEntryHash(d) };
		const res = verifyAuditChain(writeChain([af, bf, { type: "tool_use" }, cf, df]));
		expect(res.valid).toBe(true);
		expect(res.chained_events).toBe(4);
	});

	it("rejects a tampered record (hash no longer matches its payload)", () => {
		const a = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const af = { ...a, hash: computeEntryHash(a) };
		// Mutate a field but keep the stored hash → within-segment tamper-evidence.
		const tampered = { ...af, n: 999 };
		const res = verifyAuditChain(writeChain([tampered]));
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/hash mismatch/);
	});

	it("rejects a real mid-segment break (non-GENESIS previousHash that doesn't link)", () => {
		const a = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const af = { ...a, hash: computeEntryHash(a) };
		// b's previousHash is neither af.hash nor GENESIS → a genuine break.
		const b = { type: "guard_allow", previousHash: "f".repeat(64), n: 2 };
		const bf = { ...b, hash: computeEntryHash(b) };
		const res = verifyAuditChain(writeChain([af, bf]));
		expect(res.valid).toBe(false);
		expect(res.first_bad_reason).toMatch(/previousHash mismatch/);
	});
});
