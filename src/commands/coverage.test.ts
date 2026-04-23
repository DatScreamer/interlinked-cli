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
});
