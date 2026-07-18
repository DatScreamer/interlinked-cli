import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FINGERPRINT_TTL_MS, fingerprintBlock } from "./block-fingerprint.js";
import {
	clearArchive,
	loadArmedFingerprints,
	persistArmedFingerprints,
} from "./fingerprint-archive.js";

const T0 = 5_000_000;
let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fp-archive-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("fingerprint-archive round-trip", () => {
	it("persists and rehydrates a fingerprint (shingles Set survives JSON)", () => {
		const fp = fingerprintBlock({
			ruleId: "empty_catch",
			content: "try { risky() } catch (e) {}",
			target: "src/a.ts",
			atMs: T0,
		});
		persistArmedFingerprints(cwd, "sess-1", [fp], [{ detector: "d1", ruleId: "empty_catch" }]);

		const loaded = loadArmedFingerprints(cwd, "sess-1", T0 + 1000);
		expect(loaded).not.toBeNull();
		expect(loaded?.fingerprints).toHaveLength(1);
		expect(loaded?.fingerprints[0]?.ruleId).toBe("empty_catch");
		expect(loaded?.fingerprints[0]?.target).toBe("src/a.ts");
		expect(loaded?.fingerprints[0]?.shingles).toBeInstanceOf(Set);
		expect(loaded?.fingerprints[0]?.shingles.size).toBeGreaterThan(0);
		expect(loaded?.signals).toEqual([{ detector: "d1", ruleId: "empty_catch" }]);
	});

	it("prunes expired fingerprints on load (TTL enforced across restart)", () => {
		const fp = fingerprintBlock({ ruleId: "old", content: "aaa bbb ccc ddd", atMs: T0 });
		persistArmedFingerprints(cwd, "sess-2", [fp], []);

		const loaded = loadArmedFingerprints(cwd, "sess-2", T0 + DEFAULT_FINGERPRINT_TTL_MS + 1);
		expect(loaded?.fingerprints).toHaveLength(0);
	});

	it("sanitizes the session id into a safe basename (no path escape)", () => {
		const fp = fingerprintBlock({ ruleId: "r", content: "x y z", atMs: T0 });
		// A session id with slashes/dots must not write outside the archive dir.
		persistArmedFingerprints(cwd, "../../etc/passwd", [fp], []);
		const loaded = loadArmedFingerprints(cwd, "../../etc/passwd", T0 + 1);
		expect(loaded?.fingerprints).toHaveLength(1);
	});
});

describe("fingerprint-archive fail-open", () => {
	it("returns null when no archive exists", () => {
		expect(loadArmedFingerprints(cwd, "never-written", T0)).toBeNull();
	});

	it("returns null (not throw) on a corrupt archive", () => {
		const dir = join(cwd, ".interlinked", "trajectory-armed");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "corrupt.json"), "{ this is not json ");
		expect(loadArmedFingerprints(cwd, "corrupt", T0)).toBeNull();
	});

	it("clearArchive removes a session's file and is a no-op when absent", () => {
		const fp = fingerprintBlock({ ruleId: "r", content: "x y z", atMs: T0 });
		persistArmedFingerprints(cwd, "sess-clear", [fp], []);
		expect(loadArmedFingerprints(cwd, "sess-clear", T0 + 1)?.fingerprints).toHaveLength(1);
		clearArchive(cwd, "sess-clear");
		expect(loadArmedFingerprints(cwd, "sess-clear", T0 + 1)).toBeNull();
		expect(() => clearArchive(cwd, "never")).not.toThrow(); // idempotent
	});
});
