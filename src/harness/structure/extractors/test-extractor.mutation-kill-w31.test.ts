import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWalkBudget } from "./bounded-walk.js";
import { extract, metadata } from "./test-extractor.js";

// Mutation-kill wave 31 — src/harness/structure/extractors/test-extractor.ts
// Every case below is designed against a hand-traced pristine behavior; see
// receipts at scratch/fleet-r3/receipts/test-extractor.jsonl for the mutantId
// -> case mapping.

describe("test-extractor — mutation-kill w31", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "test-ext-w31-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — full node+edge shape pins provenance,
	// determinism_ceiling, localId strip regex, and inferTestedModule's ".test"
	// capture-replace all at once (module ref must keep the extension via "$1").
	it("classifies a.b.test.ts with exact node + edge shape", () => {
		writeFileSync(join(tmp, "a.b.test.ts"), "");
		const { nodes, edges } = extract(tmp);
		expect(nodes).toEqual([
			{
				id: "test:a.b.test",
				kind: "test",
				label: "a.b.test.ts",
				file: "a.b.test.ts",
				provenance: "inferred",
				determinism_ceiling: "heuristic",
			},
		]);
		expect(edges).toEqual([
			{
				id: "edge:test:a.b.test->module:a.b",
				kind: "tests",
				from: "test:a.b.test",
				to: "module:a.b",
				provenance: "inferred",
				confidence: 0.7,
			},
		]);
	});

	// test-contract: invariant — inferTestedModule's ".spec" capture-replace
	// must preserve the extension via "$1", not delete the whole match.
	it("classifies a.b.spec.ts with the correct tested-module ref", () => {
		writeFileSync(join(tmp, "a.b.spec.ts"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.to).toBe("module:a.b");
	});

	// test-contract: invariant — inferTestedModule's "_test.go" capture-replace.
	it("classifies a.b_test.go with the correct tested-module ref", () => {
		writeFileSync(join(tmp, "a.b_test.go"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.to).toBe("module:a.b");
	});

	// test-contract: invariant — inferTestedModule's "_test.py" capture-replace.
	it("classifies a.b_test.py with the correct tested-module ref", () => {
		writeFileSync(join(tmp, "a.b_test.py"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.to).toBe("module:a.b");
	});

	// test-contract: invariant — inferTestedModule's "^test_...py$" capture-replace
	// (whole string matched; "$1" must keep the captured remainder, not delete it).
	it("classifies test_a.b.py with the correct tested-module ref", () => {
		writeFileSync(join(tmp, "test_a.b.py"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.to).toBe("module:a.b");
	});

	// test-contract: boundary — a file under a test dir whose name matches none
	// of the strip patterns must yield NO tests-edge (stripped === base -> null).
	it("creates no tested-module edge for a non-matching name under __tests__", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "random.txt"), "");
		const { nodes, edges } = extract(tmp);
		expect(nodes).toHaveLength(1);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's ".test" regex must anchor at
	// the end; a mid-string ".test.ts" segment inside a longer name must NOT strip.
	it("does not infer a tested module when .test.ts is not at the name's end", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "foo.test.ts.txt"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's ".spec" regex must anchor at
	// the end; a mid-string ".spec.ts" segment inside a longer name must NOT strip.
	it("does not infer a tested module when .spec.ts is not at the name's end", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "foo.spec.ts.txt"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: invariant — inferTestedModule's ".spec" char class must
	// accept "t"/"j" (not exclude them) and its "x" must stay optional (.ts/.js valid).
	it("infers the tested module for foo.spec.ts (char class + optional x)", () => {
		writeFileSync(join(tmp, "foo.spec.ts"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
		expect(edges[0]?.to).toBe("module:foo");
	});

	// test-contract: boundary — inferTestedModule's "_test.go" regex must anchor at
	// the end; a mid-string "_test.go" segment inside a longer name must NOT strip.
	it("does not infer a tested module when _test.go is not at the name's end", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "foo_test.go.txt"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's "_test.py" regex must anchor at
	// the end; a mid-string "_test.py" segment inside a longer name must NOT strip.
	it("does not infer a tested module when _test.py is not at the name's end", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "foo_test.py.txt"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's "^test_(.*\.py)$" must require
	// the match reach the string's end; trailing junk after ".py" must block it.
	it("does not infer a tested module for test_a.py.bak (trailing junk after .py)", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "test_a.py.bak"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's "^test_...py$" must require the
	// "test_" prefix at the string's start, not merely present anywhere.
	it("does not infer a tested module for my_test_thing.py (test_ not at start)", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "my_test_thing.py"), "");
		const { edges } = extract(tmp);
		expect(edges).toEqual([]);
	});

	// test-contract: boundary — inferTestedModule's "^test_(.*\.py)$" capture group
	// must allow a multi-character stem, not just a single character.
	it("infers the tested module for test_ab.py under __tests__", () => {
		mkdirSync(join(tmp, "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "__tests__", "test_ab.py"), "");
		const { edges } = extract(tmp);
		expect(edges).toHaveLength(1);
	});

	// test-contract: boundary — the module-level TEST_PATTERNS ".test" entry must
	// anchor at the end; a mid-string match must not classify the file as a test.
	it("does not classify a top-level file whose .test.ts is mid-string", () => {
		writeFileSync(join(tmp, "gamma.test.ts.txt"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level TEST_PATTERNS ".spec" entry must
	// anchor at the end; a mid-string match must not classify the file as a test.
	it("does not classify a top-level file whose .spec.ts is mid-string", () => {
		writeFileSync(join(tmp, "gamma.spec.ts.txt"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level TEST_PATTERNS "_test.py$" entry
	// must anchor at the end; a mid-string match must not classify the file.
	it("does not classify a top-level file whose _test.py is mid-string", () => {
		writeFileSync(join(tmp, "foo_test.py.bak"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level TEST_PATTERNS "_test.go$" entry
	// must anchor at the end; a mid-string match must not classify the file.
	it("does not classify a top-level file whose _test.go is mid-string", () => {
		writeFileSync(join(tmp, "foo_test.go.bak"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level "^test_.*\.py$" entry must require
	// "test_" at the string's start.
	it("does not classify a top-level file where test_ is not at the start", () => {
		writeFileSync(join(tmp, "my_test_foo.py"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level "^test_.*\.py$" entry must require
	// the match reach the string's end.
	it("does not classify a top-level file with trailing junk after .py", () => {
		writeFileSync(join(tmp, "test_foo.py.bak"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: boundary — the module-level "^test_.*\.py$" entry's middle
	// must allow a multi-character stem, not just one character.
	it("classifies a top-level test_ab.py as a test file", () => {
		writeFileSync(join(tmp, "test_ab.py"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
	});

	// test-contract: boundary — TEST_DIRS must include the plural "tests" dirname.
	it("treats a `tests/` (plural) directory as a test location", () => {
		mkdirSync(join(tmp, "tests"), { recursive: true });
		writeFileSync(join(tmp, "tests", "foo.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
	});

	// test-contract: boundary — TEST_DIRS must include the singular "test" dirname.
	it("treats a `test/` (singular) directory as a test location", () => {
		mkdirSync(join(tmp, "test"), { recursive: true });
		writeFileSync(join(tmp, "test", "foo.ts"), "");
		const { nodes } = extract(tmp);
		expect(nodes).toHaveLength(1);
	});

	// test-contract: invariant — pins the full supported_patterns array
	// (covers the array literal and every one of its 7 string entries).
	it("exposes the exact supported_patterns list", () => {
		expect(metadata.supported_patterns).toEqual([
			"*.test.ts",
			"*.spec.ts",
			"*.test.js",
			"*.spec.js",
			"*_test.go",
			"*_test.py",
			"test_*.py",
		]);
	});

	// test-contract: invariant — a dangling symlink is neither isDirectory() nor
	// isFile() and must be skipped by walkDir, not treated as a file.
	it("skips a symlink entry instead of classifying it as a file", () => {
		symlinkSync(join(tmp, "does-not-exist-target"), join(tmp, "link.test.ts"));
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	// test-contract: invariant — the truncation warning must fire ONLY when the
	// walk actually truncated, not unconditionally.
	it("does not warn when the walk did not truncate", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		writeFileSync(join(tmp, "a.test.ts"), "");
		extract(tmp);
		expect(errSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});

	// test-contract: invariant — the truncation warning must fire when the walk
	// budget was already marked truncated, not be unconditionally suppressed, and
	// must name this extractor + the walked root in its message.
	it("warns when the supplied budget is already truncated", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const budget = createWalkBudget();
		budget.truncated = true;
		extract(tmp, budget);
		expect(errSpy.mock.calls).toEqual([[expect.stringContaining(`${metadata.name} walk hit the hard cap`)]]);
		expect(errSpy.mock.calls[0]?.[0]).toContain(tmp);
		errSpy.mockRestore();
	});
});
