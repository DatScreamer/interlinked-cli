import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan, checkSuppressionSpan } from "./unsafe-span.js";

describe("checkRustUnsafeSpan — blankRange must preserve word boundaries (positive, must fire)", () => {
	// test-contract: public-api — checkRustUnsafeSpan must still find a real
	// unsafe block when a short string sits directly against it with no
	// space, proving blanked characters are replaced with a space, not
	// deleted (a deletion would fuse the identifier before it with "unsafe").
	it("detects an unsafe block even when a short string sits directly before it with no space", () => {
		const content = [
			"fn f() {",
			'    fooo"Q"unsafe {',
			"        a();",
			"        b();",
			"        c();",
			"        d();",
			"        e();",
			"        f();",
			"    }",
			"}",
		].join("\n");
		const matches = checkRustUnsafeSpan(content, "src/sample_fusion.rs");
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("rust_unsafe_span");
	});
});

describe("checkRustUnsafeSpan — raw strings must be recognized as a unit (negative, must not fire)", () => {
	// test-contract: public-api — a `r##"..."#​#` raw string containing a
	// bare embedded quote and an "unsafe {" look-alike must be blanked as
	// ONE unit through its real closer, proving rawStringOpenAt's guard is
	// not disabled (a disabled guard falls back to plain-quote scanning,
	// which stops early at the embedded quote and leaves "unsafe {" live).
	it("does not flag an unsafe-shaped pattern hidden inside a ##-hashed raw string with an embedded quote", () => {
		const content = [
			"fn f() {",
			'    let s = r##"a"unsafe {',
			"        x();",
			"        y();",
			"        z();",
			"        w();",
			"        v();",
			"        u();",
			'    }"##;',
			"}",
		].join("\n");
		const matches = checkRustUnsafeSpan(content, "src/sample_raw.rs");
		expect(matches).toEqual([]);
	});
});

describe("checkRustUnsafeSpan — an unsafe block with no matching close brace (negative, must not fire)", () => {
	// test-contract: boundary — an unclosed `unsafe {` (no matching `}` in
	// the file) must resolve `closeIdx` to undefined and be skipped cleanly,
	// never crash and never be reported as a span violation.
	it("returns no findings and does not throw for an unterminated unsafe block", () => {
		const content = ["fn f() {", "    unsafe {", "        a();", "        b();"].join(
			"\n",
		);
		expect(() => checkRustUnsafeSpan(content, "src/sample_unterminated.rs")).not.toThrow();
		expect(checkRustUnsafeSpan(content, "src/sample_unterminated.rs")).toEqual([]);
	});
});

describe("checkRustUnsafeSpan — a lone division slash must not open a block comment (positive, must fire)", () => {
	// test-contract: public-api — a bare `/` (division, not followed by `*`)
	// must not be treated as opening a Rust block comment; if it were, it
	// would swallow the rest of the file (including a real unsafe block)
	// hunting for a "*/" that doesn't exist.
	it("still detects a real unsafe block that follows an unrelated division expression", () => {
		const content = [
			"fn f() {",
			"    let x = a / b;",
			"    unsafe {",
			"        a();",
			"        b();",
			"        c();",
			"        d();",
			"        e();",
			"        f();",
			"    }",
			"}",
		].join("\n");
		const matches = checkRustUnsafeSpan(content, "src/sample_division.rs");
		expect(matches.length).toBe(1);
	});
});

describe("checkSuppressionSpan — an unterminated single-quoted string must not swallow later comments (positive, must fire)", () => {
	// test-contract: public-api — a `'`-quoted JS/TS string with no closing
	// quote before end-of-line must stop scanning at that newline, so a real
	// eslint-disable/eslint-enable pair further down the file still parses.
	it("still finds the disable/enable pair after a stray unterminated single-quote string", () => {
		const lines: string[] = [];
		lines.push("const bad = 'unterminated");
		lines.push("/* eslint-disable no-console */");
		for (let n = 1; n <= 12; n++) lines.push(`console.log(${n});`);
		lines.push("/* eslint-enable no-console */");
		const content = lines.join("\n");
		const matches = checkSuppressionSpan(content, "src/sample_unterminated_string.ts");
		expect(matches.length).toBe(1);
	});
});

