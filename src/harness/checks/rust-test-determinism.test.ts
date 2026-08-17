import { describe, expect, it } from "vitest";
import { checkRustTestDeterminism } from "./rust-test-determinism.js";

describe("checkRustTestDeterminism (rust_test_nondeterminism)", () => {
	it("P1: fires on thread_rng in a tests/ integration file (whole-file scope)", () => {
		const src = "fn setup() {\n    let mut r = rand::thread_rng();\n}\n";
		expect(checkRustTestDeterminism(src, "tests/integration.rs")).toHaveLength(1);
	});

	it("P2: fires on thread_rng / Uuid::new_v4 inside a #[cfg(test)] module", () => {
		const src = [
			"pub fn real() -> u32 { 42 }",
			"",
			"#[cfg(test)]",
			"mod tests {",
			"    #[test]",
			"    fn t() {",
			"        let r = thread_rng();",
			"        let id = Uuid::new_v4();",
			"    }",
			"}",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs").map((m) => m.line).sort((a, b) => a - b)).toEqual([7, 8]);
	});

	it("P3: fires on the fully-qualified uuid::Uuid::new_v4() form inside a tests/ file", () => {
		const src = "fn make_id() -> String {\n    uuid::Uuid::new_v4().to_string()\n}\n";
		expect(checkRustTestDeterminism(src, "tests/ids.rs")).toHaveLength(1);
	});

	it("does NOT fire on production thread_rng OUTSIDE the test module", () => {
		const src = [
			"pub fn shuffle(v: &mut Vec<u32>) {",
			"    let mut r = thread_rng();", // production — legitimate
			"    v.shuffle(&mut r);",
			"}",
			"#[cfg(test)]",
			"mod tests {",
			"    fn helper() { let x = 1; }",
			"}",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([]);
	});

	it("does NOT fire on non-.rs files or in comments", () => {
		expect(checkRustTestDeterminism("let r = thread_rng();", "src/lib.ts")).toEqual([]);
		expect(checkRustTestDeterminism("// thread_rng() was used here\n", "tests/a.rs")).toEqual([]);
	});

	it("does NOT fire on a Rust file with no test span at all", () => {
		expect(checkRustTestDeterminism("pub fn f() { let r = thread_rng(); }", "src/lib.rs")).toEqual([]);
	});
});

describe("checkRustTestDeterminism — mutation-kill campaign (W6 residual survivors)", () => {
	// test-contract: invariant — only .rs files are Rust source; a .txt file
	// under tests/ must never be scanned, regardless of directory name.
	it("M1: the .rs extension gate excludes non-.rs files even under a tests/ path", () => {
		expect(checkRustTestDeterminism("let r = thread_rng();\n", "tests/foo.txt")).toEqual([]);
	});

	// test-contract: boundary — the span's end line is inclusive; a violation
	// on the last line of the file must still be reported.
	it("M2: a nondeterminism call on the final line of a span is still scanned", () => {
		const src = "fn a() {}\nlet r = thread_rng();";
		expect(checkRustTestDeterminism(src, "tests/x.rs")).toEqual([{ line: 2, text: "let r = thread_rng();" }]);
	});

	// test-contract: boundary — the 10-match cap prevents unbounded output on
	// a pathological file; 12 real violations must still report exactly 10.
	it("M3: caps at 10 matches per file even when more violations are present", () => {
		const src = Array.from({ length: 12 }, () => "let r = thread_rng();").join("\n");
		expect(checkRustTestDeterminism(src, "tests/many.rs")).toHaveLength(10);
	});

	// test-contract: boundary — reported match text is capped at 150 chars so
	// one pathological line can't blow up warning output.
	it("M4: truncates a reported match's text to 150 characters", () => {
		const line = `let ${"a".repeat(200)} = thread_rng();`;
		const result = checkRustTestDeterminism(line, "tests/long.rs");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe(line.slice(0, 150));
		expect(result[0]?.text.length).toBe(150);
	});

	// test-contract: invariant — reported text is the trimmed statement, not
	// the raw indented source line.
	it("M5: trims leading whitespace from a reported match's text", () => {
		expect(checkRustTestDeterminism("    let r = thread_rng();", "tests/x.rs")).toEqual([
			{ line: 1, text: "let r = thread_rng();" },
		]);
	});

	// test-contract: invariant — rustfmt tolerates whitespace around call
	// parens; the detector must recognize thread_rng()/Uuid::new_v4() no
	// matter which internal gap carries the whitespace.
	it.each([
		["thread_rng ()", "space before ("],
		["thread_rng( )", "space inside ()"],
		["Uuid::new_v4 ()", "space before ( (uuid)"],
		["Uuid::new_v4( )", "space inside () (uuid)"],
	])("M6: recognizes %s (%s) as the nondeterminism call", (call) => {
		const src = `fn f() {\n    let r = ${call};\n}\n`;
		expect(checkRustTestDeterminism(src, "tests/spacing.rs")).toHaveLength(1);
	});

	// test-contract: invariant — rustfmt tolerates whitespace inside
	// #[cfg(test)]; the attribute detector must recognize it no matter which
	// internal gap carries the whitespace.
	it.each([
		["#[ cfg(test)]", "space after #["],
		["#[cfg (test)]", "space after cfg"],
		["#[cfg( test)]", "space after ("],
		["#[cfg(test )]", "space after test"],
		["#[cfg(test) ]", "space after )"],
	])("M7: recognizes the #[cfg(test)] attribute with %s (%s)", (attrLine) => {
		const src = [attrLine, "mod t {", "    fn x() { let r = thread_rng(); }", "}"].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([
			{ line: 3, text: "fn x() { let r = thread_rng(); }" },
		]);
	});

	// test-contract: boundary — filePath separators are normalized before the
	// tests/ check so a Windows-style path is not silently treated as
	// production code.
	it("M8: recognizes a tests/ directory on a backslash-separated (Windows-style) path", () => {
		const src = "fn f() {\n    let r = thread_rng();\n}\n";
		expect(checkRustTestDeterminism(src, "foo\\tests\\bar.rs")).toHaveLength(1);
	});

	// test-contract: invariant — an attribute with no discoverable mod block
	// must not fall back to scanning unrelated later code as if it were
	// test-scoped.
	it("M9: a #[cfg(test)] with no { within its lookahead window creates no span", () => {
		const src = [
			"#[cfg(test)]",
			"// no brace here",
			"// no brace here",
			"// no brace here",
			"fn later() { let r = thread_rng(); }",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([]);
	});

	// test-contract: boundary — a brace found at index 0 is a REAL match, not
	// "not found"; the span's end boundary must include the line it opened on.
	it("M10: a single-line #[cfg(test)] mod block is scanned", () => {
		const src = "#[cfg(test)] mod t { let r = thread_rng(); }";
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([
			{ line: 1, text: "#[cfg(test)] mod t { let r = thread_rng(); }" },
		]);
	});

	// test-contract: bug — a span's start line must be the attribute line
	// itself, not an earlier line, or legitimate production randomness right
	// before a test module gets misflagged.
	it("M11: production code immediately before the #[cfg(test)] attribute is excluded", () => {
		const src = ["pub fn shuffle() { let mut r = thread_rng(); }", "", "#[cfg(test)]", "mod tests {", "}"].join(
			"\n",
		);
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([]);
	});

	// test-contract: boundary — matchBrace returning "not found" must fail
	// OPEN (scan to end-of-file), not silently drop the rest of the file.
	it("M12: an unmatched (never-closing) #[cfg(test)] brace makes the span run to end-of-file", () => {
		const src = ["#[cfg(test)]", "mod tests {", "    // never closes", "", "    let r = thread_rng();"].join(
			"\n",
		);
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([{ line: 5, text: "let r = thread_rng();" }]);
	});

	// test-contract: boundary — end===0 (matched on the same line it opened)
	// is a REAL match, not "unmatched"; the outer scan must still advance to
	// and find the next #[cfg(test)] block.
	it("M13: a same-line-matched brace does not cause the scanner to skip a later #[cfg(test)] block", () => {
		const src = [
			"#[cfg(test)] mod empty {}",
			"",
			"#[cfg(test)]",
			"mod tests2 {",
			"    let r = thread_rng();",
			"}",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([{ line: 5, text: "let r = thread_rng();" }]);
	});

	// test-contract: boundary — the lookahead window is exactly 4 lines; a
	// brace on the 5th line must not be adopted as the module's opener.
	it("M14: a { found one line past the 4-line lookahead window is not the module's opening brace", () => {
		const src = ["#[cfg(test)]", "// c1", "// c2", "// c3", "mod tests { let r = thread_rng(); }"].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([]);
	});

	// test-contract: boundary — the lookahead window is bounded, not "search
	// the rest of the file"; a distant brace must not be adopted either.
	it("M15: a { found six lines past the attribute is not the module's opening brace", () => {
		const src = [
			"#[cfg(test)]",
			"// c1",
			"// c2",
			"// c3",
			"// c4",
			"// c5",
			"mod tests { let r = thread_rng(); }",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([]);
	});

	// test-contract: bug — findModuleOpenBrace must verify the line it
	// returns actually contains "{", not just return the first line checked.
	it("M16: the first checked line in the lookahead window must itself contain the brace", () => {
		const src = [
			"#[cfg(test)] }",
			"mod tests {",
			"    let r = thread_rng();",
			"}",
			"pub fn late() { let x = thread_rng(); }",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([{ line: 3, text: "let r = thread_rng();" }]);
	});

	// test-contract: bug — matchBrace must return the line where nesting DEPTH
	// returns to zero (the real outer close), not run past it; production
	// code after the mod block must stay excluded from the span.
	it("M17: the real (outermost) closing brace bounds the span", () => {
		const src = [
			"#[cfg(test)]",
			"mod tests {",
			"    fn t() { let r = thread_rng(); }",
			"}",
			"pub fn late_production() { let x = thread_rng(); }",
		].join("\n");
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([
			{ line: 3, text: "fn t() { let r = thread_rng(); }" },
		]);
	});

	// test-contract: bug — matchBrace tracks nesting DEPTH; it must not return
	// on the first "}" it sees (that closes the inner fn, not the outer mod)
	// or real test-scoped content after it gets silently excluded.
	it("M18: a nested inner block's closing brace does not end the span prematurely", () => {
		const src = ["#[cfg(test)]", "mod tests {", "    fn helper() { let x = 1; }", "    let r = thread_rng();", "}"].join(
			"\n",
		);
		expect(checkRustTestDeterminism(src, "src/lib.rs")).toEqual([{ line: 4, text: "let r = thread_rng();" }]);
	});

	// test-contract: bug — a line with idx===-1 (no "//" comment) must be
	// returned as-is; slicing it at -1 truncates the final character and can
	// break a match that ends right at the line's last char.
	it("M19: a line with no // comment is returned completely unmodified (not truncated)", () => {
		expect(checkRustTestDeterminism("let r = thread_rng()", "tests/x.rs")).toEqual([
			{ line: 1, text: "let r = thread_rng()" },
		]);
	});
});
