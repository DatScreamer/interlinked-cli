import { describe, expect, it } from "vitest";
import type { DaemonLedgerEvent } from "./daemon-ledger.js";
import {
	HANDOVER_CHURN_MAX_ATTEMPTS,
	HANDOVER_CHURN_WINDOW_MS,
	churnBackstopEvent,
	handoverChurnExceeded,
	netUnresolvedHandovers,
} from "./handover-churn.js";

function handover(at: number, reason = "build-refresh"): DaemonLedgerEvent {
	return { at, pid: 1, event: "handover", reason };
}

function listening(at: number): DaemonLedgerEvent {
	return { at, pid: 2, event: "listening" };
}

describe("netUnresolvedHandovers — positive (must count unresolved rows)", () => {
	it("counts a handover with no matching listening row", () => {
		expect(netUnresolvedHandovers([handover(1_000)], 2_000)).toBe(1);
	});

	it("counts multiple unresolved handovers", () => {
		const events = [handover(1_000), handover(1_500), handover(1_800)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(3);
	});

	it("ignores events outside the window", () => {
		const nowMs = 100_000;
		const events = [handover(nowMs - HANDOVER_CHURN_WINDOW_MS - 1)];
		expect(netUnresolvedHandovers(events, nowMs)).toBe(0);
	});

	it("ignores events after nowMs", () => {
		expect(netUnresolvedHandovers([handover(5_000)], 1_000)).toBe(0);
	});
});

describe("netUnresolvedHandovers — negative (must not count resolved rows)", () => {
	it("nets out a handover followed by a listening row", () => {
		const events = [handover(1_000), listening(1_200)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	it("never goes negative when listening rows outnumber handovers", () => {
		const events = [listening(1_000), listening(1_200)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	it("ignores other event kinds entirely", () => {
		const events: DaemonLedgerEvent[] = [
			{ at: 1_000, pid: 1, event: "start" },
			{ at: 1_100, pid: 1, event: "exit", reason: "signal" },
			{ at: 1_200, pid: 1, event: "spike" },
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});
});

describe("handoverChurnExceeded — positive (must fire)", () => {
	it("trips once unresolved handovers reach the max", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(true);
	});

	it("trips past the max, not just at it", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS + 3 }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(true);
	});

	it("respects a custom threshold argument", () => {
		const events = [handover(1_000), handover(1_100)];
		expect(handoverChurnExceeded(events, 2_000, 2)).toBe(true);
	});
});

describe("handoverChurnExceeded — negative (must not fire)", () => {
	it("stays clear one attempt below the max", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS - 1 }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(false);
	});

	it("stays clear once every attempt resolved with a listening row", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS + 2 }, (_, i) => [
			handover(1_000 + i * 10),
			listening(1_005 + i * 10),
		]).flat();
		expect(handoverChurnExceeded(events, 10_000)).toBe(false);
	});

	it("stays clear once stale attempts age out of the window", () => {
		const nowMs = 1_000_000;
		const events = Array.from(
			{ length: HANDOVER_CHURN_MAX_ATTEMPTS + 2 },
			(_, i) => handover(nowMs - HANDOVER_CHURN_WINDOW_MS - 1_000 - i),
		);
		expect(handoverChurnExceeded(events, nowMs)).toBe(false);
	});
});

describe("churnBackstopEvent", () => {
	it("builds a handover row tagged churn-backstop with the given detail", () => {
		const evt = churnBackstopEvent(4242, 5_000, "rss-ceiling suppressed");
		expect(evt).toEqual({
			at: 5_000,
			pid: 4242,
			event: "handover",
			reason: "churn-backstop",
			detail: "rss-ceiling suppressed",
		});
	});
});
