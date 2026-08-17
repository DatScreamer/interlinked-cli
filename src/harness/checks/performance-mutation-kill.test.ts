// Mutation-kill hardening for src/harness/checks/performance.ts, targeting
// the survivors listed in
// scratch/fleet-r2/kill-briefs/src_harness_checks_performance.ts.json.
//
// Every assertion below was empirically verified before being written here:
// scratch/probes/perf-brief-run.mts shadow-builds each mutant (via
// scratch/probes/perf-brief-verify.mts, which applies the brief's own
// verbatim orig/repl text at the correct occurrence, resolved through a
// regex/string-aware brace scanner so it copes with performance.ts's heavy
// regex-literal use) and diffs this file's probe battery's output between
// the real module and each mutant. 103/112 survivors were killed this way.
// The remaining 9 — all inside extractIndentLoopBodies's single-line-body
// exclusion check — are empirically equivalent: reaching that check
// requires the preceding head regex to have already matched, which (given
// `.trim()`) forces `trimmed` to end with ":", which makes
// `!trimmed.endsWith(":")` provably always false there, so the check's
// truth value never affects output regardless of how it (or its `/:\s*\S/`
// sub-regex) is mutated. Proven over 400 randomized inputs per mutant with
// zero divergences in scratch/probes/perf-indent-fuzz-equivalence.mts — see
// the note at the end of this file for the full list and reasoning.

import { describe, expect, it } from "vitest";
import {
	checkArrayFromMap,
	checkFilterLength,
	checkJsonClonePattern,
	checkMathSpread,
	checkSpreadInReduce,
	extractBraceLoopBodies,
	extractIndentLoopBodies,
	getLoopBodies,
} from "./performance.js";

describe("extractBraceLoopBodies — isBraceLoopHeadLine anchor & delimiter boundaries", () => {
	it("N1: does not treat a mid-string 'xfor (' as a loop head (regex anchor)", () => {
		const code = "xfor (i = 0; i < 10; i++) {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("P1: recognizes an indented for-loop head (leading whitespace before 'for')", () => {
		const code = "  for (let i = 0; i < 10; i++) {\n    doWork();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.startLine).toBe(2);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();"]);
	});

	it("N2: does not treat 'forEach(' as a for-loop head", () => {
		const code = "forEach(items) {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("P2: recognizes 'while(x)' with no space before the paren", () => {
		const code = "while(x) {\n    doWork();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();"]);
	});

	it("N3: does not treat 'whileLoop(' as a while-loop head", () => {
		const code = "whileLoop(x) {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("P3: recognizes 'loop{' with no space before the brace (Rust)", () => {
		const code = "loop{\n    doWork();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();"]);
	});

	it("P4: recognizes 'loop {' with a space before the brace (Rust)", () => {
		const code = "loop {\n    doWork();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();"]);
	});
});

