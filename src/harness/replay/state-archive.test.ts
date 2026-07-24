// G2 per-step harness-state archive — pins the Tier-2 restore contract
// (docs/design/reproducibility/g2-tree-snapshots.md): the live snapshot +
// the six baseline water-line files are archived PER STEP (live.json alone is
// overwritten every event and deleted at SessionEnd), content-addressed so
// unchanged-state steps dedup to one blob, absent baselines recorded as null.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BASELINE_FILES,
	loadStateSnapshot,
	recordStateSnapshot,
} from "./state-archive.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-g2-state-"));
	cleanups.push(dir);
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "coverage-baseline.json"), '{"cov":1}');
	writeFileSync(join(dir, ".interlinked", "metric-caps.json"), '{"lines":500}');
	return dir;
}

function record(dir: string, seq: number, live: Record<string, unknown>): void {
	recordStateSnapshot({
		cwd: dir,
		sessionId: "sess-state",
		seq,
		liveSnapshot: live,
		log: () => undefined,
	});
}

describe("recordStateSnapshot / loadStateSnapshot", () => {
	it("round-trips the live snapshot and baseline contents for a seq", () => {
		const dir = fixture();
		record(dir, 3, { tool_call_count: 9 });
		const state = loadStateSnapshot(dir, "sess-state", 3);
		expect(state?.live_snapshot).toEqual({ tool_call_count: 9 });
		expect(state?.baselines["coverage-baseline.json"]).toBe('{"cov":1}');
		expect(state?.baselines["metric-caps.json"]).toBe('{"lines":500}');
	});

	it("records absent baseline files as null (never silently missing)", () => {
		const dir = fixture();
		record(dir, 1, {});
		const state = loadStateSnapshot(dir, "sess-state", 1);
		for (const name of BASELINE_FILES) {
			expect(state ? name in state.baselines : false).toBe(true);
		}
		expect(state?.baselines["mutation-baseline.json"]).toBeNull();
	});

	it("dedups unchanged state to one blob across steps", () => {
		const dir = fixture();
		record(dir, 1, { n: 1 });
		record(dir, 2, { n: 1 });
		record(dir, 3, { n: 2 });
		const blobs = readdirSync(join(dir, ".interlinked", "replay", "state", "blobs"));
		expect(blobs).toHaveLength(2);
		expect(loadStateSnapshot(dir, "sess-state", 2)?.live_snapshot).toEqual({ n: 1 });
		expect(loadStateSnapshot(dir, "sess-state", 3)?.live_snapshot).toEqual({ n: 2 });
	});

	it("returns null for an unknown seq or session", () => {
		const dir = fixture();
		record(dir, 1, {});
		expect(loadStateSnapshot(dir, "sess-state", 99)).toBeNull();
		expect(loadStateSnapshot(dir, "other", 1)).toBeNull();
	});

	it("fails open when the archive dir is unwritable (logs, no throw)", () => {
		const dir = fixture();
		const logs: string[] = [];
		writeFileSync(join(dir, ".interlinked", "replay"), "a file where a dir must go");
		recordStateSnapshot({
			cwd: dir,
			sessionId: "s",
			seq: 1,
			liveSnapshot: {},
			log: (m) => logs.push(m),
		});
		expect(logs.length).toBeGreaterThan(0);
	});
});
