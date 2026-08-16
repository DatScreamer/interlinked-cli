import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireStartupLock,
	isStartupLockStale,
	readStartupLockHolder,
	releaseStartupLock,
	STARTUP_LOCK_TTL_MS,
	startupInFlight,
	startupLockPath,
	waitForDaemonSocket,
} from "./startup-lock.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "il-startup-lock-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a lock file as if another (live) process held it. */
function foreignLock(at: number, pid = process.pid): void {
	writeFileSync(startupLockPath(root), JSON.stringify({ pid, at }));
}

describe("acquireStartupLock — positive (must fire: exactly one binder)", () => {
	it("P1: the first caller acquires and records its pid", () => {
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
		expect(readStartupLockHolder(root)?.pid).toBe(process.pid);
	});

	it("P2: two concurrent starts collapse to ONE binder", () => {
		const first = acquireStartupLock(root);
		const second = acquireStartupLock(root);
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(false);
		if (second.acquired) throw new Error("unreachable");
		expect(second.holder?.pid).toBe(process.pid);
	});

	it("P3: three concurrent starts still yield exactly one winner", () => {
		const results = [acquireStartupLock(root), acquireStartupLock(root), acquireStartupLock(root)];
		expect(results.filter((r) => r.acquired)).toHaveLength(1);
	});

	it("P4: a lock older than the TTL is stolen, not obeyed forever", () => {
		foreignLock(Date.now() - STARTUP_LOCK_TTL_MS - 1_000);
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
	});

	it("P5: a lock held by a dead pid is stolen", () => {
		foreignLock(Date.now(), 999_999_998);
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
	});

	it("P6: releasing lets the next caller acquire", () => {
		const first = acquireStartupLock(root);
		if (!first.acquired) throw new Error("expected acquire");
		first.release();
		expect(existsSync(startupLockPath(root))).toBe(false);
		expect(acquireStartupLock(root).acquired).toBe(true);
	});
});

describe("acquireStartupLock — negative (must not fire)", () => {
	it("N1: a fresh lock from a live holder is NOT stolen", () => {
		foreignLock(Date.now());
		expect(isStartupLockStale(readStartupLockHolder(root), Date.now())).toBe(false);
		expect(acquireStartupLock(root).acquired).toBe(false);
	});

	it("N2: releaseStartupLock leaves ANOTHER process's lock alone", () => {
		writeFileSync(startupLockPath(root), JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
		releaseStartupLock(root);
		expect(existsSync(startupLockPath(root))).toBe(true);
	});

	it("N3: garbage lock content is treated as stale, not as a live holder", () => {
		writeFileSync(startupLockPath(root), "not json");
		expect(readStartupLockHolder(root)).toBeNull();
		expect(acquireStartupLock(root).acquired).toBe(true);
		expect(JSON.parse(readFileSync(startupLockPath(root), "utf-8")).pid).toBe(process.pid);
	});

	it("N4: startupInFlight is false with no lock and false for an expired one", () => {
		expect(startupInFlight(root)).toBe(false);
		foreignLock(Date.now() - STARTUP_LOCK_TTL_MS - 1);
		expect(startupInFlight(root)).toBe(false);
	});
});

describe("waitForDaemonSocket — loser waits instead of binding", () => {
	it("P1: resolves true as soon as a socket answers", async () => {
		let calls = 0;
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 1_000,
			poll_ms: 1,
			listSockets: () => ["/tmp/x.sock"],
			probe: () => Promise.resolve(++calls >= 2),
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(true);
		expect(calls).toBe(2);
	});

	it("N1: resolves false when nothing answers before the deadline", async () => {
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 0,
			poll_ms: 1,
			listSockets: () => ["/tmp/x.sock"],
			probe: () => Promise.resolve(false),
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(false);
	});

	it("N2: no socket files at all still terminates (no infinite loop)", async () => {
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 0,
			poll_ms: 1,
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(false);
	});
});
