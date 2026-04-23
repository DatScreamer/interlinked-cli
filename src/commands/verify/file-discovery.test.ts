// ===========================================
// file-discovery unit tests
// ===========================================

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, discoverFiles } from "./file-discovery.js";

let tempDir: string;
let counter = 0;

beforeEach(() => {
	tempDir = join(tmpdir(), `file-discovery-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("CODE_EXTENSIONS", () => {
	it("includes major TS/JS extensions", () => {
		expect(CODE_EXTENSIONS.has(".ts")).toBe(true);
		expect(CODE_EXTENSIONS.has(".tsx")).toBe(true);
		expect(CODE_EXTENSIONS.has(".js")).toBe(true);
		expect(CODE_EXTENSIONS.has(".mjs")).toBe(true);
	});

	it("excludes markdown/json/text", () => {
		expect(CODE_EXTENSIONS.has(".md")).toBe(false);
		expect(CODE_EXTENSIONS.has(".json")).toBe(false);
		expect(CODE_EXTENSIONS.has(".txt")).toBe(false);
	});
});

describe("discoverFiles", () => {
	it("returns code files from a non-git directory (manual walk fallback)", () => {
		writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(tempDir, "b.js"), "module.exports = {};\n");
		writeFileSync(join(tempDir, "c.md"), "not code\n");
		const files = discoverFiles(tempDir);
		const names = files.map((f) => f.split("/").pop()).sort();
		expect(names).toContain("a.ts");
		expect(names).toContain("b.js");
		expect(names).not.toContain("c.md");
	});

	it("skips node_modules and dist directories", () => {
		mkdirSync(join(tempDir, "node_modules"), { recursive: true });
		writeFileSync(join(tempDir, "node_modules", "dep.ts"), "export const x = 1;\n");
		mkdirSync(join(tempDir, "dist"), { recursive: true });
		writeFileSync(join(tempDir, "dist", "out.ts"), "export const y = 1;\n");
		writeFileSync(join(tempDir, "src.ts"), "export const z = 1;\n");
		const files = discoverFiles(tempDir);
		const paths = files.map((f) => f.replace(tempDir, ""));
		expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
		expect(paths.some((p) => p.includes("/dist/"))).toBe(false);
		expect(paths.some((p) => p.endsWith("src.ts"))).toBe(true);
	});

	it("returns empty array for empty directory", () => {
		expect(discoverFiles(tempDir)).toEqual([]);
	});
});
