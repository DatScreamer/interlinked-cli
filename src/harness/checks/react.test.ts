// Co-located tests for `react.ts` checks.
//
// FP refinement (139-repo audit, 2026-05): `dangerouslySetInnerHTML`
// fires on the JSX prop, but the value is often a same-file string
// constant with no user input (Expo Router boilerplate, static CSS,
// generated SVG markup). The check now inspects the value identifier
// and skips when it resolves to a literal string/template with no
// `${...}` interpolation.

import { describe, expect, test } from "vitest";
import { checkDangerouslySetInnerHTML } from "./react.js";

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

	// Positive cases — real XSS risks MUST still fire.

	test("STILL flags when value is a prop / variable from outside", () => {
		// `userComment` is a parameter — runtime value, real XSS risk.
		const code = [
			"export function Comment({ userComment }: { userComment: string }) {",
			"  return <div dangerouslySetInnerHTML={{ __html: userComment }} />;",
			"}",
		].join("\n");
		expect(checkDangerouslySetInnerHTML(code, "src/Comment.tsx").length).toBe(1);
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
});
