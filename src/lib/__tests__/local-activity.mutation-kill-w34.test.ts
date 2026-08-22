// Mutation-kill companion for src/lib/local-activity.ts (wave 34, pass1_w34).
//
// Targets 22 of the 36 mutants recorded as "survived" for local-activity.ts in
// .interlinked/mutation-manifest.json. The remaining 14 are left still_open in
// the receipts — hand-traced and suspected equivalent, almost always because
// the mutated condition is only observably different at a boundary value
// (e.g. limit === 0) that an earlier `&&` short-circuit or an enclosing
// try/catch already renders unreachable/masked. No killing test was written
// for those, per the write-only contract.
//
// `mkdirSync` is wrapped as a call-through spy so the appendActivityRecordOnly
// mutants can be killed by call-count, not just return value — plain
// `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in ESM"
// for node:fs, so this follows the same `vi.mock` + `vi.hoisted` workaround
// used in src/harness/suppressions.mutation-kill-w30.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mkdirSyncSpy } = vi.hoisted(() => {
	return { mkdirSyncSpy: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mkdirSyncSpy.mockImplementation(actual.mkdirSync);
	return {
		...actual,
		mkdirSync: mkdirSyncSpy,
	};
});

import {
	appendActivityRecordOnly,
	appendLocalActivity,
	getLocalStats,
	readLocalActivity,
	readLocalSessions,
} from "../local-activity.js";

const INTERLINKED = ".interlinked";

function writeCollection(tmp: string, records: object[]): void {
	mkdirSync(join(tmp, INTERLINKED), { recursive: true });
	writeFileSync(
		join(tmp, INTERLINKED, "collection.jsonl"),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

function writeLegacy(tmp: string, lines: object[]): void {
	mkdirSync(join(tmp, INTERLINKED), { recursive: true });
	writeFileSync(
		join(tmp, INTERLINKED, "activity.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

/** Same collection.v1 record shape used by the primary companion test file. */
function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "collection.v1",
		kind: "tool_event",
		ts: "2026-06-06T10:00:00.000Z",
		session_id: "s1",
		agent_name: "alice",
		provider: "claude-code",
		phase: "post",
		provider_tool: "Bash",
		cwd: "/repo",
		action: { command: "ls -la" },
		...over,
	};
}

beforeEach(() => {
	mkdirSyncSpy.mockClear();
});

// ---------------------------------------------------------------------------
// appendActivityRecordOnly — kills f76d84ec35338a75, ae192e9298a6bee1,
// c2901389a4b3e583
// ---------------------------------------------------------------------------
describe("appendActivityRecordOnly mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-append-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills f76d84ec35338a75 (`!existsSync(dir)` ->
	// `true`): once the dir already exists, a repeat call must not invoke
	// mkdirSync again (forcing the guard true would call it unconditionally).
	it("does not call mkdirSync again once the target directory already exists", () => {
		appendActivityRecordOnly({ ts: "t1", agent: "a", type: "x" }, tmp);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["a"]);
		mkdirSyncSpy.mockClear();
		appendActivityRecordOnly({ ts: "t2", agent: "b", type: "y" }, tmp);
		expect(mkdirSyncSpy).not.toHaveBeenCalled();
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["b", "a"]);
	});

	// test-contract: invariant — kills ae192e9298a6bee1 (`{recursive:true}`->
	// `{}`) and c2901389a4b3e583 (`true`->`false`): a 2-level-missing cwd
	// only succeeds if mkdirSync actually runs with `recursive: true`.
	it("creates multi-level-missing parent directories (recursive mkdir required)", () => {
		const deepCwd = join(tmp, "a", "b");
		expect(() =>
			appendActivityRecordOnly({ ts: "t1", agent: "deep", type: "x" }, deepCwd),
		).not.toThrow();
		const events = readLocalActivity({ cwd: deepCwd });
		expect(events.map((e) => e.agent)).toEqual(["deep"]);
	});
});

