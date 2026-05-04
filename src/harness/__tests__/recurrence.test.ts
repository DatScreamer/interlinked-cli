// Tests for the recurrence aggregation primitive.
//
// Pure-function tests for deriveSignature / aggregateRecurrences /
// parseDurationMs / resolveSinceCutoff / proposeAction; tmpdir-backed
// tests for the JSONL append/read round-trip.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aggregateRecurrences,
	deriveSignature,
	loadRecurrenceEvents,
	parseDurationMs,
	proposeAction,
	type Recurrence,
	recordHarnessCaught,
	recordHarnessMissed,
	recordRecurrenceEvent,
	type RecurrenceEvent,
	recurrencesPath,
	resolveSinceCutoff,
} from "../recurrence.js";

function ev(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
	return {
		ts: "2026-05-01T00:00:00.000Z",
		kind: "harness_caught",
		check_id: "misused_promises",
		agent_source: "claude",
		session_id: "s1",
		file: "src/foo.ts",
		message: "x",
		...overrides,
	};
}

describe("deriveSignature", () => {
	it("groups harness_caught by check_id + agent_source", () => {
		expect(deriveSignature(ev({ check_id: "x", agent_source: "claude" }))).toBe(
			"harness_caught:x:claude",
		);
		expect(deriveSignature(ev({ check_id: "x", agent_source: "codex" }))).toBe(
			"harness_caught:x:codex",
		);
	});

	it("groups codebase_existing by check_id only (file-agnostic)", () => {
		const a = deriveSignature(ev({ kind: "codebase_existing", check_id: "y", file: "a.ts" }));
		const b = deriveSignature(ev({ kind: "codebase_existing", check_id: "y", file: "b.ts" }));
		expect(a).toBe(b);
		expect(a).toBe("codebase_existing:y");
	});

	it("groups harness_missed by user signature, not by file", () => {
		const a = deriveSignature(ev({ kind: "harness_missed", signature: "raw-sql-concat", file: "a.ts" }));
		const b = deriveSignature(ev({ kind: "harness_missed", signature: "raw-sql-concat", file: "b.ts" }));
		expect(a).toBe(b);
		expect(a).toBe("harness_missed:raw-sql-concat");
	});

	it("falls back to message then 'untagged' for harness_missed without signature", () => {
		expect(deriveSignature(ev({ kind: "harness_missed", signature: undefined, message: "fallback" }))).toBe(
			"harness_missed:fallback",
		);
		expect(
			deriveSignature(ev({ kind: "harness_missed", signature: undefined, message: undefined })),
		).toBe("harness_missed:untagged");
	});
});

