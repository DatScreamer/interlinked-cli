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
import { nonNull } from "../../lib/non-null.js";
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
		expect(nonNull(found[0]).line).toBe(2);
		expect(nonNull(found[0]).text).toContain("8 useState hooks");
		expect(nonNull(found[0]).text).toContain("useReducer");
		expect(nonNull(found[0]).text).toContain("setS0");
	});

	test("counts the generic form useState<T>(...) too", () => {
		const hooks = Array.from({ length: 9 }, (_, i) => `  const [s${i}, setS${i}] = useState<number>(0);`);
		const code = ["export function Comp() {", ...hooks, "}"].join("\n");
		const found = checkExcessiveUseState(code, "src/Widget.jsx");
		expect(found).toHaveLength(1);
		expect(nonNull(found[0]).text).toContain("9 useState hooks");
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
		const sliceStart = nonNull(found[0]).text.indexOf("] ") + 2;
		expect(nonNull(found[0]).text.slice(sliceStart).length).toBe(100);
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
		expect(nonNull(found[0]).line).toBe(2);
		expect(nonNull(found[0]).text).toContain("dangerouslySetInnerHTML");
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
		expect(nonNull(found[0]).text).toContain("getElementById");
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

	// FP refinement (2026-06): createPortal's target node and DOM access inside
	// useEffect/useLayoutEffect are the *correct* React escape hatches — they
	// must not fire. Real bugs (render-body / event-handler DOM access that
	// should be a ref) still fire.
	test("does not fire on a createPortal target node", () => {
		const code = [
			"export function Modal({ children }) {",
			'  return createPortal(children, document.getElementById("modal-root")!);',
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Modal.tsx")).toEqual([]);
	});

	test("does not fire inside a single-line useEffect callback", () => {
		const code = [
			"export function Comp() {",
			'  useEffect(() => { const el = document.querySelector(".x"); }, []);',
			"  return null;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});

	test("does not fire inside a multi-line useLayoutEffect callback", () => {
		const code = [
			"export function Comp() {",
			"  useLayoutEffect(() => {",
			'    const el = document.getElementById("x");',
			"    el?.focus();",
			"  }, []);",
			"  return null;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});

	test("still fires on DOM access in the render body", () => {
		const code = [
			"export function Comp() {",
			'  const el = document.getElementById("x");',
			"  return <div>{el?.id}</div>;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx").length).toBeGreaterThan(0);
	});

	test("still fires on DOM access in an event handler (should use a ref)", () => {
		const code = [
			"export function Comp() {",
			"  function onClick() {",
			'    const el = document.querySelector(".target");',
			"    el?.scrollIntoView();",
			"  }",
			"  return <button onClick={onClick}>go</button>;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx").length).toBeGreaterThan(0);
	});

	test("still fires after a useEffect block has closed", () => {
		const code = [
			"export function Comp() {",
			"  useEffect(() => {",
			"    doSetup();",
			"  }, []);",
			'  const stray = document.getElementById("x");',
			"  return <div>{stray?.id}</div>;",
			"}",
		].join("\n");
		const found = checkDirectDomAccess(code, "src/Comp.tsx");
		expect(found.length).toBeGreaterThan(0);
		expect(found.map((m) => m.line)).toContain(5);
	});

	// test-contract: boundary — direct DOM query recognition permits documented whitespace before the call delimiter
	test("recognizes a DOM query with whitespace before its call delimiter", () => {
		const code = "document.querySelector \t ('.target');";
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([{ line: 1, text: code }]);
	});

	// test-contract: boundary — the public direct-DOM finding list remains capped at ten findings, including exactly ten matches
	test("caps direct DOM findings at exactly ten matches", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `document.querySelector('.target-${i}');`);
		const found = checkDirectDomAccess(lines.join("\n"), "src/Comp.tsx");
		expect(found).toHaveLength(10);
		expect(found.map((match) => match.line)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
	});

	// test-contract: boundary — direct DOM findings stop collecting after the documented ten-result cap when an eleventh match is present
	test("caps direct DOM findings when matches exceed ten", () => {
		const lines = Array.from({ length: 11 }, (_, i) => `document.querySelector('.target-${i}');`);
		const found = checkDirectDomAccess(lines.join("\n"), "src/Comp.tsx");
		expect(found).toHaveLength(10);
		expect(found.at(-1)?.line).toBe(10);
	});

	// test-contract: boundary — the sanctioned effect escape hatch remains active through nested callback blocks before later DOM access
	test("keeps nested DOM access inside a multiline effect callback exempt", () => {
		const code = [
			"export function Comp() {",
			"  useEffect(() => {",
			"    if (ready) {",
			'      const el = document.querySelector(".target");',
			"      el?.focus();",
			"    }",
			"  }, []);",
			"  return null;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});

	// test-contract: boundary — a multiline effect opener seeds the documented callback exemption for DOM access on its later lines
	test("seeds effect tracking from a multiline callback opener", () => {
		const code = [
			"export function Comp() {",
			"  useEffect(() => {",
			'    const el = document.getElementById("target");',
			"  }, []);",
			"  return null;",
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Comp.tsx")).toEqual([]);
	});

	// test-contract: boundary — createPortal's documented target-node exemption accepts whitespace before the call delimiter
	test("exempts a createPortal target with whitespace before its call delimiter", () => {
		const code = [
			"export function Modal({ children }) {",
			'  return createPortal \t (children, document.getElementById("modal-root")!);',
			"}",
		].join("\n");
		expect(checkDirectDomAccess(code, "src/Modal.tsx")).toEqual([]);
	});

	// test-contract: boundary — useEffect's documented exemption accepts whitespace before the hook call delimiter
	test("exempts DOM access when useEffect has whitespace before its call delimiter", () => {
		const code = [
			"export function Comp() {",
			'  useEffect \t (() => { const el = document.querySelector(".target"); }, []);',
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
		expect(nonNull(found[0]).line).toBe(3);
		expect(nonNull(found[0]).text).toContain("3 inline object props");
		expect(nonNull(found[0]).text).toContain("useMemo");
	});

	test("aggregated count keeps climbing past the 10-match collection cap", () => {
		// 13 inline-object props: the per-line collector stops at 10, but the
		// reported count reflects all 13 (drives the `allMatches.length < 10`
		// false branch of the && while count keeps incrementing).
		const lines = Array.from({ length: 13 }, (_, i) => `  <C${i} p={{ v: ${i} }} />`);
		const code = ["export function Comp() {", "  return <>", ...lines, "  </>;", "}"].join("\n");
		const found = checkInlineObjectProps(code, "src/Comp.tsx");
		expect(found).toHaveLength(1);
		expect(nonNull(found[0]).text).toContain("13 inline object props");
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

	// test-contract: public-api — inline-object diagnostics preserve the documented 150-character source-text bound for the first finding
	test("bounds a long inline-object diagnostic to 150 source characters", () => {
		const longProp = `    <Widget longProperty={{ value: "${"x".repeat(220)}" }} />`;
		const code = [longProp, "<Widget second={{ value: 2 }} />", "<Widget third={{ value: 3 }} />"].join("\n");
		const found = checkInlineObjectProps(code, "src/Comp.tsx");
		expect(found).toEqual([
			{
				line: 1,
				text: `[3 inline object props — creates new references every render, causing unnecessary re-renders. Extract to constants or useMemo] ${longProp.trim().slice(0, 150)}`,
			},
		]);
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
		expect(nonNull(found[0]).text).toContain("onSubmit");
	});
});

describe("React checks — mutation boundary cases", () => {
	test("useState accepts whitespace before the call delimiter and reports trimmed source", () => {
		const hooks = Array.from({ length: 8 }, (_, i) => `  const [s${i}, setS${i}] = useState \t (0);`);
		const code = ["export function Comp() {", ...hooks, "}"].join("\n");
		const found = checkExcessiveUseState(code, "src/Comp.tsx");
		expect(found).toEqual([
			{
				line: 2,
				text: "[8 useState hooks — consider useReducer or splitting component] const [s0, setS0] = useState \t (0);",
			},
		]);
	});

	test("all React detectors remain gated on extension when given real matching syntax", () => {
		expect(checkDangerouslySetInnerHTML("<div dangerouslySetInnerHTML={{ __html: runtime }} />", NON_REACT_PATH)).toEqual([]);
		expect(checkDirectDomAccess("document.querySelector('.target');", NON_REACT_PATH)).toEqual([]);
		expect(checkInlineObjectProps("<Widget longProperty={{ value: 1 }} />\n<Widget anotherProperty={{ value: 2 }} />\n<Widget thirdProperty={{ value: 3 }} />", NON_REACT_PATH)).toEqual([]);
		expect(checkAsyncEventHandler("<button onClick={async () => save()} />", NON_REACT_PATH)).toEqual([]);

		const jsxPath = "src/Widget.jsx";
		expect(checkDangerouslySetInnerHTML("<div dangerouslySetInnerHTML={{ __html: runtime }} />", jsxPath)).toHaveLength(1);
		expect(checkDirectDomAccess("document.querySelector('.target');", jsxPath)).toHaveLength(1);
		expect(checkInlineObjectProps("<Widget longProperty={{ value: 1 }} />\n<Widget anotherProperty={{ value: 2 }} />\n<Widget thirdProperty={{ value: 3 }} />", jsxPath)).toHaveLength(1);
		expect(checkAsyncEventHandler("<button onClick={async () => save()} />", jsxPath)).toHaveLength(1);
	});

	test("dangerous HTML preserves the trimmed, bounded diagnostic text", () => {
		const line = `    <div dangerouslySetInnerHTML={{ __html: external }} /> ${"x".repeat(200)}   `;
		const found = checkDangerouslySetInnerHTML(line, "src/Comp.tsx");
		expect(found).toEqual([{ line: 1, text: line.trim().slice(0, 150) }]);
	});

	test("dangerous HTML resolves an identifier containing a regex metacharacter", () => {
		const code = [
			"const $HTML = '<p>static</p>';",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: $HTML }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("dangerous HTML requires every whitespace separator in the inline shape", () => {
		const code = [
			"const STATIC = '<p>static</p>';",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML \t= \t{ \t{ __html \t: \tSTATIC \t} \t} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	// test-contract: boundary — dangerouslySetInnerHTML accepts the documented JSX object shape even when __html follows the inner brace without whitespace
	test("dangerous HTML accepts an inline object with no separator after the inner brace", () => {
		const code = [
			"const STATIC = '<p>static</p>';",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{__html: STATIC}} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("template static-string scanning does not stop at an escaped backtick before interpolation", () => {
		const code = [
			"const html = `prefix \\` ${userInput}`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toHaveLength(1);
	});

	test("template static-string scanning handles a dollar immediately before closing", () => {
		const code = [
			"const html = `price $`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("template static-string scanning ignores interpolation-looking text outside the template", () => {
		const code = [
			"const html = `static`; const unrelated = '${runtime}';",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("template static-string scanning treats a plain brace as ordinary text", () => {
		const code = [
			"const html = `literal { text`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("template static-string scanning treats a plain closing brace as ordinary text", () => {
		const code = [
			"const html = `literal } text`;",
			"export function Comp() {",
			"  return <div dangerouslySetInnerHTML={{ __html: html }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comp.tsx")).toEqual([]);
	});

	test("direct DOM diagnostics are trimmed and bounded", () => {
		const line = `    document.querySelector('.target'); ${"x".repeat(200)}   `;
		const found = checkDirectDomAccess(line, "src/Comp.tsx");
		expect(found).toEqual([{ line: 1, text: line.trim().slice(0, 150) }]);
	});

	test("inline object diagnostics use the complete prop name and trimmed text", () => {
		const code = [
			"export function Comp() {",
			"    <Widget longProperty={{ value: 1 }} />",
			"    <Widget anotherProperty={{ value: 2 }} />",
			"    <Widget thirdProperty={{ value: 3 }} />",
			"}",
		].join("\n");
		const found = checkInlineObjectProps(code, "src/Comp.tsx");
		expect(found).toEqual([
			{
				line: 2,
				text: "[3 inline object props — creates new references every render, causing unnecessary re-renders. Extract to constants or useMemo] <Widget longProperty={{ value: 1 }} />",
			},
		]);
	});
});
