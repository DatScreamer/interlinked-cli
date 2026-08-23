import { describe, expect, it, vi } from "vitest";
import {
	computeSymbolHashes,
	deriveIdentities,
	mutationIdentityAvailable,
} from "./identity.js";
import type { RawMutant } from "./types.js";

function findByQualified(map: Map<string, { qualifiedName: string; symbolHash: string }>, qn: string) {
	return [...map.values()].find((e) => e.qualifiedName === qn);
}

describe("mutationIdentityAvailable / loadTs — positive (must fire)", () => {
	it("P1: returns true when typescript is resolvable", () => {
		expect(mutationIdentityAvailable()).toBe(true);
	});
});

describe("loadTs caching — positive (must fire)", () => {
	it("P1: createRequire is invoked only once across repeated calls (cache hit)", async () => {
		vi.resetModules();
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return { ...actual, createRequire: vi.fn(actual.createRequire) };
		});
		const mod = await import("node:module");
		const fresh = await import("./identity.js");
		expect(fresh.mutationIdentityAvailable()).toBe(true);
		expect(fresh.mutationIdentityAvailable()).toBe(true);
		expect(fresh.mutationIdentityAvailable()).toBe(true);
		expect(vi.mocked(mod.createRequire)).toHaveBeenCalledTimes(1);
		vi.doUnmock("node:module");
		vi.resetModules();
	});
});

describe("loadTs unavailable — negative (must not fire)", () => {
	it("N1: mutationIdentityAvailable/deriveIdentities/computeSymbolHashes all report unavailable when typescript can't be required", async () => {
		vi.resetModules();
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			const fakeRequire = (spec: string) => {
				if (spec === "typescript") throw new Error("Cannot find module 'typescript'");
				return actual.createRequire(import.meta.url)(spec);
			};
			return { ...actual, createRequire: () => fakeRequire };
		});
		const fresh = await import("./identity.js");
		expect(fresh.mutationIdentityAvailable()).toBe(false);
		expect(fresh.deriveIdentities("f.ts", "const x = 1;", [])).toBeNull();
		expect(fresh.computeSymbolHashes("f.ts", "const x = 1;")).toBeNull();
		vi.doUnmock("node:module");
		vi.resetModules();
	});
});

