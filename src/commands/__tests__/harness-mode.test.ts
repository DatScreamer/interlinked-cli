// End-to-end tests for `interlinked harness mode [name]` — exercise the
// filesystem side effects (config.json write + .mjs hook regeneration) by
// pointing INTERLINKED_HOME at a fresh tmp dir per test. The command module
// reads / writes config through getConfigDir(), which honors that env var.
//
// We stub `process.stdout.write` / `process.stderr.write` directly instead
// of using `vi.spyOn` because vitest's spy machinery does not reliably
// intercept the multi-overload write signature on Node's WriteStream.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessModeCommand } from "../harness-mode.js";

let workDir: string;
let previousInterlinkedHome: string | undefined;
let previousCwd: string;

beforeEach(() => {
	workDir = join(
		tmpdir(),
		`harness-mode-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(workDir, { recursive: true });
	mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	previousInterlinkedHome = process.env.INTERLINKED_HOME;
	process.env.INTERLINKED_HOME = join(workDir, ".interlinked");
	previousCwd = process.cwd();
	process.chdir(workDir);
});

afterEach(() => {
	process.chdir(previousCwd);
	if (previousInterlinkedHome === undefined) {
		delete process.env.INTERLINKED_HOME;
	} else {
		process.env.INTERLINKED_HOME = previousInterlinkedHome;
	}
	rmSync(workDir, { recursive: true, force: true });
});

function readSharedConfig(): Record<string, unknown> {
	const path = join(workDir, ".interlinked", "config.json");
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function writeSharedConfigFile(data: Record<string, unknown>): void {
	const path = join(workDir, ".interlinked", "config.json");
	writeFileSync(path, JSON.stringify(data, null, 4));
}

function readGeneratedHook(): string | null {
	const path = join(workDir, ".interlinked", "hooks", "interlinked-activity.mjs");
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

interface CapturedStdio {
	stdout: string;
	stderr: string;
}

/** Direct stub replacement for process.stdout.write / process.stderr.write
 *  so the test runner reliably sees what the command emits. vi.spyOn does
 *  not consistently intercept the (chunk: string|Uint8Array) overload on
 *  Node's WriteStream — we observed empty `mock.calls` arrays during
 *  initial development, hence this manual installer. */
async function captureStdio(fn: () => Promise<void>): Promise<CapturedStdio> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdoutWrite = process.stdout.write.bind(process.stdout);
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdoutChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		);
		return true;
	}) as typeof process.stderr.write;
	try {
		await fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
	}
	return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

describe("harness mode — show current", () => {
	it("prints the default mode (`quality`) when nothing is configured", async () => {
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = JSON.parse(captured.stdout) as { mode: string };
		expect(parsed.mode).toBe("quality");
	});

	it("prints the persisted mode when set", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "ci",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = JSON.parse(captured.stdout) as { mode: string };
		expect(parsed.mode).toBe("ci");
	});

	it("auto-migrates a legacy `balanced` value to `quality` on read", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "balanced",
		});
		const captured = await captureStdio(() =>
			harnessModeCommand(undefined, { json: true }),
		);
		const parsed = JSON.parse(captured.stdout) as { mode: string };
		expect(parsed.mode).toBe("quality");
	});
});

describe("harness mode — switch", () => {
	it("persists the new mode to .interlinked/config.json", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("budget");
	});

	it("creates config.json when missing, preserving the new mode", async () => {
		// No prior config.json; the command should create one.
		await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const config = readSharedConfig();
		expect(config.mode).toBe("ci");
		expect(config.version).toBe(1);
	});

	it("regenerates the hook .mjs with the new HARNESS_POST_TIMEOUT_MS literal", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("budget", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).not.toBeNull();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 30000");
	});

	it("regenerates the hook with 50_000 ms for `quality`", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("quality", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 50000");
	});

	it("regenerates the hook with 60_000 ms for `ci`", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
		});
		await captureStdio(() => harnessModeCommand("ci", { json: true }));
		const hook = readGeneratedHook();
		expect(hook).toContain("const HARNESS_POST_TIMEOUT_MS = 60000");
	});

	it("rejects unknown mode names with a useful error message", async () => {
		const previousExitCode = process.exitCode;
		const captured = await captureStdio(() =>
			harnessModeCommand("unknown_name", { json: false }),
		);
		const exitCode = process.exitCode;
		process.exitCode = previousExitCode;
		expect(captured.stderr).toMatch(/unknown harness mode/i);
		expect(captured.stderr).toContain("unknown_name");
		expect(exitCode).toBe(1);
	});

	it("rejects unknown mode names without writing the config", async () => {
		writeSharedConfigFile({
			version: 1,
			server_url: "http://localhost:8787",
			mode: "quality",
		});
		const previousExitCode = process.exitCode;
		await captureStdio(() => harnessModeCommand("super_secret", { json: false }));
		process.exitCode = previousExitCode;
		const config = readSharedConfig();
		// Mode unchanged — stays at quality
		expect(config.mode).toBe("quality");
	});
});
