import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendDebtTxn, readOpenDebts } from "./obligation-ledger-io.js";
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
	});
});
