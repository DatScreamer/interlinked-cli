// Co-located tests for `react.ts` checks.
//
// Behavioral coverage of every exported React/frontend detector plus the
// internal `isStaticStringConstant` static-string resolver (exercised through
// `checkDangerouslySetInnerHTML`). Every detector gates on test-file path and
// `.tsx`/`.jsx` extension; each branch (threshold, ternary, &&/||/??, the
// template-literal walk) is driven by a code-string fixture and asserted with
// strong matchers.
//
// FP refinement (139-repo audit, 2026-05): `dangerouslySetInnerHTML`
// fires on the JSX prop, but the value is often a same-file string
// constant with no user input (Expo Router boilerplate, static CSS,
// generated SVG markup). The check now inspects the value identifier
// and skips when it resolves to a literal string/template with no
// `${...}` interpolation.

import { describe, expect, test } from "vitest";
import {
	checkAsyncEventHandler,
	checkDangerouslySetInnerHTML,
	checkDirectDomAccess,
	checkExcessiveUseState,
	checkInlineObjectProps,
} from "./react.js";

// A non-source path that all detectors must skip via `isTestFile`.
const TEST_PATH = "src/__tests__/Comp.tsx";
// A non-React extension that all detectors must skip via the ext gate.
const NON_REACT_PATH = "src/logic.ts";

describe("checkExcessiveUseState", () => {
	test("skips test files (isTestFile gate)", () => {
		const code = Array.from({ length: 10 }, () => "  const [x, setX] = useState(0);").join("\n");
		expect(checkExcessiveUseState(code, TEST_PATH)).toEqual([]);
	});

	test("skips non-tsx/jsx extensions", () => {
		const code = Array.from({ length: 10 }, () => "  const [x, setX] = useState(0);").join("\n");
		expect(checkExcessiveUseState(code, NON_REACT_PATH)).toEqual([]);
	});

	test("does NOT fire below the 8-hook threshold", () => {
		const code = [
			"export function Comp() {",
			"  const [a, setA] = useState(0);",
			"  const [b, setB] = useState(0);",
			"  const [c, setC] = useState(0);",
			"  return null;",
			"}",
		].join("\n");
		expect(checkExcessiveUseState(code, "src/Comp.tsx")).toEqual([]);
	});

	test("does NOT fire at exactly 7 hooks (threshold is 8)", () => {
		const hooks = Array.from({ length: 7 }, (_, i) => `  const [s${i}, setS${i}] = useState(0);`);
		const code = ["export function Comp() {", ...hooks, "  return null;", "}"].join("\n");
		expect(checkExcessiveUseState(code, "src/Comp.tsx")).toEqual([]);
	});

	test("fires at exactly 8 hooks, reporting the first occurrence only", () => {
		const hooks = Array.from({ length: 8 }, (_, i) => `  const [s${i}, setS${i}] = useState(0);`);
		const code = ["export function Comp() {", ...hooks, "  return null;", "}"].join("\n");
		const found = checkExcessiveUseState(code, "src/Comp.tsx");
		expect(found).toHaveLength(1);
		// First useState is on line 2 (line 1 is the function declaration).
		expect(found[0].line).toBe(2);
		expect(found[0].text).toContain("8 useState hooks");
		expect(found[0].text).toContain("useReducer");
		expect(found[0].text).toContain("setS0");
	});

	test("counts the generic form useState<T>(...) too", () => {
		const hooks = Array.from({ length: 9 }, (_, i) => `  const [s${i}, setS${i}] = useState<number>(0);`);
		const code = ["export function Comp() {", ...hooks, "}"].join("\n");
		const found = checkExcessiveUseState(code, "src/Widget.jsx");
		expect(found).toHaveLength(1);
		expect(found[0].text).toContain("9 useState hooks");
	});

	test("truncates the reported line to 100 chars", () => {
		const longTail = "x".repeat(200);
		const lines = [
			"export function Comp() {",
			`  const [first, setFirst] = useState(0); // ${longTail}`,
		];
		for (let i = 0; i < 8; i++) lines.push(`  const [s${i}, setS${i}] = useState(0);`);
		lines.push("}");
		const found = checkExcessiveUseState(lines.join("\n"), "src/Comp.tsx");
		expect(found).toHaveLength(1);
		// Prefix "[N useState ...] " + 100-char slice of the trimmed line.
		const sliceStart = found[0].text.indexOf("] ") + 2;
		expect(found[0].text.slice(sliceStart).length).toBe(100);
	});
});

