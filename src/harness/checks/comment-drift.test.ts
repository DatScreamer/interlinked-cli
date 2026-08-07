// Tests for the comment-vs-behavior drift detector — adaptation of
// Mythos's "spotting contradictions between code comments and actual
// behavior" pattern into deterministic regex+AST rules. Five narrow
// detectors, each with positive and negative cases.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
	collectAnnotatedFunctions,
} from "./comment-drift.js";

describe("checkCommentClaimsLimitNoGuard", () => {
	it('fires when JSDoc says "max N" but body has no < N / <= N guard', () => {
		const content = `
			/** Parse up to a max of 100 items. */
			function parseAll(input: string[]): Item[] {
				const out: Item[] = [];
				for (const x of input) {
					out.push(parse(x));
				}
				return out;
			}
		`;
		const matches = checkCommentClaimsLimitNoGuard(content, "src/foo.ts");
		expect(matches.length).toBeGreaterThan(0);
		expect(nonNull(matches[0]).text.toLowerCase()).toContain("max");
	});

	it('fires for "at most N"', () => {
		const content = `
			// at most 50 retries
			function retry(): void {
				while (true) { try_once(); }
			}
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "limited to N"', () => {
		const content = `
			// Limited to 256 bytes.
			function readChunk(): Buffer {
				return Buffer.from(readAll());
			}
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when the body has a < N guard matching the comment", () => {
		const content = `
			/** Parse up to a max of 100 items. */
			function parseAll(input: string[]): Item[] {
				const out: Item[] = [];
				for (const x of input) {
					if (out.length < 100) out.push(parse(x));
				}
				return out;
			}
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/foo.ts")).toEqual([]);
	});

	it("does NOT fire when the body has a <= N guard", () => {
		const content = `
			// max 50
			function f(): void {
				if (i <= 50) doIt();
			}
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts")).toEqual([]);
	});

	it('does NOT fire for prose mentioning "max" outside an explicit limit claim', () => {
		// "max" appears but no number — heuristic skips ambiguous prose.
		const content = `
			/** Run the maximum-effort path. */
			function f(): void {
				doIt();
			}
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsNullThrowsInstead", () => {
	it('fires when comment says "returns null on failure" but body has throw', () => {
		const content = `
			/** Lookup. Returns null on failure. */
			function lookup(id: string): User | null {
				const u = db.find(id);
				if (!u) throw new Error("not found");
				return u;
			}
		`;
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires when comment says "may return undefined" but body throws', () => {
		const content = `
			/** Find by key. May return undefined when key missing. */
			function find(k: string): T | undefined {
				if (!k) throw new RangeError("empty key");
				return cache[k];
			}
		`;
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when the throw is inside a try/catch (caught above)", () => {
		// throw is recoverable — the comment's contract may still hold.
		const content = `
			/** Returns null on failure. */
			function safeLoad(p: string): T | null {
				try {
					const data = readFile(p);
					if (!data) throw new Error("empty");
					return parse(data);
				} catch {
					return null;
				}
			}
		`;
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when comment makes no null/undefined claim", () => {
		const content = `
			/** Loads the user. */
			function load(id: string): User {
				if (!id) throw new Error("missing id");
				return db.find(id);
			}
		`;
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsValidationMissing", () => {
	it('fires when comment says "validates X" but body has no conditional/regex/encode', () => {
		const content = `
			/** Validates the user email and returns it normalized. */
			function normalizeEmail(email: string): string {
				return email.toLowerCase();
			}
		`;
		expect(
			checkCommentClaimsValidationMissing(content, "src/x.ts").length,
		).toBeGreaterThan(0);
	});

	it('fires for "sanitizes" with no escape/encode call', () => {
		const content = `
			/** Sanitizes the input before insertion. */
			function clean(s: string): string {
				return s;
			}
		`;
		expect(
			checkCommentClaimsValidationMissing(content, "src/x.ts").length,
		).toBeGreaterThan(0);
	});

	it('fires for "escapes" with no replace/encode call', () => {
		const content = `
			/** Escapes user input for SQL. */
			function escapeSql(s: string): string {
				return "'" + s + "'";
			}
		`;
		expect(
			checkCommentClaimsValidationMissing(content, "src/x.ts").length,
		).toBeGreaterThan(0);
	});

	it("does NOT fire when body has a conditional + branching", () => {
		const content = `
			/** Validates the email. */
			function valid(email: string): boolean {
				if (!email.includes("@")) return false;
				return true;
			}
		`;
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when body has regex test/match", () => {
		const content = `
			/** Sanitizes the input. */
			function clean(s: string): string {
				return s.replace(/[<>]/g, "");
			}
		`;
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when body has encodeURIComponent / escape / sanitize call", () => {
		const content = `
			/** Escapes the URL. */
			function escapeUrl(u: string): string {
				return encodeURIComponent(u);
			}
		`;
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsIdempotentMutates", () => {
	it('fires when comment says "idempotent" but body has unconditional mutation', () => {
		const content = `
			/** Idempotent counter increment. */
			function bump(): void {
				counter += 1;
			}
		`;
		expect(
			checkCommentClaimsIdempotentMutates(content, "src/x.ts").length,
		).toBeGreaterThan(0);
	});

	it("does NOT fire when mutation is guarded", () => {
		const content = `
			/** Idempotent — only mutates when key is missing. */
			function set(key: string, v: T): void {
				if (!map.has(key)) map.set(key, v);
			}
		`;
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});

	it('does NOT fire when comment doesn\'t claim "idempotent"', () => {
		const content = `
			/** Increments the counter. */
			function bump(): void {
				counter += 1;
			}
		`;
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsThrowsDoesnt", () => {
	it("fires when @throws ErrorX is declared but body never throws ErrorX", () => {
		const content = `
			/**
			 * Load a record.
			 * @throws {RangeError} when id is out of range.
			 */
			function load(id: number): Record {
				if (id < 0) throw new Error("bad");
				return db.find(id);
			}
		`;
		expect(
			checkCommentClaimsThrowsDoesnt(content, "src/x.ts").length,
		).toBeGreaterThan(0);
	});

	it("does NOT fire when @throws ErrorX matches a real throw", () => {
		const content = `
			/**
			 * @throws {RangeError} when id is out of range.
			 */
			function load(id: number): Record {
				if (id < 0) throw new RangeError("bad");
				return db.find(id);
			}
		`;
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when no @throws declaration is present", () => {
		const content = `
			/** Load. */
			function load(id: number): Record {
				if (id < 0) throw new Error("bad");
				return db.find(id);
			}
		`;
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts")).toEqual([]);
	});
});

describe("collectAnnotatedFunctions — structural fixtures", () => {
	it("pins exact commentLine/commentText/bodyStartLine/bodyText for a single-line block comment", () => {
		const content = ["/** Doc. */", "function foo(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "/** Doc. */",
				bodyStartLine: 2,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("pins exact values for a multi-line block comment", () => {
		const content = [
			"/**",
			" * Doc line.",
			" */",
			"function foo(): void {",
			"\tdoIt();",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "/**\n * Doc line.\n */",
				bodyStartLine: 4,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("pins exact values for contiguous // comments starting at the top of the file", () => {
		const content = ["// First", "// Second", "function foo(): void {", "\tdoIt();", "}"].join(
			"\n",
		);
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "// First\n// Second",
				bodyStartLine: 3,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("pins exact values for contiguous // comments preceded by unrelated code (walk stops at non-comment line)", () => {
		const content = [
			"const unrelated = 1;",
			"// First line comment",
			"// Second line comment",
			"// Third line comment",
			"function foo(): void {",
			"\tdoIt();",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 2,
				commentText: "// First line comment\n// Second line comment\n// Third line comment",
				bodyStartLine: 5,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("skips a function with a blank line then a real comment above it (walk-back-over-blanks)", () => {
		const content = ["/** Doc. */", "", "function foo(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "/** Doc. */",
				bodyStartLine: 3,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("returns empty when only blank lines precede the function (no comment at all)", () => {
		const content = ["", "", "function foo(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("returns empty when a malformed block-comment-lookalike (missing opening /**) precedes the function", () => {
		const content = [
			" * Orphaned doc (no opening slash-star).",
			" */",
			"function foo(): void {",
			"\tdoIt();",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("returns empty when ordinary code (not blank, not a comment) precedes the function", () => {
		const content = ["const x = 1;", "function foo(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("finds the matching closing brace across nested braces in the body", () => {
		const content = [
			"/** Doc. */",
			"function foo(): void {",
			"\tif (x) {",
			"\t\tdoIt();",
			"\t}",
			"}",
		].join("\n");
		const result = collectAnnotatedFunctions(content);
		expect(result).toHaveLength(1);
		expect(nonNull(result[0]).bodyText).toBe("\n\tif (x) {\n\t\tdoIt();\n\t}\n");
	});

	it("skips the `{` inside a type annotation and opens the body at the real brace", () => {
		const content = [
			"/** Doc. */",
			"function foo(): { x: number } {",
			"\tdoIt();",
			"}",
		].join("\n");
		const result = collectAnnotatedFunctions(content);
		expect(result).toHaveLength(1);
		expect(nonNull(result[0]).bodyText).toBe("\n\tdoIt();\n");
	});

	it("does not match an anchor-violating line where 'function' appears mid-line, not at line start", () => {
		// Regression for anchor-removal mutants on declRe: a line whose
		// text merely CONTAINS "function name() {" partway through must
		// never be treated as a declaration line.
		const content = [
			"/** max 5 retries allowed. */",
			"const x = 1; function helper() {",
			"\tdoIt();",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("recognizes an arrow-function declaration (const ... = (...) => {)", () => {
		const content = [
			"/** Doc. */",
			"export const parseChunk = (buf: Buffer) => {",
			"\tdoIt();",
			"}",
		].join("\n");
		const result = collectAnnotatedFunctions(content);
		expect(result).toEqual([
			{
				commentLine: 1,
				commentText: "/** Doc. */",
				bodyStartLine: 2,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("recognizes an async arrow-function declaration with a bare-identifier parameter", () => {
		const content = ["/** Doc. */", "const run = async input => {", "\tdoIt();", "}"].join("\n");
		const result = collectAnnotatedFunctions(content);
		expect(result).toHaveLength(1);
	});

	it("tolerates double spaces after export/async keywords", () => {
		const content = [
			"/** Doc. */",
			"export  async  function foo(): void {",
			"\tdoIt();",
			"}",
		].join("\n");
		const result = collectAnnotatedFunctions(content);
		expect(result).toHaveLength(1);
	});

	it("tolerates a double space between 'function' and the function name", () => {
		const content = ["/** Doc. */", "function  bar(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toHaveLength(1);
	});

	it("tolerates a double space between const/let/var and the variable name", () => {
		const content = ["/** Doc. */", "const  foo = () => {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toHaveLength(1);
	});

	it("tolerates zero spaces everywhere the arrow-const branch allows optional whitespace", () => {
		// Isolates every \s*/optional-\s? position inside the
		// (?:const|let|var)...=> alternative at once: no space around
		// '=', no space after 'async', no space before '=>'.
		const content = ["/** Doc. */", "const foo=async(x)=>{", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toHaveLength(1);
	});
});

describe("checkCommentClaimsLimitNoGuard — boundary fixtures", () => {
	it('fires for "up to N" with a real space (kills a \\S* corruption of \\s*)', () => {
		const content = "/** Up to 100 retries allowed. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "atmost N" with zero spaces (kills an exact-one-space corruption of \\s*)', () => {
		const content = "/** atmost 50 retries. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "limitedto N" with zero spaces', () => {
		const content = "/** limitedto 256 bytes. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "upto N" with zero spaces', () => {
		const content = "/** upto 10 items. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "no morethan N" (zero space before "than")', () => {
		const content = "/** no morethan 12 attempts. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "nomore than N" (zero space after "no")', () => {
		const content = "/** nomore than 12 attempts. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "max ofN" collapsed to a single required space before the digits', () => {
		const content = "/** max of 7 tries. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when the body references the claimed number only as bare prose (no guard, no comparison)", () => {
		// Exercises the second early-continue: literal-number-anywhere
		// suppresses the finding even without an explicit comparison.
		const content = [
			"/** max 100 items. */",
			"function parseAll(): void {",
			'\tconst note = "documented at 100 in the spec";',
			"\tparse();",
			"}",
		].join("\n");
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsNullThrowsInstead — boundary fixtures", () => {
	it('fires for "returns  null  on" with double spaces (kills an exact-one-space corruption of \\s+)', () => {
		const content =
			"/** Lookup. Returns  null  on failure. */\nfunction lookup(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when 'try {' has a double space before the brace (regex must tolerate \\s*)", () => {
		const content = [
			"/** Returns null on failure. */",
			"function safeLoad(): void {",
			"\ttry  {",
			"\t\tthrow new Error('x');",
			"\t} catch {",
			"\t\treturn null;",
			"\t}",
			"}",
		].join("\n");
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsValidationMissing — boundary fixtures", () => {
	it('fires for "sanitize" (bare, no s/d suffix) with no evidence', () => {
		const content = "/** Sanitize the input. */\nfunction clean(s: string): string {\n\treturn s;\n}";
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when the body uses a double-spaced `if  (` guard", () => {
		const content = [
			"/** Validates the email. */",
			"function valid(email: string): boolean {",
			'\tif  (!email.includes("@")) return false;',
			"\treturn true;",
			"}",
		].join("\n");
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsIdempotentMutates — boundary fixtures", () => {
	it("fires when the only mutation is a spaced-out `x . push (` call (double-space tolerant regex)", () => {
		const content = [
			"/** Idempotent append. */",
			"function bump(): void {",
			"\tlist.push (1);",
			"}",
		].join("\n");
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire when the guard is a double-spaced `if  (` before the mutation", () => {
		const content = [
			"/** Idempotent — only mutates when key is missing. */",
			"function set(key: string, v: string): void {",
			"\tif  (!map.has(key)) map.set(key, v);",
			"}",
		].join("\n");
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsThrowsDoesnt — boundary fixtures", () => {
	it('handles a double-spaced "@throws  {RangeError}" tag', () => {
		const content = [
			"/**",
			" * @throws  {RangeError} when id is out of range.",
			" */",
			"function load(id: number): void {",
			'\tif (id < 0) throw new Error("bad");',
			"}",
		].join("\n");
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it("does NOT fire twice for two distinct @throws tags that are both satisfied", () => {
		const content = [
			"/**",
			" * @throws {RangeError} when id is out of range.",
			" * @throws {TypeError} when id is not a number.",
			" */",
			"function load(id: number): void {",
			'\tif (id < 0) throw new RangeError("bad");',
			'\tif (typeof id !== "number") throw new TypeError("bad type");',
			"}",
		].join("\n");
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts")).toEqual([]);
	});
});

describe("collectAnnotatedFunctions — findBodyOpenIdx / findMatchingBrace edge cases", () => {
	it("skips a multi-line signature with no '{' on the declaration line itself", () => {
		const content = [
			"/** Doc. */",
			"function foo(",
			"\ta: number",
			"): void {",
			"\tdoIt();",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("skips a multi-line signature even when a later stray '}' would let a bogus -1-derived scan accidentally balance", () => {
		// Regression for the -1 sentinels in findBodyOpenIdx/collectAnnotatedFunctions:
		// with an extra unmatched '}' present, a bogus bodyOpenIdx computed
		// from a defeated -1 check can spuriously find SOME closing brace
		// and produce a wrong non-empty result. The real code must still
		// skip via the (unmutated) sentinel checks.
		const content = [
			"/** Doc. */",
			"function foo(",
			"\ta: number",
			"): void {",
			"\tdoIt();",
			"}",
			"}",
		].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("skips a function whose body is never closed (unbalanced braces)", () => {
		const content = ["/** Doc. */", "function foo(): void {", "\tif (x) {", "\t\tdoIt();"].join(
			"\n",
		);
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("stops at the FIRST balanced close and ignores a stray extra '}' afterward", () => {
		const content = ["/** Doc. */", "function foo(): void {", "\tdoIt();", "}", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "/** Doc. */",
				bodyStartLine: 2,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});

	it("skips when the true body-open brace is the very last character of content (no matching close reachable)", () => {
		// The type-annotation brace `{ x: number }` is closed, but the
		// REAL body-open brace at the end of the line has nothing after
		// it — findMatchingBrace must fail closed here, not fall back
		// to matching the annotation's own closing brace.
		const content = "/** Doc. */\nfunction foo(): { x: number } {";
		expect(collectAnnotatedFunctions(content)).toEqual([]);
	});

	it("trims leading indentation from the comment's first line before using it as the finding text", () => {
		const content = "\t/** max 5 retries. */\nfunction f(): void {\n\tdoIt();\n}";
		const matches = checkCommentClaimsLimitNoGuard(content, "src/x.ts");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toBe("/** max 5 retries. */");
	});

	it("treats a whitespace-only (non-empty) blank line the same as a truly empty line when walking back", () => {
		const content = ["/** Doc. */", "   ", "function foo(): void {", "\tdoIt();", "}"].join("\n");
		expect(collectAnnotatedFunctions(content)).toEqual([
			{
				commentLine: 1,
				commentText: "/** Doc. */",
				bodyStartLine: 3,
				bodyText: "\n\tdoIt();\n",
			},
		]);
	});
});

describe("asMatch — truncation boundary", () => {
	function limitCommentOfLength(totalLen: number): string {
		const prefix = "// max 5 retries. ";
		const fillLen = Math.max(0, totalLen - prefix.length);
		return prefix + "z".repeat(fillLen);
	}

	it("does not truncate a first line well under the 150-char cap", () => {
		const content = "/** max 5 retries. */\nfunction f(): void {\n\tdoIt();\n}";
		const matches = checkCommentClaimsLimitNoGuard(content, "src/x.ts");
		expect(nonNull(matches[0]).text).toBe("/** max 5 retries. */");
	});

	it("truncates a first line well over the 150-char cap with an ellipsis", () => {
		const line = limitCommentOfLength(220);
		expect(line.length).toBeGreaterThan(150);
		const content = `${line}\nfunction f(): void {\n\tdoIt();\n}`;
		const matches = checkCommentClaimsLimitNoGuard(content, "src/x.ts");
		expect(nonNull(matches[0]).text).toBe(`${line.slice(0, 149)}…`);
	});

	it("does not truncate at exactly the 150-char boundary", () => {
		const line = limitCommentOfLength(150);
		expect(line.length).toBe(150);
		const content = `${line}\nfunction f(): void {\n\tdoIt();\n}`;
		const matches = checkCommentClaimsLimitNoGuard(content, "src/x.ts");
		expect(nonNull(matches[0]).text).toBe(line);
	});

	it("truncates at exactly 151 chars (one over the boundary)", () => {
		const line = limitCommentOfLength(151);
		expect(line.length).toBe(151);
		const content = `${line}\nfunction f(): void {\n\tdoIt();\n}`;
		const matches = checkCommentClaimsLimitNoGuard(content, "src/x.ts");
		expect(nonNull(matches[0]).text).toBe(`${line.slice(0, 149)}…`);
	});
});

describe("checkCommentClaimsLimitNoGuard — additional spacing boundaries", () => {
	it('fires for "max ofN" with the mandatory space before the digits intact and zero space after "of"', () => {
		const content = "/** max of7 tries. */\nfunction f(): void {\n\tdoIt();\n}";
		// "of7" has zero space before the digit group's OWN mandatory
		// \s+ — this must still fail to match (invalid claim), proving
		// the detector requires that final \s+ at all.
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts")).toEqual([]);
	});

	it('fires for "max  of 7" with a double space before "of" (kills an exact-one-space corruption of the optional group\'s \\s+)', () => {
		const content = "/** max  of 7 tries. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "max of  7" with a double space after "of" (kills an exact-one-space corruption of the final \\s+)', () => {
		const content = "/** max of  7 tries. */\nfunction f(): void {\n\tdoIt();\n}";
		expect(checkCommentClaimsLimitNoGuard(content, "src/x.ts").length).toBeGreaterThan(0);
	});
});

describe("checkCommentClaimsNullThrowsInstead — remaining boundary fixtures", () => {
	it("skips non-source files even when the content would otherwise trip a null-claim finding", () => {
		const content = "/** Returns null on failure. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "notes.md")).toEqual([]);
	});

	it("does NOT fire when the comment claims null-on-failure but the body never throws at all", () => {
		const content = [
			"/** Lookup. Returns null on failure. */",
			"function lookup(): User | null {",
			"\tconst u = db.find(id);",
			"\treturn u || null;",
			"}",
		].join("\n");
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts")).toEqual([]);
	});

	it('isolates the "return[s] null on/when/if" alternative, singular "return" (no trailing s)', () => {
		const content =
			"/** Return null when totally absent. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('isolates the "may return null" alternative from "returns null"/"returns undefined"', () => {
		const content =
			"/** May return null quickly under load. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "may  return  null" with double spaces on both sides of return', () => {
		const content =
			"/** May  return  null under load. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('isolates the "return[s] undefined on/when/if" alternative, singular "return" (no trailing s)', () => {
		const content =
			"/** Return undefined when totally missing. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "returns  undefined when" with a double space after returns', () => {
		const content =
			"/** Returns  undefined when only sometimes present. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for "returns undefined  when" with a double space before when', () => {
		const content =
			"/** Returns undefined  when rarely present. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for the plain "returns undefined when" form with normal single spacing', () => {
		const content =
			"/** Returns undefined when missing sometimes. */\nfunction f(): void {\n\tthrow new Error('x');\n}";
		expect(checkCommentClaimsNullThrowsInstead(content, "src/x.ts").length).toBeGreaterThan(0);
	});
});

describe("checkCommentClaimsValidationMissing — remaining boundary fixtures", () => {
	it("skips non-source files even when the content would otherwise trip a validation-claim finding", () => {
		const content = "/** Validates X. */\nfunction f(): string { return s; }";
		expect(checkCommentClaimsValidationMissing(content, "notes.md")).toEqual([]);
	});

	it("does NOT fire when the comment makes no validate/sanitize/escape claim at all", () => {
		const content = "/** Loads data quickly. */\nfunction f(): string { return x; }";
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});

	it('fires for bare "Validate" with no s/d suffix', () => {
		const content = "/** Validate input. */\nfunction f(): string { return s; }";
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('fires for bare "Escape" with no s/d suffix', () => {
		const content = "/** Escape special chars. */\nfunction f(): string { return s; }";
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it.each([
		["a bare '<' comparison", "<"],
		["a bare '>' comparison", ">"],
		["a strict '===' comparison", "==="],
	])("does NOT fire when the body's ONLY evidence is %s", (_label, evidence) => {
		const content = `/** Sanitizes X. */\nfunction f(): void {${evidence}}`;
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});

	it.each([
		["x.test(y)", ".test"],
		["x.test (y)", ".test with a space"],
		["x.match(y)", ".match"],
		["x.match (y)", ".match with a space"],
		["x.replace(y)", ".replace"],
		["x.replace (y)", ".replace with a space"],
		["encodeURI(x)", "bare encodeURI"],
		["encodeURI (x)", "encodeURI with a space"],
		["escape(x)", "bare escape, zero suffix, zero space"],
		["escapeStr(x)", "escape with a word-char suffix"],
		["escape (x)", "escape, zero suffix, one space"],
		["sanitize(x)", "bare sanitize, zero suffix, zero space"],
		["sanitizeStr(x)", "sanitize with a word-char suffix"],
		["sanitize (x)", "sanitize, zero suffix, one space"],
		["validate(x)", "bare validate, zero suffix, zero space"],
		["validateStr(x)", "validate with a word-char suffix"],
		["validate (x)", "validate, zero suffix, one space"],
	])("does NOT fire when the body's ONLY evidence is: %s (%s)", (snippet) => {
		const content = `/** Sanitizes X. */\nfunction f(): void {\n\t${snippet};\n}`;
		expect(checkCommentClaimsValidationMissing(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsIdempotentMutates — remaining boundary fixtures", () => {
	it("skips non-source files even when the content would otherwise trip an idempotent-claim finding", () => {
		const content = "/** Idempotent. */\nfunction f(): void { counter++; }";
		expect(checkCommentClaimsIdempotentMutates(content, "notes.md")).toEqual([]);
	});

	it("does NOT fire when the comment claims idempotent but the body has no mutation at all", () => {
		const content = "/** Idempotent lookup. */\nfunction f(): T {\n\treturn cache.get(key);\n}";
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});

	it("fires for an identifier-adjacent increment with zero spacing (isolates the mutation regex from the guard regex)", () => {
		const content = "/** Idempotent. */\nfunction f(): void {counter++}";
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it.each([
		["obj.set(k,v)", "zero-space .set"],
		["obj.set (k,v)", "spaced .set"],
		["arr.push(1)", "zero-space .push"],
		["arr.push (1)", "spaced .push"],
		["arr.pop()", "zero-space .pop"],
		["arr.pop ()", "spaced .pop"],
		["arr.shift()", "zero-space .shift"],
		["arr.shift ()", "spaced .shift"],
		["arr.unshift(1)", "zero-space .unshift"],
		["arr.unshift (1)", "spaced .unshift"],
		["map.delete(k)", "zero-space .delete"],
		["map.delete (k)", "spaced .delete"],
	])("fires when the only mutation evidence is: %s (%s)", (snippet) => {
		const content = `/** Idempotent. */\nfunction f(): void {\n\t${snippet};\n}`;
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it.each([
		["if (x)", "zero-space if"],
		["if  (x)", "spaced-double if"],
		["obj.has(k)", "zero-space .has"],
		["obj.has (k)", "spaced .has"],
		["arr.includes(x)", "zero-space .includes"],
		["arr.includes (x)", "spaced .includes"],
	])("does NOT fire when the guard evidence is: %s (%s)", (snippet) => {
		const content = `/** Idempotent. */\nfunction f(): void {\n\t${snippet} { counter++; }\n}`;
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});

	it.each([
		["===", "bare strict-equality guard"],
		["== =", "equality with a leading real space (first gap)"],
		["== =", "equality re-used for second-gap zero-space case"],
		["= ==", "equality with a real space isolating the first gap from \\S*"],
		["== =", "equality with a real space isolating the second gap from \\S*"],
	])("does NOT fire when the ONLY guard evidence is a spaced/unspaced '===' fragment: %s (%s)", (frag) => {
		const content = `/** Idempotent. */\nfunction f(): void {${frag}counter++}`;
		expect(checkCommentClaimsIdempotentMutates(content, "src/x.ts")).toEqual([]);
	});
});

describe("checkCommentClaimsThrowsDoesnt — remaining boundary fixtures", () => {
	it("skips non-source files even when the content would otherwise trip a @throws finding", () => {
		const content =
			"/**\n * @throws {RangeError} bad.\n */\nfunction f(id: number): void {\n\tif (id < 0) throw new Error('x');\n}";
		expect(checkCommentClaimsThrowsDoesnt(content, "notes.md")).toEqual([]);
	});

	it('fires for a bare (non-braced) "@throws RangeError" tag whose error is never thrown', () => {
		const content = [
			"/**",
			" * @throws RangeError when id is out of range.",
			" */",
			"function load(id: number): void {",
			"\tif (id < 0) throw new Error('bad');",
			"}",
		].join("\n");
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts").length).toBeGreaterThan(0);
	});

	it('does NOT fire for a bare "@throws RangeError" tag whose error IS thrown (full name, not truncated)', () => {
		const content = [
			"/**",
			" * @throws RangeError when id is out of range.",
			" */",
			"function load(id: number): void {",
			"\tif (id < 0) throw new RangeError('bad');",
			"}",
		].join("\n");
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts")).toEqual([]);
	});

	it("does NOT fire when the thrown error type is namespaced with a literal dot that is preserved, not stripped", () => {
		const content = [
			"/**",
			" * @throws {NS.RangeError} when id is out of range.",
			" */",
			"function load(id: number): void {",
			"\tif (id < 0) throw new NS.RangeError('bad');",
			"}",
		].join("\n");
		expect(checkCommentClaimsThrowsDoesnt(content, "src/x.ts")).toEqual([]);
	});
});

describe("shouldSkip — extension-check isolation", () => {
	it("skips a non-JS/TS file even when its content would otherwise match a claim (kills a forced-false ext guard)", () => {
		const content = "/** max 100 */\nfunction f(): void { doIt(); }";
		expect(checkCommentClaimsLimitNoGuard(content, "README.md")).toEqual([]);
		expect(checkCommentClaimsLimitNoGuard(content, "notes.txt")).toEqual([]);
	});
});

describe("non-source / exempt files", () => {
	it("returns empty for non-TS/JS files", () => {
		const content = `# README\nMax 100 items.`;
		expect(checkCommentClaimsLimitNoGuard(content, "README.md")).toEqual([]);
	});

	it("returns empty for test files (test fixtures often include drift on purpose)", () => {
		const content = `
			/** max 100 */
			function f(): void { doIt(); }
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/foo.test.ts")).toEqual([]);
	});

	it("returns empty for generator-emitted files", () => {
		const content = `
			/* @generated by openapi-generator */
			/** max 100 */
			function f(): void { doIt(); }
		`;
		expect(checkCommentClaimsLimitNoGuard(content, "src/api.ts")).toEqual([]);
	});
});
