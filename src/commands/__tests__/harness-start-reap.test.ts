import { beforeEach, describe, expect, it, vi } from "vitest";
import { harnessStartCommand } from "../harness.js";

/**
 * `interlinked harness start` must reap orphan daemons even when a daemon is
 * ALREADY RUNNING.
 *
 * The reap used to sit AFTER the already-running early return, so it only ran
 * on the spawn path. In a long session the common call is the other one: the
 * live daemon grows until it stops answering the socket, the hook's self-heal
 * calls `start`, `start` says "already running" and returns — reaping nothing.
 * Orphans then accumulate holding memory the live daemon needs, so each round
 * degrades faster than the last.
 *
 * Measured 2026-07-28: an orphan resident since 09:15 holding 743MB while the
 * active daemon thrashed. The source comment already warned about this shape
 * ("28 daemons across 4 days, ~1.8 GB stale RSS") — the ordering defeated it.
 */
const reapSpy = vi.fn<() => { killed: string[]; skipped: string[] }>();
const runningSpy = vi.fn<() => { running: boolean; pid: number }>();

vi.mock("../harness-process.js", () => ({
	isHarnessRunning: () => runningSpy(),
	reapOrphanHarnesses: () => reapSpy(),
	getHarnessServerPath: () => "/nonexistent/server.js",
	getSocketPath: () => "/tmp/x.sock",
	getFramedSocketPath: () => "/tmp/x-framed.sock",
	ensureDistFresh: vi.fn(),
}));

let logged: string[] = [];

beforeEach(() => {
	logged = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged.push(a.map(String).join(" "));
	});
	reapSpy.mockReset();
	runningSpy.mockReset();
});

describe("harness start — orphan reaping is not skipped by the early return", () => {
	it("reaps BEFORE deciding whether a daemon is already running", async () => {
		// Order is the fix. Asserting on order rather than "was called" is what
		// makes this a regression test: moving the reap back below the check puts
		// the calls in the other sequence and this fails.
		const calls: string[] = [];
		reapSpy.mockImplementation(() => {
			calls.push("reap");
			return { killed: [], skipped: [] };
		});
		runningSpy.mockImplementation(() => {
			calls.push("isRunning");
			return { running: true, pid: 1 };
		});

		await harnessStartCommand({ json: true });

		expect(calls).toEqual(["reap", "isRunning"]);
	});

	it("reports the orphans it reaped alongside the already-running notice", async () => {
		reapSpy.mockImplementation(() => ({ killed: ["9829"], skipped: [] }));
		runningSpy.mockImplementation(() => ({ running: true, pid: 56509 }));

		await harnessStartCommand({ json: true });

		// Observable output, not just a spy call: the operator has to be able to
		// SEE that memory was reclaimed, which is the whole point of reaping here.
		const out = logged.join("\n");
		expect(out).toContain("9829");
		expect(out).toContain("56509");
	});

	it("says nothing about orphans when there were none", async () => {
		reapSpy.mockImplementation(() => ({ killed: [], skipped: [] }));
		runningSpy.mockImplementation(() => ({ running: true, pid: 42 }));

		await harnessStartCommand({});

		expect(logged.join("\n")).not.toContain("reaped");
	});
});
