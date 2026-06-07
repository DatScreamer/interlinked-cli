import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as checkPolicy from "../harness/check-policy.js";
import { mutationBaselineCommand, mutationCheckCommand } from "./mutation.js";

function captureIO(): {
	mocks: () => { stdout: string; stderr: string; exitCode: string | number | undefined };
	restore: () => void;
} {
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

function writeStrykerReport(
	cwd: string,
	perFile: Record<string, { killed: number; survived: number }>,
): void {
	mkdirSync(join(cwd, "reports", "mutation"), { recursive: true });
	const files: Record<string, unknown> = {};
	for (const [path, stats] of Object.entries(perFile)) {
		const mutants: Array<{ status: string }> = [];
		for (let i = 0; i < stats.killed; i++) mutants.push({ status: "Killed" });
		for (let i = 0; i < stats.survived; i++) mutants.push({ status: "Survived" });
		files[path] = { mutants };
	}
	writeFileSync(join(cwd, "reports", "mutation", "mutation.json"), JSON.stringify({ files }));
}

describe("mutationCheckCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-cli-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("exits with guidance when no report is present", async () => {
		await mutationCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});

	it("writes the baseline when --update-baseline is set", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBeFalsy();
		const saved = JSON.parse(
			readFileSync(join(tmp, ".interlinked", "mutation-baseline.json"), "utf-8"),
		);
		expect(saved.files["src/foo.ts"].score).toBeCloseTo(0.9);
	});

	it("flags scores below the --min-score floor as warnings", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "0.8" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_below_floor"),
		).toBe(true);
	});

	it("emits an error finding on score regression and exits non-zero", async () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.9, killed: 9 } },
			}),
		);
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 7, survived: 3 } });
		await mutationCheckCommand({ cwd: tmp, json: true });
		expect(io.mocks().exitCode).toBe(1);
		const parsed = JSON.parse(io.mocks().stdout);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_decrease"),
		).toBe(true);
	});

	it("clamps out-of-range --min-score values", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "5" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(1);
	});

	it("restricts evaluation to --changed-files", async () => {
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 0, survived: 10 },
			"src/bar.ts": { killed: 0, survived: 10 },
		});
		await mutationCheckCommand({
			cwd: tmp,
			json: true,
			changedFiles: "src/foo.ts",
		});
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.stats.files_checked).toBe(1);
		expect(parsed.findings.every((f: { file: string }) => f.file === "src/foo.ts")).toBe(true);
	});

	it("reports a parse failure when the report file is not a valid report object", async () => {
		// resolveReportPath finds the file (it exists), but loadMutationReport
		// returns null because the parsed JSON is a bare string, not an object.
		mkdirSync(join(tmp, "reports", "mutation"), { recursive: true });
		writeFileSync(
			join(tmp, "reports", "mutation", "mutation.json"),
			JSON.stringify("not-a-report"),
		);
		await mutationCheckCommand({ cwd: tmp });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("Failed to parse mutation report");
		expect(io.mocks().stderr).toContain("mutation.json");
	});

	it("resolves an explicit --report path that exists", async () => {
		// Place the report at a non-default location to prove --report is used.
		mkdirSync(join(tmp, "custom"), { recursive: true });
		writeFileSync(
			join(tmp, "custom", "mut.json"),
			JSON.stringify({ files: { "src/foo.ts": { killed: 9, survived: 1 } } }),
		);
		await mutationCheckCommand({ cwd: tmp, json: true, report: "custom/mut.json" });
		expect(io.mocks().exitCode).toBeFalsy();
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.report).toContain(join("custom", "mut.json"));
		expect(parsed.stats.files_checked).toBe(1);
	});

	it("errors when an explicit --report path does not exist", async () => {
		await mutationCheckCommand({ cwd: tmp, report: "does/not/exist.json" });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});

	it("treats a non-finite --min-score as the 0.6 default floor", async () => {
		// killed=5/survived=5 → 50% score: below 0.6 (fires) but not below a
		// hypothetical lower clamp, so the floor we land on must be 0.6.
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 5, survived: 5 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "not-a-number" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(0.6);
		expect(
			parsed.findings.some((f: { name: string }) => f.name === "mutation_score_below_floor"),
		).toBe(true);
	});

	it("clamps a negative --min-score up to 0 (no floor findings)", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 0, survived: 10 } });
		await mutationCheckCommand({ cwd: tmp, json: true, minScore: "-3" });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.min_score).toBe(0);
		// With a floor of 0, even a 0% score is not "below floor".
		expect(parsed.findings).toHaveLength(0);
	});

	it("renders the human-readable gate with no regressions", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBeFalsy();
		expect(out).toContain("Mutation Gate");
		expect(out).toContain("Min score");
		expect(out).toContain("Files checked");
		expect(out).toContain("No mutation regressions");
	});

	it("renders regression errors and below-floor warnings in normal mode", async () => {
		// Baseline: foo at 90%. Current run drops foo to 40% (both a regression
		// AND below the 60% floor) and adds a brand-new bar at 20% (below-floor
		// only, no prior baseline → no regression).
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.9, killed: 9 } },
			}),
		);
		writeStrykerReport(tmp, {
			"src/foo.ts": { killed: 4, survived: 6 },
			"src/bar.ts": { killed: 2, survived: 8 },
		});
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBe(1);
		expect(out).toContain("regression(s):");
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("90.0% → 40.0%");
		expect(out).toContain("below floor:");
		expect(out).toContain("src/bar.ts");
		expect(out).toContain("20.0%");
		expect(out).toContain("--update-baseline to accept");
	});

	it("renders only the regression block when nothing is below floor", async () => {
		// Baseline foo at 95%; current foo drops to 70% — a regression, but 70%
		// is still above the 60% floor, so there are errors and no warnings.
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { score: 0.95, killed: 19 } },
			}),
		);
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 7, survived: 3 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(io.mocks().exitCode).toBe(1);
		expect(out).toContain("regression(s):");
		expect(out).toContain("95.0% → 70.0%");
		// No file was below the floor, so the warning block must be absent.
		expect(out).not.toContain("below floor:");
	});

	it("renders only the below-floor block for a new low-scoring file", async () => {
		// Brand-new file (no baseline) at 40% → a below-floor warning and, since
		// there is no prior score, no regression error.
		writeStrykerReport(tmp, { "src/fresh.ts": { killed: 4, survived: 6 } });
		await mutationCheckCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		// New-file-only below floor is a warning, not an error → exit stays clean.
		expect(io.mocks().exitCode).toBeFalsy();
		expect(out).toContain("below floor:");
		expect(out).toContain("src/fresh.ts");
		expect(out).toContain("40.0%");
		// No regression occurred, so the error block must be absent.
		expect(out).not.toContain("regression(s):");
	});

	it("surfaces a non-Error throw via String() in the catch path", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		// Force a thrown primitive (not an Error instance) from inside the try
		// block to exercise the `String(err)` ternary arm.
		// Deliberately reject with a non-Error primitive so the command's
		// `err instanceof Error ? err.message : String(err)` lands on String(err).
		const nonError: unknown = "policy-load-exploded";
		const spy = vi
			.spyOn(checkPolicy, "loadCheckPolicy")
			.mockImplementation((): never => {
				throw nonError;
			});
		try {
			await mutationCheckCommand({ cwd: tmp });
		} finally {
			spy.mockRestore();
		}
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("policy-load-exploded");
	});

	it("surfaces an Error thrown while persisting the baseline", async () => {
		writeStrykerReport(tmp, { "src/foo.ts": { killed: 9, survived: 1 } });
		// Make `.interlinked` a FILE so saveMutationBaseline's mkdirSync on that
		// path throws an Error, caught and reported by the command.
		writeFileSync(join(tmp, ".interlinked"), "i am a file, not a directory");
		await mutationCheckCommand({ cwd: tmp, updateBaseline: true });
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr.toLowerCase()).toContain("error");
	});

	it("defaults cwd to process.cwd() when no --cwd is passed", async () => {
		// Drive the `opts.cwd || process.cwd()` fallback. From an empty working
		// directory there is no report, so we land on the guidance path.
		const orig = process.cwd();
		process.chdir(tmp);
		try {
			await mutationCheckCommand({});
		} finally {
			process.chdir(orig);
		}
		expect(io.mocks().exitCode).toBe(1);
		expect(io.mocks().stderr).toContain("No mutation report found");
	});
});

