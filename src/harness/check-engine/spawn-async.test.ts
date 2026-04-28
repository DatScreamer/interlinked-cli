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
});