describe("extractBraceLoopBodies — for-await exclusion", () => {
	it("N1: excludes 'for await' with a single space (async iterator, not sequential)", () => {
		const code = "for await (const chunk of stream) {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("N2: excludes 'for  await' with two spaces too", () => {
		const code = "for  await (const chunk of stream) {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});
});

describe("extractBraceLoopBodies — findLoopBraceLine's 5-line lookahead window", () => {
	it("N1: does not check the line immediately past the 5-line lookahead window", () => {
		// A brace on the 6th line (index 5) must not be found — the window is
		// only [from, from+4]. Also exercises Math.min vs Math.max: with a
		// short window the two disagree here, so this doubles as that kill.
		const code =
			"for (let i = 0; i < 10; i++)\n\n\n\n\nsomethingElse() {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("N2: does not search past the window even with many more lines remaining", () => {
		const code =
			"for (let i = 0; i < 10; i++)\n\n\n\n\n\n\nsomethingElse() {\n    doWork();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});

	it("N3: the not-found sentinel must not be misread as 'brace found at index 1'", () => {
		// Line index 1 (absolute) deliberately holds an unrelated brace with a
		// positive net delta. If findLoopBraceLine's "not found" sentinel ever
		// became `+1` instead of `-1`, this unrelated function's body would be
		// misattributed to the for-loop at index 5, whose own 5-line window
		// (indices 5-9) contains no brace at all.
		const code = [
			"const x = 1;",
			"function unrelated() {",
			"    return 2;",
			"}",
			"const y = 2;",
			"for (let i = 0; i < 10; i++)",
			"",
			"",
			"",
			"",
			"somethingElse();",
		].join("\n");
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});
});

describe("extractBraceLoopBodies — captureLoopBody EOF handling", () => {
	it("P1: captures the body through EOF without throwing when no closing brace ever appears", () => {
		const code = "for (let i = 0; i < 10; i++) {\n    doWork();\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    doWork();", ""]);
	});
});

describe("extractBraceLoopBodies — initialDepth <= 0 guard", () => {
	it("N1: a self-contained single-line loop does not absorb the following unrelated block", () => {
		const code = "for (let i = 0; i < 3; i++) { x(); }\nif (cond) {\n    doStuff();\n}\n";
		expect(extractBraceLoopBodies(code)).toEqual([]);
	});
});

describe("extractBraceLoopBodies — body field is newline-joined", () => {
	it("P1: joins a multi-line body's `body` field with real newlines, not concatenation", () => {
		const code = "for (let i = 0; i < 10; i++) {\n    a();\n    b();\n}\n";
		const bodies = extractBraceLoopBodies(code);
		expect(bodies[0]?.body).toBe("    a();\n    b();");
	});
});

describe("extractIndentLoopBodies — head detection needs trim() and rejects embedded matches", () => {
	it("P1: recognizes an indented (nested) for-loop head after trimming leading whitespace", () => {
		const code = "if cond:\n    for x in range(10):\n        a = 1\n        b = 2\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.startLine).toBe(3);
		expect(bodies[0]?.bodyLines).toEqual(["        a = 1", "        b = 2", ""]);
	});

	it("N1: does not treat an embedded 'for ...:' substring (not at line start) as a loop head", () => {
		const code = "x = 5; for y in z:\n    a = 1\n";
		expect(extractIndentLoopBodies(code)).toEqual([]);
	});

	it("N2: rejects trailing content after the colon on the head line (single-statement body)", () => {
		const code = "for x in y: z = 1\nq = 2\n";
		expect(extractIndentLoopBodies(code)).toEqual([]);
	});

	it("P2: a dict-literal colon in the loop header does not falsely exclude a real multi-line body", () => {
		const code = "for x in {1: 2}:\n    a = 1\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    a = 1", ""]);
	});

	it("P3: a while-loop head is captured the same way as for", () => {
		const code = "while x < 10:\n    x += 1\n    y = 2\ndone = 1\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    x += 1", "    y = 2"]);
	});
});

describe("extractIndentLoopBodies — blank-line handling inside a captured body", () => {
	it("P1: absorbs a whitespace-only blank line inside a body without breaking (trim, not ===)", () => {
		const code = "for x in range(10):\n    a = 1\n    \n    b = 2\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    a = 1", "    ", "    b = 2", ""]);
	});

	it("P2: absorbs a truly empty blank line inside a body without breaking", () => {
		const code = "for x in range(10):\n    a = 1\n\n    b = 2\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies.length).toBe(1);
		expect(bodies[0]?.bodyLines).toEqual(["    a = 1", "", "    b = 2", ""]);
	});
});

describe("extractIndentLoopBodies — body field is newline-joined", () => {
	it("P1: joins a multi-line body's `body` field with real newlines, not concatenation", () => {
		const code = "for x in range(10):\n    a = 1\n    b = 2\n";
		const bodies = extractIndentLoopBodies(code);
		expect(bodies[0]?.body).toBe("    a = 1\n    b = 2\n");
	});
});

