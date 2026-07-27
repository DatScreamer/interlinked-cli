// interlinked reload — one-command dogfood loop (build → hook refresh → daemon).
// Pins the pure helpers (root discovery, build-identity hashing, restart
// decision) and the orchestration's delta-only behavior via module mocks.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	daemonIsStale,
	distBuildHash,
	findCliRoot,
	reloadCommand,
	shouldRestartDaemon,
} from "./reload.js";

// Mocks for the reloadCommand orchestration tests. The pure-helper describes
// above don't touch these modules, so the mocks are inert for them.
const { execFileSyncMock, harnessRestartMock, detectClientsMock, refreshClientSkillsMock } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	harnessRestartMock: vi.fn(),
	detectClientsMock: vi.fn(),
	refreshClientSkillsMock: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock("./harness.js", () => ({ harnessRestartCommand: harnessRestartMock }));
vi.mock("../lib/hooks.js", () => ({ writeHookScript: vi.fn(), installAllHooks: vi.fn() }));
vi.mock("../lib/settings.js", () => ({ detectClients: detectClientsMock }));
vi.mock("./skill-refresh.js", () => ({ refreshClientSkills: refreshClientSkillsMock }));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-reload-"));
	process.exitCode = 0;
	// Build is a no-op by default (return value is ignored); the restart mock
	// simulates the daemon's human "Harness started (PID …)" stdout line — the
	// exact line that must NOT leak into a --json run's stdout.
	execFileSyncMock.mockReset();
	harnessRestartMock.mockReset();
	harnessRestartMock.mockImplementation(async () => {
		console.log("Harness started (PID 99999)");
	});
	detectClientsMock.mockReset();
	detectClientsMock.mockReturnValue([]);
	refreshClientSkillsMock.mockReset();
	refreshClientSkillsMock.mockReturnValue({
		results: [],
		outputLines: [],
		summary: { clients: [], installed: 0, changed: 0, warnings: [] },
	});
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("findCliRoot", () => {
	it("walks up from a nested dir to the interlinked-cli package root", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "interlinked-cli" }));
		const nested = join(dir, "dist", "commands");
		mkdirSync(nested, { recursive: true });
		expect(findCliRoot(nested)).toBe(dir);
	});

	it("returns null when no interlinked-cli package.json is above the start dir", () => {
		const nested = join(dir, "some", "other", "project");
		mkdirSync(nested, { recursive: true });
		// A DIFFERENT package above must not be claimed as the CLI root.
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcp-chat" }));
		expect(findCliRoot(nested)).toBeNull();
	});

	it("ignores a malformed package.json instead of throwing", () => {
		writeFileSync(join(dir, "package.json"), "this is not json");
		const nested = join(dir, "x");
		mkdirSync(nested);
		expect(findCliRoot(nested)).toBeNull();
	});
});

describe("distBuildHash", () => {
	function seedDist(): void {
		mkdirSync(join(dir, "dist", "harness"), { recursive: true });
		writeFileSync(join(dir, "dist", "harness", "server.js"), "server-v1");
		writeFileSync(join(dir, "dist", "hook-entry.js"), "hook-v1");
	}

	it("is stable across calls for unchanged dist content", () => {
		seedDist();
		expect(distBuildHash(dir)).toBe(distBuildHash(dir));
		expect(distBuildHash(dir)).toMatch(/^[0-9a-f]{8}$/);
	});

	it("changes when either built artifact changes", () => {
		seedDist();
		const before = distBuildHash(dir);
		writeFileSync(join(dir, "dist", "harness", "server.js"), "server-v2");
		const afterServer = distBuildHash(dir);
		expect(afterServer).not.toBe(before);
		writeFileSync(join(dir, "dist", "hook-entry.js"), "hook-v2");
		expect(distBuildHash(dir)).not.toBe(afterServer);
	});

	it("reports 'absent' when the dist artifacts are missing (never built)", () => {
		expect(distBuildHash(dir)).toBe("absent");
	});
});

