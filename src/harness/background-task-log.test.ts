import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backgroundTaskLogPath,
	type BackgroundTaskRecord,
	lastStatuses,
	parseBackgroundTasks,
	recordBackgroundTasks,
} from "./background-task-log.js";

const TS = "2026-08-08T02:00:00.000Z";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bg-task-log-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function rows(): BackgroundTaskRecord[] {
	return readFileSync(backgroundTaskLogPath(dir), "utf-8")
		.split("\n")
		.filter(Boolean)
		// SAFETY: written by recordBackgroundTasks in this test; shape is ours.
		.map((line) => JSON.parse(line) as BackgroundTaskRecord);
}

function record(tasks: unknown, ts = TS): number {
	return recordBackgroundTasks({
		tasks: parseBackgroundTasks(tasks),
		sessionId: "s1",
		hookEvent: "SubagentStop",
		ts,
		cwd: dir,
	});
}

describe("parseBackgroundTasks — positive (must parse)", () => {
	it("P1: parses the roster shape the runner sends", () => {
		expect(
			parseBackgroundTasks([
				{ id: "b1", type: "agent", status: "running", description: "audit", agent_type: "general-purpose" },
			]),
		).toEqual([
			{ id: "b1", type: "agent", status: "running", description: "audit", agent_type: "general-purpose" },
		]);
	});

	it("P2: fills absent optional fields with null rather than dropping the task", () => {
		expect(parseBackgroundTasks([{ id: "b2" }])).toEqual([
			{ id: "b2", type: null, status: null, description: null, agent_type: null },
		]);
	});
});

describe("parseBackgroundTasks — negative (must not fabricate)", () => {
	it("N1: a non-array payload parses to nothing", () => {
		expect(parseBackgroundTasks(undefined)).toEqual([]);
		expect(parseBackgroundTasks({ id: "b1" })).toEqual([]);
		expect(parseBackgroundTasks("running")).toEqual([]);
	});

	it("N2: entries without an id are skipped — they cannot be state-tracked", () => {
		expect(parseBackgroundTasks([{ status: "running" }, null, 7])).toEqual([]);
	});
});

describe("recordBackgroundTasks", () => {
	it("P3: writes a row on first sight of a task", () => {
		expect(record([{ id: "b1", status: "running", type: "agent" }])).toBe(1);
		expect(rows()[0]).toMatchObject({
			schema: "background-task.v1",
			id: "b1",
			status: "running",
			session_id: "s1",
			hook_event: "SubagentStop",
		});
	});

	it("P4: writes a second row when the status changes", () => {
		record([{ id: "b1", status: "running" }]);
		expect(record([{ id: "b1", status: "completed" }])).toBe(1);
		expect(rows().map((r) => r.status)).toEqual(["running", "completed"]);
	});

	it("N3: re-observing the same status appends nothing", () => {
		record([{ id: "b1", status: "running" }]);
		expect(record([{ id: "b1", status: "running" }])).toBe(0);
		expect(rows()).toHaveLength(1);
	});

	it("N4: an empty roster writes no file", () => {
		expect(record([])).toBe(0);
		expect(() => readFileSync(backgroundTaskLogPath(dir), "utf-8")).toThrow();
	});

	it("N5: a dry-run event never mutates the log", () => {
		const written = recordBackgroundTasks({
			tasks: parseBackgroundTasks([{ id: "b1", status: "running" }]),
			sessionId: "s1",
			hookEvent: "SubagentStop",
			ts: TS,
			cwd: dir,
			dryRun: true,
		});
		expect(written).toBe(0);
		expect(() => readFileSync(backgroundTaskLogPath(dir), "utf-8")).toThrow();
	});

	it("N6: a missing log reads as no known statuses", () => {
		expect(lastStatuses(dir).size).toBe(0);
	});
});
