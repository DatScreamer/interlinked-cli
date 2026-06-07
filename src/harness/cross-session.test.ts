import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearCrossSessionCache, loadRecentWorkspaceEvents } from "./cross-session.js";

describe("loadRecentWorkspaceEvents", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xsession-"));
		_clearCrossSessionCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeLog(events: ReadonlyArray<Record<string, unknown>>): void {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		const lines = events.map((e) => JSON.stringify(e));
		writeFileSync(join(sub, "activity.jsonl"), `${lines.join("\n")}\n`, "utf-8");
	}

	it("returns an empty array when no activity.jsonl is present", () => {
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
	});

	it("parses every JSONL line into a HarnessEvent", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PreToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:02Z" },
		]);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(2);
	});

	it("filters out events with timestamps below `sinceTimestamp`", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PreToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:05Z" },
		]);
		const filtered = loadRecentWorkspaceEvents(dir, "2026-05-27T00:00:03Z");
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.session_id).toBe("s2");
	});

	it("survives malformed JSONL lines (skips them silently)", () => {
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(sub, "activity.jsonl"),
			`{"hook_event":"PreToolUse","session_id":"s1","timestamp":"2026-05-27T00:00:01Z"}\nNOT VALID JSON\n{"hook_event":"PreToolUse","session_id":"s2","timestamp":"2026-05-27T00:00:02Z"}\n`,
			"utf-8",
		);
		expect(loadRecentWorkspaceEvents(dir)).toHaveLength(2);
	});

	it("caches the result and returns the same array on a second call with no file change", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		const second = loadRecentWorkspaceEvents(dir);
		// Same reference confirms cache hit (we return the cached array as-is).
		expect(first).toBe(second);
	});

	it("caps the loaded count at 500 trailing events", () => {
		const many: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			many.push({
				hook_event: "PreToolUse",
				session_id: `s${i}`,
				timestamp: `2026-05-27T00:00:${(i % 60).toString().padStart(2, "0")}Z`,
			});
		}
		writeLog(many);
		expect(loadRecentWorkspaceEvents(dir).length).toBe(500);
	});

	it("keeps only the trailing 500 (drops the OLDEST events, not the newest)", () => {
		const many: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			many.push({
				hook_event: "PreToolUse",
				session_id: `s${i}`,
				timestamp: "2026-05-27T00:00:00Z",
			});
		}
		writeLog(many);
		const got = loadRecentWorkspaceEvents(dir);
		// First retained event is s100 (600 total, last 500 kept => indices 100..599).
		expect(got[0]?.session_id).toBe("s100");
		expect(got[got.length - 1]?.session_id).toBe("s599");
	});

	it("returns [] when activity.jsonl can be stat'd but not read (EISDIR)", () => {
		// statSync succeeds on a directory and yields a numeric mtimeMs, but
		// readFileSync throws EISDIR — exercising the read-failure catch that
		// is distinct from the stat-failure (missing-file) path.
		const sub = join(dir, ".interlinked");
		mkdirSync(sub, { recursive: true });
		// Create activity.jsonl AS A DIRECTORY.
		mkdirSync(join(sub, "activity.jsonl"), { recursive: true });
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
		// And again — the read-failure path returns before populating the
		// cache, so a second call also re-reads and returns [].
		expect(loadRecentWorkspaceEvents(dir)).toEqual([]);
	});

	it("re-reads (cache miss) after the log file's mtime changes", async () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		expect(first).toHaveLength(1);

		// Rewrite the log with different content. mtimeMs must advance so the
		// cached entry is treated as stale.
		await new Promise((r) => setTimeout(r, 12));
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
			{ hook_event: "PostToolUse", session_id: "s2", timestamp: "2026-05-27T00:00:02Z" },
		]);

		const second = loadRecentWorkspaceEvents(dir);
		// New content observed => cache was invalidated, fresh parse happened.
		expect(second).not.toBe(first);
		expect(second.map((e) => e.session_id)).toEqual(["s1", "s2"]);
	});

	it("forces a fresh read after _clearCrossSessionCache (new array reference)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		const first = loadRecentWorkspaceEvents(dir);
		// Same key would normally be a cache hit returning the same reference...
		expect(loadRecentWorkspaceEvents(dir)).toBe(first);
		// ...but after clearing, the next call must re-parse into a NEW array.
		_clearCrossSessionCache();
		const afterClear = loadRecentWorkspaceEvents(dir);
		expect(afterClear).not.toBe(first);
		expect(afterClear.map((e) => e.session_id)).toEqual(["s1"]);
	});

	it("does not evict while at or below the 16-entry cache cap", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// Exactly 16 distinct (cwd, since) keys => cache fills to the cap but
		// never overflows, so the very first key stays resident.
		const refs: Array<ReturnType<typeof loadRecentWorkspaceEvents>> = [];
		for (let i = 0; i < 16; i++) {
			refs.push(loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`));
		}
		// since_0 is still cached: a re-call returns the SAME array reference.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(refs[0]);
	});

	it("evicts the oldest cache entry once the 16-entry cap is exceeded (LRU)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// 17 distinct keys => the 17th insert overflows the 16-entry cap and
		// evicts exactly one entry from the front (the oldest = since_0).
		const refs: Array<ReturnType<typeof loadRecentWorkspaceEvents>> = [];
		for (let i = 0; i < 17; i++) {
			refs.push(loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`));
		}
		// since_0 was evicted: re-calling re-parses into a NEW array reference.
		const reloaded0 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z");
		expect(reloaded0).not.toBe(refs[0]);
		// The most-recently-inserted key (since_16) is still resident: SAME ref.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:16Z")).toBe(refs[16]);
		// Content is still correct after eviction churn.
		expect(reloaded0.map((e) => e.session_id)).toEqual(["s1"]);
	});

	it("a cache HIT promotes the entry, protecting it from later eviction (LRU recency)", () => {
		writeLog([
			{ hook_event: "PreToolUse", session_id: "s1", timestamp: "2026-05-27T00:00:01Z" },
		]);
		// Fill exactly to the cap with keys since_0..since_15 and keep the
		// since_0 and since_1 references to detect later eviction by identity.
		const ref0 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z");
		const ref1 = loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:01Z");
		for (let i = 2; i < 16; i++) {
			loadRecentWorkspaceEvents(dir, `2020-01-01T00:00:${pad(i)}Z`);
		}
		// Touch since_0 -> deleted+reinserted (now most-recent). The eviction
		// front advances past it, so since_1 is now the oldest entry.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(ref0);
		// One more distinct key overflows the cap; eviction removes the OLDEST,
		// which is now since_1 (since_0 was just promoted out of harm's way).
		loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:16Z");
		// since_0 was promoted and survives: SAME reference.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:00Z")).toBe(ref0);
		// since_1 was the eviction victim: reloading yields a DIFFERENT array.
		expect(loadRecentWorkspaceEvents(dir, "2020-01-01T00:00:01Z")).not.toBe(ref1);
	});
});

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
