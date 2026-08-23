import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	aggregateRecurrences,
	loadRecurrenceEvents,
	proposeAction,
	recordRecurrenceEvent,
	type Recurrence,
	type RecurrenceEvent,
} from "./recurrence.js";

function baseRow(overrides: Partial<Recurrence>): Recurrence {
	return {
		kind: "harness_caught",
		signature: "sig",
		check_id: undefined,
		count: 1,
		first_seen: "2024-01-01T00:00:00.000Z",
		last_seen: "2024-01-01T00:00:00.000Z",
		distinct_sessions: 1,
		distinct_files: 1,
		agent_sources: [],
		sample_files: [],
		assembly_significance: 0,
		...overrides,
	};
}

const dirs: string[] = [];
function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "recurrence-mutkill-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("aggregateRecurrences — event.file / event.session_id ternary guards", () => {
	// kills 86e5011903f50d57 and fb42ed4cd822dd97
	it("does not count a file or session when event.file/session_id are absent", () => {
		const events: RecurrenceEvent[] = [
			{ ts: "2024-01-01T00:00:00.000Z", kind: "harness_caught" },
		];
		const [row] = aggregateRecurrences(events);
		expect(row).toBeDefined();
		expect(row?.distinct_files).toBe(0);
		expect(row?.distinct_sessions).toBe(0);
	});

	it("does count a file and session when present", () => {
		const events: RecurrenceEvent[] = [
			{
				ts: "2024-01-01T00:00:00.000Z",
				kind: "harness_caught",
				file: "a.ts",
				session_id: "s1",
			},
		];
		const [row] = aggregateRecurrences(events);
		expect(row?.distinct_files).toBe(1);
		expect(row?.distinct_sessions).toBe(1);
	});
});

describe("aggregateRecurrences — trackFile empty-block mutant", () => {
	// kills 664ea0c69a40627c (BlockStatement of trackFile's first-encounter branch)
	it("records the very first file encountered for a signature", () => {
		const events: RecurrenceEvent[] = [
			{ ts: "2024-01-01T00:00:00.000Z", kind: "harness_caught", file: "only.ts" },
		];
		const [row] = aggregateRecurrences(events);
		expect(row?.distinct_files).toBe(1);
		expect(row?.sample_files).toEqual(["only.ts"]);
	});
});

describe("aggregateRecurrences — matchesFilters", () => {
	// kills 5753bfb138ac2afc
	it("excludes events whose check_id does not match the filter", () => {
		const events: RecurrenceEvent[] = [
			{ ts: "2024-01-01T00:00:00.000Z", kind: "harness_caught", check_id: "other" },
		];
		const rows = aggregateRecurrences(events, { check_id: "wanted" });
		expect(rows).toHaveLength(0);
	});

	it("includes events whose check_id matches the filter", () => {
		const events: RecurrenceEvent[] = [
			{ ts: "2024-01-01T00:00:00.000Z", kind: "harness_caught", check_id: "wanted" },
		];
		const rows = aggregateRecurrences(events, { check_id: "wanted" });
		expect(rows).toHaveLength(1);
	});

	// kills 9d11a958fe48ca67 (Number.isFinite(sinceMs) guard)
	it("does not exclude an event with a malformed ts when `since` itself is malformed", () => {
		const events: RecurrenceEvent[] = [
			{ ts: "not-a-real-date", kind: "harness_caught", file: "x.ts" },
		];
		const rows = aggregateRecurrences(events, { since: "also-not-a-real-date" });
		expect(rows).toHaveLength(1);
	});
});

describe("proposeAction — harness_missed headline", () => {
	// kills bac5505e4386df10 (regex anchor removal): the prefix must be at the
	// START of the signature to be stripped.
	it("leaves the signature untouched when harness_missed: is not a leading prefix", () => {
		const row = baseRow({ kind: "harness_missed", signature: "xharness_missed:foo" });
		const action = proposeAction(row);
		expect(action.headline).toBe("Scaffold a new rule for xharness_missed:foo");
	});

	// kills a7f19c794ad0c450 (StringLiteral "" -> "Stryker was here!")
	it("strips a leading harness_missed: prefix down to the bare remainder", () => {
		const row = baseRow({ kind: "harness_missed", signature: "harness_missed:foo" });
		const action = proposeAction(row);
		expect(action.headline).toBe("Scaffold a new rule for foo");
	});
});

describe("recordRecurrenceEvent — file encoding", () => {
	// kills 879ba91eeeb7bd6e ("utf-8" -> "" invalid encoding would throw)
	it("writes a readable utf-8 JSONL line without throwing", () => {
		const dir = makeTmpDir();
		expect(() =>
			recordRecurrenceEvent(
				{ ts: "2024-01-01T00:00:00.000Z", kind: "harness_caught", message: "héllo" },
				dir,
			),
		).not.toThrow();
		const filePath = join(dir, ".interlinked", "recurrences.jsonl");
		expect(existsSync(filePath)).toBe(true);
		const content = readFileSync(filePath, "utf-8");
		expect(content).toContain('"message":"héllo"');
	});
});

describe("loadRecurrenceEvents — isRecurrenceEvent kind acceptance", () => {
	// kills 467427fc1539c2b2 and bebbb2879cd08bfa (codebase_existing kind check)
	it("accepts a well-formed codebase_existing event", () => {
		const dir = makeTmpDir();
		recordRecurrenceEvent(
			{ ts: "2024-01-01T00:00:00.000Z", kind: "codebase_existing", file: "a.ts" },
			dir,
		);
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("codebase_existing");
	});
});
