import { describe, expect, it } from "vitest";
import type { DaemonLedgerEvent } from "./daemon-ledger.js";
import { detectEnforcementGaps, formatEnforcementGapWarning } from "./enforcement-gap.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Each daemon gets its OWN pid, as in a real ledger — recovery is detected by
 *  a start whose pid never exits, so sharing one pid across every event makes
 *  the fixture describe a situation that cannot occur. */
let nextPid = 1000;
const ev = (
	offsetMin: number,
	event: DaemonLedgerEvent["event"],
	reason?: string,
	pid = nextPid++,
): DaemonLedgerEvent => ({
	at: T0 + offsetMin * MIN,
	pid,
	event,
	...(reason ? { reason } : {}),
});

describe("detectEnforcementGaps — positive (must fire)", () => {
	it("P1: reports a closed outage between an exit and the next listen", () => {
		const gaps = detectEnforcementGaps([ev(0, "listening"), ev(10, "exit", "crash"), ev(25, "listening")], T0 + 30 * MIN);
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.ms).toBe(15 * MIN);
		expect(gaps[0]?.to).toBe(T0 + 25 * MIN);
		expect(gaps[0]?.kind).toBe("down");
		expect(gaps[0]?.reasons).toEqual(["crash"]);
	});

	it("P2: reports an ONGOING outage measured against now", () => {
		const gaps = detectEnforcementGaps([ev(0, "listening"), ev(5, "exit", "rss-ceiling")], T0 + 65 * MIN);
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.to).toBeNull();
		expect(gaps[0]?.ms).toBe(60 * MIN);
	});

	it("P3: classifies repeated failed revives as thrash, not a plain outage", () => {
		// The real anti-stomp deadlock: start/exit pairs, never a `listening`.
		const events = [ev(0, "listening"), ev(1, "exit", "crash")];
		for (let i = 2; i < 20; i++) {
			// Same pid for the start and its exit — that pairing IS the thrash.
			const pid = 2000 + i;
			events.push(ev(i, "start", undefined, pid), ev(i, "exit", "anti-stomp", pid));
		}
		const gaps = detectEnforcementGaps(events, T0 + 30 * MIN);
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.kind).toBe("thrash");
		// Most frequent reason first — anti-stomp dominates the single crash.
		expect(gaps[0]?.reasons[0]).toBe("anti-stomp");
	});
});

describe("detectEnforcementGaps — negative (must not fire)", () => {
	it("N1: ignores a brief restart below the reportable floor", () => {
		// A build-refresh handover lands in seconds; reporting it would be noise.
		const events: DaemonLedgerEvent[] = [
			{ at: T0, pid: 1, event: "listening" },
			{ at: T0 + 1000, pid: 1, event: "exit", reason: "build-refresh" },
			{ at: T0 + 4000, pid: 2, event: "listening" },
		];
		expect(detectEnforcementGaps(events, T0 + 10_000)).toEqual([]);
	});

	it("N2: returns nothing for continuous service", () => {
		expect(detectEnforcementGaps([ev(0, "listening"), ev(30, "listening")], T0 + 40 * MIN)).toEqual([]);
	});

	it("N3: returns nothing for an empty ledger", () => {
		expect(detectEnforcementGaps([], T0)).toEqual([]);
	});

	it("N4: closes a gap on a SURVIVING start, not only on `listening`", () => {
		// Regression pin. `listening` is declared in DaemonEventKind but nothing
		// emits it — this repo's ledger holds 2348 start / 2348 exit / 0
		// listening. Keying recovery on `listening` made the detector report a
		// permanent outage on every repo: a mechanism that cannot produce a
		// negative result, which is the exact defect class this module reports.
		const events: DaemonLedgerEvent[] = [
			{ at: T0, pid: 1, event: "exit", reason: "crash" },
			// pid 2 starts and never exits — it is the live daemon.
			{ at: T0 + 90 * MIN, pid: 2, event: "start" },
		];
		const gaps = detectEnforcementGaps(events, T0 + 120 * MIN);
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.to).toBe(T0 + 90 * MIN);
		expect(formatEnforcementGapWarning(gaps, T0 + 120 * MIN)).toContain("were off");
	});

	it("N5: a start whose pid later exits does NOT count as recovery", () => {
		// The anti-stomp thrash: every start is followed by that pid exiting.
		const events: DaemonLedgerEvent[] = [
			{ at: T0, pid: 1, event: "exit", reason: "crash" },
			{ at: T0 + 10 * MIN, pid: 2, event: "start" },
			{ at: T0 + 10 * MIN, pid: 2, event: "exit", reason: "anti-stomp" },
		];
		const gaps = detectEnforcementGaps(events, T0 + 70 * MIN);
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.to).toBeNull();
	});
});

describe("formatEnforcementGapWarning", () => {
	it("P1: an ongoing gap states the consequence and the recovery", () => {
		const gaps = detectEnforcementGaps([ev(0, "listening"), ev(5, "exit", "crash")], T0 + 125 * MIN);
		const msg = formatEnforcementGapWarning(gaps, T0 + 125 * MIN);
		expect(msg).toContain("Gates have been OFF for 2h00m");
		expect(msg).toContain("UNCHECKED");
		expect(msg).toContain("harness reap");
	});

	it("P2: an ongoing thrash names the anti-stomp cause rather than a reason code", () => {
		const events = [ev(0, "listening"), ev(1, "exit", "anti-stomp")];
		for (let i = 2; i < 20; i++) {
			const pid = 3000 + i;
			events.push(ev(i, "start", undefined, pid), ev(i, "exit", "anti-stomp", pid));
		}
		const msg = formatEnforcementGapWarning(detectEnforcementGaps(events, T0 + 90 * MIN), T0 + 90 * MIN);
		expect(msg).toContain("auto-revive is losing every race");
	});

	it("P3: closed gaps report the total and tell the agent to re-verify", () => {
		const gaps = detectEnforcementGaps(
			[ev(0, "listening"), ev(10, "exit", "crash"), ev(80, "listening")],
			T0 + 90 * MIN,
		);
		const msg = formatEnforcementGapWarning(gaps, T0 + 90 * MIN);
		expect(msg).toContain("Gates were off for 1h10m");
		expect(msg).toContain("interlinked verify");
	});

	it("N1: returns null when enforcement was continuous", () => {
		expect(formatEnforcementGapWarning([], T0)).toBeNull();
	});
});
