// Mutation-kill suite for src/lib/hook-version.ts (wave w39).
//
// `hook-version.ts` computes `HOOK_SCRIPT_VERSION` once, at module load, by
// walking ancestor directories looking for this package's own package.json.
// None of its internal helpers (`isPlainObject`, `isNonEmptyString`,
// `isOwnPackageJson`, `readOwnPackageVersion`, `resolveOwnVersion`) are
// exported, so the only way to exercise their branches is to mock
// `node:fs` / `node:url` and re-import the module fresh per test (the same
// pattern already used in `src/lib/__tests__/hooks.test.ts` for the sibling
// `HOOK_SCRIPT_VERSION` implementation there).
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("node:fs");
	vi.doUnmock("node:url");
	vi.resetModules();
});

describe("HOOK_SCRIPT_VERSION — isPlainObject guard (isOwnPackageJson chain)", () => {
	// test-contract: invariant — a package.json body that parses to `null`
	// must be rejected (treated as "not our package"), never crash the
	// resolver. Mutating `v instanceof Object && !Array.isArray(v)` to `||`
	// or to a bare `true` makes `isPlainObject(null)` return `true`, which
	// then lets `isOwnPackageJson` dereference `null.name` and throw.
	it("does not crash and falls back cleanly when package.json parses to null", async () => {
		vi.resetModules();
		let call = 0;
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => {
					call++;
					return call === 1;
				}),
				readFileSync: vi.fn(() => "null"),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});
});

describe("HOOK_SCRIPT_VERSION — isNonEmptyString guard (isOwnPackageJson chain)", () => {
	// test-contract: invariant — an empty-string `version` field must be
	// treated as invalid, not accepted as a real version.
	it("treats an empty-string version as invalid", async () => {
		vi.resetModules();
		let call = 0;
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => {
					call++;
					return call === 1;
				}),
				readFileSync: vi.fn(() => JSON.stringify({ name: "interlinked-cli", version: "" })),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});

	// test-contract: invariant — a non-string `version` (even one that
	// happens to carry a numeric `.length`) must be rejected on the
	// `v === String(v)` type check, not on the length check alone.
	it("treats a non-string version with a truthy .length as invalid", async () => {
		vi.resetModules();
		let call = 0;
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => {
					call++;
					return call === 1;
				}),
				readFileSync: vi.fn(() =>
					JSON.stringify({ name: "interlinked-cli", version: { length: 5 } }),
				),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});
});

describe("HOOK_SCRIPT_VERSION — isOwnPackageJson name guard", () => {
	// test-contract: public-api — a package.json belonging to a *different*
	// package (name mismatch) must never be adopted as our own version, even
	// when its `version` field is otherwise well-formed. This is the
	// documented anti-monorepo-adoption invariant.
	it("rejects a package.json whose name does not match this package", async () => {
		vi.resetModules();
		let call = 0;
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => {
					call++;
					return call === 1;
				}),
				readFileSync: vi.fn(() =>
					JSON.stringify({ name: "wrong-package", version: "1.2.3" }),
				),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});
});

describe("HOOK_SCRIPT_VERSION — readOwnPackageVersion existsSync guard", () => {
	// test-contract: invariant — a path existsSync reports as missing must
	// never be handed to readFileSync at all.
	it("never reads a package.json that existsSync reports as missing", async () => {
		vi.resetModules();
		const readFileSyncSpy = vi.fn((_path?: unknown, _encoding?: unknown) =>
			JSON.stringify({ name: "interlinked-cli", version: "9.9.9" }),
		);
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => false),
				readFileSync: readFileSyncSpy,
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
		expect(readFileSyncSpy).not.toHaveBeenCalled();
	});
});

describe("HOOK_SCRIPT_VERSION — readOwnPackageVersion encoding", () => {
	// test-contract: invariant — package.json must be read as utf-8 text,
	// not with a different (or empty) encoding argument.
	it("reads a matched package.json with the utf-8 encoding", async () => {
		vi.resetModules();
		let call = 0;
		const readFileSyncSpy = vi.fn((_path?: unknown, _encoding?: unknown) =>
			JSON.stringify({ name: "interlinked-cli", version: "1.2.3" }),
		);
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => {
					call++;
					return call === 1;
				}),
				readFileSync: readFileSyncSpy,
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("1.2.3");
		expect(readFileSyncSpy).toHaveBeenCalledTimes(1);
		expect(readFileSyncSpy.mock.calls[0]?.[1]).toBe("utf-8");
	});
});

