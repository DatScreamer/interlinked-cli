// Cross-session activity-log reader. Used by sequence detectors that need
// to look across session boundaries — e.g., `stale_read_then_write`
// (§3.4) and `file_overwrite_after_other_agent` (§3.10) check whether
// *other* agents have touched a file this workspace.
//
// Bounded I/O: only the trailing N events of `.interlinked/activity.jsonl`
// are loaded, and the result is cached per Stop turn so multiple detectors
// share the read cost.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HarnessEvent } from "./types.js";

/** Maximum number of trailing events loaded per call. Bounds both memory
 *  use and read cost — at ~1 KB per event, a 500-event tail caps at ~500 KB. */
const MAX_TRAILING_EVENTS = 500;

interface CacheEntry {
	mtime: number;
	since: string;
	events: HarnessEvent[];
}

const CACHE_MAX_ENTRIES = 16;
const cache = new Map<string, CacheEntry>();

function cacheKey(cwd: string, since: string): string {
	return `${cwd}::${since}`;
}

function pruneCache(): void {
	if (cache.size <= CACHE_MAX_ENTRIES) return;
	const toDrop = cache.size - CACHE_MAX_ENTRIES;
	let dropped = 0;
	for (const key of cache.keys()) {
		if (dropped >= toDrop) break;
		cache.delete(key);
		dropped++;
	}
}

/**
 * Load the trailing N events from `.interlinked/activity.jsonl` for the
 * given working tree, optionally filtering to events at or after a
 * given ISO timestamp.
 *
 * Best-effort: if the file doesn't exist or is malformed, returns `[]`
 * (per `[[feedback_safety_continuity]]` — fail-open on observability
 * infrastructure).
 *
 * @param cwd Project root (the dir containing `.interlinked/`)
 * @param sinceTimestamp Optional ISO timestamp; events with `timestamp <`
 *   this are filtered out
 */
export function loadRecentWorkspaceEvents(
	cwd: string,
	sinceTimestamp: string = "",
): HarnessEvent[] {
	const logPath = join(cwd, ".interlinked", "activity.jsonl");
	let mtime: number;
	try {
		mtime = statSync(logPath).mtimeMs;
	} catch {
		return [];
	}

	const key = cacheKey(cwd, sinceTimestamp);
	const cached = cache.get(key);
	if (cached && cached.mtime === mtime) {
		cache.delete(key);
		cache.set(key, cached);
		return cached.events;
	}

	let raw: string;
	try {
		raw = readFileSync(logPath, "utf-8");
	} catch {
		return [];
	}

	const lines = raw.split("\n").filter((l) => l.length > 0);
	const tail = lines.slice(-MAX_TRAILING_EVENTS);
	const events: HarnessEvent[] = [];
	for (const line of tail) {
		try {
			const parsed = JSON.parse(line) as HarnessEvent;
			if (
				sinceTimestamp &&
				typeof parsed.timestamp === "string" &&
				parsed.timestamp < sinceTimestamp
			) {
				continue;
			}
			events.push(parsed);
		} catch {
			// Skip malformed lines silently — best-effort.
		}
	}

	cache.set(key, { mtime, since: sinceTimestamp, events });
	pruneCache();
	return events;
}

/** Test helper — drop all cached entries. Exported only for vitest. */
export function _clearCrossSessionCache(): void {
	cache.clear();
}
