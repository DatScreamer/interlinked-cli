// Tests for the Stop digest: signal ranking, the stderr line budget, category
// collapse, and the spool hand-off. "positive (must fire)" = the item reaches
// the operator's screen; "negative (must not fire)" = it is correctly demoted,
// collapsed, or trimmed to the spool.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadStopDigestState } from "./stop-digest-state.js";
import {
	buildStopDigest,
	SPOOL_POINTER,
	STOP_DIGEST_LINE_BUDGET,
	warningTag,
} from "./stop-digest.js";

const LF = String.fromCharCode(10);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-digest-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(warnings: string[], dryRun = false): string[] {
	return buildStopDigest({
		warnings,
		cwd: "/repo",
		sessionId: "S",
		interlinkedDir: dir,
		dryRun,
	});
}

describe("warningTag — positive (must fire)", () => {
	it("P1: extracts the tag from a standard interlinked warning", () => {
		expect(warningTag("[interlinked:slow-test] five 5000ms sleeps")).toBe("slow-test");
	});
});

describe("warningTag — negative (must not fire)", () => {
	it("N1: returns the 'other' bucket for an untagged string", () => {
		expect(warningTag("bare text with no tag")).toBe("other");
	});

	it("N2: does not treat a tag appearing mid-line as the warning's tag", () => {
		expect(warningTag("prefix [interlinked:slow-test] later")).toBe("other");
	});
});

describe("buildStopDigest — positive (must fire)", () => {
	it("P2: puts a measurement-threatening timing warning above reflection counts", () => {
		const out = run([
			"[interlinked:commit-cadence] 12 uncommitted files",
			"[interlinked:turn-end] you re-read files",
			"[interlinked:slow-test] five 5000ms sleeps would void the measurement",
		]);
		expect(out[0]).toContain("5000ms sleeps");
	});

	it("P3: ranks an introduced-finding warning above a timing warning", () => {
		const out = run([
			"[interlinked:slow-test] sleeps",
			"[interlinked:stop-rescan] 1 file(s) you touched carry findings",
		]);
		expect(out[0]).toContain("stop-rescan");
	});

	it("P4: always points at the spool file so trimmed detail stays findable", () => {
		const out = run(["[interlinked:stop-rescan] a finding"]);
		expect(out.join(LF)).toContain(SPOOL_POINTER);
	});

	it("P5: collapses several warnings of one category into a single count line", () => {
		const out = run([
			"[interlinked:stop-rescan] top item",
			"[interlinked:gate-reach] one",
			"[interlinked:gate-reach] two",
			"[interlinked:gate-reach] three",
		]);
		const line = out.find((l) => l.startsWith("[interlinked:digest] gate-reach")) ?? "";
		expect(line).toContain("x3");
	});

	it("P6: records the emitted tags so a later Stop can see what was reported", () => {
		run(["[interlinked:mutation-kill-evidence] awaiting measurement"]);
		expect(loadStopDigestState(dir).sessions.S?.reported_tags).toContain(
			"mutation-kill-evidence",
		);
	});

	it("P7: combines multiple turn-end churn nudges into ONE line", () => {
		const out = run([
			"[interlinked:turn-end] re-read files",
			"[interlinked:turn-end] a file was edited 4+ times",
		]);
		expect(out.filter((l) => l.includes("turn-end"))).toHaveLength(1);
	});

	it("P8: keeps the whole digest inside the stderr line budget", () => {
		const many = Array.from({ length: 40 }, (_v, i) =>
			[`[interlinked:stop-rescan] item ${i}`, "detail", "detail", "detail", "detail"].join(LF),
		);
		const lines = run(many).join(LF).split(LF);
		expect(lines.length).toBeLessThanOrEqual(STOP_DIGEST_LINE_BUDGET);
	});
});

describe("buildStopDigest — negative (must not fire)", () => {
	it("N3: returns nothing at all when there are no warnings", () => {
		expect(run([])).toEqual([]);
	});

	it("N4: drops a LONE turn-end churn nudge (low value below a high count)", () => {
		const out = run(["[interlinked:turn-end] re-read files"]);
		expect(out.join(LF)).not.toContain("turn-end");
	});

	it("N5: does not print the body of a category demoted by higher-tier competition", () => {
		// Three actionable/measurement categories fill every top slot, so the
		// reflection nudge behind them survives only as a count line.
		const out = run([
			"[interlinked:stop-rescan] one",
			"[interlinked:debt-evasion] two",
			"[interlinked:slow-test] three",
			"[interlinked:commit-cadence] a very distinctive uncommitted-file sentence",
		]);
		expect(out.join(LF)).not.toContain("distinctive uncommitted-file sentence");
		expect(out.join(LF)).toContain("[interlinked:digest] commit-cadence");
	});

	it("N6: writes no state under dryRun", () => {
		run(["[interlinked:stop-rescan] a finding"], true);
		expect(loadStopDigestState(dir).sessions).toEqual({});
	});
});
