// Covers checker-level edge branches in `collectSmugglingCasts` /
// `checkTypeSmuggling` that can't be reached through any real TypeScript
// program — the TS compiler API's own signatures guarantee a TypeChecker,
// non-undefined `Type` results, and a working `createProgram` in every
// realistic case. Each test wraps the REAL `typescript` module (loaded via
// the same `createRequire` path production code uses) and overrides exactly
// one method to synthesize the otherwise-unreachable failure, so the rest of
// the pipeline (parsing, program creation, AST walk) is genuine.
//
// Isolated per-file mocking of `node:module` via `vi.doMock` + dynamic
// import + `vi.resetModules()` between cases, since each case needs a
// DIFFERENT transform of the loaded "typescript" module.

import { afterEach, describe, expect, it, vi } from "vitest";
// Imported for its side-effect-free type shape only, so the harness's
// SUT-import check recognizes this file as exercising `checkTypeSmuggling`
// (the mocked module is loaded dynamically below via
// `import("../type-smuggling.js")`, which the static check can't see).
import type {} from "../type-smuggling.js";

const TS = "src/lib/foo.ts";
const SMUGGLING_CODE = [
	"interface UserObj { id: number; name: string; }",
	"interface ProductObj { sku: string; price: number; }",
	"declare const userObj: UserObj;",
	"const product = userObj as ProductObj;",
	"export { product };",
].join("\n");

type TsLike = typeof import("typescript");

async function loadWithMockedTs(transform: (ts: TsLike) => TsLike) {
	vi.resetModules();
	vi.doMock("node:module", async (importOriginal) => {
		const actual = await importOriginal<typeof import("node:module")>();
		return {
			...actual,
			createRequire: (...args: Parameters<typeof actual.createRequire>) => {
				const req = actual.createRequire(...args);
				return (id: string) => {
					const mod = req(id);
					if (id === "typescript") return transform(mod as TsLike);
					return mod;
				};
			},
		};
	});
	return import("../type-smuggling.js");
}

afterEach(() => {
	vi.doUnmock("node:module");
	vi.resetModules();
});

describe("checkTypeSmuggling — checker edge cases (mocked typescript loader)", () => {
	it("returns [] when program.getTypeChecker() yields a falsy value", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					return {
						...program,
						getTypeChecker: () => null as unknown as ReturnType<typeof program.getTypeChecker>,
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] and does not throw when the type checker throws mid-walk", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							return {
								...checker,
								getTypeAtLocation: () => {
									throw new Error("boom");
								},
							};
						},
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("skips a cast whose source type resolves to undefined", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							return {
								...checker,
								getTypeAtLocation: () => undefined as unknown as ReturnType<
									typeof checker.getTypeAtLocation
								>,
							};
						},
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] when ts.createProgram itself throws", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => ({
			...ts,
			createProgram: (() => {
				throw new Error("boom");
			}) as unknown as typeof ts.createProgram,
		}));
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] when program.getSourceFile(filePath) yields undefined after a successful build", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					return {
						...program,
						getSourceFile: () => undefined as unknown as ReturnType<
							typeof program.getSourceFile
						>,
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	it("returns [] and does not throw when program.getTypeChecker() itself throws (outer catch)", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					return {
						...program,
						getTypeChecker: () => {
							throw new Error("boom-outer");
						},
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
	});

	// test-contract: invariant — a per-node type-resolution failure
	// (sourceType/targetType resolving to undefined for ONE cast) must skip
	// only that node and continue the walk — it must not silently discard
	// matches already found for OTHER, unrelated casts earlier in the same
	// file. The undefined-sourceType guard is per-node, not a whole-file
	// abort.
	it("keeps an earlier match when a LATER cast's source type resolves to undefined", async () => {
		const CODE = [
			"interface UserObj { id: number; name: string; }",
			"interface ProductObj { sku: string; price: number; }",
			"declare const userObj: UserObj;",
			"const product = userObj as ProductObj;",
			"declare const other: UserObj;",
			"const y = other as ProductObj;",
			"export { product, y };",
		].join("\n");

		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							const realGetTypeAtLocation = checker.getTypeAtLocation.bind(checker);
							return {
								...checker,
								getTypeAtLocation: (node: Parameters<typeof realGetTypeAtLocation>[0]) => {
									if (
										ts.isIdentifier(node) &&
										node.text === "other" &&
										node.parent &&
										ts.isAsExpression(node.parent) &&
										node.parent.expression === node
									) {
										return undefined as unknown as ReturnType<typeof realGetTypeAtLocation>;
									}
									return realGetTypeAtLocation(node);
								},
							};
						},
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});

		const matches = checkTypeSmuggling(CODE, TS);
		expect(matches).toEqual([
			{
				line: 4,
				text: "type-smuggling cast: source `UserObj` has no structural overlap with target `ProductObj` — const product = userObj as ProductObj;",
			},
		]);
	});

	it("falls back to '<unresolved>' when checker.typeToString() throws (safeTypeToString catch)", async () => {
		const { checkTypeSmuggling } = await loadWithMockedTs((ts) => {
			const realCreateProgram = ts.createProgram;
			return {
				...ts,
				createProgram: ((...args: Parameters<typeof realCreateProgram>) => {
					const program = realCreateProgram(...args);
					const realGetTypeChecker = program.getTypeChecker.bind(program);
					return {
						...program,
						getTypeChecker: () => {
							const checker = realGetTypeChecker();
							return {
								...checker,
								typeToString: () => {
									throw new Error("boom-typeToString");
								},
							};
						},
					};
					// SAFETY: test double narrows createProgram's overloaded signature to the
					// single (rootNames, options, host, ...) overload actually used here.
				}) as unknown as typeof realCreateProgram,
			};
		});
		const matches = checkTypeSmuggling(SMUGGLING_CODE, TS);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches[0]?.text).toContain("<unresolved>");
	});
});

describe("checkTypeSmuggling — __resetTsCacheForTests actually clears the cache", () => {
	// test-contract: public-api — __resetTsCacheForTests must reset the
	// module-level TS-module cache to `undefined` so the NEXT call
	// re-attempts resolution, rather than replaying a stale cached failure.
	// A cached-failure-then-recovery scenario is the only way to observe
	// this: a no-op reset would keep serving the earlier cached `null`
	// forever, even once resolution would now succeed.
	it("lets a later successful resolution replace a cached earlier failure", async () => {
		let attempts = 0;
		vi.resetModules();
		vi.doMock("node:module", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:module")>();
			return {
				...actual,
				createRequire: (...args: Parameters<typeof actual.createRequire>) => {
					const req = actual.createRequire(...args);
					return (id: string) => {
						if (id === "typescript") {
							attempts++;
							if (attempts === 1) {
								throw new Error("simulated: typescript not resolvable yet");
							}
							return req(id);
						}
						return req(id);
					};
				},
			};
		});
		const { checkTypeSmuggling, __resetTsCacheForTests } = await import("../type-smuggling.js");

		// First call: the mocked createRequire throws -> loadTs caches _ts = null.
		expect(checkTypeSmuggling(SMUGGLING_CODE, TS)).toEqual([]);
		expect(attempts).toBe(1);

		// A reset must clear the cached failure so the next call re-attempts
		// resolution instead of reusing the cached `null`.
		__resetTsCacheForTests();

		// Second call: the mock now succeeds (attempt #2) -- this only
		// happens if the reset actually cleared the cache.
		const second = checkTypeSmuggling(SMUGGLING_CODE, TS);
		expect(attempts).toBe(2);
		expect(second.length).toBeGreaterThanOrEqual(1);
	});
});
