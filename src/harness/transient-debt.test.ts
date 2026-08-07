import { describe, expect, it } from "vitest";
import type { Obligation } from "./obligations.js";
import { applyObligationTxn, replayObligations } from "./obligations.js";
import {
	DEFAULT_TRANSIENT_SLACK,
	type DeferrableFinding,
	type TransientDebtInput,
	decideTransientDebt,
	isReconcilingEdit,
} from "./transient-debt.js";

const TS6133: DeferrableFinding = {
	detector: "TS6133",
	line: 3,
	message: "'helper' is declared but its value is never read",
};

function input(over: Partial<TransientDebtInput> = {}): TransientDebtInput {
	return {
		editedFile: "src/a.ts",
		findings: [],
		openDebts: [],
		sessionId: "s1",
		atMs: 1_000,
		contentHash: "h1",
		mode: "block",
		...over,
	};
}

/** Build a live debt the way the engine would, so tests never hand-roll an
 *  Obligation shape the reducer would not produce. */
function debt(over: { file: string; detector?: string; strikes?: number }): Obligation {
	const state = replayObligations([]);
	applyObligationTxn(state, {
		op: "open",
		kind: "transient",
		file: over.file,
		contentHash: "h0",
		sessionId: "s1",
		atMs: 1,
		...(over.detector === undefined ? {} : { detector: over.detector }),
		...(over.strikes === undefined ? {} : { strikes: over.strikes }),
	});
	const only = [...state.values()][0];
	if (!only) throw new Error("fixture failed to open a debt");
	return only;
}

describe("isReconcilingEdit — positive (must fire)", () => {
	it("P1: the debt's own file is reconciling work", () => {
		expect(isReconcilingEdit("src/a.ts", debt({ file: "src/a.ts" }))).toBe(true);
	});

	it("P2: the source/test pair counts", () => {
		expect(isReconcilingEdit("src/a.test.ts", debt({ file: "src/a.ts" }))).toBe(true);
	});

	it("P3: a caller-supplied neighbour counts", () => {
		const related = new Set(["src/a.ts"]);
		expect(isReconcilingEdit("src/b.ts", debt({ file: "src/a.ts" }), related)).toBe(true);
	});
});

describe("isReconcilingEdit — negative (must not fire)", () => {
	it("N1: an unrelated file is a wander", () => {
		expect(isReconcilingEdit("src/z.ts", debt({ file: "src/a.ts" }))).toBe(false);
	});

	it("N2: a neighbour set that does not name the debt does not widen", () => {
		const related = new Set(["src/c.ts"]);
		expect(isReconcilingEdit("src/b.ts", debt({ file: "src/a.ts" }), related)).toBe(false);
	});
});

describe("decideTransientDebt — opening (must fire)", () => {
	it("P1: a deferrable finding warns and opens a debt, never blocks", () => {
		const out = decideTransientDebt(input({ findings: [TS6133] }));
		expect(out.decision).toBeNull();
		expect(out.txns).toHaveLength(1);
		expect(out.txns[0]).toMatchObject({ op: "open", kind: "transient", detector: "TS6133" });
		expect(out.warnings.join()).toContain("TS6133 deferred");
	});

	it("P2: the debt it opens cannot block the write that opened it", () => {
		const out = decideTransientDebt(input({ findings: [TS6133] }));
		expect(out.decision).toBeNull();
	});

	it("P3: two detectors on one file are two independently-keyed debts", () => {
		const out = decideTransientDebt(
			input({ findings: [TS6133, { detector: "TS2304", line: 9, message: "Cannot find name 'x'" }] }),
		);
		const state = replayObligations(out.txns);
		expect(state.size).toBe(2);
	});

	it("P4: re-opening an already-announced debt does not re-nag", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133" });
		const out = decideTransientDebt(input({ findings: [TS6133], openDebts: [open] }));
		expect(out.warnings.filter((w) => w.includes("deferred"))).toHaveLength(0);
	});
});

describe("decideTransientDebt — discharge (must fire)", () => {
	it("P1: the checker no longer reporting it discharges the debt", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133" });
		const out = decideTransientDebt(input({ findings: [], openDebts: [open] }));
		expect(out.txns).toEqual([
			{ op: "discharge", id: open.id, source: "local", atMs: 1_000 },
		]);
		expect(out.warnings.join()).toContain("reconciled");
	});

	it("P2: a still-firing detector is NOT discharged", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133" });
		const out = decideTransientDebt(input({ findings: [TS6133], openDebts: [open] }));
		expect(out.txns.some((t) => t.op === "discharge")).toBe(false);
	});

	it("P3: a fix + a wander in one edit is credited for the fix", () => {
		const fixed = debt({ file: "src/a.ts", detector: "TS6133" });
		const other = debt({ file: "src/z.ts", detector: "TS2304" });
		const out = decideTransientDebt(input({ findings: [], openDebts: [fixed, other] }));
		expect(out.txns.some((t) => t.op === "discharge" && t.id === fixed.id)).toBe(true);
	});
});

