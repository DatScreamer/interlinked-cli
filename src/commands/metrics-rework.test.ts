// ===========================================
// metrics-rework unit tests — pure core (diff hunks → blame ages → classify)
// ===========================================
// The git subprocess loop is exercised via the live command; the parsers and
// the age classification below are pure and tested against fixtures.

import { describe, expect, it } from "vitest";
import {
	classifyRework,
	parseBlamePorcelainTimes,
	parseUnifiedZeroHunks,
} from "./metrics-rework.js";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -3,2 +3,3 @@ function f() {",
	"-old line one",
	"-old line two",
	"+new one",
	"+new two",
	"+new three",
	"@@ -10,0 +12,4 @@",
	"+pure addition — no old side",
	"diff --git a/src/gone.ts b/src/gone.ts",
	"--- a/src/gone.ts",
	"+++ /dev/null",
	"@@ -1,5 +0,0 @@",
	"-deleted",
	"diff --git a/src/new.ts b/src/new.ts",
	"--- /dev/null",
	"+++ b/src/new.ts",
	"@@ -0,0 +1,7 @@",
	"+brand new file",
].join("\n");

describe("parseUnifiedZeroHunks", () => {
	it("extracts old-side ranges per OLD path, keyed for blame-at-parent", () => {
		const hunks = parseUnifiedZeroHunks(DIFF);
		const a = hunks.find((h) => h.file === "src/a.ts");
		expect(a?.ranges).toEqual([{ start: 3, lines: 2 }]);
	});

	it("skips pure additions (old-side length 0)", () => {
		const a = parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/a.ts");
		expect(a?.ranges).toHaveLength(1);
	});

	it("counts deletions against the old path even when the file is removed", () => {
		const gone = parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/gone.ts");
		expect(gone?.ranges).toEqual([{ start: 1, lines: 5 }]);
	});

	it("skips new files entirely (old side is /dev/null)", () => {
		expect(parseUnifiedZeroHunks(DIFF).find((h) => h.file === "src/new.ts")).toBeUndefined();
	});

	it("defaults a bare @@ -N +M @@ header to 1 old line", () => {
		const hunks = parseUnifiedZeroHunks(
			"--- a/x.ts\n+++ b/x.ts\n@@ -7 +7 @@\n-a\n+b\n",
		);
		expect(hunks[0]?.ranges).toEqual([{ start: 7, lines: 1 }]);
	});
});

describe("parseBlamePorcelainTimes", () => {
	// Two commits: full header on first occurrence, bare sha line after.
	const SHA_A = "a".repeat(40);
	const SHA_B = "b".repeat(40);
	const BLAME = [
		`${SHA_A} 3 3 2`,
		"author X",
		"committer-time 1000",
		"filename src/a.ts",
		"\tline three",
		`${SHA_A} 4 4`,
		"\tline four",
		`${SHA_B} 5 5 1`,
		"author Y",
		"committer-time 2000",
		"filename src/a.ts",
		"\tline five",
	].join("\n");

	it("emits one committer-time per content line, resolving repeated shas", () => {
		expect(parseBlamePorcelainTimes(BLAME)).toEqual([1000, 1000, 2000]);
	});

	it("returns empty for empty input", () => {
		expect(parseBlamePorcelainTimes("")).toEqual([]);
	});
});

describe("classifyRework", () => {
	const DAY = 86_400;
	it("counts lines younger than the window as rework", () => {
		const commitTs = 100 * DAY;
		const times = [commitTs - 1 * DAY, commitTs - 13 * DAY, commitTs - 15 * DAY];
		expect(classifyRework(commitTs, times, 14 * DAY)).toEqual({ rework: 2, total: 3 });
	});

	it("treats age exactly at the window as NOT rework (strict <)", () => {
		const commitTs = 100 * DAY;
		expect(classifyRework(commitTs, [commitTs - 14 * DAY], 14 * DAY)).toEqual({
			rework: 0,
			total: 1,
		});
	});

	it("clamps clock skew: a line 'from the future' is rework", () => {
		const commitTs = 100 * DAY;
		expect(classifyRework(commitTs, [commitTs + DAY], 14 * DAY)).toEqual({
			rework: 1,
			total: 1,
		});
	});
});
