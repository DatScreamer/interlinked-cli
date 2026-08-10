import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	censusPath,
	describeShape,
	loadCensus,
	MAX_SHAPE_MEMBERS,
	mergeObservation,
	type PayloadKeyCensus,
	recordPayloadKeys,
	unconsumedKeys,
} from "./payload-key-census.js";

const NOW = "2026-08-07T22:00:00.000Z";
const LATER = "2026-08-08T09:00:00.000Z";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "payload-census-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function read(): PayloadKeyCensus {
	// SAFETY: written by recordPayloadKeys in this test; shape is ours.
	return JSON.parse(readFileSync(censusPath(dir), "utf-8")) as PayloadKeyCensus;
}

describe("unconsumedKeys — positive (must report)", () => {
	it("P1: reports a field the pipeline does not read", () => {
		expect(unconsumedKeys({ session_id: "s", brand_new_field: 1 })).toEqual(["brand_new_field"]);
	});

	it("P2: sorts the reported keys for a stable census", () => {
		expect(unconsumedKeys({ zeta: 1, alpha: 2 })).toEqual(["alpha", "zeta"]);
	});
});

describe("unconsumedKeys — negative (must not report)", () => {
	it("N1: a fully-consumed payload reports nothing", () => {
		expect(unconsumedKeys({ session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: {} })).toEqual([]);
	});

	it("N2: subagent lifecycle fields are recognized as consumed", () => {
		expect(
			unconsumedKeys({ agent_id: "a1", agent_type: "general-purpose", agent_transcript_path: "/t" }),
		).toEqual([]);
	});
});

describe("recordPayloadKeys", () => {
	it("P3: writes an entry keyed by runner + native event", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "SubagentStop",
			raw: { session_id: "s", mystery_usage: { output: 1 } },
			cwd: dir,
			now: NOW,
		});
		expect(read().entries["claude-code/SubagentStop"]).toEqual({
			unconsumed: ["mystery_usage"],
			shapes: { mystery_usage: "object{output}" },
			first_seen: NOW,
			last_seen: NOW,
		});
	});

	it("P4: merges a newly-seen key and moves last_seen, keeping first_seen", () => {
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: { a_new: 1 }, cwd: dir, now: NOW });
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "Stop",
			raw: { a_new: 1, b_newer: 2 },
			cwd: dir,
			now: LATER,
		});
		expect(read().entries["claude-code/Stop"]).toEqual({
			unconsumed: ["a_new", "b_newer"],
			shapes: { a_new: "number", b_newer: "number" },
			first_seen: NOW,
			last_seen: LATER,
		});
	});

	it("N3: a payload with nothing unconsumed writes no file at all", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "PreToolUse",
			raw: { session_id: "s", tool_name: "Bash" },
			cwd: dir,
			now: NOW,
		});
		expect(() => readFileSync(censusPath(dir), "utf-8")).toThrow();
	});

	it("N4: a non-object payload is ignored", () => {
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: "nope", cwd: dir, now: NOW });
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: [1, 2], cwd: dir, now: NOW });
		expect(() => readFileSync(censusPath(dir), "utf-8")).toThrow();
	});

	it("N5: a corrupt census is replaced rather than thrown on", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(censusPath(dir), "{not json");
		recordPayloadKeys({ runner: "claude-code", nativeEvent: "Stop", raw: { odd: 1 }, cwd: dir, now: NOW });
		expect(read().entries["claude-code/Stop"]?.unconsumed).toEqual(["odd"]);
	});
});

describe("describeShape — positive (must describe type + member names)", () => {
	it("P6: describes an array of objects by its first element's members", () => {
		expect(describeShape([{ id: "t1", status: "running" }])).toBe("array<object{id,status}>");
	});

	it("P7: describes primitives by type and an empty array distinctly", () => {
		expect(describeShape("high")).toBe("string");
		expect(describeShape(7)).toBe("number");
		expect(describeShape([])).toBe("array<empty>");
		expect(describeShape(null)).toBe("null");
	});

	it("P8: records the shape alongside the key in the census", () => {
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "Stop",
			raw: { future_roster: [{ id: "b1", status: "running" }] },
			cwd: dir,
			now: NOW,
		});
		expect(read().entries["claude-code/Stop"]?.shapes).toEqual({
			future_roster: "array<object{id,status}>",
		});
	});
});