describe("decideTransientDebt — wander teeth (must fire)", () => {
	it("P1: the first wander warns and spends slack, it does not block", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 0 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		expect(out.decision).toBeNull();
		expect(out.warnings.join()).toContain("Slack spent");
		expect(out.txns).toContainEqual(expect.objectContaining({ op: "open", strikes: 1 }));
	});

	it("P2: the second wander blocks and names the debt file", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: DEFAULT_TRANSIENT_SLACK });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		expect(out.decision?.decision).toBe("block");
		expect(out.decision?.rule_id).toBe("transient_debt");
		expect(out.decision?.reason).toContain("src/a.ts");
	});

	it("P3: a refused wander still costs a strike", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: DEFAULT_TRANSIENT_SLACK });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		expect(out.txns).toContainEqual(
			expect.objectContaining({ op: "open", strikes: DEFAULT_TRANSIENT_SLACK + 1 }),
		);
	});
});

describe("decideTransientDebt — cross-actor deadlock (stale debts must not block)", () => {
	// The ledger is repo-wide. Under a parallel wave, one agent's in-flight
	// breakage blocked every other agent, and the victims could not fix it
	// because the file was outside their scope. Measured 2026-08-05: two agents
	// of twenty produced ZERO work (188 survivors untouched) for this reason.
	const ELEVEN_MIN = 11 * 60 * 1000;

	it("P1: a debt older than the stale window warns instead of blocking", () => {
		const open = debt({ file: "src/other-agents-file.ts", detector: "TS2532", strikes: 5 });
		const out = decideTransientDebt(
			input({ editedFile: "src/mine.ts", openDebts: [open], atMs: 1 + ELEVEN_MIN }),
		);
		expect(out.decision).toBeNull();
		expect(out.warnings.join()).toContain("Not blocking this edit");
		expect(out.warnings.join()).toContain("src/other-agents-file.ts");
	});

	it("P2: a FRESH debt over slack still blocks — the teeth are intact", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: DEFAULT_TRANSIENT_SLACK });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open], atMs: 1_000 }));
		expect(out.decision?.decision).toBe("block");
	});

	it("P3: a stale debt still accrues a strike, so it is not free", () => {
		const open = debt({ file: "src/other.ts", detector: "TS2532", strikes: 5 });
		const out = decideTransientDebt(
			input({ editedFile: "src/mine.ts", openDebts: [open], atMs: 1 + ELEVEN_MIN }),
		);
		expect(out.txns).toContainEqual(expect.objectContaining({ op: "open", strikes: 6 }));
	});
});

describe("decideTransientDebt — wander teeth (must not fire)", () => {
	it("N1: the coordinated counterpart edit gets its one free pass", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 0 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		expect(out.decision).toBeNull();
	});

	it("N2: iterating inside the debt's own pair never blocks, however long it takes", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 99 });
		const out = decideTransientDebt(input({ editedFile: "src/a.test.ts", openDebts: [open] }));
		expect(out.decision).toBeNull();
		expect(out.txns.some((t) => t.op === "open" && t.file === "src/a.ts")).toBe(false);
	});

	it("N3: a graph neighbour is not a wander when the caller supplies one", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 99 });
		const out = decideTransientDebt(
			input({ editedFile: "src/b.ts", openDebts: [open], relatedFiles: new Set(["src/a.ts"]) }),
		);
		expect(out.decision).toBeNull();
	});

	it("N4: warn mode escalates the wording but never blocks", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 99 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open], mode: "warn" }));
		expect(out.decision).toBeNull();
		expect(out.warnings.join()).toContain("escalates");
	});

	it("N5: mode off is a pure pass-through — no decision, no ledger writes", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 99 });
		const out = decideTransientDebt(
			input({ editedFile: "src/b.ts", findings: [TS6133], openDebts: [open], mode: "off" }),
		);
		expect(out).toEqual({ decision: null, warnings: [], txns: [] });
	});
});

describe("decideTransientDebt — ledger round-trip", () => {
	it("P1: emitted transitions replay to the state the decision assumed", () => {
		const opened = decideTransientDebt(input({ findings: [TS6133] }));
		const afterOpen = replayObligations(opened.txns);
		const live = [...afterOpen.values()];
		expect(live).toHaveLength(1);
		expect(live[0]?.status).toBe("open");

		// One wander, then a second: the strike count survives the round-trip and
		// the gate bites exactly once slack is gone.
		const first = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: live }));
		expect(first.decision).toBeNull();
		const second = decideTransientDebt(
			input({ editedFile: "src/c.ts", openDebts: [...replayObligations([...opened.txns, ...first.txns]).values()] }),
		);
		expect(second.decision?.decision).toBe("block");
	});
});