describe("getLoopBodies — per-language dispatch", () => {
	it("P1: dispatches to extractBraceLoopBodies for a C header (.h)", () => {
		const code = "for (int i = 0; i < 10; i++) {\n    a = 1;\n}\n";
		expect(getLoopBodies(code, "loop.h")).toEqual(extractBraceLoopBodies(code));
	});

	it("P2: dispatches to extractBraceLoopBodies for a C++ header (.hpp)", () => {
		const code = "for (int i = 0; i < 10; i++) {\n    a = 1;\n}\n";
		expect(getLoopBodies(code, "loop.hpp")).toEqual(extractBraceLoopBodies(code));
	});
});

describe("checkSpreadInReduce — reduce/bracket regex tolerate an extra space", () => {
	it("P1: still detects a spread when there is a space between '.reduce' and '('", () => {
		const code =
			"const flat = arr.reduce (function(acc, item) {\n    return [...acc, item];\n}, []);";
		const out = checkSpreadInReduce(code, "util.ts");
		expect(out).toEqual([{ line: 2, text: "return [...acc, item];" }]);
	});

	it("P2: still detects a spread when there is a space between '[' and '...'", () => {
		const code = "const flat = arr.reduce((acc, item) => {\n    return [ ...acc, item];\n}, []);";
		const out = checkSpreadInReduce(code, "util.ts");
		expect(out).toEqual([{ line: 2, text: "return [ ...acc, item];" }]);
	});
});

describe("checkSpreadInReduce — same-line spread must not count (j > i)", () => {
	it("N1: a spread on the same line as the .reduce( call itself is not flagged", () => {
		const code = "const x = arr.reduce((acc, item) => [...acc, item], []);";
		expect(checkSpreadInReduce(code, "util.ts")).toEqual([]);
	});
});

describe("checkSpreadInReduce — paren-depth tracking across the callback body", () => {
	it("P1: keeps scanning across a non-spread line while callback parens are still open", () => {
		const code =
			"const flat = arr.reduce((acc, item) => {\n    doWork(item);\n    return [...acc, item];\n}, []);\n";
		const out = checkSpreadInReduce(code, "util.ts");
		expect(out).toEqual([{ line: 3, text: "return [...acc, item];" }]);
	});

	it("N1: does not match an unrelated spread once the reduce call's own parens have closed", () => {
		const code =
			"const sum = arr.reduce((acc, n) => {\n    return acc + n;\n}, 0);\nconst other = [...unrelated, x];\n";
		expect(checkSpreadInReduce(code, "util.ts")).toEqual([]);
	});

	it("P2: a self-closing single-line reduce still lets the very next line's real spread through", () => {
		const code = "const x = arr.reduce((acc, n) => acc + n, 0);\nconst y = [...seed, z];\n";
		const out = checkSpreadInReduce(code, "util.ts");
		expect(out).toEqual([{ line: 2, text: "const y = [...seed, z];" }]);
	});
});

describe("checkSpreadInReduce — match text is trim()'d and capped to 150 chars", () => {
	it("P1: strips leading indentation and caps text length at exactly 150", () => {
		const pad = "x".repeat(200);
		const code = `const flat = arr.reduce((acc, item) => {\n    return [...acc, item]; // ${pad}\n}, []);`;
		const out = checkSpreadInReduce(code, "util.ts");
		expect(out[0]?.line).toBe(2);
		expect(out[0]?.text.length).toBe(150);
		expect(out[0]?.text.startsWith(" ")).toBe(false);
		expect(out[0]?.text.startsWith("return [...acc, item];")).toBe(true);
	});
});

describe("checkSpreadInReduce — extension guard", () => {
	it("N1: rejects a .py file even when the content matches the reduce/spread pattern", () => {
		const code = "const flat = arr.reduce((acc, item) => {\n    return [...acc, item];\n}, []);";
		expect(checkSpreadInReduce(code, "util.py")).toEqual([]);
	});

	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs"])("P1.%s: detects the pattern for %s files", (ext) => {
		const code = "const flat = arr.reduce((acc, item) => {\n    return [...acc, item];\n}, []);";
		const out = checkSpreadInReduce(code, `util${ext}`);
		expect(out).toEqual([{ line: 2, text: "return [...acc, item];" }]);
	});
});

