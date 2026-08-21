import { describe, expect, it } from "vitest";
import type { CoverageObligation } from "./coverage-obligation-ledger.js";
import {
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnresolvedRedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
} from "./verification-stop-checks.js";

function obligation(file: string): CoverageObligation {
	return {
		kind: "coverage",
		file,
		reason: "budget_exceeded",
		estimated_suite_ms: 30_000,
		budget_ms: 25_000,
		session_id: "r25",
		timestamp: "2026-08-21T00:00:00.000Z",
	};
}

describe("formatUnverifiedCodeWarning — positive (must fire)", () => {
	// test-contract: public-api — pins every literal segment of the "no invocation observed" message.
	it("P1: renders the exact message when nothing was verified", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 10,
				verifyCommandCount: 0,
				verificationObserved: new Set(),
			}),
		).toBe(
			"[interlinked:verify-before-stop] Stopping with 10 code file edit(s) and no tsc / test / lint / build " +
				"invocation observed — a verify-to-edit cadence of 0.00, well below the ~0.5–1.0 verifications per " +
				"edit the best agents sustain. Before stopping, run the project's typecheck or tests (e.g., " +
				"`npx tsc --noEmit`, `bun run test`, or the project's verify command) to confirm the edits actually " +
				"compile and pass. Don't claim done on unverified work.",
		);
	});
});

describe("formatUnverifiedCodeWarning — negative (must not fire)", () => {
	// test-contract: boundary — the ratio floor is inclusive (>=), so an exact 0.10 ratio is satisfied, not exceeded.
	it("N1: treats an exact 0.10 ratio as satisfied", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 20,
				verifyCommandCount: 2,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	// test-contract: invariant — "lint" must be the literal member of INDIVIDUAL_CORRECTNESS_SIGNALS the filter matches against.
	it("N2: counts an observed 'lint' signal toward the verify ratio", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 10,
				verifyCommandCount: 0,
				verificationObserved: new Set(["lint"]),
			}),
		).toBeNull();
	});

	// test-contract: invariant — "build" must be the literal member of INDIVIDUAL_CORRECTNESS_SIGNALS the filter matches against.
	it("N3: counts an observed 'build' signal toward the verify ratio", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 10,
				verifyCommandCount: 0,
				verificationObserved: new Set(["build"]),
			}),
		).toBeNull();
	});
});

describe("formatVerifyNotRunWarning", () => {
	// test-contract: boundary — the verify-suite signal must categorically suppress this nudge.
	it("N1: suppresses the nudge once the verify suite ran", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 3,
				verificationObserved: new Set(["verify-suite", "typecheck"]),
			}),
		).toBeNull();
	});

	// test-contract: public-api — pins every literal segment of the partial-verification message.
	it("P1: renders the exact partial-verification message", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 3,
				verificationObserved: new Set(["typecheck"]),
			}),
		).toBe(
			"[interlinked:verify-before-stop] Stopping with 3 code file edit(s) and partial verification — " +
				"individual checks ran but `interlinked verify` did not. The verify suite is the canonical local " +
				"mirror of CI (tsc + biome + lint + secrets + SAST + docs:check + dep-audit aggregated). Run " +
				"`interlinked verify` before stopping to confirm the full pipeline is clean — a green tsc doesn't " +
				"catch docs drift, secrets, or the lint/SAST findings verify aggregates.",
		);
	});
});

describe("formatUiNotInteractedWarning", () => {
	// test-contract: public-api — pins every literal segment of the UI-not-interacted message.
	it("P1: renders the exact message", () => {
		expect(
			formatUiNotInteractedWarning({ uiFilesEdited: 2, verificationObserved: new Set() }),
		).toBe(
			"[interlinked:verify-before-stop] Stopping with 2 UI file edit(s) (.tsx / .jsx / .html / .css / .vue / " +
				".svelte / .astro) and no browser interaction this session — neither a dev server (wrangler dev / " +
				"vite / npm run dev) nor a chrome-devtools / playwright MCP call was observed. Type-checking is not " +
				"feature-checking: load the page and verify what you built before claiming done.",
		);
	});
});