describe("describeShape — negative (must not leak values)", () => {
	it("N7: object member VALUES never appear in the shape", () => {
		const shape = describeShape({ token: "sk-live-SECRET", nested: { pw: "hunter2" } });
		expect(shape).not.toContain("SECRET");
		expect(shape).not.toContain("hunter2");
		expect(shape).toBe("object{token,nested}");
	});

	it("N8: a wide object is capped rather than fully enumerated", () => {
		const wide: Record<string, number> = {};
		for (let i = 0; i < MAX_SHAPE_MEMBERS + 5; i++) wide[`k${i}`] = i;
		expect(describeShape(wide).endsWith(",…}")).toBe(true);
	});
});

describe("mergeObservation / loadCensus", () => {
	it("P5: re-seeing the same keys reports no change", () => {
		const first = mergeObservation(loadCensus(dir), { key: "r/E", keys: ["x"], now: NOW });
		expect(first.changed).toBe(true);
		const second = mergeObservation(first.census, { key: "r/E", keys: ["x"], now: LATER });
		expect(second.changed).toBe(false);
	});

	it("P10: a since-wired key is pruned from the FILE on the next observation", () => {
		// Seed a stale entry naming a key that is now consumed, as a census
		// written before the field was wired up would look.
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"claude-code/PreToolUse": {
						unconsumed: ["background_tasks", "still_unknown"],
						shapes: { background_tasks: "array<empty>", still_unknown: "string" },
						first_seen: NOW,
						last_seen: NOW,
					},
				},
			}),
		);
		// A payload with nothing NEW to report must still reach the merge —
		// otherwise a solved problem stays on the report forever.
		recordPayloadKeys({
			runner: "claude-code",
			nativeEvent: "PreToolUse",
			raw: { session_id: "s", tool_name: "Bash" },
			cwd: dir,
			now: LATER,
		});
		expect(read().entries["claude-code/PreToolUse"]?.unconsumed).toEqual(["still_unknown"]);
	});

	it("P9: prunes a key that has since been wired into the pipeline", () => {
		const stale = mergeObservation(loadCensus(dir), {
			key: "claude-code/Stop",
			keys: ["still_unknown", "background_tasks"],
			shapes: { still_unknown: "string", background_tasks: "array<empty>" },
			now: NOW,
		}).census;
		// `background_tasks` is in CONSUMED_PAYLOAD_KEYS, so the next observation
		// must drop it from both the key list and the shape map.
		const next = mergeObservation(stale, {
			key: "claude-code/Stop",
			keys: ["still_unknown"],
			shapes: { still_unknown: "string" },
			now: LATER,
		});
		expect(next.changed).toBe(true);
		expect(next.census.entries["claude-code/Stop"]?.unconsumed).toEqual(["still_unknown"]);
		expect(next.census.entries["claude-code/Stop"]?.shapes).toEqual({ still_unknown: "string" });
	});

	it("N6: a missing census file loads as empty", () => {
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
	});

	it("N9: drops a malformed individual entry but keeps valid ones", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"good/Event": { unconsumed: ["x"], first_seen: NOW, last_seen: NOW },
					"bad/Event": { unconsumed: "not-an-array", first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		const census = loadCensus(dir);
		expect(Object.keys(census.entries)).toEqual(["good/Event"]);
	});

	it("N10: treats a non-object entries field as empty instead of trusting it", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({ schema: "payload-keys.v1", entries: ["not", "a", "record"] }),
		);
		expect(loadCensus(dir)).toEqual({ schema: "payload-keys.v1", entries: {} });
	});

	it("P11: a malformed entry no longer crashes a follow-up merge", () => {
		// Pre-fix, `existing.unconsumed.filter(...)` inside mergeObservation threw
		// on a corrupted (non-array) `unconsumed` field, since loadCensus trusted
		// the whole entries map unchecked. Post-fix the malformed entry is
		// dropped at load time, so the follow-up observation is treated as a
		// brand-new entry instead of crashing.
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			censusPath(dir),
			JSON.stringify({
				schema: "payload-keys.v1",
				entries: {
					"claude-code/Stop": { unconsumed: "not-an-array", first_seen: NOW, last_seen: NOW },
				},
			}),
		);
		expect(() =>
			recordPayloadKeys({
				runner: "claude-code",
				nativeEvent: "Stop",
				raw: { odd: 1 },
				cwd: dir,
				now: LATER,
			}),
		).not.toThrow();
		expect(read().entries["claude-code/Stop"]?.unconsumed).toEqual(["odd"]);
	});
});
