import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_SYNC_STATE_BYTES,
	readSyncState,
} from "./local-activity-sync.js";
import { getLocalStats } from "./local-activity.js";

describe("bounded sync-state reader", () => {
	let root: string;
	let statePath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-sync-state-"));
		const dataDir = join(root, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		statePath = join(dataDir, "sync-state.json");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("accepts a normal state within the byte ceiling", () => {
		writeFileSync(statePath, JSON.stringify({ synced_through_bytes: 42, last_sync_at: "t" }));
		expect(readSyncState(root)).toMatchObject({ synced_through_bytes: 42, last_sync_at: "t" });
	});

	it("resets an oversized state without materializing its contents", () => {
		writeFileSync(statePath, "{}");
		truncateSync(statePath, MAX_SYNC_STATE_BYTES + 1);
		expect(readSyncState(root)).toEqual({ synced_through_bytes: 0, last_sync_at: "" });
	});

	it.each([
		["missing", {}],
		["string", { synced_through_bytes: "42" }],
		["negative", { synced_through_bytes: -1 }],
		["unsafe", { synced_through_bytes: Number.MAX_SAFE_INTEGER + 1 }],
	])("fails safe for a %s cursor without rewriting the corrupt state", (_label, raw) => {
		const bytes = JSON.stringify(raw);
		writeFileSync(statePath, bytes);

		expect(readSyncState(root)).toEqual({ synced_through_bytes: 0, last_sync_at: "" });
		expect(readFileSync(statePath, "utf8")).toBe(bytes);
	});

	it("never reports a nonempty activity backlog as up to date when the state shape is invalid", () => {
		writeFileSync(statePath, "{}");
		writeFileSync(
			join(root, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "t", type: "prompt", agent: "codex" })}\n`,
		);

		expect(getLocalStats(root).pending_sync).toBe(1);
	});

	it("keeps a valid cursor but drops a malformed optional summary", () => {
		writeFileSync(
			statePath,
			JSON.stringify({
				synced_through_bytes: 42,
				last_sync_at: "t",
				last_summary: { accepted: "nine" },
			}),
		);

		expect(readSyncState(root)).toEqual({ synced_through_bytes: 42, last_sync_at: "t" });
	});

	it("accepts a fully validated summary and normalizes a legacy missing timestamp", () => {
		writeFileSync(
			statePath,
			JSON.stringify({
				synced_through_bytes: 42,
				last_summary: {
					server_url: "https://sync.test",
					workspace_id: null,
					events_total: 3,
					accepted: 2,
					skipped: 1,
					scrubbed: 0,
					batches: 1,
					by_type: { edit: 3 },
					by_agent: { codex: 3 },
					top_tools: [["Edit", 3]],
					sessions: 1,
					time_range: { earliest: "a", latest: "b" },
				},
			}),
		);

		expect(readSyncState(root)).toMatchObject({
			synced_through_bytes: 42,
			last_sync_at: "",
			last_summary: { accepted: 2, top_tools: [["Edit", 3]] },
		});
	});
});
