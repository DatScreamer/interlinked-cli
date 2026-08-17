import { describe, expect, it } from "vitest";
import { checkIntrovertedTest } from "./introverted-test.js";

// Fleet W9 mutation-kill wave targeting src/harness/checks/introverted-test.ts.
// Every fixture below is grounded in `checkIntrovertedTest`'s actual (pristine)
// output, verified by direct execution before being committed here — not
// merely "kills the mutant", per the shared assert-on-the-mutant-not-the-diff
// contract. This file does not flag itself: every assertion here is grounded
// in the SUT call below, matching the companion file's own convention.

function run(content: string, path = "cart.test.ts"): ReturnType<typeof checkIntrovertedTest> {
	return checkIntrovertedTest(content, path);
}

const CART = `import { calcTotal } from "./cart";\n`;

describe("checkIntrovertedTest — loadTs caches a failed require across calls", () => {
	// test-contract: invariant — a failed `typescript` require is cached so a
	// second call does not re-invoke createRequire's returned loader; this is
	// the observable half of the tsCache-null-on-catch contract (the pure
	// return-value half is already covered by the "degradation" describe).
	it("invokes the require loader exactly once across two failing calls", async () => {
		const { vi } = await import("vitest");
		vi.resetModules();
		let requireCalls = 0;
		vi.doMock("node:module", () => ({
			createRequire: () => {
				requireCalls++;
				return () => {
					throw new Error("Cannot find module 'typescript'");
				};
			},
		}));
		const fresh = await import("./introverted-test.js");
		fresh.checkIntrovertedTest(`${CART}it("x", () => { expect(3).toBe(3); });`, "cart.test.ts");
		fresh.checkIntrovertedTest(`${CART}it("y", () => { expect(3).toBe(3); });`, "cart2.test.ts");
		vi.doUnmock("node:module");
		vi.resetModules();
		expect(requireCalls).toBe(1);
	});
});

describe("checkIntrovertedTest — scriptKind selection per extension (angle-bracket cast probe)", () => {
	// A `<number>3` type-assertion cast parses cleanly (3 call expressions: it,
	// expect, toBe) ONLY under the TS ScriptKind — every JSX-capable kind
	// (TSX/JSX/JS all try JSX parsing on the leading `<`) breaks the cast and
	// loses the `expect(y)` call entirely, so the finding vanishes. Verified
	// directly against `typescript`'s createSourceFile for all four kinds
	// before writing these assertions.
	const CAST = `${CART}it("adds", () => { const y = <number>3; expect(y).toBe(3); });`;

	// test-contract: public-api — a .ts file resolves the TS ScriptKind, so the cast parses and the literal-only assertion is flagged (control case)
	it("flags the cast on a .ts file (TS ScriptKind control case)", () => {
		expect(run(CAST, "cart.test.ts")).toHaveLength(1);
	});

	// test-contract: boundary — a .tsx extension must resolve to the TSX ScriptKind, not TS, so the cast misparses and stays silent
	it("does not flag the cast on a .tsx file", () => {
		expect(run(CAST, "cart.test.tsx")).toEqual([]);
	});

	// test-contract: boundary — a .jsx extension must resolve to JSX, not TS
	it("does not flag the cast on a .jsx file", () => {
		expect(run(CAST, "cart.test.jsx")).toEqual([]);
	});

	// test-contract: boundary — a .js extension must resolve to JS, not TS
	it("does not flag the cast on a .js file", () => {
		expect(run(CAST, "cart.test.js")).toEqual([]);
	});

	// test-contract: boundary — a .mjs extension must resolve to JS, not TS (shares the fallthrough case-clause with .js/.cjs)
	it("does not flag the cast on a .mjs file", () => {
		expect(run(CAST, "cart.test.mjs")).toEqual([]);
	});

	// test-contract: boundary — a .cjs extension must resolve to JS, not TS (the LAST case in the js/mjs/cjs fallthrough group — its statement is shared by all three)
	it("does not flag the cast on a .cjs file", () => {
		expect(run(CAST, "cart.test.cjs")).toEqual([]);
	});
});

