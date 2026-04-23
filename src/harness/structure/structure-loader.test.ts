import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getImplicitConfig, loadArtifactFile, loadStructureConfig } from "./structure-loader.js";

describe("loadStructureConfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "struct-load-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns implicit=true when no structure.json exists", () => {
		const r = loadStructureConfig(tmp);
		expect(r.implicit).toBe(true);
		expect(r.config).toBeNull();
		expect(r.errors).toEqual([]);
	});

	it("returns errors for malformed JSON", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(join(tmp, "interlinked", "structure.json"), "{not json");
		const r = loadStructureConfig(tmp);
		expect(r.config).toBeNull();
		expect(r.errors.length).toBeGreaterThan(0);
	});

	it("loads a valid structure.json", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "structure.json"),
			JSON.stringify({ version: 1, mode: "minimal", artifacts: {} }),
		);
		const r = loadStructureConfig(tmp);
		expect(r.config?.mode).toBe("minimal");
		expect(r.implicit).toBe(false);
	});

	it("returns schema errors for unknown top-level keys", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "structure.json"),
			JSON.stringify({ version: 1, mode: "minimal", bogus: true }),
		);
		const r = loadStructureConfig(tmp);
		expect(r.config).toBeNull();
		expect(r.errors.some((e) => /Unknown/.test(e))).toBe(true);
	});
});

describe("getImplicitConfig", () => {
	it("returns a minimal mode config by default", () => {
		const c = getImplicitConfig();
		expect(c.mode).toBe("minimal");
		expect(c.version).toBe(1);
	});
});

describe("loadArtifactFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "struct-art-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports `File not found` when missing", () => {
		const r = loadArtifactFile(tmp, "public_api", "public-api.json");
		expect(r.data).toBeNull();
		expect(r.errors[0]).toMatch(/File not found/);
	});

	it("returns parsed data for a valid env file", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(
			join(tmp, "interlinked", "env.json"),
			JSON.stringify({ version: 1, keys: [] }),
		);
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.errors).toEqual([]);
		expect(r.data).toBeTruthy();
	});

	it("reports JSON parse errors", () => {
		mkdirSync(join(tmp, "interlinked"));
		writeFileSync(join(tmp, "interlinked", "env.json"), "{broken");
		const r = loadArtifactFile(tmp, "env", "env.json");
		expect(r.data).toBeNull();
		expect(r.errors.length).toBeGreaterThan(0);
	});
});
