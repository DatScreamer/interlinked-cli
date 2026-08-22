import { describe, expect, it } from "vitest";
import {
	checkSwiftCombineNoStore,
	checkSwiftNotificationObserverNoRemoval,
	checkSwiftTimerNoInvalidate,
} from "./swift-lifecycle.js";

// Mutation-kill campaign w29 — targets survived mutants recorded against
// src/harness/checks/swift-lifecycle.ts in .interlinked/mutation-manifest.json.
// The three detectors share one heuristic shape, so the same case shapes
// (regex-whitespace probes, MATCH_LIMIT boundary, object/line/text exactness)
// repeat once per function.

describe("checkSwiftNotificationObserverNoRemoval — mutation kill", () => {
	// test-contract: boundary — regex \s* -> \S* on addObserver (guard 62785e53, loop cdf84ceac):
	// a literal space between "addObserver" and "(" still matches \s* but breaks \S*.
	it("P1: flags addObserver with internal whitespace before the paren", () => {
		const code = "NotificationCenter.default.addObserver (self, selector: #selector(x), name: .y, object: nil)";
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift").length).toBe(1);
	});

	// test-contract: boundary — regex \s* -> \S* on removeObserver (61e4faa5): a spaced
	// removeObserver call must still suppress the finding.
	it("N2: does not flag when removeObserver has internal whitespace before the paren", () => {
		const code = [
			"NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil)",
			"NotificationCenter.default.removeObserver (self)",
		].join("\n");
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift")).toEqual([]);
	});

	// test-contract: invariant — StringLiteral "\n" -> "" (ff91e7f1) collapses both line
	// splits to per-character arrays; ObjectLiteral -> {} (8a4c8711); ArithmeticOperator
	// i+1 -> i-1 (e38b8f3c). Exact shape + a match on a non-first line kills all three.
	it("P2: reports the exact {line, text} shape at the correct 1-based line number", () => {
		const code = "class Foo {\n\tfunc setup() {\n\t\tNotificationCenter.default.addObserver(self, selector: #selector(handle), name: .x, object: nil)\n\t}\n}";
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift")).toEqual([
			{
				line: 3,
				text: "NotificationCenter.default.addObserver(self, selector: #selector(handle), name: .x, object: nil)",
			},
		]);
	});

	// test-contract: boundary — ConditionalExpression matches.length>=MATCH_LIMIT -> false
	// (8ee9a66a) and EqualityOperator >= -> > (4dee226d): with 15 candidate lines the
	// cap must land exactly at 10 (false keeps all 15; > over-runs to 11).
	it("P3: caps findings at MATCH_LIMIT (10) even with 15 candidate lines", () => {
		const line = "NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil)";
		const code = Array(15).fill(line).join("\n");
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift").length).toBe(10);
	});

	// test-contract: boundary — MethodExpression .trim().slice(0,150) -> .trim() (4fe4f76165):
	// a line over 150 chars must be truncated to exactly the first 150 characters.
	it("P4: truncates the reported text to exactly 150 characters", () => {
		const prefix = "NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil) ";
		const code = prefix + "x".repeat(200);
		const result = checkSwiftNotificationObserverNoRemoval(code, "Foo.swift");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe(
			"NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil) xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		);
		expect(result[0]?.text.length).toBe(150);
	});

	// test-contract: boundary — MethodExpression .trim() -> (removed) (6462d3c6bbedb6bb):
	// leading/trailing whitespace around the matched line must not survive in `text`.
	it("P5: trims leading and trailing whitespace from the reported text", () => {
		const code = "\t  NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil)  \t";
		expect(checkSwiftNotificationObserverNoRemoval(code, "Foo.swift")).toEqual([
			{ line: 1, text: "NotificationCenter.default.addObserver(self, selector: #selector(x), name: .y, object: nil)" },
		]);
	});
});

