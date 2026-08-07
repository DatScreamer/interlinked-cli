import { describe, expect, it, vi } from "vitest";
import { type AntiStompDeps, loseAntiStompRace, reapZombieIncumbent } from "./anti-stomp.js";

function makeDeps(): AntiStompDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		logAlways: vi.fn(() => calls.push("log")),
		recordExit: vi.fn(() => calls.push("recordExit")),
		exit: vi.fn(() => calls.push("exit")),
	};
}

describe("loseAntiStompRace", () => {
	it("logs, records the ledger exit, then exits — in that exact order (must fire)", () => {
		const deps = makeDeps();
		loseAntiStompRace({ ownerPid: 4242, detail: "the raw socket", cwd: "/repo", deps });

		expect(deps.calls).toEqual(["log", "recordExit", "exit"]);
		expect(deps.logAlways).toHaveBeenCalledTimes(1);
		expect(deps.recordExit).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	it("includes the owner pid, the contested detail, and the cwd in the logged message", () => {
		const deps = makeDeps();
		loseAntiStompRace({
			ownerPid: 9999,
			detail: 'the framed session "default"',
			cwd: "/Users/x/project",
			deps,
		});

		const logged = String(vi.mocked(deps.logAlways).mock.calls[0]?.[0]);
		expect(logged).toContain("PID 9999");
		expect(logged).toContain('the framed session "default"');
		expect(logged).toContain("/Users/x/project");
		expect(logged).toContain("interlinked harness restart");
	});

	it("still calls recordExit and exit even though the log message differs per call (must not skip on differing input)", () => {
		// Negative-shape case: a caller passing an unusual detail string
		// (empty, or containing the ownerPid's own digits) must not
		// short-circuit the contract — recordExit/exit are unconditional.
		const deps = makeDeps();
		loseAntiStompRace({ ownerPid: 1, detail: "", cwd: "", deps });
		expect(deps.recordExit).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	it("propagates a throwing exit() (the real process.exit test-double shape) rather than swallowing it", () => {
		// Test doubles for `process.exit` in this codebase throw a sentinel
		// (see server.test.ts's ProcessExitError) since a real exit() never
		// returns. loseAntiStompRace must not catch that — a caller relying
		// on "exit() throws to unwind the stack" needs it to actually
		// propagate, and recordExit must already have run by then.
		const deps = makeDeps();
		const boom = new Error("process.exit(0)");
		vi.mocked(deps.exit).mockImplementation(() => {
			deps.calls.push("exit");
			throw boom;
		});
		expect(() =>
			loseAntiStompRace({ ownerPid: 7, detail: "the raw socket", cwd: "/x", deps }),
		).toThrow(boom);
		expect(deps.calls).toEqual(["log", "recordExit", "exit"]);
	});
});

describe("reapZombieIncumbent", () => {
	it("SIGTERMs the given pid", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const logAlways = vi.fn();
		reapZombieIncumbent(4242, logAlways);
		expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
		expect(logAlways).not.toHaveBeenCalled();
		killSpy.mockRestore();
	});

	it("silently ignores ESRCH (the pid was already gone by the time we signalled it)", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
			err.code = "ESRCH";
			throw err;
		});
		const logAlways = vi.fn();
		expect(() => reapZombieIncumbent(4242, logAlways)).not.toThrow();
		expect(logAlways).not.toHaveBeenCalled();
		killSpy.mockRestore();
	});

	it("logs (but does not throw) on an unexpected signalling failure, e.g. EPERM", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			const err = new Error("kill EPERM") as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
		});
		const logAlways = vi.fn();
		expect(() => reapZombieIncumbent(4242, logAlways)).not.toThrow();
		expect(logAlways).toHaveBeenCalledTimes(1);
		expect(String(logAlways.mock.calls[0]?.[0])).toContain("4242");
		killSpy.mockRestore();
	});
});
