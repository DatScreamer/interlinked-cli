import { describe, expect, it } from "vitest";
import { detectSnapshotHygiene } from "./snapshot-hygiene.js";

const ANY_CONTENT = "// snapshot bytes — content is not inspected\n[]";

describe("detectSnapshotHygiene — positive cases", () => {
	it("flags a jest/vitest *.snap.new review artifact under __snapshots__/", () => {
		const out = detectSnapshotHygiene(
			ANY_CONTENT,
			"src/components/__snapshots__/Button.test.tsx.snap.new",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toMatch(/snapshot review artifact/i);
	});

	it("flags a cargo-insta *.pending-snap review artifact under snapshots/", () => {
		const out = detectSnapshotHygiene(
			ANY_CONTENT,
			"crates/beads/tests/snapshots/golden_beads_init__cli.pending-snap",
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
	});

	it("flags a bare *.snap.new at the repo root (no directory prefix)", () => {
		expect(detectSnapshotHygiene(ANY_CONTENT, "Foo.test.ts.snap.new")).toHaveLength(1);
	});

	it("flags Windows-style backslash paths to a review artifact", () => {
		expect(
			detectSnapshotHygiene(ANY_CONTENT, "src\\__snapshots__\\widget.test.ts.snap.new"),
		).toHaveLength(1);
	});

	it("is case-insensitive on the extension", () => {
		expect(detectSnapshotHygiene(ANY_CONTENT, "src/__snapshots__/X.test.ts.SNAP.NEW")).toHaveLength(
			1,
		);
	});
});

describe("detectSnapshotHygiene — negative cases", () => {
	it("does NOT fire on an accepted *.snap (the committed golden file)", () => {
		expect(
			detectSnapshotHygiene(ANY_CONTENT, "src/components/__snapshots__/Button.test.tsx.snap"),
		).toEqual([]);
	});

	it("does NOT fire on an accepted insta *.snap golden file", () => {
		expect(
			detectSnapshotHygiene(ANY_CONTENT, "crates/beads/tests/snapshots/golden_beads_init__cli.snap"),
		).toEqual([]);
	});

	it("does NOT fire on a normal source file", () => {
		expect(detectSnapshotHygiene("export const x = 1;", "src/lib/foo.ts")).toEqual([]);
	});

	it("does NOT fire on a test file that merely mentions .snap.new in its body", () => {
		const code = [
			"it('cleans up review files', () => {",
			"  expect(existsSync('x.snap.new')).toBe(false);",
			"});",
		].join("\n");
		expect(detectSnapshotHygiene(code, "src/__tests__/snapshot.test.ts")).toEqual([]);
	});

	it("does NOT fire on a file whose name only CONTAINS 'snap' (e.g. snapshot.ts)", () => {
		expect(detectSnapshotHygiene(ANY_CONTENT, "src/lib/snapshot.ts")).toEqual([]);
	});

	it("does NOT fire on a '.new' file that is not a snapshot (e.g. config.json.new)", () => {
		expect(detectSnapshotHygiene(ANY_CONTENT, "config/settings.json.new")).toEqual([]);
	});
});
