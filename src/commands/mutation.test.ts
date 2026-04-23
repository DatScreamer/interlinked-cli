import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