describe("formatStubsIntroducedWarning", () => {
	// test-contract: public-api — no truncation branch; pins the join newline, the empty "more" suffix, and both closing sentences.
	it("P1: renders the exact message with no truncation", () => {
		const stubs = [
			{ file: "/repo/a.ts", kind: "TODO", snippet: "do this" },
			{ file: "/repo/b.ts", kind: "FIXME", snippet: "fix this" },
		];
		expect(formatStubsIntroducedWarning({ stubs })).toBe(
			"[interlinked:verify-before-stop] Stopping with 2 stub / TODO / disabled-test addition(s) introduced " +
				"this session:\n  - a.ts [TODO]: do this\n  - b.ts [FIXME]: fix this\n" +
				"If these are deliberate scaffolding, document the follow-up in a TODO list or issue. " +
				"If they're forgotten work, finish them before stopping.",
		);
	});

	// test-contract: boundary — length exactly equal to maxShown must not be read as "over the limit" (kills > → >=).
	it("N1: does not truncate when the count exactly equals maxShown", () => {
		const stubs = Array.from({ length: 5 }, (_, i) => ({
			file: `/repo/x${i}.ts`,
			kind: "TODO",
			snippet: `s${i}`,
		}));
		expect(formatStubsIntroducedWarning({ stubs, maxShown: 5 })).not.toContain("...and");
	});

	// test-contract: invariant — an omitted maxShown must default via ?? (not &&) to 5, distinguishing the two only when undefined.
	it("P2: applies the default limit of 5 exactly, with the correct truncation suffix", () => {
		const stubs = Array.from({ length: 6 }, (_, i) => ({
			file: `/repo/file-${i}.ts`,
			kind: "TODO",
			snippet: `s${i}`,
		}));
		expect(formatStubsIntroducedWarning({ stubs })).toBe(
			"[interlinked:verify-before-stop] Stopping with 6 stub / TODO / disabled-test addition(s) introduced " +
				"this session:\n  - file-0.ts [TODO]: s0\n  - file-1.ts [TODO]: s1\n  - file-2.ts [TODO]: s2\n" +
				"  - file-3.ts [TODO]: s3\n  - file-4.ts [TODO]: s4\n  ...and 1 more\n" +
				"If these are deliberate scaffolding, document the follow-up in a TODO list or issue. " +
				"If they're forgotten work, finish them before stopping.",
		);
	});
});

describe("formatTddRegressionWarning", () => {
	// test-contract: public-api — no truncation branch; pins the join newline, the empty "more" suffix, and both closing sentences.
	it("P1: renders the exact message with no truncation", () => {
		const regressions = [{ sourceFile: "/repo/a.ts" }, { sourceFile: "/repo/b.ts" }];
		expect(formatTddRegressionWarning({ regressions })).toBe(
			"[interlinked:verify-before-stop] Stopping with 2 test regression(s) — a test that was passing " +
				"earlier this session is now failing:\n  - a.ts\n  - b.ts\n" +
				"A green→red transition means this session's edits broke previously-working " +
				"behavior. Re-run the test(s) and fix the regression before stopping.",
		);
	});

	// test-contract: boundary — length exactly equal to maxShown must not be read as "over the limit" (kills > → >=).
	it("N1: does not truncate when the count exactly equals maxShown", () => {
		const regressions = Array.from({ length: 5 }, (_, i) => ({ sourceFile: `/repo/x${i}.ts` }));
		expect(formatTddRegressionWarning({ regressions, maxShown: 5 })).not.toContain("...and");
	});

	// test-contract: invariant — an omitted maxShown must default via ?? (not &&) to 5, distinguishing the two only when undefined.
	it("P2: applies the default limit of 5 exactly, with the correct truncation suffix", () => {
		const regressions = Array.from({ length: 6 }, (_, i) => ({ sourceFile: `/repo/r${i}.ts` }));
		expect(formatTddRegressionWarning({ regressions })).toBe(
			"[interlinked:verify-before-stop] Stopping with 6 test regression(s) — a test that was passing " +
				"earlier this session is now failing:\n  - r0.ts\n  - r1.ts\n  - r2.ts\n  - r3.ts\n  - r4.ts\n" +
				"  ...and 1 more\nA green→red transition means this session's edits broke previously-working " +
				"behavior. Re-run the test(s) and fix the regression before stopping.",
		);
	});
});