// ---------------------------------------------------------------------------
// readActivityStream (legacy path, no collection.jsonl) — kills
// e697c63d2098e2fe, 14bc7a8905d9d8a0, 118bd69a25d9f255
// ---------------------------------------------------------------------------
describe("readActivityStream mutants (legacy activity.jsonl)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-stream-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills e697c63d2098e2fe (`opts.limit > 0` ->
	// `true`): a negative limit must resolve to "no limit" (the `&& > 0`
	// guard is false for -1). Forcing it true sets limit=-1, and the loop's
	// `events.length >= limit` (0 >= -1) breaks after the first event.
	it("treats a negative limit as no-limit (returns every event, not just the first)", () => {
		writeLegacy(tmp, [
			{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x" },
			{ ts: "2026-04-22T10:00:01Z", agent: "b", type: "x" },
			{ ts: "2026-04-22T10:00:02Z", agent: "c", type: "x" },
		]);
		const events = readLocalActivity({ cwd: tmp, limit: -1 });
		expect(events.length).toBe(3);
	});

	// test-contract: invariant — kills 14bc7a8905d9d8a0 (`Math.max(limit*20,
	// 500)`->`Math.min(...)`) and 118bd69a25d9f255 (`limit*20`->`limit/20`):
	// both shrink the scan budget to 500 for limit=30 instead of 600, so the
	// 100 oldest "oldtarget" lines fall outside a 500-line tail scan.
	it("scans deep enough to find matches beyond a 500-line tail window", () => {
		const filler = Array.from({ length: 500 }, (_, i) => ({
			ts: `2026-04-22T11:00:${String(i % 60).padStart(2, "0")}Z`,
			agent: "filler",
			type: "x",
		}));
		const old = Array.from({ length: 100 }, (_, i) => ({
			ts: `2026-04-22T09:00:${String(i % 60).padStart(2, "0")}Z`,
			agent: "oldtarget",
			type: "x",
		}));
		// Oldest physically first, newest physically last (tail-scan order).
		writeLegacy(tmp, [...old, ...filler]);
		const events = readLocalActivity({ cwd: tmp, agent: "oldtarget", limit: 30 });
		expect(events.length).toBe(30);
	});
});

