// Co-located tests for the CLI-entrypoint exemption (field report 2026-07-06):
// `console_statements` (checkConsoleDebug — the PostToolUse registry check,
// also run by verify's file-checks) fired on entrypoints whose console.log IS
// their output. `isCliEntrypoint` is the shared predicate — the write-guard
// content-quality console heuristic consumes the same function, so both
// surfaces inherit these semantics.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkConsoleDebug, isCliEntrypoint, locateBinaryContent } from "./language-agnostic.js";

const LOGS = 'console.log("output line");\nconsole.log("another");\n';

describe("isCliEntrypoint", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cli-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects a shebang first line", () => {
		expect(isCliEntrypoint("/proj/src/tool.ts", "#!/usr/bin/env node\nrun();")).toBe(true);
	});

	it("detects scripts/ and bin/ path segments", () => {
		expect(isCliEntrypoint("/proj/scripts/migrate.ts", "run();")).toBe(true);
		expect(isCliEntrypoint("proj/bin/tool.js", "run();")).toBe(true);
	});

	it("detects a string-form package.json bin target", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliEntrypoint(join(dir, "run.js"), "run();")).toBe(true);
	});

	it("detects an object-form package.json bin target via the NEAREST package.json", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "t", bin: { tool: "./dist/entry.js" } }),
		);
		mkdirSync(join(dir, "dist"), { recursive: true });
		expect(isCliEntrypoint(join(dir, "dist", "entry.js"), "run();")).toBe(true);
	});

	it("resolves a relative path against cwd for the bin lookup", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliEntrypoint("run.js", "run();", dir)).toBe(true);
	});

	it("is false for ordinary source files, non-bin-target files, and malformed package.json", () => {
		expect(isCliEntrypoint("/proj/src/lib/util.ts", "export const x = 1;")).toBe(false);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(isCliEntrypoint(join(dir, "src", "other.ts"), "export const x = 1;")).toBe(false);
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(isCliEntrypoint(join(dir, "run.js"), "run();")).toBe(false);
	});

	it("skips the bin lookup for a relative path without cwd (no crash, path rules still apply)", () => {
		expect(isCliEntrypoint("src/app.ts", "export const x = 1;")).toBe(false);
	});
});

describe("checkConsoleDebug — CLI-entrypoint exemption", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cd-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does NOT flag a shebang entrypoint", () => {
		expect(checkConsoleDebug(`#!/usr/bin/env node\n${LOGS}`, "/proj/src/tool.ts")).toEqual([]);
	});

	it("does NOT flag a package.json bin target", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.mjs" }));
		expect(checkConsoleDebug(LOGS, join(dir, "run.mjs"))).toEqual([]);
	});

	it("still flags ordinary library files (path- and bin-map-negative)", () => {
		expect(checkConsoleDebug(LOGS, "/proj/src/app.ts").length).toBeGreaterThanOrEqual(1);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(checkConsoleDebug(LOGS, join(dir, "src", "app.ts")).length).toBeGreaterThanOrEqual(1);
	});
});

// locateBinaryContent supplies the position/count that makes the
// binary_content error actionable — the raw byte is invisible in editors.
// Fixtures build the NUL with String.fromCharCode so this test file never
// contains a raw control byte itself.
describe("locateBinaryContent", () => {
	const NUL = String.fromCharCode(0);

	it("returns null for clean content", () => {
		expect(locateBinaryContent("plain text\nsecond line\n")).toBeNull();
		expect(locateBinaryContent("")).toBeNull();
		expect(locateBinaryContent("escaped \\u0000 text is fine")).toBeNull();
	});

	it("reports a 1-based line:column for the first NUL", () => {
		expect(locateBinaryContent(`valid text${NUL}rest`)).toEqual({
			count: 1,
			line: 1,
			column: 11,
		});
	});

	it("tracks line breaks before the first NUL", () => {
		expect(locateBinaryContent(`line one\nab${NUL}cd`)).toEqual({
			count: 1,
			line: 2,
			column: 3,
		});
	});

	it("counts every NUL but positions only the first", () => {
		expect(locateBinaryContent(`a${NUL}b\nc${NUL}${NUL}d`)).toEqual({
			count: 3,
			line: 1,
			column: 2,
		});
	});

	it("handles a NUL as the very first character", () => {
		expect(locateBinaryContent(`${NUL}payload`)).toEqual({ count: 1, line: 1, column: 1 });
	});
});
