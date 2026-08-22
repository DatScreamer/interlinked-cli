// Mutation-kill suite for src/harness/checks/react.ts (wave w38).
// Targets survivor mutants from scratch/fleet-r3/w38-briefs/src_harness_checks_react.ts.json.
//
// Many packet mutants inside `isStaticStringConstant`'s brace/backtick depth
// walk, `checkDirectDomAccess`'s undefined-guard/effectDepth clamps, and
// `checkInlineObjectProps`'s push-cap were hand-traced and found to converge
// to the SAME return value as pristine on every constructible input (the
// final `.includes("${")` string search operates on the raw captured slice
// regardless of how the depth walk got there, and any nested backtick can
// only occur after a `${` already present in that same slice). Those are
// reported as still_open rather than claimed as kills — see receipts notes.

import { describe, expect, test } from "vitest";
import { checkDangerouslySetInnerHTML, checkExcessiveUseState, checkInlineObjectProps } from "./react.js";

const REACT_PATH = "src/Comp.tsx";

describe("checkExcessiveUseState — mutation kill", () => {
	// test-contract: public-api — MethodExpression drops `.trim()` on the
	// line used to build the reported finding text; heavily-indented source
	// lines make the leading whitespace observable in the exact output text.
	test("reports trimmed text with no leading whitespace at 8+ useState hooks", () => {
		const hooks = Array.from(
			{ length: 8 },
			(_, i) => `\t\t\t\tconst [s${i}, setS${i}] = useState(0);`,
		);
		const code = ["export function Comp() {", ...hooks, "  return null;", "}"].join("\n");
		const result = checkExcessiveUseState(code, REACT_PATH);
		expect(result).toEqual([
			{
				line: 2,
				text: "[8 useState hooks — consider useReducer or splitting component] const [s0, setS0] = useState(0);",
			},
		]);
	});

	// test-contract: boundary — the counting loop's bound `i < lines.length`
	// mutated to `i <= lines.length` reads `lines[lines.length]` (undefined),
	// and `nonNull()` throws on undefined — a real, observable crash vs the
	// pristine function returning normally.
	test("does not throw when scanning a well-formed 8-hook file (loop bound stays in range)", () => {
		const hooks = Array.from({ length: 8 }, (_, i) => `const [s${i}, setS${i}] = useState(0);`);
		const code = [...hooks, "return null;"].join("\n");
		expect(() => checkExcessiveUseState(code, REACT_PATH)).not.toThrow();
		expect(checkExcessiveUseState(code, REACT_PATH)).toHaveLength(1);
	});
});

describe("isStaticStringConstant (via checkDangerouslySetInnerHTML) — mutation kill", () => {
	// test-contract: boundary — ArithmeticOperator mutates the `${`
	// lookahead `content[i + 1] === "{"` to `content[i - 1] === "{"`. A
	// literal `{$` sequence (brace immediately BEFORE a dollar, reverse
	// order) makes the mutated backward-look condition true where pristine's
	// forward-look is false, incorrectly opening depth tracking on plain
	// static text. Depth then never returns to 0, so the mutant's walk
	// never finds the real closing backtick and falls through to
	// `return false` — flipping a genuinely static template to "fires"
	// where pristine correctly suppresses it.
	test("suppresses a static template literal containing a literal '{$' substring", () => {
		const code = [
			"const staticHtml = `abc{$def`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: staticHtml }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, REACT_PATH)).toEqual([]);
	});

	// test-contract: public-api — a plain quoted string const is recognized
	// as static (the string-literal branch, unaffected by the packet's
	// mutants but pins the baseline true-branch so a regression elsewhere
	// in the function is caught too).
	test("suppresses a static double-quoted string constant", () => {
		const code = [
			'const staticHtml = "<b>ok</b>";',
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: staticHtml }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, REACT_PATH)).toEqual([]);
	});
});

describe("checkInlineObjectProps — mutation kill", () => {
	// test-contract: boundary — Regex mutant drops the `+` quantifier
	// (`/\w+=\{\{/` -> `/\w=\{\{/`), requiring exactly one word character
	// before `={{`. A multi-character prop name (`style={{`) cannot match
	// the single-char mutant regex, so the mutant undercounts and the
	// 3-occurrence threshold is never reached (empty result) where
	// pristine correctly fires.
	test("fires on 3 multi-character inline object props (style={{...}})", () => {
		const lines = Array.from({ length: 3 }, () => "  <div style={{ color: 'red' }} />").join(
			"\n",
		);
		const result = checkInlineObjectProps(lines, REACT_PATH);
		expect(result).toEqual([
			{
				line: 1,
				text: "[3 inline object props — creates new references every render, causing unnecessary re-renders. Extract to constants or useMemo] <div style={{ color: 'red' }} />",
			},
		]);
	});

	// test-contract: boundary — pins the `count < 3` threshold gate exactly
	// below its boundary (2 occurrences must not fire).
	test("does NOT fire at exactly 2 inline object props (below threshold of 3)", () => {
		const lines = [
			"  <div style={{ x: 1 }} />",
			"  <div style={{ y: 2 }} />",
			"  <span>text</span>",
		].join("\n");
		expect(checkInlineObjectProps(lines, REACT_PATH)).toEqual([]);
	});
});
