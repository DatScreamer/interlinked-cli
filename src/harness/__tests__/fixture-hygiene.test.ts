import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleFixtureDirs } from "./fixture-hygiene.js";

const OLD = new Date("2020-01-01T00:00:00Z");

describe("sweepStaleFixtureDirs — positive (must remove)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fixture-hygiene-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("P1: removes a stale leaked fixture dir and reports it", () => {
		const leaked = join(root, "_content_gate_fixtures-AbC123");
		mkdirSync(leaked);
		writeFileSync(join(leaked, "probe.ts"), "export const p = 1;\n");
		utimesSync(leaked, OLD, OLD);

		const removed = sweepStaleFixtureDirs(root);
		expect(removed).toEqual([leaked]);
		expect(() => statSync(leaked)).toThrow();
	});

	it("P2: removes every stale fixture family in one pass", () => {
		const names = [
			"_diff_overlay_fixtures-x1",
			"_tsc_overlay_fixtures-y2",
			"_multi_edit_fixtures-z3",
		];
		for (const name of names) {
			const dir = join(root, name);
			mkdirSync(dir);
			utimesSync(dir, OLD, OLD);
		}
		const removed = sweepStaleFixtureDirs(root);
		expect(removed.map((p) => p.split("/").pop()).sort()).toEqual([...names].sort());
	});
});

describe("sweepStaleFixtureDirs — negative (must NOT remove)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fixture-hygiene-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("N1: keeps a fresh fixture dir (a parallel live run owns it)", () => {
		const fresh = join(root, "_content_gate_fixtures-Live01");
		mkdirSync(fresh);
		expect(sweepStaleFixtureDirs(root)).toEqual([]);
		expect(statSync(fresh).isDirectory()).toBe(true);
	});

	it("N2: ignores stale dirs whose names do not match the fixture pattern", () => {
		for (const name of ["regular-dir", "_underscore-but-not-fixtures", "fixtures-no-prefix"]) {
			const dir = join(root, name);
			mkdirSync(dir);
			utimesSync(dir, OLD, OLD);
		}
		expect(sweepStaleFixtureDirs(root)).toEqual([]);
		expect(statSync(join(root, "regular-dir")).isDirectory()).toBe(true);
	});

	it("N3: an unreadable root yields an empty list rather than a throw", () => {
		expect(sweepStaleFixtureDirs(join(root, "does-not-exist"))).toEqual([]);
	});
});
