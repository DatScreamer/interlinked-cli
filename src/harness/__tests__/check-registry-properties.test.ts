// Generated property harness over the ENTIRE check-registry (plan 16 §6 /
// docs/plans/15 survivor-elimination underpinnings).
//
// Every registered check shares one signature —
//   fn: (content: string, filePath: string) => InlineMatch[]
// — so five properties can be DERIVED once and run for all ~252 checks
// instead of hand-written per detector (the thing that normally makes
// property testing not scale). A sixth property, LIVENESS ("can this check
// ever fire on anything?"), is deliberately NOT here — it needs real
// harvested fixtures, not arbitrary strings, and lives in the one-time sweep
// at `scratch/registry-properties/liveness-sweep.mts` (run via `npx tsx`,
// reported in plan 16 §6, not part of the vitest suite).
//
// Scope discipline: numRuns and the termination probe's byte sizes are kept
// small so the whole file runs in low tens of seconds, not minutes — this is
// an audit artifact over the registry's shared contract, not a per-edit gate.
//
// Absolute-ms timing is the one thing this repo has learned NOT to assert
// (see `checks/reinterpret-alignment.test.ts`'s "flood" test and plan 16
// §11.2's `absolute_ms_assertion_in_test` backlog entry: 4 prior instances,
// all fixed by a same-process COARSE ratio). The termination property below
// follows that exact pattern: a small control and a much-larger subject
// timed in-process, asserting a wide-margin ratio ceiling rather than a
// wall-clock bound.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings, stripComments as stripCommentsWithBraces, stripStrings } from "../checks/shared-text-utils.js";
import { CHECK_REGISTRY, type CheckRegistration } from "../check-registry/index.js";
import { stripAllLiterals, stripComments as stripCommentsGeneric, stripTemplateLiterals } from "../strip-helpers.js";

const NUM_RUNS = 12;

// A handful of checks are explicitly project-context-coupled (they close
// over `process.cwd()` to do a whole-repo graph walk — circular_imports,
// dead_exports, untested_inverse_pair, untested_idempotent; see the liveness
// sweep report for why). Property-testing those against ARBITRARY strings is
// still valid (totality/determinism/well-formedness must hold regardless),
// but the termination probe's 32x-larger input would multiply an
// already-heavy whole-project walk by 252 checks worth of runs, which is
// exactly the "minutes not hours" budget this file must respect. Skip the
// termination probe for that small set; everything else still applies.
const PROJECT_GRAPH_COUPLED = new Set(["circular_imports", "dead_exports", "untested_inverse_pair", "untested_idempotent"]);

function isFiniteNumber(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n);
}

/** Build `bytes` of filler content: repeated benign-looking lines. */
function fillerContent(bytes: number): string {
	const line = "const x = 1; // filler line for the termination probe\n";
	const reps = Math.max(1, Math.ceil(bytes / line.length));
	return line.repeat(reps).slice(0, bytes);
}

/** min-of-N timing (noise can only make a sample slower, never faster). */
function timeOf(fn: CheckRegistration["fn"], bytes: number, reps: number): number {
	const src = fillerContent(bytes);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < reps; i++) {
		const t0 = performance.now();
		fn(src, "src/termination-probe.ts");
		best = Math.min(best, performance.now() - t0);
	}
	return best;
}

describe("check-registry generated properties", () => {
	for (const check of CHECK_REGISTRY) {
		describe(check.id, () => {
			it("TOTALITY: never throws on arbitrary input (incl. unicode/control chars/empty)", () => {
				fc.assert(
					fc.property(fc.string({ maxLength: 400, unit: "binary" }), fc.string({ maxLength: 60 }), (content, filePath) => {
						expect(() => check.fn(content, filePath)).not.toThrow();
					}),
					{ numRuns: NUM_RUNS },
				);
				// Deterministic edge cases every check must survive regardless of
				// what the random generator happened to sample this run.
				const edgeCases: [string, string][] = [
					["", ""],
					["\0", "a.ts"],
					["\uD800", "a.ts"], // lone high surrogate
					["\uDC00", "a.ts"], // lone low surrogate
					["a".repeat(20_000), "a.ts"], // one very long line, no newlines
					["{".repeat(500), "a.ts"], // deeply nested opener, never closed
					["\n".repeat(500), "a.ts"], // all blank lines
				];
				for (const [content, filePath] of edgeCases) {
					expect(() => check.fn(content, filePath)).not.toThrow();
				}
			});

			it("DETERMINISM: same (content, filePath) called twice yields deeply-equal output", () => {
				fc.assert(
					fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 60 }), (content, filePath) => {
						const a = check.fn(content, filePath);
						const b = check.fn(content, filePath);
						expect(b).toEqual(a);
					}),
					{ numRuns: NUM_RUNS },
				);
			});

			it("OUTPUT WELL-FORMEDNESS: every match has a valid 1-based line number and string text", () => {
				fc.assert(
					fc.property(fc.string({ minLength: 1, maxLength: 400 }), fc.string({ maxLength: 60 }), (content, filePath) => {
						const lineCount = content.split("\n").length;
						const matches = check.fn(content, filePath);
						expect(Array.isArray(matches)).toBe(true);
						for (const m of matches) {
							expect(isFiniteNumber(m.line)).toBe(true);
							expect(m.line).toBeGreaterThanOrEqual(1);
							expect(m.line).toBeLessThanOrEqual(lineCount);
							expect(typeof m.text).toBe("string");
						}
					}),
					{ numRuns: NUM_RUNS },
				);
			});

			if (!PROJECT_GRAPH_COUPLED.has(check.id)) {
				it(
					"TERMINATION: stays roughly linear — a 32x-larger input costs nowhere near 32x^2",
					() => {
						const CONTROL_BYTES = 2 * 1024;
						const SUBJECT_BYTES = 32 * CONTROL_BYTES; // 64KB
						const control = timeOf(check.fn, CONTROL_BYTES, 3);
						const subject = timeOf(check.fn, SUBJECT_BYTES, 2);
						// Floor the denominator: a sub-millisecond control is
						// unresolvable by performance.now() and must never fail a
						// fast machine. Threshold follows the repo's own calibrated
						// pattern (reinterpret-alignment.test.ts): linear lands near
						// 32x, quadratic near 1024x — 150x leaves wide margin over
						// linear while still catching a quadratic blow-up.
						const ratio = subject / Math.max(control, 0.5);
						expect(ratio).toBeLessThan(150);
					},
					20_000,
				);
			}
		});
	}

	describe("IDEMPOTENCE of the shared strip/normalize helpers", () => {
		// These are genuinely idempotent by construction (stripping strings a
		// second time finds no strings left to strip) — not invented for this
		// harness. Skipped for helpers with no natural idempotence claim
		// (e.g. anything line-count-changing).
		const helpers: [string, (s: string) => string][] = [
			["stripComments (shared-text-utils)", stripCommentsWithBraces],
			["stripStrings (shared-text-utils)", stripStrings],
			["stripCommentsAndStrings (shared-text-utils)", stripCommentsAndStrings],
			["stripComments (strip-helpers)", stripCommentsGeneric],
			["stripAllLiterals (strip-helpers)", stripAllLiterals],
			["stripTemplateLiterals (strip-helpers)", stripTemplateLiterals],
		];

		for (const [name, fn] of helpers) {
			it(`${name}: applying twice equals applying once`, () => {
				fc.assert(
					fc.property(fc.string({ maxLength: 500 }), (content) => {
						const once = fn(content);
						const twice = fn(once);
						expect(twice).toEqual(once);
					}),
					{ numRuns: NUM_RUNS },
				);
			});
		}
	});
});
