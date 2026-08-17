// Harness liveness — the ROUND-TRIP verdict both diagnostics now depend on.
//
// The bug this module exists to close (audit F1, 2026-08-14): `harness status`
// and `doctor` judged the daemon by pid-liveness alone, so a process kept
// resident by crash-resilience with no listening socket was reported as
// healthy by both — while every tool call was failing closed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	queryHarness: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("./harness-process.js", () => ({
	getSocketPath: (cwd: string) => `${cwd}/.interlinked/harness.sock`,
}));
vi.mock("./harness-status-helpers.js", () => ({ queryHarness: mocks.queryHarness }));
// Identity colors so assertions compare words, not ANSI.
vi.mock("../lib/formatter.js", () => ({
	c: {
		green: (s: string) => s,
		red: (s: string) => s,
		yellow: (s: string) => s,
		dim: (s: string) => s,
		bold: (s: string) => s,
	},
}));

import {
	classifyHarnessLiveness,
	harnessServerRow,
	LIVENESS_PROBE_TIMEOUT_MS,
	livenessStatusValue,
	probeHarnessLive,
	probeHarnessSocket,
	zombieWarningLine,
} from "./harness-liveness.js";

beforeEach(() => {
	mocks.existsSync.mockReset();
	mocks.queryHarness.mockReset();
});

describe("classifyHarnessLiveness", () => {
	// P1: the state the whole fix exists for.
	it("calls a live pid with no answer a zombie", () => {
		expect(classifyHarnessLiveness({ processRunning: true, socketAnswered: false })).toBe(
			"zombie",
		);
	});

	// P2: an answer is proof, whatever the pid file says.
	it("calls an answering socket listening even when the pid file is stale", () => {
		expect(classifyHarnessLiveness({ processRunning: true, socketAnswered: true })).toBe(
			"listening",
		);
		expect(classifyHarnessLiveness({ processRunning: false, socketAnswered: true })).toBe(
			"listening",
		);
	});

	// N1: nothing running, nothing answering — the honest empty state.
	it("calls no pid and no answer stopped", () => {
		expect(classifyHarnessLiveness({ processRunning: false, socketAnswered: false })).toBe(
			"stopped",
		);
	});
});

describe("probeHarnessSocket", () => {
	// P1: a decision line back means the daemon is serving.
	it("returns true when the daemon answers", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await expect(probeHarnessSocket("/repo")).resolves.toBe(true);
		expect(mocks.queryHarness).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ hook_event: "StatusQuery" }),
			LIVENESS_PROBE_TIMEOUT_MS,
		);
	});

	// P2: connected (or timed out) with no answer is NOT serving.
	it("returns false when the query yields nothing", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue(null);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
	});

	// N1: no socket file → no dial at all.
	it("short-circuits without querying when the socket file is absent", async () => {
		mocks.existsSync.mockReturnValue(false);
		await expect(probeHarnessSocket("/repo")).resolves.toBe(false);
		expect(mocks.queryHarness).not.toHaveBeenCalled();
	});

	// P3: the caller's timeout is honored (a diagnostic must not hang).
	it("passes an explicit timeout through", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue(null);
		await probeHarnessSocket("/repo", 25);
		expect(mocks.queryHarness).toHaveBeenCalledWith("/repo", expect.anything(), 25);
	});
});

describe("probeHarnessLive", () => {
	// P1: an immediate answer costs exactly one round-trip.
	it("returns true on the first answer without re-probing", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(true);
		expect(mocks.queryHarness).toHaveBeenCalledTimes(1);
	});

	// P2: a daemon still binding (the `restart && status` window) answers on
	// the confirming probe — it must NOT be reported as a zombie.
	it("re-probes once when a live pid answered nothing, and accepts a late answer", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValueOnce(null).mockResolvedValueOnce({ decision: "allow" });
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(true);
		expect(mocks.queryHarness).toHaveBeenCalledTimes(2);
	});

	// P3: silent twice with a live pid is a real zombie.
	it("returns false when both probes are silent", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue(null);
		await expect(probeHarnessLive("/repo", true, 0)).resolves.toBe(false);
		expect(mocks.queryHarness).toHaveBeenCalledTimes(2);
	});

	// N1: with no live pid there is nothing to wait for — "not running" stays
	// instant, so the common case pays nothing for the zombie check.
	it("does not re-probe when no process is running", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue(null);
		await expect(probeHarnessLive("/repo", false, 0)).resolves.toBe(false);
		expect(mocks.queryHarness).toHaveBeenCalledTimes(1);
	});
});

describe("harnessServerRow", () => {
	// P1: pid + answer = pass, and the row says WHY it passed.
	it("passes when the socket answered", () => {
		expect(
			harnessServerRow({
				processRunning: true,
				pid: 42,
				socketExists: true,
				socketAnswered: true,
			}),
		).toEqual({ status: "pass", message: "Running (PID 42) -- socket answering" });
	});

	// P2: pid + silence = FAIL with the shared zombie wording.
	it("FAILS with the zombie message when a live pid answers nothing", () => {
		const row = harnessServerRow({
			processRunning: true,
			pid: 42,
			socketExists: true,
			socketAnswered: false,
		});
		expect(row.status).toBe("fail");
		expect(row.message).toBe(zombieWarningLine(42));
	});

	// N1: an un-probed caller keeps the pre-probe wording rather than being
	// handed a verdict nobody measured.
	it("keeps the plain running message when the caller did not probe", () => {
		expect(
			harnessServerRow({
				processRunning: true,
				pid: 42,
				socketExists: true,
				socketAnswered: undefined,
			}),
		).toEqual({ status: "pass", message: "Running (PID 42)" });
	});

	// N2/N3: the two not-running messages are unchanged.
	it("warns about a stale socket, then about the inline fallback", () => {
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: true,
				socketAnswered: false,
			}),
		).toEqual({
			status: "warn",
			message: "Stale socket found but process not running -- run 'interlinked harness start'",
		});
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: false,
				socketAnswered: false,
			}),
		).toEqual({
			status: "warn",
			message:
				"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
		});
	});

	// P3: an answering daemon with no pid file (framed-only) still passes.
	it("passes without a pid when something answered", () => {
		expect(
			harnessServerRow({
				processRunning: false,
				pid: undefined,
				socketExists: false,
				socketAnswered: true,
			}),
		).toEqual({ status: "pass", message: "Running -- socket answering" });
	});
});

describe("livenessStatusValue / zombieWarningLine", () => {
	// P1: each state gets distinct words; "running (PID …)" is reserved for a
	// verified listener.
	it("renders one distinct value per state", () => {
		expect(livenessStatusValue("listening", 9)).toBe("running (PID 9) — socket answering");
		expect(livenessStatusValue("zombie", 9)).toBe(
			"ZOMBIE — process alive (PID 9), no socket answering",
		);
		expect(livenessStatusValue("stopped", undefined)).toBe("not running");
	});

	// N1: an unknown pid degrades gracefully instead of printing "undefined".
	it("does not print a literal undefined pid", () => {
		expect(livenessStatusValue("zombie", undefined)).not.toContain("undefined");
		expect(zombieWarningLine(undefined)).not.toContain("undefined");
	});

	// P2: the warning states the consequence and the fix, in that order.
	it("names the consequence and the fix command", () => {
		const line = zombieWarningLine(31337);
		expect(line).toContain("Harness PID 31337");
		expect(line).toContain("guarding nothing");
		expect(line).toContain("interlinked harness restart");
	});
});
