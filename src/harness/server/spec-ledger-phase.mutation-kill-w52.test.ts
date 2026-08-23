import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prerefreshSpecLedger,
	runSpecLedgerPhase,
	setSharedSpecLedgerForTesting,
} from "./spec-ledger-phase.js";

interface FakeFinding {
	kind: string;
	file: string;
	line: number;
	message: string;
	relatedFiles: string[];
}

function makeFinding(
	kind: string,
	file: string,
	opts: Partial<{ relatedFiles: string[]; line: number; message: string }> = {},
): FakeFinding {
	return {
		kind,
		file,
		line: opts.line ?? 3,
		message: opts.message ?? `finding for ${file}`,
		relatedFiles: opts.relatedFiles ?? [],
	};
}

function fakeLedger(findings: FakeFinding[]) {
	return {
		refreshFile: vi.fn(),
		removeFile: vi.fn(),
		computeDrift: vi.fn(() => findings),
	};
}

interface FakeSession {
	spec_drift_outstanding: Array<{ file: string; line: number; message: string }> | undefined;
	pending_completions: Map<
		string,
		{
			source_file: string;
			affected_files: string[];
			resolved_files: Set<string>;
			recorded_at_tool_call: number;
			description: string;
		}
	>;
	tool_call_count: number;
}

function fakeSession(): FakeSession {
	return {
		spec_drift_outstanding: undefined,
		pending_completions: new Map(),
		tool_call_count: 7,
	};
}

function fakeCtx(cwd: string, specLedger: unknown = null) {
	return {
		cwd,
		rules: { spec_checks: undefined as { enabled?: boolean } | undefined },
		log: vi.fn(),
		specLedger,
	};
}

interface FakeAcc {
	checksRan: string[];
	allCheckResults: Array<{ determinism: string }>;
}

function fakeDecision(): { warnings?: string[] } {
	return {};
}

function fakeAcc(): FakeAcc {
	return { checksRan: [], allCheckResults: [] };
}

let tmp: string;
let outsideDirs: string[];

beforeEach(() => {
	outsideDirs = [];
	// realpath-resolve: on macOS the OS temp dir is itself a symlink
	// (/var/folders -> /private/var/folders). If ctx.cwd stayed unresolved
	// while a not-yet-existing file's canonicalPath() fallback returned the
	// unresolved form, `relative()` would spuriously walk up through "..".
	// Resolving once here keeps every test's cwd/file pairing consistent.
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-ledger-phase-w52-")));
	setSharedSpecLedgerForTesting(null);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	for (const dir of outsideDirs) rmSync(dir, { recursive: true, force: true });
	setSharedSpecLedgerForTesting(null);
});

describe("driftDeterminism / driftTag via runSpecLedgerPhase — positive (must fire)", () => {
	// test-contract: invariant — driftDeterminism() classifies only the three
	// exact-match kinds (declared_fact_drift/xref_missing_anchor/xref_missing_file)
	// as fully_deterministic; every other kind, including count_claim_drift, is
	// partially_deterministic and must render the [heuristic] tag, not [proven].
	it("tags a non-listed kind (count_claim_drift) as heuristic/partially_deterministic", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const finding = makeFinding("count_claim_drift", rel);
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const warnings = decision.warnings;
		expect(warnings).toBeDefined();
		expect(warnings?.[0]).toContain("[heuristic]");
		expect(warnings?.[0]).not.toContain("[proven]");
		expect(acc.allCheckResults[0]?.determinism).toBe("partially_deterministic");
	});

	// test-contract: invariant — kind === "xref_missing_anchor" is one of the
	// three exact-match fully_deterministic kinds; the tag must be [proven].
	it("tags xref_missing_anchor as proven/fully_deterministic", () => {
		const abs = join(tmp, "doc2.md");
		writeFileSync(abs, "# doc2\n");
		const rel = "doc2.md";
		const finding = makeFinding("xref_missing_anchor", rel);
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(decision.warnings?.[0]).toContain("[proven]");
		expect(decision.warnings?.[0]).not.toContain("[heuristic]");
		expect(acc.allCheckResults[0]?.determinism).toBe("fully_deterministic");
	});

	// test-contract: invariant — kind === "xref_missing_file" is one of the
	// three exact-match fully_deterministic kinds; the tag must be [proven].
	it("tags xref_missing_file as proven/fully_deterministic", () => {
		const abs = join(tmp, "doc3.md");
		writeFileSync(abs, "# doc3\n");
		const rel = "doc3.md";
		const finding = makeFinding("xref_missing_file", rel);
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(decision.warnings?.[0]).toContain("[proven]");
		expect(acc.allCheckResults[0]?.determinism).toBe("fully_deterministic");
	});
});

