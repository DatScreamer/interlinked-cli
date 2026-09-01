import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLocalStats, getUnsyncedEvents, updateSyncState } from "./local-activity.js";

const OVER_V8_STRING_LIMIT = 513 * 1024 * 1024;

function writeSparseEvent(path: string, event: object): number {
	const encoded = Buffer.from(`${JSON.stringify(event)}\n`);
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, OVER_V8_STRING_LIMIT);
		writeSync(fd, encoded, 0, encoded.length, OVER_V8_STRING_LIMIT);
	} finally {
		closeSync(fd);
	}
	return encoded.length;
}

describe("large local activity logs", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "activity-large-"));
		mkdirSync(join(tmp, ".interlinked"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("syncs a record beyond 512 MiB without materializing the sparse prefix", () => {
		const activityPath = join(tmp, ".interlinked", "activity.jsonl");
		const event = { ts: "2026-08-31T00:00:00.000Z", agent: "codex", type: "tool_use" };
		const encodedBytes = writeSparseEvent(activityPath, event);
		updateSyncState(OVER_V8_STRING_LIMIT, undefined, tmp);

		const result = getUnsyncedEvents(1, tmp);
		expect(result.events).toEqual([event]);
		expect(result.newOffset).toBe(OVER_V8_STRING_LIMIT + encodedBytes);
	});

	it("reports at least one pending event when a tiny suffix follows 512 MiB", () => {
		const activityPath = join(tmp, ".interlinked", "activity.jsonl");
		const event = { ts: "2026-08-31T00:00:00.000Z", agent: "codex", type: "tool_use" };
		const encodedBytes = writeSparseEvent(activityPath, event);
		updateSyncState(OVER_V8_STRING_LIMIT, undefined, tmp);

		const stats = getLocalStats(tmp);
		expect(stats.file_size_bytes).toBe(OVER_V8_STRING_LIMIT + encodedBytes);
		expect(stats.total_events).toBe(1);
		expect(stats.pending_sync).toBe(1);
	});

	it("surfaces an activity read failure instead of claiming zero pending events", () => {
		mkdirSync(join(tmp, ".interlinked", "activity.jsonl"));
		expect(() => getLocalStats(tmp)).toThrow();
	});
});
