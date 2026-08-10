import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearManifestCache } from "../harness/mutation/manifest.js";
import type { SurvivorFileRow, SurvivorSummary } from "../harness/mutation/survivors.js";
import { mutationSurvivorsCommand, parseShard, renderSurvivorReport, shardOf } from "./mutation-survivors.js";

function fileRow(file: string, open: number): SurvivorFileRow {
	return {
		file,
		symbols: 1,
		open,
		dispositioned: 0,
		uncovered: 0,
		timeout: 0,
		killed: 10,
		total: 10 + open,
		score: 0.5,
		stale: false,
		remedy: "unknown",
		provenance: null,
	};
}

function summary(over: Partial<SurvivorSummary> = {}): SurvivorSummary {
	return {
		generation: 3,
		authoritativeAt: "2026-08-09T00:00:00.000Z",
		totals: {
			files: 1,
			symbols: 1,
			mutants: 12,
			killed: 10,
			survived: 2,
			open: 2,
			dispositioned: 0,
			uncovered: 0,
			timeout: 0,
			staleFiles: 0,
			unqualifiedFiles: 0,
			openByRemedy: { write_test: 0, strengthen_tests: 2, unknown: 0 },
			score: 0.83,
		},
		files: [fileRow("src/a.ts", 2)],
		symbols: [
			{
				file: "src/a.ts",
				symbolId: "sym",
				qualifiedName: "doThing",
				open: 2,
				dispositioned: 0,
				uncovered: 0,
				total: 12,
				quarantined: false,
			},
		],
		mutators: [{ mutator: "BooleanLiteral", open: 2, total: 4, escapeRate: 0.5 }],
		mutants: [
			{
				file: "src/a.ts",
				symbolId: "sym",
				qualifiedName: "doThing",
				mutantId: "m1",
				mutator: "BooleanLiteral",
				originalLexeme: "true",
				replacement: "false",
				firstSeen: "2026-08-01T00:00:00.000Z",
				disposition: null,
			},
		],
		...over,
	};
}

describe("parseShard", () => {
	it("P1: parses the i/n form into a zero-based index and count", () => {
		expect(parseShard("2/3")).toEqual({ index: 1, count: 3 });
	});

	it("P2: parses the first shard", () => {
		expect(parseShard("1/2")).toEqual({ index: 0, count: 2 });
	});

	it("N1: rejects a shard index outside its count", () => {
		expect(parseShard("3/2")).toBeNull();
	});

	it("N2: rejects malformed input rather than guessing", () => {
		for (const bad of ["", "2", "a/b", "0/2", "2/0", "-1/3"]) expect(parseShard(bad)).toBeNull();
	});
});

describe("shardOf", () => {
	it("P1: round-robins so every shard gets comparable total work", () => {
		const rows = ["a", "b", "c", "d", "e"];
		expect(shardOf(rows, { index: 0, count: 2 })).toEqual(["a", "c", "e"]);
		expect(shardOf(rows, { index: 1, count: 2 })).toEqual(["b", "d"]);
	});

	it("P2: the shards partition the input exactly — nothing lost, nothing duplicated", () => {
		const rows = Array.from({ length: 17 }, (_, i) => `f${i}`);
		const union = [0, 1, 2].flatMap((index) => shardOf(rows, { index, count: 3 }));
		expect(union.sort()).toEqual([...rows].sort());
	});

	it("N1: a single shard is the identity", () => {
		expect(shardOf(["a", "b"], { index: 0, count: 1 })).toEqual(["a", "b"]);
	});

	it("N2: sharding an empty list yields an empty list", () => {
		expect(shardOf([], { index: 1, count: 2 })).toEqual([]);
	});
});

