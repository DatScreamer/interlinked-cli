import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan, checkSuppressionSpan } from "./unsafe-span.js";

const RS = "src/ffi/bridge.rs";
const TS = "src/feature/bridge.ts";
const code = (n: number): string[] => Array.from({ length: n }, (_, i) => `    op_${i}();`);
const rust = (lines: string[]) => checkRustUnsafeSpan(lines.join("\n"), RS);
const js = (lines: string[]) => checkSuppressionSpan(lines.join("\n"), TS);

describe("unsafe-span mutation-kill campaign (wave pass1_w25)", () => {
	// test-contract: invariant — a triple-apostrophe run must never be mistaken for a
	// 3-char literal: the second `'` disqualifies it under `next !== "'"`, so all three
	// quotes stay live code and the standalone-quote line keeps counting as nonblank.
	it("does not treat three consecutive apostrophes as a char literal", () => {
		const found = rust(["unsafe {", "    '''", ...code(5), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	// test-contract: security — a lone division slash must not be misread as a block
	// comment opener; doing so would swallow the real closing brace as "comment body".
	it("does not treat a bare division slash as a block-comment opener", () => {
		expect(rust(["unsafe {", "    let a = 10 / 2;", ...code(4), "}"])).toHaveLength(0);
	});

	// test-contract: boundary — `consumeBlockComment` must search for `*/` starting
	// AFTER the opener, not before it; two back-to-back comments probe the offset.
	it("finds a directive whose block comment immediately follows another comment", () => {
		const found = js(["/* c1 *//* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: invariant — the returned resume index must land just past the
	// comment's closer, not mid-body; a stray backtick placed 2 chars before `*/`
	// would open a phantom template string if the resume point rewinds into the body.
	it("resumes scanning immediately after the comment closer, not mid-body", () => {
		const found = js(["/* eslint-disable` */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: security — an unterminated `"`/`'` string must stop at the line's
	// end so it cannot swallow a real directive on a later line.
	it("stops an unterminated double-quoted string at end of line", () => {
		const found = js([
			"/* eslint-disable */",
			'const x = "unterminated',
			...code(9),
			"/* eslint-enable */",
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 12 lines");
	});

	// test-contract: security — a bare `/` (division) inside code must not be read as
	// opening a block comment; doing so hides the following real eslint-disable.
	it("does not treat a division slash in code as a comment opener", () => {
		const found = js(["const r = 10 / 2;", "/* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: security — an ordinary character immediately followed by `*`
	// (e.g. a multiplication) must not be read as opening a block comment either.
	it("does not treat a multiplication asterisk in code as a comment opener", () => {
		const found = js(["a = 9*3;", "/* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: invariant — the line counter must ADVANCE across a multi-line
	// comment's embedded newlines, not retreat; a two-line padding comment before the
	// disable directive pins the reported line number.
	it("advances the line counter across a multi-line padding comment", () => {
		const found = js(["/* padding", "comment */", "/* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: invariant — same as above, but the multi-line span is a template
	// literal instead of a comment (the sibling call site of the same source line).
	it("advances the line counter across a multi-line template literal", () => {
		const tick = String.fromCharCode(96);
		const found = js([
			`const s = ${tick}line1`,
			`line2${tick};`,
			"/* eslint-disable */",
			...code(9),
			"/* eslint-enable */",
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
		expect(found[0]?.text).toContain("spans 11 lines");
	});

	// test-contract: invariant — `findEnableLineFor` must SKIP over an intervening
	// disable directive while searching for the closing enable, never treat the
	// intervening disable itself as satisfying the enable match.
	it("skips an intervening disable while searching for the closing enable", () => {
		const found = js(["/* eslint-disable */", "/* eslint-disable */", ...code(9), "/* eslint-enable */"]);
		expect(found).toHaveLength(2);
		expect(found[0]?.text).toContain("spans 12 lines");
		expect(found[1]?.text).toContain("spans 11 lines");
	});
});
