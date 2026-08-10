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

	it("P1: reports retry buffer size, last sync success, and last sync error", () => {
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

	// --- parseSyncErrorEntry boundary parser (local-activity.ts) ---

	it("P2: extra unrecognised fields on the sync-error line do not block ts/message", () => {
		writeFileSync(
			join(dataDir, "sync-errors.jsonl"),
			`${JSON.stringify({ ts: "2026-08-01T00:00:00Z", message: "boom", stage: "x", transient: false, extra: { nested: 1 } })}\n`,
		);

		const diagnostics = getSyncDiagnostics();
		expect(diagnostics.sync_error_count).toBe(1);
		expect(diagnostics.last_sync_error_at).toBe("2026-08-01T00:00:00Z");
		expect(diagnostics.last_sync_error).toBe("boom");
	});

	it("N1: a wrongly-typed message is dropped but ts and the error count survive", () => {
		writeFileSync(
			join(dataDir, "sync-errors.jsonl"),
			`${JSON.stringify({ ts: "2026-08-01T00:00:00Z", message: 12345 })}\n`,
		);

		const diagnostics = getSyncDiagnostics();
		expect(diagnostics.sync_error_count).toBe(1);
		expect(diagnostics.last_sync_error_at).toBe("2026-08-01T00:00:00Z");
		expect(diagnostics.last_sync_error).toBeUndefined();
	});

	it("N2: a non-object last line leaves both ts and message undefined without throwing", () => {
		writeFileSync(join(dataDir, "sync-errors.jsonl"), '["not", "an", "object"]\n');

		const diagnostics = getSyncDiagnostics();
		expect(diagnostics.sync_error_count).toBe(1);
		expect(diagnostics.last_sync_error_at).toBeUndefined();
		expect(diagnostics.last_sync_error).toBeUndefined();
	});
});