// ---------------------------------------------------------------------------
// projectedType (via toolEventIdentity dedup) — kills 0c22affba08d1a33
// ---------------------------------------------------------------------------
describe("projectedType mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-proj-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills 0c22affba08d1a33 (body -> `{}`): a
	// legacy `tool_use` and collection `tool_use_start` sharing ts/session/
	// tool must NOT dedup — a blanked projectedType collapses both types
	// to `undefined`, causing a false collision.
	it("does not dedup a legacy tool_use event against an unrelated collection tool_use_start", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:00.000Z", session_id: "s1", provider_tool: "Bash", phase: "pre" }),
		]);
		writeLegacy(tmp, [
			{ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Bash", session: "s1" },
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.map((e) => e.type).sort()).toEqual(["tool_use", "tool_use_start"]);
		expect(events.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// toolEventIdentity — kills 3af25da2b5794f15, ae4524db9f5a17c4
// ---------------------------------------------------------------------------
describe("toolEventIdentity mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-identity-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills 3af25da2b5794f15 (`""` fallback in
	// `e.tool ?? ""` -> sentinel string): a legacy event with NO tool field
	// must fall back to "" and match a collection event whose tool IS "".
	// A different fallback constant breaks that match.
	it("dedups a tool-less legacy event against a collection event with an empty-string tool", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:00.000Z", session_id: "s1", provider_tool: "", phase: "post" }),
		]);
		writeLegacy(tmp, [{ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", session: "s1" }]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
	});

	// test-contract: invariant — kills ae4524db9f5a17c4 (`e.tool ?? ""` ->
	// `e.tool && ""`): `x && ""` collapses ANY truthy tool to `""`, so two
	// events with different tools ("Bash" vs "Write") would wrongly dedup.
	it("does not dedup two events with different (both truthy) tool names", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:00.000Z", session_id: "s1", provider_tool: "Bash", phase: "post" }),
		]);
		writeLegacy(tmp, [
			{ ts: "2026-06-06T10:00:00.000Z", agent: "a", type: "tool_use", tool: "Write", session: "s1" },
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// readLocalActivity — merge / sort / limit — kills e0355fb9918f7696,
// 2d4e86a4e1318d41, c10eacc815f7ef60, 015cfe738ed46d86, e5969ba25f8f4c84,
// b8ab261ad74b8884, f3c6abfdbb15efb4, 6a0efe5d18902c6b, 457935606e1a551b
// ---------------------------------------------------------------------------
describe("readLocalActivity mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-merge-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills e0355fb9918f7696 (`id.idKey` -> `true`
	// in the legacy filter's ternary): an id-LESS legacy twin matching a
	// canonical field key must be deduped. Forcing the id-branch always
	// taken means `canonicalIds.has(null)` is always false, so it survives.
	it("dedups an id-less legacy twin via the field-key fallback", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:00.000Z", session_id: "s1", provider_tool: "Bash", phase: "post" }),
		]);
		writeLegacy(tmp, [
			{ ts: "2026-06-06T10:00:00.000Z", agent: "dup", type: "tool_use", tool: "Bash", session: "s1" },
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
	});

	// test-contract: invariant — kills 2d4e86a4e1318d41 (`!existsSync(...)`
	// -> `false`): with NO collection.jsonl, the legacy stream's own
	// (unsorted, tail-scan) order must pass through untouched. Skipping the
	// early return re-sorts by ts, differing when file order != ts order.
	it("returns raw scan order (unsorted) when collection.jsonl is absent, even with out-of-order timestamps", () => {
		// Physically first line has the LATER ts; physically last has the EARLIER ts.
		writeLegacy(tmp, [
			{ ts: "2030-06-01T00:00:00.000Z", agent: "physically-first", type: "x" },
			{ ts: "2000-01-01T00:00:00.000Z", agent: "physically-last", type: "x" },
		]);
		// Tail-scan reads physically-last line first -> [physically-last, physically-first].
		const events = readLocalActivity({ cwd: tmp });
		expect(events.map((e) => e.agent)).toEqual(["physically-last", "physically-first"]);
	});

	// test-contract: invariant — kills c10eacc815f7ef60 (`merged.sort(...)`
	// -> `merged`) and 015cfe738ed46d86 (comparator -> `() => undefined`,
	// a stable no-op): once collection.jsonl exists, merged events must be
	// sorted by ts descending, not left in concatenation order.
	it("sorts merged collection+legacy events by ts descending (collection is older)", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-01-01T00:00:05.000Z", session_id: "sX", agent_name: "coll", provider_tool: "Bash" }),
		]);
		writeLegacy(tmp, [
			{ ts: "2026-01-01T00:00:10.000Z", agent: "legacy-newer", type: "session_start" },
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.map((e) => e.agent)).toEqual(["legacy-newer", "coll"]);
	});

	// test-contract: invariant — kills 457935606e1a551b (comparator's `-`
	// -> `+`): a `+` comparator is symmetric and, for two positive epoch
	// timestamps, always positive — forcing an unconditional swap regardless
	// of actual chronological order.
	it("sorts merged events by ts descending (collection is newer, must NOT swap-always)", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-01-01T00:00:10.000Z", session_id: "sX", agent_name: "coll-newer", provider_tool: "Bash" }),
		]);
		writeLegacy(tmp, [
			{ ts: "2026-01-01T00:00:05.000Z", agent: "legacy-older", type: "session_start" },
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.map((e) => e.agent)).toEqual(["coll-newer", "legacy-older"]);
	});

	// test-contract: invariant — kills e5969ba25f8f4c84 (limit guard -> false),
	// f3c6abfdbb15efb4 (-> `<= 0`), and 6a0efe5d18902c6b (`slice` -> `merged`):
	// limit=1 with 2 surviving merged events (one per source, so the cut can
	// ONLY come from the outer slice) must end up as exactly 1.
	it("applies the outer limit across merged collection+legacy sources", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:02.000Z", session_id: "s1", provider_tool: "Bash" }),
		]);
		writeLegacy(tmp, [{ ts: "2026-06-06T10:00:00.000Z", agent: "old", type: "session_start" }]);
		const events = readLocalActivity({ cwd: tmp, limit: 1 });
		expect(events.length).toBe(1);
	});

	// test-contract: invariant — kills b8ab261ad74b8884 (outer `opts.limit
	// > 0` -> `true`): limit=-1 must resolve to no-limit (full 2-event
	// list). Forcing it true sets limit=-1, and `merged.slice(0,-1)` drops
	// the last element instead.
	it("treats a negative outer limit as no-limit (does not drop the last merged event)", () => {
		writeCollection(tmp, [
			rec({ ts: "2026-06-06T10:00:00.000Z", session_id: "s1", agent_name: "one", provider_tool: "Bash" }),
			rec({ ts: "2026-06-06T10:00:01.000Z", session_id: "s2", agent_name: "two", provider_tool: "Read", phase: "pre", action: { path: "/a" } }),
		]);
		const events = readLocalActivity({ cwd: tmp, limit: -1 });
		expect(events.length).toBe(2);
	});

});

