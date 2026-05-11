// Tests for the recency-weighted check depth helper. Adapted from
// Mythos's "hot paths are well-audited; new code is where bugs live"
// observation. Files that change frequently get the full advisory
// pipeline; files unchanged for 6+ months only run block-class
// checks. The check pipeline reads this map and skips advisory
// detectors for cold files.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FilePriority,
	parseGitLogOutput,
	priorityTierForAge,
	shouldRunAdvisoryChecks,
} from "../file-priority.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-fp-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("priorityTierForAge", () => {
	it('returns "hot" for files modified within the last 7 days', () => {
		expect(priorityTierForAge(0)).toBe("hot");
		expect(priorityTierForAge(3)).toBe("hot");
		expect(priorityTierForAge(6)).toBe("hot");
	});

	it('returns "warm" for files modified 7-180 days ago', () => {
		expect(priorityTierForAge(7)).toBe("warm");
		expect(priorityTierForAge(90)).toBe("warm");
		expect(priorityTierForAge(180)).toBe("warm");
	});

	it('returns "cold" for files unchanged for more than 180 days', () => {
		expect(priorityTierForAge(181)).toBe("cold");
		expect(priorityTierForAge(365)).toBe("cold");
		expect(priorityTierForAge(9999)).toBe("cold");
	});

	it('returns "cold" for unknown / never-tracked files (negative ageDays)', () => {
		// Files git doesn't know about (untracked or newly added but not
		// committed) get the cold treatment — we have no evidence they're
		// recent work. The check pipeline can still run defaults for
		// untracked files via the existing diff-aware path.
		expect(priorityTierForAge(-1)).toBe("cold");
	});
});

describe("parseGitLogOutput", () => {
	it("returns an empty map for empty input", () => {
		expect(parseGitLogOutput("", 1_700_000_000_000)).toEqual(new Map());
	});

	it("parses one file per commit and keeps the most recent timestamp", () => {
		// Format: COMMIT-TIMESTAMP\n<file1>\n<file2>\n\nCOMMIT-TIMESTAMP\n<file3>...
		// Most-recent first (git default). For each file, the FIRST
		// occurrence wins because subsequent ones are older.
		const now = 1_700_000_000_000;
		const out = [
			`${Math.floor(now / 1000)}`,
			"src/a.ts",
			"src/b.ts",
			"",
			`${Math.floor(now / 1000) - 30 * 24 * 60 * 60}`,
			"src/a.ts",
			"src/c.ts",
		].join("\n");

		const map = parseGitLogOutput(out, now);
		// a.ts touched both commits — youngest (0 days) wins.
		expect(map.get("src/a.ts")?.ageDays).toBe(0);
		expect(map.get("src/b.ts")?.ageDays).toBe(0);
		// c.ts only in the 30-days-ago commit.
		expect(map.get("src/c.ts")?.ageDays).toBeCloseTo(30, 0);
	});

	it("tags each entry with the computed tier", () => {
		const now = 1_700_000_000_000;
		const out = [
			`${Math.floor(now / 1000)}`,
			"recent.ts",
			"",
			`${Math.floor(now / 1000) - 90 * 24 * 60 * 60}`,
			"middle.ts",
			"",
			`${Math.floor(now / 1000) - 365 * 24 * 60 * 60}`,
			"ancient.ts",
		].join("\n");

		const map = parseGitLogOutput(out, now);
		expect(map.get("recent.ts")?.tier).toBe("hot");
		expect(map.get("middle.ts")?.tier).toBe("warm");
		expect(map.get("ancient.ts")?.tier).toBe("cold");
	});

	it("ignores malformed commit blocks (non-numeric timestamp)", () => {
		const now = 1_700_000_000_000;
		const out = ["not-a-number", "src/a.ts", "", `${Math.floor(now / 1000)}`, "src/b.ts"].join(
			"\n",
		);
		const map = parseGitLogOutput(out, now);
		expect(map.has("src/a.ts")).toBe(false);
		expect(map.has("src/b.ts")).toBe(true);
	});
});

describe("shouldRunAdvisoryChecks", () => {
	function makeMap(
		entries: Array<[string, FilePriority["tier"]]>,
	): Map<string, FilePriority> {
		const m = new Map<string, FilePriority>();
		for (const [path, tier] of entries) {
			const ageDays = tier === "hot" ? 1 : tier === "warm" ? 30 : 365;
			m.set(path, { ageDays, tier });
		}
		return m;
	}

	it("returns true for hot files", () => {
		const m = makeMap([["src/a.ts", "hot"]]);
		expect(shouldRunAdvisoryChecks("src/a.ts", m)).toBe(true);
	});

	it("returns true for warm files (advisory checks still run)", () => {
		// 7-180 days: we still run the full advisory set. Tier "cold"
		// is the only one that skips advisories.
		const m = makeMap([["src/a.ts", "warm"]]);
		expect(shouldRunAdvisoryChecks("src/a.ts", m)).toBe(true);
	});

	it("returns false for cold files", () => {
		const m = makeMap([["src/a.ts", "cold"]]);
		expect(shouldRunAdvisoryChecks("src/a.ts", m)).toBe(false);
	});

	it("returns true (fail-open) when the file is not in the priority map", () => {
		// Untracked or newly-added files don't appear in git log output.
		// Default behavior must run ALL checks — never silently drop
		// coverage on new code, which is the highest-bug-likelihood
		// case per Mythos's observation.
		const m = makeMap([["src/other.ts", "cold"]]);
		expect(shouldRunAdvisoryChecks("src/missing.ts", m)).toBe(true);
	});
});
