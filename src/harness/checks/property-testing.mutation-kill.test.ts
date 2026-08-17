// interlinked: defer test_missing_sut_import -- detector strips only .test.ts (followup #24); this file imports the real SUT ./property-testing.js below
// Mutation-kill safety net for src/harness/checks/property-testing.ts (W6
// residue campaign, scratch/fleet-r3/CONTRACT-W6.md). The 38-survivor
// inventory this file responds to was measured (generation 761) against the
// mutation runner's HEAD-reset checkout — at that commit,
// property-testing.integration.test.ts's asymmetric-reference coverage did
// not exist yet (685 uncommitted insertion lines in the working tree at the
// time of this campaign). This file exists so mutant e32494f8dd632c0a's kill
// does not depend on that sibling file's uncommitted state ever landing —
// it is a small, independent, self-contained proof.
//
// Placement per CONTRACT-W6: no `property-testing.test.ts` companion stem
// exists, so this `*.mutation-kill.test.ts` (top-level static SUT import)
// is the correct home.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkUntestedIdempotent, checkUntestedInversePair } from "./property-testing.js";
// interlinked: defer test_legitimacy -- sanctioned test seam export, required to build the cwd-mismatch fixtures
import { __setPackageRootForTesting } from "./shared.js";

describe("checkUntestedInversePair — pairHasRoundTripTest requires BOTH names, not just one (mutation-kill e32494f8dd632c0a)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-mutkill-asym-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	// test-contract: invariant — checkUntestedInversePair must flag an inverse pair even when the candidate test covers only one name.
	it(
		"still fires when the co-located candidate test references ONLY the forward half of the pair",
		() => {
			// If the inverse-name regex (built from the template literal
			// `\b${b}\b`) ever degrades to an empty pattern, it matches every
			// string unconditionally — a candidate file that mentions ONLY
			// "encode" would then read as covering "decode" too, wrongly
			// suppressing this finding. A forward-only reference is the
			// fixture that isolates exactly that failure mode.
			writeFileSync(
				join(dir, "widget.ts"),
				"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			);
			writeFileSync(
				join(dir, "widget.test.ts"),
				"import { encode } from './widget.js';\nit('encodes', () => { expect(encode('a')).toBeDefined(); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
			expect(checkUntestedInversePair(src, join(dir, "widget.ts"), dir).length).toBeGreaterThan(0);
		},
		60_000,
	);
});

// ===========================================
// W6 round-2 residue kills (scratch/fleet-r3/CONTRACT-W6.md). Round 1
// classified these four as equivalent via fuzz_no_divergence; each is a
// genuine kill found by hand-crafted structural inputs the fuzz corpus
// apparently never generated (unmatched interior parens, and a real file on
// disk literally named "Stryker was here").
// ===========================================

describe("exportTakesArg (via checkUntestedIdempotent) — internal `(` search survives a stray leading close-paren (mutation-kill ca76b917129357f9)", () => {
	// test-contract: invariant — exportTakesArg's `sig.indexOf("(")` must find
	// the FIRST literal open-paren; if it is forced to `indexOf("")` (always
	// 0), the depth-tracking scan starts one char before an unmatched interior
	// ")" it would otherwise skip over, driving `depth` negative and making
	// the scan miss every real parameter character.
	// test-contract: boundary — exportTakesArg's paren scan must locate the true '(' and track depth correctly past a stray leading ')'.
	it("still reports the function as argument-taking when the accumulated signature text contains a stray ')' before the real '(' group", () => {
		// Line 1 ends in the literal word "function" (no paren on that line, so
		// extractExportedNames' function-branch — `(?:function\\b|\\()` —
		// matches on the keyword alone); line 2 supplies a ')' BEFORE the real
		// param-list '(' the same way `functionNORM)(x) {` would misparse if
		// indexOf ever stopped honoring the actual paren position.
		const content = "export const normalize = function\nNORM)(x) {\n  return x;\n}\n";
		const out = checkUntestedIdempotent(content, "zzqp_w6r2_argscan.ts", process.cwd());
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("idempotent-shaped normalize");
	});
});

describe("exportTakesArg (via checkUntestedIdempotent) — nested-paren depth tracking (mutation-kill 537b4ba257ef0fb1)", () => {
	// test-contract: invariant — only the OUTERMOST opening paren (depth going
	// 0→1) is skipped by the `continue`; any deeper '(' (depth going 1→2 or
	// higher) must still be appended to `params`. Forcing every '(' to take
	// the `continue` branch (as if `depth === 1` were always true) drops that
	// second paren character, and with no other parameter text present the
	// accumulated `params` string goes from non-empty to empty.
	// test-contract: boundary — exportTakesArg must count a nested '(' as parameter content instead of treating every '(' as the outer skip.
	it("still reports the function as argument-taking for an unterminated, once-nested parameter list ('((' with no matching content or close)", () => {
		// sig = "export function normalize((" — the scan reaches only two
		// characters after `open`: the outer '(' (always skipped) and the
		// inner '(' (must be appended for `params` to be non-empty; the loop
		// ends at end-of-signature before any closing paren is seen).
		const content = "export function normalize((";
		const out = checkUntestedIdempotent(content, "zzqp_w6r2_nestparen.ts", process.cwd());
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toContain("idempotent-shaped normalize");
	});
});

describe("checkUntestedIdempotent — candidate-list ternary fallback must stay empty when the basename strips to '' (mutation-kill 876c6dc37313f2c7)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-w6r2-idem-fallback-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	// test-contract: boundary — checkUntestedIdempotent's candidate list must stay empty (never read from disk) when the basename strips to ''.
	it(
		// test-contract: boundary — when `baseNoExt` is empty, `candidates`
		// takes the ternary's `: []` branch and getGitSourceFiles is never
		// called (no git repo needed here). If that literal `[]` is replaced
		// by a non-empty array, the read loop would attempt (and, given a
		// literally-named file on disk, succeed at) reading a file whose name
		// is the mutant's own injected string — which must never happen.
		"still fires (does not read a phantom 'Stryker was here' candidate) when a file with exactly that name exists in cwd and mentions the function",
		() => {
			// interlinked: defer write_without_mkdir -- dir is the mkdtempSync tmpdir created above
		writeFileSync(join(dir, "Stryker was here"), "this file mentions normalize but must never be read");
			const content = "export function normalize(x: string){ return x.trim(); }";
			// filePath ".ts" strips to an empty basename (relFromRoot=".ts" ->
			// pop()=".ts" -> strip trailing ext -> "").
			const out = checkUntestedIdempotent(content, ".ts", dir);
			expect(out).toHaveLength(1);
			expect(out[0]?.text).toContain("idempotent-shaped normalize");
		},
	);
});

