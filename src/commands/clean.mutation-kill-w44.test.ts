import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { closeSync, ftruncateSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanCommand } from "./clean.js";

let tmpDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "clean-mutation-w44-"));
	process.chdir(tmpDir);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmpDir, { recursive: true, force: true });
	logSpy.mockRestore();
	vi.restoreAllMocks();
});

function lastLog(): string {
	const calls = logSpy.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return String(calls[calls.length - 1]?.[0]);
}

function lastJson(): any {
	return JSON.parse(lastLog());
}

// ---------------------------------------------------------------------------
// formatAge — "hours < 24" (mutantId 151eeff8d20f1e34)
// ---------------------------------------------------------------------------
describe("formatAge hours<24 boundary — positive (must fire)", () => {
	it("P1: an item stale by well over 24h but with a tiny post-threshold age reads in hours, not days", () => {
		const sessionsDir = path.join(tmpDir, ".interlinked", "hooks", "agent-sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const filePath = path.join(sessionsDir, "s1.json");
		writeFileSync(filePath, "{}");

		const FIXED_NOW = 2_000_000_000_000; // arbitrary fixed instant
		const mtimeMs = FIXED_NOW - 30 * 3600000; // 30h before FIXED_NOW: well past the 24h threshold
		utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));

		let call = 0;
		vi.spyOn(Date, "now").mockImplementation(() => {
			call += 1;
			// call #1: staleThreshold = Date.now() - 24h
			// call #2 (only for the matched file): ageMs = Date.now() - stat.mtimeMs
			return call === 1 ? FIXED_NOW : mtimeMs + 500; // ageMs = 500ms => hours = 0
		});

		cleanCommand({ json: true });
		const parsed = lastJson();
		expect(parsed.stale_items).toHaveLength(1);
		// orig: hours=0 < 24 -> "0h". mutant (hours<24 -> false): "0d".
		expect(parsed.stale_items[0].age).toBe("0h");
		expect(parsed.stale_items[0].age).not.toBe("0d");
	});
});

