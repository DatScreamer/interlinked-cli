import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateUnifiedContext } from "./harness/evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./harness/session-daemon.js";
import type { DaemonPaths } from "./harness/session-paths.js";
import type { TsgoRunner } from "./harness/tsgo-runner.js";
import { discoverSocket, runHookEntry } from "./hook-entry.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-he-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePaths(id: string): DaemonPaths {
	return {
		socket: join(tmp, ".interlinked", `harness-${id}.sock`),
		pid: join(tmp, ".interlinked", `harness-${id}.pid`),
		log: join(tmp, ".interlinked", "logs", `daemon-${id}.log`),
	};
}

function makeTsgo(): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
	};
}

function makeEvaluatorContext(): EvaluateUnifiedContext {
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

describe("discoverSocket", () => {
	it("returns null when no .interlinked dir exists", () => {
		const empty = mkdtempSync(join(tmpdir(), "interlinked-empty-"));
		try {
			expect(discoverSocket(empty, "any")).toBeNull();
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("prefers per-session sockets", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-abc.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "abc");
		expect(path?.endsWith("harness-abc.sock")).toBe(true);
	});

	it("falls back to legacy socket", () => {
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "no-match");
		expect(path?.endsWith("harness.sock")).toBe(true);
	});

	it("returns null when no socket files exist", () => {
		expect(discoverSocket(tmp, "any")).toBeNull();
	});
});

describe("runHookEntry — adapter resolution", () => {
	it("returns a helpful stderr when no runner is detected", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {},
			env: {},
		});
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("no runner detected");
	});

	it("resolves an explicit runner id", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "s",
				cwd: tmp,
				tool_name: "Read",
				tool_input: {},
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		// No daemon running → cold fallback to allow.
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
	});
});

describe("runHookEntry — end-to-end with real daemon", () => {
	it("round-trips a PreToolUse event through the daemon", async () => {
		const paths = makePaths("he1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "he1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "he1",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: paths.socket,
		});
		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
	});
});

describe("runHookEntry — cold fallback on daemon absence", () => {
	it("never blocks when socket is missing", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "none",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "/x", old_string: "a", new_string: "b" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: join(tmp, "nope.sock"),
		});
		expect(result.fell_back).toBe(true);
		// Adapter encodes allow-with-warning → exit 0 + warning on stderr.
		expect(result.exit_code).toBe(0);
	});
});
