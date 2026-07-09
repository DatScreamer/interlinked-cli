// Colocated red/green tests for the public surface of `ubs-language-specific.ts`.
// The full test surface lives in `src/harness/__tests__/ubs-*.test.ts`; this
// file exists to satisfy the colocation gate while remaining a useful smoke
// signal that the two functions exist and respect the language gate.

import { describe, expect, it } from "vitest";
import {
	checkDivisionByVariable,
	checkJavaOptionalGet,
	checkRustDebugAssertSideEffects,
} from "./ubs-language-specific.js";

describe("ubs-language-specific (smoke)", () => {
	it("checkJavaOptionalGet flags Optional<T>....get() in a Java file", () => {
		const code = "Optional<String> x = svc.find(); return x.get();";
		expect(checkJavaOptionalGet(code, "Sample.java").length).toBeGreaterThan(0);
	});

	it("checkJavaOptionalGet returns empty for non-Java files", () => {
		const code = "Optional<string> x = svc.find(); return x.get();";
		expect(checkJavaOptionalGet(code, "sample.ts")).toEqual([]);
	});

	it("checkDivisionByVariable flags `a / b`", () => {
		expect(checkDivisionByVariable("const r = a / b;", "calc.ts").length).toBeGreaterThan(0);
	});

	it("checkDivisionByVariable does not flag division by a numeric literal", () => {
		expect(checkDivisionByVariable("const r = a / 2;", "calc.ts")).toEqual([]);
	});

	it("checkRustDebugAssertSideEffects flags fallible mutating work inside debug_assert", () => {
		const code = [
			"fn refresh(dev: &mut Dev) -> Result<()> {",
			"    debug_assert!(dev.client_graph.insert_stale(&dev.import_source, false)? == react_refresh_index);",
			"    Ok(())",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "src/dev.rs")).toEqual([
			{
				line: 2,
				text: "debug_assert!(dev.client_graph.insert_stale(&dev.import_source, false)? == react_refresh_index);",
			},
		]);
	});

	it("checkRustDebugAssertSideEffects flags mutating calls in debug_assert_eq", () => {
		const code = "fn f(queue: &mut Vec<u8>) { debug_assert_eq!(queue.pop(), Some(1)); }";
		expect(checkRustDebugAssertSideEffects(code, "src/queue.rs").length).toBe(1);
	});

	it("checkRustDebugAssertSideEffects ignores ordinary predicate-only assertions", () => {
		const code = [
			"fn f(items: &[u8], state: State) {",
			"    debug_assert!(items.is_empty());",
			"    debug_assert!(path.starts_with(\"/\"));",
			"    debug_assert!(cfg.settings().len() > 0);",
			"    debug_assert!(slot.taken().is_none());",
			"    debug_assert!(out.writer().is_ok());",
			"    debug_assert!(conn.closed());",
			"    debug_assert!(file.opened());",
			"    debug_assert!(event.created_at().is_some());",
			"    debug_assert!(queue.popped());",
			"    debug_assert!(matches!(state, State::Ready));",
			"}",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "src/predicate.rs")).toEqual([]);
	});

	it("checkRustDebugAssertSideEffects ignores comments, strings, non-Rust files, and tests", () => {
		const code = [
			"// debug_assert!(queue.pop());",
			"const MSG: &str = \"debug_assert!(queue.pop())\";",
			"fn f(queue: &mut Vec<u8>) { debug_assert!(queue.pop().is_some()); }",
		].join("\n");
		expect(checkRustDebugAssertSideEffects(code, "src/main.rs")).toEqual([
			{
				line: 3,
				text: "fn f(queue: &mut Vec<u8>) { debug_assert!(queue.pop().is_some()); }",
			},
		]);
		expect(checkRustDebugAssertSideEffects(code, "src/main.ts")).toEqual([]);
		expect(checkRustDebugAssertSideEffects(code, "project/tests/main.rs")).toEqual([]);
	});

	// Regression: markdown table separators like `▲/▼/○` and prose alternation
	// like `staged / modified / clean` are bilateral-id-shaped and would fire
	// the regex if not gated by the source-extension allow-list. Doc edits
	// repeatedly tripped this during the statusline redesign before the gate
	// was confirmed.
	it("checkDivisionByVariable skips markdown files even with division-looking content", () => {
		const tableContent =
			"| `▲/▼/○` glyph | source | (none) | Up / stale / not-installed |";
		expect(checkDivisionByVariable(tableContent, "docs/design/foo.md")).toEqual([]);
		expect(checkDivisionByVariable(tableContent, "README.mdx")).toEqual([]);
	});

	it("checkDivisionByVariable skips plain-text and unknown extensions", () => {
		const prose = "states: pending / in_progress / completed";
		expect(checkDivisionByVariable(prose, "notes.txt")).toEqual([]);
		expect(checkDivisionByVariable(prose, "config.yaml")).toEqual([]);
		expect(checkDivisionByVariable(prose, "/tmp/no-extension")).toEqual([]);
	});

	// FP refinement (139-repo audit, 2026-05): zero-guard + Path-join
	// detection. Supermodel mcpbr/analytics/ab_testing.py had 165 hits
	// — most with explicit `... if x > 0 else 0` guards. alter/cc-
	// autopipe-source had 53 hits — all `Path / "subdir"` joins.

	it("does NOT flag Python `total / count if count > 0 else 0.0` (zero-guard)", () => {
		const code = `avg_runtime = total_runtime / task_count if task_count > 0 else 0.0`;
		expect(checkDivisionByVariable(code, "src/analytics.py")).toEqual([]);
	});

	it("does NOT flag Python `... if x != 0 else ...` (zero-guard)", () => {
		const code = `rate = a / b if b != 0 else 0.0`;
		expect(checkDivisionByVariable(code, "src/analytics.py")).toEqual([]);
	});

	it("does NOT flag JS ternary `count > 0 ? sum / count : 0`", () => {
		const code = `const avg = count > 0 ? sum / count : 0;`;
		expect(checkDivisionByVariable(code, "src/avg.ts")).toEqual([]);
	});

	it("does NOT flag JS short-circuit `count && sum / count`", () => {
		const code = `const avg = count && sum / count;`;
		expect(checkDivisionByVariable(code, "src/avg.ts")).toEqual([]);
	});

	it("does NOT flag Python pathlib join — `path / 'subdir'`", () => {
		// LHS annotated as Path — `__truediv__` overload, not division.
		const code = [
			"from pathlib import Path",
			"def make(path: Path):",
			"    return path / 'subdir'",
		].join("\n");
		expect(checkDivisionByVariable(code, "src/paths.py")).toEqual([]);
	});

	it("does NOT flag Python `root = Path(x) / subdir` assignment-form", () => {
		const code = [
			"from pathlib import Path",
			"root = Path(x)",
			"target = root / subdir",
		].join("\n");
		// `root` is assigned via Path(...) — the third line's `root /
		// subdir` is path join.
		expect(checkDivisionByVariable(code, "src/paths.py")).toEqual([]);
	});

	it("does NOT flag `os.path.join(a, b)` even with bilateral identifiers nearby", () => {
		// The line itself contains `a / b`-style fragments only as part
		// of os.path.join arguments — gate at the call shape.
		const code = `result = os.path.join(prefix, "data") / handler`;
		// This is a contrived example, but the check should respect
		// `os.path.join(...)` presence.
		expect(checkDivisionByVariable(code, "src/paths.py")).toEqual([]);
	});

	// Positive cases — real division-by-zero risks MUST still fire.

	it("STILL flags `result = total / count` with no zero guard", () => {
		const code = `result = total / count`;
		expect(checkDivisionByVariable(code, "src/calc.py").length).toBeGreaterThan(0);
	});

	it("STILL flags JS `const r = a / b;` with no guard", () => {
		const code = `const r = a / b;`;
		expect(checkDivisionByVariable(code, "src/calc.ts").length).toBeGreaterThan(0);
	});

	it("STILL flags Python division on a non-Path identifier", () => {
		// `count` is NOT annotated/assigned as Path — must fire.
		const code = `def avg(total, count):\n    return total / count`;
		expect(checkDivisionByVariable(code, "src/calc.py").length).toBeGreaterThan(0);
	});

	it("STILL flags when `if` appears for an unrelated condition", () => {
		// `if debug:` is unrelated to the divisor — must fire.
		const code = `result = a / b\nif debug:\n    log()`;
		expect(checkDivisionByVariable(code, "src/calc.py").length).toBeGreaterThan(0);
	});
});
