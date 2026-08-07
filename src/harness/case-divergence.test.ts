import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetTsCacheForTesting,
	__setTsRequirerForTesting,
	analyzeSymbols,
	caseDivergenceAvailable,
	classifyStyle,
	extractTopLevelSymbols,
	MIN_CORE_LEN,
	normalizeCore,
	runCaseDivergenceCheck,
	type SymbolLoc,
} from "./case-divergence.js";

afterEach(() => {
	__setTsRequirerForTesting(null);
});

const sym = (name: string, kind: SymbolLoc["kind"], file = "a.ts"): SymbolLoc => ({
	name,
	kind,
	file,
	line: 1,
});

describe("normalizeCore", () => {
	it("folds case and internal separators to a common core", () => {
		expect(normalizeCore("userId").core).toBe("userid");
		expect(normalizeCore("user_id").core).toBe("userid");
		expect(normalizeCore("USER_ID").core).toBe("userid");
		expect(normalizeCore("user-id").core).toBe("userid");
	});
	it("keeps leading underscores significant (separated from the core)", () => {
		expect(normalizeCore("_userId")).toEqual({ lead: "_", core: "userid" });
		expect(normalizeCore("__foo")).toEqual({ lead: "__", core: "foo" });
		expect(normalizeCore("userId").lead).toBe("");
	});
});

describe("classifyStyle", () => {
	it("classifies the standard case styles", () => {
		expect(classifyStyle("userId")).toBe("camelCase");
		expect(classifyStyle("user_id")).toBe("snake_case");
		expect(classifyStyle("UserId")).toBe("PascalCase");
		expect(classifyStyle("MAX_LINES")).toBe("SCREAMING_SNAKE");
		expect(classifyStyle("BLOCK")).toBe("SCREAMING_SNAKE");
		expect(classifyStyle("userid")).toBe("flatcase");
		expect(classifyStyle("user-id")).toBe("kebab-case");
	});
	it("ignores leading underscores when classifying", () => {
		expect(classifyStyle("_userId")).toBe("camelCase");
		expect(classifyStyle("__MAX_LINES")).toBe("SCREAMING_SNAKE");
	});
	it("returns 'other' for empty cores and malformed mixed names", () => {
		expect(classifyStyle("___")).toBe("other");
		expect(classifyStyle("Foo_bar")).toBe("other");
	});
});

