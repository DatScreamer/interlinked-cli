import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveOwnArtifact,
	shouldHandOver,
	startBuildRefreshWatcher,
} from "./build-refresh.js";

describe("resolveOwnArtifact", () => {
	it("returns null for a src-run module URL (tsx/bun dev — no dist marker)", () => {
		expect(resolveOwnArtifact("file:///Users/x/interlinked-cli/src/harness/server.ts")).toBeNull();
	});

	it("returns null for an unparseable module URL", () => {
		expect(resolveOwnArtifact("not-a-url")).toBeNull();
	});

	it("derives artifact + CLI entry from a dist-run module URL", () => {
		const resolved = resolveOwnArtifact("file:///Users/x/interlinked-cli/dist/harness/server.js");
		expect(resolved).not.toBeNull();
		expect(resolved?.artifactPath).toBe("/Users/x/interlinked-cli/dist/harness/server.js");
		expect(resolved?.cliEntryPath).toBe("/Users/x/interlinked-cli/dist/index.js");
	});
});

describe("shouldHandOver", () => {
	const base = {
		nowMs: 100_000,
		currentMtimeMs: 50_000,
		startedMtimeMs: 40_000,
		lastActivityAtMs: 0,
		settleMs: 5_000,
		quietMs: 10_000,
	};

	it("fires when the artifact is newer, settled, and the repo is quiet", () => {
		expect(shouldHandOver(base)).toBe(true);
	});

	it("does not fire when the artifact mtime is unchanged", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: base.startedMtimeMs })).toBe(false);
	});

	it("does not fire when the artifact is older than the running build (clock skew)", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: 30_000 })).toBe(false);
	});

	it("does not fire while the rebuild is still settling", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: 99_000 })).toBe(false);
	});

	it("does not fire during an active hook-event burst", () => {
		expect(shouldHandOver({ ...base, lastActivityAtMs: 95_000 })).toBe(false);
	});

	it("treats a never-active daemon (lastActivityAtMs=0) as quiet", () => {
		expect(shouldHandOver({ ...base, lastActivityAtMs: 0 })).toBe(true);
	});
});

describe("startBuildRefreshWatcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const distUrl = "file:///repo/dist/harness/server.js";

	interface HarnessDeps {
		spawn: ReturnType<typeof vi.fn>;
		log: ReturnType<typeof vi.fn>;
		mtime: { value: number };
		dispose: () => void;
	}

	function startWatcher(overrides: {
		env?: NodeJS.ProcessEnv;
		moduleUrl?: string;
		startMtime?: number;
	} = {}): HarnessDeps {
		const mtime = { value: overrides.startMtime ?? 1_000 };
		const spawn = vi.fn(() => ({ unref: vi.fn() }));
		const log = vi.fn();
		const dispose = startBuildRefreshWatcher({
			moduleUrl: overrides.moduleUrl ?? distUrl,
			cwd: "/repo",
			lastActivityMs: () => 0,
			log,
			env: overrides.env ?? {},
			deps: {
				statMtimeMs: () => mtime.value,
				// SAFETY: the watcher only calls spawn(cmd, argv, opts).unref();
				// the vi.fn stub satisfies exactly that shape.
				spawn: spawn as never,
			},
		});
		return { spawn, log, mtime, dispose };
	}

	it("no-ops entirely for src-run daemons", () => {
		const h = startWatcher({ moduleUrl: "file:///repo/src/harness/server.ts" });
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("no-ops when disabled via INTERLINKED_NO_AUTO_RESTART=1", () => {
		const h = startWatcher({ env: { INTERLINKED_NO_AUTO_RESTART: "1" } });
		h.mtime.value = 5_000_000;
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("does not spawn while the artifact mtime is unchanged", () => {
		const h = startWatcher();
		vi.advanceTimersByTime(300_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("spawns `harness restart` via the CLI entry once a newer settled build lands", () => {
		const h = startWatcher();
		// Newer than the recorded start mtime; by the first tick (60s later,
		// fake clock) it is settled well past settleMs.
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(61_000); // first tick: spawns the hand-over
		vi.advanceTimersByTime(61_000); // second tick: absorbed by the throttle
		expect(h.spawn).toHaveBeenCalledTimes(1);
		// SAFETY: asserted immediately above that exactly one call was made;
		// the tuple mirrors node's spawn(cmd, argv, opts) signature.
		const [cmd, argv, opts] = h.spawn.mock.calls[0] as unknown as [
			string,
			string[],
			{ cwd: string; detached: boolean },
		];
		expect(cmd).toBe(process.execPath);
		expect(argv).toEqual(["/repo/dist/index.js", "harness", "restart"]);
		expect(opts.cwd).toBe("/repo");
		expect(opts.detached).toBe(true);
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("newer build"));
		h.dispose();
	});

	it("throttles re-spawn attempts to one per interval while the restart is pending", () => {
		const h = startWatcher();
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(61_000 * 4);
		// Ticks after the first successful attempt are throttled to ~1/interval,
		// so 4 ticks can spawn at most 2 restarts (initial + one retry).
		expect(h.spawn.mock.calls.length).toBeLessThanOrEqual(2);
		h.dispose();
	});

	it("stops ticking after dispose", () => {
		const h = startWatcher();
		h.dispose();
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
	});
});
