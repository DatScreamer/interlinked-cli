// Tests for `interlinked tdd` — the inspection and reset path for TDD cycle
// state. This exists because the commit gate blocks on remembered state that
// nothing re-measures, and when that memory went wrong there was no way to see
// what the gate believed or to correct it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockingCycles, clearCycles, collectCycles, sessionSnapshotPaths } from "./tdd.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tdd-cmd-"));
	mkdirSync(join(root, ".interlinked", "sessions"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a session snapshot with the given cycles. */
function snapshot(id: string, step: number, cycles: Record<string, unknown>[]): void {
	writeFileSync(
		join(root, ".interlinked", "sessions", `${id}.json`),
		JSON.stringify({
			tool_call_count: step,
			tdd_cycles: Object.fromEntries(cycles.map((c) => [c.source_file as string, c])),
		}),
	);
}

const redCycle = {
	source_file: "/r/a.ts",
	test_file: "/r/a.test.ts",
	state: "red",
	red_at: 40,
	red_command: "npx vitest run /r/a.test.ts",
	impl_edits_before_test: 0,
};

describe("sessionSnapshotPaths", () => {
	it("finds snapshots and ignores anchor sidecars", () => {
		snapshot("s1", 50, [redCycle]);
		writeFileSync(join(root, ".interlinked", "sessions", "s1.anchor.json"), "{}");
		const paths = sessionSnapshotPaths(root);
		expect(paths).toHaveLength(1);
		expect(paths[0]).toMatch(/s1\.json$/);
	});

	it("returns empty when the sessions dir is absent", () => {
		expect(sessionSnapshotPaths(mkdtempSync(join(tmpdir(), "empty-")))).toEqual([]);
	});
});

describe("collectCycles", () => {
	it("reports state, the run that set the red, and its age", () => {
		snapshot("s1", 146, [redCycle]);
		const [row] = collectCycles(root);
		expect(row?.state).toBe("red");
		expect(row?.red_command).toBe("npx vitest run /r/a.test.ts");
		expect(row?.age).toBe(106);
	});

	it("leaves age undefined for a cycle that was never red", () => {
		snapshot("s1", 10, [{ ...redCycle, state: "green", red_at: undefined }]);
		expect(collectCycles(root)[0]?.age).toBeUndefined();
	});

	// tdd_cycles serializes as an object or as Map entry-pairs depending on the
	// codec path; both must read.
	it("accepts the entry-pair serialization", () => {
		writeFileSync(
			join(root, ".interlinked", "sessions", "s2.json"),
			JSON.stringify({ tool_call_count: 50, tdd_cycles: [["/r/a.ts", redCycle]] }),
		);
		expect(collectCycles(root)).toHaveLength(1);
	});

	it("skips a corrupt snapshot rather than throwing", () => {
		writeFileSync(join(root, ".interlinked", "sessions", "bad.json"), "{ not json");
		snapshot("s1", 50, [redCycle]);
		expect(collectCycles(root)).toHaveLength(1);
	});
});

describe("blockingCycles", () => {
	it("selects only red and regression", () => {
		snapshot("s1", 50, [
			redCycle,
			{ ...redCycle, source_file: "/r/b.ts", state: "green" },
			{ ...redCycle, source_file: "/r/c.ts", state: "regression" },
			{ ...redCycle, source_file: "/r/d.ts", state: "no_test" },
		]);
		expect(blockingCycles(collectCycles(root)).map((r) => r.source_file).sort()).toEqual([
			"/r/a.ts",
			"/r/c.ts",
		]);
	});
});

describe("clearCycles", () => {
	it("drops one cycle by absolute path and leaves the rest", () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts" }]);
		expect(clearCycles(root, "/r/a.ts")).toBe(1);
		expect(collectCycles(root).map((r) => r.source_file)).toEqual(["/r/b.ts"]);
	});

	it("matches on basename too, so the reported name works", () => {
		snapshot("s1", 50, [redCycle]);
		expect(clearCycles(root, "a.ts")).toBe(1);
		expect(collectCycles(root)).toHaveLength(0);
	});

	it("clears every cycle when no file is given", () => {
		snapshot("s1", 50, [redCycle, { ...redCycle, source_file: "/r/b.ts" }]);
		expect(clearCycles(root)).toBe(2);
		expect(collectCycles(root)).toHaveLength(0);
	});

	it("reports 0 and rewrites nothing when nothing matches", () => {
		snapshot("s1", 50, [redCycle]);
		const before = readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8");
		expect(clearCycles(root, "/r/nope.ts")).toBe(0);
		expect(readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8")).toBe(before);
	});

	it("preserves other snapshot fields when rewriting", () => {
		snapshot("s1", 77, [redCycle]);
		clearCycles(root, "/r/a.ts");
		const snap = JSON.parse(readFileSync(join(root, ".interlinked", "sessions", "s1.json"), "utf-8"));
		expect(snap.tool_call_count).toBe(77);
	});
});
