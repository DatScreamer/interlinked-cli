// Mutation-hardening tests for gitignored-write.ts — W6 residue wave
// (scratch/fleet-r3/CONTRACT-W6.md), killing survivors left after two prior
// kill campaigns (gitignored-write.test.ts + gitignored-write.mutation-hardening.test.ts).
//
// Every assertion here was empirically verified against a shadow-mutated
// copy of the module (scratch/fleet-r3/gw-w6-fuzz.mts, built on
// scratch/probes/mutant-shadow-runner.ts): the assertion passes against the
// real module and FAILS against the specific mutant it targets. Receipts:
// scratch/fleet-r3/receipts/src_harness_checks_gitignored-write.ts.jsonl.

import { describe, expect, it } from "vitest";
import { detectGitignoredWrites } from "./gitignored-write.js";

const TS = "src/setup/init.ts";

function everythingIgnored(_p: string): boolean {
	return true;
}

// ─── extractFirstArg: outer-call bracket depth-tracking for "[" and "{" ────
// Kills: the ConditionalExpression->false and StringLiteral->"" mutants on
// `ch === "["` and `ch === "{"` inside extractFirstArg's depth-tracking.
//
// The witness needs a SINGLE-ARG outer call (no trailing `, data`) so that
// extractFirstArg's own depth-reaches-0 termination — not a top-level comma —
// is what decides where the first arg ends. With "[" tracking disabled, the
// stray "[" never opens a nesting level, so the comma right after it is
// wrongly read as join()'s own top-level separator (swallowed instead of
// splitting), and the depth deficit this leaves means the outer close paren
// (not join's own) is what extractFirstArg mistakes for "depth reached 0" —
// producing a COMPLETE, `)`-terminated `join(...)` string that resolvePathArg
// accepts, with `("a"[, "b"` merged as a single (mis-parsed but non-null)
// literal by extractStringLiteral's own greedy backtracking. Under the real
// module, extractFirstArg keeps counting past that same closing paren
// (looking for a THIRD close it will never find) and the loop runs out,
// returning null — no finding.
describe("detectGitignoredWrites — extractFirstArg bracket depth-tracking for [ and { (must NOT fire)", () => {
	it("P1: a stray unmatched '[' inside a single-arg join() call must not merge segments into a false literal", () => {
		const code = 'writeFileSync(join("a"[, "b"))';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P2: a stray unmatched '{' inside a single-arg join() call must not merge segments into a false literal", () => {
		const code = 'writeFileSync(join("a"{, "b"))';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── resolvePathArg: absolute-path check must be startsWith, not endsWith ──
// Kills: the MethodExpression mutant `lit.startsWith("/")` -> `lit.endsWith("/")`.
// A literal that STARTS with "/" is a genuine absolute OS path and must be
// skipped (never flagged). The existing regression test for this behavior
// ("does not flag absolute OS paths") uses "/tmp/out.json", whose "tmp"
// segment ALSO satisfies the unrelated isEphemeralTarget check — so it stays
// unresolvable either way and never exercised this specific line. "/etc/x.json"
// has no ephemeral segment or extension, isolating the absolute-path check.
describe("detectGitignoredWrites — absolute-path check is anchored to the START of the literal (must NOT fire)", () => {
	it("P1: a bare literal starting with '/' is skipped as absolute even with no ephemeral segment in the path", () => {
		const code = 'writeFileSync("/etc/passwd", data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── splitTopLevelArgs: a bracket char immediately followed by its OWN
// matching close, placed right after a clean quoted literal and before a
// real top-level comma (W6 residue wave, second pass — 25 survivors killed
// by 4 witnesses; scratch/fleet-r3/gw-w6b-second-pass.mts) ─────────────────
//
// The pair is COUNT-BALANCED, so extractFirstArg (untouched by any of these
// mutants) still finds the true join(...) boundary and hands
// splitTopLevelArgs the intended innerRaw. Inside splitTopLevelArgs, the
// mutant's disabled half of the pair leaves `depth` NONZERO (not 0) at the
// real top-level comma that follows, so that comma is wrongly swallowed
// instead of splitting. The resulting UNSPLIT span (quote ... more chars
// ... quote) still matches extractStringLiteral's regex, because `[^\\]` in
// its lazy-backtracking capture group accepts embedded quote/bracket
// characters — the regex only requires the FIRST and LAST characters to be
// a matching quote pair, not that the interior be "clean". Under the real
// module, the trailing bracket char breaks that shape (segment ends in `(`
// / `[` / `{`, not a quote), so resolvePathArg correctly nulls the call.
//
// A SINGLE witness per bracket type kills every atomic/combined/opposite-
// direction mutant on that type's open+close pair, because all of them
// converge on the same observable: depth stays nonzero across the real
// comma. Verified per-mutant via a physical shadow-mutant build (not just
// hand-trace): scratch/fleet-r3/gw-w6b-final-check.mts.
describe("detectGitignoredWrites — a balanced bracket pair right after a literal defeats the depth counter (must NOT fire)", () => {
	it("P1: an empty parenthesis pair after a literal leaves the following real comma nested, nulling the call", () => {
		// Kills (all splitTopLevelArgs): the "(" and ")" atomic/3-way/2-way
		// ConditionalExpression->false and LogicalOperator mutants, the ""("
		// / ")"" StringLiteral->"" mutants, the depth++/depth-- block-body
		// and UpdateOperator-direction mutants for BOTH the open and close
		// bracket handling (16 mutantIds total — the open and close blocks
		// share this one witness because either side going "stuck nonzero"
		// produces the identical observable: the pair's own imbalance).
		const code = 'writeFileSync(join("a"(), "b"), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P2: an empty bracket pair after a literal leaves the following real comma nested, nulling the call", () => {
		// Kills: ch==="[" ->false, "["->"" , ch==="]"->false, "]"->"".
		const code = 'writeFileSync(join("a"[], "b"), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});

	it("P3: an empty brace pair after a literal leaves the following real comma nested, nulling the call", () => {
		// Kills: ch==="{" ->false, "{"->"" , ch==="}"->false, "}"->"".
		const code = 'writeFileSync(join("a"{}, "b"), data);';
		const results = detectGitignoredWrites(code, TS, everythingIgnored);
		expect(results).toEqual([]);
	});
});

// ─── splitTopLevelArgs: comma-split condition must respect nesting depth,
// not just character identity (must resolve to the CORRECT joined value) ──
//
// Kills the `depth === 0` -> `true` mutant (every comma splits, regardless
// of nesting). A nested parenthesized group whose CLOSE is immediately
// followed — with NO comma — by another quoted literal gives pristine and
// mutant two DIFFERENT split boundaries that are BOTH still regex-valid
// "literals" via extractStringLiteral's lazy backtracking (which accepts
// any embedded, non-backslash character between the delimiting quotes).
// Pristine keeps the whole nested group as one segment (comma inside stays
// nested); the mutant splits at that inner comma too, producing a shorter
// first segment and merging the close-paren into the next one — both
// resolve to A quoted-literal shape, but not the SAME one, so the final
// joined path differs. isIgnored is pinned to the PRISTINE resolved value
// only, so the mutant (whose resolved value differs) produces no finding.
describe("detectGitignoredWrites — the comma-split decision must respect nesting depth, not fire unconditionally (must fire with the correct resolved value)", () => {
	it("P1: a nested group directly followed by another literal (no separating comma) resolves via the depth-aware split boundary", () => {
		const code = 'writeFileSync(join("a"("z","y")"c", "b"), data);';
		const results = detectGitignoredWrites(code, TS, (p) => p === 'a"("z","y")"c/b');
		expect(results).toEqual([{ line: 1, text: 'writeFileSync(join("a"("z","y")"c", "b"), data);' }]);
	});
});
