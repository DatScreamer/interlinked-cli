import { afterEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "./cohort.js";
import {
	type ReservationLogEvent,
	ReservationManager,
} from "./reservations.js";

function join(cohort: CohortManager, agentName: string): void {
	cohort.agentJoined({
		hook_event: "SessionStart",
		session_id: `session-${agentName}`,
		agent_source: "codex",
		agent_name: agentName,
		timestamp: "2026-08-30T00:00:00.000Z",
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ReservationManager.checkAndReserveBatch", () => {
	it("aborts before every grant when any conflict is blocking", () => {
		const cohort = new CohortManager();
		const events: ReservationLogEvent[] = [];
		const reservations = new ReservationManager(undefined, 30_000, (event) => events.push(event));
		reservations.checkAndReserve("/repo/b.ts", "remote-holder", cohort);
		events.length = 0;

		const result = reservations.checkAndReserveBatch({
			filePaths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			agentName: "writer",
			cohort,
			shouldBlock: (_filePath, conflict) => conflict.cohort === "remote",
		});

		expect(result?.filePath).toBe("/repo/b.ts");
		expect(result?.conflict.agent_name).toBe("remote-holder");
		expect(reservations.getAll().map((entry) => entry.file_pattern)).toEqual(["/repo/b.ts"]);
		expect(events.filter((event) => event.action === "grant")).toEqual([]);
	});

	it("skips warning-only conflicts while granting every free path", () => {
		const cohort = new CohortManager();
		join(cohort, "sibling");
		const reservations = new ReservationManager();
		reservations.checkAndReserve("/repo/b.ts", "sibling", cohort);
		const shouldBlock = vi.fn(() => false);

		const result = reservations.checkAndReserveBatch({
			filePaths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
			agentName: "writer",
			cohort,
			shouldBlock,
		});

		expect(result).toBeNull();
		expect(shouldBlock).toHaveBeenCalledWith(
			"/repo/b.ts",
			expect.objectContaining({ agent_name: "sibling", cohort: "local" }),
		);
		expect(
			reservations.getForAgent("writer").map((entry) => entry.file_pattern).sort(),
		).toEqual(["/repo/a.ts", "/repo/c.ts"]);
	});

	it("de-duplicates a conflict-free target list before granting", () => {
		const cohort = new CohortManager();
		const events: ReservationLogEvent[] = [];
		const reservations = new ReservationManager(undefined, 30_000, (event) => events.push(event));

		expect(
			reservations.checkAndReserveBatch({
				filePaths: ["/repo/a.ts", "/repo/a.ts", "/repo/b.ts"],
				agentName: "writer",
				cohort,
				shouldBlock: () => true,
			}),
		).toBeNull();
		expect(reservations.getForAgent("writer")).toHaveLength(2);
		expect(events.filter((event) => event.action === "grant")).toHaveLength(2);
	});
});

describe("ReservationManager reacquisition", () => {
	it("cancels an older idle timer before renewing an owned lease", () => {
		vi.useFakeTimers();
		const cohort = new CohortManager();
		const reservations = new ReservationManager();
		reservations.checkAndReserve("/repo/a.ts", "writer", cohort);
		reservations.scheduleRelease("/repo/a.ts", "writer", cohort);
		vi.advanceTimersByTime(29_000);

		expect(reservations.checkAndReserve("/repo/a.ts", "writer", cohort)).toBeNull();
		vi.advanceTimersByTime(2_000);
		expect(reservations.getForAgent("writer")).toHaveLength(1);

		reservations.scheduleRelease("/repo/a.ts", "writer", cohort);
		vi.advanceTimersByTime(29_999);
		expect(reservations.getForAgent("writer")).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(reservations.getForAgent("writer")).toEqual([]);
	});
});
