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
});
