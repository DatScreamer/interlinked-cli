// ============================================================================
// `claimSessionPid`'s genuine-race branch (session-daemon.ts:88-98).
// ============================================================================
// Reaching "a DIFFERENT, ALIVE pid raced us onto the file between our initial
// read and our `wx` write attempt" requires the pid file's content to change
// between two `readPidFile` calls a few lines apart — not producible with
// real concurrency in a single-threaded unit test. This file mocks node:fs
// directly (isolated from session-daemon.test.ts's real-socket integration
// tests, which need real fs) to script exactly that sequence:
//   1st read  -> a dead/unowned pid (doesn't block the initial check)
//   wx write  -> throws EEXIST (something now occupies the path)
//   2nd read  -> a DIFFERENT, genuinely alive pid (this process's own, so
//                `isProcessAlive` — real, unmocked — reports true)
// -> claimSessionPid must report the race loser outcome, never silently
//    "win" over a live rival.
//
// Statically imports claimSessionPid ONCE (module mocks are hoisted above
// this file's imports) and reconfigures the fs mocks per test instead of
// dynamically re-importing the module under test — no `resetModules()`
// churn, so there's no dynamic-import-vs-mock-registration ordering to get
// wrong.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSessionPid } from "./session-daemon.js";

const existsSyncMock = vi.fn((_path: string) => true);
const readFileSyncMock = vi.fn<(path: string, encoding: string) => string>();
const writeFileSyncMock = vi.fn<(path: string, data: string, opts?: { flag?: string }) => void>();

vi.mock("node:fs", () => ({
	existsSync: (...args: [string]) => existsSyncMock(...args),
	readFileSync: (...args: [string, string]) => readFileSyncMock(...args),
	writeFileSync: (...args: [string, string, ({ flag?: string } | undefined)?]) =>
		writeFileSyncMock(...args),
}));

describe("claimSessionPid — genuine race (node:fs mocked)", () => {
	beforeEach(() => {
		existsSyncMock.mockReset().mockReturnValue(true);
		readFileSyncMock.mockReset();
		writeFileSyncMock.mockReset();
		writeFileSyncMock.mockImplementation((_path, _data, opts) => {
			if (opts?.flag === "wx") {
				const err = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
				err.code = "EEXIST";
				throw err;
			}
			// Non-wx (the race-loser overwrite path) — allowed, no-op.
		});
	});

	it("a different, alive pid racing in between the read and the wx write is reported as the loser (line 94, branch 93 true)", () => {
		let readCallCount = 0;
		readFileSyncMock.mockImplementation(() => {
			readCallCount++;
			// First read (the pre-write blocking check): a pid nothing alive will
			// ever hold, so the initial check does not block.
			if (readCallCount === 1) return "999999999";
			// Second read (post-EEXIST re-read): this process's OWN real pid —
			// genuinely alive per the real (unmocked) `isProcessAlive`.
			return String(process.pid);
		});
		// Claim as some other, distinct pid — never our own process id — so the
		// re-read (this process's real pid) is unambiguously "someone else".
		const claimingPid = process.pid === 1 ? 2 : 1;
		const result = claimSessionPid("/fake/path/harness.pid", claimingPid);
		expect(result).toEqual({ claimed: false, ownerPid: process.pid });
		// Exactly two reads: the initial blocking check, and the post-EEXIST
		// re-read — proving the race window (not some other code path) is what
		// produced the result.
		expect(readCallCount).toBe(2);
		// The wx attempt happened (and threw); no second, non-wx write ever ran
		// because the re-read found a live rival and returned before line 96.
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
	});

	it("when the raced pid is NOT alive/foreign, the race loser silently overwrites and wins (line 96-97 contrast)", () => {
		// Both reads return the same dead pid, so the re-read never finds a
		// live rival — the write-over branch runs instead.
		readFileSyncMock.mockReturnValue("999999999");
		const result = claimSessionPid("/fake/path/harness.pid", 42);
		expect(result).toEqual({ claimed: true });
		// Two writes: the failed `wx` attempt, then the unconditional overwrite.
		expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
	});

	it("a raced claim by this same pid is not treated as a foreign owner", () => {
		let readCallCount = 0;
		readFileSyncMock.mockImplementation(() => {
			readCallCount++;
			if (readCallCount === 1) return "999999999";
			return String(process.pid);
		});

		expect(claimSessionPid("/fake/path/self-race.pid", process.pid)).toEqual({ claimed: true });
	});

	it("a non-EEXIST failure from the exclusive claim is rethrown", () => {
		existsSyncMock.mockReturnValue(false);
		writeFileSyncMock.mockImplementation((_path, _data, opts) => {
			if (opts?.flag === "wx") {
				const err = new Error("permission denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
		});

		expect(() => claimSessionPid("/fake/path/denied.pid", process.pid)).toThrow("permission denied");
	});

	it("a raced missing pid is treated as an available stale claim", () => {
		let readCallCount = 0;
		readFileSyncMock.mockImplementation(() => {
			readCallCount++;
			if (readCallCount === 1) return "999999999";
			throw new Error("ENOENT");
		});

		expect(claimSessionPid("/fake/path/missing-race.pid", process.pid)).toEqual({ claimed: true });
	});
});
