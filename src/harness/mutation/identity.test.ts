import { describe, expect, it } from "vitest";
import { computeSymbolHashes, deriveIdentities, mutationIdentityAvailable } from "./identity.js";
import type { MutantIdentity, RawMutant } from "./types.js";

const FILE = "src/example.ts";

interface RawSpec {
	needle: string;
	lexeme: string;
	replacement: string;
	mutator?: string;
}

/** Strict-safe positional access (the tsconfig's noUncheckedIndexedAccess is on). */
function nth<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`expected element ${i}`);
	return v;
}

/** A RawMutant whose token starts at the first occurrence of `spec.needle`. */
function rawAt(content: string, spec: RawSpec): RawMutant {
	const idx = content.indexOf(spec.needle);
	if (idx < 0) throw new Error(`needle not found: ${spec.needle}`);
	return {
		file: FILE,
		mutator: spec.mutator ?? "RelationalOperator",
		originalLexeme: spec.lexeme,
		replacement: spec.replacement,
		startOffset: idx,
	};
}

/** Derive identities for `specs` against `content`, asserting the dep is present. */
function derive(content: string, specs: RawSpec[]): MutantIdentity[] {
	const ids = deriveIdentities(
		FILE,
		content,
		specs.map((s) => rawAt(content, s)),
	);
	if (!ids) throw new Error("typescript unavailable — identity derivation returned null");
	return ids;
}

describe("mutationIdentityAvailable", () => {
	it("is true when the optional typescript dep is present", () => {
		expect(mutationIdentityAvailable()).toBe(true);
	});
});

describe("deriveIdentities", () => {
	const SRC_A = `function bar(x: number): boolean {\n  return x > 0 && x < 10;\n}\n`;
	const GT: RawSpec = { needle: "> 0", lexeme: ">", replacement: ">=" };

	it("is deterministic", () => {
		expect(derive(SRC_A, [GT])).toEqual(derive(SRC_A, [GT]));
	});

	it("anchors identity to the enclosing symbol, not the line — invariant under edits above", () => {
		const SRC_B = `function unrelated(): void {\n  // padding that shifts every offset below\n  return;\n}\n\n${SRC_A}`;
		expect(SRC_B.indexOf("> 0")).not.toBe(SRC_A.indexOf("> 0")); // the raw offset really did move

		const idA = nth(derive(SRC_A, [GT]), 0);
		const idB = nth(derive(SRC_B, [GT]), 0);
		expect(idB.symbolId).toBe(idA.symbolId);
		expect(idB.siteId).toBe(idA.siteId);
		expect(idB.mutantId).toBe(idA.mutantId);
		expect(idB.qualifiedName).toBe("bar");
	});

	it("distinguishes site (lexeme) from mutant (replacement)", () => {
		const ids = derive(SRC_A, [
			GT,
			{ needle: "< 10", lexeme: "<", replacement: "<=" },
			{ needle: "> 0", lexeme: ">", replacement: "<" }, // same token as GT, different replacement
		]);
		const gt = nth(ids, 0);
		const lt = nth(ids, 1);
		const gt2 = nth(ids, 2);
		expect(lt.siteId).not.toBe(gt.siteId); // different lexeme → different site
		expect(gt2.siteId).toBe(gt.siteId); // same token offset → same site
		expect(gt2.mutantId).not.toBe(gt.mutantId); // different replacement → different mutant
	});

	it("ranks identical operators by source order and keeps it stable under shift", () => {
		const TWO = `function twogt(a: number, b: number, c: number): boolean {\n  return a > b && b > c;\n}\n`;
		const first: RawSpec = { needle: "> b", lexeme: ">", replacement: ">=" };
		const second: RawSpec = { needle: "> c", lexeme: ">", replacement: ">=" };
		const ids = derive(TWO, [first, second]);
		const f = nth(ids, 0);
		const s = nth(ids, 1);
		expect(f.ordinalWithinSymbol).toBe(0);
		expect(s.ordinalWithinSymbol).toBe(1);
		expect(f.siteId).not.toBe(s.siteId);

		const SHIFTED = `// leading comment\n\n${TWO}`;
		const shifted = derive(SHIFTED, [first, second]);
		expect(nth(shifted, 0).siteId).toBe(f.siteId);
		expect(nth(shifted, 1).siteId).toBe(s.siteId);
	});
});

describe("computeSymbolHashes", () => {
	function onlyEntry(content: string): { qualifiedName: string; symbolHash: string } {
		const map = computeSymbolHashes(FILE, content);
		if (!map) throw new Error("typescript unavailable");
		return nth([...map.values()], 0);
	}

	it("is stable under reformatting (operator spacing + comments)", () => {
		const tight = onlyEntry(`function bar(x: number){return x>0;}`);
		const loose = onlyEntry(`function bar(x: number) {\n  // a comment\n  return x > 0;\n}`);
		expect(tight.qualifiedName).toBe("bar");
		expect(loose.symbolHash).toBe(tight.symbolHash);
	});

	it("changes when the body's tokens change", () => {
		expect(onlyEntry(`function bar(x: number){return x<0;}`).symbolHash).not.toBe(
			onlyEntry(`function bar(x: number){return x>0;}`).symbolHash,
		);
	});
});

describe("source-kind and naming coverage", () => {
	const GT: RawSpec = { needle: "> 0", lexeme: ">", replacement: ">=" };

	it("parses tsx / jsx / js script kinds", () => {
		for (const ext of ["tsx", "jsx", "js"]) {
			const file = `src/x.${ext}`;
			const src = `function bar(x){ return x > 0; }`;
			const ids = deriveIdentities(file, src, [
				{ file, mutator: "Op", originalLexeme: ">", replacement: ">=", startOffset: src.indexOf("> 0") },
			]);
			expect(ids?.length).toBe(1);
		}
	});

	it("derives qualified names across function forms", () => {
		const cases: Array<[string, string]> = [
			["class C { foo(x: number) { return x > 0; } }", "C.foo"],
			["const foo = (x: number) => x > 0;", "foo"],
			["const o = { foo: (x: number) => x > 0 };", "foo"],
			["[1].map(function (x: number) { return x > 0; });", "(anonymous)"],
		];
		for (const [src, expected] of cases) {
			expect(nth(derive(src, [GT]), 0).qualifiedName).toBe(expected);
		}
	});
});
