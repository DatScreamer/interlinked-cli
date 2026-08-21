import { describe, expect, it } from "vitest";
import {
	type CoverageDebtInput,
	decideCoverageDebt,
	isRedBarBlock,
	isUncoveredBlock,
	relatedToDebt,
} from "./coverage-debt.js";
import type { Obligation } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

const SRC = "src/luna.ts";
const TEST = "src/luna.test.ts";

function makeDebt(
	overrides: Partial<Obligation> & Pick<Obligation, "file" | "kind">,
): Obligation {
	return {
		id: `${overrides.kind}:${overrides.file}`,
		contentHash: "hash",
		status: "open",
		sessionId: "session",
		openedAtMs: 10,
		...overrides,
	};
}

function uncoveredBlock(file = SRC): HarnessDecision {
	return {
		decision: "block",
		reason: `${file} is uncovered by the test suite`,
		rule_id: "coverage",
		severity: "medium",
		category: "coverage",
	};
}

function redBlock(failing_test_files?: string[]): HarnessDecision {
	return {
		decision: "block",
		reason: "this edit leaves the test suite RED",
		rule_id: "coverage",
		severity: "medium",
		category: "coverage",
		...(failing_test_files === undefined ? {} : { failing_test_files }),
	};
}

function run(overrides: Partial<CoverageDebtInput>): ReturnType<typeof decideCoverageDebt> {
	return decideCoverageDebt({
		baseDecision: null,
		editedFile: SRC,
		openDebts: [],
		rechecks: new Map(),
		sessionId: "session",
		atMs: 1000,
		...overrides,
	});
}

