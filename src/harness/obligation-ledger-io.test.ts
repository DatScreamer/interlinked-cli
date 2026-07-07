import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendDebtTxn,
	readDebtTxns,
	readDebtTxnsForFile,
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
