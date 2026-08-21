import { describe, expect, it } from "vitest";
import type { Obligation } from "./obligations.js";
import { applyObligationTxn, replayObligations } from "./obligations.js";
import {
	CROSS_ACTOR_STALE_MS,
	DEFAULT_TRANSIENT_SLACK,
	type DeferrableFinding,
	type TransientDebtInput,
	decideTransientDebt,
} from "./transient-debt.js";

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

/** Build a live debt the way the engine would (mirrors the companion test's helper). */
function debt(over: { file: string; detector?: string; strikes?: number; atMs?: number }): Obligation {
	const state = replayObligations([]);
	applyObligationTxn(state, {
		op: "open",
		kind: "transient",
		file: over.file,
		contentHash: "h0",
		sessionId: "s1",
		atMs: over.atMs ?? 1,
		...(over.detector === undefined ? {} : { detector: over.detector }),
		...(over.strikes === undefined ? {} : { strikes: over.strikes }),
	});
	const only = [...state.values()][0];
	if (!only) throw new Error("fixture failed to open a debt");
	return only;
}

describe("openTxnsForFindings + renderFinding — grouping, joining, wording (must fire)", () => {
	// test-contract: public-api — decideTransientDebt's grouping/join/wording is the observable warning text.
	it("P1: two findings under one detector group into one debt, joined with '; ', full wording intact", () => {
		const f1: DeferrableFinding = { detector: "TS6133", line: 3, message: "'a' is declared but never read" };
		const f2: DeferrableFinding = { detector: "TS6133", line: 9, message: "'b' is declared but never read" };
		const out = decideTransientDebt(input({ findings: [f1, f2], slack: 3 }));
		expect(out.txns).toHaveLength(1);
		expect(out.warnings).toEqual([
			"[interlinked:transient-debt] src/a.ts — TS6133 deferred: " +
				"L3 TS6133 'a' is declared but never read; L9 TS6133 'b' is declared but never read. " +
				"Not blocking: this is the shape a coordinated edit's other half resolves. Land that half " +
				"next — after 4 edits away from this file it becomes a block.",
		]);
	});
});

describe("openTxnsForFindings — reopening preserves the prior strike count (must fire)", () => {
	// test-contract: invariant — re-announcing an open debt must not reset its strike count.
	it("P1: a debt reopened by a still-firing detector keeps its strikes, not 0", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 3 });
		const finding: DeferrableFinding = { detector: "TS6133", line: 3, message: "still unread" };
		const out = decideTransientDebt(input({ findings: [finding], openDebts: [open] }));
		expect(out.txns).toContainEqual(
			expect.objectContaining({ op: "open", file: "src/a.ts", detector: "TS6133", strikes: 3 }),
		);
	});
});

describe("dischargeTxns — discharge message names the actual detector (must fire)", () => {
	// test-contract: public-api — the discharge warning must name the real detector id, not a placeholder.
	it("P1: the reconciled message names the specific detector, not a stand-in", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133" });
		const out = decideTransientDebt(input({ findings: [], openDebts: [open] }));
		expect(out.warnings.join()).toContain("src/a.ts — TS6133 reconciled.");
	});
});

describe("wanderTarget — picks the highest-strikes wanderable debt (must fire)", () => {
	// test-contract: invariant — wanderTarget picks the strictly-most-struck wanderable debt (later item wins on strict >).
	it("P1: comparison correctly promotes a later, higher-strikes debt over an earlier lower one", () => {
		const low = debt({ file: "src/low.ts", detector: "D1", strikes: 2 });
		const high = debt({ file: "src/high.ts", detector: "D2", strikes: 5 });
		const out = decideTransientDebt(input({ editedFile: "src/other.ts", openDebts: [low, high] }));
		// At default slack, strikes 2 and 5 both clear the block threshold, so the
		// wandered debt surfaces in the block decision's reason, not in warnings.
		expect(out.decision?.reason ?? "").toContain("src/high.ts");
		expect(out.decision?.reason ?? "").not.toContain("src/low.ts");
	});

	// test-contract: invariant — an earlier higher-strikes debt must not be replaced by a later lower one.
	it("P2: an earlier, higher-strikes debt is NOT overwritten by a later lower one", () => {
		const high = debt({ file: "src/high2.ts", detector: "D1", strikes: 5 });
		const low = debt({ file: "src/low2.ts", detector: "D2", strikes: 2 });
		const out = decideTransientDebt(input({ editedFile: "src/other.ts", openDebts: [high, low] }));
		expect(out.decision?.reason ?? "").toContain("src/high2.ts");
		expect(out.warnings.join()).not.toContain("src/low2.ts");
	});
});

