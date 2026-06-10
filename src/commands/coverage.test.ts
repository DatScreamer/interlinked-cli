import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coverageBaselineCommand, coverageCheckCommand } from "./coverage.js";

interface Captured {
	stdout: string;
	stderr: string;
	exitCode: string | number | undefined;
}

function captureIO(): { mocks: () => Captured; restore: () => void } {
	let stdout = "";
	let stderr = "";
	const origExit = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		stdout += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
	});
	const rawStderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	return {
		mocks: () => ({ stdout, stderr, exitCode: process.exitCode }),
		restore: () => {
			logSpy.mockRestore();
			errSpy.mockRestore();
			rawStderrSpy.mockRestore();
			process.exitCode = origExit;
		},
	};
}

function writeCoverageSummary(
	cwd: string,
	data: Record<string, { lines: number; branches: number }>,
): void {
	mkdirSync(join(cwd, "coverage"), { recursive: true });
	const summary: Record<string, unknown> = {};
	for (const [path, { lines, branches }] of Object.entries(data)) {
		summary[path] = { lines: { pct: lines }, branches: { pct: branches } };
	}
	writeFileSync(join(cwd, "coverage", "coverage-summary.json"), JSON.stringify(summary));
}

/**
 * Write a minimal LCOV report at the canonical `coverage/lcov.info` path so the
 * `.info` dispatch arm of `loadReport` (LCOV → canonical → ratchet) is exercised
 * rather than the istanbul json-summary arm. One DA line is covered, one not, so
 * line coverage lands at 50%; one branch taken, one not, so branches land at 50%.
 */
function writeLcov(cwd: string, relSrc: string): void {
	mkdirSync(join(cwd, "coverage"), { recursive: true });
	const body = [
		`SF:${relSrc}`,
		"FN:1,fn",
		"FNDA:1,fn",
		"DA:1,1",
		"DA:2,0",
		"BRDA:1,0,0,1",
		"BRDA:1,0,1,-",
		"end_of_record",
		"",
	].join("\n");
	writeFileSync(join(cwd, "coverage", "lcov.info"), body);
}

