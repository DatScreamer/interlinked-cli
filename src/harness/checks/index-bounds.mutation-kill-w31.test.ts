import { describe, expect, it } from "vitest";
import { checkIndexBoundsUnchecked } from "./index-bounds.js";

const TS = "src/handlers/users.ts";

/** Build `count` inert filler statements, numbered starting at `startIndex`.
 * Never matches ASSIGNMENT_PATTERN/INLINE_PATTERN/guard clauses — pure noise
 * to pad line counts for the two-step lookahead-window boundary tests. */
function buildFillerLines(count: number, startIndex: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(`let f${startIndex + i} = ${startIndex + i};`);
	}
	return lines;
}

describe("checkIndexBoundsUnchecked — mutation kill (w31 pass1)", () => {
	// Mutant 1f93fb8983f52c95 forces the extension guard to `false`, letting a
	// non-JS/TS file fall through to a real finding instead of short-circuiting.
	// test-contract: public-api — non-JS/TS files must return no findings at all
	it("does not scan non-JS/TS files at all", () => {
		const code = "return rows[Number(req.body.idx)];";
		expect(checkIndexBoundsUnchecked(code, "src/handlers/users.py")).toEqual([]);
	});

	// Mutant 3c88d10754d96fb5 drops the `$`-escape in buildGuardPattern, so the
	// guard pattern requires "id" immediately before ")" — which never matches
	// "id$)" — silently letting a finding leak through a guarded use.
	// test-contract: invariant — a Number.isFinite guard on a name containing $ must still suppress the finding
	it("recognizes a guard on a name containing '$'", () => {
		const code = [
			"function ok(req, rows) {",
			"  const id$ = parseInt(req.params.id, 10);",
			"  if (Number.isFinite(id$) && id$ < rows.length) return rows[id$];",
			"  return null;",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	// Distinguishes several independent mutants that each corrupt one piece of
	// the reported {line, text} shape: dc356f34345468f1 (content split
	// delimiter), fc2ce0e3351b9875 (offset-to-line split delimiter),
	// b6892cce6594eea7 (empties the pushed object), 98d520a5dfd50882 (drops
	// .trim()), 30c143c917758b5a (|| -> && collapses text to ""),
	// 5c0a646f899dbf7d (off-by-two line index), bd34ef8c447138fb (uses the
	// whole-file line count instead of the prefix-up-to-offset count).
	// test-contract: public-api — an inline finding reports the exact trimmed line text and its 1-based line number
	it("reports the exact trimmed line and 1-based line number", () => {
		const code = [
			"function handler(req, rows) {",
			"  return rows[Number(req.body.idx)];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out).toEqual([{ line: 2, text: "return rows[Number(req.body.idx)];" }]);
	});

	// Mutant 41bdcf3f8dadf5be drops the `.slice(0, REPORT_LINE_TRUNC)` call, so
	// the untruncated (much longer) trimmed line would leak through instead.
	// test-contract: boundary — reported text is truncated to exactly REPORT_LINE_TRUNC (150) chars
	it("truncates a long reported line to 150 chars", () => {
		const longProp = "idx".repeat(60);
		const rawLine = `  return rows[Number(req.body.${longProp})];`;
		const code = ["function handler(req, rows) {", rawLine, "}"].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		const expectedText = rawLine.trim().slice(0, 150);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(expectedText);
		expect(out[0]?.text.length).toBe(150);
	});

	// Distinguishes ten independent mutants that each break the lineOffsets
	// bookkeeping so the lookahead window silently degrades to "search the
	// rest of the file": 0cb55159b2649486 (drops the leading 0 sentinel),
	// beb1524052e4dde7 / 296e92e9fa294f4f (disable the offset-building
	// for-loop), 0d5e1fb0cc0f80b0 / 3231beafcde418dc / c32253caf2eb5f3d /
	// 3076d6bfb39f9f11 (each disables the per-char newline detection that
	// feeds the loop), 31b4a97a31735b78 / 2462b0d23c88bba1 (flip/force the
	// in-range condition), 96b7604a7f84fbe7 (flips the lookahead direction to
	// "-60", landing on a negative index that also degrades to full-file
	// search).
	// test-contract: boundary — a two-step use one line past TWO_STEP_LOOKAHEAD_LINES must stay excluded
	it("excludes an unguarded index use exactly one line past the lookahead window", () => {
		const lines61 = [
			"const id = parseInt(req.params.id, 10);",
			...buildFillerLines(59, 2),
			"return rows[id];",
		];
		expect(lines61.length).toBe(61);
		const code = lines61.join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	// Isolates the `lookaheadEndLine - 1` arithmetic itself. Mutant
	// eb732e655bc4807e flips `-1` to `+1`, pushing the boundary check/lookup
	// out of range and (via the undefined-index-degrades-to-full-length path)
	// leaking the out-of-window use back in.
	// test-contract: boundary — a two-step use two lines past TWO_STEP_LOOKAHEAD_LINES must stay excluded
	it("excludes an unguarded index use two lines past the lookahead window", () => {
		const lines62 = [
			"const id = parseInt(req.params.id, 10);",
			...buildFillerLines(60, 2),
			"return rows[id];",
		];
		expect(lines62.length).toBe(62);
		const code = lines62.join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	// Mutant 5c47ee39aa6f119b replaces the `$`-escape used to build the
	// index-use regex with "", so the built pattern looks for a bracket
	// containing "n" instead of "n$" and silently stops matching the real use.
	// test-contract: invariant — a two-step use of a name containing $ must still be matched by the index-use regex
	it("finds an unguarded two-step use of a name containing '$'", () => {
		const code = [
			"function handler(req, rows) {",
			"  const n$ = parseInt(req.params.id, 10);",
			"  return rows[n$];",
			"}",
		].join("\n");
		const out = checkIndexBoundsUnchecked(code, TS);
		expect(out).toHaveLength(1);
	});

	// Mutant cc311e03a2fb1fc0 forces `seen.has(offset)` to `false`, so the
	// second (redeclared) assignment's scan re-records the identical use
	// offset instead of being deduplicated.
	// test-contract: invariant — the same physical use offset reached via two assignments is recorded exactly once
	it("de-duplicates the same use offset reached from two assignments", () => {
		const code = [
			"function handler(req, rows) {",
			"  var id = parseInt(req.params.id, 10);",
			"  var id = parseInt(req.query.other, 10);",
			"  return rows[id];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toHaveLength(1);
	});

	// Mutants b5de50fc6603521e (uses the whole string instead of the
	// up-to-offset prefix) and 5acb1cc305e89a9e (splits by "" — a char count —
	// instead of "\n") both inflate assignLineNo far past the true value,
	// which blows the lookahead window out to "search the rest of the file"
	// and leaks in a use that should stay excluded as out-of-window.
	// test-contract: boundary — the lookahead window stays anchored to the assignment's own line, not the file total
	it("keeps the lookahead window anchored to the assignment's own line, not the file total", () => {
		const lines115 = [
			...buildFillerLines(49, 1),
			"const id = parseInt(req.params.id, 10);",
			...buildFillerLines(64, 51),
			"return rows[id];",
		];
		expect(lines115.length).toBe(115);
		const code = lines115.join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	// Mutant f17ace0f41ecf79f empties the COERCE_OPENERS pattern, so any
	// external-input-shaped index starts matching even with no
	// Number/parseInt/parseFloat wrapper immediately inside the bracket.
	// test-contract: invariant — a direct (uncoerced) external-input index must not fire the inline pattern
	it("does not flag a direct (uncoerced) external-input index", () => {
		const code = [
			"function handler(req, rows) {",
			"  return rows[req.body.idx];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toEqual([]);
	});

	// Mutant f6ddf44b70551319 disables the recordMatch cap check entirely (all
	// 11 candidates leak through); dad99726fe2b8b2b loosens `>=` to `>`,
	// letting exactly one extra (11th) candidate leak through.
	// test-contract: boundary — inline matches cap at MAX_MATCHES_PER_FILE (10) even with 11 candidates present
	it("caps inline matches at 10 even with 11 candidates", () => {
		const props = Array.from({ length: 11 }, (_, i) => String.fromCharCode(97 + i));
		const code = [
			"function handler(req, rows) {",
			"  return [",
			...props.map((p) => `    rows[Number(req.body.${p})],`),
			"  ];",
			"}",
		].join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toHaveLength(10);
	});

	// Mutant b36b0c4e45563181 forces the loop-level cap check to `true`,
	// breaking on the very first assignment (0 total instead of the capped
	// 10). Mutant 48742d21fc54b1d9 flips `>=` to `<`, which is true while
	// still under the cap — also breaking on the very first iteration.
	// test-contract: boundary — two-step matches cap at MAX_MATCHES_PER_FILE (10) even with 11 candidate assignments
	it("caps two-step matches at 10 even with 11 candidate assignments", () => {
		const code = Array.from({ length: 11 }, (_, i) => {
			const n = i + 1;
			return `function h${n}(req, rows) { const v${n} = parseInt(req.params.p${n}, 10); return rows[v${n}]; }`;
		}).join("\n");
		expect(checkIndexBoundsUnchecked(code, TS)).toHaveLength(10);
	});
});
