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

// ─── targeted mutation-kill coverage ───────────────────────────────────────────
//
// Each test below pins one or more specific mutation-testing survivors (Stryker
// operator mutants against the real detector source) by constructing a fixture
// where the mutated behavior produces a DIFFERENT observable result than the
// real implementation — verified by hand-tracing the mutated code path, not by
// argument from "this looks equivalent". Grouped by target function; the
// comment on each test names the code-level change it distinguishes.

describe("checkRustUnsafeSpan — blankRustBlockComment mutation coverage", () => {
	it("MK-BC1: a single non-nested block comment before a wide unsafe block still lets it fire", () => {
		// Pins: the scan must start at `start + 2` (right after "/*", not before
		// it) and must correctly detect the real "*/" as *the* close (not miss
		// it, not require an extra one, not flip the *increment* direction on
		// either side of the pairing). Any of those defects makes the comment
		// swallow the whole rest of the file, hiding the block below it.
		const src = ["/* header */", "unsafe {", ...stmts(6, "    "), "}"];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("MK-BC2: a lone unpaired `/` inside a comment body does not falsely open a nested level", () => {
		// Pins: opening detection must require BOTH "/" at i AND "*" at i+1
		// (not either alone) — a stray "/" with no "*" after it must not count.
		const src = ["/* path a/b end */", "unsafe {", ...stmts(6, "    "), "}"];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("MK-BC3: a lone unpaired `*` inside a comment body does not falsely open a nested level", () => {
		// Pins: opening detection's "*" operand is checked at i+1 against the
		// CURRENT char being "/", not decoupled from it.
		const src = ["/* a*b */", "unsafe {", ...stmts(6, "    "), "}"];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("MK-BC4: a genuinely 2-level-nested comment closes after exactly two real closes", () => {
		// Pins: depth increments (not decrements) on a real nested open, so a
		// 2-level nest needs exactly 2 real "*/" to close — not 1, not 3.
		const src = ["/* outer /* inner */ still-outer */", "unsafe {", ...stmts(6, "    "), "}"];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("MK-BC5: a nested comment's inner /* must be detected, or the outer comment closes too early and leaks code", () => {
		// Pins: the opening check actually inspects individual characters
		// (not the whole remaining buffer) — if inner "/*" opens are never
		// detected, the FIRST "*/" (the inner one) wrongly ends the whole
		// comment, exposing the "unsafe {" that should still be commented out.
		const src = [
			"/* outer",
			"   /* inner */",
			"   unsafe {",
			...stmts(6, "       "),
			"   }",
			"   still outer */",
			"fn done() {}",
		];
		expect(rust(src, "crates/core/src/nest.rs")).toHaveLength(0);
	});

	it("MK-BC6: a lone unpaired `*` inside a comment body must not close it early and leak code", () => {
		// Pins: closing detection's "/" operand at i+1 is checked, not
		// inverted and not decoupled — a bare "*" with a non-"/" neighbor
		// must not end the comment.
		const src = [
			"/* note: 2*3=6",
			"   unsafe {",
			...stmts(6, "       "),
			"   }",
			"   end of note */",
			"fn done() {}",
		];
		expect(rust(src, "crates/core/src/note.rs")).toHaveLength(0);
	});
});

describe("checkRustUnsafeSpan — additional mutation coverage", () => {
	it("MK-CR1: reported excerpt is the real source line, sliced/trimmed, not a corrupted read", () => {
		// Pins rawLineExcerpt end-to-end: correct line index (lineNo - 1, not
		// +1), the fallback-to-"" only on a genuinely missing line, .trim(),
		// and the final excerpt is not simply dropped (BlockStatement -> {}).
		const src = [
			"fn init(p: *mut u8) {",
			"    unsafe {",
			...stmts(6, "        "),
			"    }",
			"}",
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/— unsafe \{$/);
	});

	it("MK-CR2: a span of exactly 5 reached via the real nonblank count (not the cheap skip check) still does not fire", () => {
		// Pins the DECISIVE `span <= MAX_UNSAFE_SPAN_LINES` check (not the
		// earlier total-line skip heuristic, which this fixture deliberately
		// routes around: 7 total interior lines but only 5 nonblank).
		const src = [
			"fn f(p: *mut u8) {",
			"    unsafe {",
			"        a();",
			"", // blank
			"        // comment",
			"        b();",
			"        c();",
			"        d();",
			"        e();",
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});

	it("MK-CR3: a long same-line excerpt is truncated to exactly REPORT_LINE_TRUNC and still trimmed", () => {
		// Pins the .trim().slice(0, 150) chain — removing either the trim or
		// the slice changes the excerpt's length or leading whitespace.
		const long = "x".repeat(200);
		const src = [
			"fn f(p: *mut u8) {",
			`    unsafe { // ${long}`,
			...stmts(6, "        "),
			"    }",
			"}",
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		const excerpt = found[0]?.text.split(" — ").pop() ?? "";
		expect(excerpt).toHaveLength(150);
		expect(excerpt.startsWith("unsafe")).toBe(true);
	});
});

describe("checkSuppressionSpan — countNewlines / line-tracking mutation coverage", () => {
	it("MK-CN1: a multi-line comment before a disable is counted so the disable's reported line is exact", () => {
		// Pins countNewlines: if it always returns 0 (or otherwise fails to
		// count real newlines skipped inside a consumed block comment), the
		// running `line` counter under-shoots and every directive after it
		// reports the wrong line number.
		const src = [
			"/* a multi-line",
			"   regular comment",
			"   spanning lines */",
			DISABLE,
			...stmts(12, ""),
			ENABLE,
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});

describe("checkSuppressionSpan — raw excerpt integrity", () => {
	it("MK-CS1: the reported excerpt is the actual disable-comment source text", () => {
		// Pins `rawLines = content.split("\n")` — splitting on "" instead
		// would make every excerpt an unrelated single character.
		const src = [DISABLE, ...stmts(13, ""), ENABLE];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text.endsWith(`— ${DISABLE}`)).toBe(true);
	});
});

describe("checkSuppressionSpan — widestBoundedSpan mutation coverage", () => {
	it("MK-WBS1: a wide first rule-span survives a narrower later rule-span (widest, not last)", () => {
		// Pins `span > widest` picking the MAXIMUM across all of a multi-rule
		// disable's targets — not unconditionally overwriting on every
		// iteration and not stopping after the first.
		const src = [
			"/* eslint-disable no-console, no-undef */", // 1
			"a();", // 2
			"/* eslint-enable no-undef */", // 3 — closes no-undef narrow (span 3)
			...stmts(20, ""), // 4-23
			"/* eslint-enable no-console */", // 24 — closes no-console wide (span 24)
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 24 lines");
	});

	it("MK-WBS2: a narrow first rule-span is overtaken by a wider later rule-span (widest, not first)", () => {
		// Pins the same comparison from the opposite ordering — a detector
		// that only ever keeps the FIRST processed rule's span (e.g. an
		// `&&` in place of `||`, or the comparison forced to `false`) passes
		// MK-WBS1 by accident but fails here.
		const src = [
			"/* eslint-disable no-undef, no-console */", // 1
			"a();", // 2
			"/* eslint-enable no-undef */", // 3 — closes no-undef narrow (span 3)
			...stmts(20, ""), // 4-23
			"/* eslint-enable no-console */", // 24 — closes no-console wide (span 24)
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 24 lines");
	});
});

describe("checkSuppressionSpan — isQuoteChar mutation coverage", () => {
	it("MK-IQ1: eslint-disable text inside a single-quoted string is not detected as a real directive", () => {
		// Pins the single-quote arm of isQuoteChar specifically (the fixture
		// also carries a double-quoted string elsewhere in the suite, so this
		// isolates "'" from '"' and "`"). If single quotes stop being
		// recognized as string delimiters, the text inside becomes real scan
		// territory and the block-comment branch (which always outranks the
		// quote check) picks up the disable directive for real.
		const src = [
			"const s = '/* eslint-disable */';", // 1 — single-quoted, must stay opaque
			...stmts(12, ""), // 2-13
			"/* eslint-enable */", // 14 — a real, unrelated enable
		];
		expect(suppression(src)).toHaveLength(0);
	});
});

// ─── round 2: blankRustCharLiteral / rawStringOpenAt mutation-kill coverage ───
//
// Both helpers are internal (not exported); every fixture below drives them
// through checkRustUnsafeSpan and distinguishes real vs. mutated behavior by
// an OBSERVABLE consequence — normally whether a `}` embedded in what should
// be stripped comment/string/char-literal content leaks through as a REAL
// brace. A leaked `}` closes the `unsafe {` early (block too narrow, 0
// findings, or a different span); correctly-hidden content lets the block
// reach its real closing brace several lines down (fires with the expected
// span). Each comment traces the specific mutant(s) the fixture kills.

describe("checkRustUnsafeSpan — blankRustCharLiteral mutation coverage (round 2)", () => {
	it("MK-CL1: an escaped literal hiding an embedded quote ('\\\"') must be blanked as ONE unit, not abandoned mid-scan", () => {
		// Pins the entire escape-handling path together: `next === "\\"` must
		// read the REAL next char (not `src` itself, not `charAt(start - 1)`),
		// the scan loop must start at `start + 3`, run `i < src.length` (not
		// `<=`/`>=`/forced-false/forced-true), advance with `i++` (not `i--`),
		// detect the close via `ch === "'"` (not `false`, not a `src`-wide
		// compare), and blank through `i + 1` (not `i - 1`). If ANY of those
		// break, the loop exits without blanking, the embedded `"` inside the
		// escape body is left for the main scanner, which misreads it as
		// opening a REAL string with no other closing quote anywhere in the
		// file — swallowing everything after it, including the block's real
		// closing braces, so the block never resolves and the check reports
		// nothing at all.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			'        let c = \'\\"\';', // 3 — escaped-quote char literal
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

	it("MK-CL2: an escape body containing a real `}` before its closing quote must be scanned char-by-char, not abandoned on the first non-newline char", () => {
		// Pins the loop's `if (ch === "\n") break` check against a false
		// positive: if it fires on ANY non-newline char (not just a real
		// newline), the scan aborts before reaching the true closing quote,
		// leaving the `}` inside the escape body unblanked — a real brace
		// that closes the unsafe block right there instead of several lines
		// down.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let c = '\\u}';", // 3 — multi-char escape body containing `}`
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

	it("MK-CL3: an unterminated escape must stop at the NEXT REAL newline, not scan on into later lines for a stray apostrophe", () => {
		// Pins `ch === "\n"` positively: if the break never fires (forced
		// `false`, or compared against `""` instead of an actual newline
		// character), the scan keeps running past the line boundary and
		// wrongly pairs the dangling `'\` with an unrelated lifetime
		// apostrophe several lines later — blanking everything between as
		// fake char-literal content and hiding real code (and the real
		// nonblank line count) from the span counter.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let bad = '\\", // 3 — escape opens, no closing quote on this line
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        let l: &'a str = v;", // 8 — real lifetime apostrophe further down
			"        x5();", // 9
			"    }", // 10
			"}", // 11
		];
		const found = rust(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 7 nonblank lines");
	});

	it("MK-CL4: charAt(start+2) not equal to a quote means only the opening apostrophe is consumed, leaving real code (incl. `}`) intact", () => {
		// Pins the non-escape branch's decisive check: `next !== "" && next
		// !== "'" && charAt(start + 2) === "'"`. A lifetime marker like `'a`
		// is exactly two chars short of a 3-char literal, so the real
		// function must leave the trailing `}` as genuine code — closing the
		// unsafe block right there. If the whole condition (or its `charAt
		// (start+2) === "'"` clause) is forced `true`, the apostrophe and the
		// next two chars get wrongly blanked, hiding the `}` and letting the
		// block run on to its real close several lines down.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let x: &'a}b;", // 3 — 'a is a lifetime, not a 3-char literal; `}` is real
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		expect(rust(src)).toHaveLength(0);
	});
});

describe("checkRustUnsafeSpan — rawStringOpenAt mutation coverage (round 2)", () => {
	it("RSO1: a hash-delimited raw string with an embedded bare quote must close ONLY at its matching `\"#`, hiding a `}` before it", () => {
		// Pins the whole r#"…"# detection chain from a non-identifier
		// position: the leading-context guard must NOT block here (prev char
		// is a space), the `b`/`c` prefix check must correctly skip (this is
		// bare `r`), the mandatory `charAt(j) !== "r"` check must pass, the
		// `#` counting loop must count exactly 1 hash, and the final quote
		// check must confirm the opener. If any step instead returns null
		// (guard forced to always block, the r-check inverted, the hash loop
		// skipped or its update reversed, or the final quote-check inverted),
		// the raw string is never recognized: the main scanner falls back to
		// treating the LONE embedded `"` inside the raw body as an ordinary
		// string open, which closes at the FIRST bare quote it finds — right
		// after the embedded `"a"`, exposing the `}` right after it as real
		// code that closes the unsafe block early.
		const src = [
			"fn f() {", // 1
			'    unsafe {', // 2
			'        let s = r#"a"b}c"#;', // 3 — 1-hash raw string, embedded bare quote + `}`
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src, "crates/core/src/gen2.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RSO2: an identifier ending in 'r' immediately before a hash-quote must NOT be treated as a raw-string opener", () => {
		// Pins the leading-context guard from the OTHER direction: `foor#"`
		// is the identifier "foor" followed by an unrelated raw-looking
		// sequence — the char before this 'r' is 'o' (alnum), so the guard
		// MUST block detection here, and the real closing `}` right after
		// the embedded bare quote stays live code, closing the block early.
		// If the guard fails to block (forced `false`, the `&&` flipped to
		// `||`, `i - 1` flipped to `i + 1`, `i > 0` flipped to `i <= 0`, or
		// `charAt(i - 1)` swapped for the whole `src` string), the sequence
		// gets wrongly accepted as a real raw-string opener, which correctly
		// hides the `}` and lets the block run on to its real close.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        let foor#"a"b}c"#;', // 3 — "foor" + unrelated hash-quote text
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		expect(rust(src, "crates/core/src/gen3.rs")).toHaveLength(0);
	});

	it("RSO3: a byte raw string (br#\"...\"#) must consume its 'b' prefix before requiring 'r'", () => {
		// Pins the `charAt(j) === "b" || charAt(j) === "c"` branch (and its
		// `j++` advance) specifically for 'b'. If the check is forced
		// `false`, its `||` flipped to `&&`, or its `charAt(j)`/`"b"` operands
		// swapped for something that never matches, `j` never advances past
		// 'b' and the mandatory `charAt(j) !== "r"` check then sees 'b'
		// itself and fails — returning null and falling back to plain-string
		// parsing, which closes at the first bare quote and exposes the `}`.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        let s = br#"a"b}c"#;', // 3
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		const found = rust(src, "crates/core/src/gen4.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RSO4: a C raw string (cr#\"...\"#) must consume its 'c' prefix before requiring 'r'", () => {
		// Pins the same branch's 'c' arm, distinctly from RSO3's 'b' arm —
		// Stryker mutates each `charAt(j) === "b"` / `charAt(j) === "c"`
		// comparison as its own node, so both prefixes need their own case.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        let s = cr#"a"b}c"#;', // 3
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		const found = rust(src, "crates/core/src/gen5.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RSO5: a byte string with NO 'r' (b\"\") must be rejected by the mandatory r-check, not treated as a 0-hash raw string", () => {
		// Pins `charAt(j) !== "r"` positively: `b""` is a real (non-raw) byte
		// string — after consuming 'b', the next char is `"`, which must fail
		// the r-check and return null so the plain-string handler takes over
		// and blanks just the pair of quotes. If the check is forced `false`
		// (always "proceed as if it were r"), the function instead computes a
		// bogus 0-hash raw-string opener and searches for a lone closing `"`
		// starting AFTER the `""` pair — finding none anywhere in the file,
		// it blanks everything to EOF, hiding the block's real closing
		// braces entirely.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        let x = b"";', // 3
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		const found = rust(src, "crates/core/src/gen6.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RSO7: a wrong opener length must not let the search start land ON the opener's own quote, false-matching a `\"#` shaped sequence right after it", () => {
		// Pins the openLen computation `j + 1 - i` end-to-end. If openLen were
		// computed 1 short, blankRustRawString's search would start AT the
		// opener's own closing quote (itself a `"`), and since the very next
		// content char here is `#`, that position would false-match the 1-hash
		// closer immediately — leaving everything from `abc}def"#` on as REAL
		// unblanked code, exposing the `}` and closing the block early.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			'        let s = r#"#abc}def"#;', // 3 — content starts with `#`
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src, "crates/core/src/gen8.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	it("RSO6: 'r' followed by hashes with NO quote (r#x) must be rejected, not accepted as a real raw-string opener", () => {
		// Pins the final `charAt(j) !== '"'` check (and its equality-flip /
		// `charAt` -> `src` / `'"'` -> `''` variants): `r#x` has no opening
		// quote after its hash, so this must return null and leave `r#x` as
		// harmless literal code. If forced to proceed anyway, the function
		// returns a bogus opener with hashes = 1 and searches for a `"#`
		// closer that does not exist anywhere in the file, blanking
		// everything to EOF and hiding the block's real closing braces.
		const src = [
			"fn f() {", // 1
			"    unsafe {", // 2
			"        let v = r#x;", // 3
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		const found = rust(src, "crates/core/src/gen7.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});
});

// ─── round 3: fleet mutation-kill sweep (2026-08-10) ──────────────────────────

describe("checkRustUnsafeSpan — blankRustString escape-handling mutation coverage", () => {
	it("RP15: an escape sequence must advance the scan FORWARD past both chars, not backward — otherwise the opening quote itself gets misread as the close", () => {
		// Pins the `i += 2` direction in blankRustString. If the escape branch
		// ever moved `i` BACKWARD, the scan would re-visit the string's own
		// opening quote and misread it as an immediate close, leaving
		// everything after (including the embedded `}`) as real unblanked
		// code — closing the unsafe block far too early.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			'        let s = "a\\b}";', // 3 — escape + a `}` later in the string body
			"        x1();", // 4
			"        x2();", // 5
			"        x3();", // 6
			"        x4();", // 7
			"        x5();", // 8
			"    }", // 9
			"}", // 10
		];
		const found = rust(src, "crates/core/src/esc.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});
});

describe("checkRustUnsafeSpan — blankRustCharLiteral non-escape-branch clause coverage", () => {
	it("MK-CL5: an empty char literal ('') keeps the trailing `}` live — the 3-char-literal clause must not misfire when the second char IS the closing quote", () => {
		// Pins the `next !== "'"` clause of the non-escape branch. `''` is not
		// a real 1-char literal (Rust doesn't allow it), so `charAt(start+2)`
		// lands on whatever comes after — here a real `}`. If the clause were
		// forced true (or the operator flipped), the apostrophe pair plus the
		// next char would get wrongly blanked, hiding the `}` and letting the
		// block run on further than it should.
		const src = [
			"fn f(p: *mut u8) {", // 1
			"    unsafe {", // 2
			"        let x = ''}b;", // 3 — '' then a real `}`, not a 3-char literal
			"        x1();",
			"        x2();",
			"        x3();",
			"        x4();",
			"        x5();",
			"    }",
			"}",
		];
		expect(rust(src, "crates/core/src/emptylit.rs")).toHaveLength(0);
	});
});

describe("checkSuppressionSpan — DIRECTIVE_BODY_RE mutation coverage", () => {
	it("RS-DIR1: a mid-comment PROSE mention of 'eslint-disable' (not at the body start) is not a real directive", () => {
		// Pins the leading `^` anchor: without it, the pattern could match
		// anywhere in the body instead of only at its start.
		const src = [
			"/* note: consider eslint-disable for this section */", // 1 — prose, not a directive
			...stmts(12, ""), // 2-13
			ENABLE, // 14 — a real bare enable, with nothing real to pair with
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("RS-DIR2: zero whitespace before 'eslint-disable' (/*eslint-disable*/) is still a valid directive", () => {
		// Pins `\s*` (zero-or-more) against a narrowing to `\s` (exactly one):
		// a comment with NO space between the delimiter and the keyword must
		// still be recognized.
		const src = [
			"/*eslint-disable*/", // 1 — no leading space
			...stmts(12, ""), // 2-13
			ENABLE, // 14
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});

describe("checkSuppressionSpan — parseRuleList split-marker regex mutation coverage", () => {
	it("RS-PL1: a `--` with NO whitespace before it is not a justification split — the whole tail is one rule name", () => {
		// Pins the `\s` clause immediately before `--`. A rule name that
		// happens to CONTAIN "--" with no preceding space must not be split.
		const src = [
			"/* eslint-disable no-console-- reason */", // 1 — 'e' immediately before "--"
			...stmts(12, ""), // 2-13
			ENABLE_NO_CONSOLE, // 14 — targets "no-console", NOT the real (unsplit) rule name
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("RS-PL2: a `--` at the very end of the tail (no trailing char) still splits via the end-of-string alternative", () => {
		// Pins the `$` branch of `(?:\s|$)`. Removing it would leave the
		// trailing " --" attached to the rule name.
		const src = [
			"/* eslint-disable no-console --*/", // 1 — "--" is the last text before the delimiter
			...stmts(12, ""), // 2-13
			ENABLE_NO_CONSOLE, // 14
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});

	it("RS-PL3: a `--` followed by a real whitespace char (not end-of-string) still splits via the whitespace alternative", () => {
		// Pins the `\s` branch of `(?:\s|$)` specifically (as opposed to a
		// non-whitespace char following, which must NOT split).
		const src = [
			"/* eslint-disable no-console -- because reasons */", // 1
			...stmts(12, ""), // 2-13
			ENABLE_NO_CONSOLE, // 14
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});

describe("checkSuppressionSpan — parseRuleList empty-entry filter mutation coverage", () => {
	it("RS-FILT1: a trailing-comma empty rule entry must be filtered out, not survive as a phantom '' target", () => {
		// Pins the `.filter((rule) => rule !== "")` call. If the filter were
		// removed (or its predicate neutered), a disable with a trailing
		// comma would carry a stray "" rule; that stray "" would then
		// spuriously MATCH an unrelated enable that ALSO has its own
		// trailing-comma "" artifact, even though neither directive shares a
		// real rule name — producing a finding where none should exist.
		const src = [
			"/* eslint-disable no-console, */", // 1 — trailing comma
			...stmts(12, ""), // 2-13
			"/* eslint-enable no-undef, */", // 14 — unrelated rule, also trailing comma
		];
		expect(suppression(src)).toHaveLength(0);
	});
});

describe("checkSuppressionSpan — consumeBlockComment unterminated-at-EOF mutation coverage", () => {
	it("RS-EOF1: an unterminated block-form enable at true EOF must use the WHOLE remaining text as its body, not one character short", () => {
		// Pins `bodyEnd = close === -1 ? content.length : close` and the
		// paired resume-offset computation. If either used `close` itself
		// (-1) instead of `content.length` for the unterminated case, the
		// computed body would drop the file's FINAL character — here, the
		// last letter of the rule name — corrupting the parsed rule from
		// "my-rule" to "my-rul", which then fails to match the enable this
		// disable is genuinely waiting for.
		const src = [
			"/* eslint-disable my-rule */", // 1
			...stmts(12, ""), // 2-13
			"/* eslint-enable my-rule", // 14 — unterminated: no closing */, ends at true EOF
		].join("\n");
		const found = suppression(src.split("\n"));
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});

describe("checkSuppressionSpan — isQuoteChar backtick-clause mutation coverage", () => {
	it("RS-QUOTE1: a backtick-delimited template containing directive text stays opaque even with no other quote types nearby", () => {
		// Isolates the "`" arm of isQuoteChar from "'" and '"' (both already
		// covered elsewhere) by using ONLY a backtick-quoted string. Uses the
		// file's hoisted DISABLE/ENABLE constants (not an inline literal) so
		// this test body itself never contains raw directive-shaped text.
		const bt = String.fromCharCode(96);
		const src = [
			"const s = " + bt + DISABLE + bt + ";", // 1 — directive text inside a template
			...stmts(12, ""), // 2-13
			ENABLE, // 14 — a real, unrelated enable
		];
		expect(suppression(src)).toHaveLength(0);
	});
});

describe("checkSuppressionSpan — skipStringLiteral resumption mutation coverage", () => {
	it("RS-RESUME1: a short well-terminated string literal must not swallow the rest of the file — scanning resumes right after it", () => {
		// Pins that skipStringLiteral's loop body actually RUNS (as opposed
		// to being replaced with an empty block, or its test forced to
		// `false`/an inverted boundary) — any of those defects makes the
		// function always return content.length, silently discarding every
		// directive that follows any plain string literal in the file.
		const src = [
			'const s = "hello";', // 1 — plain terminated string, unrelated to directives
			DISABLE, // 2
			...stmts(12, ""), // 3-14
			ENABLE, // 15
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});

describe("checkSuppressionSpan — main-loop and findEnableLineFor guard mutation coverage", () => {
	it("RS-MAIN1: two bare enables with no disable at all must never pair with each other", () => {
		// Pins the `disable.kind !== "disable"` guard. If it were disabled,
		// the FIRST enable would be processed as though it were a disable,
		// and its own (bare) rule-set would spuriously pair with the SECOND
		// enable via findEnableLineFor's `d.kind === "enable"` check.
		const src = [
			ENABLE, // 1 — bare enable, no preceding disable
			...stmts(12, ""), // 2-13
			ENABLE, // 14 — another bare enable, far below
		];
		expect(suppression(src)).toHaveLength(0);
	});

	it("RS-FEL1: an enable is only ever searched for AFTER the disable's own index — a rule-matching enable earlier in the file must not pair", () => {
		// Pins the `fromIdx + 1` starting point of findEnableLineFor's scan
		// (and its guard's short-circuit order): an enable that appears
		// BEFORE the disable in question must never close it, even when the
		// rule names line up exactly.
		const src = [
			ENABLE_NO_CONSOLE, // 1 — precedes the disable; must not pair with it
			...stmts(12, ""), // 2-13
			DISABLE_NO_CONSOLE, // 14 — nothing valid follows this one
		];
		expect(suppression(src)).toHaveLength(0);
	});
});

describe("checkSuppressionSpan — skipStringLiteral quote-close mutation coverage", () => {
	it("RS-SL1: a real directive immediately after a same-line string literal is still detected — the string must stop at its OWN closing quote", () => {
		// Pins `if (ch === quote) return i + 1;`. If the closing-quote check
		// never fires, the "string skip" runs on past its own close looking
		// for a newline instead, swallowing a real directive that follows
		// later on the SAME line — here, DISABLE right after the string.
		const src = [
			'const s = "abc"; ' + DISABLE, // 1 — string, then a real directive, same line
			...stmts(12, ""), // 2-13
			ENABLE, // 14
		];
		const found = suppression(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("spans 14 lines");
	});
});
