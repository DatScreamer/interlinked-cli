// ===========================================
// disable command — behavioral coverage
// ===========================================
// Exercises every branch of disableCommand: configured vs not, per-client
// result rendering (removed / error / none), script + skill removal toggles,
// keep-config vs delete-config, and the removed-count summary fork.
//
// All module boundaries (../lib/config, ../lib/hooks, ../lib/settings,
// ../lib/skill-installers) are mocked so the test asserts real output strings
// and side-effect calls without touching the filesystem. The formatter is left
// real but neutralized via NO_COLOR so assertions match plain substrings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstallResult } from "../lib/hook-types.js";
import type { ClientName } from "../lib/settings.js";

// --- module boundary mocks ------------------------------------------------

vi.mock("../lib/config.js", () => ({
	getConfigDir: vi.fn(),
	isConfigured: vi.fn(),
}));

vi.mock("../lib/hooks.js", () => ({
	deleteConfigDir: vi.fn(),
	deleteHookScript: vi.fn(),
	uninstallAllHooks: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
	detectClients: vi.fn(),
}));

vi.mock("../lib/skill-installers.js", () => ({
	uninstallEnforceSkill: vi.fn(),
}));

import { getConfigDir, isConfigured } from "../lib/config.js";
import { stripAnsi } from "../lib/formatter.js";
import { deleteConfigDir, deleteHookScript, uninstallAllHooks } from "../lib/hooks.js";
import { detectClients } from "../lib/settings.js";
import { uninstallEnforceSkill } from "../lib/skill-installers.js";
import { disableCommand } from "./disable.js";

// --- helpers --------------------------------------------------------------

const CWD = "/fake/project";

function result(client: ClientName, over: Partial<InstallResult> = {}): InstallResult {
	return { client, installed: false, events: [], ...over };
}

/**
 * Concatenate every console.log argument into one searchable blob.
 * ANSI is stripped (the formatter's color state is fixed at module load, so we
 * normalize at read time instead of trying to flip NO_COLOR after the fact).
 */
