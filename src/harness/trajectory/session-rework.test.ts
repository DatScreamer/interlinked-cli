// Oracle tests for the session-rework aggregate (7d): the quantitative roll-up
// of the churn family — share of edits that returned a file to content the
// session had already produced. Nudge-only; thresholds from
// docs/design/history-relational-metrics.md §6.
import { describe, expect, it } from "vitest";
import {
	formatSessionReworkNudge,
	MIN_EDITS_FOR_NUDGE,
	REWORK_RATIO_FLOOR,
	sessionReworkSummary,
} from "./session-rework.js";
import { createState } from "./state.js";
import type { ShaEntry, TrajectoryState } from "./types.js";

function entry(sha: string, atStep: number, normSha = sha): ShaEntry {
	return { sha, normSha, atStep };
}

function stateWith(histories: Record<string, ShaEntry[]>): TrajectoryState {
	const s = createState("t");
	for (const [file, hist] of Object.entries(histories)) {
		s.fileShaHistory.set(file, hist);
	}
	return s;
}

describe("sessionReworkSummary", () => {
	it("counts an edit as rework when its exact content appeared earlier for that file", () => {
		const s = stateWith({
			"a.ts": [entry("s1", 1), entry("s2", 2), entry("s1", 3)], // s1 revisited
		});
		const sum = sessionReworkSummary(s);
		expect(sum.totalEdits).toBe(3);
		expect(sum.revisitedEdits).toBe(1);
		expect(sum.ratio).toBeCloseTo(1 / 3, 5);
	});

	it("excludes whitespace-only cycles (same normSha throughout)", () => {
		const s = stateWith({
			"b.ts": [entry("x1", 1, "n"), entry("x2", 2, "n"), entry("x1", 3, "n")],
		});
		expect(sessionReworkSummary(s).revisitedEdits).toBe(0);
	});

	it("aggregates across files and ranks top offenders", () => {
		const s = stateWith({
			"a.ts": [entry("a1", 1), entry("a2", 2), entry("a1", 3), entry("a2", 4)],
			"b.ts": [entry("b1", 5), entry("b2", 6)],
		});
		const sum = sessionReworkSummary(s);
		expect(sum.totalEdits).toBe(6);
		expect(sum.revisitedEdits).toBe(2);
		expect(sum.topFiles[0]).toEqual({ file: "a.ts", revisits: 2, edits: 4 });
	});

	it("returns zeros for an empty session", () => {
		const sum = sessionReworkSummary(createState("t"));
		expect(sum).toMatchObject({ totalEdits: 0, revisitedEdits: 0, ratio: 0 });
	});
});

describe("formatSessionReworkNudge", () => {
	function summaryOf(revisits: number, total: number) {
		return {
			totalEdits: total,
			revisitedEdits: revisits,
			ratio: total === 0 ? 0 : revisits / total,
			topFiles: [{ file: "a.ts", revisits, edits: total }],
		};
	}

	it("stays silent below the edit floor even at a high ratio", () => {
		expect(formatSessionReworkNudge(summaryOf(3, MIN_EDITS_FOR_NUDGE - 1))).toBeNull();
	});

	it("stays silent below the ratio floor", () => {
		const total = MIN_EDITS_FOR_NUDGE + 4;
		const revisits = Math.floor(total * (REWORK_RATIO_FLOOR - 0.05));
		expect(revisits / total).toBeLessThan(REWORK_RATIO_FLOOR);
		expect(formatSessionReworkNudge(summaryOf(revisits, total))).toBeNull();
	});

	it("fires above both floors, naming the ratio and the top file", () => {
		const total = MIN_EDITS_FOR_NUDGE + 4;
		const revisits = Math.ceil(total * (REWORK_RATIO_FLOOR + 0.1));
		const nudge = formatSessionReworkNudge(summaryOf(revisits, total));
		expect(nudge).toContain("[interlinked:session-rework]");
		expect(nudge).toContain("a.ts");
		expect(nudge).toContain(`${revisits}/${total}`);
	});
});
