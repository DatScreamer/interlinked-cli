import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	estimateEditLine,
	globMatch,
	isBash,
	isBrowserNavigate,
	isFileOperation,
	isFileWrite,
	isReadOperation,
	normalizeToolToOp,
} from "../tool-classifiers.js";

describe("tool classifiers", () => {
	it("isBash matches Bash-family tool names and rejects unrelated ones", () => {
		expect(isBash("Bash")).toBe(true);
		expect(isBash("bash")).toBe(true);
		expect(isBash("run_command")).toBe(true);
		expect(isBash(undefined)).toBe(false);
		expect(isBash("Write")).toBe(false);
	});

	it("isBrowserNavigate only matches Playwright/Chrome DevTools navigation tools", () => {
		expect(isBrowserNavigate("mcp__playwright__browser_navigate")).toBe(true);
		expect(isBrowserNavigate("mcp__chrome-devtools__navigate_page")).toBe(true);
		expect(isBrowserNavigate("mcp__chrome-devtools__new_page")).toBe(true);
		expect(isBrowserNavigate("mcp__playwright__browser_click")).toBe(false);
		expect(isBrowserNavigate(undefined)).toBe(false);
	});

	it("isFileOperation covers Read/Write/Edit + Copilot CLI aliases", () => {
		expect(isFileOperation("Read")).toBe(true);
		expect(isFileOperation("Write")).toBe(true);
		expect(isFileOperation("Edit")).toBe(true);
		expect(isFileOperation("str_replace")).toBe(true);
		expect(isFileOperation("apply_patch")).toBe(true);
		expect(isFileOperation("Bash")).toBe(false);
		expect(isFileOperation(undefined)).toBe(false);
	});

	it("isReadOperation narrows to file-read tool variants", () => {
		expect(isReadOperation("Read")).toBe(true);
		expect(isReadOperation("view")).toBe(true);
		expect(isReadOperation("Write")).toBe(false);
		expect(isReadOperation(undefined)).toBe(false);
	});

	it("isFileWrite narrows to file-write tool variants including NotebookEdit", () => {
		expect(isFileWrite("Write")).toBe(true);
		expect(isFileWrite("Edit")).toBe(true);
		expect(isFileWrite("NotebookEdit")).toBe(true);
		expect(isFileWrite("apply_patch")).toBe(true);
		expect(isFileWrite("Read")).toBe(false);
		expect(isFileWrite(undefined)).toBe(false);
	});

	it("normalizeToolToOp maps tool names to canonical protected-file ops", () => {
		expect(normalizeToolToOp("Read")).toBe("Read");
		expect(normalizeToolToOp("Write")).toBe("Write");
		expect(normalizeToolToOp("Edit")).toBe("Edit");
		expect(normalizeToolToOp("FileDelete")).toBe("Delete");
		expect(normalizeToolToOp("NotebookEdit")).toBe("Write");
		expect(normalizeToolToOp("Mystery")).toBe("Mystery");
	});
});

describe("estimateEditLine", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "evaluator-tc-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns line number of match (1-indexed)", () => {
		const file = join(tmpDir, "sample.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		expect(estimateEditLine(file, "gamma")).toBe(3);
	});

	it("returns undefined when file missing or old_string absent", () => {
		const file = join(tmpDir, "sample.txt");
		writeFileSync(file, "alpha\nbeta\n");
		expect(estimateEditLine(file, "missing")).toBeUndefined();
		expect(estimateEditLine(join(tmpDir, "no-such-file.txt"), "alpha")).toBeUndefined();
	});
});

describe("globMatch", () => {
	it("matches **/*.ext anywhere in the tree", () => {
		expect(globMatch("src/foo/bar.ts", "**/*.ts")).toBe(true);
		expect(globMatch("src/foo/bar.ts", "**/*.js")).toBe(false);
	});

	it("matches pipe-separated patterns as a union", () => {
		expect(globMatch("secret.pem", "**/*.pem|**/*.key")).toBe(true);
		expect(globMatch("secret.key", "**/*.pem|**/*.key")).toBe(true);
		expect(globMatch("README.md", "**/*.pem|**/*.key")).toBe(false);
	});

	it("matches **/*.env* trailing-wildcard patterns", () => {
		expect(globMatch(".env.local", "**/*.env*")).toBe(true);
		expect(globMatch("config/.env.production", "**/*.env*")).toBe(true);
	});

	it("matches dir/** prefixes and dir/* direct children only", () => {
		expect(globMatch("src/a/b.ts", "src/**")).toBe(true);
		expect(globMatch("src/a.ts", "src/*")).toBe(true);
		expect(globMatch("src/a/b.ts", "src/*")).toBe(false);
	});

	it("returns false for non-matching bare patterns", () => {
		expect(globMatch("foo.ts", "bar.ts")).toBe(false);
	});
});
