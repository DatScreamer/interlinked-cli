// ===========================================
// metrics-coupling unit tests — pure core (parse → pairs → annotate)
// ===========================================
// The git subprocess is exercised manually (`interlinked metrics coupling`);
// everything below the spawn is pure and tested here.

import { describe, expect, it } from "vitest";
import {
	annotateRelations,
	computeCoupling,
	isCompanionPair,
	parseNameOnlyLog,
} from "./metrics-coupling.js";

const LOG = [
	"aaa\t1700000000",
	"src/a.ts",
	"src/b.ts",
	"",
	"bbb\t1700000100",
	"src/a.ts",
	"src/b.ts",
	"src/c.ts",
	"",
	"ccc\t1700000200",
	"src/a.ts",
	"src/b.ts",
	"",
	"ddd\t1700000300",
	"src/c.ts",
	"",
].join("\n");

describe("parseNameOnlyLog", () => {
	it("parses sha, timestamp, and file list per commit", () => {
		const commits = parseNameOnlyLog(LOG);
		expect(commits).toHaveLength(4);
		expect(commits[0]).toEqual({ sha: "aaa", timestamp: 1700000000, files: ["src/a.ts", "src/b.ts"] });
		expect(commits[3]?.files).toEqual(["src/c.ts"]);
	});

	it("tolerates CRLF and trailing blank lines", () => {
		const commits = parseNameOnlyLog("eee\t1700000400\r\nsrc/x.ts\r\n\r\n\r\n");
		expect(commits).toEqual([{ sha: "eee", timestamp: 1700000400, files: ["src/x.ts"] }]);
	});

	it("returns empty for empty input", () => {
		expect(parseNameOnlyLog("")).toEqual([]);
		expect(parseNameOnlyLog("\n\n")).toEqual([]);
	});

	it("skips malformed header lines rather than throwing", () => {
		const commits = parseNameOnlyLog("not-a-header\nsrc/a.ts\n\nfff\t1700000500\nsrc/b.ts\n");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.sha).toBe("fff");
	});
});

describe("computeCoupling", () => {
	it("counts pair support and per-file revisions, computing Tornhill strength", () => {
		const pairs = computeCoupling(parseNameOnlyLog(LOG), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		const ab = pairs.find((p) => p.a === "src/a.ts" && p.b === "src/b.ts");
		// a: 3 revs, b: 3 revs, together 3 → 3 / ((3+3)/2) = 100%
		expect(ab).toMatchObject({ support: 3, revA: 3, revB: 3, strength: 100 });
		const ac = pairs.find((p) => p.a === "src/a.ts" && p.b === "src/c.ts");
		// a: 3, c: 2, together 1 → 1 / 2.5 = 40%
		expect(ac).toMatchObject({ support: 1, strength: 40 });
	});

	it("applies minSupport and minStrength filters", () => {
		const commits = parseNameOnlyLog(LOG);
		expect(
			computeCoupling(commits, { minSupport: 2, maxCommitFiles: 30, minStrength: 0 }).map(
				(p) => `${p.a}+${p.b}`,
			),
		).toEqual(["src/a.ts+src/b.ts"]);
		expect(
			computeCoupling(commits, { minSupport: 1, maxCommitFiles: 30, minStrength: 50 }).map(
				(p) => `${p.a}+${p.b}`,
			),
		).toEqual(["src/a.ts+src/b.ts"]);
	});

	it("ignores bulk commits over maxCommitFiles entirely", () => {
		const bulk = `big\t1700000600\n${Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`).join("\n")}\n`;
		const pairs = computeCoupling(parseNameOnlyLog(bulk), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		expect(pairs).toEqual([]);
	});

	it("sorts by strength desc, then support desc, and orders each pair lexicographically", () => {
		const pairs = computeCoupling(parseNameOnlyLog(LOG), {
			minSupport: 1,
			maxCommitFiles: 30,
			minStrength: 0,
		});
		expect(pairs[0]?.a).toBe("src/a.ts");
		expect(pairs[0]?.strength).toBeGreaterThanOrEqual(pairs[pairs.length - 1]?.strength ?? 0);
		for (const p of pairs) expect(p.a < p.b).toBe(true);
	});
});

describe("isCompanionPair", () => {
	it("matches same-dir test/SUT siblings in both extensions", () => {
		expect(isCompanionPair("src/foo.ts", "src/foo.test.ts")).toBe(true);
		expect(isCompanionPair("src/foo.spec.tsx", "src/foo.tsx")).toBe(true);
	});

	it("matches __tests__/ siblings with the same stem", () => {
		expect(isCompanionPair("src/x/__tests__/foo.test.ts", "src/x/foo.ts")).toBe(true);
	});

	it("rejects unrelated files, cross-stem tests, and cross-dir pairs", () => {
		expect(isCompanionPair("src/foo.ts", "src/bar.test.ts")).toBe(false);
		expect(isCompanionPair("src/a/foo.ts", "src/b/foo.test.ts")).toBe(false);
		expect(isCompanionPair("src/foo.ts", "src/bar.ts")).toBe(false);
	});
});

describe("annotateRelations", () => {
	const base = { support: 3, revA: 3, revB: 3, strength: 100 };
	it("labels companions by name before consulting the graph", () => {
		const [p] = annotateRelations(
			[{ a: "src/foo.test.ts", b: "src/foo.ts", ...base }],
			() => false,
		);
		expect(p?.relation).toBe("companion");
	});

	it("labels linked vs hidden from the import lookup", () => {
		const pairs = annotateRelations(
			[
				{ a: "src/a.ts", b: "src/b.ts", ...base },
				{ a: "src/a.ts", b: "src/c.ts", ...base },
			],
			(a, b) => a === "src/a.ts" && b === "src/b.ts",
		);
		expect(pairs[0]?.relation).toBe("linked");
		expect(pairs[1]?.relation).toBe("hidden");
	});

	it("labels unknown when the lookup is unavailable", () => {
		const [p] = annotateRelations([{ a: "src/a.ts", b: "src/b.ts", ...base }], () => null);
		expect(p?.relation).toBe("unknown");
	});
});
