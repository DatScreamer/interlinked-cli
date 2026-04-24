import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarManager } from "../sidecar-manager.js";
import type { SidecarManagerOptions } from "../sidecar-manager.js";

// ===========================================
// Fake child process
// ===========================================

interface FakeChild extends EventEmitter {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	kill(signal?: string): boolean;
	/** Helper: emit a JSON line on the fake stdout. */
	respond(obj: Record<string, unknown>): void;
	/** Helper: pretend the child exited. */
	exit(code: number | null): void;
	/** Captured stdin writes, one JSON object per line. */
	readonly stdinLines: string[];
}

function makeFakeChild(): FakeChild {
	const emitter = new EventEmitter() as FakeChild;
	emitter.stdin = new PassThrough();
	emitter.stdout = new PassThrough();
	emitter.stderr = new PassThrough();
	emitter.killed = false;

	const lines: string[] = [];
	emitter.stdin.on("data", (chunk: Buffer) => {
		// Each chunk may contain one or more \n-delimited JSON objects.
		const text = chunk.toString();
		for (const line of text.split("\n")) {
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
	emitter.kill = (_signal?: string) => {
		if (!emitter.killed) {
			emitter.killed = true;
			queueMicrotask(() => emitter.emit("exit", null));
		}
		return true;
	};

	return emitter;
}

function makeOpts(overrides: Partial<SidecarManagerOptions> = {}): SidecarManagerOptions {
	const child = makeFakeChild();
	const spawn = vi.fn(() => child as unknown as import("node:child_process").ChildProcess);
	return {
		python_bin: "python3",
		script_path: "/tmp/fake-sidecar.py",
		startup_timeout_ms: 500,
		scan_timeout_ms: 100,
		idle_shutdown_ms: 10_000,
		max_restarts: 3,
		spawn,
		stderrSink: () => {},
		...overrides,
	};
}

// ===========================================
// Test fixtures
// ===========================================

type ManagerCtx = {
	mgr: SidecarManager;
	child: FakeChild;
	spawn: ReturnType<typeof vi.fn>;
};

function makeManager(overrides: Partial<SidecarManagerOptions> = {}): ManagerCtx {
	const child = makeFakeChild();
	const spawn = vi.fn(() => child as unknown as import("node:child_process").ChildProcess);
	const opts = { ...makeOpts(), ...overrides, spawn };
	return { mgr: new SidecarManager(opts), child, spawn };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// ===========================================
// Tests
// ===========================================

describe("SidecarManager — happy path", () => {
	it("spawns lazily on first send, forwards request, correlates response by id", async () => {
		const { mgr, child, spawn } = makeManager();
		expect(spawn).not.toHaveBeenCalled();

		const p = mgr.send({ op: "ping" });
		expect(spawn).toHaveBeenCalledOnce();

		// Advance enough microtasks for the Promise chain to register the pending entry.
		await Promise.resolve();
		expect(child.stdinLines).toHaveLength(1);
		const sent = JSON.parse(child.stdinLines[0]);
		expect(sent.op).toBe("ping");
		expect(typeof sent.id).toBe("string");

		child.respond({ id: sent.id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("delivers spans and redacted_text on scan responses", async () => {
		const { mgr, child } = makeManager();
		const p = mgr.send({ op: "scan", text: "alice@example.com" });
		await Promise.resolve();
		const sent = JSON.parse(child.stdinLines[0]);
		expect(sent.text).toBe("alice@example.com");

		child.respond({
			id: sent.id,
			ok: true,
			spans: [{ label: "private_email", start: 0, end: 17, text: "alice@example.com" }],
			redacted_text: "<PRIVATE_EMAIL>",
		});
		const resp = await p;
		expect(resp.ok).toBe(true);
		expect(resp.spans).toHaveLength(1);
		expect(resp.spans?.[0].label).toBe("private_email");
		expect(resp.redacted_text).toBe("<PRIVATE_EMAIL>");
	});

	it("multiple concurrent requests are correlated by id", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "scan", text: "a" });
		const p2 = mgr.send({ op: "scan", text: "b" });
		await Promise.resolve();
		const [sent1, sent2] = child.stdinLines.map((l) => JSON.parse(l));

		// Respond out of order — p2 first, then p1.
		child.respond({ id: sent2.id, ok: true, spans: [], redacted_text: "b" });
		child.respond({ id: sent1.id, ok: true, spans: [], redacted_text: "a" });
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.redacted_text).toBe("a");
		expect(r2.redacted_text).toBe("b");
	});
});

describe("SidecarManager — timeouts", () => {
	it("uses startup_timeout_ms for the first call (cold load)", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 500, scan_timeout_ms: 50 });
		const p = mgr.send({ op: "ping" });
		await Promise.resolve();

		// Less than startup budget but more than scan budget — should still be pending.
		await vi.advanceTimersByTimeAsync(200);
		child.respond({ id: JSON.parse(child.stdinLines[0]).id, ok: true });
		const resp = await p;
		expect(resp.ok).toBe(true);
	});

	it("uses scan_timeout_ms for subsequent calls after first response", async () => {
		const { mgr, child } = makeManager({ startup_timeout_ms: 500, scan_timeout_ms: 100 });
		// First (warm-up) call completes fast.
		const p1 = mgr.send({ op: "ping" });
		await Promise.resolve();
		child.respond({ id: JSON.parse(child.stdinLines[0]).id, ok: true });
		await p1;

		// Second call — no response; should time out at scan_timeout_ms.
		const p2 = mgr.send({ op: "scan", text: "x" });
		await vi.advanceTimersByTimeAsync(101);
		const resp = await p2;
		expect(resp.ok).toBe(false);
		expect(resp.error).toContain("timeout after 100ms");
	});

	it("aborts on AbortSignal", async () => {
		const { mgr } = makeManager();
		const controller = new AbortController();
		const p = mgr.send({ op: "scan", text: "x", signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		const resp = await p;
		expect(resp.ok).toBe(false);
		expect(resp.error).toBe("aborted");
	});
});

describe("SidecarManager — crash handling", () => {
	it("rejects all pending with error when the child exits unexpectedly", async () => {
		const { mgr, child } = makeManager();
		const p1 = mgr.send({ op: "scan", text: "a" });
		const p2 = mgr.send({ op: "scan", text: "b" });
		await Promise.resolve();

		child.exit(1);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.ok).toBe(false);
		expect(r1.error).toContain("exited with code 1");
		expect(r2.ok).toBe(false);
	});

	it("honors max_restarts when the child keeps dying", async () => {
		// Build a spawn function that always returns a dying child.
		const spawn = vi.fn(() => {
			const c = makeFakeChild();
			queueMicrotask(() => c.exit(1));
			return c as unknown as import("node:child_process").ChildProcess;
		});
		const mgr = new SidecarManager({ ...makeOpts(), spawn, max_restarts: 2 });

		// First two calls — each triggers a spawn (child dies instantly).
		const r1 = await mgr.send({ op: "ping" });
		expect(r1.ok).toBe(false);
		const r2 = await mgr.send({ op: "ping" });
		expect(r2.ok).toBe(false);

		// Third call should fail-open with "exceeded max_restarts" — no spawn attempt.
		const r3 = await mgr.send({ op: "ping" });
		expect(r3.ok).toBe(false);
		expect(r3.error).toContain("exceeded max_restarts");
		expect(spawn).toHaveBeenCalledTimes(2);
	});
});

describe("SidecarManager — shutdown", () => {
	it("sends a shutdown request and force-kills after the grace window", async () => {
		const { mgr, child } = makeManager();
		// Kick off a send to force spawn. Don't await — fake timers won't resolve it.
		void mgr.send({ op: "ping" });
		await Promise.resolve();
		expect(child.stdinLines.length).toBeGreaterThan(0);

		const p = mgr.shutdown();
		// After 1s (force-kill timer), we expect SIGKILL.
		await vi.advanceTimersByTimeAsync(1100);
		await p;
		expect(child.killed).toBe(true);
	});

	it("returns {ok:false} when called while shutting down", async () => {
		const { mgr, child } = makeManager();
		void mgr.send({ op: "ping" });
		await Promise.resolve();

		const shutdownPromise = mgr.shutdown();
		const r = await mgr.send({ op: "ping" });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("shutting down");
		// Clean up the in-flight shutdown.
		child.exit(0);
		await vi.advanceTimersByTimeAsync(1100);
		await shutdownPromise;
	});
});
