// Tests for SidecarPool — N-instance wrapper that round-robins scan requests
// across independent SidecarManager children. Exists because the Python OPF
// sidecar is single-threaded: one instance handling events from multiple
// concurrent Claude sessions saturates fast, scans abort at the 1.5 s
// AbortSignal timeout, and the scanner silently fail-opens. With N children,
// concurrent sessions can actually run in parallel.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarPoolOptions } from "../sidecar-pool.js";
import { SidecarPool } from "../sidecar-pool.js";

interface FakeChild extends EventEmitter {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	pid: number;
	kill(signal?: string): boolean;
	respond(obj: Record<string, unknown>): void;
	exit(code: number | null): void;
	readonly stdinLines: string[];
}

function makeFakeChild(pid = 1000): FakeChild {
	const emitter = new EventEmitter() as FakeChild;
	emitter.stdin = new PassThrough();
	emitter.stdout = new PassThrough();
	emitter.stderr = new PassThrough();
	emitter.killed = false;
	emitter.pid = pid;
	const lines: string[] = [];
	emitter.stdin.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n")) {
			if (line.length > 0) lines.push(line);
		}
	});
	Object.defineProperty(emitter, "stdinLines", { get: () => lines });
	emitter.respond = (obj) => {
		emitter.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	emitter.exit = (code) => {
		emitter.killed = true;
		emitter.emit("exit", code);
	};
	emitter.kill = () => {
		if (!emitter.killed) {
			emitter.killed = true;
			queueMicrotask(() => emitter.emit("exit", null));
		}
		return true;
	};
	return emitter;
}