describe("canonicalPath catch-fallback via toLedgerPath — positive (must fire)", () => {
	// test-contract: bug — canonicalPath's catch branch must return the input
	// path `p` on a realpathSync failure. If the catch body were emptied, the
	// function would return undefined, and relative(cwd, undefined) throws a
	// TypeError before readFileSync ever runs — a different, wrong error is
	// logged instead of the expected ENOENT from the missing file.
	it("logs an ENOENT (not a path-type error) when the edited file does not exist on disk", () => {
		const missing = join(tmp, "missing.md");
		const ledger = fakeLedger([]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(
			ctx as never,
			missing,
			true,
			session as never,
			decision as never,
			acc as never,
		);

		expect(ctx.log).toHaveBeenCalledTimes(1);
		const msg = ctx.log.mock.calls[0]?.[0] as string;
		expect(msg).toContain("Spec-ledger phase error:");
		expect(msg).toMatch(/ENOENT/);
	});
});

describe("runSpecLedgerPhase — early-return guards — positive/negative (must fire)", () => {
	// test-contract: security/boundary — a file that resolves OUTSIDE ctx.cwd
	// (rel.startsWith("..")) must be skipped entirely: no ledger refresh, no
	// warnings. A `rel.startsWith("..") -> false` mutant, or the
	// startsWith->endsWith mutant (which is false for this path since it
	// doesn't literally end in ".."), would both wrongly let it through.
	it("skips a file whose relative path starts with '..' (outside cwd)", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "spec-ledger-phase-w52-outside-")));
		outsideDirs.push(outside);
		const abs = join(outside, "doc.md");
		writeFileSync(abs, "# outside\n");
		const ledger = fakeLedger([makeFinding("declared_fact_drift", "doc.md")]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(ledger.refreshFile).not.toHaveBeenCalled();
		expect(decision.warnings).toBeUndefined();
	});

	// test-contract: invariant — !isSpecEligibleFile(editedFilePath) must
	// short-circuit before any ledger work for a non-markdown file, even
	// though editedFileInRepo is true and the file exists and is readable.
	it("skips a non-eligible extension (.txt) entirely", () => {
		const abs = join(tmp, "notes.txt");
		writeFileSync(abs, "plain text notes");
		const ledger = fakeLedger([]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(ledger.refreshFile).not.toHaveBeenCalled();
		expect(decision.warnings).toBeUndefined();
	});
});

describe("toLedgerPath separator normalization — positive (must fire)", () => {
	// test-contract: public-api — toLedgerPath must key the ledger with a
	// forward-slash relative path. If the "\\"->"/" join separator were
	// emptied, nested-path segments would be glued together instead of
	// slash-separated.
	it("produces a forward-slash relative path (posix keys) for a nested file", () => {
		mkdirSync(join(tmp, "sub"), { recursive: true });
		const abs = join(tmp, "sub", "doc.md");
		writeFileSync(abs, "# nested\n");
		const finding = makeFinding("declared_fact_drift", "sub/doc.md");
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(ledger.refreshFile).toHaveBeenCalledWith("sub/doc.md", "# nested\n");
	});
});

describe("prerefreshSpecLedger — gating and filtering — positive/negative (must fire)", () => {
	// test-contract: public-api — ctx.rules.spec_checks.enabled === false must
	// fully disable the pre-refresh pass regardless of how many md paths are given.
	it("does not refresh anything when spec_checks.enabled === false, even with 2+ md paths", () => {
		const a = join(tmp, "a.md");
		const b = join(tmp, "b.md");
		writeFileSync(a, "a");
		writeFileSync(b, "b");
		const ledger = fakeLedger([]);
		const ctx = fakeCtx(tmp, ledger);
		ctx.rules.spec_checks = { enabled: false };

		prerefreshSpecLedger(ctx as never, [a, b]);

		expect(ledger.refreshFile).not.toHaveBeenCalled();
	});

	// test-contract: invariant — editedFilePaths.filter((p) => p &&
	// isSpecEligibleFile(p)) must drop falsy and non-markdown entries before
	// the >=2 threshold check; a degenerate filter (identity, or `||` instead
	// of `&&`) would let non-md/empty entries reach refreshFile.
	it("filters out non-eligible and falsy paths before counting, so a single real md path is a no-op", () => {
		const a = join(tmp, "a.md");
		writeFileSync(a, "a");
		const notMd = join(tmp, "a.txt");
		writeFileSync(notMd, "a");
		const ledger = fakeLedger([]);
		const ctx = fakeCtx(tmp, ledger);

		prerefreshSpecLedger(ctx as never, [a, notMd, ""]);

		expect(ledger.refreshFile).not.toHaveBeenCalled();
	});

	// test-contract: public-api — with 2+ eligible md paths, every one of them
	// must be refreshed with its own file content (not the raw array passed
	// through unfiltered, and not just the first entry).
	it("refreshes every eligible md path when 2+ are given, each with its own content", () => {
		const a = join(tmp, "a.md");
		const b = join(tmp, "b.md");
		writeFileSync(a, "content-a");
		writeFileSync(b, "content-b");
		const ledger = fakeLedger([]);
		const ctx = fakeCtx(tmp, ledger);

		prerefreshSpecLedger(ctx as never, [a, b]);

		expect(ledger.refreshFile).toHaveBeenCalledTimes(2);
		expect(ledger.refreshFile).toHaveBeenCalledWith("a.md", "content-a");
		expect(ledger.refreshFile).toHaveBeenCalledWith("b.md", "content-b");
	});
});

