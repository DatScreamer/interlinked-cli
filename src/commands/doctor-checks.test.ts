import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionLiveness } from "../lib/collection/liveness.js";
import { writeGuardDisable } from "../lib/guard-state.js";
import { collectionLivenessCheck, harnessChecks } from "./doctor-checks.js";

vi.mock("./harness.js", () => ({
	isHarnessRunning: vi.fn().mockReturnValue({ running: false }),
}));

describe("collectionLivenessCheck", () => {
	it("returns a pass row for 'live' status", () => {
		const live: CollectionLiveness = {
			status: "live",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-06T00:00:00.000Z",
			lastRecordAgeMs: 1_000,
			reason: "recent event",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "pass",
			message: "collection.jsonl flowing -- recent event",
		});
	});

	it("returns a pass row for 'idle' status", () => {
		const live: CollectionLiveness = {
			status: "idle",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-06T00:00:00.000Z",
			lastRecordAgeMs: 6 * 60_000,
			reason: "no recent tool use",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "pass",
			message: "collection.jsonl -- no recent tool use",
		});
	});

	it("returns a warn row for 'stale' status", () => {
		const live: CollectionLiveness = {
			status: "stale",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 1024,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: "2026-08-05T00:00:00.000Z",
			lastRecordAgeMs: 60 * 60_000,
			reason: "no writes in 1h",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message:
				"collection.jsonl STALE -- no writes in 1h. Check 'interlinked harness status' + hook wiring ('interlinked enable').",
		});
	});

	it("returns a warn row for 'missing' status", () => {
		const live: CollectionLiveness = {
			status: "missing",
			path: "/tmp/collection.jsonl",
			exists: false,
			sizeBytes: 0,
			mtimeMs: null,
			lastRecordTs: null,
			lastRecordAgeMs: null,
			reason: "not found",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "No collection.jsonl yet -- start the daemon and run 'interlinked enable' to begin recording.",
		});
	});

	it("returns a warn row for 'empty' status", () => {
		const live: CollectionLiveness = {
			status: "empty",
			path: "/tmp/collection.jsonl",
			exists: true,
			sizeBytes: 0,
			mtimeMs: 1_700_000_000_000,
			lastRecordTs: null,
			lastRecordAgeMs: null,
			reason: "zero bytes",
		};
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "collection.jsonl is empty -- no tool events recorded yet.",
		});
	});

	it("returns a warn row for an unrecognized/default status", () => {
		const live = { status: "corrupt", reason: "bad json" } as unknown as CollectionLiveness;
		expect(collectionLivenessCheck(live)).toEqual({
			status: "warn",
			message: "collection.jsonl unreadable -- bad json",
		});
	});
});

describe("harnessChecks — guard stand-down row", () => {
	let dir: string;
	let configDir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-checks-")));
		configDir = join(dir, ".interlinked");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("omits the Guard stand-down row when the guard is not disabled", () => {
		const rows = harnessChecks(dir, configDir);
		expect(rows.find((r) => r.name === "Guard stand-down")).toBeUndefined();
	});

	it("adds a warn row with by/reason/team scope when disabled by a named team marker", () => {
		writeGuardDisable(
			configDir,
			{ by: "qcody", reason: "incident response", now: "2026-01-01T00:00:00Z" },
			true,
		);
		const rows = harnessChecks(dir, configDir);
		const row = rows.find((r) => r.name === "Guard stand-down");
		expect(row).toEqual({
			name: "Guard stand-down",
			status: "warn",
			message:
				'Harness STOOD DOWN here (committed/team by qcody) — "incident response". Re-arm with \'interlinked enable\'',
		});
	});

	it("adds a warn row with no by/reason suffix and personal scope for a bare local marker", () => {
		writeGuardDisable(configDir, { now: "2026-01-01T00:00:00Z" }, false);
		const rows = harnessChecks(dir, configDir);
		const row = rows.find((r) => r.name === "Guard stand-down");
		expect(row).toEqual({
			name: "Guard stand-down",
			status: "warn",
			message: "Harness STOOD DOWN here (personal). Re-arm with 'interlinked enable'",
		});
	});
});
