// ===========================================
// verify-summary unit tests
// ===========================================
// Pins the invariant for the tail "X / Y files flagged" summary:
//   - numerator ≤ denominator (always — regression: v0 produced 68 / 67),
//   - synthetic sentinels like "<project>" do not inflate the numerator,
//   - a file flagged by an external tool but outside the discovered source
//     sweep (e.g. tsc error in tsconfig.json) expands both sides so the ratio
//     stays meaningful.

import { describe, expect, it } from "vitest";
import { summarizeFlaggedFiles } from "./verify-summary.js";

describe("summarizeFlaggedFiles", () => {
	it("reports numerator ≤ denominator and drops the <project> sentinel", () => {
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`, `${cwd}/src/c.ts`];
		// Mirror the real mix in allFlaggedFiles: absolute hit, relative hit,
		// bare-filename hit, the project sentinel.
		const flagged = new Set([
			`${cwd}/src/a.ts`, // absolute — same as discovered[0]
			"src/b.ts", // relative — same as discovered[1]
			"tsconfig.json", // non-source file flagged by tsc
			"<project>", // project-wide LOC-ratio finding
		]);
		const tally = summarizeFlaggedFiles(cwd, files, flagged);
		expect(tally.flaggedFiles).toBe(3); // a.ts, b.ts, tsconfig.json
		expect(tally.totalFiles).toBe(4); // + c.ts from discovered
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("never exceeds the denominator even when every path is synthetic or non-discovered", () => {
		const cwd = "/repo";
		const flagged = new Set(["<project>", "<project>", "tsconfig.json", "package.json"]);
		const tally = summarizeFlaggedFiles(cwd, [], flagged);
		// A Set collapses the duplicate "<project>" token, so only one project
		// finding reaches us. Both non-source hits land in the universe.
		expect(tally.flaggedFiles).toBe(2);
		expect(tally.totalFiles).toBe(2);
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("returns a zero tally when nothing is flagged", () => {
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`];
		const tally = summarizeFlaggedFiles(cwd, files, new Set());
		expect(tally).toEqual({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
	});
});