describe("mutationBaselineCommand", () => {
	let tmp: string;
	let io: ReturnType<typeof captureIO>;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mut-base-"));
		io = captureIO();
	});

	afterEach(() => {
		io.restore();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("prints an empty baseline hint when no file exists", () => {
		mutationBaselineCommand({ cwd: tmp });
		expect(io.mocks().stdout).toContain("no baseline yet");
	});

	it("emits JSON payload when --json is set", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22",
				files: { "src/foo.ts": { score: 0.9, killed: 27 } },
			}),
		);
		mutationBaselineCommand({ cwd: tmp, json: true });
		const parsed = JSON.parse(io.mocks().stdout);
		expect(parsed.files["src/foo.ts"].score).toBe(0.9);
	});

	it("renders per-file rows sorted ascending by score in normal mode", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-05-01",
				files: {
					"src/high.ts": { score: 0.95, killed: 19 },
					"src/low.ts": { score: 0.4, killed: 4 },
				},
			}),
		);
		mutationBaselineCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		expect(out).toContain("Mutation Baseline");
		expect(out).toContain("Updated");
		expect(out).toContain("Files");
		// Both files rendered with formatted score + kill count.
		expect(out).toContain("src/high.ts");
		expect(out).toContain("score=95.0% killed=19");
		expect(out).toContain("src/low.ts");
		expect(out).toContain("score=40.0% killed=4");
		// Ascending by score: low.ts (40%) must appear before high.ts (95%).
		expect(out.indexOf("src/low.ts")).toBeLessThan(out.indexOf("src/high.ts"));
		// No overflow line when there are <= 25 files.
		expect(out).not.toContain("more");
	});

	it("defaults cwd to process.cwd() when no --cwd is passed", () => {
		// Drive the `opts.cwd || process.cwd()` fallback for the baseline command.
		const orig = process.cwd();
		process.chdir(tmp);
		try {
			mutationBaselineCommand({});
		} finally {
			process.chdir(orig);
		}
		// Empty working dir → no baseline file → the empty-baseline hint.
		expect(io.mocks().stdout).toContain("no baseline yet");
	});

	it("truncates to 25 rows and prints an overflow line for larger baselines", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		const files: Record<string, { score: number; killed: number }> = {};
		for (let i = 0; i < 30; i++) {
			// Distinct ascending scores so ordering and truncation are deterministic.
			files[`src/file-${String(i).padStart(2, "0")}.ts`] = {
				score: i / 100,
				killed: i,
			};
		}
		writeFileSync(
			join(tmp, ".interlinked", "mutation-baseline.json"),
			JSON.stringify({ version: 1, updated_at: "2026-05-02", files }),
		);
		mutationBaselineCommand({ cwd: tmp });
		const out = io.mocks().stdout;
		// 30 files, capped at 25 rows → 5 hidden.
		expect(out).toContain("Files");
		expect(out).toContain("… and 5 more");
		// Lowest-scoring file is shown; a file beyond the 25-row window is not.
		expect(out).toContain("src/file-00.ts");
		expect(out).not.toContain("src/file-29.ts");
	});
});
