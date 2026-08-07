import { describe, expect, it } from "vitest";
import { runProcessAsync } from "./spawn-async.js";

describe("runProcessAsync", () => {
	it("captures stdout from a successful process", async () => {
		const r = await runProcessAsync("/bin/echo", ["hello"], { timeout: 5000 });
		expect(r.stdout).toContain("hello");
		expect(r.code).toBe(0);
		expect(r.timedOut).toBe(false);
	});

	it("captures stderr separately from stdout", async () => {
		// `sh -c 'echo out; echo err 1>&2'` writes to both
		const r = await runProcessAsync("/bin/sh", ["-c", "echo out; echo err 1>&2"], {
			timeout: 5000,
		});
		expect(r.stdout).toContain("out");
		expect(r.stderr).toContain("err");
	});

	it("propagates non-zero exit code", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "exit 7"], { timeout: 5000 });
		expect(r.code).toBe(7);
	});

	it("returns timedOut=true when the process exceeds the timeout", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 5"], { timeout: 100 });
		expect(r.timedOut).toBe(true);
		expect(r.killed).toBe(true);
	});

	it("does not throw on a missing binary — returns code !== 0", async () => {
		const r = await runProcessAsync("/nonexistent/binary-xyz", ["arg"], { timeout: 1000 });
		// On macOS, ENOENT manifests as code === null (process never ran).
		// We capture that via a sentinel rather than throwing.
		expect(r.code).not.toBe(0);
	});

	it("cancels pending timeout/kill timers once the child exits (no signal after reap)", async () => {
		// A process that finishes well within its timeout must report killed=false:
		// the 'exit' handler cancels the timeout + SIGKILL-grace timers so nothing
		// can signal the child's (now potentially OS-recycled) pid after it is reaped
		// — closing the `process.kill(-pid)`-hits-the-wrong-group window.
		const r = await runProcessAsync("/bin/sh", ["-c", "exit 0"], { timeout: 5000 });
		expect(r.killed).toBe(false);
		expect(r.timedOut).toBe(false);
		expect(r.code).toBe(0);
	});

	it("uses the default 30s timeout when none is given", async () => {
		const r = await runProcessAsync("/bin/echo", ["hi"]);
		expect(r.stdout).toContain("hi");
		expect(r.timedOut).toBe(false);
	});

	it("merges opts.env on top of process.env", async () => {
		const r = await runProcessAsync("/bin/sh", ["-c", "echo $SPAWN_ASYNC_TEST_VAR"], {
			timeout: 5000,
			env: { SPAWN_ASYNC_TEST_VAR: "custom-value" },
		});
		expect(r.stdout).toContain("custom-value");
	});

	it("kills an already-aborted signal immediately (aborted:true at call time)", async () => {
		const controller = new AbortController();
		controller.abort();
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 5"], {
			timeout: 30_000,
			signal: controller.signal,
		});
		expect(r.killed).toBe(true);
	});

	it("escalates to SIGKILL after the grace period when the process ignores SIGTERM", async () => {
		// `trap '' TERM` makes the shell ignore SIGTERM, forcing the timeout path
		// through the full SIGKILL_GRACE_MS window before the process actually dies.
		const start = Date.now();
		const r = await runProcessAsync("/bin/sh", ["-c", "trap '' TERM; sleep 10"], {
			timeout: 100,
		});
		expect(r.timedOut).toBe(true);
		expect(r.killed).toBe(true);
		expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
	}, 10_000);

	it("respects an external AbortSignal", async () => {
		const controller = new AbortController();
		const promise = runProcessAsync("/bin/sh", ["-c", "sleep 5"], {
			timeout: 30_000,
			signal: controller.signal,
		});
		// Abort after a tick.
		setTimeout(() => controller.abort(), 50);
		const r = await promise;
		expect(r.killed).toBe(true);
	});

	it("truncates stdout at MAX_BUFFER_BYTES instead of buffering unbounded output", async () => {
		// Print well past the 10 MB cap so the byte-count guard in the 'data'
		// listener actually engages and further chunks are dropped.
		const r = await runProcessAsync(
			"/bin/sh",
			["-c", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 11000000"],
			{ timeout: 15_000 },
		);
		expect(r.stdout.length).toBeLessThan(11_000_000);
		expect(r.code).toBe(0);
	}, 20_000);

	it("truncates stderr at MAX_BUFFER_BYTES instead of buffering unbounded output", async () => {
		const r = await runProcessAsync(
			"/bin/sh",
			["-c", "yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 11000000 1>&2"],
			{ timeout: 15_000 },
		);
		expect(r.stderr.length).toBeLessThan(11_000_000);
		expect(r.code).toBe(0);
	}, 20_000);

	it("resolves via the close-guard fallback with code=null when the process self-signals and a re-parented grandchild holds the pipe", async () => {
		// `kill -TERM $$` (no leading '-') signals only the script's own pid, not
		// its process group — so it never touches the `sleep` backgrounded from
		// a subshell, which keeps running (re-parented) holding the inherited
		// stdout fd. `exit` reports code=null (died from a signal, not us — we
		// never call killTree here: killed/timedOut stay false); 'close' is
		// delayed by the surviving grandchild, forcing the 250ms close-guard
		// fallback to take the null-code branch.
		const r = await runProcessAsync("/bin/sh", ["-c", "(sleep 5 &) ; kill -TERM $$"], {
			timeout: 30_000,
		});
		expect(r.timedOut).toBe(false);
		expect(r.killed).toBe(false);
		expect(r.code).toBeNull();
	}, 10_000);

	it("resolves promptly after the child exits even if a backgrounded grandchild holds the stdio pipe", async () => {
		// `sh` exits 0 immediately, but the backgrounded `sleep` inherits the
		// stdout pipe and keeps it OPEN — so 'close' (stdio EOF) is delayed until
		// the grandchild exits. Resolving only on 'close' let a grandchild that
		// escaped the process-group kill wedge the call — and any awaiting vitest
		// worker / daemon — indefinitely (Linux + parallel batches; finding
		// 2026-06: a 25-min CI deadlock). We must resolve shortly after exit, not
		// wait the full 3 s for the orphaned grandchild.
		const start = Date.now();
		const r = await runProcessAsync("/bin/sh", ["-c", "sleep 3 & exit 0"], { timeout: 30_000 });
		expect(r.code).toBe(0);
		expect(Date.now() - start).toBeLessThan(2000);
	}, 10_000);
});