describe("checkSwiftTimerNoInvalidate — mutation kill", () => {
	// test-contract: boundary — the three \s*->\S* Regex mutants on the scheduledTimer
	// pattern at BOTH the guard occurrence (753e295e/8a5262e5/473f91dd) and the loop
	// occurrence (a6330474/ae79161a/b42873d2): spaces at all three \s* positions.
	it("P1: flags Timer.scheduledTimer with whitespace around every token", () => {
		const code = "Timer . scheduledTimer (withTimeInterval: 1, repeats: true) { _ in }";
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift").length).toBe(1);
	});

	// test-contract: boundary — the three \s*->\S* Regex mutants on the invalidate
	// pattern (5ca50c34/591630a8/a3b9c8ae): whitespace at all three \s* positions
	// must still suppress the finding.
	it("N2: does not flag when invalidate() has whitespace around every token", () => {
		const code = [
			"Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }",
			"t?. invalidate ( )",
		].join("\n");
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift")).toEqual([]);
	});

	// test-contract: invariant — StringLiteral "\n" -> "" (d8afadaf), ObjectLiteral -> {}
	// (bb25c02458ca3dab), ArithmeticOperator i+1 -> i-1 (acdf2cf2): exact shape at a
	// non-first line number.
	it("P2: reports the exact {line, text} shape at the correct 1-based line number", () => {
		const code = "class Foo {\n\tfunc setup() {\n\t\tTimer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }\n\t}\n}";
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift")).toEqual([
			{ line: 3, text: "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }" },
		]);
	});

	// test-contract: boundary — ConditionalExpression >= -> false (b9bec2ea) and
	// EqualityOperator >= -> > (5837f910): 15 candidates must cap at exactly 10.
	it("P3: caps findings at MATCH_LIMIT (10) even with 15 candidate lines", () => {
		const line = "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }";
		const code = Array(15).fill(line).join("\n");
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift").length).toBe(10);
	});

	// test-contract: boundary — MethodExpression .trim().slice(0,150) -> .trim() (a0c56573):
	// truncate to exactly 150 characters.
	it("P4: truncates the reported text to exactly 150 characters", () => {
		const prefix = "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in } ";
		const code = prefix + "x".repeat(200);
		const result = checkSwiftTimerNoInvalidate(code, "Foo.swift");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe(
			"Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in } xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		);
		expect(result[0]?.text.length).toBe(150);
	});

	// test-contract: boundary — MethodExpression .trim() -> (removed) (6d7419ac):
	// leading/trailing whitespace must not survive in `text`.
	it("P5: trims leading and trailing whitespace from the reported text", () => {
		const code = "\t  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }  \t";
		expect(checkSwiftTimerNoInvalidate(code, "Foo.swift")).toEqual([
			{ line: 1, text: "Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in }" },
		]);
	});
});

describe("checkSwiftCombineNoStore — mutation kill", () => {
	// test-contract: boundary — the \s*->\S* Regex mutants on the sink|assign pattern at
	// BOTH the guard occurrence (9b28d8cf) and the loop occurrence (a25200e0): a
	// literal space after the dot and before the brace.
	it("P1: flags .sink with whitespace around the dot and the brace", () => {
		const code = "publisher. sink { value in print(value) }";
		expect(checkSwiftCombineNoStore(code, "Foo.swift").length).toBe(1);
	});

	// test-contract: boundary — the four \s*->\S* Regex mutants on the store(in:) pattern
	// (12f4cca7/ce8fa420/98f6c48411/058c14a5): whitespace at all four \s* positions
	// must still suppress the finding.
	it("N2: does not flag when .store(in:) has whitespace around every token", () => {
		const code = [
			"publisher.sink { value in print(value) }",
			". store ( in : &cancellables)",
		].join("\n");
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([]);
	});

	// test-contract: invariant — StringLiteral "\n" -> "" (b2a3db22), ObjectLiteral -> {}
	// (02f37176481c71bc), ArithmeticOperator i+1 -> i-1 (aaefe9d7): exact shape at a
	// non-first line number.
	it("P2: reports the exact {line, text} shape at the correct 1-based line number", () => {
		const code = "class Foo {\n\tfunc setup() {\n\t\tpublisher.sink { value in print(value) }\n\t}\n}";
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([
			{ line: 3, text: "publisher.sink { value in print(value) }" },
		]);
	});

	// test-contract: boundary — ConditionalExpression >= -> false (289bd5a3) and
	// EqualityOperator >= -> > (dddad9e6): 15 candidates must cap at exactly 10.
	it("P3: caps findings at MATCH_LIMIT (10) even with 15 candidate lines", () => {
		const line = "publisher.sink { value in print(value) }";
		const code = Array(15).fill(line).join("\n");
		expect(checkSwiftCombineNoStore(code, "Foo.swift").length).toBe(10);
	});

	// test-contract: boundary — MethodExpression .trim().slice(0,150) -> .trim() (63b77d8c):
	// truncate to exactly 150 characters.
	it("P4: truncates the reported text to exactly 150 characters", () => {
		const prefix = "publisher.sink { value in print(value) } ";
		const code = prefix + "x".repeat(200);
		const result = checkSwiftCombineNoStore(code, "Foo.swift");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toBe(
			"publisher.sink { value in print(value) } xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		);
		expect(result[0]?.text.length).toBe(150);
	});

	// test-contract: boundary — MethodExpression .trim() -> (removed) (37f2d262):
	// leading/trailing whitespace must not survive in `text`.
	it("P5: trims leading and trailing whitespace from the reported text", () => {
		const code = "\t  publisher.sink { value in print(value) }  \t";
		expect(checkSwiftCombineNoStore(code, "Foo.swift")).toEqual([
			{ line: 1, text: "publisher.sink { value in print(value) }" },
		]);
	});
});
