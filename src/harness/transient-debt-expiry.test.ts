// ===========================================
// Transient-debt expiry on a clean project sweep
// ===========================================
// A transient debt is discharged only when its OWN session re-edits the file
// and the checker re-runs clean. Nothing else ever clears it — so a debt on a
// file nobody touches again outlives the diagnostic that opened it. Measured
// 2026-08-16: `spec-pre-gates.mutation-kill.test.ts` warned [TS18048] on every
// write for over an hour while `tsgo --noEmit` reported zero errors, which
// trains an agent to ignore the warning. These cases pin the expiry.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Obligation } from "./obligations.js";
import { appendDebtTxn, readOpenTransientDebts } from "./obligation-ledger-io.js";
import {
	diagnosticCodesByFile,
	expiredTransientDebts,
	sweepExpiredTransientDebts,
} from "./transient-debt-expiry.js";

const ROOT = "/repo";

function debt(file: string, detector: string | undefined, id = `${file}:${detector}`): Obligation {
	return {
		id,
		kind: "transient",
		file,
		contentHash: "h",
		status: "open",
		sessionId: "s1",
		openedAtMs: 1,
		...(detector === undefined ? {} : { detector }),
	};
}

describe("diagnosticCodesByFile — positive (must fire)", () => {
	it("P1: extracts the TS code from a sweep finding's message", () => {
		const map = diagnosticCodesByFile(ROOT, [
			{ file: "src/a.ts", message: "TS18048: 'x' is possibly undefined." },
		]);
		expect([...(map.get("src/a.ts") ?? [])]).toEqual(["TS18048"]);
	});

	it("P2: normalizes an absolute path to repo-relative", () => {
		const map = diagnosticCodesByFile(ROOT, [
			{ file: "/repo/src/a.ts", message: "TS2304: Cannot find name 'z'." },
		]);
		expect(map.has("src/a.ts")).toBe(true);
	});

	it("P3: several codes on one file all survive", () => {
		const map = diagnosticCodesByFile(ROOT, [
			{ file: "src/a.ts", message: "TS2304: nope" },
			{ file: "src/a.ts", message: "TS18048: nope" },
		]);
		expect((map.get("src/a.ts") ?? new Set()).size).toBe(2);
	});
});

describe("diagnosticCodesByFile — negative (must not fire)", () => {
	it("N1: a finding with no file is dropped rather than keyed to nothing", () => {
		expect(diagnosticCodesByFile(ROOT, [{ message: "TS2304: x" }]).size).toBe(0);
	});

	it("N2: a message with no TS code records the file with an empty code set", () => {
		const map = diagnosticCodesByFile(ROOT, [{ file: "src/a.ts", message: "lint: no-explicit-any" }]);
		expect(map.has("src/a.ts")).toBe(true);
		expect((map.get("src/a.ts") ?? new Set()).size).toBe(0);
	});
});

describe("expiredTransientDebts — positive (must fire: the diagnostic is gone)", () => {
	it("P1: a debt whose file the sweep no longer reports at all expires", () => {
		const open = [debt("src/a.ts", "TS18048")];
		expect(expiredTransientDebts(open, new Map()).map((d) => d.id)).toEqual(["src/a.ts:TS18048"]);
	});

	it("P2: a debt whose file is reported under a DIFFERENT code expires", () => {
		const byFile = new Map([["src/a.ts", new Set(["TS2304"])]]);
		expect(expiredTransientDebts([debt("src/a.ts", "TS18048")], byFile)).toHaveLength(1);
	});

	it("P3: a detector-less debt expires only when its file is wholly clean", () => {
		expect(expiredTransientDebts([debt("src/a.ts", undefined)], new Map())).toHaveLength(1);
	});
});

describe("expiredTransientDebts — negative (must not fire: still reproducing)", () => {
	it("N1: the same code on the same file keeps the debt open", () => {
		const byFile = new Map([["src/a.ts", new Set(["TS18048"])]]);
		expect(expiredTransientDebts([debt("src/a.ts", "TS18048")], byFile)).toEqual([]);
	});

	it("N2: a detector-less debt is KEPT while its file reports anything at all", () => {
		const byFile = new Map([["src/a.ts", new Set(["TS2304"])]]);
		expect(expiredTransientDebts([debt("src/a.ts", undefined)], byFile)).toEqual([]);
	});

	it("N3: another file's diagnostic does not keep this file's debt, nor drop its own", () => {
		const byFile = new Map([["src/b.ts", new Set(["TS18048"])]]);
		const open = [debt("src/a.ts", "TS18048"), debt("src/b.ts", "TS18048")];
		expect(expiredTransientDebts(open, byFile).map((d) => d.file)).toEqual(["src/a.ts"]);
	});

	it("N4: an already-discharged debt is never re-expired", () => {
		const closed = { ...debt("src/a.ts", "TS18048"), status: "discharged" as const };
		expect(expiredTransientDebts([closed], new Map())).toEqual([]);
	});
});

describe("sweepExpiredTransientDebts — ledger round trip", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "il-debt-expiry-"));
		mkdirSync(join(root, ".interlinked"), { recursive: true });
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function openDebt(file: string, detector: string): void {
		appendDebtTxn(root, {
			op: "open",
			kind: "transient",
			file,
			contentHash: "h",
			sessionId: "s1",
			atMs: 1,
			detector,
		});
	}

	it("P1: a clean sweep discharges the stale debt in the ledger", () => {
		openDebt("src/a.ts", "TS18048");
		expect(readOpenTransientDebts(root)).toHaveLength(1);
		const expired = sweepExpiredTransientDebts(root, [], { atMs: 99 });
		expect(expired).toHaveLength(1);
		expect(readOpenTransientDebts(root)).toHaveLength(0);
	});

	it("N1: a sweep that still reports the code leaves the debt open", () => {
		openDebt("src/a.ts", "TS18048");
		const expired = sweepExpiredTransientDebts(
			root,
			[{ file: "src/a.ts", message: "TS18048: still here" }],
			{ atMs: 99 },
		);
		expect(expired).toEqual([]);
		expect(readOpenTransientDebts(root)).toHaveLength(1);
	});

	it("N2: dryRun computes the expiry but writes no discharge", () => {
		openDebt("src/a.ts", "TS18048");
		const expired = sweepExpiredTransientDebts(root, [], { atMs: 99, dryRun: true });
		expect(expired).toHaveLength(1);
		expect(readOpenTransientDebts(root)).toHaveLength(1);
	});

	it("N3: no open debts is a no-op that writes nothing", () => {
		expect(sweepExpiredTransientDebts(root, [], { atMs: 99 })).toEqual([]);
	});
});