// checkJsonClonePattern / checkFilterLength / checkMathSpread / checkArrayFromMap
// share the identical extension-guard shape: `if (![...].includes(ext)) return [];`.
// Two mutant families collapse the guard to "always return []" — the whole
// condition forced to `true`, and the allowed-extensions array emptied — both
// have the SAME observable effect, so one positive-per-extension test kills
// both for a given extension. A per-extension StringLiteral mutant (e.g.
// ".tsx" -> "") drops just that one extension from the array, so it needs
// its own extension-specific positive case.
describe("checkJsonClonePattern — extension guard covers every listed extension", () => {
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])("P1.%s: detects JSON round-trip clone for %s", (ext) => {
		const out = checkJsonClonePattern("const copy = JSON.parse(JSON.stringify(x));", `u${ext}`);
		expect(out).toEqual([{ line: 1, text: "const copy = JSON.parse(JSON.stringify(x));" }]);
	});
});

describe("checkFilterLength — extension guard covers every listed extension", () => {
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])("P1.%s: detects .filter().length for %s", (ext) => {
		const out = checkFilterLength("const n = items.filter(x => x.ok).length;", `u${ext}`);
		expect(out).toEqual([{ line: 1, text: "const n = items.filter(x => x.ok).length;" }]);
	});
});

describe("checkMathSpread — extension guard covers every listed extension", () => {
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])("P1.%s: detects Math.max(...arr) for %s", (ext) => {
		const out = checkMathSpread("const m = Math.max(...values);", `u${ext}`);
		expect(out).toEqual([{ line: 1, text: "const m = Math.max(...values);" }]);
	});
});

describe("checkArrayFromMap — extension guard covers every listed extension", () => {
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])("P1.%s: detects Array.from(x).map(fn) for %s", (ext) => {
		const out = checkArrayFromMap("Array.from(set).map(x => x * 2);", `u${ext}`);
		expect(out).toEqual([{ line: 1, text: "Array.from(set).map(x => x * 2);" }]);
	});
});

