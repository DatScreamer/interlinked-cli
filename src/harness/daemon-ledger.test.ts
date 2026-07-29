import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeLastExit,
	readRecentDaemonEvents,
	recordDaemonEvent,
} from "./daemon-ledger.js";

/**
 * Why this exists: over one session (2026-07-28) the daemon "went down" a
 * dozen times with FOUR different causes — build-refresh handovers, memory
 * hangs under swap, orphan accumulation, RSS-ceiling recycles — and every one
 * presented as the same opaque symptom: "pid present, no live daemon". With no
 * record of WHY a daemon exited, each occurrence was re-diagnosed from scratch
 * and mostly misattributed. The ledger makes every daemon exit self-
 * documenting, so the cold-block message and `harness status` can say "handed
 * over to a newer build 4s ago — normal after a rebuild" instead of implying
 * a crash.
 */
let dir: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "daemon-ledger-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("recordDaemonEvent / readRecentDaemonEvents", () => {
	it("round-trips an exit event with its reason", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 42, event: "exit", reason: "build-refresh", rss_mb: 180 });
		const events = readRecentDaemonEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ pid: 42, event: "exit", reason: "build-refresh" });
	});

	it("keeps events in append order", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
		recordDaemonEvent(dir, { at: NOW + 1, pid: 1, event: "exit", reason: "signal" });
		expect(readRecentDaemonEvents(dir).map((e) => e.event)).toEqual(["start", "exit"]);
	});

	it("never throws when the directory is unwritable — the guard must not die of its own diary", () => {
		// A REAL unwritable directory (mode 000), not a procfs path: probing
		// /proc/nonexistent-root worked as a joke path on macOS but on the Linux
		// CI runner it lands inside procfs, whose mkdir semantics hung the
		// single fork worker and timed out the whole unit lane (run 30410747800
		// — identified by the size-ordered queue: this file was the largest
		// never-completed). Root under CI runs unprivileged, so chmod 000 holds.
		const locked = join(dir, "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		try {
			expect(() =>
				recordDaemonEvent(join(locked, "sub"), { at: NOW, pid: 1, event: "start" }),
			).not.toThrow();
		} finally {
			chmodSync(locked, 0o755); // or afterEach's rmSync fails on some platforms
		}
	});

	it("returns [] when no ledger exists", () => {
		expect(readRecentDaemonEvents(dir)).toEqual([]);
	});

	it("skips torn/corrupt lines rather than failing the read", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
		writeFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), "{not json\n", { flag: "a" });
		recordDaemonEvent(dir, { at: NOW + 2, pid: 1, event: "exit", reason: "signal" });
		expect(readRecentDaemonEvents(dir)).toHaveLength(2);
	});

	it("bounds the read to a tail — a long-lived ledger must not be slurped whole", () => {
		for (let i = 0; i < 2000; i++) recordDaemonEvent(dir, { at: NOW + i, pid: i, event: "start" });
		const events = readRecentDaemonEvents(dir);
		expect(events.length).toBeLessThan(2000);
		expect(events.at(-1)?.pid).toBe(1999); // the newest survives the bound
	});
});

describe("describeLastExit — the sentence the block message shows", () => {
	it("explains a build-refresh handover as normal, with age", () => {
		recordDaemonEvent(dir, { at: NOW - 4_000, pid: 7, event: "handover", reason: "build-refresh" });
		recordDaemonEvent(dir, { at: NOW - 3_000, pid: 7, event: "exit", reason: "signal" });
		const line = describeLastExit(readRecentDaemonEvents(dir), NOW);
		expect(line).toContain("build-refresh");
		expect(line).toContain("3s ago");
	});

	it("names an rss-ceiling recycle explicitly", () => {
		recordDaemonEvent(dir, { at: NOW - 10_000, pid: 7, event: "exit", reason: "rss-ceiling", rss_mb: 512 });
		const line = describeLastExit(readRecentDaemonEvents(dir), NOW);
		expect(line).toContain("rss-ceiling");
		expect(line).toContain("512");
	});

	it("does not explain a stale exit as if it were the current outage", () => {
		// An exit from an hour ago cannot be why the socket is down NOW; a wrong
		// explanation is worse than none.
		recordDaemonEvent(dir, { at: NOW - 3_600_000, pid: 7, event: "exit", reason: "signal" });
		expect(describeLastExit(readRecentDaemonEvents(dir), NOW)).toBeNull();
	});

	it("returns null with no exit events at all", () => {
		recordDaemonEvent(dir, { at: NOW - 1_000, pid: 7, event: "start" });
		expect(describeLastExit(readRecentDaemonEvents(dir), NOW)).toBeNull();
	});
});
