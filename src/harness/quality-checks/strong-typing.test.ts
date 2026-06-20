import { describe, expect, it } from "vitest";
import { findAnyTypes, stripStringLiterals } from "./strong-typing.js";
import { nonNull } from "../../lib/non-null.js";

describe("findAnyTypes", () => {
	it("flags explicit `: any` type annotations", () => {
		const out = findAnyTypes("const x: any = 1;");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).kind).toBe("any");
	});

	it("flags `as any` casts", () => {
		const out = findAnyTypes("const x = foo as any;");
		expect(out[0]?.kind).toBe("any");
	});

	it("flags `as unknown` escape hatches", () => {
		const out = findAnyTypes("const x = foo as unknown as Bar;");
		expect(out[0]?.kind).toBe("unknown");
	});

	it("ignores `any`/`unknown` inside string literals", () => {
		const out = findAnyTypes('const s = "do not use as any or as unknown";');
		expect(out.length).toBe(0);
	});

	it("ignores `any`/`unknown` inside regex literals — self-reference guard", () => {
		// Regression test for the bug where the strong_typing check flagged
		// its own detector file because RECORD_ANY contains `(?:any|unknown)`.
		const src = [
			"const RECORD_ANY = /\\bRecord\\s*<\\s*[\\w.|&\\s]+,\\s*(?:any|unknown)\\s*>/;",
			"const INDEX_ANY = /\\{\\s*\\[\\s*\\w+\\s*:\\s*(?:string|number|symbol)\\s*\\]\\s*:\\s*(?:any|unknown)\\s*\\}/;",
		].join("\n");
		const out = findAnyTypes(src);
		expect(out.length).toBe(0);
	});

	it("ignores comment-only lines", () => {
		expect(findAnyTypes("// TODO: replace any with unknown").length).toBe(0);
		expect(findAnyTypes("/* `any` appears in docs */").length).toBe(0);
	});
});

describe("stripStringLiterals", () => {
	it("replaces double-quoted string content", () => {
		expect(stripStringLiterals('a = "hello"')).toBe('a = ""');
	});

	it("replaces single-quoted string content", () => {
		expect(stripStringLiterals("a = 'hi'")).toBe("a = ''");
	});

	it("replaces backtick template content (single-line)", () => {
		const bt = String.fromCharCode(96);
		expect(stripStringLiterals(`a = ${bt}yo${bt}`)).toBe(`a = ${bt}${bt}`);
	});

	it("preserves surrounding code", () => {
		expect(stripStringLiterals('const x = "y"; return x;')).toBe('const x = ""; return x;');
	});
});