// ---------------------------------------------------------------------------
// scanStaleFilesInDir — "stat.mtimeMs < staleThreshold" boundary (mutantId 2e72ebbdf206682b)
// ---------------------------------------------------------------------------
describe("scanStaleFilesInDir equality boundary — positive (must fire)", () => {
	it("P1: a file exactly at the staleness threshold is NOT reported as stale", () => {
		const localSessionsDir = path.join(tmpDir, ".interlinked", "sessions");
		mkdirSync(localSessionsDir, { recursive: true });
		const filePath = path.join(localSessionsDir, "exact.json");
		writeFileSync(filePath, "{}");

		const FIXED_NOW = 3_000_000_000_000;
		const thresholdMs = FIXED_NOW - 24 * 3600000;
		utimesSync(filePath, new Date(thresholdMs), new Date(thresholdMs));

		vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);

		cleanCommand({ json: true });
		const parsed = lastJson();
		// orig: mtimeMs < staleThreshold is false at equality -> item excluded.
		// mutant (<=): item would be included.
		expect(parsed.total_found).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// checkAndTruncateActivityLog — "sizeMB > 50" boundary (mutantId 30b55dbe4d25f094)
// ---------------------------------------------------------------------------
describe("activity log size boundary — positive (must fire)", () => {
	it("P1: an activity log of exactly 50MB is not flagged as large", () => {
		const interlinkedDir = path.join(tmpDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		const activityPath = path.join(interlinkedDir, "activity.jsonl");
		const fd = openSync(activityPath, "w");
		ftruncateSync(fd, 50 * 1024 * 1024); // exactly 50MB
		closeSync(fd);

		cleanCommand({ json: true });
		const parsed = lastJson();
		// orig: 50 > 50 is false -> not flagged. mutant (>=50): flagged.
		const largeLogItems = parsed.stale_items.filter(
			(i: { type: string }) => i.type === "large_activity_log",
		);
		expect(largeLogItems).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// findOrphanedHookEntry — regex \s+ vs \s (mutantId 049c4a89d97020f7)
// ---------------------------------------------------------------------------
describe("orphaned hook script-path regex — positive (must fire)", () => {
	it("P1: multiple spaces between 'node' and the script path still resolve the script path", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const settingsPath = path.join(claudeDir, "settings.json");
		const missingScript = path.join(tmpDir, "does", "not", "exist", "interlinked-activity.mjs");
		writeFileSync(
			settingsPath,
			JSON.stringify({ hook: `node  ${missingScript}` }), // two spaces after "node"
		);
		expect(existsSync(missingScript)).toBe(false);

		cleanCommand({ json: true });
		const parsed = lastJson();
		const orphaned = parsed.stale_items.filter((i: { type: string }) => i.type === "orphaned_hook");
		// orig regex \s+ tolerates the double space and finds the missing script.
		// mutant regex \s (single) fails to match -> no orphaned_hook item.
		expect(orphaned).toHaveLength(1);
		expect(orphaned[0].detail).toContain(missingScript);
	});
});

// ---------------------------------------------------------------------------
// formatCleanSummaryLines — "orphanedHooksCount > 0" (mutantIds a553d9ee2cd566aa, b0a4d14a309ecdae)
// ---------------------------------------------------------------------------
describe("clean summary orphaned-hook count — positive (must fire)", () => {
	it("P1: --force with zero orphaned hooks prints no orphaned-hook nudge", () => {
		const sessionsDir = path.join(tmpDir, ".interlinked", "hooks", "agent-sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const filePath = path.join(sessionsDir, "old.json");
		writeFileSync(filePath, "{}");
		const oldTime = new Date(Date.now() - 48 * 3600000);
		utimesSync(filePath, oldTime, oldTime);
		// No .claude/.gemini/.codex settings files exist in tmpDir -> orphanedHooksCount is 0.

		cleanCommand({ force: true });
		const out = lastLog();
		// orig: orphanedHooksCount(0) > 0 is false -> no nudge line.
		// mutant (true, or >=0): nudge line prints even at zero.
		expect(out).not.toContain("orphaned hook(s) found");
	});
});

// ---------------------------------------------------------------------------
// Group-formatting functions + the group filters that feed them
// (mutantIds: c3e7c5770ffe71ae, d7436318f37a14a8, bc6c10fbd045faf7, 9b3ce79ca9bb2eea,
//  026c196ea4552dcb, e8e6556392c6e6f2, a1ab34ddb1e75ea1, 2050965d7abb4e26,
//  6cb6052f419570b8, a52eaad2bcc329a2, c59a78bb23d701b7, ac0a4cbdfd19b9c7,
//  d5e9580c10981ca1, eb17f26050fdf003)
// ---------------------------------------------------------------------------
describe("normal-mode group rendering — positive (must fire)", () => {
	it("P1: an orphaned-hook-only result shows only the orphaned-hook group, nothing else", () => {
		const claudeDir = path.join(tmpDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const settingsPath = path.join(claudeDir, "settings.json");
		const missingScript = path.join(tmpDir, "missing", "interlinked-activity.mjs");
		writeFileSync(settingsPath, JSON.stringify({ hook: `node ${missingScript}` }));

		cleanCommand({});
		const out = lastLog();

		// Real filters/early-returns for the OTHER groups must all stay empty:
		// mutating any of them (filter bypass, ===0->false, []->["Stryker was here"])
		// would leak a header or the marker string into this output.
		expect(out).not.toContain("Large activity log");
		expect(out).not.toContain("Stale hook session files");
		expect(out).not.toContain("Stale local sessions");
		expect(out).not.toContain("Stryker was here");
		// The orphaned-hook group itself IS present.
		expect(out).toContain("Orphaned hook entries");
	});

	it("P2: a session-file-only result shows only the session-file group, and orphaned-hook group is absent", () => {
		const sessionsDir = path.join(tmpDir, ".interlinked", "hooks", "agent-sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const filePath = path.join(sessionsDir, "old.json");
		writeFileSync(filePath, "{}");
		const oldTime = new Date(Date.now() - 48 * 3600000);
		utimesSync(filePath, oldTime, oldTime);

		cleanCommand({});
		const out = lastLog();

		expect(out).not.toContain("Orphaned hook entries");
		expect(out).not.toContain("Stryker was here");
		expect(out).toContain("Stale hook session files");
	});

	it("P3: the rendered output is genuinely multi-line (join separator is a real newline)", () => {
		const sessionsDir = path.join(tmpDir, ".interlinked", "hooks", "agent-sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const filePath = path.join(sessionsDir, "old.json");
		writeFileSync(filePath, "{}");
		const oldTime = new Date(Date.now() - 48 * 3600000);
		utimesSync(filePath, oldTime, oldTime);

		cleanCommand({});
		const out = lastLog();
		// orig: lines.join("\n") -> many lines. mutant ("\n"->""): everything on one line.
		const lineCount = out.split("\n").length;
		expect(lineCount).toBeGreaterThan(4);
		expect(out).toContain("Stale hook session files");
		expect(out.indexOf("Stale hook session files")).not.toBe(out.lastIndexOf("\n"));
	});
});
