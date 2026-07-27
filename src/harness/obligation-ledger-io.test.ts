import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendDebtTxn,
	isOrphanedDebt,
	readDebtTxns,
	readDebtTxnsForFile,
	readDischargeableDebts,
	readOpenDebts,
} from "./obligation-ledger-io.js";
import { type ObligationTxn, obligationId } from "./obligations.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "obl-io-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const openTxn = (file: string): ObligationTxn => ({ op: "open", kind: "coverage", file, contentHash: "", sessionId: "s", atMs: 1 });
const dischargeTxn = (file: string): ObligationTxn => ({ op: "discharge", id: obligationId("coverage", file), source: "local", atMs: 2 });

describe("obligation-ledger-io", () => {
	it("round-trips open → readOpenDebts", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		const open = readOpenDebts(root);
		expect(open).toHaveLength(1);
		expect(open[0]?.file).toBe("src/foo.ts");
	});

	it("nets a discharge against its open", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		appendDebtTxn(root, dischargeTxn("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("returns [] when the ledger does not exist yet", () => {
		expect(readOpenDebts(root)).toEqual([]);
	});

	it("skips a torn / non-JSON line and keeps the valid debts", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		mkdirSync(join(root, ".interlinked"), { recursive: true }); // dir already exists; keeps the raw append guarded
		appendFileSync(join(root, ".interlinked", "obligations.jsonl"), "{ this is not json\n", "utf-8");
		appendDebtTxn(root, openTxn("src/bar.ts"));
		expect(readOpenDebts(root)).toHaveLength(2);
	});

	it("fails open (no throw) when the ledger path is unusable", () => {
		// Make obligations.jsonl a DIRECTORY so append (EISDIR) and read (EISDIR)
		// both throw — both paths must swallow and degrade, never crash.
		mkdirSync(join(root, ".interlinked", "obligations.jsonl"), { recursive: true });
		expect(() => appendDebtTxn(root, openTxn("src/foo.ts"))).not.toThrow();
		expect(readOpenDebts(root)).toEqual([]);
		expect(readDebtTxns(root)).toEqual([]);
	});
});

// ===========================================
// Orphaned debts — unclearable by construction
// ===========================================
//
// A debt is discharged only by the session that opened it. Once that session
// ends, nothing can clear it automatically. Two such debts sat open for 28
// hours after the failure they described was fixed (2026-07-26). A permanent
// block with no action that resolves it is worse than no gate: it asserts
// something false with enough authority to override verified results.

describe("isOrphanedDebt / readDischargeableDebts", () => {
	function withSessionSnapshot(sessionId: string, suffix: string): void {
		mkdirSync(join(root, ".interlinked", "sessions"), { recursive: true });
		appendFileSync(join(root, ".interlinked", "sessions", `${sessionId}${suffix}`), "{}");
	}

	const debtFor = (file: string, sessionId: string) => ({
		id: obligationId("coverage", file),
		kind: "coverage" as const,
		file,
		contentHash: "",
		sessionId,
		openedAtMs: 1,
		status: "open" as const,
	});

	it("P1: a debt whose session left NO artifact of any shape is orphaned", () => {
		expect(isOrphanedDebt(root, debtFor("src/foo.ts", "dead-session"))).toBe(true);
	});

	it("N1: a bare <id>.json counts as a surviving artifact", () => {
		withSessionSnapshot("legacy-session", ".json");
		expect(isOrphanedDebt(root, debtFor("src/foo.ts", "legacy-session"))).toBe(false);
	});

	it("N2: a RUNNING session's .live.json counts — the FP that started this", () => {
		// The original predicate probed only `<id>.json`, which current builds
		// never write, so it reported the running session's debts as orphaned.
		withSessionSnapshot("live-session", ".live.json");
		expect(isOrphanedDebt(root, debtFor("src/foo.ts", "live-session"))).toBe(false);
	});

	it("N3: a .trajectory.json counts too", () => {
		withSessionSnapshot("traj-session", ".trajectory.json");
		expect(isOrphanedDebt(root, debtFor("src/foo.ts", "traj-session"))).toBe(false);
	});

	it("N4: a debt with no session id is not orphaned", () => {
		expect(isOrphanedDebt(root, { ...debtFor("src/foo.ts", ""), sessionId: "" })).toBe(false);
	});

	it("P2: a debt from ANOTHER session is not dischargeable by this one", () => {
		appendDebtTxn(root, openTxn("src/foo.ts")); // opened by session "s"
		expect(readOpenDebts(root)).toHaveLength(1);
		expect(readDischargeableDebts(root, "a-different-session")).toHaveLength(0);
	});

	it("N5: this session's OWN debts remain dischargeable, so they still block", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		expect(readDischargeableDebts(root, "s")).toHaveLength(1);
	});

	it("N7: omitting the current session id keeps every debt (back-compat)", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		expect(readDischargeableDebts(root)).toHaveLength(1);
	});
});

describe("readDebtTxns / readDebtTxnsForFile", () => {
	it("returns every parsed transition in append order", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		appendDebtTxn(root, dischargeTxn("src/foo.ts"));
		const txns = readDebtTxns(root);
		expect(txns).toHaveLength(2);
		expect(txns[0]?.op).toBe("open");
		expect(txns[1]?.op).toBe("discharge");
	});

	it("returns [] when the ledger does not exist yet", () => {
		expect(readDebtTxns(root)).toEqual([]);
		expect(readDebtTxnsForFile(root, "src/foo.ts")).toEqual([]);
	});

	it("skips torn lines but keeps valid transitions", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		appendFileSync(join(root, ".interlinked", "obligations.jsonl"), "{ torn\n", "utf-8");
		appendDebtTxn(root, openTxn("src/bar.ts"));
		expect(readDebtTxns(root)).toHaveLength(2);
	});

	it("filters one file's history: opens by file, discharges/escalates by id", () => {
		appendDebtTxn(root, openTxn("src/foo.ts"));
		appendDebtTxn(root, openTxn("src/bar.ts"));
		appendDebtTxn(root, dischargeTxn("src/foo.ts"));
		appendDebtTxn(root, {
			op: "open",
			kind: "red_suite",
			file: "src/foo.ts",
			contentHash: "",
			sessionId: "s",
			atMs: 3,
		});
		appendDebtTxn(root, {
			op: "escalate",
			id: obligationId("mutation", "src/foo.ts"),
			survivors: [{ line: 4, description: "swapped > for >=" }],
			atMs: 4,
		});
		const foo = readDebtTxnsForFile(root, "src/foo.ts");
		expect(foo.map((t) => t.op)).toEqual(["open", "discharge", "open", "escalate"]);
		expect(readDebtTxnsForFile(root, "src/bar.ts")).toHaveLength(1);
	});

	it("matches a REGION-scoped obligation id to its file, and never a prefix-colliding sibling", () => {
		appendDebtTxn(root, {
			op: "discharge",
			id: `${obligationId("mutation", "src/foo.ts")}:3-9`,
			source: "cloud",
			atMs: 5,
		});
		expect(readDebtTxnsForFile(root, "src/foo.ts")).toHaveLength(1);
		// `src/foo.ts2` shares the string prefix but is a different file: no match
		// (the id continues with a region suffix `:start-end` only, never bare text).
		expect(readDebtTxnsForFile(root, "src/foo.ts2")).toHaveLength(0);
	});
});