describe("checkIntrovertedTest — isSutSpecifier prefix/suffix boundaries", () => {
	// test-contract: boundary — a bare specifier whose basename equals the
	// companion base must never be treated as an in-project SUT source; only
	// a "./" or "../" prefix (not a basename match alone) makes a source SUT.
	it("does not treat a bare companion-basename import as a SUT source", () => {
		expect(run(`import { calcTotal } from "cart";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	// test-contract: boundary — the trailing-relative check is a PREFIX test
	// ("../" at the start), not a suffix test; a bare spec that merely ENDS in
	// "../" must still resolve as non-SUT.
	it("does not ground a dynamic import of a bare spec that happens to end in \"../\"", () => {
		expect(run(`${CART}it("x", async () => { expect(import("weird../")).toBeDefined(); });`)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — normalizeSpec end-anchor", () => {
	// test-contract: invariant — normalizeSpec strips a TRAILING module
	// extension only; an extension-shaped substring in the MIDDLE of a mock
	// specifier must not be treated as a match, so a differently-shaped real
	// import specifier does not spuriously collide with it in the mocked set.
	it("does not treat an embedded (non-trailing) extension as stripped when matching a mock specifier", () => {
		const content = `${CART}vi.mock("./dep.ts/sub");\nimport { helper } from "./dep/sub";\nit("x", () => { expect(helper()).toBe(1); });`;
		expect(run(content)).toEqual([]);
	});
});

describe("checkIntrovertedTest — importBasename alternation order", () => {
	// test-contract: boundary — importBasename must strip the FULL trailing
	// extension via backtracking (".tsx" as a whole), not stop at the shorter
	// "ts" alternative that appears earlier in the regex's alternation list;
	// otherwise a ".tsx"-suffixed companion spec's basename gains a stray "x"
	// and no longer matches the companion base.
	it("strips a full .tsx suffix (not just the leading \"ts\") when matching the companion basename", () => {
		expect(run(`import { calcTotal } from "./cart.tsx";\nit("adds", () => { expect(3).toBe(3); });`)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — sutBaseFromPath", () => {
	// test-contract: boundary — a Windows-style backslash separator must be
	// normalized to "/" before extracting the basename, or the whole path
	// collapses into one bogus segment and the companion base is wrong.
	it("normalizes a backslash path separator before deriving the companion base", () => {
		const content = `import { calcTotal } from "./cart";\nit("adds", () => { expect(3).toBe(3); });`;
		expect(run(content, "src\\cart.test.ts")).toHaveLength(1);
	});

	// test-contract: boundary — when the ternary's equality check is bypassed,
	// a file with NO ".test."/".spec." suffix in its name (a strict test file
	// only via directory convention) must still resolve to an EMPTY companion
	// base, not the raw filename, so no import can spuriously match it.
	it("resolves an empty companion base for a directory-only strict test filename", () => {
		const content = `import { calcTotal } from "./cart.ts.js";\nit("adds", () => { expect(3).toBe(3); });`;
		expect(run(content, "src/tests/cart.ts")).toEqual([]);
	});
});

describe("checkIntrovertedTest — collectMockedModules vi/jest.mock recognition", () => {
	// test-contract: security — only `vi.mock(...)` / `jest.mock(...)` may
	// register a specifier as mocked; a call on an unrelated object whose
	// method happens to be named "mock" (or a vi/jest call whose method is
	// NOT "mock") must never reclassify the real companion import, or a
	// genuinely introverted assertion goes undetected (recall/precision
	// contract violation in the dangerous direction).
	it("does not treat an arbitrary object's .mock(...) call as a vi/jest mock registration", () => {
		const content = `${CART}foo.mock("./cart");\nit("x", () => { expect(calcTotal([1])).toBe(1); });`;
		expect(run(content)).toEqual([]);
	});

	// test-contract: boundary — only the "mock" method name registers a
	// specifier; `vi.fn(...)` (a different vi API) must not.
	it("does not treat vi.fn(...) as a mock registration", () => {
		const content = `${CART}vi.fn("./cart");\nit("x", () => { expect(calcTotal([1])).toBe(1); });`;
		expect(run(content)).toEqual([]);
	});

	// test-contract: boundary — a no-argument vi.mock() call must be ignored,
	// not crash the whole check, when the arg-presence guard is bypassed.
	it("does not crash on a no-argument vi.mock() call", () => {
		const content = `${CART}vi.mock();\nit("x", () => { expect(calcTotal([1])).toBe(1); });`;
		expect(run(content)).toEqual([]);
	});

	// test-contract: boundary — a non-string-literal vi.mock(...) argument
	// (here an array) must be ignored, not crash while normalizing a
	// nonexistent `.text` field.
	it("does not crash on a non-string-literal vi.mock(...) argument", () => {
		const content = `${CART}vi.mock([]);\nit("x", () => { expect(calcTotal([1])).toBe(1); });`;
		expect(run(content)).toEqual([]);
	});
});

describe("checkIntrovertedTest — classifyCompanionImport", () => {
	// test-contract: boundary — an empty named-import clause (`import {} from
	// "./cart"`) is a real companion import with ZERO tracked symbols; it must
	// not spuriously widen the SUT-symbol set past empty, or the file's
	// early empty-SUT bail is skipped and every literal assertion is flagged.
	it("does not widen the tracked SUT set for an empty named-import clause", () => {
		expect(run(`import {} from "./cart";\nit("adds", () => { expect(3).toBe(3); });`)).toEqual([]);
	});

	// test-contract: public-api — a default import combined with a named
	// import in one statement must track BOTH bindings; losing the default
	// binding hides a real out-param SUT call from bodyReferencesCompanion.
	it("tracks a default import's binding alongside a named import from the same statement", () => {
		const content = `import calc, { helper } from "./cart";\nit("x", () => { const out = []; calc(out); expect(out).toEqual([1]); });`;
		expect(run(content)).toEqual([]);
	});

	// test-contract: public-api — a default import combined with a namespace
	// import in one statement must track BOTH bindings; losing the namespace
	// binding hides a real out-param namespace call from bodyReferencesCompanion.
	it("tracks a namespace import's binding alongside a default import from the same statement", () => {
		const content = `import calc, * as cart from "./cart";\nit("x", () => { const out = []; cart.calcTotal(out); expect(out).toEqual([1]); });`;
		expect(run(content)).toEqual([]);
	});
});

describe("checkIntrovertedTest — dynamic-import REACHED propagation through combine/rankValue", () => {
	// test-contract: public-api — a dynamic import of the companion, used
	// DIRECTLY as an assertion subject (not bound to a name, and not textually
	// referencing any reachable identifier elsewhere in the body), is the only
	// fixture shape that isolates combine()'s REACHED short-circuit and
	// rankValue's dynamic-import special case from the independent
	// bodyReferencesCompanion backstop (which only matches bare identifiers /
	// namespace property-access, never a string literal import specifier).
	it("does not flag a dynamic companion import used directly as the assertion subject", () => {
		expect(run(`${CART}it("x", async () => { expect(import("./cart")).toBeDefined(); });`)).toEqual([]);
	});

	// test-contract: boundary — the dynamic-import REACHED rule is gated on
	// the callee actually being the `import` keyword; a regular call whose
	// FIRST ARGUMENT merely happens to be a SUT-shaped string (here a
	// known-non-SUT `Math.max` call) must still resolve through the normal
	// callee-rank path (NONE, since Math is a known non-SUT global) rather
	// than short-circuiting to REACHED.
	it("does not let a SUT-shaped string argument short-circuit an unrelated known-non-SUT call to REACHED", () => {
		expect(run(`${CART}it("x", () => { expect(Math.max("./cart")).toBeDefined(); });`)).toHaveLength(1);
	});

	// test-contract: boundary — a non-string-literal argument to a bare
	// `import(...)` call (here an array literal) must be ignored by the
	// SUT-specifier check, not crash while reading a nonexistent `.text`.
	it("does not crash on a dynamic import whose argument is not a string literal", () => {
		expect(run(`${CART}it("x", async () => { expect(import([])).toBeDefined(); });`)).toHaveLength(1);
	});

	// test-contract: invariant — losing an argument's rank (via a broken
	// argument-rank mapper) must not silently downgrade a REACHED dynamic
	// import nested inside another call's arguments to NONE.
	it("propagates a nested dynamic companion import's REACHED rank through an outer call's arguments", () => {
		expect(run(`${CART}it("x", () => { expect(Object.keys(import("./cart"))).toBeDefined(); });`)).toEqual([]);
	});

	// test-contract: invariant — the default (non-primitive/call/property/identifier)
	// AST branch must recurse into an awaited dynamic import's children to
	// discover its REACHED rank; an emptied recursion callback silently drops
	// every child rank to the initial (unpushed) empty array, i.e. NONE.
	it("recurses through an await-wrapped dynamic companion import to find its REACHED rank", () => {
		expect(run(`${CART}it("x", async () => { expect(await import("./cart")).toBeDefined(); });`)).toEqual([]);
	});
});

describe("checkIntrovertedTest — NON_SUT_SPEC_RE asset-extension boundaries", () => {
	// test-contract: boundary — the JSON/asset-extension check is anchored to
	// the END of the specifier; a specifier that merely CONTAINS ".json" in
	// the middle (not as its real extension) must still be treated as a
	// legitimate SUT source, not excluded as a JSON asset.
	it("does not treat a mid-specifier \".json\" substring as a trailing JSON-asset extension", () => {
		const content = `${CART}it("x", async () => { expect(import("./cart.json.ts")).toBeDefined(); });`;
		expect(run(content)).toEqual([]);
	});

	// test-contract: boundary — the image-extension alternative must match
	// BOTH "jpg" and "jpeg" (the "e" is optional); a ".jpg" asset must be
	// excluded from SUT classification exactly like a ".jpeg" one.
	it("excludes a .jpg asset specifier from SUT classification (not just .jpeg)", () => {
		const content = `${CART}it("x", async () => { expect(import("./photo.jpg")).toBeDefined(); });`;
		expect(run(content)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — collectAssertionSubjects bare assert() tracking", () => {
	// test-contract: public-api — a bare `assert(...)` call with a literal-only
	// argument must be tracked as an assertion subject and flagged; an
	// untracked bare assert() is indistinguishable from an assertion-free
	// block, which stays silent by design (a different, unintended silence).
	it("flags a bare assert() call whose argument is confidently non-SUT", () => {
		expect(run(`${CART}it("x", () => { assert(3 === 3); });`)).toHaveLength(1);
	});

	// test-contract: boundary — a property-access call whose object is NOT
	// literally named "assert" (here a lookalike "check.assert") must not be
	// treated as the property-form assert() API.
	it("does not treat a non-\"assert\"-named object's .assert(...) call as the assert API", () => {
		expect(run(`${CART}it("x", () => { check.assert(3, 3); });`)).toEqual([]);
	});
});

describe("checkIntrovertedTest — declaredHelperName anonymous default-export guard", () => {
	// test-contract: boundary — an anonymous `export default function() {}`
	// declaration has no `.name`, so it can never be registered as a callable
	// helper by name; the name-presence guard must short-circuit BEFORE
	// reading `.name.text`, or this legitimate, common declaration shape
	// crashes the whole check.
	it("does not crash on an anonymous default-exported function declaration", () => {
		const content = `${CART}export default function() { calcTotal([1]); }\nit("x", () => { expect(3).toBe(3); });`;
		expect(run(content)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — findTestBlocks missing-callback guard", () => {
	// test-contract: boundary — an it() call with only a name argument and no
	// callback (`it("adds")`, e.g. a pending/TODO-style declaration some
	// runners accept) must be ignored, not crash while reading `.body` off a
	// nonexistent function argument.
	it("does not crash on a test call with no callback argument", () => {
		expect(run(`${CART}it("adds");`)).toEqual([]);
	});
});
