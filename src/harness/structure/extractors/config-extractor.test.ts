import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extract, metadata } from "./config-extractor.js";

describe("config-extractor", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cfg-ext-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("metadata declares config-access patterns", () => {
		expect(metadata.name).toBe("config-extractor");
		expect(metadata.output_kinds).toEqual(["config_key"]);
	});

	it('discovers config.get("key")', () => {
		writeFileSync(join(tmp, "a.ts"), 'config.get("server.url")');
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("server.url");
	});

	it('discovers config["key"]', () => {
		writeFileSync(join(tmp, "b.ts"), `config["max_retries"]`);
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("max_retries");
	});

	it("discovers config.key.subkey (dotted)", () => {
		writeFileSync(join(tmp, "c.ts"), "config.db.host");
		const { nodes } = extract(tmp);
		expect(nodes.map((n) => n.label)).toContain("db.host");
	});

	it("returns empty when no matches", () => {
		writeFileSync(join(tmp, "a.ts"), "const x = 1;");
		const { nodes } = extract(tmp);
		expect(nodes).toEqual([]);
	});

	it("deduplicates repeated keys across files", () => {
		writeFileSync(join(tmp, "a.ts"), 'config.get("dup.key")');
		writeFileSync(join(tmp, "b.ts"), 'config.get("dup.key")');
		const { nodes } = extract(tmp);
		expect(nodes.filter((n) => n.label === "dup.key")).toHaveLength(1);
	});
});