describe("HOOK_SCRIPT_VERSION — resolveOwnVersion dir assignment", () => {
	// test-contract: invariant — the resolver must assign `dir` from the
	// resolved file URL before the ancestor walk runs; if that assignment is
	// skipped, `join(undefined, "package.json")` throws and the whole
	// resolver (and the module load) would crash instead of degrading to the
	// documented fallback.
	it("resolves the starting directory before walking ancestors", async () => {
		vi.resetModules();
		vi.doMock("node:url", async () => {
			const actual = await vi.importActual<typeof import("node:url")>("node:url");
			return {
				...actual,
				fileURLToPath: vi.fn(() => "/synthetic/deep/path/to/hook-version.mjs"),
			};
		});
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: vi.fn(() => false),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
	});
});

describe("HOOK_SCRIPT_VERSION — resolveOwnVersion loop bound", () => {
	// test-contract: invariant — the ancestor walk must stop after exactly
	// PACKAGE_WALK_MAX_DEPTH (8) directories, even when deeper ancestors
	// would otherwise satisfy the search. A boundary or step-direction bug
	// (`<=` instead of `<`, or `i--` instead of `i++`) lets the walk run a
	// 9th lookup and adopt a version it should never have reached.
	it("stops walking after exactly 8 ancestor levels", async () => {
		vi.resetModules();
		const deepSegments = Array.from({ length: 12 }, (_, i) => `lvl${i}`);
		const syntheticPath = `/${deepSegments.join("/")}/hook-version.mjs`;
		vi.doMock("node:url", async () => {
			const actual = await vi.importActual<typeof import("node:url")>("node:url");
			return { ...actual, fileURLToPath: vi.fn(() => syntheticPath) };
		});
		let call = 0;
		const existsSyncSpy = vi.fn(() => {
			call++;
			return call === 9;
		});
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				existsSync: existsSyncSpy,
				readFileSync: vi.fn(() =>
					JSON.stringify({ name: "interlinked-cli", version: "9.9.9" }),
				),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
		expect(existsSyncSpy).toHaveBeenCalledTimes(8);
	});
});

describe("HOOK_SCRIPT_VERSION — resolveOwnVersion root-break", () => {
	// test-contract: invariant — once the ancestor walk reaches the
	// filesystem root (`dirname(dir) === dir`), it must stop immediately
	// rather than continuing to re-probe the root for the remaining budget.
	it("stops probing once the ancestor walk reaches the filesystem root", async () => {
		vi.resetModules();
		vi.doMock("node:url", async () => {
			const actual = await vi.importActual<typeof import("node:url")>("node:url");
			return { ...actual, fileURLToPath: vi.fn(() => "/a/b/hook-version.mjs") };
		});
		const existsSyncSpy = vi.fn(() => false);
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return { ...actual, existsSync: existsSyncSpy };
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
		// "/a/b" -> "/a" -> "/" (existsSync checked at each) then break.
		expect(existsSyncSpy).toHaveBeenCalledTimes(3);
	});
});

describe("HOOK_SCRIPT_VERSION — fallback sentinel", () => {
	// test-contract: public-api — when resolution fails outright (a bad
	// file URL), the fallback must be exactly "0.0.0", the documented
	// "unknown" sentinel doctor/hook code compares against — not an empty
	// string, which downstream `not.toBe("0.0.0")`-style staleness checks
	// would silently misread.
	it("falls back to the literal 0.0.0 sentinel when fileURLToPath fails", async () => {
		vi.resetModules();
		vi.doMock("node:url", async () => {
			const actual = await vi.importActual<typeof import("node:url")>("node:url");
			return {
				...actual,
				fileURLToPath: vi.fn(() => {
					throw new Error("bad url");
				}),
			};
		});
		const mod = await import("./hook-version.js");
		expect(mod.HOOK_SCRIPT_VERSION).toBe("0.0.0");
		expect(mod.HOOK_SCRIPT_VERSION.length).toBeGreaterThan(0);
	});
});
