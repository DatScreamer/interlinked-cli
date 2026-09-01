// ===========================================
// harness-restart-guard — restart trigger vs. in-flight start
// ===========================================
// Root cause (2026-08-22 postmortem): `harnessRestartCommand` used to call
// `stopRunningHarnessForRestart` unconditionally, so any two overlapping
// restart triggers (a build-refresh handover, an rss-ceiling recycle, a
// human re-running the command) fought over the same daemon — whichever
// trigger ran second SIGTERM'd a successor the first had JUST spawned,
// before it reached `listening`. These tests pin `resolveRestartAction`'s
// three verdicts and `reportRestartDecision`'s ledger + output contract for
// each.

import { describe, expect, it, vi } from "vitest";
import type { DaemonLedgerEvent } from "../harness/daemon-ledger.js";
import { HANDOVER_ATTEMPT_ENV, HANDOVER_CHURN_MAX_ATTEMPTS } from "../harness/handover-churn.js";
import {
	beginRestartAttempt,
	failRestartAttempt,
	reportRestartDecision,
	resolveRestartAction,
} from "./harness-restart-guard.js";

function churnedEvents(nowMs: number): DaemonLedgerEvent[] {
	return Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) => ({
		at: nowMs - 1_000 + i,
		pid: 1,
		event: "handover" as const,
		reason: "build-refresh",
	}));
}

describe("resolveRestartAction — positive (must fire)", () => {
	it("P1: an in-flight start that comes up defers as deferred-ready", async () => {
		const decision = await resolveRestartAction("/repo", 1_000, {
			inFlight: () => true,
			wait: async () => true,
			readEvents: () => [],
		});
		expect(decision).toEqual({ action: "deferred-ready" });
	});

	it("P2: an in-flight start that never answers defers as deferred-timeout", async () => {
		const decision = await resolveRestartAction("/repo", 1_000, {
			inFlight: () => true,
			wait: async () => false,
			readEvents: () => [],
		});
		expect(decision).toEqual({ action: "deferred-timeout" });
	});

	it("P3: excess unresolved handovers with no in-flight start back off", async () => {
		const nowMs = 100_000;
		const decision = await resolveRestartAction("/repo", nowMs, {
			inFlight: () => false,
			wait: async () => true,
			readEvents: () => churnedEvents(nowMs),
		});
		expect(decision).toEqual({ action: "backoff-churn" });
	});

	it("P4: in-flight takes priority over churn — waits, does not immediately back off", async () => {
		const nowMs = 100_000;
		const wait = vi.fn(async () => true);
		const decision = await resolveRestartAction("/repo", nowMs, {
			inFlight: () => true,
			wait,
			readEvents: () => churnedEvents(nowMs),
		});
		expect(decision).toEqual({ action: "deferred-ready" });
		expect(wait).toHaveBeenCalledTimes(1);
	});
});

describe("resolveRestartAction — negative (must not fire)", () => {
	it("N1: no in-flight start and no churn proceeds normally", async () => {
		const decision = await resolveRestartAction("/repo", 1_000, {
			inFlight: () => false,
			wait: async () => true,
			readEvents: () => [],
		});
		expect(decision).toEqual({ action: "proceed" });
	});

	it("N2: unresolved handovers just under the max still proceed", async () => {
		const nowMs = 100_000;
		const decision = await resolveRestartAction("/repo", nowMs, {
			inFlight: () => false,
			wait: async () => true,
			readEvents: () => churnedEvents(nowMs).slice(0, HANDOVER_CHURN_MAX_ATTEMPTS - 1),
		});
		expect(decision).toEqual({ action: "proceed" });
	});

	it("N3: default deps resolve without throwing (real startup-lock + ledger modules)", async () => {
		await expect(resolveRestartAction("/nonexistent-repo-path")).resolves.toEqual({ action: "proceed" });
	});
});

