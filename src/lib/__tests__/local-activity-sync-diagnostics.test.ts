import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSyncError, getSyncDiagnostics, updateSyncState } from "../local-activity.js";

describe("local activity sync diagnostics", () => {
	let dataDir = "";
	const prevDataDir = process.env.INTERLINKED_DATA_DIR;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "interlinked-sync-diag-"));
		process.env.INTERLINKED_DATA_DIR = dataDir;
	});

	afterEach(() => {
		if (dataDir) {
			rmSync(dataDir, { recursive: true, force: true });
		}
		if (prevDataDir === undefined) {
			delete process.env.INTERLINKED_DATA_DIR;
		} else {
			process.env.INTERLINKED_DATA_DIR = prevDataDir;
		}
	});

	it("reports retry buffer size, last sync success, and last sync error", () => {
		writeFileSync(
			join(dataDir, "realtime-retry.jsonl"),
			`${JSON.stringify({ id: 1 })}\n${JSON.stringify({ id: 2 })}\n`,
		);

		appendSyncError({
			stage: "manual_sync_network",
			message: "timeout",
			transient: true,
		});
		updateSyncState(128);

		const diagnostics = getSyncDiagnostics();
		expect(diagnostics.pending_realtime_retry).toBe(2);
		expect(diagnostics.sync_error_count).toBe(1);
		expect(diagnostics.last_sync_success_at).toBeTruthy();
		expect(diagnostics.last_sync_error_at).toBeTruthy();
		expect(diagnostics.last_sync_error).toContain("timeout");
	});
});