describe("coverageCheckCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-cli-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exits with a clean message when no report is present", async () => {
		await coverageCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No coverage report found");
	});

	it("surfaces language-specific LCOV-generation guidance when no report exists", async () => {
		// Mark the temp project as Python so the guidance is tailored to it.
		writeFileSync(join(tmp, "pyproject.toml"), "[project]\nname='x'\n");
		await coverageCheckCommand({ cwd: tmp });
		const { stderr } = io.mocks();
		expect(stderr).toContain("coverage lcov");
		expect(stderr).toContain("--cov-context=test");
		// JS guidance must not leak into a Python-only project.
		expect(stderr).not.toContain("vitest");
	});

	it("accepts the current state as a new baseline when --update-baseline is set", async () => {
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const saved = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "coverage-baseline.json"), "utf-8"),
		);
		expect(saved.files["src/foo.ts"].lines_pct).toBe(80);
	});

	it("emits JSON payload with findings when --json is set and there's a regression", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
			}),
		);
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0].metric).toBe("lines");
		expect(parsed.findings[0].delta_pct).toBeLessThan(0);
	});

	it("honors --strict to upgrade warnings into non-zero exit", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
			}),
		);
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp, strict: true });
		expect(io.mocks().exitCode).toBe(1);
	});

	it("restricts evaluation to --changed-files when provided", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: {
					"src/foo.ts": { lines_pct: 90, branches_pct: 60 },
					"src/bar.ts": { lines_pct: 90, branches_pct: 60 },
				},
			}),
		);
		writeCoverageSummary(tmp, {
			"src/foo.ts": { lines: 50, branches: 50 },
			"src/bar.ts": { lines: 50, branches: 50 },
		});
		await coverageCheckCommand({ cwd: tmp, json: true, changedFiles: "src/foo.ts" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.findings.every((f: { file: string }) => f.file === "src/foo.ts")).toBe(true);
		expect(parsed.stats.files_checked).toBe(1);
	});

	it("reports a parse failure when a report exists at the default path but is malformed", async () => {
		// resolveReportPath finds it (exists), loadCoverageSummary returns null (JSON throws).
		mkdirSync(join(tmp, "coverage"), { recursive: true });
		writeFileSync(join(tmp, "coverage", "coverage-summary.json"), "{ this is not ] json");
		await coverageCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Failed to parse coverage report");
		expect(io.mocks().stderr).toContain("coverage-summary.json");
	});

	it("loads coverage from the canonical lcov.info via the LCOV → ratchet path", async () => {
		// lcov.info is first in DEFAULT_REPORT_PATHS, so it wins over json-summary.
		writeLcov(tmp, "src/foo.ts");
		await coverageCheckCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.report.endsWith("lcov.info")).toBe(true);
		expect(parsed.stats.files_checked).toBe(1);
		// First sighting of this file → counted as new, no regression.
		expect(parsed.stats.files_new).toBe(1);
		expect(parsed.findings).toHaveLength(0);
	});

	it("ratchets against a baseline using lcov.info-derived percentages", async () => {
		// LCOV fixture is 50% lines / 50% branches; baseline at 100% → a regression.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { lines_pct: 100, branches_pct: 100 } },
			}),
		);
		writeLcov(tmp, "src/foo.ts");
		await coverageCheckCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		const metrics = parsed.findings.map((f: { metric: string }) => f.metric).sort();
		expect(metrics).toEqual(["branches", "lines"]);
		expect(io.mocks().exitCode).toBeFalsy(); // warnings only, not strict
	});

	it("reports a parse failure when lcov.info exists but cannot be read", async () => {
		// A directory at the lcov.info path: existsSync passes, readFileSync throws,
		// loadLcovFile returns null → the `: null` arm of loadReport's LCOV branch.
		mkdirSync(join(tmp, "coverage", "lcov.info"), { recursive: true });
		await coverageCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Failed to parse coverage report");
		expect(io.mocks().stderr).toContain("lcov.info");
	});

	it("MERGES every existing per-language LCOV report (finding 2026-06: no clobbered language)", async () => {
		// Canonical report covers the TS file; the python adapter's per-language
		// report covers the PY file. Pre-fix only the first existing path was read,
		// so one language vanished from the ratchet.
		writeLcov(tmp, "src/foo.ts");
		const pyBody = ["SF:pkg/mod.py", "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n");
		writeFileSync(join(tmp, "coverage", "lcov-python.info"), pyBody);
		await coverageCheckCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.stats.files_checked).toBe(2); // BOTH languages' files
		expect(parsed.report).toContain("lcov.info");
		expect(parsed.report).toContain("lcov-python.info");
	});

	it("an explicit --report path stays a single-file read (user override, no merge)", async () => {
		writeLcov(tmp, "src/foo.ts");
		const pyBody = ["SF:pkg/mod.py", "DA:1,1", "end_of_record", ""].join("\n");
		writeFileSync(join(tmp, "coverage", "lcov-python.info"), pyBody);
		await coverageCheckCommand({
			cwd: tmp,
			report: "coverage/lcov-python.info",
			json: true,
		});
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.stats.files_checked).toBe(1); // only the named report
	});

	it("errors when an explicit --report path does not exist", async () => {
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		// Even though a default report exists, an explicit missing path short-circuits.
		await coverageCheckCommand({ cwd: tmp, report: "does/not/exist.json" });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No coverage report found");
	});

	it("uses an explicit --report path when it exists", async () => {
		mkdirSync(join(tmp, "custom"), { recursive: true });
		writeFileSync(
			join(tmp, "custom", "report.json"),
			JSON.stringify({ "src/only.ts": { lines: { pct: 91 }, branches: { pct: 73 } } }),
		);
		await coverageCheckCommand({ cwd: tmp, report: "custom/report.json", json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.report.endsWith(join("custom", "report.json"))).toBe(true);
		expect(parsed.stats.files_checked).toBe(1);
	});

	it("renders the normal (non-JSON) human summary with regressions", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
			}),
		);
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 70, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp });
		const { stdout } = io.mocks();
		expect(stdout).toContain("Coverage Ratchet");
		expect(stdout).toContain("Files checked");
		expect(stdout).toContain("regression");
		expect(stdout).toContain("src/foo.ts");
		expect(stdout).toContain("[lines]");
		expect(stdout).toContain("--update-baseline");
	});

	it("renders the clean normal summary when there are no regressions", async () => {
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp });
		const { stdout } = io.mocks();
		expect(stdout).toContain("No per-file coverage regressions");
		expect(io.mocks().exitCode).toBeFalsy();
	});

	it("does not print the stderr baseline-updated banner in JSON mode", async () => {
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp, updateBaseline: true, json: true });
		const { stdout, stderr } = io.mocks();
		// Baseline is still persisted...
		const saved = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "coverage-baseline.json"), "utf-8"),
		);
		expect(saved.files["src/foo.ts"].lines_pct).toBe(80);
		// ...but the human banner is suppressed under --json.
		expect(stderr).not.toContain("Baseline updated");
		// stdout is the JSON payload, not the banner.
		expect(() => JSON.parse(stdout)).not.toThrow();
	});

	it("prints the stderr baseline-updated banner in normal mode", async () => {
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await coverageCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().stderr).toContain("Baseline updated");
	});

	it("catches an Error thrown mid-run and surfaces its message", async () => {
		// `.interlinked` is a regular file, so saveBaseline's mkdirSync throws EEXIST
		// inside the try block → the catch arm renders `err.message`.
		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		writeFileSync(join(tmp, ".interlinked"), "not a directory");
		await coverageCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("EEXIST");
	});

	it("defaults cwd to process.cwd() when no cwd option is given", async () => {
		const orig = process.cwd();
		try {
			process.chdir(tmp);
			// Empty dir → no report; exercises `opts.cwd || process.cwd()`.
			await coverageCheckCommand({});
			expect(io.mocks().exitCode).toBe(1);
			expect(io.mocks().stderr).toContain("No coverage report found");
		} finally {
			process.chdir(orig);
		}
	});
});

