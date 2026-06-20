// Tests for the codebase_existing scanner — walks the working tree,
// runs registry inline detectors against each file, optionally records
// codebase_existing recurrence events for repeated patterns.

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRecurrenceEvents } from "../recurrence.js";
import type { DetectorFinding } from "../checks/endpoint-security.js";
import {
	scanCIFilesForRecurrences,
	scanCodebaseForRecurrences,
	scanFilesForDetector,
	type ScanCodebaseFinding,
} from "../recurrence-scanner.js";
import { nonNull } from "../../lib/non-null.js";

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

	it("does not follow symlinked subdirectories", () => {
		fixture("src/keeper.ts", "export const x = eval('1+1');\n");
		const externalDir = mkdtempSync(join(tmpdir(), "interlinked-scan-ext-"));
		try {
			writeFileSync(join(externalDir, "outside.ts"), "eval('outside');\n");
			try {
				symlinkSync(externalDir, join(dir, "src", "linked"), "dir");
			} catch (_err) {
				// Some test envs (e.g., locked-down Windows runners) reject
				// symlink creation; the behavior under test only matters when
				// symlinks exist, so skipping is the right call.
				return;
			}
			const findings = scanCodebaseForRecurrences({ cwd: dir });
			const files = new Set(findings.map((f: ScanCodebaseFinding) => f.file));
			expect(files.has("src/keeper.ts")).toBe(true);
			expect([...files].some((f) => f.includes("linked"))).toBe(false);
			expect([...files].some((f) => f.endsWith("outside.ts"))).toBe(false);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});
});

// ===========================================
// Phase D — scoped-scan API (scanFilesForDetector)
// ===========================================

describe("scanFilesForDetector", () => {
	/** Tiny synthetic detector — flags every line containing "BAD". */
	function badLineDetector(file: string, content: string): DetectorFinding[] {
		const out: DetectorFinding[] = [];
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			if (nonNull(lines[i]).includes("BAD")) {
				out.push({
					check_id: "bad_line",
					file,
					line: i + 1,
					message: `bad line ${i + 1}`,
				});
			}
		}
		return out;
	}

	it("returns an empty array when given no files", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: [],
			readFile: () => "",
		});
		expect(out).toEqual([]);
	});

	it("returns an empty array when the single file has zero detector hits", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/clean.ts"],
			readFile: () => "// nothing flagged here\nconst x = 1;\n",
		});
		expect(out).toEqual([]);
	});

	it("returns N findings from a single file with N detector hits", () => {
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/dirty.ts"],
			readFile: () => "ok\nBAD here\nok\nBAD again\n",
		});
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ check_id: "bad_line", file: "/abs/dirty.ts", line: 2 });
		expect(out[1]).toMatchObject({ check_id: "bad_line", file: "/abs/dirty.ts", line: 4 });
	});

	it("aggregates findings across multiple files with mixed content", () => {
		const contents: Record<string, string> = {
			"/abs/a.ts": "clean\nclean\n",
			"/abs/b.ts": "BAD line\n",
			"/abs/c.ts": "ok\nBAD\nBAD again\n",
		};
		const out = scanFilesForDetector({
			detector: badLineDetector,
			files: ["/abs/a.ts", "/abs/b.ts", "/abs/c.ts"],
			readFile: (p) => nonNull(contents[p]),
		});
		expect(out).toHaveLength(3);
		const files = out.map((f) => f.file);
		expect(files).toContain("/abs/b.ts");
		expect(files).toContain("/abs/c.ts");
		expect(files).not.toContain("/abs/a.ts");
	});

	it("logs to stderr and skips files that are unreadable (does not throw)", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const out = scanFilesForDetector({
				detector: badLineDetector,
				files: ["/abs/missing.ts", "/abs/exists.ts"],
				readFile: (p) => {
					if (p === "/abs/missing.ts") {
						throw new Error("ENOENT: no such file");
					}
					return "BAD line\n";
				},
			});
			// The exists.ts hit must come through; missing.ts must be skipped.
			expect(out).toHaveLength(1);
			expect(nonNull(out[0]).file).toBe("/abs/exists.ts");
			// And the failure must have been logged.
			expect(stderrWrites.some((s) => s.includes("missing.ts"))).toBe(true);
			expect(stderrWrites.some((s) => s.includes("ENOENT"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});

	it("isolates a misbehaving detector — one file's throw doesn't break the batch", () => {
		const stderrWrites: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrWrites.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const out = scanFilesForDetector({
				detector: (file, content) => {
					if (file === "/abs/blowup.ts") {
						throw new Error("detector bug");
					}
					return badLineDetector(file, content);
				},
				files: ["/abs/blowup.ts", "/abs/ok.ts"],
				readFile: () => "BAD line\n",
			});
			// The blowup is swallowed; ok.ts still produces a finding.
			expect(out).toHaveLength(1);
			expect(nonNull(out[0]).file).toBe("/abs/ok.ts");
			expect(stderrWrites.some((s) => s.includes("blowup.ts"))).toBe(true);
		} finally {
			process.stderr.write = origWrite;
		}
	});
});

describe("scanCIFilesForRecurrences", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-ci-scan-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fixture(relPath: string, content: string): void {
		const abs = join(dir, relPath);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}

	it("flags a destructive workflow run: step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
		const hit = findings.find((f) => f.check_id === "builtin-rm-rf-root");
		expect(hit?.file).toBe(".github/workflows/ci.yml");
	});

	it("flags a destructive Dockerfile RUN", () => {
		fixture("Dockerfile", ["FROM node:20", "RUN rm -rf /etc"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
	});

	it("flags a destructive Makefile recipe (force push)", () => {
		fixture("Makefile", ["deploy:", "\tgit push --force origin main"].join("\n"));
		const findings = scanCIFilesForRecurrences(dir);
		expect(findings.some((f) => f.check_id === "builtin-git-force-push")).toBe(true);
	});

	it("does not flag a benign workflow step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: npm ci && npm test"].join("\n"));
		expect(scanCIFilesForRecurrences(dir)).toEqual([]);
	});

	it("does not flag a quoted destructive mention inside a run step", () => {
		fixture(".github/workflows/ci.yml", ["steps:", '  - run: echo "rm -rf / is bad"'].join("\n"));
		expect(scanCIFilesForRecurrences(dir)).toEqual([]);
	});

	it("scanCodebaseForRecurrences includes CI findings by default", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCodebaseForRecurrences({ cwd: dir });
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(true);
	});

	it("scanCodebaseForRecurrences skips CI findings when includeCI is false", () => {
		fixture(".github/workflows/ci.yml", ["steps:", "  - run: rm -rf /"].join("\n"));
		const findings = scanCodebaseForRecurrences({ cwd: dir, includeCI: false });
		expect(findings.some((f) => f.check_id === "builtin-rm-rf-root")).toBe(false);
	});
});
