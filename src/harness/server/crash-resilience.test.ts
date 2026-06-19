import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCrashResilience, logFatalButSurvive } from "./crash-resilience.js";

// Capture the process-listener baseline so each test cleans up only the
// handlers IT registered — never another test's (or the runner's own).
let baseUncaught: unknown[] = [];
let baseRejection: unknown[] = [];

beforeEach(() => {
	baseUncaught = process.listeners("uncaughtException");
	baseRejection = process.listeners("unhandledRejection");
});

afterEach(() => {
	for (const l of process.listeners("uncaughtException")) {
		if (!baseUncaught.includes(l)) process.removeListener("uncaughtException", l as () => void);
	}
	for (const l of process.listeners("unhandledRejection")) {
		if (!baseRejection.includes(l)) process.removeListener("unhandledRejection", l as () => void);
	}
	vi.restoreAllMocks();
});

describe("logFatalButSurvive", () => {
	it("logs an Error's stack with the daemon-log prefix and never throws", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => logFatalButSurvive("uncaughtException", new Error("boom"))).not.toThrow();
		expect(spy).toHaveBeenCalledTimes(1);
		const msg = String(spy.mock.calls[0]?.[0]);
		expect(msg).toContain("[interlinked-harness]");
		expect(msg).toContain("kept the daemon alive");
		expect(msg).toContain("boom");
	});

	it("stringifies a non-Error reason (unhandledRejection with a plain value)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		logFatalButSurvive("unhandledRejection", "string reason");
		expect(String(spy.mock.calls[0]?.[0])).toContain("string reason");
	});

	it("swallows a failure in the logger itself (last-resort catch) without throwing", () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("stderr is gone");
		});
		// The catch branch must absorb the logging failure — re-throwing here would
		// exit the daemon the handler exists to keep alive.
		expect(() => logFatalButSurvive("uncaughtException", new Error("x"))).not.toThrow();
	});
});

describe("installCrashResilience", () => {
	it("registers exactly one uncaughtException and one unhandledRejection listener", () => {
		const ue = process.listenerCount("uncaughtException");
		const ur = process.listenerCount("unhandledRejection");
		installCrashResilience();
		expect(process.listenerCount("uncaughtException")).toBe(ue + 1);
		expect(process.listenerCount("unhandledRejection")).toBe(ur + 1);
	});

	it("the registered handler logs and does NOT re-throw (daemon stays alive)", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		installCrashResilience();
		const handler = process.listeners("uncaughtException").at(-1) as (e: unknown) => void;
		expect(() => handler(new Error("async-throw"))).not.toThrow();
		expect(String(spy.mock.calls[0]?.[0])).toContain("async-throw");
	});
});