describe("reportRestartDecision", () => {
	it("records deferred-to-inflight and reports nothing-to-restart for deferred-ready", () => {
		const recorded: DaemonLedgerEvent[] = [];
		reportRestartDecision(
			"json",
			"/repo",
			{ action: "deferred-ready" },
			{ recordEvent: (evt) => recorded.push(evt) },
		);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ event: "handover", reason: "deferred-to-inflight" });
	});

	it("records churn-backstop and reports the threshold error for backoff-churn", () => {
		const recorded: DaemonLedgerEvent[] = [];
		const errs: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errs.push(a.join(" "));
		});
		reportRestartDecision(
			"normal",
			"/repo",
			{ action: "backoff-churn" },
			{ recordEvent: (evt) => recorded.push(evt) },
		);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ event: "handover", reason: "churn-backstop" });
		expect(errs.join(" ")).toContain("Too many restart attempts");
		vi.restoreAllMocks();
	});

	it("records deferred-timeout for the wedged-holder fallback", () => {
		const recorded: DaemonLedgerEvent[] = [];
		reportRestartDecision(
			"json",
			"/repo",
			{ action: "deferred-timeout" },
			{ recordEvent: (evt) => recorded.push(evt) },
		);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({ event: "handover", reason: "deferred-timeout" });
	});

	// test-contract: invariant — terminal verdicts (deferred-ready, backoff)
	// carry the attempt id AND the resolving `refused` outcome; the wedged-
	// holder fallback stays non-terminal `requested` because the flow proceeds.
	it("P: verdict rows carry the attempt id and the right outcome", () => {
		const rows: DaemonLedgerEvent[] = [];
		const deps = { recordEvent: (evt: DaemonLedgerEvent) => rows.push(evt), attemptId: "abc12345" };
		reportRestartDecision("json", "/repo", { action: "deferred-ready" }, deps);
		reportRestartDecision("json", "/repo", { action: "deferred-timeout" }, deps);
		expect(rows[0]).toMatchObject({ outcome: "refused", attempt_id: "abc12345" });
		expect(rows[1]).toMatchObject({ outcome: "requested", attempt_id: "abc12345" });
	});

	it("P: the backoff verdict resolves the attempt with refused on the churn row", () => {
		const rows: DaemonLedgerEvent[] = [];
		vi.spyOn(console, "error").mockImplementation(() => {});
		reportRestartDecision(
			"normal",
			"/repo",
			{ action: "backoff-churn" },
			{ recordEvent: (evt) => rows.push(evt), attemptId: "abc12345" },
		);
		expect(rows[0]).toMatchObject({
			reason: "churn-backstop",
			outcome: "refused",
			attempt_id: "abc12345",
		});
		vi.restoreAllMocks();
	});
});

describe("beginRestartAttempt / failRestartAttempt — the CLI leg", () => {
	// test-contract: public-api — an inherited id (automatic handover) is
	// ADOPTED, kept in env for the daemon spawn, and stamped on the
	// non-counting intent row.
	it("P: adopts the inherited env id and writes the requested intent row", () => {
		const rows: DaemonLedgerEvent[] = [];
		const env: NodeJS.ProcessEnv = { [HANDOVER_ATTEMPT_ENV]: "feed5eed" };
		const id = beginRestartAttempt("/repo", { recordEvent: (evt) => rows.push(evt), env });
		expect(id).toBe("feed5eed");
		expect(env[HANDOVER_ATTEMPT_ENV]).toBe("feed5eed");
		expect(rows[0]).toMatchObject({
			event: "handover",
			reason: "explicit-restart",
			outcome: "requested",
			attempt_id: "feed5eed",
		});
	});

	// test-contract: public-api — a manual restart (no inherited id) mints one
	// and SETS it in env so the daemon spawn inherits it.
	it("P: mints an id for a manual restart and threads it via env", () => {
		const rows: DaemonLedgerEvent[] = [];
		const env: NodeJS.ProcessEnv = {};
		const id = beginRestartAttempt("/repo", { recordEvent: (evt) => rows.push(evt), env });
		expect(id).toMatch(/^[0-9a-f-]{8}$/);
		expect(env[HANDOVER_ATTEMPT_ENV]).toBe(id);
		expect(rows[0]?.attempt_id).toBe(id);
	});

	// test-contract: invariant — the survived-SIGKILL abort writes the
	// TERMINAL start_failed row so the attempt resolves.
	it("P: failRestartAttempt writes the terminal start_failed row", () => {
		const rows: DaemonLedgerEvent[] = [];
		failRestartAttempt("/repo", "feed5eed", "old daemon survived SIGKILL", {
			recordEvent: (evt) => rows.push(evt),
		});
		expect(rows[0]).toMatchObject({
			event: "handover",
			reason: "explicit-restart",
			outcome: "start_failed",
			attempt_id: "feed5eed",
			detail: "old daemon survived SIGKILL",
		});
	});
});