// checkArrayFromMap / checkFilterLength / checkJsonClonePattern / checkMathSpread
// each chain three \s* segments around their anchor tokens. A \s* -> \S*
// mutation on any one segment only changes behavior when a REAL space sits
// at that exact spot — with none, \S* matches zero chars just like \s* did.
// Each fixture below inserts exactly one space at the mutated segment, so a
// \S*-mutated regex can no longer traverse it (a literal space is not \S)
// and detection is lost. Shadow-verified against all 10 live mutant ids in
// scratch/fleet-r3/src_harness_checks_performance.ts-shadow-verify.mts.
describe("checkArrayFromMap / checkFilterLength / checkJsonClonePattern / checkMathSpread — \\s* segments tolerate a real space that \\S* cannot", () => {
	it("P1: checkArrayFromMap tolerates a space between 'from' and '('", () => {
		const out = checkArrayFromMap("Array.from (set).map(x => x * 2);", "u.ts");
		expect(out).toEqual([{ line: 1, text: "Array.from (set).map(x => x * 2);" }]);
	});
	it("P2: checkArrayFromMap tolerates a space between ')' and '.map'", () => {
		const out = checkArrayFromMap("Array.from(set) .map(x => x * 2);", "u.ts");
		expect(out).toEqual([{ line: 1, text: "Array.from(set) .map(x => x * 2);" }]);
	});
	it("P3: checkArrayFromMap tolerates a space between '.map' and '('", () => {
		const out = checkArrayFromMap("Array.from(set).map (x => x * 2);", "u.ts");
		expect(out).toEqual([{ line: 1, text: "Array.from(set).map (x => x * 2);" }]);
	});
	it("P4: checkFilterLength tolerates a space between 'filter' and '('", () => {
		const out = checkFilterLength("const n = items.filter (x => x.ok).length;", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const n = items.filter (x => x.ok).length;" }]);
	});
	it("P5: checkFilterLength tolerates a space between ')' and '.length'", () => {
		const out = checkFilterLength("const n = items.filter(x => x.ok) .length;", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const n = items.filter(x => x.ok) .length;" }]);
	});
	it("P6: checkJsonClonePattern tolerates a space between 'parse' and '('", () => {
		const out = checkJsonClonePattern("const c = JSON.parse (JSON.stringify(x));", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const c = JSON.parse (JSON.stringify(x));" }]);
	});
	it("P7: checkJsonClonePattern tolerates a space between '(' and 'JSON.stringify'", () => {
		const out = checkJsonClonePattern("const c = JSON.parse( JSON.stringify(x));", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const c = JSON.parse( JSON.stringify(x));" }]);
	});
	it("P8: checkJsonClonePattern tolerates a space between 'stringify' and '('", () => {
		const out = checkJsonClonePattern("const c = JSON.parse(JSON.stringify (x));", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const c = JSON.parse(JSON.stringify (x));" }]);
	});
	it("P9: checkMathSpread tolerates a space between 'max'/'min' and '('", () => {
		const out = checkMathSpread("const m = Math.max (...values);", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const m = Math.max (...values);" }]);
	});
	it("P10: checkMathSpread tolerates a space between '(' and '...'", () => {
		const out = checkMathSpread("const m = Math.max( ...values);", "u.ts");
		expect(out).toEqual([{ line: 1, text: "const m = Math.max( ...values);" }]);
	});
});

// --- Equivalent survivors (skipped; not asserted here) ---
//
// 10 of the current (2026-08-12 regeneration) 112-mutant set for this file
// are empirically equivalent — proven over 500 randomized+noise inputs EACH
// with zero observed divergence in
// scratch/fleet-r3/src_harness_checks_performance.ts-shadow-verify.mts
// (re-verifying and extending the prior wave's 9-mutant / 400-trial run in
// scratch/probes/perf-indent-fuzz-equivalence.mts). All 10 live in
// extractIndentLoopBodies's single-line-body-exclusion line:
//
//   if (/:\s*\S/.test(trimmed) && !trimmed.endsWith(":")) continue;
//
// This line is only reached after
// `/^(for\s+.+|while\s+.+):\s*$/.test(trimmed)` has already matched. Given
// `trimmed` is `.trim()`'d (so it never ends in whitespace), the ONLY way
// that regex's trailing `\s*$` can succeed is if `trimmed`'s literal last
// character is ":". So at the exclusion-check line, `trimmed.endsWith(":")`
// is provably always true, `!trimmed.endsWith(":")` is provably always
// false, and `X && false` is always false regardless of what `X` — or the
// regex/comparisons that produce it — get mutated into. The 10 mutants:
//   - Regex `/^(for\s+.+|while\s+.+):\s*$/` variants: drop trailing `$`;
//     `for\s+` -> `for\s`; `while\s+` -> `while\s`; trailing `\s*$` -> `\S*$`.
//     (Each of these, when it WOULD change the head-regex's match verdict,
//     does so only by admitting a string that has non-whitespace after some
//     colon — which is exactly what `/:\s*\S/` detects, so the exclusion
//     check's OTHER sub-condition catches it instead. `for\s+`->`for\s` and
//     `while\s+`->`while\s` are additionally provably equivalent regexes in
//     their own right, since `.+` immediately follows and can absorb any
//     whitespace the shortened quantifier no longer consumes.)
//   - ConditionalExpression: the whole exclusion condition -> `false`.
//   - Regex `/:\s*\S/` variants: `\s\S`, `\S*\S`, `\s*\s` (only feed the
//     always-false-here condition; changing them changes nothing).
//   - StringLiteral: `":"` -> `""` in `trimmed.endsWith(":")`. Stronger than
//     the reachability argument above needs: `"".endsWith("")` and every
//     other string also always returns `true` for `endsWith("")` per the
//     ECMAScript spec (a zero-length search string always matches), so
//     `!trimmed.endsWith("")` is always `false` UNCONDITIONALLY — the
//     mutant's right conjunct doesn't even need the left conjunct's
//     reachability precondition to be neutralized.
//   - ConditionalExpression: `headIndent < 0` -> `false` (also unreachable:
//     if `trimmed` — a substring of the untrimmed line — is non-empty,
//     `.search(/\S/)` on the untrimmed line can never return -1).