describe("shouldRestartDaemon", () => {
	const base = { buildChanged: false, hookChanged: false, force: false, daemonStale: false };
	it("restarts when the build changed", () => {
		expect(shouldRestartDaemon({ ...base, buildChanged: true })).toBe(true);
	});
	it("restarts when the hook script changed even with an unchanged build", () => {
		expect(shouldRestartDaemon({ ...base, hookChanged: true })).toBe(true);
	});
	it("skips the restart when nothing changed, daemon fresh, and no --force", () => {
		expect(shouldRestartDaemon(base)).toBe(false);
	});
	it("--force restarts even when nothing changed", () => {
		expect(shouldRestartDaemon({ ...base, force: true })).toBe(true);
	});
	it("restarts when the RUNNING daemon predates the current build (v2: out-of-band builds)", () => {
		expect(shouldRestartDaemon({ ...base, daemonStale: true })).toBe(true);
	});
});

describe("daemonIsStale", () => {
	it("stale when the daemon started before the current server artifact was built", () => {
		expect(daemonIsStale({ serverMtimeMs: 2_000, daemonStartMs: 1_000 })).toBe(true);
	});
	it("fresh when the daemon started after the current build landed", () => {
		expect(daemonIsStale({ serverMtimeMs: 1_000, daemonStartMs: 2_000 })).toBe(false);
	});
	it("treats unknowable state (no pid / no artifact) as stale — fail toward restarting", () => {
		expect(daemonIsStale({ serverMtimeMs: null, daemonStartMs: 1_000 })).toBe(true);
		expect(daemonIsStale({ serverMtimeMs: 1_000, daemonStartMs: null })).toBe(true);
	});
});

describe("reloadCommand — stdout integrity", () => {
	// Collect everything written to a console channel across the whole run.
	function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
		return spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");
	}

	it("emits a SINGLE parseable JSON object in --json mode WHEN a restart occurs", async () => {
		// Regression: daemonStep restarted the daemon in human mode, so the
		// restart's 'Harness started (PID …)' printed to stdout BEFORE reload's
		// JSON blob — yielding unparseable output. --force guarantees the restart.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ json: true, force: true, cwd: dir });

		const stdout = joinCalls(logSpy);
		// The restart ran (its stdout was suppressed, not skipped)…
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		// …and its human line never reached stdout.
		expect(stdout).not.toContain("Harness started");
		// stdout is the JSON blob and NOTHING else → parseable, restart reported.
		const parsed = JSON.parse(stdout) as { daemon: { restarted: boolean } };
		expect(parsed.daemon.restarted).toBe(true);
	});

	it("still shows the restart's human stdout in normal mode (suppression is json-only)", async () => {
		// Guard against over-suppression: a normal reload must keep the restart's
		// 'Harness started (PID …)' visible; only --json swallows it.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ force: true, cwd: dir });

		const stdout = joinCalls(logSpy);
		expect(harnessRestartMock).toHaveBeenCalledTimes(1);
		expect(stdout).toContain("Harness started (PID 99999)");
	});

	it("refreshes deployed skills for every detected client", async () => {
		detectClientsMock.mockReturnValue([
			{ name: "codex", exists: true },
			{ name: "gemini", exists: false },
		]);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await reloadCommand({ force: true, cwd: dir });

		expect(refreshClientSkillsMock).toHaveBeenCalledWith(dir, ["codex"]);
	});

	it("surfaces the compiler error and exits non-zero when the CLI build fails (no opaque crash)", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// A failed `npm run build` throws with the tool's captured stdout/stderr.
		execFileSyncMock.mockImplementation(() => {
			throw Object.assign(new Error("Command failed: npm run build"), {
				stdout: Buffer.from(""),
				stderr: Buffer.from("src/x.ts(1,5): error TS1005: ';' expected."),
				status: 1,
			});
		});

		// Resolves rather than rejecting with an opaque stack.
		await expect(reloadCommand({ json: true, cwd: dir })).resolves.toBeUndefined();

		expect(process.exitCode).toBe(1);
		// The real compiler diagnostic is surfaced on stderr…
		const stderr = joinCalls(errSpy);
		expect(stderr).toContain("TS1005");
		expect(stderr).toContain("CLI build failed");
		// …the build never reached the restart…
		expect(harnessRestartMock).not.toHaveBeenCalled();
		// …and nothing (no half-built JSON) went to stdout.
		expect(logSpy.mock.calls).toHaveLength(0);
	});
});