// ---------------------------------------------------------------------------
// readLocalSessions — kills fe4d6ffa278151f3, bc884197b4c6c20a
// ---------------------------------------------------------------------------
describe("readLocalSessions mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-sessions-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills fe4d6ffa278151f3 (`!endsWith(".json")`
	// -> `false`) and bc884197b4c6c20a (`".json"` -> `""`): a non-.json file
	// with VALID JSON content must still be skipped by the extension filter
	// (invalid content would be masked by the inner malformed-file catch).
	it("skips a non-.json file even when its content happens to be valid JSON", () => {
		const dir = join(tmp, INTERLINKED, "sessions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.txt"), JSON.stringify({ session_id: "fromtxt" }));
		const sessions = readLocalSessions(tmp);
		expect(sessions.map((s) => s.session_id)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// getLocalStats — kills 4dedd04d17e55f51, 00ebd6478e77e311
// ---------------------------------------------------------------------------
describe("getLocalStats mutants", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-stats-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills 4dedd04d17e55f51 (`lines.length > 0`
	// -> `true`) and 00ebd6478e77e311 (-> `>= 0`): on a zero-byte file,
	// 0/0=NaN; the real else-branch (0) skips that division, but forcing
	// the then-branch computes `Math.round(NaN * 0)` = NaN, not 0.
	it("reports pending_sync as exactly 0 for a zero-byte activity.jsonl (never divides by zero)", () => {
		mkdirSync(join(tmp, INTERLINKED), { recursive: true });
		writeFileSync(join(tmp, INTERLINKED, "activity.jsonl"), "");
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(0);
		expect(stats.pending_sync).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Sanity: appendLocalActivity still round-trips through the mocked fs module
// (guards against the vi.mock wrapper silently breaking normal operation).
// ---------------------------------------------------------------------------
describe("sanity — mocked node:fs still behaves normally", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-w34-sanity-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — sanity check only (not mutation-directed):
	// confirms the vi.mock("node:fs") wrapper still passes real read/write
	// calls through to the actual filesystem.
	it("appendLocalActivity + readLocalActivity still round-trip", () => {
		appendLocalActivity({ ts: "2026-04-22T10:00:00.000Z", agent: "alice", type: "tool_use", tool: "Read" }, tmp);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
		expect(events[0]?.agent).toBe("alice");
	});
});