describe("recordFindings — stash cap and message cap — positive (must fire)", () => {
	// test-contract: invariant — the Stop-nudge stash is capped at
	// STASH_CAP=10 entries regardless of how many outstanding findings exist.
	it("caps the stash to 10 entries even when 15 findings exist", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const many = Array.from({ length: 15 }, (_, i) =>
			makeFinding("declared_fact_drift", rel, { line: i, message: `m${i}` }),
		);
		const ledger = fakeLedger(many);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(session.spec_drift_outstanding).toHaveLength(10);
	});

	// test-contract: invariant — each stashed finding message is truncated to
	// STASH_MESSAGE_CHARS=200 characters (the full untruncated message would
	// bloat the Stop-nudge payload).
	it("truncates each stashed message to 200 characters", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const longMsg = "x".repeat(250);
		const finding = makeFinding("declared_fact_drift", rel, { message: longMsg });
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const stashed = session.spec_drift_outstanding?.[0]?.message;
		expect(stashed).toHaveLength(200);
		expect(stashed).toBe("x".repeat(200));
	});
});

describe("recordFindings — MAX_WARNINGS_PER_EVENT boundary — positive/negative (must fire)", () => {
	// test-contract: boundary — at exactly MAX_WARNINGS_PER_EVENT=5 scoped
	// findings, no overflow notice is emitted (nothing was actually dropped).
	// A `findings.length >= MAX_WARNINGS_PER_EVENT` mutant would wrongly add
	// the overflow line here since 5 >= 5.
	it("emits exactly 5 warning lines and no overflow notice for exactly 5 findings", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const exactlyFive = Array.from({ length: 5 }, (_, i) =>
			makeFinding("declared_fact_drift", rel, { line: i, message: `m${i}` }),
		);
		const ledger = fakeLedger(exactlyFive);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(decision.warnings).toHaveLength(5);
	});

	it("does not include an overflow notice for exactly 5 findings", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const exactlyFive = Array.from({ length: 5 }, (_, i) =>
			makeFinding("declared_fact_drift", rel, { line: i, message: `m${i}` }),
		);
		const ledger = fakeLedger(exactlyFive);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const hasOverflow = decision.warnings?.some((w) => w.includes("more cross-file finding")) ?? false;
		expect(hasOverflow).toBe(false);
	});

	// test-contract: boundary — 6 findings exceed the 5-warning cap by
	// exactly 1; the overflow notice must report "1 more".
	it("emits exactly 1 overflow notice reporting 1 dropped finding for 6 findings", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const six = Array.from({ length: 6 }, (_, i) =>
			makeFinding("declared_fact_drift", rel, { line: i, message: `m${i}` }),
		);
		const ledger = fakeLedger(six);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		expect(decision.warnings).toHaveLength(6);
		expect(decision.warnings?.[5]).toContain("…and 1 more cross-file finding(s)");
	});
});

describe("recordSiblingCompletions — pending-completion payload — positive (must fire)", () => {
	// test-contract: public-api — a finding anchored in a sibling file (file
	// !== rel) must record a pending_completion whose affected_files is
	// exactly [f.file] and whose description embeds the finding's file:line
	// and kind.
	it("records affected_files as exactly [f.file] for a sibling-anchored finding", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const finding = makeFinding("declared_fact_drift", "other.md", { relatedFiles: [rel] });
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const entry = session.pending_completions.get("spec:declared_fact_drift:other.md:3");
		expect(entry?.affected_files).toEqual(["other.md"]);
	});

	it("records source_file as the edited (relative) file and preserves recorded_at_tool_call", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const finding = makeFinding("declared_fact_drift", "other.md", { relatedFiles: [rel] });
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const entry = session.pending_completions.get("spec:declared_fact_drift:other.md:3");
		expect(entry?.source_file).toBe(rel);
		expect(entry?.recorded_at_tool_call).toBe(7);
	});

	// test-contract: bug — description must not be emptied (ArrayDeclaration/
	// ObjectLiteral/StringLiteral mutants on this literal would drop the
	// human-readable follow-up text entirely).
	it("builds a non-empty description embedding the finding's file:line and kind", () => {
		const abs = join(tmp, "doc.md");
		writeFileSync(abs, "# doc\n");
		const rel = "doc.md";
		const finding = makeFinding("declared_fact_drift", "other.md", { relatedFiles: [rel] });
		const ledger = fakeLedger([finding]);
		const ctx = fakeCtx(tmp, ledger);
		const session = fakeSession();
		const decision = fakeDecision();
		const acc = fakeAcc();

		runSpecLedgerPhase(ctx as never, abs, true, session as never, decision as never, acc as never);

		const entry = session.pending_completions.get("spec:declared_fact_drift:other.md:3");
		expect(entry?.description).toBe(
			"[spec] declared_fact_drift: other.md:3 still states a value this edit may have outdated",
		);
	});
});
