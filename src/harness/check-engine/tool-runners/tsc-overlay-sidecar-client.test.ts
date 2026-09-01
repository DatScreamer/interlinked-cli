// Daemon-side sidecar client. Failure-mode coverage mocks node:child_process
// (crash / timeout / malformed reply / missing binary / consecutive-failure
// cooldown); the real-process round trip lives in
// tsc-overlay-sidecar-main.test.ts (this file trusts spawnSync's contract,
// not the sidecar's own logic).

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

async function importClient() {
	return await import("./tsc-overlay-sidecar-client.js");
}

function ok(stdout: string): SpawnSyncReturns<string> {
	return { status: 0, signal: null, stdout, stderr: "", pid: 1, output: [null, stdout, ""] };
}

function crashed(): SpawnSyncReturns<string> {
	return { status: 1, signal: null, stdout: "", stderr: "boom", pid: 1, output: [null, "", "boom"] };
}

function timedOut(): SpawnSyncReturns<string> {
	return { status: null, signal: "SIGTERM", stdout: "", stderr: "", pid: 1, output: [null, "", ""] };
}

function missingBinary(): SpawnSyncReturns<string> {
	return {
		status: null,
		signal: null,
		stdout: "",
		stderr: "",
		pid: 0,
		output: [null, "", ""],
		error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
	};
}

const INPUT = { projectRoot: "/tmp/proj", filePath: "/tmp/proj/a.ts", content: "export const x = 1;\n" };