describe("sha16 digest width — positive (must fire)", () => {
	it("P1: mutantId is exactly 16 hex characters, not the full sha256 digest", () => {
		const raw: RawMutant[] = [
			{ file: "f.ts", mutator: "EqualityOperator", originalLexeme: ">", replacement: ">=", startOffset: 0 },
		];
		const ids = deriveIdentities("f.ts", "const x = 1;", raw);
		expect(ids).not.toBeNull();
		const [id] = ids!;
		expect(id).toBeDefined();
		expect(id!.mutantId).toMatch(/^[0-9a-f]{16}$/);
		expect(id!.siteId).toMatch(/^[0-9a-f]{16}$/);
		expect(id!.symbolId).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("sha16 part separator — positive (must fire)", () => {
	it("P1: symbolId for (file=a, symbol=bc) differs from (file=ab, symbol=c) despite identical concatenation", () => {
		const mapA = computeSymbolHashes("a", "function bc(){}");
		const mapB = computeSymbolHashes("ab", "function c(){}");
		expect(mapA).not.toBeNull();
		expect(mapB).not.toBeNull();
		const idA = [...mapA!.keys()][0];
		const idB = [...mapB!.keys()][0];
		expect(idA).not.toBe(idB);
	});
});

describe("normalizeTokens spacing separator — positive (must fire)", () => {
	it("P1: token-adjacency-sensitive bodies hash differently ('1 .5' vs '1.5' scan to different token streams)", () => {
		const mapA = computeSymbolHashes("x.ts", "function f() { 1 .5; }");
		const mapB = computeSymbolHashes("x.ts", "function f() { 1.5; }");
		expect(mapA).not.toBeNull();
		expect(mapB).not.toBeNull();
		const hashA = findByQualified(mapA!, "f")!.symbolHash;
		const hashB = findByQualified(mapB!, "f")!.symbolHash;
		expect(hashA).not.toBe(hashB);
	});
});

describe("localName constructor — positive (must fire)", () => {
	it("P1: a class constructor's qualifiedName is 'C.constructor'", () => {
		const map = computeSymbolHashes("k.ts", "class C { constructor() { const z = 1; } }");
		expect(map).not.toBeNull();
		const entry = findByQualified(map!, "C.constructor");
		expect(entry).toBeDefined();
	});
});

describe("localName identifier/private-identifier guard — negative (must not fire)", () => {
	it("N1: a computed string-literal method name is NOT read as an identifier name (falls through to anonymous)", () => {
		const map = computeSymbolHashes("m.ts", 'class C { ["m"]() { const z = 1; } }');
		expect(map).not.toBeNull();
		expect(findByQualified(map!, 'C.["m"]')).toBeUndefined();
		expect(findByQualified(map!, "C.(anonymous)")).toBeDefined();
	});
});

describe("localName property-declaration guard — positive (must fire)", () => {
	it("P1: a class-property function initializer is named after the property ('C.f')", () => {
		const map = computeSymbolHashes("p.ts", "class C { f = function () { const z = 1; }; }");
		expect(map).not.toBeNull();
		expect(findByQualified(map!, "C.f")).toBeDefined();
	});
});

describe("qualifiedName empty-parts fallback — positive (must fire)", () => {
	it("P1: top-level module-scope code hashes under qualifiedName '(module)', not the empty string", () => {
		const map = computeSymbolHashes("q.ts", "const x = 1;\nconst y = 2;\n");
		expect(map).not.toBeNull();
		const entry = findByQualified(map!, "(module)");
		expect(entry).toBeDefined();
		expect(findByQualified(map!, "")).toBeUndefined();
	});
});

describe("qualifiedName namespace walk — positive (must fire)", () => {
	it("P1: a function inside a namespace is qualified as 'N.f', not bare 'f'", () => {
		const map = computeSymbolHashes("n.ts", "namespace N { function f() { const z = 1; } }");
		expect(map).not.toBeNull();
		expect(findByQualified(map!, "N.f")).toBeDefined();
		expect(findByQualified(map!, "f")).toBeUndefined();
	});
});

describe("arityOf parameter count — positive (must fire)", () => {
	it("P1: symbolId depends on the function's actual parameter count", () => {
		const mapA = computeSymbolHashes("ar.ts", "function f(a) { const z = 1; }");
		const mapB = computeSymbolHashes("ar.ts", "function f(a, b) { const z = 1; }");
		expect(mapA).not.toBeNull();
		expect(mapB).not.toBeNull();
		const idA = [...mapA!.keys()][0];
		const idB = [...mapB!.keys()][0];
		expect(idA).not.toBe(idB);
	});
});

describe("enclosingFunction start boundary — positive (must fire)", () => {
	it("P1: an offset exactly at a function's start position resolves inside that function", () => {
		const content = "function f(){}";
		const raw: RawMutant[] = [
			{ file: "e.ts", mutator: "X", originalLexeme: "y", replacement: "z", startOffset: 0 },
		];
		const ids = deriveIdentities("e.ts", content, raw);
		expect(ids).not.toBeNull();
		expect(ids![0]!.qualifiedName).toBe("f");
	});
});

describe("enclosingFunction end boundary — negative (must not fire)", () => {
	it("N1: an offset exactly at a function's end position (half-open span) resolves OUTSIDE that function", () => {
		const content = "function f(){}"; // end = 14, right after the closing brace
		const raw: RawMutant[] = [
			{ file: "e2.ts", mutator: "X", originalLexeme: "y", replacement: "z", startOffset: content.length },
		];
		const ids = deriveIdentities("e2.ts", content + "x;", raw);
		expect(ids).not.toBeNull();
		expect(ids![0]!.qualifiedName).toBe("(module)");
	});
});

describe("groupKey collapse — negative (must not fire)", () => {
	it("N1: distinct (symbol,mutator,lexeme) groups keep independent ordinal-0 ranks, not merged into one shared group", () => {
		const content = "const x = 1;\nconst y = 2;\n";
		const raw: RawMutant[] = [
			{ file: "g.ts", mutator: "MutatorA", originalLexeme: "lexA", replacement: "r1", startOffset: 2 },
			{ file: "g.ts", mutator: "MutatorB", originalLexeme: "lexB", replacement: "r2", startOffset: 16 },
		];
		const ids = deriveIdentities("g.ts", content, raw);
		expect(ids).not.toBeNull();
		expect(ids![0]!.ordinalWithinSymbol).toBe(0);
		expect(ids![1]!.ordinalWithinSymbol).toBe(0);
	});
});

describe("ordinal sort comparator — positive (must fire)", () => {
	it("P1: ordinals within a shared group are ranked by ascending offset regardless of input order", () => {
		const content = "const x = 1;\n";
		const raw: RawMutant[] = [
			{ file: "s.ts", mutator: "M", originalLexeme: "L", replacement: "r", startOffset: 50 },
			{ file: "s.ts", mutator: "M", originalLexeme: "L", replacement: "r", startOffset: 10 },
			{ file: "s.ts", mutator: "M", originalLexeme: "L", replacement: "r", startOffset: 30 },
		];
		const ids = deriveIdentities("s.ts", content, raw);
		expect(ids).not.toBeNull();
		const byOffset = new Map(raw.map((r, i) => [r.startOffset, ids![i]!.ordinalWithinSymbol]));
		expect(byOffset.get(10)).toBe(0);
		expect(byOffset.get(30)).toBe(1);
		expect(byOffset.get(50)).toBe(2);
	});
});

describe("isHashedFunction body guard — negative (must not fire)", () => {
	it("N1: bodiless overload signatures are not hashed as their own symbol; only the implementation is", () => {
		const content =
			"function f(): void;\nfunction f(x: number): string;\nfunction f(x?: number): any { return x; }\n";
		const map = computeSymbolHashes("o.ts", content);
		expect(map).not.toBeNull();
		// Only the implementation (arity 1, has a body) is its own hashed symbol;
		// the two bodiless overload lines stay leftover module-scope text, so a
		// "(module)" entry survives alongside exactly one "f" entry.
		const fEntries = [...map!.values()].filter((e) => e.qualifiedName === "f");
		expect(fEntries).toHaveLength(1);
		expect(findByQualified(map!, "(module)")).toBeDefined();
	});
});

describe("isHashedFunction logical operator — negative (must not fire)", () => {
	it("N1: a namespace (has a .body but is not function-like) is not treated as a hashed function", () => {
		const content = "namespace N { const x = 1; }";
		const map = computeSymbolHashes("ns.ts", content);
		expect(map).not.toBeNull();
		expect(map!.size).toBe(1);
		expect(findByQualified(map!, "(module)")).toBeDefined();
		expect(findByQualified(map!, "N")).toBeUndefined();
	});
});

describe("hashedFunctionSpans initial array contents — positive (must fire)", () => {
	it("P1: module-scope hash for content with an excised function matches the equivalent function-free content", () => {
		const withFn = computeSymbolHashes("wf.ts", "const a=1;\nfunction f(){ return 2; }\nconst b=3;\n");
		const withoutFn = computeSymbolHashes("nf.ts", "const a=1;\nconst b=3;\n");
		expect(withFn).not.toBeNull();
		expect(withoutFn).not.toBeNull();
		const hashA = findByQualified(withFn!, "(module)")!.symbolHash;
		const hashB = findByQualified(withoutFn!, "(module)")!.symbolHash;
		expect(hashA).toBe(hashB);
	});
});
