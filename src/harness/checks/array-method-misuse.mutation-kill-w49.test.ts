import { describe, expect, it } from "vitest";
import {
	detectArrayIterateeVariadicBuiltin,
	detectReturnArrayPush,
} from "./array-method-misuse.js";

const FILE = "probe.ts";

describe("detectReturnArrayPush — positive (must fire)", () => {
	// test-contract: public-api — detectReturnArrayPush's InlineMatch.line/text
	// fields are the on-disk contract PostToolUse reports render verbatim.
	it("reports the exact 1-based line and exact trimmed text of the match", () => {
		const content = "// comment\nconst added = items.push(value);\n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(2);
		expect(matches[0]?.text).toBe("const added = items.push(value);");
	});

	// test-contract: bug — pins the `line: i + 1` arithmetic; a wrong offset
	// (e.g. i - 1) points the agent at the wrong source line.
	it("computes line as i + 1, not i - 1, for a match on a later line", () => {
		const content = "a();\nb();\nc();\nconst z = arr.push(q);\n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(4);
	});

	// test-contract: public-api — the reported text field is documented to be
	// trimmed (module header: `.trim().slice(...)`); untrimmed text is a
	// contract break for downstream display.
	it("trims leading/trailing whitespace off the reported text", () => {
		const content = "   const added = items.push(value);   \n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.startsWith(" ")).toBe(false);
		expect(matches[0]?.text.endsWith(" ")).toBe(false);
		expect(matches[0]?.text.length).toBeGreaterThan(0);
	});

	// test-contract: boundary — REPORT_LINE_TRUNC (150) caps the reported text
	// length; an unbounded report could flood the agent's warning output.
	it("truncates the reported text to REPORT_LINE_TRUNC (150) characters", () => {
		const filler = "x".repeat(200);
		const content = `const added = items.push(${filler});\n`;
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.length).toBeLessThanOrEqual(150);
		// the full untruncated line is longer than 150 chars, proving slice ran
		expect(content.trim().length).toBeGreaterThan(150);
	});

	// test-contract: boundary — MAX_MATCHES_PER_FILE (10) is the documented
	// per-file cap; off-by-one or a disabled cap changes report volume.
	it("caps matches at MAX_MATCHES_PER_FILE (10), not unlimited and not 11", () => {
		const lines: string[] = [];
		for (let n = 0; n < 15; n++) {
			lines.push(`const added${n} = items.push(value${n});`);
		}
		const content = lines.join("\n");
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(10);
	});
});

describe("detectReturnArrayPush — chained-push exclusion regex (must not fire on genuine chains)", () => {
	// test-contract: invariant — CHAINED_PUSH_RE is documented (module header)
	// to exempt `.push(x).length`-style chains as a deliberate value read.
	it("does not flag push(...).method() chains with a multi-char argument", () => {
		const content = "const x = items.push(value).toString();\n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(0);
	});

	// test-contract: invariant — the chain regex uses \s* around the opening
	// paren, so whitespace after the method name must not defeat the exemption.
	it("does not flag a chain when there is whitespace before the '(' after push", () => {
		const content = "const b = items.push (arg).toString();\n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(0);
	});

	// test-contract: invariant — the chain regex uses \s* between the closing
	// paren and the following '.', so whitespace there must not defeat it.
	it("does not flag a chain when there is whitespace between ')' and the following '.'", () => {
		const content = "const c = items.push(arg) .toString();\n";
		const matches = detectReturnArrayPush(content, FILE);
		expect(matches).toHaveLength(0);
	});
});

describe("detectArrayIterateeVariadicBuiltin — positive (must fire)", () => {
	// test-contract: public-api — InlineMatch.line/text is the reporting
	// contract this detector's callers (PostToolUse / verify) render verbatim.
	it("reports the exact 1-based line and exact trimmed text of the match", () => {
		const content = "// comment\narr.map(parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(2);
		expect(matches[0]?.text).toBe("arr.map(parseInt);");
	});

	// test-contract: bug — pins the `line: i + 1` arithmetic; a wrong offset
	// (e.g. i - 1) points the agent at the wrong source line.
	it("computes line as i + 1, not i - 1, for a match on a later line", () => {
		const content = "a();\nb();\nc();\narr.map(parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(4);
	});

	// test-contract: public-api — the reported text field is documented to be
	// trimmed (module header: `.trim().slice(...)`); untrimmed text breaks
	// downstream display consumers.
	it("trims leading/trailing whitespace off the reported text", () => {
		const content = "   arr.map(parseInt);   \n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.startsWith(" ")).toBe(false);
		expect(matches[0]?.text.endsWith(" ")).toBe(false);
	});

	// test-contract: boundary — REPORT_LINE_TRUNC (150) caps the reported text
	// length; removing the slice() lets long lines blow past the cap.
	it("truncates the reported text to REPORT_LINE_TRUNC (150) characters", () => {
		const padding = "y".repeat(200);
		const content = `arr.map(parseInt); // ${padding}\n`;
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.length).toBeLessThanOrEqual(150);
		expect(content.trim().length).toBeGreaterThan(150);
	});

	// test-contract: boundary — MAX_MATCHES_PER_FILE (10) is the documented
	// per-file cap; off-by-one or a disabled cap changes report volume.
	it("caps matches at MAX_MATCHES_PER_FILE (10), not unlimited and not 11", () => {
		const lines: string[] = [];
		for (let n = 0; n < 15; n++) {
			lines.push(`arrList${n}.map(parseInt);`);
		}
		const content = lines.join("\n");
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(10);
	});
});

describe("detectArrayIterateeVariadicBuiltin — regex whitespace-tolerance (must still fire)", () => {
	// test-contract: invariant — MAP_PARSEINT_RE uses \s* after the opening
	// paren, so a space before the callback must not defeat the detector.
	it("still fires with a space right after '(' before parseInt", () => {
		const content = "arr.map( parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});

	// test-contract: invariant — MAP_PARSEINT_RE uses \s* between the method
	// name and '(', so a space there must not defeat the detector.
	it("still fires with a space between the method name and '('", () => {
		const content = "arr.map (parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});

	// test-contract: invariant — MAP_PARSEINT_RE uses \s* before the closing
	// paren, so a trailing space must not defeat the detector.
	it("still fires with a space right before the closing ')'", () => {
		const content = "arr.map(parseInt );\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});

	// test-contract: invariant — ARRAY_FROM_PARSEINT_RE uses \s* (zero or
	// more) after the comma, so no whitespace at all must still match.
	it("still fires on Array.from with no space between comma and parseInt", () => {
		const content = "Array.from(arr,parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});

	// test-contract: invariant — ARRAY_FROM_PARSEINT_RE uses \s* before the
	// closing paren, so a trailing space must not defeat the detector.
	it("still fires on Array.from with a space before the closing ')'", () => {
		const content = "Array.from(arr, parseInt );\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});

	// test-contract: invariant — ARRAY_FROM_PARSEINT_RE uses \s* between
	// 'from' and '(', so a space there must not defeat the detector.
	it("still fires on Array.from with a space between 'from' and '('", () => {
		const content = "Array.from (arr, parseInt);\n";
		const matches = detectArrayIterateeVariadicBuiltin(content, FILE);
		expect(matches).toHaveLength(1);
	});
});