describe("tsc-overlay-sidecar-client", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		spawnSyncMock.mockReset();
		vi.resetModules();
		warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	// kind: public-api — positive (must fire)
	it("P1: a well-formed sidecar reply returns its CheckResult[] verbatim", async () => {
		const finding = { tool: "tsc", severity: "error", file: "a.ts", line: 1, message: "boom" };
		spawnSyncMock.mockReturnValue(ok(`${JSON.stringify({ id: 1, result: [finding] })}\n`));
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([finding]);
	});

	// kind: boundary — negative (must not fire / degrade gracefully)
	it("N1: missing sidecar binary degrades to [] with one stderr warning", async () => {
		spawnSyncMock.mockReturnValue(missingBinary());
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// kind: boundary — negative (must not fire / degrade gracefully)
	it("N2: a crashed sidecar (nonzero exit) degrades to [] with one warning", async () => {
		spawnSyncMock.mockReturnValue(crashed());
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// kind: boundary — negative (must not fire / degrade gracefully)
	it("N3: a timed-out sidecar degrades to [] with one warning", async () => {
		spawnSyncMock.mockReturnValue(timedOut());
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// kind: boundary — negative (must not fire / degrade gracefully)
	it("N4: a malformed (non-JSON) reply degrades to [] with one warning", async () => {
		spawnSyncMock.mockReturnValue(ok("not json at all\n"));
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// kind: boundary — negative (must not fire / degrade gracefully)
	it("N5: an explicit {id,error} reply degrades to [] with one warning", async () => {
		spawnSyncMock.mockReturnValue(ok(`${JSON.stringify({ id: 1, error: "sidecar: broke" })}\n`));
		const { runOverlayViaSidecar } = await importClient();
		expect(runOverlayViaSidecar(INPUT)).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	// kind: invariant — positive (must fire)
	it("P2: N consecutive failures trip a cooldown that short-circuits spawnSync entirely", async () => {
		spawnSyncMock.mockReturnValue(crashed());
		const { runOverlayViaSidecar, SIDECAR_MAX_CONSECUTIVE_FAILURES } = await importClient();
		for (let i = 0; i < SIDECAR_MAX_CONSECUTIVE_FAILURES; i++) {
			runOverlayViaSidecar(INPUT);
		}
		const callsBeforeCooldown = spawnSyncMock.mock.calls.length;
		expect(callsBeforeCooldown).toBe(SIDECAR_MAX_CONSECUTIVE_FAILURES);
		const result = runOverlayViaSidecar(INPUT);
		expect(result).toEqual([]);
		// Cooldown short-circuits BEFORE spawning again.
		expect(spawnSyncMock.mock.calls.length).toBe(callsBeforeCooldown);
	});

	// ───────────────────────────────────────────────
	// Typed contract (runOverlayViaSidecarTyped) — every failure mode must be
	// DISTINGUISHABLE from "checked clean": {status:"unavailable", reason},
	// never []. This is the review-mandated fix for the false-clean defect
	// (multi-edit accepting type errors when the sidecar timed out).
	// ───────────────────────────────────────────────

	// kind: public-api — positive (must fire)
	it("P4: typed: a timed-out sidecar returns status unavailable with a signal reason", async () => {
		spawnSyncMock.mockReturnValue(timedOut());
		const { runOverlayViaSidecarTyped } = await importClient();
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.status === "unavailable" && outcome.reason).toMatch(/signal/);
	});

	// kind: public-api — positive (must fire)
	it("P5: typed: a spawn failure (missing binary) returns status unavailable", async () => {
		spawnSyncMock.mockReturnValue(missingBinary());
		const { runOverlayViaSidecarTyped } = await importClient();
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.status === "unavailable" && outcome.reason).toMatch(/spawn failed/);
	});

	// kind: public-api — positive (must fire)
	it("P6: typed: a malformed reply returns status unavailable", async () => {
		spawnSyncMock.mockReturnValue(ok("not json at all\n"));
		const { runOverlayViaSidecarTyped } = await importClient();
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.status === "unavailable" && outcome.reason).toMatch(/malformed/);
	});

	// kind: invariant — positive (must fire)
	it("P7: typed: cooldown returns status unavailable WITHOUT spawning", async () => {
		spawnSyncMock.mockReturnValue(crashed());
		const { runOverlayViaSidecarTyped, SIDECAR_MAX_CONSECUTIVE_FAILURES } = await importClient();
		for (let i = 0; i < SIDECAR_MAX_CONSECUTIVE_FAILURES; i++) {
			runOverlayViaSidecarTyped(INPUT);
		}
		const callsBefore = spawnSyncMock.mock.calls.length;
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome.status).toBe("unavailable");
		expect(outcome.status === "unavailable" && outcome.reason).toMatch(/cooldown/);
		expect(spawnSyncMock.mock.calls.length).toBe(callsBefore);
	});

	// kind: public-api — negative (must not fire)
	it("N6: typed: a well-formed reply returns status ok with the findings", async () => {
		const finding = { tool: "tsc", severity: "error", file: "a.ts", line: 1, message: "boom" };
		spawnSyncMock.mockReturnValue(ok(`${JSON.stringify({ id: 1, result: [finding] })}\n`));
		const { runOverlayViaSidecarTyped } = await importClient();
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome).toEqual({ status: "ok", findings: [finding] });
	});

	it("returns typed unavailable without spawning while the project compiler is busy", async () => {
		const { runWithProjectCompilerLease } = await import("../../project-compiler-gate.js");
		let finish = (): void => undefined;
		const barrier = new Promise<void>((resolveBarrier) => {
			finish = resolveBarrier;
		});
		const active = runWithProjectCompilerLease(INPUT.projectRoot, () => barrier);
		await Promise.resolve();
		const { runOverlayViaSidecarTyped } = await importClient();
		const outcome = runOverlayViaSidecarTyped(INPUT);
		expect(outcome).toEqual({
			status: "unavailable",
			reason: "sidecar deferred: another TypeScript compiler is already running for this project",
		});
		expect(spawnSyncMock).not.toHaveBeenCalled();
		finish();
		await active;
	});

	// kind: invariant — positive (must fire)
	it("P3: a success after failures resets the consecutive-failure counter", async () => {
		const { runOverlayViaSidecar, SIDECAR_MAX_CONSECUTIVE_FAILURES } = await importClient();
		spawnSyncMock.mockReturnValue(crashed());
		for (let i = 0; i < SIDECAR_MAX_CONSECUTIVE_FAILURES - 1; i++) {
			runOverlayViaSidecar(INPUT);
		}
		spawnSyncMock.mockReturnValue(ok(`${JSON.stringify({ id: 1, result: [] })}\n`));
		runOverlayViaSidecar(INPUT); // success — resets the counter
		spawnSyncMock.mockReturnValue(crashed());
		const callsBefore = spawnSyncMock.mock.calls.length;
		for (let i = 0; i < SIDECAR_MAX_CONSECUTIVE_FAILURES - 1; i++) {
			runOverlayViaSidecar(INPUT);
		}
		// Still under the cap post-reset — every one of these calls actually spawned.
		expect(spawnSyncMock.mock.calls.length).toBe(callsBefore + (SIDECAR_MAX_CONSECUTIVE_FAILURES - 1));
	});
});