describe("formatUnresolvedRedWarning", () => {
	// test-contract: public-api — pins ordering (checks then tests), the join newline, and the empty "more" suffix.
	it("P1: renders the exact message with no truncation", () => {
		const warning = formatUnresolvedRedWarning({
			redChecks: [{ kind: "lint", detail: "biome check" }, { kind: "build" }],
			redTests: [{ sourceFile: "/repo/x.ts" }],
			maxShown: 5,
		});
		expect(warning).toBe(
			"[interlinked:verify-before-stop] Stopping with 3 check/test that went red this session and never " +
				"went green again:\n  - lint (biome check)\n  - build\n  - test: x.ts\n" +
				"If you meant to leave it red — a known-failing test, an in-progress refactor, a " +
				"deliberately-pending check — that's fine; this is just a reminder to confirm the red " +
				"was intentional. Otherwise, re-run it and get it green before stopping.",
		);
	});

	// test-contract: invariant — items must be sliced by maxShown (kills the slice(0,max) → items identity mutation).
	it("N1: truncates the combined items list to maxShown, hiding later entries", () => {
		const warning = formatUnresolvedRedWarning({
			redChecks: [{ kind: "a" }, { kind: "b" }, { kind: "c" }],
			redTests: [{ sourceFile: "/repo/d.ts" }],
			maxShown: 2,
		});
		expect(warning).toContain("  - a\n  - b");
		expect(warning).not.toContain("test: d.ts");
		expect(warning).toContain("...and 2 more");
	});

	// test-contract: boundary — total count exactly equal to maxShown must not be read as "over the limit" (kills > → >=).
	it("N2: does not truncate when the total exactly equals maxShown", () => {
		const warning = formatUnresolvedRedWarning({
			redChecks: [{ kind: "a" }, { kind: "b" }],
			redTests: [],
			maxShown: 2,
		});
		expect(warning).not.toContain("...and");
	});
});

describe("formatDeferredCoverageWarning", () => {
	// test-contract: public-api — no truncation branch; pins every literal sentence and the join/more newlines.
	it("P1: renders the exact message with no truncation", () => {
		expect(formatDeferredCoverageWarning({ obligations: [obligation("src/a.ts")], maxShown: 5 })).toBe(
			"[interlinked:verify-before-stop] Stopping with 1 deferred coverage check(s) this session that " +
				"were never enforced — the per-edit coverage gate deferred them (suite runtime over budget) and " +
				"only the commit gate enforces them:\n  - a.ts\n" +
				"Run the full suite with coverage — a green run discharges the obligations its report " +
				"measures. (Committing also discharges them, via the commit gate, but that is the " +
				"user's call to make, not something to do in order to clear this notice.) This is a " +
				"reminder, not a block — a deferred check is unverified coverage, not a known failure. " +
				"If you are waiting on the user, say so and stop; this notice will not repeat.",
		);
	});

	// test-contract: boundary — count exactly equal to maxShown must not be read as "over the limit" (kills > → >=).
	it("N1: does not truncate when the count exactly equals maxShown", () => {
		const warning = formatDeferredCoverageWarning({
			obligations: [obligation("src/a.ts"), obligation("src/b.ts")],
			maxShown: 2,
		});
		expect(warning).not.toContain("...and");
	});
});

describe("formatBisectNotResetWarning", () => {
	const exactMessage =
		"[interlinked:verify-before-stop] Stopping with an unfinished git bisect — a " +
		"`git bisect start/good/bad/run` ran this session with no `git bisect reset` " +
		"after it. The working tree is likely still on an old commit in detached-HEAD " +
		"bisect state. Run `git bisect reset` to restore HEAD before stopping.";

	// test-contract: public-api — pins every literal segment; also proves lastReset's initial sentinel is -1 (not +1),
	// since a +1 sentinel would make the guard clause return null instead of this message.
	it("P1: renders the exact message for an unresolved bisect start", () => {
		expect(formatBisectNotResetWarning({ commandsRun: ["git bisect start"] })).toBe(exactMessage);
	});

	// test-contract: invariant — an unrelated command must NOT be read as a bisect reset (kills RESET_RE.test(c) → true).
	it("P2: an unrelated later command does not count as a reset", () => {
		expect(
			formatBisectNotResetWarning({
				commandsRun: ["git bisect start", "totally unrelated text"],
			}),
		).toBe(exactMessage);
	});

	// test-contract: boundary — a command matching BOTH patterns sets lastOp === lastReset at the same index;
	// equality must not count as "reset happened after" (kills lastReset > lastOp → >=).
	it("P3: an op and reset at the same command index is still unresolved", () => {
		expect(
			formatBisectNotResetWarning({
				commandsRun: ["git bisect start; git bisect reset"],
			}),
		).toBe(exactMessage);
	});

	// test-contract: invariant — the op regex must require one-or-more whitespace at BOTH gaps, not exactly one (kills \s+ → \s).
	it("P4: tolerates repeated whitespace throughout the op command", () => {
		expect(
			formatBisectNotResetWarning({ commandsRun: ["git  bisect   start"] }),
		).toBe(exactMessage);
	});

	// test-contract: invariant — the reset regex must require one-or-more whitespace at BOTH gaps, not exactly one (kills \s+ → \s).
	it("N1: tolerates repeated whitespace throughout the reset command", () => {
		expect(
			formatBisectNotResetWarning({
				commandsRun: ["git bisect start", "git  bisect   reset"],
			}),
		).toBeNull();
	});
});
