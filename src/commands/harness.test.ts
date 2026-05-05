import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectAncestorPids,
	harnessStartCommand,
	harnessStatusCommand,
	isHarnessRunning,
	readActiveHarnessPid,
	reapOrphanHarnesses,
} from "./harness.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("harness command module", () => {
	it("exports isHarnessRunning as a function", () => {
		expect(typeof isHarnessRunning).toBe("function");
	});

	it("exports harnessStartCommand as a function", () => {
		expect(typeof harnessStartCommand).toBe("function");
	});

	it("exports reapOrphanHarnesses as a function", () => {
		expect(typeof reapOrphanHarnesses).toBe("function");
	});

	it("exports collectAncestorPids as a function", () => {
		expect(typeof collectAncestorPids).toBe("function");
	});

	it("exports readActiveHarnessPid as a function", () => {
		expect(typeof readActiveHarnessPid).toBe("function");
	});
});

describe("harnessStatusCommand — enriched signals", () => {
	let workDir: string;
	let previousCwd: string;

	beforeEach(() => {
		workDir = join(
			tmpdir(),
			`harness-status-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		);
		mkdirSync(join(workDir, ".interlinked", "logs"), { recursive: true });
		previousCwd = process.cwd();
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(workDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("surfaces orphan_count, mode, and last_event_at in JSON output", async () => {
		// Arrange: shared config with a non-default mode
		writeFileSync(
			join(workDir, ".interlinked", "config.json"),
			JSON.stringify({ version: 1, server_url: "http://localhost:8787", mode: "ci" }),
		);
		// Latency log with two records — the most recent one's `ts` should win
		writeFileSync(
			join(workDir, ".interlinked", "logs", "latency.jsonl"),
			[
				JSON.stringify({ ts: "2026-04-01T00:00:00.000Z", hook_event: "PreToolUse" }),
				JSON.stringify({ ts: "2026-04-27T08:00:00.000Z", hook_event: "PostToolUse" }),
			].join("\n"),
		);
		writeFileSync(
			join(workDir, ".interlinked", "harness-protocol.json"),
			JSON.stringify({
				protocol: "dual",
				protocol_version: "1",
				started_at: "2026-04-27T07:59:00.000Z",
				raw_socket_path: join(workDir, ".interlinked", "harness.sock"),
				framed_socket_path: join(workDir, ".interlinked", "harness-default.sock"),
				framed_session_id: "default",
				last_raw_event_at: "2026-04-27T08:00:00.000Z",
				last_framed_event_at: "2026-04-27T08:00:01.000Z",
				raw_event_count: 1,
				framed_event_count: 2,
				framed_error_count: 0,
				framed_timeout_count: 0,
			}),
		);

		const captured: string[] = [];
		const realLog = console.log;
		console.log = (...args: unknown[]): void => {
			captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		};
		try {
			await harnessStatusCommand({ json: true });
		} finally {
			console.log = realLog;
		}
		const parsed = JSON.parse(captured.join("\n")) as {
			running: boolean;
			orphan_count: number;
			mode: string | null;
			last_event_at: string | null;
			protocol_status: { protocol: string; framed_event_count: number } | null;
		};
		expect(parsed.running).toBe(false);
		expect(parsed.mode).toBe("ci");
		expect(parsed.last_event_at).toBe("2026-04-27T08:00:00.000Z");
		expect(parsed.protocol_status?.protocol).toBe("dual");
		expect(parsed.protocol_status?.framed_event_count).toBe(2);
		expect(typeof parsed.orphan_count).toBe("number");
	});
});