describe("coverageBaselineCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-base-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("prints an empty baseline hint when no file exists", () => {
		coverageBaselineCommand({ cwd: tmp });
		expect(io.mocks().stdout).toContain("no baseline yet");
	});

	it("emits JSON payload when --json is set", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22T00:00:00Z",
				files: { "src/foo.ts": { lines_pct: 80, branches_pct: 60 } },
			}),
		);
		coverageBaselineCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.files["src/foo.ts"].lines_pct).toBe(80);
	});

	it("renders the normal baseline table with per-file rows", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22T00:00:00Z",
				files: {
					"src/zeta.ts": { lines_pct: 88.5, branches_pct: 70.25 },
					"src/alpha.ts": { lines_pct: 95, branches_pct: 80 },
				},
			}),
		);
		coverageBaselineCommand({ cwd: tmp });
		const { stdout } = io.mocks();
		expect(stdout).toContain("Coverage Baseline");
		expect(stdout).toContain("Files");
		expect(stdout).toContain("src/alpha.ts");
		expect(stdout).toContain("src/zeta.ts");
		// Percentages are rendered to one decimal place.
		expect(stdout).toContain("lines=88.5%");
		expect(stdout).toContain("branches=70.3%");
		// Sorted: alpha before zeta.
		expect(stdout.indexOf("src/alpha.ts")).toBeLessThan(stdout.indexOf("src/zeta.ts"));
		// No truncation footer for two files.
		expect(stdout).not.toContain("more");
	});

	it("truncates the baseline table to 25 rows and shows an overflow footer", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const files: Record<string, { lines_pct: number; branches_pct: number }> = {};
		for (let i = 0; i < 30; i++) {
			files[`src/f${String(i).padStart(2, "0")}.ts`] = {
				lines_pct: 50 + i,
				branches_pct: 40 + i,
			};
		}
		writeFileSync(
			join(tmp, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({ version: 1, updated_at: "2026-04-22T00:00:00Z", files }),
		);
		coverageBaselineCommand({ cwd: tmp });
		const { stdout } = io.mocks();
		expect(stdout).toContain("… and 5 more");
		// First (sorted) row shown, a row beyond the 25th cap is not.
		expect(stdout).toContain("src/f00.ts");
		expect(stdout).not.toContain("src/f29.ts");
	});

	it("defaults cwd to process.cwd() when no cwd option is given", () => {
		const orig = process.cwd();
		try {
			process.chdir(tmp);
			coverageBaselineCommand({});
			expect(io.mocks().stdout).toContain("no baseline yet");
		} finally {
			process.chdir(orig);
		}
	});
});

// The top-level catch in coverageCheckCommand stringifies non-Error throws via
// `String(err)`. No library on the happy path throws a bare value, so this arm
// is only reachable by forcing a dependency to throw a non-Error. We isolate a
// module-graph remock to one test (resetModules → doMock → dynamic import →
// unmock) so the rest of the suite keeps the real coverage-ratchet.
describe("coverageCheckCommand — non-Error rejection handling", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-nonerr-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		vi.doUnmock("../harness/coverage-ratchet.js");
		vi.resetModules();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("stringifies a non-Error thrown mid-run", async () => {
		vi.resetModules();
		vi.doMock("../harness/coverage-ratchet.js", async () => {
			const actual =
				await vi.importActual<typeof import("../harness/coverage-ratchet.js")>(
					"../harness/coverage-ratchet.js",
				);
			return {
				...actual,
				// Throw a bare string (not an Error) from inside the try block.
				saveBaseline: () => {
					throw "kaboom-non-error";
				},
			};
		});
		const { coverageCheckCommand: freshCommand } = await import("./coverage.js");

		writeCoverageSummary(tmp, { "src/foo.ts": { lines: 80, branches: 60 } });
		await freshCommand({ cwd: tmp, updateBaseline: true });

		expect(io.mocks().exitCode).toBe(1);
		// The bare-string throw flows through `String(err)`, not `err.message`.
		expect(io.mocks().stderr).toContain("kaboom-non-error");
	});
});
