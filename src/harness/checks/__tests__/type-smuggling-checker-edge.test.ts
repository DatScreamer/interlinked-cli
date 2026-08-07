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