function makePoolOpts(
	pool_size: number,
	spawn: NonNullable<SidecarPoolOptions["spawn"]>,
): SidecarPoolOptions {
	return {
		python_bin: "python3",
		script_path: "/tmp/fake.py",
		startup_timeout_ms: 500,
		scan_timeout_ms: 100,
		idle_shutdown_ms: 10_000,
		max_restarts: 3,
		pool_size,
		spawn,
		stderrSink: () => {},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("SidecarPool — lazy spawn", () => {
	it("does not spawn any child until the first send", () => {
		const spawn = vi.fn(() => makeFakeChild() as unknown as import("node:child_process").ChildProcess);
		const pool = new SidecarPool(makePoolOpts(3, spawn));
		expect(spawn).toHaveBeenCalledTimes(0);
		void pool; // suppress unused-var linting
	});

	it("spawns only one child for a single-session workload", async () => {
		const children = [makeFakeChild(101), makeFakeChild(102), makeFakeChild(103)];
		const spawn = vi.fn(() => children.shift() as unknown as import("node:child_process").ChildProcess);
		const pool = new SidecarPool(makePoolOpts(3, spawn));

		const p = pool.send({ op: "ping" });
		await Promise.resolve();
		// One spawn per send; successive sends cycle through the pool.
		expect(spawn).toHaveBeenCalledTimes(1);
		// Satisfy the pending promise so timers don't hang.
		const alive = children.length === 2; // first consumed
		expect(alive).toBe(true);
		// Respond using the child that was actually spawned (first in pool).
		const spawned = spawn.mock.results[0].value as FakeChild;
		spawned.respond({ id: JSON.parse(spawned.stdinLines[0]).id, ok: true });
		await p;
	});
});

describe("SidecarPool — round-robin dispatch", () => {
	it("dispatches N concurrent sends to N distinct children", async () => {
		const children = [makeFakeChild(201), makeFakeChild(202), makeFakeChild(203)];
		const copy = [...children];
		const spawn = vi.fn(() => copy.shift() as unknown as import("node:child_process").ChildProcess);
		const pool = new SidecarPool(makePoolOpts(3, spawn));

		// Three concurrent requests should fan out to three distinct children.
		const p1 = pool.send({ op: "scan", text: "a" });
		const p2 = pool.send({ op: "scan", text: "b" });
		const p3 = pool.send({ op: "scan", text: "c" });
		await Promise.resolve();

		expect(spawn).toHaveBeenCalledTimes(3);
		// Each child got exactly one line written to its stdin.
		expect(children[0].stdinLines).toHaveLength(1);
		expect(children[1].stdinLines).toHaveLength(1);
		expect(children[2].stdinLines).toHaveLength(1);

		children[0].respond({ id: JSON.parse(children[0].stdinLines[0]).id, ok: true });
		children[1].respond({ id: JSON.parse(children[1].stdinLines[0]).id, ok: true });
		children[2].respond({ id: JSON.parse(children[2].stdinLines[0]).id, ok: true });
		await Promise.all([p1, p2, p3]);
	});

	it("wraps around after N sends — request N+1 lands on child 0 again", async () => {
		const children = [makeFakeChild(301), makeFakeChild(302)];
		const copy = [...children];
		const spawn = vi.fn(() => copy.shift() as unknown as import("node:child_process").ChildProcess);
		const pool = new SidecarPool(makePoolOpts(2, spawn));

		// Kick off three sends in rapid succession against a pool of 2.
		const p1 = pool.send({ op: "scan", text: "1" });
		const p2 = pool.send({ op: "scan", text: "2" });
		const p3 = pool.send({ op: "scan", text: "3" });
		await Promise.resolve();

		expect(spawn).toHaveBeenCalledTimes(2);
		// Child 0 should have received TWO lines (requests 1 and 3), child 1 one.
		expect(children[0].stdinLines).toHaveLength(2);
		expect(children[1].stdinLines).toHaveLength(1);

		// Resolve all.
		for (const line of children[0].stdinLines) {
			children[0].respond({ id: JSON.parse(line).id, ok: true });
		}
		for (const line of children[1].stdinLines) {
			children[1].respond({ id: JSON.parse(line).id, ok: true });
		}
		await Promise.all([p1, p2, p3]);
	});
});

describe("SidecarPool — status aggregation", () => {
	it("fires onStatusChange with state=ready once any child boots", async () => {
		const child = makeFakeChild(401);
		const spawn = vi.fn(() => child as unknown as import("node:child_process").ChildProcess);
		const statuses: string[] = [];
		const pool = new SidecarPool({
			...makePoolOpts(3, spawn),
			onStatusChange: (s) => statuses.push(s.state),
		});

		expect(statuses[0]).toBe("idle");
		const p = pool.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(child.stdinLines[0]).id, ok: true });
		await p;

		// The aggregate should transition through spawning→ready as the first
		// child boots, without waiting for the other two.
		expect(statuses).toContain("ready");
	});

	it("aggregate state is `disabled` only when every child is disabled", async () => {
		// Build a spawn fn that always returns a dying child, so children hit
		// max_restarts and flip to disabled one by one.
		const spawn = vi.fn(() => {
			const c = makeFakeChild();
			queueMicrotask(() => c.exit(1));
			return c as unknown as import("node:child_process").ChildProcess;
		});
		const statuses: string[] = [];
		const pool = new SidecarPool({
			...makePoolOpts(2, spawn),
			max_restarts: 1,
			onStatusChange: (s) => statuses.push(s.state),
		});

		// Send a request per child. Each spawn crashes, each child exhausts its
		// 1-restart budget on the next attempt, and both end up disabled.
		// First round of crashes.
		await pool.send({ op: "ping" });
		await pool.send({ op: "ping" });
		// Second round — both children should now trip the budget and return disabled.
		await pool.send({ op: "ping" });
		await pool.send({ op: "ping" });

		expect(statuses).toContain("disabled");
	});
});

describe("SidecarPool — shutdown", () => {
	it("shuts down every child on pool.shutdown()", async () => {
		const children = [makeFakeChild(501), makeFakeChild(502)];
		const copy = [...children];
		const spawn = vi.fn(() => copy.shift() as unknown as import("node:child_process").ChildProcess);
		const pool = new SidecarPool(makePoolOpts(2, spawn));

		// Kick both children alive.
		void pool.send({ op: "ping" });
		void pool.send({ op: "ping" });
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledTimes(2);

		// Shutdown races a 1s force-kill per child; advance timers so both settle.
		const done = pool.shutdown();
		await vi.advanceTimersByTimeAsync(1100);
		await done;
		expect(children[0].killed).toBe(true);
		expect(children[1].killed).toBe(true);
	});
});
