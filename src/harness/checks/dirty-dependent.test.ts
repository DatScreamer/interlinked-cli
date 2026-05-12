import { describe, expect, it } from "vitest";
import {
	findDirtyDependents,
	formatDirtyDependentWarning,
} from "./dirty-dependent.js";

// Helper: build a `getImporters(file)` closure from an importer-edges map.
//   importers["src/a.ts"] = ["src/b.ts"] means b imports a
function makeGetImporters(map: Record<string, string[]>) {
	return (f: string) => map[f] ?? [];
}

const isTestFile = (f: string) => /\.(test|spec)\.[tj]sx?$/.test(f);

describe("findDirtyDependents", () => {
	it("returns empty when nothing is staged", () => {
		const result = findDirtyDependents({
			stagedFiles: [],
			unstagedDirtyFiles: ["src/b.test.ts"],
			getImporters: makeGetImporters({}),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("returns empty when nothing is dirty-unstaged", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: [],
			getImporters: makeGetImporters({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("flags a direct dirty importer", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeGetImporters({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			staged: "src/a.ts",
			dirtyImporter: "src/b.ts",
			hopCount: 1,
			isTest: false,
		});
	});

	it("flags a transitive dirty importer with the right hop count", () => {
		// a → b → c.test.ts
		// staged: a, dirty: c.test.ts
		// c.test.ts imports b imports a. c is 2 hops from a.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/c.test.ts"],
			getImporters: makeGetImporters({
				"src/a.ts": ["src/b.ts"],
				"src/b.ts": ["src/c.test.ts"],
			}),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			staged: "src/a.ts",
			dirtyImporter: "src/c.test.ts",
			hopCount: 2,
			isTest: true,
		});
	});

	it("does NOT flag a dirty file that is also staged (intentional partial)", () => {
		// b imports a; both a and b are staged AND b is dirty (mixed-stage).
		// Don't flag — agent is shipping both halves together.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts", "src/b.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeGetImporters({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("walks through a staged intermediate to reach a dirty transitive importer", () => {
		// a → b (staged) → c.test.ts (dirty)
		// Even though b is staged, c.test.ts beyond it is still dirty and
		// should be flagged — its changes won't go in this commit.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts", "src/b.ts"],
			unstagedDirtyFiles: ["src/c.test.ts"],
			getImporters: makeGetImporters({
				"src/a.ts": ["src/b.ts"],
				"src/b.ts": ["src/c.test.ts"],
			}),
			isTestFile,
		});
		const importers = result.map((r) => r.dirtyImporter);
		expect(importers).toContain("src/c.test.ts");
	});

	it("dedupes when one dirty importer reaches one staged file via multiple paths", () => {
		// a → b, a → c; b → d.test.ts, c → d.test.ts
		// Only one (a, d.test.ts) pair should be returned.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/d.test.ts"],
			getImporters: makeGetImporters({
				"src/a.ts": ["src/b.ts", "src/c.ts"],
				"src/b.ts": ["src/d.test.ts"],
				"src/c.ts": ["src/d.test.ts"],
			}),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.dirtyImporter).toBe("src/d.test.ts");
	});

	it("handles import cycles without infinite loop", () => {
		// a → b → a (cycle); staged: x; dirty: a.test.ts
		// x → a, and a/b cycle. The visited set prevents revisits.
		const result = findDirtyDependents({
			stagedFiles: ["src/x.ts"],
			unstagedDirtyFiles: ["src/a.test.ts"],
			getImporters: makeGetImporters({
				"src/x.ts": ["src/a.ts"],
				"src/a.ts": ["src/b.ts", "src/a.test.ts"],
				"src/b.ts": ["src/a.ts"],
			}),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyImporter)).toContain("src/a.test.ts");
	});

	it("respects the maxDepth cap", () => {
		// 5-hop chain; with maxDepth=2 the deep dirty importer is not reached.
		const importers: Record<string, string[]> = {
			"src/a.ts": ["src/b.ts"],
			"src/b.ts": ["src/c.ts"],
			"src/c.ts": ["src/d.ts"],
			"src/d.ts": ["src/e.ts"],
		};
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/e.ts"],
			getImporters: makeGetImporters(importers),
			isTestFile,
			maxDepth: 2,
		});
		expect(result).toEqual([]);
	});

	it("orders matches by isTest first, then hopCount", () => {
		// Two dirty importers — one is a test, one is not. Test should be first.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts", "src/c.test.ts"],
			getImporters: makeGetImporters({
				"src/a.ts": ["src/b.ts", "src/c.test.ts"],
			}),
			isTestFile,
		});
		expect(result[0]?.dirtyImporter).toBe("src/c.test.ts");
		expect(result[1]?.dirtyImporter).toBe("src/b.ts");
	});
});

describe("formatDirtyDependentWarning", () => {
	it("returns null on no matches", () => {
		expect(formatDirtyDependentWarning({ matches: [] })).toBeNull();
	});

	it("includes the file pair, hop count, and TEST tag", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{
					staged: "src/a.ts",
					dirtyImporter: "src/b.test.ts",
					hopCount: 1,
					isTest: true,
				},
			],
		});
		expect(msg).toContain("src/a.ts");
		expect(msg).toContain("src/b.test.ts");
		expect(msg).toContain("[TEST]");
		expect(msg).toContain("dirty in the working tree");
	});

	it("uses the test-aware headline when any match is a test", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{ staged: "src/a.ts", dirtyImporter: "src/b.ts", hopCount: 1, isTest: false },
				{ staged: "src/a.ts", dirtyImporter: "src/c.test.ts", hopCount: 2, isTest: true },
			],
		});
		expect(msg).toMatch(/dirty importer is a TEST/);
	});

	it("uses the non-test headline when no match is a test", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{ staged: "src/a.ts", dirtyImporter: "src/b.ts", hopCount: 1, isTest: false },
			],
		});
		expect(msg).toMatch(/dirty importer has unstaged changes/);
		expect(msg).not.toMatch(/TEST/);
	});

	it("describes transitive hops in the line", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{ staged: "src/a.ts", dirtyImporter: "src/c.test.ts", hopCount: 3, isTest: true },
			],
		});
		expect(msg).toMatch(/transitively, 3 hops/);
	});

	it("truncates to maxShown with an 'and N more' suffix", () => {
		const matches = Array.from({ length: 8 }, (_, i) => ({
			staged: "src/a.ts",
			dirtyImporter: `src/dep-${i}.ts`,
			hopCount: 1,
			isTest: false,
		}));
		const msg = formatDirtyDependentWarning({ matches, maxShown: 3 });
		expect(msg).toContain("dep-0.ts");
		expect(msg).toContain("dep-2.ts");
		expect(msg).not.toContain("dep-3.ts");
		expect(msg).toContain("...and 5 more");
	});
});
