import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cachePath,
	filterDisabled,
	listSourceFiles,
	loadCache,
	saveCache,
} from "./discovered-primitives-fs.js";
import type { DiscoveredPrimitive, DiscoveryCache } from "./discovered-primitives.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dpfs-w44-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch (err) {
			console.warn(`cleanup failed for ${d}:`, err);
		}
	}
	tmpDirs = [];
});

describe("listSourceFiles — positive (must fire)", () => {
	it("P1: returns empty array when directory is empty (loop terminates on empty stack)", () => {
		const root = makeTmpDir();
		const result = listSourceFiles(root);
		expect(result).toEqual([]);
	});

	it("P2: finds .ts files but skips SKIP_DIRS (node_modules, dist, etc.)", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "a.ts"), "export {}");
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(root, "node_modules", "pkg", "b.ts"), "export {}");
		const result = listSourceFiles(root);
		expect(result).toContain(join(root, "src", "a.ts"));
		expect(result).not.toContain(join(root, "node_modules", "pkg", "b.ts"));
	});

	it("P3: sorts directory entries before recursing (readdirSync().sort())", () => {
		const root = makeTmpDir();
		// Create files in reverse alphabetical filesystem-creation order.
		writeFileSync(join(root, "z.ts"), "export {}");
		writeFileSync(join(root, "a.ts"), "export {}");
		writeFileSync(join(root, "m.ts"), "export {}");
		const result = listSourceFiles(root);
		expect(result).toEqual([join(root, "a.ts"), join(root, "m.ts"), join(root, "z.ts")]);
	});

	it("P4: skips non-matching extensions (SOURCE_FILE_RE with trailing $ anchor)", () => {
		const root = makeTmpDir();
		writeFileSync(join(root, "a.ts"), "export {}");
		writeFileSync(join(root, "a.ts.bak"), "export {}");
		const result = listSourceFiles(root);
		expect(result).toContain(join(root, "a.ts"));
		expect(result).not.toContain(join(root, "a.ts.bak"));
	});

	it("P5: a non-existent repoRoot returns [] instead of throwing (top-level readdirSync throw -> continue)", () => {
		const root = makeTmpDir();
		const missing = join(root, "does-not-exist");
		expect(() => listSourceFiles(missing)).not.toThrow();
		expect(listSourceFiles(missing)).toEqual([]);
	});

	it("P6: MAX_FILES_TO_SCAN inner break stops collecting once cap is hit within one directory listing", () => {
		// Exercise the `out.length >= MAX_FILES_TO_SCAN` break inside the for-loop
		// indirectly: with a small number of files well under the cap, all files
		// are collected (sanity that the break condition doesn't fire early).
		const root = makeTmpDir();
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(root, `f${i}.ts`), "export {}");
		}
		const result = listSourceFiles(root);
		expect(result.length).toBe(5);
	});
});

describe("cachePath / loadCache / saveCache — positive (must fire)", () => {
	it("P7: cachePath joins repoRoot/.interlinked/discovered-primitives.json", () => {
		const root = "/some/repo";
		expect(cachePath(root)).toBe(join(root, ".interlinked", "discovered-primitives.json"));
	});

	it("P8: loadCache returns null when cache file is missing", () => {
		const root = makeTmpDir();
		expect(loadCache(root)).toBeNull();
	});

	it("P9: loadCache returns null when JSON parses to a non-object (e.g. a bare number)", () => {
		const root = makeTmpDir();
		const path = cachePath(root);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(path, "42");
		expect(loadCache(root)).toBeNull();
	});

	it("P10: loadCache returns null when JSON parses to null", () => {
		const root = makeTmpDir();
		const path = cachePath(root);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(path, "null");
		expect(loadCache(root)).toBeNull();
	});

	it("P11: loadCache defaults discoveredAt to 0 when not a number", () => {
		const root = makeTmpDir();
		const path = cachePath(root);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ version: 1, discoveredAt: "not-a-number", primitives: [], disabled: [] }),
		);
		const loaded = loadCache(root);
		expect(loaded).not.toBeNull();
		expect(loaded?.discoveredAt).toBe(0);
	});

	it("P12: loadCache preserves a valid numeric discoveredAt", () => {
		const root = makeTmpDir();
		const path = cachePath(root);
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(path, JSON.stringify({ version: 1, discoveredAt: 12345, primitives: [], disabled: [] }));
		const loaded = loadCache(root);
		expect(loaded?.discoveredAt).toBe(12345);
	});

	it("P13: saveCache creates .interlinked dir when absent, and content round-trips via loadCache", () => {
		const root = makeTmpDir();
		expect(existsSync(join(root, ".interlinked"))).toBe(false);
		const cache: DiscoveryCache = { version: 1, discoveredAt: 99, primitives: [], disabled: [] };
		saveCache(root, cache);
		expect(existsSync(join(root, ".interlinked"))).toBe(true);
		const written = JSON.parse(readFileSync(cachePath(root), "utf-8"));
		expect(written).toEqual(cache);
	});

	it("P14: saveCache does not error/re-mkdir when .interlinked already exists", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		const cache: DiscoveryCache = { version: 1, discoveredAt: 1, primitives: [], disabled: [] };
		expect(() => saveCache(root, cache)).not.toThrow();
		expect(existsSync(cachePath(root))).toBe(true);
	});
});

describe("filterDisabled — positive (must fire)", () => {
	function prim(wrapperName: string): DiscoveredPrimitive {
		return {
			wrapperName,
			unsafeBuiltin: "parseInt",
			callSiteCount: 1,
			declarationFile: "src/x.ts",
			discoveredAt: 0,
		};
	}

	it("P15: with empty disabled list, returns the SAME array (identity-preserving fast path)", () => {
		const primitives = [prim("safeParseInt")];
		const cache: DiscoveryCache = { version: 1, discoveredAt: 0, primitives, disabled: [] };
		const result = filterDisabled(cache);
		expect(result).toBe(primitives);
	});

	it("P16: with non-empty disabled list, filters out disabled wrapper names", () => {
		const primitives = [prim("safeParseInt"), prim("safeParseFloat")];
		const cache: DiscoveryCache = {
			version: 1,
			discoveredAt: 0,
			primitives,
			disabled: ["safeParseInt"],
		};
		const result = filterDisabled(cache);
		expect(result).toEqual([prim("safeParseFloat")]);
	});

	it("N1: with non-empty disabled list containing no matches, all primitives survive", () => {
		const primitives = [prim("safeParseInt")];
		const cache: DiscoveryCache = {
			version: 1,
			discoveredAt: 0,
			primitives,
			disabled: ["unrelatedWrapper"],
		};
		const result = filterDisabled(cache);
		expect(result).toEqual(primitives);
	});
});

describe("SKIP_DIRS string literals — positive (must fire)", () => {
	for (const dirName of ["build", "coverage", ".next", ".interlinked", "reference-repos", ".archive"]) {
		it(`P: skips directory named "${dirName}"`, () => {
			const root = makeTmpDir();
			mkdirSync(join(root, dirName), { recursive: true });
			writeFileSync(join(root, dirName, "hidden.ts"), "export {}");
			writeFileSync(join(root, "visible.ts"), "export {}");
			const result = listSourceFiles(root);
			expect(result).toContain(join(root, "visible.ts"));
			expect(result).not.toContain(join(root, dirName, "hidden.ts"));
		});
	}
});
