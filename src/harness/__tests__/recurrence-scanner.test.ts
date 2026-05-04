// Tests for the codebase_existing scanner — walks the working tree,
// runs registry inline detectors against each file, optionally records
// codebase_existing recurrence events for repeated patterns.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRecurrenceEvents } from "../recurrence.js";
import {
	scanCodebaseForRecurrences,
	type ScanCodebaseFinding,
} from "../recurrence-scanner.js";

describe("scanCodebaseForRecurrences", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-scan-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fixture(relPath: string, content: string): string {
		const abs = join(dir, relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	}

	it("returns an empty list when no source files match", () => {
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings).toEqual([]);
	});

	it("flags eval() usage in a TS file under src/", () => {
		fixture("src/bad.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const evalHit = findings.find((f: ScanCodebaseFinding) => f.check_id === "eval_usage");
		expect(evalHit).toBeDefined();
		expect(evalHit?.file).toBe("src/bad.ts");
	});

	it("does not record events by default (dry run)", () => {
		fixture("src/bad.ts", "export const x = eval('1+1');\n");
		scanCodebaseForRecurrences({ cwd: dir });
		expect(loadRecurrenceEvents(dir)).toEqual([]);
	});

	it("when recordEvents=true, appends a codebase_existing event per finding", () => {
		fixture("src/a.ts", "export const x = eval('1+1');\n");
		fixture("src/b.ts", "export const y = eval('2+2');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir, recordEvents: true });
		expect(findings.length).toBeGreaterThanOrEqual(2);
		const events = loadRecurrenceEvents(dir);
		const evalEvents = events.filter((e) => e.check_id === "eval_usage");
		expect(evalEvents.length).toBeGreaterThanOrEqual(2);
		expect(evalEvents.every((e) => e.kind === "codebase_existing")).toBe(true);
		const files = new Set(evalEvents.map((e) => e.file));
		expect(files.has("src/a.ts")).toBe(true);
		expect(files.has("src/b.ts")).toBe(true);
	});

	it("skips node_modules / dist / build / vendor subtrees", () => {
		fixture("node_modules/foo/index.ts", "eval('x');\n");
		fixture("dist/bundle.ts", "eval('x');\n");
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		const files = new Set<string>(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("src/keeper.ts")).toBe(true);
		expect([...files].some((f) => f.includes("node_modules"))).toBe(false);
		expect([...files].some((f) => f.startsWith("dist/"))).toBe(false);
	});

	it("limits which file extensions it inspects (TS/JS family by default)", () => {
		fixture("src/secret.txt", "eval('not source code');\n");
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings.some((f: ScanCodebaseFinding) => f.file === "src/secret.txt")).toBe(false);
		expect(findings.some((f: ScanCodebaseFinding) => f.file === "src/keeper.ts")).toBe(true);
	});

	it("respects an explicit roots option (custom directory list)", () => {
		fixture("src/in.ts", "export const x = eval('1+1');\n");
		fixture("lib/in.ts", "export const x = eval('1+1');\n");
		const findings = scanCodebaseForRecurrences({ cwd: dir, roots: ["lib"] });
		const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
		expect(files.has("lib/in.ts")).toBe(true);
		expect(files.has("src/in.ts")).toBe(false);
	});
});