describe("aggregateRecurrences", () => {
	it("counts events per signature, ranks by count descending", () => {
		const rows = aggregateRecurrences([
			ev({ check_id: "a", session_id: "s1", file: "f1.ts" }),
			ev({ check_id: "a", session_id: "s2", file: "f2.ts" }),
			ev({ check_id: "b", session_id: "s1", file: "f3.ts" }),
			ev({ check_id: "a", session_id: "s2", file: "f1.ts" }),
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0].check_id).toBe("a");
		expect(rows[0].count).toBe(3);
		expect(rows[0].distinct_sessions).toBe(2);
		expect(rows[0].distinct_files).toBe(2);
		expect(rows[1].check_id).toBe("b");
		expect(rows[1].count).toBe(1);
	});

	it("derives first_seen / last_seen from the event timestamps", () => {
		const rows = aggregateRecurrences([
			ev({ ts: "2026-05-01T00:00:00.000Z" }),
			ev({ ts: "2026-05-03T00:00:00.000Z" }),
			ev({ ts: "2026-05-02T00:00:00.000Z" }),
		]);
		expect(rows[0].first_seen).toBe("2026-05-01T00:00:00.000Z");
		expect(rows[0].last_seen).toBe("2026-05-03T00:00:00.000Z");
	});

	it("collects sample_files most-recent-first, deduplicated", () => {
		const rows = aggregateRecurrences([
			ev({ ts: "2026-05-01T00:00:00.000Z", file: "old.ts" }),
			ev({ ts: "2026-05-02T00:00:00.000Z", file: "mid.ts" }),
			ev({ ts: "2026-05-03T00:00:00.000Z", file: "mid.ts" }), // dup
			ev({ ts: "2026-05-04T00:00:00.000Z", file: "new.ts" }),
		]);
		expect(rows[0].sample_files).toEqual(["new.ts", "mid.ts", "old.ts"]);
	});

	it("collects agent_sources sorted and unique", () => {
		const rows = aggregateRecurrences([
			ev({ agent_source: "claude" }),
			ev({ agent_source: "codex" }),
			ev({ agent_source: "claude" }),
		]);
		// Different agent_sources produce different signatures, so two rows; check both.
		const allSources = rows.flatMap((r: Recurrence) => r.agent_sources);
		expect(allSources).toContain("claude");
		expect(allSources).toContain("codex");
	});

	it("filters by kind, since, agent_source, check_id", () => {
		const events: RecurrenceEvent[] = [
			ev({ ts: "2026-04-01T00:00:00.000Z", kind: "harness_caught", check_id: "a", agent_source: "claude" }),
			ev({ ts: "2026-05-01T00:00:00.000Z", kind: "harness_caught", check_id: "a", agent_source: "codex" }),
			ev({ ts: "2026-05-01T00:00:00.000Z", kind: "codebase_existing", check_id: "a" }),
		];
		expect(aggregateRecurrences(events, { kind: "codebase_existing" })).toHaveLength(1);
		expect(aggregateRecurrences(events, { since: "2026-04-15T00:00:00.000Z" }).reduce((n: number, r: Recurrence) => n + r.count, 0)).toBe(2);
		expect(aggregateRecurrences(events, { agent_source: "codex" })).toHaveLength(1);
		expect(aggregateRecurrences(events, { check_id: "a" }).reduce((n: number, r: Recurrence) => n + r.count, 0)).toBe(3);
	});

	it("returns an empty list for an empty input", () => {
		expect(aggregateRecurrences([])).toEqual([]);
	});
});

