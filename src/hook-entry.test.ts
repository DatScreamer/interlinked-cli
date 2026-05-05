import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateUnifiedContext } from "./harness/evaluator-unified.js";
import { type SessionDaemonHandle, startSessionDaemon } from "./harness/session-daemon.js";
import type { DaemonPaths } from "./harness/session-paths.js";
import type { TsgoRunner } from "./harness/tsgo-runner.js";
import type { HarnessDecision, HarnessEvent } from "./harness/types.js";
import { discoverSocket, runHookEntry } from "./hook-entry.js";

let tmp = "";
let daemon: SessionDaemonHandle | null = null;
let legacyServer: Server | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-he-"));
	mkdirSync(join(tmp, ".interlinked"));
});
afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	if (legacyServer) {
		await new Promise<void>((resolve) => legacyServer?.close(() => resolve()));
		legacyServer = null;
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

function startLegacyHarnessServer(
	socketPath: string,
	decision: HarnessDecision,
	received: HarnessEvent[],
): Promise<void> {
	legacyServer = createServer((socket: Socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			const idx = buffer.indexOf("\n");
			if (idx === -1) return;
			received.push(JSON.parse(buffer.slice(0, idx)) as HarnessEvent);
			socket.write(`${JSON.stringify(decision)}\n`);
		});
	});
	return new Promise((resolve, reject) => {
		legacyServer?.once("error", reject);
		legacyServer?.listen(socketPath, () => resolve());
	});
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
		writeFileSync(join(tmp, ".interlinked", "harness-default.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "abc");
		expect(path?.endsWith("harness-abc.sock")).toBe(true);
	});

	it("uses the default framed socket before the legacy raw socket", () => {
		writeFileSync(join(tmp, ".interlinked", "harness-default.sock"), "");
		writeFileSync(join(tmp, ".interlinked", "harness.sock"), "");
		const path = discoverSocket(tmp, "no-match");
		expect(path?.endsWith("harness-default.sock")).toBe(true);
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

	it("uses raw JSON for legacy harness.sock and surfaces the real PreToolUse warning", async () => {
		const socketPath = join(tmp, ".interlinked", "harness.sock");
		const received: HarnessEvent[] = [];
		await startLegacyHarnessServer(
			socketPath,
			{ decision: "allow", warnings: ["[interlinked:test] visible warning"] },
			received,
		);

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "legacy",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});

		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
		expect(JSON.parse(result.stdout ?? "{}")).toEqual({
			hookSpecificOutput: {
				additionalContext: "[interlinked:test] visible warning",
			},
		});
		expect(received[0]).toMatchObject({
			hook_event: "PreToolUse",
			tool_name: "Edit",
			session_id: "legacy",
		});
		expect("id" in (received[0] ?? {})).toBe(false);
		expect("method" in (received[0] ?? {})).toBe(false);
	});

	it("honors INTERLINKED_HOOK_PROTOCOL=framed even when the socket is named harness.sock", async () => {
		const paths: DaemonPaths = {
			socket: join(tmp, ".interlinked", "harness.sock"),
			pid: join(tmp, ".interlinked", "harness-framed.pid"),
			log: join(tmp, ".interlinked", "logs", "daemon-framed.log"),
		};
		daemon = await startSessionDaemon({
			paths,
			session_id: "forced-framed",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "forced-framed",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
			},
			env: { INTERLINKED_HOOK_PROTOCOL: "framed" },
			runner: "claude-code",
			cwd: tmp,
			socketPath: paths.socket,
		});

		expect(result.fell_back).toBe(false);
		expect(result.exit_code).toBe(0);
	});

	it("honors INTERLINKED_HOOK_PROTOCOL=raw for a harness-*.sock path", async () => {
		const socketPath = join(tmp, ".interlinked", "harness-raw.sock");
		const received: HarnessEvent[] = [];
		await startLegacyHarnessServer(
			socketPath,
			{ decision: "allow", warnings: ["forced raw"] },
			received,
		);

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "forced-raw",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			},
			env: { INTERLINKED_HOOK_PROTOCOL: "raw" },
			runner: "claude-code",
			cwd: tmp,
			socketPath,
		});

		expect(result.fell_back).toBe(false);
		expect(received[0]?.hook_event).toBe("PreToolUse");
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
		// Cold fallback allows without putting transport failures in
		// model-visible PreToolUse additionalContext.
		expect(result.exit_code).toBe(0);
		expect(result.stdout).toBeUndefined();
		expect(result.stderr).toContain("evaluator skipped");
	});
});
