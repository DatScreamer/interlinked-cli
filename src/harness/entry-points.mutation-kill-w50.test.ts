import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(actual.readdirSync),
		existsSync: vi.fn(actual.existsSync),
	};
});

import { existsSync, readdirSync } from "node:fs";
import { collectEntryPoints } from "./entry-points.js";
import type { RouteMap } from "./route-map.js";

const mockedReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;
const mockedExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("entry-points.ts mutation-kill (w50)", () => {
	let tmpDirs: string[] = [];

	afterEach(async () => {
		for (const d of tmpDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
		tmpDirs = [];
		// vi.fn(actual.fn) mocks (created inside the vi.mock factory) are not
		// spies, so vi.restoreAllMocks() alone won't revert a mockImplementation
		// set by a test back to the real fs call — reset explicitly.
		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		mockedReaddirSync.mockImplementation(actualFs.readdirSync);
		mockedExistsSync.mockImplementation(actualFs.existsSync);
		vi.restoreAllMocks();
	});

	function newTmp(prefix = "il-entry-pts-"): string {
		const d = mkTmp(prefix);
		tmpDirs.push(d);
		return d;
	}

	// --- ArrayDeclaration mutants: [] -> ["Stryker was here"] ---------------

	it("returns an exactly-empty array for a project with no package.json, no routeMap, no tests (kills [] init/return mutants)", () => {
		const dir = newTmp();
		const result = collectEntryPoints(dir, { includeTests: true });
		expect(result).toEqual([]);
	});

	it("returns no http_handler entries when routeMap.extractAllEndpoints() is empty (kills the alternate [] site in collectHttpHandlers)", () => {
		const dir = newTmp();
		const fakeRouteMap = {
			extractAllEndpoints: () => [],
		} as unknown as RouteMap;
		const result = collectEntryPoints(dir, { routeMap: fakeRouteMap });
		expect(result).toEqual([]);
	});

	it("never leaks the literal Stryker sentinel into output regardless of options", () => {
		const dir = newTmp();
		const fakeRouteMap = {
			extractAllEndpoints: () => [],
		} as unknown as RouteMap;
		const result = collectEntryPoints(dir, { routeMap: fakeRouteMap, includeTests: true });
		for (const item of result) {
			expect(typeof item).toBe("object");
			expect(item).not.toBe("Stryker was here");
		}
	});

	// --- StringLiteral: `:${ep.line}` -> `` ----------------------------------

	it("appends :<line> to the http_handler reason when a line number is present", () => {
		const dir = newTmp();
		const fakeRouteMap = {
			extractAllEndpoints: () => [
				{ framework: "express", method: "GET", path: "/foo", file: join(dir, "h.ts"), line: 42 },
			],
		} as unknown as RouteMap;
		const result = collectEntryPoints(dir, { routeMap: fakeRouteMap });
		const httpEntries = result.filter((e) => e.kind === "http_handler");
		expect(httpEntries).toHaveLength(1);
		expect(httpEntries[0]?.reason).toBe("express GET /foo:42");
	});

	// --- ConditionalExpression: value !== null -> true (isJsonObject) -------

	it("does not throw when package.json exports is JSON null (kills isJsonObject(null) always-true mutant)", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: null }));
		expect(() => collectEntryPoints(dir)).not.toThrow();
		const result = collectEntryPoints(dir);
		expect(result.some((e) => e.kind === "lib_export")).toBe(false);
	});

	// --- collectTestFiles: seen-dir guard (!dir || seen.has(dir)) -----------

	it("does not re-scan a directory already visited via a different path (kills the seen-guard mutants)", () => {
		const rootDir = newTmp();
		const pDir = join(rootDir, "p");
		const qDir = join(rootDir, "q");
		const dupDir = join(pDir, "dup");

		type FakeEntry = { name: string; isDir: boolean };
		const dirEntries: Record<string, FakeEntry[]> = {
			[rootDir]: [
				{ name: "p", isDir: true },
				{ name: "q", isDir: true },
			],
			[qDir]: [{ name: "../p/dup", isDir: true }],
			[pDir]: [{ name: "dup", isDir: true }],
			[dupDir]: [],
		};

		let readdirCallCount = 0;
		mockedReaddirSync.mockImplementation((dir: unknown) => {
			readdirCallCount++;
			const list = dirEntries[dir as string];
			if (!list) return [] as never;
			return list.map((e) => ({
				name: e.name,
				isDirectory: () => e.isDir,
				isFile: () => !e.isDir,
			})) as never;
		});

		collectEntryPoints(rootDir, { includeTests: true });

		expect(readdirCallCount).toBe(4);
	});

	// --- collectTestFiles: TEST_SKIP_DIRS membership (non-dot names) --------

	it.each(["dist", "build", "coverage", "out", "target", "venv"])(
		"skips descending into %s when scanning for test files",
		(skipDirName) => {
			const dir = newTmp();
			const skipDir = join(dir, skipDirName);
			mkdirSync(skipDir, { recursive: true });
			writeFileSync(join(skipDir, "hidden.test.ts"), "export {};");
			const normalDir = join(dir, "normal");
			mkdirSync(normalDir, { recursive: true });
			writeFileSync(join(normalDir, "present.test.ts"), "export {};");

			const result = collectEntryPoints(dir, { includeTests: true });
			const testFiles = result.filter((e) => e.kind === "test").map((e) => e.file);

			expect(testFiles.some((f) => f.includes(`${skipDirName}${sep}hidden.test.ts`))).toBe(false);
			expect(testFiles.some((f) => f.endsWith(join("normal", "present.test.ts")))).toBe(true);
		},
	);

	// --- collectTestFiles: reason template `test file: ${entry.name}` -------

	it("includes the file name in the test-file reason string", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "found.test.ts"), "export {};");
		const result = collectEntryPoints(dir, { includeTests: true });
		const testEntry = result.find((e) => e.kind === "test");
		expect(testEntry).toBeDefined();
		expect(testEntry?.reason).toBe("test file: found.test.ts");
	});

	// --- walkExportsField: i < node.length off-by-one ------------------------

	it("does not read past the reported length of the exports array (kills i<=length off-by-one mutant)", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "a.js"), "");
		writeFileSync(join(dir, "b.js"), "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: ["./a.js", "./b.js"] }));

		const target = ["./a.js", "./b.js"];
		const lyingArray = new Proxy(target, {
			get(t, prop, receiver) {
				if (prop === "length") return 1;
				return Reflect.get(t, prop, receiver);
			},
		});

		const realParse: (text: string) => unknown = JSON.parse.bind(JSON);
		vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
			const result = realParse(text);
			if (result && typeof result === "object" && !Array.isArray(result) && "exports" in result) {
				(result as { exports: unknown }).exports = lyingArray;
			}
			return result;
		});

		let entries: ReturnType<typeof collectEntryPoints>;
		try {
			entries = collectEntryPoints(dir);
		} finally {
			(JSON.parse as unknown as { mockRestore: () => void }).mockRestore();
		}

		const libExportFiles = entries.filter((e) => e.kind === "lib_export").map((e) => e.file);
		expect(libExportFiles.some((f) => f.endsWith("a.js"))).toBe(true);
		expect(libExportFiles.some((f) => f.endsWith("b.js"))).toBe(false);
	});

	// --- readPackageJson: !existsSync(path) -> false --------------------------

	it("treats package.json as absent when existsSync says so, even if it is really on disk (kills !existsSync always-false mutant)", async () => {
		const dir = newTmp();
		writeFileSync(join(dir, "x.js"), "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./x.js" }));

		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		mockedExistsSync.mockImplementation((p: unknown) => {
			if (typeof p === "string" && p.endsWith("package.json")) return false;
			return actualFs.existsSync(p as string);
		});

		const result = collectEntryPoints(dir);
		expect(result.some((e) => e.reason === "package.json:main")).toBe(false);
	});

	// --- readPackageJson: "utf-8" encoding + happy path -----------------------

	it("reads package.json:main correctly end to end (kills the utf-8 encoding mutant)", () => {
		const dir = newTmp();
		writeFileSync(join(dir, "x.js"), "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "./x.js" }));

		const result = collectEntryPoints(dir);
		const mainEntry = result.find((e) => e.reason === "package.json:main");
		expect(mainEntry).toBeDefined();
		expect(mainEntry?.file.endsWith("x.js")).toBe(true);
	});
});
