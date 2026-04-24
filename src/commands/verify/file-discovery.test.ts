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
	it("returns code + config + docs (wide text-scan policy)", () => {
		// Policy: scan every tracked text file, then let individual checks
		// filter by applicable extension. Fixes the summary-line bug where
		// files like tsconfig.json were flagged by external tools but never
		// counted in the "files scanned" denominator.
		writeFileSync(join(tempDir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(tempDir, "b.js"), "module.exports = {};\n");
		writeFileSync(join(tempDir, "c.md"), "# docs\n");
		writeFileSync(join(tempDir, "tsconfig.json"), "{}\n");
		const files = discoverFiles(tempDir);
		const names = files.map((f) => f.split("/").pop()).sort();
		expect(names).toContain("a.ts");
		expect(names).toContain("b.js");
		expect(names).toContain("c.md");
		expect(names).toContain("tsconfig.json");
	});

	it("excludes binary assets and lock files", () => {
		writeFileSync(join(tempDir, "src.ts"), "export const z = 1;\n");
		writeFileSync(join(tempDir, "logo.png"), "\x89PNG\r\n\x1a\n");
		writeFileSync(join(tempDir, "font.woff2"), "binary");
		writeFileSync(join(tempDir, "package-lock.json"), "{}\n");
		writeFileSync(join(tempDir, "yarn.lock"), "# yarn lockfile\n");
		const files = discoverFiles(tempDir);
		const names = files.map((f) => f.split("/").pop()).sort();
		expect(names).toContain("src.ts");
		expect(names).not.toContain("logo.png");
		expect(names).not.toContain("font.woff2");
		expect(names).not.toContain("package-lock.json");
		expect(names).not.toContain("yarn.lock");
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
