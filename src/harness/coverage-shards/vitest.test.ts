// Tests for the production Vitest shard-capture adapter — the capture module
// generator, istanbul → canonical element-set conversion, captured-record
// parsing, and one real end-to-end capture run against a tmp fixture (the
// productionized Phase 0 spike path; see
// docs/design/incremental-per-edit-coverage-phase0-spike.md).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureProviderSource,
	captureVitestShards,
	istanbulToElementSets,
	parseShardRecord,
	shardIdForRecord,
	shardIdForTestFile,
} from "./vitest.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "cov-shards-vitest-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
	const abs = join(scratch, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

// ==================================================================
// captureProviderSource — the generated .mjs capture module
// ==================================================================

describe("captureProviderSource", () => {
	const source = captureProviderSource("file:///repo/node_modules/@vitest/coverage-v8/dist/index.js", "/tmp/out");

	it("imports the resolved provider URL and embeds the output dir (no env plumbing)", () => {
		expect(source).toContain('from "file:///repo/node_modules/@vitest/coverage-v8/dist/index.js"');
		expect(source).toContain(JSON.stringify("/tmp/out"));
	});

	it("runtime-checks the private convertCoverage and writes the degraded marker on a miss", () => {
		expect(source).toContain("convertCoverage");
		expect(source).toContain("capture-degraded.json");
	});

	it("hooks the public surfaces: onAfterSuiteRun for stashing, generateReports for conversion", () => {
		expect(source).toContain("onAfterSuiteRun");
		expect(source).toContain("generateReports");
	});

	it("stash keys carry project + environment + transformMode, not just the file list (round 6)", () => {
		// In a vitest WORKSPACE the same test file runs once per project; a
		// files-only key made each later run overwrite the earlier one's
		// coverage and pass/fail evidence.
		expect(source).toContain("meta.projectName ?? ");
		expect(source).toContain("meta.environment ?? ");
		expect(source).toContain("meta.transformMode ?? ");
	});
});

// ==================================================================
// shardIdForRecord — workspace-project identity (round 6)
// ==================================================================

describe("shardIdForRecord", () => {
	function record(project: string | null): Parameters<typeof shardIdForRecord>[0] {
		return {
			version: 1,
			testFiles: ["tests/a.test.mjs"],
			environment: "node",
			project,
			durationMs: null,
			passed: true,
			istanbul: {},
		};
	}

	it("qualifies named-project records so same-file shards do not collide", () => {
		const idA = shardIdForRecord(record("project-a"), "/repo");
		const idB = shardIdForRecord(record("project-b"), "/repo");
		expect(idA).toBe("tests/a.test.mjs#project-a");
		expect(idB).toBe("tests/a.test.mjs#project-b");
		expect(idA).not.toBe(idB);
	});

	it("leaves single-project (unnamed) records unqualified — the common path", () => {
		expect(shardIdForRecord(record(null), "/repo")).toBe("tests/a.test.mjs");
	});
});

// ==================================================================
// istanbulToElementSets — istanbul shapes → canonical element sets
// ==================================================================

describe("istanbulToElementSets", () => {
	const FILE = "/repo/src/m.ts";

	function istanbulFixture(): Record<string, unknown> {
		return {
			[FILE]: {
				path: FILE,
				statementMap: {
					"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
					"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
					"2": { start: { line: 2, column: 12 }, end: { line: 2, column: 20 } },
					"3": { start: { line: 4, column: 0 }, end: { line: 4, column: 9 } },
				},
				s: { "0": 3, "1": 0, "2": 5, "3": 0 },
				branchMap: {
					"0": {
						line: 2,
						type: "if",
						loc: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
						locations: [
							{ start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
							{ start: { line: 2, column: 12 }, end: { line: 2, column: 20 } },
						],
					},
				},
				b: { "0": [4, 0] },
				fnMap: {
					"0": {
						name: "foo",
						decl: { start: { line: 1, column: 9 }, end: { line: 1, column: 12 } },
						loc: { start: { line: 1, column: 20 }, end: { line: 3, column: 1 } },
					},
				},
				f: { "0": 3 },
			},
		};
	}

	it("maps statements to per-line max hits (istanbul getLineCoverage semantics)", () => {
		const sets = istanbulToElementSets(istanbulFixture(), "/repo");
		const m = sets.get("src/m.ts");
		expect(m).toBeDefined();
		expect(m?.lines.get(1)).toBe(3);
		// Two statements on line 2 with hits 0 and 5 → the line reports 5.
		expect(m?.lines.get(2)).toBe(5);
		// An uncovered statement keeps its line in the denominator at 0 hits.
		expect(m?.lines.get(4)).toBe(0);
	});

	it("keys branches by line:branchId:pathIndex with per-path hits", () => {
		const m = istanbulToElementSets(istanbulFixture(), "/repo").get("src/m.ts");
		expect(m?.branches.get("2:0:0")).toBe(4);
		expect(m?.branches.get("2:0:1")).toBe(0);
	});

	it("keys functions by name@declLine and keeps statement data", () => {
		const m = istanbulToElementSets(istanbulFixture(), "/repo").get("src/m.ts");
		expect(m?.functions.get("foo@1")).toBe(3);
		expect(m?.statements?.size).toBe(4);
	});

	it("unwraps {data: …} FileCoverage envelopes and skips files outside the root", () => {
		const wrapped = {
			[FILE]: { data: (istanbulFixture() as Record<string, unknown>)[FILE] },
			"/elsewhere/x.ts": {
				path: "/elsewhere/x.ts",
				statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
				s: { "0": 1 },
				branchMap: {},
				b: {},
				fnMap: {},
				f: {},
			},
		};
		const sets = istanbulToElementSets(wrapped, "/repo");
		expect(sets.get("src/m.ts")?.lines.get(1)).toBe(3);
		expect(sets.size).toBe(1);
	});

	it("tolerates malformed entries by skipping them", () => {
		const sets = istanbulToElementSets({ [FILE]: "garbage", "/repo/ok.ts": null }, "/repo");
		expect(sets.size).toBe(0);
	});
});

// ==================================================================
// parseShardRecord + shardIdForTestFile
// ==================================================================

describe("parseShardRecord", () => {
	it("accepts a well-formed record and rejects structural mismatches", () => {
		const good = {
			version: 1,
			testFiles: ["tests/a.test.ts"],
			environment: "ssr",
			project: null,
			durationMs: 412,
			passed: true,
			istanbul: {},
		};
		expect(parseShardRecord(good)).not.toBeNull();
		expect(parseShardRecord(null)).toBeNull();
		expect(parseShardRecord({ ...good, version: 2 })).toBeNull();
		expect(parseShardRecord({ ...good, testFiles: "nope" })).toBeNull();
		expect(parseShardRecord({ ...good, istanbul: "nope" })).toBeNull();
	});

	it("treats absent duration/passed as null (runtime-checked capture may degrade)", () => {
		const parsed = parseShardRecord({
			version: 1,
			testFiles: ["t.test.ts"],
			environment: "ssr",
			project: null,
			durationMs: null,
			passed: null,
			istanbul: {},
		});
		expect(parsed?.durationMs).toBeNull();
		expect(parsed?.passed).toBeNull();
	});
});

describe("shardIdForTestFile", () => {
	it("normalizes absolute and relative test paths to repo-relative POSIX", () => {
		expect(shardIdForTestFile("/repo/tests/a.test.ts", "/repo")).toBe("tests/a.test.ts");
		expect(shardIdForTestFile("tests/a.test.ts", "/repo")).toBe("tests/a.test.ts");
	});
});

// ==================================================================
// captureVitestShards — real end-to-end capture (productionized spike)
// ==================================================================

describe("captureVitestShards — real vitest run", () => {
	it(
		"captures per-shard contributions with real line identities, pass state, and durations",
		async () => {
			// Fixture mirrors the Phase 0 spike: two tests, one shared function.
			// Line numbers in src/calc.mjs are load-bearing for the assertions.
			write("package.json", JSON.stringify({ name: "capture-fixture", type: "module" }));
			write(
				"src/calc.mjs",
				[
					"export function shared() {",
					"	return 1 + 1;", // line 2 — covered by BOTH shards
					"}",
					"export function onlyA() {",
					"	return 2 + shared();", // line 5 — covered by shard A only
					"}",
					"export function onlyB() {",
					"	return 3 + shared();", // line 8 — covered by shard B only
					"}",
					"",
				].join("\n"),
			);
			write(
				"tests/a.test.mjs",
				[
					'import { expect, test } from "vitest";',
					'import { onlyA, shared } from "../src/calc.mjs";',
					'test("a", () => {',
					"	expect(shared()).toBe(2);",
					"	expect(onlyA()).toBe(4);",
					"});",
					"",
				].join("\n"),
			);
			write(
				"tests/b.test.mjs",
				[
					'import { expect, test } from "vitest";',
					'import { onlyB } from "../src/calc.mjs";',
					'test("b", () => {',
					"	expect(onlyB()).toBe(5);",
					"});",
					"",
				].join("\n"),
			);
			// Bare fixture has no node_modules: link the repo's vitest bin (realpath,
			// so its own imports resolve from the repo's node_modules).
			const repoVitest = join(process.cwd(), "node_modules/vitest/vitest.mjs");
			mkdirSync(join(scratch, "node_modules/.bin"), { recursive: true });
			symlinkSync(repoVitest, join(scratch, "node_modules/.bin/vitest"));

			const captureDir = join(scratch, ".capture");
			const result = await captureVitestShards({
				projectRoot: scratch,
				captureDir,
				timeoutMs: 60_000,
			});

			expect(result.degraded).toBeNull();
			expect(result.runResult.testsPassed).toBe(true);
			expect(result.shards).toHaveLength(2);

			const byId = new Map(result.shards.map((s) => [s.shardId, s]));
			const a = byId.get("tests/a.test.mjs");
			const b = byId.get("tests/b.test.mjs");
			expect(a).toBeDefined();
			expect(b).toBeDefined();

			const aCalc = a?.contribution.files.get("src/calc.mjs");
			const bCalc = b?.contribution.files.get("src/calc.mjs");
			expect(aCalc).toBeDefined();
			expect(bCalc).toBeDefined();
			// shared() body (line 2): covered by both shards.
			expect(aCalc?.lines.get(2) ?? 0).toBeGreaterThan(0);
			expect(bCalc?.lines.get(2) ?? 0).toBeGreaterThan(0);
			// onlyA body (line 5): covered by A, present-but-uncovered for B.
			expect(aCalc?.lines.get(5) ?? 0).toBeGreaterThan(0);
			expect(bCalc?.lines.get(5)).toBe(0);
			// onlyB body (line 8): the mirror image.
			expect(bCalc?.lines.get(8) ?? 0).toBeGreaterThan(0);
			expect(aCalc?.lines.get(8)).toBe(0);
			// Function identities carry real declaration lines.
			expect(aCalc?.functions.get("onlyA@4") ?? 0).toBeGreaterThan(0);
			// Per-shard pass state and duration came from the run's task state.
			expect(a?.passed).toBe(true);
			expect(b?.passed).toBe(true);
			expect(a?.durationMs === null || (a?.durationMs ?? 0) >= 0).toBe(true);
		},
		90_000,
	);
});
