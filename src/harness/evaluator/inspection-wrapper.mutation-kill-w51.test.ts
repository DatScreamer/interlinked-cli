import { describe, it, expect } from "vitest";
import { isInspectionWrapperCall } from "./inspection-wrapper.js";

// Mutation-kill suite for src/harness/evaluator/inspection-wrapper.ts
// (wave pass1_w51). Each test is built to flip true<->false relative to
// the specific mutant listed in the wave brief.

describe("isInspectionWrapperCall — mutation kills (w51)", () => {
	// 0d1e915e2049582a: tail.trim() -> tail
	// Trailing whitespace after a bare-word argument must be trimmed away
	// before the bare-word regex check (which forbids whitespace).
	// test-contract: public-api — isInspectionWrapperCall trims trailing
	// whitespace off the argument before validating it as inert.
	it("accepts a bare-word argument with trailing whitespace (trim required)", () => {
		expect(isInspectionWrapperCall("interlinked harness test word   ")).toBe(true);
	});

	// 0415db41b72444ed: rest.startsWith("'") -> rest.endsWith("'")
	// test-contract: security — a bare word that merely ends with a stray
	// quote must be rejected (not treated as a quoted-argument start).
	it("rejects a bare word ending in a stray single quote", () => {
		expect(isInspectionWrapperCall("interlinked harness test ok'")).toBe(false);
	});

	// 64356e6df2c2868b: -1 -> +1 (the close === -1 sentinel check)
	// test-contract: boundary — an empty single-quoted argument '' closes
	// at index 1; that must not be misread as the "not found" sentinel.
	it("accepts an empty single-quoted argument ''", () => {
		expect(isInspectionWrapperCall("interlinked harness test ''")).toBe(true);
	});

	// 71fe51840a3a8669: rest.slice(close + 1).trim() -> without .trim()
	// test-contract: public-api — trailing whitespace after a closing
	// single quote is part of the tail that must be trimmed to empty.
	it("accepts a single-quoted argument with trailing whitespace after it", () => {
		expect(isInspectionWrapperCall("interlinked harness test 'ok'  ")).toBe(true);
	});

	// 1cc9f40d1abfa05e: rest.startsWith('"') -> rest.endsWith('"')
	// test-contract: security — a bare word merely ending in a stray
	// double quote must be rejected, not treated as a quoted argument.
	it('rejects a bare word ending in a stray double quote', () => {
		expect(isInspectionWrapperCall('interlinked harness test ok"')).toBe(false);
	});

	// b7d7ab31043e8645 (i + 1 -> i - 1) and 74edc5bf173c0e4d
	// (body += rest[i+1] -> body -= rest[i+1]): both corrupt which
	// character is accumulated for the dangerous-substitution ($ / `)
	// scan inside a double-quoted argument.
	// test-contract: security — an escaped '$' inside a double-quoted
	// argument (shell command substitution risk) must be read correctly
	// and cause the call to be rejected.
	it('rejects a double-quoted argument containing an escaped "$"', () => {
		expect(isInspectionWrapperCall('interlinked harness test "a\\$"')).toBe(false);
	});

	// 164633ffa9292857: i >= rest.length -> false
	// 0aee233285edde9b: i >= rest.length -> i > rest.length
	// test-contract: boundary — an unterminated double-quoted argument
	// (no closing quote) must be rejected exactly at the loop's final
	// index, not fall through as if it were valid.
	it("rejects an unterminated double-quoted argument", () => {
		expect(isInspectionWrapperCall('interlinked harness test "abc')).toBe(false);
	});

	// 41cc9e6ff17be924: rest.slice(i + 1).trim() -> without .trim()
	// test-contract: public-api — trailing whitespace after a closing
	// double quote is part of the tail that must be trimmed to empty.
	it("accepts a double-quoted argument with trailing whitespace after it", () => {
		expect(isInspectionWrapperCall('interlinked harness test "ok"  ')).toBe(true);
	});

	// f6e228ff23277213: INSPECTION_PREFIX_RE loses its leading ^ anchor.
	// test-contract: security — the wrapper prefix must only match at the
	// true start of the command; a prefix embedded mid-command (e.g.
	// hidden after other text) must not be treated as the wrapper call.
	it("rejects when the wrapper prefix is not at the start of the command", () => {
		expect(isInspectionWrapperCall("xinterlinked harness test 'ok'")).toBe(false);
	});

	// 9a8f1613cf18759d: npx\s+tsx\s+src -> npx\s+tsx\ssrc (loses a '+')
	// test-contract: public-api — the npx-tsx wrapper prefix tolerates
	// arbitrary whitespace (\s+) between "tsx" and "src", not exactly one.
	it("accepts extra whitespace between tsx and src in the npx-tsx prefix", () => {
		expect(
			isInspectionWrapperCall("npx tsx  src/index.ts harness test 'ok'"),
		).toBe(true);
	});

	// e13c54519a6fae2f: npx\s+tsx -> npx\stsx (loses a '+')
	// test-contract: public-api — the npx-tsx wrapper prefix tolerates
	// arbitrary whitespace between "npx" and "tsx", not exactly one.
	it("accepts extra whitespace between npx and tsx in the npx-tsx prefix", () => {
		expect(
			isInspectionWrapperCall("npx  tsx src/index.ts harness test 'ok'"),
		).toBe(true);
	});

	// e851c62cfe42595f: node\s+(?:\.\/)?dist -> node\s(?:\.\/)?dist (loses a '+')
	// test-contract: public-api — the node-dist wrapper prefix tolerates
	// arbitrary whitespace between "node" and "dist", not exactly one.
	it("accepts extra whitespace between node and dist in the node-dist prefix", () => {
		expect(
			isInspectionWrapperCall("node  dist/index.js harness test 'ok'"),
		).toBe(true);
	});

	// 3dc2c60300401d1e: )\s+harness -> )\sharness (loses a '+')
	// test-contract: public-api — whitespace between the wrapper
	// alternation and "harness" must tolerate more than one space.
	it("accepts extra whitespace before 'harness' in the prefix", () => {
		expect(isInspectionWrapperCall("interlinked  harness test 'ok'")).toBe(true);
	});

	// fba81da889640ae6: harness\s+test -> harness\stest (loses a '+')
	// test-contract: public-api — whitespace between "harness" and "test"
	// must tolerate more than one space (real usage is not that strict).
	it("accepts extra whitespace between 'harness' and 'test'", () => {
		expect(isInspectionWrapperCall("interlinked harness  test 'ok'")).toBe(true);
	});

	// a6b56b287924c164: /^--?[\w-]+\s+/ -> /^--[\w-]+\s+/ (mandatory '--')
	// test-contract: public-api — FLAG_TOKEN_RE recognizes a single-dash
	// flag such as "-v", not only double-dash flags.
	it("accepts a single-dash flag token before the argument", () => {
		expect(isInspectionWrapperCall("interlinked harness test -v 'ok'")).toBe(true);
	});

	// 095f27e4b26b9fad: flag token's trailing \s+ -> \s (loses a '+')
	// test-contract: public-api — whitespace after a "--flag" token must
	// tolerate more than one space, fully consuming it before the argument.
	it("accepts extra whitespace after a long flag token", () => {
		expect(
			isInspectionWrapperCall("interlinked harness test --flag  'ok'"),
		).toBe(true);
	});

	// 54615b71c486f3a9: bare-word regex loses its trailing '$' anchor.
	// test-contract: security — a bare word must match its safe-character
	// class for its ENTIRE length; a dangerous suffix (";rm -rf /") after
	// safe leading characters must still cause rejection.
	it("rejects a bare-word argument with a dangerous suffix (';rm -rf /')", () => {
		expect(isInspectionWrapperCall("interlinked harness test ok;rm -rf /")).toBe(
			false,
		);
	});

	// 87178e7df2a3fbf3: bare-word regex loses its leading '^' anchor.
	// test-contract: security — a bare word must match its safe-character
	// class from the very start; a dangerous prefix (";rm -rf /") before a
	// safe-looking suffix must still cause rejection.
	it("rejects a bare-word argument with a dangerous prefix (';rm -rf /ok')", () => {
		expect(isInspectionWrapperCall("interlinked harness test ;rm -rf /ok")).toBe(
			false,
		);
	});

	// test-contract: public-api — the documented `interlinked harness test
	// "rm -rf /"` usage from CLAUDE.md is the canonical accepted case.
	it("still accepts the documented usage from CLAUDE.md", () => {
		expect(isInspectionWrapperCall('interlinked harness test "rm -rf /"')).toBe(
			true,
		);
	});

	// test-contract: security — a command chained after the inspected
	// argument (`&&` metacharacter in the tail) must fall through to
	// normal (non-exempt) evaluation.
	it("still rejects a chained command after the wrapper", () => {
		expect(
			isInspectionWrapperCall('interlinked harness test "x" && rm -rf /'),
		).toBe(false);
	});
});
