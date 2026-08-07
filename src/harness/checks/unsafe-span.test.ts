// Unit tests for unsafe-span.ts
//
// checkRustUnsafeSpan (rust_unsafe_span):
//   Positive (MUST fire):
//     RP1  6 nonblank interior lines
//     RP2  blank + comment-only interior lines are NOT counted
//     RP3  small block + big block in one file → only the big one fires
//     RP4  nested braces inside the unsafe block are balanced correctly
//     RP5  "unsafe" keyword with the brace on the next line
//     RP6  same-line #[cfg] attribute opening an inner block (# is not a comment)
//     RP7  lifetime + '}' char literal on an interior line
//     RP8  multi-line raw string with a `}` content line inside a wide block
//     RP9  multi-line plain string with a `}` content line inside a wide block
//     RP10 attribute-only interior line counts as code
//   Negative (MUST NOT fire):
//     RN1  exactly 5 interior lines (boundary)
//     RN2  one-line and two-line unsafe blocks
//     RN3  unsafe fn / unsafe impl without an unsafe block
//     RN4  comments-only occurrence
//     RN5  string-literal occurrence
//     RN6  wrong extension (.c)
//     RN7  test-file path (tests/ dir)
//     RN8  generator-marker header
//     RN9  rust-bindgen output
//     RN10 unclosed (unbalanced) block
//     RN11 one-line block containing a raw string (r#"..."#)
//     RN12 short block containing a multi-line string with a `{` inside
//     RN13 unsafe block inside a NESTED block comment
//     RN14 one-statement block, lifetime + trailing comment with unmatched `{`
//   Adversarial perf (must stay near-linear; quadratic-scan regression):
//     RA1  200KB balanced non-firing blocks under budget
//     RA2  200KB unbalanced opens under budget
//
// checkSuppressionSpan (suppression_block_span):
//   Positive (MUST fire):
//     SP1  bare disable → enable, 15-line region
//     SP2  rule-list disable → enable
//     SP3  small region + big region → only the big one fires
//     SP4  11-line region (boundary: just over the cap)
//     SP5  apostrophe in a line comment above the region does not break the scan
//     SP6  rule-aware pairing skips an inner scoped enable for a different rule
//   Negative (MUST NOT fire):
//     SN1  disable/enable pair 4 lines apart
//     SN2  disable with no enable (file-level suppression — other check's job)
//     SN3  line-form eslint-disable-next-line only
//     SN4  block-form eslint-disable-next-line + stray enable
//     SN5  comments-only mention of the block form
//     SN6  string-literal occurrence
//     SN7  template-literal occurrence (multi-line)
//     SN8  wrong extension (.py)
//     SN9  test-file path
//     SN10 exactly 10-line region (boundary)
//     SN11 enable BEFORE disable
//     SN12 disjoint rule sets (disable no-console / enable no-undef)
//     SN13 bare file-level disable + later unrelated scoped pair

import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan, checkSuppressionSpan } from "./unsafe-span.js";

const RS_PATH = "crates/core/src/ffi.rs";
const TS_PATH = "src/lib/app.ts";

// ESLint directive fixture lines, hoisted so no test-body line pairs a
// string containing the two-char comment closer with a trailing slash.
const DISABLE = "/* eslint-disable */";
const ENABLE = "/* eslint-enable */";
const DISABLE_RULES = "/* eslint-disable no-console, no-undef */";
const ENABLE_RULES = "/* eslint-enable no-console, no-undef */";
const DISABLE_NEXT_LINE_BLOCK = "/* eslint-disable-next-line no-console */";
const DISABLE_NO_CONSOLE = "/* eslint-disable no-console */";
const ENABLE_NO_CONSOLE = "/* eslint-enable no-console */";
const DISABLE_NO_UNDEF = "/* eslint-disable no-undef */";
const ENABLE_NO_UNDEF = "/* eslint-enable no-undef */";

function rust(lines: string[], path = RS_PATH) {
	return checkRustUnsafeSpan(lines.join("\n"), path);
}

function suppression(lines: string[], path = TS_PATH) {
	return checkSuppressionSpan(lines.join("\n"), path);
}

