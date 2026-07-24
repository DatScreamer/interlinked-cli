import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUERY_SOURCES, resolveTarget } from "./sources.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "il-query-src-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("QUERY_SOURCES", () => {
	it("declares a file, fields, and hint for every source", () => {
		expect(QUERY_SOURCES.length).toBeGreaterThanOrEqual(10);
		for (const source of QUERY_SOURCES) {
			expect(source.name).toMatch(/^[a-z]+$/);
			expect(source.file).toMatch(/\.jsonl$/);
			expect(source.fields.length).toBeGreaterThan(0);
			expect(source.hint.length).toBeGreaterThan(0);
		}
	});

	it("keeps source names unique", () => {
		const names = QUERY_SOURCES.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("resolveTarget", () => {
	it("resolves a known source name to its data-dir file", () => {
		const resolved = resolveTarget("blocks", undefined, dir);
		expect(resolved?.file).toBe(join(dir, ".interlinked", "activity.jsonl"));
		expect(resolved?.source?.where).toEqual(["type=guard_block"]);
	});

	it("returns undefined with no target (catalog mode)", () => {
		expect(resolveTarget(undefined, undefined, dir)).toBeUndefined();
	});

	it("prefers an explicit --file over the positional source", () => {
		const explicit = join(dir, "some.jsonl");
		writeFileSync(explicit, "{}\n");
		const resolved = resolveTarget("blocks", explicit, dir);
		expect(resolved?.file).toBe(explicit);
		expect(resolved?.source).toBeUndefined();
	});

	it("resolves a bare .jsonl basename against the data dir", () => {
		writeFileSync(join(dir, ".interlinked", "custom.jsonl"), "{}\n");
		const resolved = resolveTarget("custom.jsonl", undefined, dir);
		expect(resolved?.file).toBe(join(dir, ".interlinked", "custom.jsonl"));
	});

	it("resolves a relative .jsonl path against cwd first", () => {
		writeFileSync(join(dir, "local.jsonl"), "{}\n");
		const resolved = resolveTarget("local.jsonl", undefined, dir);
		expect(resolved?.file).toBe(join(dir, "local.jsonl"));
	});

	it("throws with the catalog when the source name is unknown", () => {
		expect(() => resolveTarget("nonsense", undefined, dir)).toThrow(/Unknown source "nonsense"/);
		expect(() => resolveTarget("nonsense", undefined, dir)).toThrow(/blocks/);
	});

	it("throws when a .jsonl path exists nowhere", () => {
		expect(() => resolveTarget("ghost.jsonl", undefined, dir)).toThrow(/No such file/);
	});
});
