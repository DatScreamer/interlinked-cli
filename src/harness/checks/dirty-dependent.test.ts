import { describe, expect, it } from "vitest";
import {
	findDirtyDependents,
	formatDirtyDependentWarning,
	looksCoordinated,
} from "./dirty-dependent.js";

// Helper: build a one-hop neighbor lookup from a map. Used for both the
// importer and the dependency walk — `neighbors["src/a.ts"] = ["src/b.ts"]`
// means the walk steps from a to b.
function makeNeighbors(map: Record<string, string[]>) {
	return (f: string) => map[f] ?? [];
}

const isTestFile = (f: string) => /\.(test|spec)\.[tj]sx?$/.test(f);

describe("findDirtyDependents", () => {
	it("returns empty when nothing is staged", () => {
		const result = findDirtyDependents({
			stagedFiles: [],
			unstagedDirtyFiles: ["src/b.test.ts"],
			getImporters: makeNeighbors({}),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("returns empty when nothing is dirty-unstaged", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: [],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("flags a direct dirty importer", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			staged: "src/a.ts",
			dirtyFile: "src/b.ts",
			direction: "importer",
			hopCount: 1,
			isTest: false,
		});
	});

	it("flags a transitive dirty importer with the right hop count", () => {
		// a → b → c.test.ts; staged a, dirty c.test.ts (2 hops from a).
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/c.test.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/b.ts"],
				"src/b.ts": ["src/c.test.ts"],
			}),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			staged: "src/a.ts",
			dirtyFile: "src/c.test.ts",
			direction: "importer",
			hopCount: 2,
			isTest: true,
		});
	});

	it("does NOT flag a dirty file that is also staged (intentional partial)", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts", "src/b.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("walks through a staged intermediate to reach a dirty transitive importer", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts", "src/b.ts"],
			unstagedDirtyFiles: ["src/c.test.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/b.ts"],
				"src/b.ts": ["src/c.test.ts"],
			}),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyFile)).toContain("src/c.test.ts");
	});

	it("dedupes when one dirty importer reaches one staged file via multiple paths", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/d.test.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/b.ts", "src/c.ts"],
				"src/b.ts": ["src/d.test.ts"],
				"src/c.ts": ["src/d.test.ts"],
			}),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.dirtyFile).toBe("src/d.test.ts");
	});

	it("handles import cycles without infinite loop", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/x.ts"],
			unstagedDirtyFiles: ["src/a.test.ts"],
			getImporters: makeNeighbors({
				"src/x.ts": ["src/a.ts"],
				"src/a.ts": ["src/b.ts", "src/a.test.ts"],
				"src/b.ts": ["src/a.ts"],
			}),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyFile)).toContain("src/a.test.ts");
	});

	it("respects the maxDepth cap", () => {
		const importers: Record<string, string[]> = {
			"src/a.ts": ["src/b.ts"],
			"src/b.ts": ["src/c.ts"],
			"src/c.ts": ["src/d.ts"],
			"src/d.ts": ["src/e.ts"],
		};
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/e.ts"],
			getImporters: makeNeighbors(importers),
			isTestFile,
			maxDepth: 2,
		});
		expect(result).toEqual([]);
	});

	it("orders matches by isTest first, then hopCount", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts", "src/c.test.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/b.ts", "src/c.test.ts"],
			}),
			isTestFile,
		});
		expect(result[0]?.dirtyFile).toBe("src/c.test.ts");
		expect(result[1]?.dirtyFile).toBe("src/b.ts");
	});

	it("flags a dirty dependency in the symmetric direction", () => {
		// Staged a test file; the production code it imports is dirty-unstaged.
		// CI would run the new test against the old production code.
		const result = findDirtyDependents({
			stagedFiles: ["src/a.test.ts"],
			unstagedDirtyFiles: ["src/a.ts"],
			getImporters: makeNeighbors({}),
			getDependencies: makeNeighbors({ "src/a.test.ts": ["src/a.ts"] }),
			isTestFile,
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			staged: "src/a.test.ts",
			dirtyFile: "src/a.ts",
			direction: "dependency",
			hopCount: 1,
		});
	});

	it("skips the dependency-direction walk when getDependencies is omitted", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.test.ts"],
			unstagedDirtyFiles: ["src/a.ts"],
			getImporters: makeNeighbors({}),
			isTestFile,
		});
		expect(result).toEqual([]);
	});

	it("drops candidates rejected by isRelevant, keeps accepted ones", () => {
		const args = {
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		};
		expect(
			findDirtyDependents({ ...args, isRelevant: () => true }),
		).toHaveLength(1);
		expect(findDirtyDependents({ ...args, isRelevant: () => false })).toEqual(
			[],
		);
	});
});

