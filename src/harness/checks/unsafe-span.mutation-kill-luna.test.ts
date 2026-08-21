import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan, checkSuppressionSpan } from "./unsafe-span.js";

const RS = "src/ffi/bridge.rs";
const TS = "src/feature/bridge.ts";
const code = (n: number): string[] => Array.from({ length: n }, (_, i) => `    op_${i}();`);
const rust = (lines: string[]) => checkRustUnsafeSpan(lines.join("\n"), RS);
const js = (lines: string[]) => checkSuppressionSpan(lines.join("\n"), TS);

describe("unsafe-span public mutation contracts", () => {
	// test-contract: public-api — comment-only interior lines must remain blank so they do not inflate the nonblank span.
	it("does not fire for five statements plus a Rust block comment", () => {
		expect(rust(["unsafe {", ...code(2), "    /* comment text */", ...code(3), "}"])).toHaveLength(0);
	});

	// test-contract: boundary — an unterminated Rust block comment must hide every later brace and unsafe block.
	it("does not fire when an unterminated block comment consumes the apparent block", () => {
		expect(rust(["/* comment", "unsafe {", ...code(6), "}"])).toHaveLength(0);
	});

	// test-contract: public-api — a Rust char literal containing a brace must not close the unsafe block.
	it("keeps a brace inside a char literal opaque", () => {
		const found = rust(["unsafe {", "    let close = '}';", ...code(5), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	// test-contract: boundary — a lifetime apostrophe is code, not a three-character char literal, so its following brace stays live.
	it("does not blank a lifetime followed by a real closing brace", () => {
		expect(rust(["unsafe {", "    let _: &'a}", ...code(6), "}"])).toHaveLength(0);
	});

	// test-contract: boundary — an empty or truncated apostrophe sequence must not hide the next real brace.
	it("does not treat an apostrophe at end of input as a char literal", () => {
		expect(rust(["unsafe {", "    let x = '"])).toHaveLength(0);
	});

	// test-contract: public-api — plain Rust strings may span lines and braces in their contents are not syntax.
	it("keeps a brace in an unterminated plain string opaque until EOF", () => {
		expect(rust(["unsafe {", '    let s = "text }', ...code(5), "}"])).toHaveLength(0);
	});

	// test-contract: public-api — raw Rust strings use their exact hash delimiter and can contain ordinary braces.
	it("keeps a brace in a multi-hash raw string opaque", () => {
		const found = rust(["unsafe {", '    let s = r##"text }"##;', ...code(5), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	// test-contract: security — an identifier-adjacent `r#` is not a raw-string opener and must leave its brace live.
	it("does not recognize identifier-adjacent raw-string syntax", () => {
		expect(rust(["unsafe {", "    let s = ptr##{ }", ...code(5), "}"])).toHaveLength(0);
	});

	// test-contract: boundary — only six nonblank interior lines exceed the five-line Rust threshold.
	it("fires at exactly six nonblank interior lines", () => {
		const found = rust(["unsafe {", ...code(6), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	// test-contract: public-api — an unmatched opening brace is ignored rather than reported as a bounded span.
	it("does not fire for an unbalanced unsafe block", () => {
		expect(rust(["unsafe {", ...code(8)])).toHaveLength(0);
	});

	// test-contract: invariant — nested braces must match the outer unsafe block, not its first inner close.
	it("counts the full balanced nested unsafe span", () => {
		const found = rust(["unsafe {", "    if ready {", "        inner();", "    }", ...code(4), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	// test-contract: public-api — no directives means no bounded suppression finding.
	it("does not invent a suppression finding without directives", () => {
		expect(js(["const value = 1;", ...code(12)])).toHaveLength(0);
	});

	// test-contract: public-api — block comments beginning with a line comment are not ESLint directives.
	it("ignores directive-shaped text inside a line comment", () => {
		expect(js(["// /* eslint-disable */", ...code(12), "/* eslint-enable */"])).toHaveLength(0);
	});

	// test-contract: security — directive-shaped text in a quoted string must not disable linting.
	it("ignores directive-shaped text inside an unterminated quoted string", () => {
		expect(js(['const text = "/* eslint-disable */', ...code(12), "/* eslint-enable */"])).toHaveLength(0);
	});

	// test-contract: boundary — a multiline template string is opaque while scanning, including embedded directive text.
	it("ignores directives inside a multiline template literal", () => {
		const tick = String.fromCharCode(96);
		expect(js([`const text = ${tick}/* eslint-disable */`, "still text", `${tick};`, ...code(12), "/* eslint-enable */"])).toHaveLength(0);
	});

	// test-contract: invariant — an enable for another rule cannot close a scoped disable.
	it("keeps a scoped disable open across an unrelated enable", () => {
		expect(js(["/* eslint-disable no-console */", ...code(5), "/* eslint-enable no-undef */"])).toHaveLength(0);
	});

	// test-contract: public-api — a matching scoped enable closes the rule-specific region and prevents a finding.
	it("closes a scoped disable with its matching rule", () => {
		expect(js(["/* eslint-disable no-console */", ...code(9), "/* eslint-enable no-console */"])).toHaveLength(0);
	});

	// test-contract: boundary — a ten-line inclusive disable-to-enable region is allowed.
	it("does not fire at the exact suppression span limit", () => {
		expect(js(["/* eslint-disable */", ...code(8), "/* eslint-enable */"])).toHaveLength(0);
	});

	// test-contract: boundary — an eleven-line inclusive region must fire at its disable line.
	it("fires one line beyond the suppression span limit", () => {
		const found = js(["/* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: invariant — a bare disable is closed only by a bare enable, never by a scoped enable.
	it("does not close a bare disable with a scoped enable", () => {
		expect(js(["/* eslint-disable */", ...code(12), "/* eslint-enable no-console */"])).toHaveLength(0);
	});

	// test-contract: public-api — a disable with no matching enable is file-level suppression owned by another check.
	it("does not report an unbounded disable", () => {
		expect(js(["/* eslint-disable no-console */", ...code(20)])).toHaveLength(0);
	});

	// test-contract: invariant — multiple rule spans report the widest matching bounded region.
	it("reports the widest region among rules in one disable", () => {
		const found = js([
			"/* eslint-disable no-console, no-undef */",
			...code(2),
			"/* eslint-enable no-undef */",
			...code(10),
			"/* eslint-enable no-console */",
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 15 lines");
	});
});