/** N distinct nonblank statement lines for fixture padding. */
function stmts(n: number, indent = "    "): string[] {
	return Array.from({ length: n }, (_, i) => indent + "step_" + i + "();");
}

// ─── rust_unsafe_span — positive ──────────────────────────────────────────────

describe("checkRustUnsafeSpan — positive (must fire)", () => {
	it("RP1: unsafe block with 6 nonblank interior lines fires at the unsafe line", () => {
		const src = [
			"fn init(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let a = p.add(1);", // 3
			"        let b = p.add(2);", // 4
			"        let c = p.add(3);", // 5
			"        let d = p.add(4);", // 6
			"        let e = p.add(5);", // 7
			"        let f = p.add(6);", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toMatch(/^rust_unsafe_span: unsafe block spans 6 nonblank lines/);
		expect(found[0]?.text).toContain("78% of Bun's post-port unsafe blocks are one line");
	});

	it("RP2: blank and comment-only interior lines are not counted in the span", () => {
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			"        let a = 1;", // 3
			"", // 4 (blank — not counted)
			"        // SAFETY: pointer valid for writes", // 5 (comment — not counted)
			"        let b = 2;", // 6
			"        let c = 3;", // 7
			"        let d = 4;", // 8
			"        let e = 5;", // 9
			"        let f = 6;", // 10
			"    }", // 11
			"}", // 12
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RP3: only the wide block fires when a one-liner sits next to it", () => {
		const src = [
			"fn g(p: *mut u8) {", // 1
			"    unsafe { p.write(0); }", // 2 (narrow — OK)
			"    unsafe {", // 3
			...stmts(6, "        "), // 4-9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("RP4: nested braces inside the block are balanced to the right close", () => {
		const src = [
			"fn h(cond: bool) {", // 1
			"    unsafe {", // 2
			"        if cond {", // 3
			"            do_a();", // 4
			"            do_b();", // 5
			"        } else {", // 6
			"            do_c();", // 7
			"        }", // 8
			"        do_d();", // 9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 7 nonblank lines");
	});

	it("RP5: unsafe keyword with the brace on the following line fires at the keyword", () => {
		const src = [
			"fn i() {", // 1
			"    unsafe", // 2
			"    {", // 3
			...stmts(6, "        "), // 4-9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("RP6: same-line #[cfg] attribute opening an inner block does not close the block early", () => {
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			"        #[cfg(unix)] {", // 3 — attribute is CODE; its `{` must nest
			"            libc::close(fd);", // 4
			"        }", // 5
			"        x1();", // 6
			"        x2();", // 7
			"        x3();", // 8
			"        x4();", // 9
			"        x5();", // 10
			"    }", // 11
			"}", // 12
		];
		const found = rust(src, "crates/core/src/sys.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 8 nonblank lines");
	});

	it("RP7: lifetime + '}' char literal on an interior line keeps the block wide", () => {
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let name: &'static str = if c == '}' { \"a\" } else { \"b\" };", // 3
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"        x6();", // 9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src, "crates/core/src/parse.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 7 nonblank lines");
	});

	it("RP8: multi-line raw string with a `}` content line does not hide a wide block", () => {
		const src = [
			"fn emit(p: *mut Ctx) {", // 1
			"    unsafe {", // 2
			"        ffi::begin(p);", // 3
			'        let epilogue = std::ffi::CString::new(r#"', // 4
			"}", // 5 — raw-string CONTENT (a C epilogue), not code
			'"#)', // 6
			"        .unwrap();", // 7
			"        ffi::append(p, epilogue.as_ptr());", // 8
			"        ffi::step3(p);", // 9
			"        ffi::step4(p);", // 10
			"        ffi::step5(p);", // 11
			"        ffi::finish(p);", // 12
			"    }", // 13
			"}", // 14
		];
		const found = rust(src, "crates/core/src/gen.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 9 nonblank lines");
	});

	it("RP9: multi-line plain string with a `}` content line does not hide a wide block", () => {
		const src = [
			"fn log_and_run(p: *mut u8) {", // 1
			"    unsafe {", // 2
			'        let msg = "closing marker:', // 3 — string spans lines
			"} end of block", // 4 — string CONTENT
			'";', // 5
			"        ffi::log(msg.as_ptr());", // 6
			"        ffi::a(p);", // 7
			"        ffi::b(p);", // 8
			"        ffi::c(p);", // 9
			"        ffi::d(p);", // 10
			"        ffi::e(p);", // 11
			"    }", // 12
			"}", // 13
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 8 nonblank lines");
	});

	it("RP10: an attribute-only interior line counts as code, not comment", () => {
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        #[cfg(debug_assertions)]", // 3 — real nonblank code line
			"        check_alignment(p);", // 4
			"        step1(p);", // 5
			"        step2(p);", // 6
			"        step3(p);", // 7
			"        step4(p);", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});
});

// ─── rust_unsafe_span — negative ──────────────────────────────────────────────

describe("checkRustUnsafeSpan — negative (must not fire)", () => {
	it("RN1: exactly 5 interior lines (boundary) does not fire", () => {
		const src = [
			"fn f(p: *mut u8) {",
			"    unsafe {",
			...stmts(5, "        "),
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN2: one-line and two-line unsafe blocks do not fire", () => {
		const src = [
			"fn f(p: *mut u8) {",
			"    let v = unsafe { p.read() };",
			"    unsafe {",
			"        p.write(1);",
			"        p.write(2);",
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN3: unsafe fn / unsafe impl without an unsafe block do not fire", () => {
		const src = [
			"unsafe fn scary(p: *mut u8) {",
			...stmts(8, "    "),
			"}",
			"struct Wrapper(*mut u8);",
			"unsafe impl Send for Wrapper {}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN4: comments-only occurrence does not fire", () => {
		const src = [
			"// docs example only:",
			"// unsafe {",
			"//     one();",
			"//     two();",
			"//     three();",
			"//     four();",
			"//     five();",
			"//     six();",
			"// }",
			"/* also unsafe {",
			"   in_block_comment();",
			"} */",
			"fn real() {}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN5: string-literal occurrence does not fire", () => {
		const src = [
			"fn msg() {",
			'    let s = "unsafe {";',
			...stmts(6, "    "),
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN6: wrong extension (.c) does not fire", () => {
		const src = ["void f() {", "    unsafe {", ...stmts(6, "        "), "    }", "}"];
		expect(rust(src, "src/ffi.c")).toHaveLength(0);
	});

	it("RN7: test-file path does not fire", () => {
		const src = ["fn t() {", "    unsafe {", ...stmts(6, "        "), "    }", "}"];
		expect(rust(src, "mycrate/tests/integration.rs")).toHaveLength(0);
	});

	it("RN8: generator-marked file does not fire", () => {
		// Marker built at runtime so THIS test file's own header never
		// carries a generator marker in its first 20 lines.
		const marker = "@" + "generated";
		const src = [
			"// " + marker + " by cbindgen — edit the schema instead",
			"fn t() {",
			"    unsafe {",
			...stmts(6, "        "),
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN9: rust-bindgen output does not fire", () => {
		const src = [
			"// bindings built with rust-bindgen 0.69.4",
			"fn t() {",
			"    unsafe {",
			...stmts(6, "        "),
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN10: unclosed (unbalanced) block does not fire", () => {
		const src = ["fn t() {", "    unsafe {", ...stmts(8, "        ")];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN11: one-line block containing a raw string (r#\"...\"#) does not fire", () => {
		const src = [
			"fn f() {", // 1
			'    unsafe { call(r#"x"#); }', // 2 — # must not read as a comment
			"    a1();", // 3
			"    a2();", // 4
			"    a3();", // 5
			"    a4();", // 6
			"    a5();", // 7
			"    a6();", // 8
			"}", // 9
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN12: short block with a multi-line string containing `{` does not fire", () => {
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        emit("{', // 3 — string spans lines; its `{` is content
			'");', // 4
			"    }", // 5
			"    a1();", // 6
			"    a2();", // 7
			"    a3();", // 8
			"    a4();", // 9
			"    a5();", // 10
			"    a6();", // 11
			"}", // 12
		];
		expect(rust(src, "crates/core/src/gen.rs")).toHaveLength(0);
	});

	it("RN13: unsafe block inside a NESTED block comment does not fire", () => {
		// Rust block comments nest — the whole region through the FINAL */ is
		// one comment (this is exactly how code containing /* */ is commented out).
		const src = [
			"/* commented out /* keep */", // 1
			"unsafe {", // 2
			"    a();", // 3
			"    b();", // 4
			"    c();", // 5
			"    d();", // 6
			"    e();", // 7
			"    f();", // 8
			"}", // 9
			"*/", // 10
			"fn real() {}", // 11
		];
		expect(rust(src, "crates/core/src/lib.rs")).toHaveLength(0);
	});

	it("RN14: one-statement block + lifetime + trailing comment with `{` does not fire", () => {
		const src = [
			"fn head<'a>(p: *const u8, n: usize) -> &'a [u8] {", // 1
			"    let s: &'a [u8];", // 2
			"    unsafe {", // 3
			"        s = core::slice::from_raw_parts::<'a, u8>(p, n); // was: if n == 0 {", // 4
			"    }", // 5
			"    validate(s);", // 6
			"    trace(s);", // 7
			"    audit(s);", // 8
			"    record(s);", // 9
			"    publish(s);", // 10
			"    s", // 11
			"}", // 12
		];
		expect(rust(src)).toHaveLength(0);
	});
});

// ─── rust_unsafe_span — additional branch coverage ────────────────────────────

describe("checkRustUnsafeSpan — additional branch coverage", () => {
	it("RP11: a closed escaped char literal ('\\n') inside a wide block is stripped and still fires", () => {
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let sep = '\\n';", // 3 — escaped char literal, closes normally
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RN15: an unterminated escaped char literal breaks at the next newline and does not corrupt the scan", () => {
		const src = [
			"fn f() {", // 1
			"    let bad = '\\q", // 2 — escape start, no closing quote before EOL
			"    a1();", // 3
			"    a2();", // 4
			"    a3();", // 5
			"    a4();", // 6
			"    a5();", // 7
			"    a6();", // 8
			"}", // 9
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RN16: a trailing line comment with no terminating newline (EOF) is stripped correctly", () => {
		const src = ["// trailing comment, file ends right after this, no newline"];
		expect(rust(src, "crates/core/src/tail.rs")).toHaveLength(0);
	});

	it("RN17: a stray unmatched closing brace before a real block doesn't break brace matching", () => {
		const src = [
			"}", // 1 — stray close, no matching open (pop() returns undefined)
			"fn f(p: *mut u8) {", // 2
			"    unsafe {", // 3
			...stmts(6, "        "), // 4-9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("RN18: an unterminated raw string blanks the rest of the file, hiding a wide block", () => {
		const src = [
			"fn f() {", // 1
			'    let s = r#"begin', // 2 — raw string opens, never closes
			"unsafe {", // 3 — inside the (unterminated) raw string, not real code
			"    a();", // 4
			"    b();", // 5
			"    c();", // 6
			"    d();", // 7
			"    e();", // 8
			"    f();", // 9
			"}", // 10
		];
		expect(rust(src, "crates/core/src/gen.rs")).toHaveLength(0);
	});

	it("RN19: total interior lines exceed the cap but nonblank content stays within it", () => {
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			"        a();", // 3
			"", // 4 (blank)
			"", // 5 (blank)
			"        // c1", // 6 (comment — blanked)
			"        // c2", // 7
			"        // c3", // 8
			"        // c4", // 9
			"        // c5", // 10
			"        // c6", // 11
			"        b();", // 12
			"    }", // 13
			"}", // 14
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("RP13: a plain string with a backslash-escaped quote does not close the string early", () => {
		const src = [
			"fn f(p: *mut u8) {", // 1
			'    unsafe {', // 2
			'        let s = "a\\"b";', // 3 — escaped quote must not end the string
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RP14: a multi-char escaped char literal ('\\u{7FFF}') scans past interior chars before closing", () => {
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let c = '\\u{7FFF}';", // 3 — multi-char escape body, several loop iterations
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RP12: matches are capped at 10 per file even when 11 wide blocks are present", () => {
		const blocks: string[] = [];
		for (let i = 0; i < 11; i++) {
			blocks.push(`unsafe {`, ...stmts(6, "    "), `}`);
		}
		const found = rust(blocks);
		expect(found).toHaveLength(10);
	});
});

// ─── rust_unsafe_span — adversarial perf ──────────────────────────────────────

describe("checkRustUnsafeSpan — adversarial inputs stay near-linear", () => {
	// Quadratic-scan regression: the old per-candidate offset scans from 0 and
	// scan-to-EOF brace matching took ~5.8s (balanced) / ~4.3s (unbalanced) on
	// these inputs. The fixed one-pass index runs in ~20ms; the 2s budget is
	// ~100x headroom for slow CI while still failing a quadratic implementation.
	it(
		"RA1: 200KB of balanced non-firing blocks scans under budget",
		() => {
			const src = "unsafe {}\n".repeat(20_000); // ~200KB, 20k candidates
			const t0 = performance.now();
			expect(checkRustUnsafeSpan(src, RS_PATH)).toHaveLength(0);
			expect(performance.now() - t0).toBeLessThan(2_000);
		},
		60_000,
	);

	it(
		"RA2: 200KB of unbalanced opens scans under budget",
		() => {
			const src = "unsafe {".repeat(25_000); // ~200KB, all unclosed
			const t0 = performance.now();
			expect(checkRustUnsafeSpan(src, RS_PATH)).toHaveLength(0);
			expect(performance.now() - t0).toBeLessThan(2_000);
		},
		60_000,
	);
});

// ─── suppression_block_span — positive ────────────────────────────────────────

describe("checkSuppressionSpan — positive (must fire)", () => {
	it("SP1: bare disable → enable spanning 15 lines fires at the disable line", () => {
		const src = [
			DISABLE, // 1
			...stmts(13, ""), // 2-14
			ENABLE, // 15
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toMatch(
			/^suppression_block_span: eslint-disable block spans 15 lines/,
		);
	});

	it("SP2: rule-list disable → enable fires", () => {
		const src = [
			DISABLE_RULES, // 1
			...stmts(12, ""), // 2-13
			ENABLE_RULES, // 14
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});

	it("SP3: only the wide region fires when a narrow region precedes it", () => {
		const src = [
			DISABLE, // 1
			"legacy();", // 2
			ENABLE, // 3
			"ok();", // 4
			DISABLE, // 5
			...stmts(12, ""), // 6-17
			ENABLE, // 18
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(5);
		expect(found[0]?.text).toContain("spans 14 lines");
	});

	it("SP4: 11-line region (just over the 10-line cap) fires", () => {
		const src = [
			DISABLE, // 1
			...stmts(9, ""), // 2-10
			ENABLE, // 11
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	it("SP5: an apostrophe in a comment above the region does not break the scan", () => {
		const src = [
			"// don't widen suppressions", // 1 (unpaired apostrophe)
			DISABLE, // 2
			...stmts(12, ""), // 3-14
			ENABLE, // 15
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 14 lines");
	});

	it("SP6: an inner scoped enable for a DIFFERENT rule does not end the region", () => {
		// no-console is suppressed lines 1-29; the enable at line 4 only
		// re-enables no-undef (rule-aware pairing must skip it).
		const src = [
			DISABLE_NO_CONSOLE, // 1
			DISABLE_NO_UNDEF, // 2
			"doWork();", // 3
			ENABLE_NO_UNDEF, // 4 — closes only line 2's region (span 3)
			...stmts(24, ""), // 5-28
			ENABLE_NO_CONSOLE, // 29 — the matching enable for line 1
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 29 lines");
	});
});

// ─── suppression_block_span — negative ────────────────────────────────────────

describe("checkSuppressionSpan — negative (must not fire)", () => {
	it("SN1: disable/enable pair 4 lines apart does not fire", () => {
		const src = [
			DISABLE_RULES, // 1
			"a();", // 2
			"b();", // 3
			"c();", // 4
			ENABLE_RULES, // 5
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN2: disable with no matching enable does not fire (file-level — not ours)", () => {
		const src = [DISABLE, ...stmts(30, "")];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN3: line-form eslint-disable-next-line does not fire", () => {
		const src = [
			"// eslint-disable-next-line no-console",
			"console.log(1);",
			...stmts(15, ""),
			"// eslint-disable-next-line no-console",
			"console.log(2);",
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN4: block-form eslint-disable-next-line + a stray enable does not fire", () => {
		const src = [
			DISABLE_NEXT_LINE_BLOCK, // 1 — not a region opener
			"console.log(1);", // 2
			...stmts(12, ""), // 3-14
			ENABLE, // 15 — no disable to pair with
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN5: comments-only mention of the block form does not fire", () => {
		const src = [
			"// wrap a region in /* eslint-disable */ to silence it",
			...stmts(12, ""),
			"// and close it with /* eslint-enable */ afterwards",
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN6: string-literal occurrence does not fire", () => {
		const src = [
			'const open = "/* eslint-disable */";',
			...stmts(12, ""),
			"const close = '/* eslint-enable */';",
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN7: multi-line template literal containing both directives does not fire", () => {
		// Backtick built at runtime: the FIXTURE contains a real multi-line
		// template literal, without this test file carrying a raw backtick
		// inside a quoted string in its own source.
		const bt = String.fromCharCode(96);
		const src = [
			"const doc = " + bt, // 1 — template opens
			DISABLE, // 2 (inside template)
			...stmts(12, ""), // 3-14
			ENABLE, // 15 (inside template)
			bt + ";", // 16 — template closes
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN8: wrong extension (.py) does not fire", () => {
		const src = [DISABLE, ...stmts(13, ""), ENABLE];
		expect(suppression(src, "scripts/gen.py")).toHaveLength(0);
	});

	it("SN9: test-file path does not fire", () => {
		const src = [DISABLE, ...stmts(13, ""), ENABLE];
		expect(suppression(src, "src/lib/app.test.ts")).toHaveLength(0);
		expect(suppression(src, "src/__tests__/helper.ts")).toHaveLength(0);
	});

	it("SN10: exactly 10-line region (boundary) does not fire", () => {
		const src = [
			DISABLE, // 1
			...stmts(8, ""), // 2-9
			ENABLE, // 10
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN11: enable before disable does not pair and does not fire", () => {
		const src = [
			ENABLE, // 1
			...stmts(12, ""), // 2-13
			DISABLE, // 14 — nothing after it
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN12: disjoint rule sets do not pair (no-console runs to EOF — file-level)", () => {
		const src = [
			DISABLE_NO_CONSOLE, // 1
			...stmts(12, ""), // 2-13
			ENABLE_NO_UNDEF, // 14 — re-enables a different rule; no match for line 1
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN13: bare file-level disable is not closed by a later unrelated scoped pair", () => {
		const src = [
			DISABLE, // 1 — bare; never fully re-enabled (file-level — not ours)
			...stmts(38, ""), // 2-39
			DISABLE_NO_CONSOLE, // 40
			"console.log(1);", // 41
			ENABLE_NO_CONSOLE, // 42 — closes only line 40's region (span 3)
			"more();", // 43
		];
		expect(suppression(src)).toHaveLength(0);
	});
});

// ─── suppression_block_span — additional branch coverage ──────────────────────

describe("checkSuppressionSpan — additional branch coverage", () => {
	it("SP7: matches are capped at 10 per file even when 11 wide regions are present", () => {
		const lines: string[] = [];
		for (let i = 0; i < 11; i++) {
			lines.push(DISABLE, ...stmts(12, ""), ENABLE);
		}
		const found = suppression(lines);
		expect(found).toHaveLength(10);
	});

	it("SN14: an unterminated block-comment directive (no closing */, runs to EOF) does not fire", () => {
		const src = ["/* eslint-disable"];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN16: a backslash-escaped quote inside a string does not end the string early", () => {
		const src = [
			'const s = "a\\"/* eslint-disable */b";', // 1 — the directive text is inside the string
			...stmts(12, ""), // 2-13
			ENABLE, // 14 — no matching disable outside the string
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("SN15: an unterminated template literal (no closing backtick, runs to EOF) hides its content", () => {
		const bt = String.fromCharCode(96);
		const src = [
			"const doc = " + bt, // 1 — template opens, never closes
			DISABLE, // 2 (inside the unterminated template)
			...stmts(12, ""), // 3-14
			ENABLE, // 15 (inside the unterminated template)
		];
		expect(suppression(src)).toHaveLength(0);
	});
});
