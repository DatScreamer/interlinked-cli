// Tests for the comment-vs-behavior drift detector — adaptation of
// Mythos's "spotting contradictions between code comments and actual
// behavior" pattern into deterministic regex+AST rules. Five narrow
// detectors, each with positive and negative cases.

import { describe, expect, it } from "vitest";
import {
	checkCommentClaimsIdempotentMutates,
	checkCommentClaimsLimitNoGuard,
	checkCommentClaimsNullThrowsInstead,
	checkCommentClaimsThrowsDoesnt,
	checkCommentClaimsValidationMissing,
} from "./comment-drift.js";
import { nonNull } from "../../lib/non-null.js";

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