describe("coverage-debt.ts — wave-26 survivor kills", () => {
	// test-contract: public-api — isUncoveredBlock requires decision.decision === "block" exactly.
	it("N1: isUncoveredBlock rejects an allow decision whose reason carries the uncovered marker", () => {
		const allowWithMarker: HarnessDecision = {
			decision: "allow",
			reason: "x is uncovered by the test suite",
		};
		expect(isUncoveredBlock(allowWithMarker)).toBe(false);
	});

	// test-contract: public-api — isRedBarBlock requires decision.decision === "block" exactly.
	it("N2: isRedBarBlock rejects an allow decision whose reason carries the red-bar marker", () => {
		const allowWithMarker: HarnessDecision = {
			decision: "allow",
			reason: "this edit leaves the test suite RED",
		};
		expect(isRedBarBlock(allowWithMarker)).toBe(false);
	});

	// test-contract: public-api — isRedBarBlock requires reason to be a string, not any truthy value.
	it("N3: isRedBarBlock rejects a block decision with a non-string reason", () => {
		// SAFETY: deliberately malformed runtime input (reason: number) exercises the typeof guard.
		const malformed = { decision: "block", reason: 42 } as unknown as HarnessDecision;
		expect(isRedBarBlock(malformed)).toBe(false);
	});

	// test-contract: public-api — the affected-test cone widens relatedness on a PARTIAL match ("some", not "every").
	it("P1: relatedToDebt is related when only ONE recorded failing test is in the affected-test cone", () => {
		const d = makeDebt({
			file: "src/other-debt.ts",
			kind: "red_suite",
			failingTestFiles: ["a.test.ts", "b.test.ts"],
		});
		expect(relatedToDebt("src/unrelated.ts", d, new Set(["a.test.ts"]))).toBe(true);
	});

	// test-contract: invariant — pairOtherSide's "cover its source" phrasing is scoped to kind === "coverage" debts
	// opened on a TEST file; a non-coverage debt (e.g. "mutation") on the same test file gets plain "its source" guidance.
	it("E1: a coverage-kind debt on a test file gets the CREATE ('cover its source') phrasing", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [makeDebt({ file: TEST, kind: "coverage" })],
		});
		expect(out.decision?.reason).toContain(`cover its source (${SRC})`);
	});

	// test-contract: invariant — pairOtherSide only uses the CREATE phrasing for kind === "coverage"; any other
	// kind on the same test file must fall back to the plain "its source" phrasing.
	it("E2: a non-coverage debt on a test file gets plain 'its source' phrasing, never 'cover its source'", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [makeDebt({ file: TEST, kind: "mutation" })],
		});
		expect(out.decision?.reason).toContain(`its source (${SRC})`);
		expect(out.decision?.reason).not.toContain("cover its source");
	});

	// test-contract: invariant — pairOtherSide's second kind==="coverage" check (source-file branch) must also gate
	// the CREATE phrasing, independently of the test-file branch above.
	it("E3: a coverage-kind debt on a source file gets the CREATE ('write its test ... and cover it') phrasing", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [makeDebt({ file: SRC, kind: "coverage" })],
		});
		expect(out.decision?.reason).toContain(`write its test (${TEST}) and cover it`);
	});

	// test-contract: invariant — a non-coverage debt on a source file must fall back to plain "its test" phrasing,
	// never the CREATE phrasing reserved for kind === "coverage".
	it("E4: a non-coverage debt on a source file gets plain 'its test' phrasing, never 'write its test ... and cover it'", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [makeDebt({ file: SRC, kind: "mutation" })],
		});
		expect(out.decision?.reason).toContain(`its test (${TEST})`);
		expect(out.decision?.reason).not.toContain("write its test");
	});

	// test-contract: boundary — failingFilesPhrase shows up to three files verbatim, joined by ", ", with a bare period
	// immediately after the last shown file when there are three or fewer.
	it("F1: exactly three failing files render with no elision and a comma-space join", () => {
		const out = run({
			editedFile: "src/other.ts",
			openDebts: [
				makeDebt({
					file: SRC,
					kind: "red_suite",
					failingTestFiles: ["a.ts", "b.ts", "c.ts"],
				}),
			],
		});
		expect(out.decision?.reason).toContain("the failing test(s): a.ts, b.ts, c.ts. Drive the suite green first");
	});

	// test-contract: boundary — a fourth failing file is elided behind "…" and never named.
	it("F2: a fourth failing file is elided behind an ellipsis and its own name never appears", () => {
		const out = run({
			editedFile: "src/other.ts",
			openDebts: [
				makeDebt({
					file: SRC,
					kind: "red_suite",
					failingTestFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
				}),
			],
		});
		expect(out.decision?.reason).toContain("the failing test(s): a.ts, b.ts, c.ts, ….");
		expect(out.decision?.reason).not.toContain("d.ts");
	});

	// test-contract: invariant — redWanderGuidance's evidence-branch sentence carries both surrounding template
	// fragments verbatim (the "edit X, a failing test file..." clause and the "(per the import graph)..." tail).
	it("H1: the red wander block names the edited file's fix path and the import-graph closing clause", () => {
		const out = run({
			editedFile: "src/other.ts",
			openDebts: [makeDebt({ file: SRC, kind: "red_suite", failingTestFiles: ["a.ts"] })],
		});
		expect(out.decision?.reason).toContain(
			`edit ${SRC}, a failing test file, or any file those tests exercise (per the import graph) — then continue.`,
		);
	});

	// test-contract: invariant — the coverage-kind wander block carries its BLOCKED preamble, its "moves to an
	// unrelated file" clause, and exact severity/category metadata, and also the full WANDER_ESCAPE tail.
	it("I1: the coverage wander block names the edited file in both clauses, with exact metadata and escape text", () => {
		const out = run({
			editedFile: "src/other.ts",
			openDebts: [makeDebt({ file: SRC, kind: "coverage" })],
		});
		expect(out.decision?.reason).toContain(
			`[interlinked:coverage] BLOCKED: you added code to ${SRC} that no test covers yet, `,
		);
		expect(out.decision?.reason).toContain(
			`and this edit moves to an unrelated file. Keep editing ${SRC} or `,
		);
		expect(out.decision?.reason).toContain(
			"If this edit IS part of that work and the import graph can't see it, raise",
		);
		expect(out.decision?.reason).toContain("— scoped, recorded, auditable.");
		expect(out.decision).toMatchObject({
			decision: "block",
			rule_id: "per-edit-coverage-debt",
			severity: "medium",
			category: "coverage",
		});
	});

	// test-contract: invariant — allowWithDebt's warning carries both the "write its test next" clause and the
	// exact "unrelated file until it's covered." tail verbatim.
	it("J1: opening a coverage debt on a source file names the exact create-test and scope-boundary clauses", () => {
		const out = run({ baseDecision: uncoveredBlock(SRC), editedFile: SRC });
		expect(out.decision?.warnings?.[0]).toContain("write its test next");
		expect(out.decision?.warnings?.[0]).toContain("unrelated file until it's covered.");
	});

	// test-contract: invariant — allowWithRedDebt's evidence-branch scope names the "or any file those tests
	// exercise" clause verbatim.
	it("K1: opening/continuing a red debt with failing evidence names the import-graph scope clause", () => {
		const out = run({
			baseDecision: redBlock(["a.test.ts"]),
			editedFile: SRC,
			openDebts: [],
		});
		expect(out.decision?.warnings?.[0]).toContain("or any file those tests exercise");
	});

	// test-contract: invariant — allowWithRedDebt's no-evidence, non-test-file branch names "its test" verbatim,
	// and the tail clause about the suite running green again is present.
	it("L1: opening a red debt with no evidence on a source file names its test and the green-again tail", () => {
		const out = run({ baseDecision: redBlock([]), editedFile: SRC, openDebts: [] });
		expect(out.decision?.warnings?.[0]).toContain(`keep editing ${SRC} or its test freely`);
		expect(out.decision?.warnings?.[0]).toContain(
			"move to an unrelated file until the suite runs green again.",
		);
	});

	// test-contract: invariant — foldRedVerdict opens a FRESH red debt with no failingTestFiles field at all when
	// this run reported zero failing tests and no related debt exists yet.
	it("M1: a red verdict with empty evidence and no prior related debt opens with no failingTestFiles field", () => {
		const out = run({ baseDecision: redBlock([]), editedFile: SRC, openDebts: [] });
		expect(out.txns[0]).toMatchObject({ op: "open", kind: "red_suite" });
		expect(out.txns[0]).not.toHaveProperty("failingTestFiles");
	});

	// test-contract: invariant — when the CURRENT run reports zero evidence but a related debt already carries
	// non-empty evidence, the allow message must still fall back to that debt's recorded evidence (not an empty list).
	it("N4: empty current-run evidence falls back to the related debt's own recorded failing tests", () => {
		const out = run({
			baseDecision: redBlock(),
			editedFile: SRC,
			openDebts: [makeDebt({ file: SRC, kind: "red_suite", failingTestFiles: ["a.ts", "b.ts"] })],
		});
		expect(out.decision?.warnings?.[0]).toContain("the failing test file(s) (a.ts, b.ts)");
	});

	// test-contract: invariant — refreshRedEvidence detects a length change between the recorded and current
	// failing-test sets and re-opens the debt with the new (shorter) set.
	it("O1: a shrunk failing-test set re-opens the red debt with the new, shorter evidence", () => {
		const out = run({
			baseDecision: redBlock(["a.test.ts"]),
			editedFile: SRC,
			openDebts: [makeDebt({ file: SRC, kind: "red_suite", failingTestFiles: ["a.test.ts", "b.test.ts"] })],
		});
		expect(out.txns).toContainEqual(
			expect.objectContaining({ op: "open", failingTestFiles: ["a.test.ts"] }),
		);
	});

	// test-contract: invariant — sameStringSet requires membership for EVERY entry, not just some; a same-length,
	// partially-overlapping set must still be treated as changed evidence and re-open the debt.
	it("O2: a same-length but only-partially-overlapping failing-test set is treated as CHANGED evidence", () => {
		const out = run({
			baseDecision: redBlock(["a.ts", "y.ts"]),
			editedFile: SRC,
			openDebts: [makeDebt({ file: SRC, kind: "red_suite", failingTestFiles: ["a.ts", "x.ts"] })],
		});
		expect(out.txns).toContainEqual(
			expect.objectContaining({ op: "open", failingTestFiles: ["a.ts", "y.ts"] }),
		);
	});

	// test-contract: boundary — resolveWander must not block a wander that IS related to an open debt even when
	// a SECOND, unrelated debt is also open and at the WIP limit ("some", not "every", relatedness).
	it("Q1: staying in-pair with one open debt is never blocked, even alongside a second unrelated open debt", () => {
		const out = run({
			editedFile: SRC,
			openDebts: [
				makeDebt({ file: SRC, kind: "coverage" }),
				makeDebt({ file: "src/other.ts", kind: "coverage" }),
			],
		});
		expect(out.decision).toBeNull();
	});

	// test-contract: boundary — below the WIP limit, an unrelated wander is never blocked and never noted, even
	// though a foreign debt technically exists (the early "stillOpen.length < wipLimit" short-circuit governs).
	it("R1: below the configured WIP limit, an unrelated wander produces neither a block nor a foreign note", () => {
		const out = run({
			editedFile: "src/other.ts",
			openDebts: [makeDebt({ file: SRC, kind: "coverage", sessionId: "other-session" })],
			wipLimit: 2,
		});
		expect(out.decision).toBeNull();
	});

	// test-contract: boundary — when this session's own open-debt count is BELOW the WIP limit, resolveWander must
	// not block even though a truthy oldestOwn exists — the AND of (oldestOwn present) and (own count >= limit) is
	// required, not an OR, and the count check itself must not be forced true.
	it("S1: an own debt below the WIP limit never blocks a wander; it falls through to the foreign-note path", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [
				makeDebt({ file: SRC, kind: "coverage", sessionId: "session" }),
				makeDebt({ file: "src/other2.ts", kind: "coverage", sessionId: "foreign" }),
			],
			wipLimit: 2,
		});
		expect(out.decision?.decision).toBe("allow");
		expect(out.decision?.decision).not.toBe("block");
	});

	// test-contract: security — the foreign-debt finder must only match debts whose sessionId actually differs from
	// the current session; it must never pick the first stillOpen entry regardless of ownership.
	it("T1: the foreign-debt note names the TRULY foreign debt's file, never an earlier same-session debt's file", () => {
		const out = run({
			editedFile: "src/unrelated.ts",
			openDebts: [
				makeDebt({ file: "src/mine.ts", kind: "coverage", sessionId: "session" }),
				makeDebt({ file: "src/theirs.ts", kind: "coverage", sessionId: "foreign-session" }),
			],
			wipLimit: 2,
		});
		expect(out.decision?.warnings?.[0]).toContain("src/theirs.ts");
		expect(out.decision?.warnings?.[0]).not.toContain("src/mine.ts");
	});

	// test-contract: invariant — decideCoverageDebt's step-1 recheck-discharge loop only discharges COVERAGE-kind
	// debts; a red_suite debt with a true recheck must stay open and go on to block an unrelated wander.
	it("U1: a true recheck on a red_suite debt's file does not discharge it — the debt stays open and blocks", () => {
		const out = run({
			baseDecision: null,
			editedFile: "src/other.ts",
			openDebts: [makeDebt({ file: "src/red.ts", kind: "red_suite" })],
			rechecks: new Map([["src/red.ts", true]]),
			wipLimit: 1,
		});
		expect(out.decision?.decision).toBe("block");
	});

	// test-contract: invariant — the same recheck-discharge loop, when it DOES fire (coverage kind, true recheck),
	// records the discharge with source: "local" exactly.
	it("U2: a discharged coverage debt records its transition with source \"local\" exactly", () => {
		const out = run({
			baseDecision: null,
			editedFile: SRC,
			openDebts: [makeDebt({ file: SRC, kind: "coverage" })],
			rechecks: new Map([[SRC, true]]),
		});
		expect(out.txns[0]).toMatchObject({ op: "discharge", source: "local" });
		expect(out.decision).toBeNull();
	});

	// test-contract: boundary — the FINAL "edited the debted source and it now reads covered" discharge check must
	// only fire when baseDecision is ACTUALLY null; a non-null, non-block, pass-through decision must pass through
	// UNCHANGED with no discharge, leaving the coverage debt open.
	it("V1: a non-null pass-through decision is returned unchanged and does not trigger the covered-now discharge", () => {
		const passthrough: HarnessDecision = { decision: "allow" };
		const out = run({
			baseDecision: passthrough,
			editedFile: SRC,
			openDebts: [makeDebt({ file: SRC, kind: "coverage" })],
			rechecks: new Map(),
		});
		expect(out.decision).toEqual(passthrough);
		expect(out.txns).toHaveLength(0);
	});

	// test-contract: invariant — the freshly-opened coverage debt's transition carries an exact empty contentHash
	// and kind "coverage" — not any other literal value.
	it("W1: opening a coverage debt records an exact contentHash of \"\" and kind \"coverage\"", () => {
		const out = run({ baseDecision: uncoveredBlock(SRC), editedFile: SRC });
		expect(out.txns[0]).toMatchObject({ op: "open", kind: "coverage", contentHash: "" });
	});
});
