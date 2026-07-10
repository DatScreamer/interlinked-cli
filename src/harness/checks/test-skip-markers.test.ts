// Tests for the polyglot skipped/disabled-test marker table.
// Positive: unconditional skips in all four languages. Negative: every
// conditional-skip idiom, string-literal fixtures, non-test files, caps.

import { describe, expect, it } from "vitest";
import { countSkippedTests, findSkipMarkers } from "./test-skip-markers.js";

describe("findSkipMarkers — positives (must fire)", () => {
	it("JS/TS: it.skip / xit / xdescribe in a test file", () => {
		const src = [
			"it.skip('flaky', () => {});",
			"xit('legacy', () => {});",
			"xdescribe('old suite', () => {});",
		].join("\n");
		const hits = findSkipMarkers(src, "src/foo.test.ts");
		expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
	});

	it("Python: @pytest.mark.skip and @unittest.skip decorators", () => {
		const src = [
			"@pytest.mark.skip(reason='broken')",
			"def test_a(): ...",
			"@unittest.skip('later')",
			"def test_b(): ...",
		].join("\n");
		expect(findSkipMarkers(src, "tests/test_foo.py").map((h) => h.line)).toEqual([1, 3]);
	});

	it("Rust: #[ignore] fires in ANY .rs file (no test-file naming convention)", () => {
		const src = ["#[test]", "#[ignore]", "fn slow_case() {}"].join("\n");
		expect(findSkipMarkers(src, "src/lib.rs").map((h) => h.line)).toEqual([2]);
	});

	it("Go: unguarded t.Skip / t.Skipf / t.SkipNow", () => {
		const src = [
			"func TestA(t *testing.T) {",
			"\tt.Skip(\"broken\")",
			"}",
		].join("\n");
		expect(findSkipMarkers(src, "pkg/foo_test.go").map((h) => h.line)).toEqual([2]);
	});

	it("countSkippedTests sums markers with the same rules", () => {
		const src = "it.skip('a', () => {});\ntest.skip('b', () => {});\n";
		expect(countSkippedTests(src, "src/foo.test.ts")).toBe(2);
	});
});

describe("findSkipMarkers — negatives (must NOT fire)", () => {
	it("Python conditional skips are exempt: skipif / skipIf / skipUnless", () => {
		const src = [
			"@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')",
			"def test_a(): ...",
			"@unittest.skipIf(missing_dep, 'no dep')",
			"def test_b(): ...",
			"@unittest.skipUnless(has_gpu, 'gpu only')",
			"def test_c(): ...",
		].join("\n");
		expect(findSkipMarkers(src, "tests/test_foo.py")).toEqual([]);
	});

	it("Rust cfg_attr conditional ignore is exempt", () => {
		const src = "#[cfg_attr(miri, ignore)]\nfn test_x() {}";
		expect(findSkipMarkers(src, "src/lib.rs")).toEqual([]);
	});

	it("Go t.Skip behind an if-guard (testing.Short idiom) is exempt", () => {
		const sameLine = "if testing.Short() { t.Skip(\"short mode\") }";
		expect(findSkipMarkers(sameLine, "pkg/foo_test.go")).toEqual([]);
		const prevLine = "if testing.Short() {\n\tt.Skip(\"short mode\")\n}";
		expect(findSkipMarkers(prevLine, "pkg/foo_test.go")).toEqual([]);
	});

	it("string-literal fixtures do not count (detector-source pattern)", () => {
		const src = "const fixture = \"it.skip('x', () => {})\";";
		expect(findSkipMarkers(src, "src/foo.test.ts")).toEqual([]);
	});

	it("non-test files are exempt for languages that require test files", () => {
		expect(findSkipMarkers("@pytest.mark.skip\ndef f(): ...", "src/app.py")).toEqual([]);
		expect(findSkipMarkers("t.Skip()", "pkg/main.go")).toEqual([]);
		expect(findSkipMarkers("it.skip('x', () => {});", "src/app.ts")).toEqual([]);
	});

	it("unknown extensions return empty", () => {
		expect(findSkipMarkers("it.skip('x')", "notes/readme.md")).toEqual([]);
	});

	it("caps at 15 markers per file", () => {
		const src = Array.from({ length: 20 }, (_, i) => `it.skip('c${i}', () => {});`).join("\n");
		expect(findSkipMarkers(src, "src/big.test.ts")).toHaveLength(15);
	});
});