describe("checkSuppressionSpan — a lone division slash must not open a block comment (positive, must fire)", () => {
	// test-contract: public-api — a bare `/` (division) in JS/TS source must
	// not be treated as opening a block comment; if it were, it would
	// consume the real eslint-disable comment's own body, silently dropping
	// the directive.
	it("still finds the disable/enable pair after an unrelated division expression", () => {
		const lines: string[] = [];
		lines.push("const x = a / b;");
		lines.push("/* eslint-disable no-console */");
		for (let n = 1; n <= 12; n++) lines.push(`console.log(${n});`);
		lines.push("/* eslint-enable no-console */");
		const content = lines.join("\n");
		const matches = checkSuppressionSpan(content, "src/sample_div.ts");
		expect(matches.length).toBe(1);
	});
});

describe("checkSuppressionSpan — a multiplication asterisk must not open a block comment (positive, must fire)", () => {
	// test-contract: public-api — a character immediately followed by `*`
	// (e.g. the space before a `*` in a multiplication expression) must not
	// be treated as opening a block comment on its own.
	it("still finds the disable/enable pair after an unrelated multiplication expression", () => {
		const lines: string[] = [];
		lines.push("const x = a * b;");
		lines.push("/* eslint-disable no-console */");
		for (let n = 1; n <= 12; n++) lines.push(`console.log(${n});`);
		lines.push("/* eslint-enable no-console */");
		const content = lines.join("\n");
		const matches = checkSuppressionSpan(content, "src/sample_mul.ts");
		expect(matches.length).toBe(1);
	});
});

describe("checkSuppressionSpan — line counting across a multi-line comment (positive, must fire, exact span)", () => {
	// test-contract: invariant — a newline embedded inside a block comment
	// must ADD to the running line counter (not subtract), so the exact
	// reported span for a later disable/enable pair stays correct.
	// The disable comment starts on line 2 and spans through line 3; the
	// enable comment sits on line 16. Correct counting gives span 15
	// (16 - 2 + 1). If the embedded newline SUBTRACTS instead of adding,
	// every subsequent line is off by 2 and the reported span is 13.
	it("reports the exact span, which only holds if newlines inside a block comment ADD to the line count", () => {
		const lines: string[] = [];
		lines.push("console.log(0);");
		lines.push("/* eslint-disable no-console");
		lines.push("*/");
		for (let n = 1; n <= 12; n++) lines.push(`console.log(${n});`);
		lines.push("/* eslint-enable no-console */");
		const content = lines.join("\n");
		const matches = checkSuppressionSpan(content, "src/sample_multiline_comment.ts");
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
		expect(matches[0]?.text).toContain("spans 15 lines");
	});
});

describe("checkSuppressionSpan — an intervening bare disable must not be mistaken for an enable (positive, must fire)", () => {
	// test-contract: invariant — findEnableLineFor must skip any directive
	// whose kind is not "enable" while searching for a disable's closer.
	// disable A sits on line 2 (rule no-console); an unrelated bare disable
	// B sits on line 4; the real enable for A sits on line 16 (span 15). If
	// the kind-skip guard breaks, B (bare, so its rules.length is 0) gets
	// mistaken for A's closer, producing a tiny bogus span of 3 instead, and
	// the real 15-line violation goes unreported.
	it("still reports the wide span for the first disable, skipping past an unrelated bare disable", () => {
		const lines: string[] = [];
		lines.push("console.log(0);");
		lines.push("/* eslint-disable no-console */");
		lines.push("console.log(1);");
		lines.push("/* eslint-disable */");
		for (let n = 2; n <= 12; n++) lines.push(`console.log(${n});`);
		lines.push("/* eslint-enable no-console */");
		const content = lines.join("\n");
		const matches = checkSuppressionSpan(content, "src/sample_bare_intervening.ts");
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(2);
		expect(matches[0]?.text).toContain("spans 15 lines");
	});
});