describe("parseDurationMs", () => {
	it("parses suffixed durations s/m/h/d/w", () => {
		expect(parseDurationMs("90s")).toBe(90 * 1000);
		expect(parseDurationMs("30m")).toBe(30 * 60 * 1000);
		expect(parseDurationMs("12h")).toBe(12 * 60 * 60 * 1000);
		expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
		expect(parseDurationMs("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
	});
	it("tolerates whitespace and case", () => {
		expect(parseDurationMs("  7D  ")).toBe(7 * 24 * 60 * 60 * 1000);
	});
	it("returns null on malformed input", () => {
		expect(parseDurationMs("seven days")).toBeNull();
		expect(parseDurationMs("7y")).toBeNull();
		expect(parseDurationMs("")).toBeNull();
	});
});

describe("resolveSinceCutoff", () => {
	const NOW = new Date("2026-05-04T12:00:00.000Z");
	it("resolves a relative duration to an absolute past timestamp", () => {
		expect(resolveSinceCutoff("1d", NOW)).toBe("2026-05-03T12:00:00.000Z");
	});
	it("accepts an absolute ISO timestamp as-is (normalized)", () => {
		expect(resolveSinceCutoff("2026-04-01T00:00:00Z", NOW)).toBe("2026-04-01T00:00:00.000Z");
	});
	it("returns null for unparseable input or empty", () => {
		expect(resolveSinceCutoff(undefined, NOW)).toBeNull();
		expect(resolveSinceCutoff("garbage", NOW)).toBeNull();
	});
});

describe("proposeAction", () => {
	const baseRow = (overrides: Partial<Recurrence>): Recurrence => ({
		kind: "harness_caught",
		signature: "harness_caught:foo:claude",
		check_id: "foo",
		count: 5,
		first_seen: "2026-05-01T00:00:00.000Z",
		last_seen: "2026-05-03T00:00:00.000Z",
		distinct_sessions: 3,
		distinct_files: 2,
		agent_sources: ["claude"],
		sample_files: ["a.ts", "b.ts"],
		...overrides,
	});

	it("harness_caught → ratchet", () => {
		const a = proposeAction(baseRow({}));
		expect(a.kind).toBe("ratchet");
		expect(a.headline).toContain("foo");
		expect(a.detail).toContain("guard-rules.local.json");
	});

	it("harness_missed → scaffold_rule", () => {
		const a = proposeAction(
			baseRow({
				kind: "harness_missed",
				signature: "harness_missed:raw-sql-concat",
				check_id: undefined,
			}),
		);
		expect(a.kind).toBe("scaffold_rule");
		expect(a.headline).toContain("raw-sql-concat");
	});

	it("codebase_existing → cleanup_pr", () => {
		const a = proposeAction(
			baseRow({
				kind: "codebase_existing",
				signature: "codebase_existing:foo",
				check_id: "foo",
				distinct_files: 12,
				sample_files: ["a.ts", "b.ts", "c.ts"],
			}),
		);
		expect(a.kind).toBe("cleanup_pr");
		expect(a.headline).toContain("12");
		expect(a.detail).toContain("a.ts");
	});
});

describe("recurrencesPath / recordRecurrenceEvent / loadRecurrenceEvents", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-recurrence-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("recurrencesPath resolves under .interlinked/recurrences.jsonl in the given cwd", () => {
		expect(recurrencesPath(dir)).toBe(join(dir, ".interlinked", "recurrences.jsonl"));
	});

	it("returns an empty array when the file does not exist", () => {
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("appends + reads back round-trip preserves event order", () => {
		recordRecurrenceEvent(ev({ ts: "2026-05-01T00:00:00.000Z" }), dir);
		recordRecurrenceEvent(ev({ ts: "2026-05-02T00:00:00.000Z" }), dir);
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(2);
		expect(out[0].ts).toBe("2026-05-01T00:00:00.000Z");
		expect(out[1].ts).toBe("2026-05-02T00:00:00.000Z");
	});

	it("recordHarnessMissed records a harness_missed event with the supplied signature", () => {
		recordHarnessMissed({
			signature: "raw-sql-concat",
			file: "src/db.ts",
			message: "string-templated SQL",
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("harness_missed");
		expect(events[0].signature).toBe("raw-sql-concat");
		expect(events[0].file).toBe("src/db.ts");
	});

	it("recordHarnessCaught wraps recordRecurrenceEvent with kind=harness_caught + a fresh ts", () => {
		recordHarnessCaught({
			check_id: "misused_promises",
			agent_source: "claude",
			session_id: "s1",
			file: "src/foo.ts",
			message: "x",
			cwd: dir,
		});
		const events = loadRecurrenceEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("harness_caught");
		expect(events[0].check_id).toBe("misused_promises");
		expect(events[0].agent_source).toBe("claude");
		expect(events[0].session_id).toBe("s1");
		expect(events[0].file).toBe("src/foo.ts");
		expect(events[0].message).toBe("x");
		// ts auto-populated as ISO 8601
		expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("skips torn / malformed lines without throwing", () => {
		const path = join(dir, ".interlinked", "recurrences.jsonl");
		recordRecurrenceEvent(ev(), dir); // ensures dir exists
		writeFileSync(
			path,
			[
				JSON.stringify(ev({ ts: "2026-05-01T00:00:00.000Z" })),
				"{not valid json",
				"",
				JSON.stringify(ev({ ts: "2026-05-02T00:00:00.000Z" })),
			].join("\n"),
		);
		const out = loadRecurrenceEvents(dir);
		expect(out).toHaveLength(2);
		expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
	});
});