describe("checkUntestedInversePair — candidate-list ternary fallback must stay empty when the basename strips to '' (mutation-kill 3d95fa5d2eeb018d)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-w6r2-inv-fallback-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	// test-contract: boundary — checkUntestedInversePair's candidate list must stay empty (never read from disk) when the basename strips to ''.
	it(
		// test-contract: boundary — same ternary-fallback contract as above,
		// for checkUntestedInversePair's own `candidates` array. A file
		// literally named "Stryker was here" mentioning BOTH pair halves must
		// never be read as a round-trip test.
		"still fires (does not read a phantom 'Stryker was here' candidate) when a file with exactly that name exists in cwd and mentions both pair halves",
		() => {
			// interlinked: defer write_without_mkdir -- dir is the mkdtempSync tmpdir created above
		writeFileSync(join(dir, "Stryker was here"), "mentions encode and decode together but must never be read");
			const content = "export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
			const out = checkUntestedInversePair(content, ".ts", dir);
			expect(out).toHaveLength(1);
			expect(out[0]?.text).toContain("encode/decode");
		},
	);
});

// ===========================================
// Fresh-eyes round (scratch/fleet-r3/CONTRACT-W6.md LEAN MODE, fresh_eyes_r2).
// `isTestFile` (imported from ./shared.js) is NOT a narrow "*.test.ts" check —
// it is `isPatternDataFile` = `isStrictTestFile || isHarnessInternalDataFile`,
// and `isHarnessInternalDataFile` resolves a RELATIVE input against the REAL
// `process.cwd()` (via bare `resolve(raw)`), completely independent of the
// `cwd` PARAMETER these functions take. That makes `isTestFile(relFromRoot)`
// able to diverge from `isTestFile(filePath)` even though the prior round
// treated them as interchangeable — the two kills below exploit exactly that
// gap, using the package's own `__setPackageRootForTesting` test seam
// (established usage: shared.test.ts) to make the divergence deterministic
// without depending on the real repo's absolute path.
// ===========================================