function logged(spy: ReturnType<typeof vi.spyOn>): string {
	const calls = spy.mock.calls as unknown[][];
	return stripAnsi(calls.map((args) => args.join(" ")).join("\n"));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(CWD);

	// Conservative defaults; individual tests override.
	vi.mocked(detectClients).mockReturnValue([]);
	vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
	vi.mocked(isConfigured).mockReturnValue(true);
	vi.mocked(uninstallAllHooks).mockReturnValue([]);
	vi.mocked(deleteHookScript).mockReturnValue(false);
	vi.mocked(deleteConfigDir).mockReturnValue(false);
	vi.mocked(uninstallEnforceSkill).mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const ALL_CLIENTS: ClientName[] = ["claude", "copilot", "gemini", "codex", "cursor"];

// --------------------------------------------------------------------------

describe("disableCommand", () => {
	it("always prints the header banner and probes the right cwd", async () => {
		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Interlinked CLI — Disable Hook Management");
		expect(out).toContain("Removing hooks:");
		// Detection + uninstall + skill removal all keyed off the same cwd.
		expect(vi.mocked(detectClients)).toHaveBeenCalledWith(CWD);
		expect(vi.mocked(uninstallAllHooks)).toHaveBeenCalledWith(CWD, ALL_CLIENTS);
		expect(vi.mocked(uninstallEnforceSkill)).toHaveBeenCalledWith(CWD, ALL_CLIENTS);
	});

	it("warns when not configured but still proceeds to remove hooks", async () => {
		vi.mocked(isConfigured).mockReturnValue(false);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Not enabled.");
		expect(out).toContain("No .interlinked/ config found.");
		expect(out).toContain("Checking for hooks to remove anyway");
		// Removal still attempted despite no config.
		expect(vi.mocked(uninstallAllHooks)).toHaveBeenCalledOnce();
	});

	it("does NOT print the not-enabled notice when configured", async () => {
		vi.mocked(isConfigured).mockReturnValue(true);

		await disableCommand({});

		expect(logged(logSpy)).not.toContain("Not enabled.");
	});

	it("renders a removed line per client and counts toward the summary", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			result("claude", { events: ["PreToolUse", "PostToolUse"] }),
			result("codex", { events: ["PreToolUse"] }),
		]);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("claude — removed 2 hook event(s)");
		expect(out).toContain("codex — removed 1 hook event(s)");
		// Two clients had removals.
		expect(out).toContain("Removed hooks from 2 client(s).");
	});

	it("renders an error line for a client that failed to uninstall", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			result("gemini", { error: "permission denied" }),
		]);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("gemini — permission denied");
		// An error result is not a removal, so summary stays at the no-op branch.
		expect(out).toContain("No hooks were found to remove.");
	});

	it("renders a no-hooks line for a client with neither events nor error", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([result("cursor")]);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("cursor — no hooks found");
		expect(out).toContain("No hooks were found to remove.");
	});

	it("handles a mix of removed / error / none in one run", async () => {
		vi.mocked(uninstallAllHooks).mockReturnValue([
			result("claude", { events: ["PreToolUse"] }),
			result("copilot", { error: "boom" }),
			result("gemini"),
		]);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("claude — removed 1 hook event(s)");
		expect(out).toContain("copilot — boom");
		expect(out).toContain("gemini — no hooks found");
		// Only one client actually had removals.
		expect(out).toContain("Removed hooks from 1 client(s).");
	});

	it("announces hook-script deletion when the script existed", async () => {
		vi.mocked(deleteHookScript).mockReturnValue(true);

		await disableCommand({});

		expect(logged(logSpy)).toContain("Deleted hook script");
	});

	it("stays silent about the script when none was deleted", async () => {
		vi.mocked(deleteHookScript).mockReturnValue(false);

		await disableCommand({});

		expect(logged(logSpy)).not.toContain("Deleted hook script");
	});

	it("announces /enforce skill removal across all clients when it changed", async () => {
		vi.mocked(uninstallEnforceSkill).mockReturnValue(true);

		await disableCommand({});

		const out = logged(logSpy);
		expect(out).toContain("Removed /enforce skill from");
		expect(out).toContain(ALL_CLIENTS.join(", "));
	});

	it("stays silent about the skill when nothing changed", async () => {
		vi.mocked(uninstallEnforceSkill).mockReturnValue(false);

		await disableCommand({});

		expect(logged(logSpy)).not.toContain("Removed /enforce skill");
	});

	it("deletes the config dir by default and prints a repo-relative path", async () => {
		vi.mocked(getConfigDir).mockReturnValue(`${CWD}/.interlinked`);
		vi.mocked(deleteConfigDir).mockReturnValue(true);

		await disableCommand({});

		const out = logged(logSpy);
		expect(vi.mocked(deleteConfigDir)).toHaveBeenCalledWith(CWD);
		// cwd prefix stripped → ".interlinked/"
		expect(out).toContain("Deleted .interlinked/");
		expect(out).not.toContain("Kept");
		// Default (delete) path prints the re-enable tip without "Config preserved".
		expect(out).toContain("Run 'interlinked enable' to re-enable.");
		expect(out).not.toContain("Config preserved.");
	});

	it("does not print a deletion line when the config dir was absent", async () => {
		vi.mocked(deleteConfigDir).mockReturnValue(false);

		await disableCommand({});

		const out = logged(logSpy);
		expect(vi.mocked(deleteConfigDir)).toHaveBeenCalledWith(CWD);
		expect(out).not.toContain("Deleted .interlinked/");
	});

	it("keeps the config dir and prints the preserved messaging with --keep-config", async () => {
		await disableCommand({ keepConfig: true });

		const out = logged(logSpy);
		// deleteConfigDir / getConfigDir must NOT be touched on the keep path.
		expect(vi.mocked(deleteConfigDir)).not.toHaveBeenCalled();
		expect(vi.mocked(getConfigDir)).not.toHaveBeenCalled();
		expect(out).toContain("Kept");
		expect(out).toContain("(--keep-config)");
		expect(out).toContain("Config preserved. Run 'interlinked enable' to re-install hooks.");
		// The delete-path re-enable tip must not appear on the keep path.
		expect(out).not.toContain("Run 'interlinked enable' to re-enable.");
	});

	it("always prints the no-longer-captured footer", async () => {
		await disableCommand({});

		expect(logged(logSpy)).toContain("Agent activity will no longer be captured.");
	});

	it("uses process.cwd() as the working directory", async () => {
		await disableCommand({});

		expect(cwdSpy).toHaveBeenCalled();
	});
});