// ===========================================
// End-to-end: the two options whose whole behavior is "which files reach the
// report" (--include-stale, --file) can only be pinned against a real manifest
// on disk, because the filtering happens in the command, not the renderer.
// ===========================================
describe("mutationSurvivorsCommand — file scope options", () => {
	let cwd: string;
	let logs: string[];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mutation-survivors-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "here.ts"), "export const x = 1;\n");
		writeFileSync(
			join(cwd, ".interlinked", "mutation-manifest.json"),
			JSON.stringify({
				version: 1,
				generation: 1,
				authoritativeAt: "2026-08-09T00:00:00.000Z",
				engine: "stryker",
				engineVersion: "8",
				dependencyGraphVersion: "1",
				environmentHash: "env",
				files: {
					"src/here.ts": {
						s1: {
							symbolId: "s1",
							qualifiedName: "here",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: {
								m1: {
									mutantId: "m1",
									siteId: "site1",
									mutator: "BooleanLiteral",
									originalLexeme: "true",
									replacement: "false",
									ordinalWithinSymbol: 0,
									status: "survived",
									firstSeen: "2026-08-01T00:00:00.000Z",
								},
							},
						},
					},
					"src/deleted.ts": {
						s2: {
							symbolId: "s2",
							qualifiedName: "gone",
							symbolHash: "h",
							instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
							mutants: {
								m2: {
									mutantId: "m2",
									siteId: "site2",
									mutator: "BooleanLiteral",
									originalLexeme: "true",
									replacement: "false",
									ordinalWithinSymbol: 0,
									status: "survived",
									firstSeen: "2026-08-01T00:00:00.000Z",
								},
							},
						},
					},
				},
			}),
		);
		clearManifestCache();
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		clearManifestCache();
		vi.restoreAllMocks();
	});

	function reported(): SurvivorSummary {
		return JSON.parse(logs.join("\n")) as SurvivorSummary;
	}

	it("P1: hides survivors in files that no longer exist by default", async () => {
		await mutationSurvivorsCommand({ cwd, json: true });
		const s = reported();
		expect(s.files.map((f) => f.file)).toEqual(["src/here.ts"]);
		expect(s.totals.open).toBe(1);
	});

	it("P2: --include-stale lists them, and the totals grow to match", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, includeStale: true });
		const s = reported();
		expect(s.files.map((f) => f.file).sort()).toEqual(["src/deleted.ts", "src/here.ts"]);
		expect(s.totals.open).toBe(2);
		expect(s.totals.staleFiles).toBe(1);
	});

	it("N1: --file narrows to the one path and reports only its mutants", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, file: "here.ts" });
		const s = reported();
		expect(s.mutants.map((m) => m.mutantId)).toEqual(["m1"]);
	});

	it("N2: a missing manifest is an error exit, not an empty success", async () => {
		const bare = mkdtempSync(join(tmpdir(), "mutation-survivors-bare-"));
		await mutationSurvivorsCommand({ cwd: bare, json: true });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		rmSync(bare, { recursive: true, force: true });
	});

	it("P3: --shard narrows the report to this machine's slice of the ranked files", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, includeStale: true, shard: "1/2" });
		const s = reported();
		// Round-robin over the two manifest files (deleted.ts, here.ts in ranked
		// order) — shard 1/2 keeps every other one, starting at index 0.
		expect(s.files.length).toBeLessThan(2);
	});

	it("N3: an invalid --shard is refused before the manifest is even loaded", async () => {
		await mutationSurvivorsCommand({ cwd, json: true, shard: "0/2" });
		expect(process.exitCode).toBe(1);
		expect(logs.join("\n")).toMatch(/--shard must be/);
		process.exitCode = 0;
	});
});

describe("renderSurvivorReport", () => {
	it("P1: leads with the totals line and the ranked files", () => {
		const text = renderSurvivorReport(summary(), { top: 20 });
		expect(text).toContain("src/a.ts");
		expect(text).toMatch(/open/i);
	});

	it("P2: --top truncates the file table and says how many were hidden", () => {
		const files = Array.from({ length: 5 }, (_, i) => fileRow(`src/f${i}.ts`, 5 - i));
		const text = renderSurvivorReport(summary({ files }), { top: 2 });
		expect(text).toContain("src/f0.ts");
		expect(text).not.toContain("src/f4.ts");
		expect(text).toContain("3 more");
	});

	it("P3: a file-scoped report lists the individual mutants to kill", () => {
		const text = renderSurvivorReport(summary(), { top: 20, file: "src/a.ts" });
		expect(text).toContain("doThing");
		expect(text).toContain("true");
		expect(text).toContain("false");
	});

	it("P4: reports stale files so nobody chases survivors in deleted code", () => {
		const s = summary();
		s.totals.staleFiles = 2;
		expect(renderSurvivorReport(s, { top: 20 })).toMatch(/stale/i);
	});

	it("N1: a clean manifest renders a done message, not an empty table", () => {
		const s = summary({ files: [], symbols: [], mutants: [], mutators: [] });
		s.totals.open = 0;
		expect(renderSurvivorReport(s, { top: 20 })).toMatch(/no open surviving mutants/i);
	});

	it("N2: never renders NaN when the manifest is empty", () => {
		const s = summary({ files: [], symbols: [], mutants: [], mutators: [] });
		s.totals = { ...s.totals, mutants: 0, killed: 0, survived: 0, open: 0, score: 1 };
		expect(renderSurvivorReport(s, { top: 20 })).not.toContain("NaN");
	});

	it("P5: warns when files carry no measurement provenance, naming the share and the fix", () => {
		const s = summary();
		s.totals.unqualifiedFiles = 1;
		s.totals.files = 1;
		const text = renderSurvivorReport(s, { top: 20 });
		expect(text).toMatch(/no measurement provenance/i);
		expect(text).toContain("100%");
		expect(text).toContain("mutation sweep");
	});

	it("P6: prints the shard-of-total note when the report is scoped to a shard", () => {
		const text = renderSurvivorReport(summary(), { top: 20, shard: { index: 0, count: 4 } });
		expect(text).toContain("shard 1/4");
	});
});