describe("checkUntestedIdempotent — f !== relFromRoot self-exclusion survives isTestFile's harness-internal-data widening (mutation-kill 87461b565a83ca12)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-freshr2-selfpath-idem-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => __setPackageRootForTesting(undefined));

	// test-contract: invariant — checkUntestedIdempotent must exclude the SUT's own relativized path from candidates even when isTestFile misreads that path as harness-internal-data.
	it(
		// test-contract: invariant — the candidate filter's `f !== relFromRoot`
		// conjunct must exclude the SUT's OWN relativized path from the
		// candidate pool REGARDLESS of what isTestFile(f) reports for that
		// path. isTestFile is the wide isPatternDataFile union, and its
		// isHarnessInternalDataFile half resolves a relative `f` against the
		// REAL process.cwd() — not the `cwd` parameter — so relFromRoot can
		// independently read as harness-internal-data-shaped (via a
		// `harness/checks/` path segment) even when the guard's
		// isTestFile(filePath) (checked on the pre-relativized ABSOLUTE
		// string, which lives under an unrelated tmp root) did not. If the
		// self-exclusion conjunct is ever forced to `true`, the SUT's own
		// on-disk content — deliberately seeded here with the target name —
		// gets admitted as a candidate and wrongly suppresses the finding.
		"still fires when the SUT's own relativized path independently reads as harness-internal-data-shaped",
		() => {
			__setPackageRootForTesting(process.cwd());
			mkdirSync(join(dir, "harness", "checks"), { recursive: true });
			const filePath = join(dir, "harness", "checks", "decoyfile.ts");
			// Seeded so that IF this path were ever wrongly admitted as its own
			// candidate and read back off disk, the finding would be suppressed.
			writeFileSync(filePath, "this file mentions normalize but must never be read as a candidate");
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const content = "export function normalize(x: string){ return x; }";
			const out = checkUntestedIdempotent(content, filePath, dir);
			expect(out).toHaveLength(1);
			expect(out[0]?.text).toContain("idempotent-shaped normalize");
		},
		60_000,
	);
});

describe("checkUntestedInversePair — f !== relFromRoot self-exclusion survives isTestFile's harness-internal-data widening (mutation-kill a32bb059d08187c5)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pt-freshr2-selfpath-inv-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	afterEach(() => __setPackageRootForTesting(undefined));

	// test-contract: invariant — checkUntestedInversePair must exclude the SUT's own relativized path from candidates even when isTestFile misreads that path as harness-internal-data.
	it(
		// test-contract: invariant — same self-exclusion contract as the
		// checkUntestedIdempotent sibling above, for checkUntestedInversePair's
		// own candidate filter. The seeded on-disk content mentions BOTH pair
		// halves, so a wrongly-admitted self-candidate would satisfy
		// pairHasRoundTripTest's requirement for both names and suppress the
		// finding.
		"still fires when the SUT's own relativized path independently reads as harness-internal-data-shaped",
		() => {
			__setPackageRootForTesting(process.cwd());
			mkdirSync(join(dir, "harness", "checks"), { recursive: true });
			const filePath = join(dir, "harness", "checks", "decoyfile.ts");
			writeFileSync(filePath, "mentions encode and decode together but must never be read as a candidate");
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const content = "export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
			const out = checkUntestedInversePair(content, filePath, dir);
			expect(out).toHaveLength(1);
			expect(out[0]?.text).toContain("encode/decode");
		},
		60_000,
	);
});