describe("looksCoordinated", () => {
	const fnDiff = (ctx: string, ...lines: string[]) =>
		[`@@ -1,2 +1,3 @@ ${ctx}`, ...lines].join("\n");

	it("treats diffs that cross-reference a changed symbol as coordinated", () => {
		const staged = fnDiff(
			"export function applyDiscount(price: number): number {",
			"-  return price;",
			"+  return price * rate;",
		);
		const dirty = fnDiff(
			'describe("discount", () => {',
			"+  expect(applyDiscount(100)).toBe(90);",
		);
		expect(looksCoordinated([staged, dirty])).toBe(true);
	});

	it("treats diffs with no shared changed symbol as uncoordinated", () => {
		const staged = fnDiff(
			"export function applyDiscount(price: number): number {",
			"-  return price;",
			"+  return price * rate;",
		);
		const dirty = fnDiff(
			"export function formatDate(input: Date): string {",
			"-  return input.toString();",
			"+  return input.toISOString();",
		);
		expect(looksCoordinated([staged, dirty])).toBe(false);
	});

	it("fails open when a diff is empty (insufficient evidence)", () => {
		const dirty = fnDiff(
			"export function formatDate(input: Date): string {",
			"+  return input.toISOString();",
		);
		expect(looksCoordinated(["", dirty])).toBe(true);
	});

	it("fails open when a hunk has no identifiable definition", () => {
		const noContext = ["@@ -1,1 +1,1 @@", "-const x = 1;", "+const x = 2;"].join(
			"\n",
		);
		const dirty = fnDiff(
			"export function formatDate(input: Date): string {",
			"+  return input.toISOString();",
		);
		expect(looksCoordinated([noContext, dirty])).toBe(true);
	});

	// Refinement (2026-05): top-level diffs (new commander registrations,
	// new top-level `const X = …`) produce hunk-contexts that don't yield
	// a definition name. Previously the check failed-open in that case, so
	// an unrelated dirty companion would always trip the warning. The
	// fallback extracts identifier-shaped tokens from added/removed lines
	// instead, so the cross-reference still has a topic to anchor on.
	it("uses fallback identifier extraction when the staged side has no hunk-context", () => {
		// staged: top-level addition with no enclosing function in the hunk
		// header. The fallback should pull `auditCmd` and `auditVerifyCommand`
		// from the added lines.
		const stagedTopLevel = [
			"@@ -180,5 +180,17 @@",
			"+const auditCmd = program",
			'+	.command("audit")',
			'+	.description("Verify audit chain");',
			"+",
			"+auditCmd",
			'+	.command("verify")',
			"+	.action(async (opts) => {",
			"+		const { auditVerifyCommand } = await import('./commands/audit.js');",
			"+		await auditVerifyCommand(opts);",
			"+	});",
		].join("\n");
		// dirty companion: unrelated, names a different symbol.
		const dirtyUnrelated = fnDiff(
			"export const DEFAULT_ADVISORY_SKIPS = new Set<string>([",
			'+	"mock_only_test",',
			'+	"happy_path_only_test",',
		);
		// With the fallback, the staged side's topic set = {auditCmd,
		// auditVerifyCommand, ...}; the dirty side names DEFAULT_ADVISORY_SKIPS.
		// No cross-reference → drop the candidate.
		expect(looksCoordinated([stagedTopLevel, dirtyUnrelated])).toBe(false);
	});

	it("the fallback still surfaces a coordinated edit when the identifier matches", () => {
		const stagedTopLevel = [
			"@@ -180,5 +180,8 @@",
			"+export function applyDiscount(price: number): number {",
			"+	return price * 0.9;",
			"+}",
		].join("\n");
		// Dirty companion mentions applyDiscount on a changed line.
		const dirtyConsumer = fnDiff(
			'describe("discount", () => {',
			"+	expect(applyDiscount(100)).toBe(90);",
		);
		expect(looksCoordinated([stagedTopLevel, dirtyConsumer])).toBe(true);
	});

	it("the fallback excludes JS/TS keywords and universal globals", () => {
		// Both diffs name only keywords/globals — neither contributes a
		// real topic, so even the fallback yields no symbols and the check
		// fails open.
		const onlyKeywords = [
			"@@ -1,1 +1,1 @@",
			"+const x = true;",
			"-const x = false;",
		].join("\n");
		const alsoOnlyKeywords = [
			"@@ -1,1 +1,1 @@",
			"+const y = null;",
			"-const y = undefined;",
		].join("\n");
		expect(looksCoordinated([onlyKeywords, alsoOnlyKeywords])).toBe(true);
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
					dirtyFile: "src/b.test.ts",
					direction: "importer",
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
				{
					staged: "src/a.ts",
					dirtyFile: "src/b.ts",
					direction: "importer",
					hopCount: 1,
					isTest: false,
				},
				{
					staged: "src/a.ts",
					dirtyFile: "src/c.test.ts",
					direction: "importer",
					hopCount: 2,
					isTest: true,
				},
			],
		});
		expect(msg).toMatch(/dirty companion is a TEST/);
	});

	it("uses the non-test headline when no match is a test", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{
					staged: "src/a.ts",
					dirtyFile: "src/b.ts",
					direction: "importer",
					hopCount: 1,
					isTest: false,
				},
			],
		});
		expect(msg).toMatch(/dirty, unstaged companion/);
		expect(msg).not.toMatch(/TEST/);
	});

	it("describes transitive hops in the line", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{
					staged: "src/a.ts",
					dirtyFile: "src/c.test.ts",
					direction: "importer",
					hopCount: 3,
					isTest: true,
				},
			],
		});
		expect(msg).toMatch(/transitively, 3 hops/);
	});

	it("renders the dependency direction (staged imports the dirty file)", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{
					staged: "src/a.test.ts",
					dirtyFile: "src/a.ts",
					direction: "dependency",
					hopCount: 1,
					isTest: false,
				},
			],
		});
		expect(msg).toContain("src/a.test.ts imports");
		expect(msg).toContain("which is dirty in the working tree");
	});

	it("truncates to maxShown with an 'and N more' suffix", () => {
		const matches = Array.from({ length: 8 }, (_, i) => ({
			staged: "src/a.ts",
			dirtyFile: `src/dep-${i}.ts`,
			direction: "importer" as const,
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