describe("checkDangerouslySetInnerHTML — gates", () => {
	test("skips test files", () => {
		const code = "function C() { return <div dangerouslySetInnerHTML={{ __html: x }} />; }";
		expect(checkDangerouslySetInnerHTML(code, TEST_PATH)).toEqual([]);
	});

	test("skips non-tsx/jsx extensions", () => {
		const code = "const s = '<div dangerouslySetInnerHTML />';";
		expect(checkDangerouslySetInnerHTML(code, NON_REACT_PATH)).toEqual([]);
	});

	test("does not fire when the token is absent", () => {
		const code = ["export function Comp() {", "  return <div>safe</div>;", "}"].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("caps output at 10 matches even with many risky usages", () => {
		// 12 distinct firing lines, each with a runtime (non-static) value.
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `  <div dangerouslySetInnerHTML={{ __html: runtime${i}() }} />`,
		);
		const code = ["export function Comp() {", ...lines, "}"].join("\n");
		const found = checkDangerouslySetInnerHTML(code, "src/Comp.tsx");
		expect(found).toHaveLength(10);
	});
});

describe("checkDangerouslySetInnerHTML — same-file static-string suppression", () => {
	// Negative cases — these MUST be suppressed.

	test("Flexpa Expo Router shape — template literal CSS constant", () => {
		// The exact shape from `flexpa-link-react-native-example/app/+html.tsx`.
		const code = [
			"export default function Root() {",
			"  return (",
			"    <html>",
			"      <head>",
			"        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />",
			"      </head>",
			"    </html>",
			"  );",
			"}",
			"",
			"const responsiveBackground = `body { background-color: #fff; padding: 0; }`;",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "app/+html.tsx")).toEqual([]);
	});

	test("plain string constant — `const STATIC = 'literal'`", () => {
		const code = [
			"const STATIC = 'plain string with no interpolation';",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: STATIC }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("double-quoted string constant", () => {
		const code = [
			'const HTML = "<p>static</p>";',
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: HTML }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("template literal with escaped backtick but no interpolation — suppressed", () => {
		// Exercises the `\\` escape branch of the backtick walk: the escaped
		// backtick must NOT be read as the closing delimiter.
		const code = [
			"const TPL = `code: \\` still static \\` end`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: TPL }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	// Positive cases — real XSS risks MUST still fire.

	test("STILL flags when value is a prop / variable from outside", () => {
		// `userComment` is a parameter — runtime value, real XSS risk.
		const code = [
			"export function Comment({ userComment }: { userComment: string }) {",
			"  return <div dangerouslySetInnerHTML={{ __html: userComment }} />;",
			"}",
		].join("\n");
		const found = checkDangerouslySetInnerHTML(code, "src/Comment.tsx");
		expect(found).toHaveLength(1);
		expect(found[0].line).toBe(2);
		expect(found[0].text).toContain("dangerouslySetInnerHTML");
	});

	test("STILL flags template literal WITH `${...}` interpolation", () => {
		// `${userInput}` makes the literal dynamic — must fire.
		const code = [
			"export function Comp({ userInput }) {",
			"  const html = `<p>${userInput}</p>`;",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags interpolation containing a nested object literal", () => {
		// `${ {a:1}.a }` drives the depth>0 brace push/pop branches inside the
		// `${...}` scan, and the closing backtick still sees `${` → dynamic.
		const code = [
			"const html = `<p>${ {a: 1}.a }</p>`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags `__html: state.value` (member access — not a bare ident)", () => {
		const code = [
			"export function Comp() {",
			"  const [state] = useState({ value: '' });",
			"  return <div dangerouslySetInnerHTML={{ __html: state.value }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags `__html: foo()` (function-call result)", () => {
		const code = [
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: getHtml() }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags when constant uses `let`/`var` (mutable)", () => {
		// `let` allows reassignment — not safe to suppress.
		const code = [
			"let html = '<p>initial</p>';",
			"html = userSupplied;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags a bare ident with no matching const declaration anywhere", () => {
		// `mystery` is never declared in-file → isStaticStringConstant returns
		// false via both the string-regex miss and the template-open miss.
		const code = [
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: mystery }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});

	test("STILL flags an unterminated template constant (walk runs off EOF)", () => {
		// The backtick never closes, so the walk exhausts the buffer and
		// `isStaticStringConstant` returns false → the check fires.
		const code = [
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: TPL }} />;",
			"}",
			"const TPL = `unterminated body never closed",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx").length).toBe(1);
	});
});

describe("checkDirectDomAccess", () => {
	test("skips test files", () => {
		const code = "function C() { document.getElementById('x'); }";
		expect(checkDirectDomAccess(code, TEST_PATH)).toEqual([]);
	});

	test("skips non-tsx/jsx extensions", () => {
		const code = "document.querySelector('.a');";
		expect(checkDirectDomAccess(code, NON_REACT_PATH)).toEqual([]);
	});

	test("does not fire without direct DOM access", () => {
		const code = ["export function Comp() {", "  return <div ref={ref} />;", "}"].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});

	test("fires on each document query API and reports line + text", () => {
		// The `getElementsBy` alternative requires `(` right after it, so the
		// fixture calls `getElementsBy(` directly (the regex stops at the prefix).
		const code = [
			"export function Comp() {",
			"  const a = document.getElementById('a');",
			"  const b = document.querySelector('.b');",
			"  const c = document.querySelectorAll('.c');",
			"  const d = document.getElementsBy('d');",
			"  return null;",
			"}",
		].join("\n");
		const found = checkDirectDomAccess(code, "src/Comp.tsx");
		expect(found).toHaveLength(4);
		expect(found.map((m) => m.line)).toEqual([2, 3, 4, 5]);
		expect(found[0].text).toContain("getElementById");
	});

	test("does not match document access that lives only inside a string literal", () => {
		// stripCommentsAndStrings blanks the string body, so this must not fire.
		const code = [
			"export function Comp() {",
			"  const note = 'call document.getElementById here';",
			"  return null;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});
});

describe("checkInlineObjectProps", () => {
	test("skips test files", () => {
		const code = ["<A x={{}} />", "<B y={{}} />", "<C z={{}} />"].join("\n");
		expect(checkInlineObjectProps(code, TEST_PATH)).toEqual([]);
	});

	test("skips non-tsx/jsx extensions", () => {
		const code = ["<A x={{}} />", "<B y={{}} />", "<C z={{}} />"].join("\n");
		expect(checkInlineObjectProps(code, NON_REACT_PATH)).toEqual([]);
	});

	test("does NOT fire below the 3-prop threshold", () => {
		const code = [
			"export function Comp() {",
			"  return <A style={{ color: 'red' }} other={{ a: 1 }} />;",
			"}",
		].join("\n");
		expect(checkInlineObjectProps(code, "src/Comp.tsx")).toEqual([]);
	});

	test("fires at the 3-prop threshold with an aggregated single finding", () => {
		const code = [
			"export function Comp() {",
			"  return (",
			"    <Box style={{ color: 'red' }}",
			"      layout={{ flex: 1 }}",
			"      data={{ id: 1 }} />",
			"  );",
			"}",
		].join("\n");
		const found = checkInlineObjectProps(code, "src/Comp.tsx");
		expect(found).toHaveLength(1);
		// Anchored at the first inline-object line (line 3).
		expect(found[0].line).toBe(3);
		expect(found[0].text).toContain("3 inline object props");
		expect(found[0].text).toContain("useMemo");
	});

	test("aggregated count keeps climbing past the 10-match collection cap", () => {
		// 13 inline-object props: the per-line collector stops at 10, but the
		// reported count reflects all 13 (drives the `allMatches.length < 10`
		// false branch of the && while count keeps incrementing).
		const lines = Array.from({ length: 13 }, (_, i) => `  <C${i} p={{ v: ${i} }} />`);
		const code = ["export function Comp() {", "  return <>", ...lines, "  </>;", "}"].join("\n");
		const found = checkInlineObjectProps(code, "src/Comp.tsx");
		expect(found).toHaveLength(1);
		expect(found[0].text).toContain("13 inline object props");
	});

	test("does not count inline-object syntax that lives only inside a string", () => {
		const code = [
			"export function Comp() {",
			"  const a = 'x={{ not jsx }}';",
			"  const b = 'y={{ also not }}';",
			"  const c = 'z={{ nope }}';",
			"  return null;",
			"}",
		].join("\n");
		expect(checkInlineObjectProps(code, "src/Comp.tsx")).toEqual([]);
	});
});

describe("checkAsyncEventHandler", () => {
	test("skips test files", () => {
		const code = "<button onClick={async () => {}} />";
		expect(checkAsyncEventHandler(code, TEST_PATH)).toEqual([]);
	});

	test("skips non-tsx/jsx extensions", () => {
		const code = "const x = '<button onClick={async () => {}} />';";
		expect(checkAsyncEventHandler(code, NON_REACT_PATH)).toEqual([]);
	});

	test("does not fire on a synchronous handler", () => {
		const code = [
			"export function Comp() {",
			"  return <button onClick={() => doThing()} />;",
			"}",
		].join("\n");
		expect(checkAsyncEventHandler(code, "src/Comp.tsx")).toEqual([]);
	});

	test("fires on async event handlers and reports each line", () => {
		const code = [
			"export function Comp() {",
			"  return (",
			"    <form onSubmit={async (e) => { await save(e); }}>",
			"      <button onClick={async () => { await go(); }} />",
			"    </form>",
			"  );",
			"}",
		].join("\n");
		const found = checkAsyncEventHandler(code, "src/Comp.tsx");
		expect(found).toHaveLength(2);
		expect(found.map((m) => m.line)).toEqual([3, 4]);
		expect(found[0].text).toContain("onSubmit");
	});
});
