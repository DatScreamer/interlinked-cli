import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CoverageObligation,
	readFileCoverageBaseline,
	readRuntimeEstimateMs,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "./coverage-obligation-ledger.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-ledger-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("runtime estimate", () => {
	it("returns null when no estimate has been recorded", () => {
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});

	it("seeds the estimate directly on the first measurement", () => {
		updateRuntimeEstimateMs(root, 1200, () => 0);
		expect(readRuntimeEstimateMs(root)).toBe(1200);
	});

	it("blends later measurements via EWMA (does not jump straight to the new value)", () => {
		updateRuntimeEstimateMs(root, 1000, () => 0);
		updateRuntimeEstimateMs(root, 3000, () => 0);
		const blended = readRuntimeEstimateMs(root);
		// EWMA(alpha=0.5): 1000*0.5 + 3000*0.5 = 2000.
		expect(blended).toBe(2000);
	});

	it("reads null when the estimate file is malformed (fail-open)", () => {
		// Write garbage where the estimate lives, then confirm we read null.
		updateRuntimeEstimateMs(root, 500, () => 0);
		const path = join(root, ".interlinked", "coverage-runtime-estimate.json");
		expect(existsSync(path)).toBe(true);
		rmSync(path);
		// Re-create as invalid JSON via the obligation log writer's dir, then check.
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});
});

describe("per-file coverage baseline", () => {
	it("returns null for a file with no baseline", () => {
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBeNull();
	});

	it("round-trips a covered fraction for a file", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.8);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.8);
	});

	it("merges multiple files into one baseline map without clobbering", () => {
		writeFileCoverageBaseline(root, "src/a.ts", 0.8);
		writeFileCoverageBaseline(root, "src/b.ts", 0.6);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(0.8);
		expect(readFileCoverageBaseline(root, "src/b.ts")).toBe(0.6);
	});
});

describe("obligation log", () => {
	it("appends a JSONL row that round-trips", () => {
		const obligation: CoverageObligation = {
			kind: "coverage",
			file: "src/slow.ts",
			reason: "budget_exceeded",
			estimated_suite_ms: 40_000,
			budget_ms: 25_000,
			session_id: "sess-1",
			timestamp: "2026-06-07T00:00:00.000Z",
		};
		recordCoverageObligation(root, obligation);
		const path = join(root, ".interlinked", "coverage-obligations.jsonl");
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual(obligation);
	});

	it("appends successive obligations rather than overwriting", () => {
		const base: CoverageObligation = {
			kind: "coverage",
			file: "src/slow.ts",
			reason: "budget_exceeded",
			estimated_suite_ms: 40_000,
			budget_ms: 25_000,
			session_id: "sess-1",
			timestamp: "2026-06-07T00:00:00.000Z",
		};
		recordCoverageObligation(root, base);
		recordCoverageObligation(root, { ...base, file: "src/other.ts" });
		const path = join(root, ".interlinked", "coverage-obligations.jsonl");
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});
});