describe("strikeTxns — the detector field on a strike re-open (must fire)", () => {
	// test-contract: invariant — a strike re-open must preserve the debt's real detector identity.
	it("P1: a debt WITH a detector keeps it on the strike re-open", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 0 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		expect(out.txns).toContainEqual(
			expect.objectContaining({ op: "open", file: "src/a.ts", detector: "TS6133", strikes: 1 }),
		);
	});

	// test-contract: invariant — exactOptionalPropertyTypes: an absent detector must stay ABSENT, not present-undefined.
	it("P2: a debt WITHOUT a detector must NOT gain a present-but-undefined detector key", () => {
		const open = debt({ file: "src/a.ts", strikes: 0 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open] }));
		const txn = out.txns.find((t) => t.op === "open" && t.file === "src/a.ts");
		expect(txn).toBeDefined();
		expect(txn && "detector" in txn).toBe(false);
	});
});

describe("wanderBlock — exact reason text, severity, category, empty warnings (must fire)", () => {
	// test-contract: public-api — decideTransientDebt's block decision reason/severity/category are the agent-facing contract.
	it("P1: full block reason matches exactly, decision metadata is not blanked out", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: DEFAULT_TRANSIENT_SLACK });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open], atMs: 1_000 }));
		expect(out.decision).toEqual({
			decision: "block",
			reason:
				"BLOCKED by transient debt: src/a.ts still carries [TS6133], deferred 2 edits ago because " +
				"it looked like one half of a coordinated change. This edit to src/b.ts walks away from it again.\n" +
				"Go back to src/a.ts and resolve [TS6133] — use the symbol, drop the import, or land the " +
				"counterpart that makes it resolve. The next write to that file re-runs the same check and " +
				"clears the debt automatically.\n" +
				"If the finding is deliberate, mark it in place (`// interlinked-ignore: <check> — <why>`); " +
				"if the gate mis-modeled a legitimate change, that is a gate defect worth reporting.",
			warnings: [],
			rule_id: "transient_debt",
			severity: "medium",
			category: "pre-block",
		});
		expect(out.warnings).toEqual([]);
	});
});

describe("describeWander — exact non-stale wording (must fire)", () => {
	// test-contract: public-api — the non-stale wander warning's mode-dependent tail wording is agent-facing.
	it("P1: block mode says 'will be blocked', not 'escalates'", () => {
		const open = debt({ file: "src/a.ts", detector: "TS6133", strikes: 0 });
		const out = decideTransientDebt(input({ editedFile: "src/b.ts", openDebts: [open], mode: "block" }));
		expect(out.warnings).toContain(
			"[interlinked:transient-debt] src/a.ts still carries [TS6133] and this edit moves elsewhere. " +
				"Slack spent — the next edit away from it will be blocked.",
		);
	});
});

describe("describeWander — exact stale wording, including the minute count (must fire)", () => {
	// test-contract: public-api — the stale wander warning's exact minute count is agent-facing, derived from CROSS_ACTOR_STALE_MS.
	it("P1: stale message names the file, the finding, and '10 minutes' exactly", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const open = debt({ file: "src/old.ts", detector: "TS2532", strikes: 5 });
		const out = decideTransientDebt(
			input({ editedFile: "src/mine.ts", openDebts: [open], atMs: 1 + ELEVEN_MIN }),
		);
		expect(out.warnings).toContain(
			"[interlinked:transient-debt] src/old.ts has carried [TS2532] for over 10 minutes. " +
				"Not blocking this edit — a debt that old is usually another session's in-flight work, and " +
				"blocking on it deadlocks every other actor. Someone should still fix it.",
		);
	});
});

describe("decideTransientDebt — stale boundary is strictly-greater, not >= (must fire)", () => {
	// test-contract: boundary — the stale check uses strict `>`; an exactly-equal elapsed time must still block.
	it("P1: elapsed time exactly equal to the stale window is NOT stale — it still blocks", () => {
		const open = debt({
			file: "src/a.ts",
			detector: "TS6133",
			strikes: DEFAULT_TRANSIENT_SLACK,
			atMs: 0,
		});
		const out = decideTransientDebt(
			input({ editedFile: "src/b.ts", openDebts: [open], atMs: CROSS_ACTOR_STALE_MS }),
		);
		expect(out.decision?.decision).toBe("block");
	});
});
