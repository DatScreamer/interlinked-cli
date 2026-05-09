// Tests for `interlinked ci-status`. The fetcher is injected so the gh
// subprocess is stubbed out.

import { describe, expect, it } from "vitest";
import {
	aggregateRuns,
	ciStatusCommand,
	type CiRun,
	type CiStatusFetcher,
} from "./ci-status.js";

function run(partial: Partial<CiRun> & { conclusion: string | null }): CiRun {
	return {
		databaseId: 1,
		workflowName: "CI",
		status: "completed",
		name: "commit",
		createdAt: "2026-05-01T00:00:00Z",
		...partial,
	};
}

class StubFetcher implements CiStatusFetcher {
	constructor(private readonly runs: CiRun[], private readonly _available = true) {}
	available(): boolean {
		return this._available;
	}
	listRuns(): CiRun[] {
		return this.runs;
	}
}

describe("aggregateRuns", () => {
	it("returns an empty aggregation when there are no runs", () => {
		const agg = aggregateRuns([]);
		expect(agg.total).toBe(0);
		expect(agg.completed).toBe(0);
		expect(agg.failures).toBe(0);
		expect(agg.byWorkflow).toEqual([]);
		expect(agg.recentFailures).toEqual([]);
	});

	it("groups completed runs by workflow and counts failures", () => {
		const agg = aggregateRuns([
			run({ workflowName: "CI", conclusion: "success" }),
			run({ workflowName: "CI", conclusion: "failure" }),
			run({ workflowName: "CI", conclusion: "failure" }),
			run({ workflowName: "Release", conclusion: "success" }),
		]);
		expect(agg.completed).toBe(4);
		expect(agg.failures).toBe(2);
		const ci = agg.byWorkflow.find((w) => w.workflowName === "CI");
		expect(ci?.total).toBe(3);
		expect(ci?.failures).toBe(2);
		expect(ci?.failureRate).toBeCloseTo(2 / 3);
		const release = agg.byWorkflow.find((w) => w.workflowName === "Release");
		expect(release?.total).toBe(1);
		expect(release?.failures).toBe(0);
	});

	it("sorts workflows by failure rate (highest first), failures as tiebreak", () => {
		const agg = aggregateRuns([
			run({ workflowName: "ok", conclusion: "success" }),
			run({ workflowName: "ok", conclusion: "success" }),
			run({ workflowName: "half", conclusion: "failure" }),
			run({ workflowName: "half", conclusion: "success" }),
			run({ workflowName: "all-bad", conclusion: "failure" }),
		]);
		expect(agg.byWorkflow.map((w) => w.workflowName)).toEqual(["all-bad", "half", "ok"]);
	});

	it("treats cancelled / timed_out as failures", () => {
		const agg = aggregateRuns([
			run({ workflowName: "CI", conclusion: "cancelled" }),
			run({ workflowName: "CI", conclusion: "timed_out" }),
			run({ workflowName: "CI", conclusion: "success" }),
		]);
		expect(agg.failures).toBe(2);
	});

	it("ignores in-progress runs from completed/failure counts", () => {
		const agg = aggregateRuns([
			run({ workflowName: "CI", status: "in_progress", conclusion: null }),
			run({ workflowName: "CI", status: "queued", conclusion: null }),
			run({ workflowName: "CI", conclusion: "success" }),
		]);
		expect(agg.total).toBe(3);
		expect(agg.completed).toBe(1);
		expect(agg.failures).toBe(0);
	});

	it("returns up to 5 most-recent failures", () => {
		const runs: CiRun[] = [];
		for (let i = 0; i < 10; i++) {
			runs.push(
				run({
					workflowName: "CI",
					conclusion: "failure",
					createdAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
					name: `commit-${i}`,
				}),
			);
		}
		const agg = aggregateRuns(runs);
		expect(agg.recentFailures).toHaveLength(5);
		// Most recent first
		expect(agg.recentFailures[0].name).toBe("commit-9");
		expect(agg.recentFailures[4].name).toBe("commit-5");
	});
});

describe("ciStatusCommand", () => {
	it("emits an error when gh is not installed", async () => {
		const captured: unknown[] = [];
		const orig = console.log;
		console.log = (msg: unknown) => captured.push(msg);
		try {
			await ciStatusCommand({}, new StubFetcher([], false));
			expect(captured.length).toBeGreaterThan(0);
			expect(String(captured.join(""))).toContain("gh");
			expect(process.exitCode).toBe(1);
		} finally {
			console.log = orig;
			process.exitCode = 0;
		}
	});

	it("renders aggregation in normal mode", async () => {
		const captured: string[] = [];
		const orig = console.log;
		console.log = (msg: unknown) => captured.push(String(msg));
		try {
			const fetcher = new StubFetcher([
				run({ workflowName: "CI", conclusion: "failure", name: "broken" }),
				run({ workflowName: "CI", conclusion: "failure", name: "still broken" }),
				run({ workflowName: "CI", conclusion: "success", name: "fixed" }),
			]);
			await ciStatusCommand({}, fetcher);
			const out = captured.join("\n");
			expect(out).toContain("CI");
			expect(out).toContain("2/3");
		} finally {
			console.log = orig;
		}
	});

	it("emits JSON aggregation when --json", async () => {
		const captured: string[] = [];
		const orig = console.log;
		console.log = (msg: unknown) => captured.push(String(msg));
		try {
			const fetcher = new StubFetcher([
				run({ workflowName: "CI", conclusion: "failure" }),
			]);
			await ciStatusCommand({ json: true }, fetcher);
			const parsed = JSON.parse(captured.join("\n"));
			expect(parsed.failures).toBe(1);
			expect(parsed.byWorkflow[0].workflowName).toBe("CI");
		} finally {
			console.log = orig;
		}
	});

	it("clamps --limit to [1, 100]", async () => {
		// Just verify it doesn't throw on extreme inputs.
		const fetcher = new StubFetcher([]);
		await expect(ciStatusCommand({ limit: 9999 }, fetcher)).resolves.toBeUndefined();
		await expect(ciStatusCommand({ limit: -5 }, fetcher)).resolves.toBeUndefined();
	});
});
