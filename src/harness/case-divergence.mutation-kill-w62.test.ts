import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetTsCacheForTesting,
	__setTsRequirerForTesting,
	analyzeSymbols,
	classifyStyle,
	runCaseDivergenceCheck,
} from "./case-divergence.js";

let tmpDir: string;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
	// Always restore the real `typescript` resolver + clear the cache so later
	// tests are not affected by an earlier test's swapped requirer.
	__setTsRequirerForTesting(null);
	__resetTsCacheForTesting();
});

function freshDir(): string {
	tmpDir = mkdtempSync(join(tmpdir(), "case-div-w62-"));
	return tmpDir;
}

// --- positive (must fire) ---------------------------------------------

describe("classifyStyle — leading-underscore stripping (Regex mutant)", () => {
	it("strips ALL leading underscores before classifying, not just one", () => {
		// Original: /^_+/ strips both leading underscores -> "foo_bar" -> snake_case.
		// Mutant /^_/ strips only one -> "_foo_bar" -> first split segment is empty
		// -> classified as "other" instead.
		expect(classifyStyle("__foo_bar")).toBe("snake_case");
	});
});

describe("classifyStyle — snake_case segment validation (ConditionalExpression/EqualityOperator mutants)", () => {
	it("rejects a name with an empty segment (double underscore) as non-snake_case", () => {
		// seg.length > 0 must be a real check: "foo__bar" splits into
		// ["foo", "", "bar"]; the empty middle segment must fail the every().
		// A mutant that hardcodes `true` (or `>= 0`) accepts it as snake_case.
		expect(classifyStyle("foo__bar")).toBe("other");
	});
});

describe("analyzeSymbols — sorted spelling order (MethodExpression mutant on .sort())", () => {
	it("orders flagged spellings alphabetically, not by insertion order", () => {
		const symbols = [
			{ name: "user_id", kind: "const" as const, file: "a.ts", line: 1 },
			{ name: "userId", kind: "const" as const, file: "a.ts", line: 2 },
			{ name: "UserId", kind: "const" as const, file: "a.ts", line: 3 },
		];
		const findings = analyzeSymbols(symbols);
		expect(findings).toHaveLength(1);
		// Default JS sort() on these three strings: "UserId" < "userId" < "user_id"
		// (uppercase 'U' sorts before lowercase 'u'; at position 4, 'I' < '_').
		expect(findings[0]?.spellings.map((s) => s.name)).toEqual([
			"UserId",
			"userId",
			"user_id",
		]);
	});
});

describe("runCaseDivergenceCheck — isExcludedPath branches", () => {
	it('excludes .d.ts files from the scan (endsWith(".d.ts") mutants)', () => {
		const dir = freshDir();
		const a = join(dir, "a.ts");
		const b = join(dir, "b.d.ts");
		writeFileSync(a, "export const fooBarOne = 1;\n");
		writeFileSync(b, "export const foo_bar_one = 2;\n");
		const result = runCaseDivergenceCheck(dir, [a, b]);
		// b.d.ts must be excluded, leaving only one spelling -> no divergence.
		expect(result).toHaveLength(0);
	});

	it("excludes files under a __tests__ directory (Regex ^| mutant)", () => {
		const dir = freshDir();
		mkdirSync(join(dir, "__tests__"));
		const dup = join(dir, "__tests__", "dup.ts");
		const real = join(dir, "real2.ts");
		writeFileSync(dup, "export const fooBarTwo = 1;\n");
		writeFileSync(real, "export const foo_bar_two = 2;\n");
		const result = runCaseDivergenceCheck(dir, [dup, real]);
		expect(result).toHaveLength(0);
	});

	it("excludes files under node_modules at the scan root (Regex ^| + BooleanLiteral mutants)", () => {
		const dir = freshDir();
		mkdirSync(join(dir, "node_modules"));
		const pkg = join(dir, "node_modules", "pkg.ts");
		const real = join(dir, "real3.ts");
		writeFileSync(pkg, "export const fooBarThree = 1;\n");
		writeFileSync(real, "export const foo_bar_three = 2;\n");
		const result = runCaseDivergenceCheck(dir, [pkg, real]);
		expect(result).toHaveLength(0);
	});

	it("does not exclude a JS file merely nested under a dir named *.test.ts (Regex $ anchor mutant)", () => {
		const dir = freshDir();
		mkdirSync(join(dir, "foo.test.ts"));
		const legacy = join(dir, "foo.test.ts", "legacy.js");
		const other = join(dir, "other4.js");
		writeFileSync(legacy, "export const fooBarFour = 1;\n");
		writeFileSync(other, "export const foo_bar_four = 2;\n");
		const result = runCaseDivergenceCheck(dir, [legacy, other]);
		// legacy.js's own path does NOT end in .test.js/.test.ts — the $ anchor
		// means only a trailing match excludes; both symbols must be counted.
		expect(result).toHaveLength(1);
	});
});

describe("runCaseDivergenceCheck — ts-unavailable early return (ConditionalExpression mutant)", () => {
	it("returns [] without throwing when `typescript` cannot be resolved", () => {
		const dir = freshDir();
		const valid = join(dir, "valid.ts");
		writeFileSync(valid, "export const something = 1;\n");
		__setTsRequirerForTesting(() => {
			throw new Error("no ts available");
		});
		let result: unknown;
		expect(() => {
			result = runCaseDivergenceCheck(dir, [valid]);
		}).not.toThrow();
		expect(result).toEqual([]);
	});
});

describe("runCaseDivergenceCheck — extension filter (ConditionalExpression mutant)", () => {
	it("skips files whose extension is not in the recognized JS/TS set", () => {
		const dir = freshDir();
		const skip = join(dir, "skip.txt");
		const keep = join(dir, "keep5.ts");
		writeFileSync(skip, "export const fooBarFive = 1;\n");
		writeFileSync(keep, "export const foo_bar_five = 2;\n");
		const result = runCaseDivergenceCheck(dir, [skip, keep]);
		expect(result).toHaveLength(0);
	});
});

describe("runCaseDivergenceCheck — recognized extension set (StringLiteral mutants)", () => {
	it("recognizes .tsx, .cjs, .js, .jsx, and .mts as scannable extensions", () => {
		const dir = freshDir();
		const files: string[] = [];
		const pairs: Array<[string, string, string]> = [
			["tsx1.tsx", "tsx2.ts", "tsxval"],
			["cjs1.cjs", "cjs2.ts", "cjsval"],
			["js1.js", "js2.ts", "jsval"],
			["jsx1.jsx", "jsx2.ts", "jsxval"],
			["mts1.mts", "mts2.ts", "mtsval"],
		];
		for (const [primaryName, partnerName, core] of pairs) {
			const primary = join(dir, primaryName);
			const partner = join(dir, partnerName);
			// Same case-folded core ("tsxval"), two different case spellings —
			// PascalCase in the candidate-extension file, flatcase in the .ts partner.
			writeFileSync(primary, `export const ${core[0]?.toUpperCase()}${core.slice(1)} = 1;\n`);
			writeFileSync(partner, `export const ${core} = 2;\n`);
			files.push(primary, partner);
		}
		const result = runCaseDivergenceCheck(dir, files);
		const cores = result.map((f) => f.core).sort();
		expect(cores).toEqual(["cjsval", "jsval", "jsxval", "mtsval", "tsxval"]);
	});
});
