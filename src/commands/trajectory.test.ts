import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	trajectoryListCommand,
	trajectoryReplayCommand,
	trajectoryShowCommand,
} from "./trajectory.js";

describe("trajectory commands", () => {
	let dir: string;
	let consoleLogs: string[];
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trajectory-cmd-"));
		consoleLogs = [];
		logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
			consoleLogs.push(typeof msg === "string" ? msg : JSON.stringify(msg));
		});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		logSpy.mockRestore();
		errSpy.mockRestore();
	});

	describe("list", () => {
		it("reports zero snapshots when the sessions dir is empty", async () => {
			await trajectoryListCommand({ cwd: dir });
			expect(consoleLogs.join("\n")).toMatch(/no trajector/i);
		});

		it("lists sessions present on disk", async () => {
			const sessDir = join(dir, ".interlinked", "sessions");
			mkdirSync(sessDir, { recursive: true });
			writeFileSync(
				join(sessDir, "abc.trajectory.json"),
				JSON.stringify({ session_id: "abc", agent_name: "tester" }),
				"utf-8",
			);
			await trajectoryListCommand({ cwd: dir });
			expect(consoleLogs.join("\n")).toContain("abc");
		});

		it("emits valid JSON with --json and empty dir", async () => {
			await trajectoryListCommand({ cwd: dir, json: true });
			const joined = consoleLogs.join("\n").trim();
			expect(() => JSON.parse(joined)).not.toThrow();
		});
	});

	describe("show", () => {
		it("errors with a clear message when the session is not on disk", async () => {
			await expect(
				trajectoryShowCommand({ session: "nonexistent", cwd: dir }),
			).rejects.toThrow(/nonexistent|no trajectory/i);
		});

		it("loads and prints a known snapshot", async () => {
			const sessDir = join(dir, ".interlinked", "sessions");
			mkdirSync(sessDir, { recursive: true });
			writeFileSync(
				join(sessDir, "xyz.trajectory.json"),
				JSON.stringify({ session_id: "xyz", agent_name: "tester", tool_call_count: 7 }),
				"utf-8",
			);
			await trajectoryShowCommand({ session: "xyz", cwd: dir });
			const joined = consoleLogs.join("\n");
			expect(joined).toContain("xyz");
			expect(joined).toContain("tool_call_count");
		});
	});

	describe("replay", () => {
		it("errors when the events file does not exist", async () => {
			await expect(
				trajectoryReplayCommand({ file: join(dir, "missing.jsonl"), cwd: dir }),
			).rejects.toThrow();
		});

		it("processes an events JSONL and emits no findings when no detectors are default-enabled", async () => {
			const eventsPath = join(dir, "events.jsonl");
			const lines = [
				JSON.stringify({
					hook_event: "PreToolUse",
					session_id: "s",
					agent_source: "claude",
					timestamp: "2026-05-27T00:00:00Z",
					tool_name: "Read",
					tool_input: { file_path: "src/foo.ts" },
				}),
				JSON.stringify({
					hook_event: "PreToolUse",
					session_id: "s",
					agent_source: "claude",
					timestamp: "2026-05-27T00:00:01Z",
					tool_name: "Bash",
					tool_input: { command: "ls" },
				}),
			];
			writeFileSync(eventsPath, `${lines.join("\n")}\n`, "utf-8");
			await trajectoryReplayCommand({ file: eventsPath, cwd: dir, json: true });
			const out = consoleLogs.join("\n").trim();
			const parsed = JSON.parse(out);
			expect(parsed.events_replayed).toBe(2);
			expect(parsed.findings).toEqual([]);
		});
	});
});
