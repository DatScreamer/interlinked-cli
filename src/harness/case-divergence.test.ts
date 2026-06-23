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
