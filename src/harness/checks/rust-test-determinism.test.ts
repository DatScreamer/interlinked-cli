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