describe("analyzeSymbols — positives (genuine case divergence → flagged)", () => {
	it("flags a cross-file camelCase vs snake_case value divergence", () => {
		const f = analyzeSymbols([sym("userId", "const", "a.ts"), sym("user_id", "function", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.core).toBe("userid");
		expect(f[0]?.role).toBe("value");
		expect(f[0]?.spellings.map((s) => s.name).sort()).toEqual(["userId", "user_id"]);
	});
	it("flags camelCase vs flatcase among functions", () => {
		const f = analyzeSymbols([sym("parseUrl", "function", "a.ts"), sym("parseurl", "function", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.core).toBe("parseurl");
	});
	it("flags a PascalCase vs snake_case divergence among TYPE symbols", () => {
		const f = analyzeSymbols([sym("UserId", "type", "a.ts"), sym("user_id", "interface", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.role).toBe("type");
	});
	it("flags two SCREAMING_SNAKE constants that differ only by separator", () => {
		const f = analyzeSymbols([sym("USERID", "const", "a.ts"), sym("USER_ID", "const", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.spellings.map((s) => s.name).sort()).toEqual(["USERID", "USER_ID"]);
	});
	it("emits multiple findings (sorted by core) and lists every location of a spelling", () => {
		const f = analyzeSymbols([
			sym("userId", "const", "a.ts"),
			sym("userId", "const", "b.ts"),
			sym("user_id", "function", "c.ts"),
			sym("fooBar", "function", "a.ts"),
			sym("foo_bar", "function", "b.ts"),
		]);
		expect(f.map((x) => x.core)).toEqual(["foobar", "userid"]);
		const userIdEntry = f
			.find((x) => x.core === "userid")
			?.spellings.find((s) => s.name === "userId");
		expect(userIdEntry?.locs).toHaveLength(2);
	});
});

describe("analyzeSymbols — negatives (intentional convention → NOT flagged)", () => {
	it("does NOT flag a SCREAMING constant next to a camelCase variable", () => {
		expect(analyzeSymbols([sym("MAX_LINES", "const", "a.ts"), sym("maxLines", "let", "b.ts")])).toEqual([]);
	});
	it("does NOT flag a PascalCase type next to a camelCase value (role split)", () => {
		expect(analyzeSymbols([sym("User", "type", "a.ts"), sym("user", "const", "b.ts")])).toEqual([]);
	});
	it("does NOT flag the idiomatic class + instance pair", () => {
		expect(
			analyzeSymbols([sym("TrigramIndex", "class", "a.ts"), sym("trigramIndex", "const", "b.ts")]),
		).toEqual([]);
	});
	it("does NOT flag names that differ only by a leading underscore", () => {
		expect(analyzeSymbols([sym("_userId", "const", "a.ts"), sym("userId", "const", "b.ts")])).toEqual([]);
	});
	it("does NOT flag the same spelling repeated across files", () => {
		expect(analyzeSymbols([sym("userId", "const", "a.ts"), sym("userId", "const", "b.ts")])).toEqual([]);
	});
	it("does NOT flag cores shorter than MIN_CORE_LEN", () => {
		expect(analyzeSymbols([sym("id", "const", "a.ts"), sym("ID", "const", "b.ts")])).toEqual([]);
	});
});

const EXTRACT_SRC = [
	"export function foo() { function nested() {} }",
	"const bar = 1, baz = 2;",
	"export class Cls {}",
	"export type T = string;",
	"interface I { x: number }",
	"enum E { A }",
	"let mut = 3;",
	"var legacy = 4;",
].join("\n");

describe("extractTopLevelSymbols", () => {
	it("captures top-level declarations and ignores nested ones", () => {
		const names = extractTopLevelSymbols(ts, EXTRACT_SRC, "x.ts").map((s) => s.name);
		expect(names).toEqual(
			expect.arrayContaining(["foo", "bar", "baz", "Cls", "T", "I", "E", "mut", "legacy"]),
		);
		expect(names).not.toContain("nested");
	});
	it("records value-symbol kinds (function / const / let / var)", () => {
		const syms = extractTopLevelSymbols(ts, EXTRACT_SRC, "x.ts");
		expect(syms.find((s) => s.name === "foo")?.kind).toBe("function");
		expect(syms.find((s) => s.name === "bar")?.kind).toBe("const");
		expect(syms.find((s) => s.name === "mut")?.kind).toBe("let");
		expect(syms.find((s) => s.name === "legacy")?.kind).toBe("var");
	});
	it("records type-symbol kinds (class / type / interface / enum)", () => {
		const syms = extractTopLevelSymbols(ts, EXTRACT_SRC, "x.ts");
		expect(syms.find((s) => s.name === "Cls")?.kind).toBe("class");
		expect(syms.find((s) => s.name === "T")?.kind).toBe("type");
		expect(syms.find((s) => s.name === "I")?.kind).toBe("interface");
		expect(syms.find((s) => s.name === "E")?.kind).toBe("enum");
	});
	it("parses tsx / jsx / js by file extension", () => {
		expect(extractTopLevelSymbols(ts, "export const X = <div/>;", "c.tsx").map((s) => s.name)).toContain("X");
		expect(extractTopLevelSymbols(ts, "export const Z = 1;", "c.jsx").map((s) => s.name)).toContain("Z");
		expect(extractTopLevelSymbols(ts, "export const Y = 1;", "c.js").map((s) => s.name)).toContain("Y");
	});
});

describe("runCaseDivergenceCheck (integration over real files)", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("flags a cross-file camelCase/snake_case value divergence", () => {
		dir = mkdtempSync(join(tmpdir(), "casediv-"));
		writeFileSync(join(dir, "a.ts"), "export const userAge = 1;\n");
		writeFileSync(join(dir, "b.ts"), "export function user_age() { return 2; }\n");
		const findings = runCaseDivergenceCheck(dir, [join(dir, "a.ts"), join(dir, "b.ts")]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.core).toBe("userage");
		expect(findings[0]?.files.slice().sort()).toEqual(["a.ts", "b.ts"]);
	});

	it("excludes test files from the comparison", () => {
		dir = mkdtempSync(join(tmpdir(), "casediv-"));
		writeFileSync(join(dir, "a.ts"), "export const userAge = 1;\n");
		writeFileSync(join(dir, "a.test.ts"), "export const user_age = 2;\n");
		const findings = runCaseDivergenceCheck(dir, [join(dir, "a.ts"), join(dir, "a.test.ts")]);
		expect(findings).toHaveLength(0);
	});

	it("skips vendored, generated, non-JS/TS, and unreadable paths", () => {
		const cwd = "/repo";
		const files = [
			"/repo/node_modules/x.ts",
			"/repo/dist/b.ts",
			"/repo/foo.d.ts",
			"/repo/src/__tests__/a.ts",
			"/repo/x.test.ts",
			"/repo/readme.md",
			"/repo/ghost.ts",
		];
		expect(runCaseDivergenceCheck(cwd, files)).toEqual([]);
	});
});

describe("loadTs caching (via caseDivergenceAvailable)", () => {
	afterEach(() => {
		__setTsRequirerForTesting(null);
		__resetTsCacheForTesting();
	});

	it("resolves the requirer only once across repeated calls (cache hit)", () => {
		let calls = 0;
		__setTsRequirerForTesting(() => {
			calls++;
			return ts;
		});
		expect(caseDivergenceAvailable()).toBe(true);
		expect(caseDivergenceAvailable()).toBe(true);
		expect(caseDivergenceAvailable()).toBe(true);
		expect(calls).toBe(1);
	});

	it("__resetTsCacheForTesting actually clears the cache, forcing re-resolution", () => {
		let calls = 0;
		__setTsRequirerForTesting(() => {
			calls++;
			return ts;
		});
		expect(caseDivergenceAvailable()).toBe(true);
		expect(calls).toBe(1);
		__resetTsCacheForTesting();
		expect(caseDivergenceAvailable()).toBe(true);
		expect(calls).toBe(2);
	});
});

describe("classifyStyle — regex/logic boundary cases", () => {
	it("does not misclassify an all-digit/underscore segment lacking any letter as SCREAMING_SNAKE", () => {
		// No uppercase letter present, so the SCREAMING_SNAKE branch must not fire;
		// falls through to the snake_case check instead.
		expect(classifyStyle("123_456")).toBe("snake_case");
	});
	it("requires the WHOLE string to be uppercase/digits/underscore, not just a trailing run", () => {
		expect(classifyStyle("MAX.LINES")).toBe("PascalCase");
	});
	it("requires the WHOLE string to be uppercase/digits/underscore, not just a leading run", () => {
		expect(classifyStyle("MAX!")).toBe("PascalCase");
	});
	it("rejects a snake_case segment that only partially matches (anchored on both ends)", () => {
		expect(classifyStyle("abc_de!f")).toBe("other");
	});
});

describe("extractTopLevelSymbols — line numbers and non-declaration statements", () => {
	it("reports the correct 1-based source line for each declaration", () => {
		const src = ["", "export const first = 1;", "", "export function second() {}"].join("\n");
		const syms = extractTopLevelSymbols(ts, src, "x.ts");
		expect(syms.find((s) => s.name === "first")?.line).toBe(2);
		expect(syms.find((s) => s.name === "second")?.line).toBe(4);
	});
	it("does not crash on and silently skips non-declaration top-level statements (import/expression)", () => {
		const src = ['import Foo from "foo";', "Foo();", "export const bar = 1;"].join("\n");
		const syms = extractTopLevelSymbols(ts, src, "x.ts");
		expect(syms.map((s) => s.name)).toEqual(["bar"]);
	});
	it("ignores destructured variable declarations (name is not a plain identifier)", () => {
		const src = "const [a, b] = [1, 2];\nconst { c } = { c: 3 };\nconst d = 4;";
		const syms = extractTopLevelSymbols(ts, src, "x.ts");
		expect(syms.map((s) => s.name)).toEqual(["d"]);
	});
});

describe("analyzeSymbols — message text, location ordering, and file list (exact-value)", () => {
	it("builds the exact divergence message for a two-way spelling split", () => {
		const f = analyzeSymbols([sym("userId", "const", "a.ts"), sym("user_id", "function", "b.ts")]);
		expect(f[0]?.message).toBe(
			'"userId" / "user_id" — same value name in 2 case spellings; reconcile to one',
		);
	});
	it("orders each spelling's locations by file then by line", () => {
		const f = analyzeSymbols([
			sym("userId", "const", "b.ts"),
			{ name: "userId", kind: "const", file: "a.ts", line: 9 },
			{ name: "userId", kind: "const", file: "a.ts", line: 2 },
			sym("user_id", "function", "c.ts"),
		]);
		const locs = f[0]?.spellings.find((s) => s.name === "userId")?.locs;
		expect(locs).toEqual([
			{ file: "a.ts", line: 2, kind: "const" },
			{ file: "a.ts", line: 9, kind: "const" },
			{ file: "b.ts", line: 1, kind: "const" },
		]);
	});
	it("records the exact kind on each location entry", () => {
		const f = analyzeSymbols([sym("userId", "const", "a.ts"), sym("user_id", "function", "b.ts")]);
		const locs = f[0]?.spellings.find((s) => s.name === "user_id")?.locs;
		expect(locs).toEqual([{ file: "b.ts", line: 1, kind: "function" }]);
	});
	it("dedupes the files list and returns it sorted, unaffected by insertion/duplicate order", () => {
		const f = analyzeSymbols([
			sym("userId", "const", "z.ts"),
			sym("userId", "const", "z.ts"),
			sym("user_id", "function", "a.ts"),
		]);
		expect(f[0]?.files).toEqual(["a.ts", "z.ts"]);
	});
	it("flags only the regular-case pair, excluding a lone SCREAMING sibling of the same core", () => {
		const f = analyzeSymbols([
			sym("fooBar", "function", "a.ts"),
			sym("foo_bar", "function", "b.ts"),
			sym("FOO_BAR", "function", "c.ts"),
		]);
		expect(f).toHaveLength(1);
		expect(f[0]?.spellings.map((s) => s.name).sort()).toEqual(["fooBar", "foo_bar"]);
	});
	it("flags only the SCREAMING pair, excluding a lone regular sibling of the same core", () => {
		const f = analyzeSymbols([
			sym("FOOBAR", "const", "a.ts"),
			sym("FOO_BAR", "const", "b.ts"),
			sym("fooBar", "const", "c.ts"),
		]);
		expect(f).toHaveLength(1);
		expect(f[0]?.spellings.map((s) => s.name).sort()).toEqual(["FOOBAR", "FOO_BAR"]);
	});
});

describe("analyzeSymbols — ROLE mapping covers every SymbolKind", () => {
	it("groups let and var together with the 'value' role (not just const/function)", () => {
		const f = analyzeSymbols([sym("userId", "let", "a.ts"), sym("user_id", "var", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.role).toBe("value");
	});
	it("groups class and enum together with the 'type' role (not just type/interface)", () => {
		const f = analyzeSymbols([sym("UserId", "class", "a.ts"), sym("User_Id", "enum", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.role).toBe("type");
	});
});

describe("runCaseDivergenceCheck — every JS/TS extension in JS_TS_EXTS is recognized", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});
	it("scans .mjs and .cts files (not just .ts/.js)", () => {
		dir = mkdtempSync(join(tmpdir(), "casediv-"));
		writeFileSync(join(dir, "a.mjs"), "export const userAge = 1;\n");
		writeFileSync(join(dir, "b.cts"), "export const user_age = 2;\n");
		const findings = runCaseDivergenceCheck(dir, [join(dir, "a.mjs"), join(dir, "b.cts")]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.core).toBe("userage");
	});
});

describe("analyzeSymbols — MIN_CORE_LEN boundary (exact)", () => {
	it("does NOT flag a same-family divergence whose core is 1 below MIN_CORE_LEN", () => {
		// core "ab" has length 2 (MIN_CORE_LEN - 1); both spellings are 'regular' family.
		expect(analyzeSymbols([sym("ab", "const", "a.ts"), sym("aB", "const", "b.ts")])).toEqual([]);
	});
	it("DOES flag a same-family divergence whose core is exactly MIN_CORE_LEN", () => {
		// core "abc" has length 3 === MIN_CORE_LEN; must not be skipped.
		const f = analyzeSymbols([sym("abc", "const", "a.ts"), sym("aBc", "const", "b.ts")]);
		expect(f).toHaveLength(1);
		expect(f[0]?.core).toBe("abc");
	});
});

describe("runCaseDivergenceCheck — path exclusion edge cases (real files)", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("excludes .test.cts files (regex must match the cm-optional infix, not negate it)", () => {
		dir = mkdtempSync(join(tmpdir(), "casediv-"));
		writeFileSync(join(dir, "a.ts"), "export const userAge = 1;\n");
		writeFileSync(join(dir, "a.test.cts"), "export const user_age = 2;\n");
		const findings = runCaseDivergenceCheck(dir, [join(dir, "a.ts"), join(dir, "a.test.cts")]);
		expect(findings).toEqual([]);
	});

	it("excludes a path whose separators are backslashes once normalized to forward slashes", () => {
		dir = mkdtempSync(join(tmpdir(), "casediv-"));
		writeFileSync(join(dir, "a.ts"), "export const userAge = 1;\n");
		// A single filename component containing literal backslashes — valid on POSIX
		// filesystems — that only reads as an excluded __tests__ path after the
		// backslash-to-forward-slash normalization runs.
		const weirdName = "weird\\__tests__\\user_age.ts";
		writeFileSync(join(dir, weirdName), "export const user_age = 2;\n");
		const findings = runCaseDivergenceCheck(dir, [join(dir, "a.ts"), join(dir, weirdName)]);
		expect(findings).toEqual([]);
	});
});

describe("availability / dependency-absent degrade", () => {
	afterEach(() => {
		__setTsRequirerForTesting(null);
		__resetTsCacheForTesting();
	});

	it("reports typescript as available in dev", () => {
		__resetTsCacheForTesting();
		expect(caseDivergenceAvailable()).toBe(true);
		expect(MIN_CORE_LEN).toBeGreaterThanOrEqual(2);
	});

	it("no-ops (false / empty) when typescript cannot be resolved", () => {
		__setTsRequirerForTesting(() => {
			throw new Error("typescript not installed");
		});
		expect(caseDivergenceAvailable()).toBe(false);
		expect(runCaseDivergenceCheck("/repo", ["/repo/a.ts"])).toEqual([]);
	});
});
