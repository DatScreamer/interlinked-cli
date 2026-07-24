// Tests for the generic overlay command runner — the P4 spike seam
// (docs/design/overlay-exec-runtime-oracles.md §2). Drives the injectable
// spawn so no real process runs.

import { describe, expect, it } from "vitest";
import {
	type OverlaySpawnFn,
	resolveOverlayBin,
	runArgvInOverlay,
} from "./overlay-command-runner.js";

const OVERLAY = "/repo/.interlinked/.cov-overlay-x";

function stubSpawn(
	outcome: Partial<Awaited<ReturnType<OverlaySpawnFn>>>,
	capture?: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => void,
): OverlaySpawnFn {
	return async (cmd, args, opts) => {
		capture?.(cmd, args, opts.cwd, opts.env);
		return { stdout: "", stderr: "", status: 0, ...outcome };
	};
}

describe("runArgvInOverlay", () => {
	it("runs argv against the overlay root and returns a structured result", async () => {
		let seenCwd = "";
		const spawn = stubSpawn({ stdout: "ok", status: 0 }, (_c, _a, cwd) => {
			seenCwd = cwd;
		});
		const r = await runArgvInOverlay(["node", "-e", "0"], OVERLAY, 5000, spawn);
		expect(seenCwd).toBe(OVERLAY);
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.stdout).toBe("ok");
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("maps a nonzero exit through", async () => {
		const r = await runArgvInOverlay(["false"], OVERLAY, 5000, stubSpawn({ status: 1 }));
		expect(r.exitCode).toBe(1);
		expect(r.timedOut).toBe(false);
	});

	it("reports a timeout (ETIMEDOUT → timedOut, exitCode null)", async () => {
		const timedOut = stubSpawn({
			status: null,
			error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
		});
		const r = await runArgvInOverlay(["sleep", "99"], OVERLAY, 10, timedOut);
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBeNull();
	});

	it("reports ENOENT as a launch failure, not a timeout", async () => {
		const enoent = stubSpawn({
			status: null,
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
		});
		const r = await runArgvInOverlay(["nope"], OVERLAY, 5000, enoent);
		expect(r.timedOut).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(r.error).toContain("nope");
	});

	it("threads env over the child", async () => {
		let seenEnv: Record<string, string> | undefined;
		const spawn = stubSpawn({ status: 0 }, (_c, _a, _cwd, env) => {
			seenEnv = env;
		});
		await runArgvInOverlay(["node"], OVERLAY, 5000, spawn, { NODE_OPTIONS: "--expose-gc" });
		expect(seenEnv).toEqual({ NODE_OPTIONS: "--expose-gc" });
	});

	it("rejects an empty argv without spawning", async () => {
		let spawned = false;
		const r = await runArgvInOverlay([], OVERLAY, 5000, stubSpawn({}, () => {
			spawned = true;
		}));
		expect(spawned).toBe(false);
		expect(r.error).toContain("empty");
	});
});

describe("resolveOverlayBin", () => {
	it("leaves an absolute or slash-bearing bin untouched", () => {
		expect(resolveOverlayBin("/repo", "/usr/bin/node")).toBe("/usr/bin/node");
		expect(resolveOverlayBin("/repo", "./x")).toBe("./x");
	});

	it("returns a bare bin unchanged when no local .bin exists", () => {
		// /repo has no node_modules/.bin/definitely-not-a-real-bin → PATH fallback.
		expect(resolveOverlayBin("/repo", "definitely-not-a-real-bin")).toBe(
			"definitely-not-a-real-bin",
		);
	});
});
