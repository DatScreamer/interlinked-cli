import { describe, expect, it } from "vitest";
import { detectConfigLoosening } from "./config-loosening-gate.js";

describe("detectConfigLoosening — tsconfig.json", () => {
	it("flags `strict: true` → `strict: false`", () => {
		// Flipping strict from true → false also flips every implied
		// subflag (noImplicitAny, strictNullChecks, …) from effectively
		// true to effectively false. The check surfaces all of them so
		// the user sees the full blast radius.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("strict");
		expect(rules).toContain("noImplicitAny");
	});

	it("flags `noImplicitAny: true` → `noImplicitAny: false`", () => {
		const before = `{ "compilerOptions": { "noImplicitAny": true } }`;
		const after = `{ "compilerOptions": { "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags `strictNullChecks: true` → `strictNullChecks: false`", () => {
		const before = `{ "compilerOptions": { "strictNullChecks": true } }`;
		const after = `{ "compilerOptions": { "strictNullChecks": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after).length).toBe(1);
	});

	it("does not flag adding a new strict flag", () => {
		const before = `{ "compilerOptions": {} }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("does not flag tightening (false → true)", () => {
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags adding a `noImplicitAny: false` override under `strict: true`", () => {
		// strict: true makes noImplicitAny effectively true. Adding an
		// explicit `noImplicitAny: false` is a real loosening even though
		// the literal `noImplicitAny` was undefined before.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("noImplicitAny");
	});

	it("flags adding `strictNullChecks: false` override under `strict: true`", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "strictNullChecks": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("strictNullChecks");
	});

	it("does not flag adding a strict subflag override under `strict: false`", () => {
		// If strict was already false, adding noImplicitAny: false isn't a
		// loosening — the umbrella was already off.
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": false, "noImplicitAny": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags removing `noUncheckedIndexedAccess: true` (TS default is false)", () => {
		// noUncheckedIndexedAccess is NOT implied by strict — its TS default
		// is false. Removing an explicit `true` therefore IS a loosening.
		const before = `{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("noUncheckedIndexedAccess");
	});

	it("flags removing `strict: true` entirely", () => {
		// Removing strict drops every implied subflag from true → false (TS
		// defaults each to false when strict is absent).
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": {} }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		// Should fire on `strict` itself plus the 8 implied subflags.
		expect(findings.length).toBeGreaterThanOrEqual(1);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("strict");
	});

	it("does not flag removing a flag that's already false", () => {
		const before = `{ "compilerOptions": { "noImplicitReturns": false } }`;
		const after = `{ "compilerOptions": {} }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — package.json", () => {
	it("flags engines.node version drop", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("engines.node");
	});

	it("flags engines.node removal entirely (no floor at all)", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("engines.node");
	});

	it("flags engines block removal", () => {
		const before = `{ "engines": { "node": ">=22.0.0" }, "name": "x" }`;
		const after = `{ "name": "x" }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags removal of test script", () => {
		const before = `{ "scripts": { "test": "vitest run", "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(findings[0].rule).toBe("scripts.test");
	});

	it("does not flag adding a script", () => {
		const before = `{ "scripts": { "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup", "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — non-config files", () => {
	it("returns empty for non-config file paths", () => {
		expect(
			detectConfigLoosening(
				"src/lib/foo.ts",
				`{"strict": true}`,
				`{"strict": false}`,
			),
		).toEqual([]);
	});
});

describe("reconstructEditContent — Edit tool reconstruction", () => {
	it("reconstructs from old_string + new_string", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const before = `{ "compilerOptions": { "strict": true } }`;
		const result = reconstructEditContent(before, '"strict": true', '"strict": false');
		expect(result).toBe(`{ "compilerOptions": { "strict": false } }`);
	});

	it("returns null when old_string is not present in disk content", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const result = reconstructEditContent("{}", "missing", "x");
		expect(result).toBeNull();
	});

	it("returns null when old_string is ambiguous (matches multiple times)", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		// `replaceAll` is intentionally unsupported — agents pass replace_all=true
		// for that, and we can't reproduce ambiguity safely. Return null so the
		// caller falls back to the next gate rather than firing on the wrong
		// reconstructed content.
		const result = reconstructEditContent("aa\naa", "aa", "bb");
		expect(result).toBeNull();
	});
});
