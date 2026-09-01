import { describe, expect, it } from "vitest";
import { AsyncFindingQueue } from "../async-finding-queue.js";
import { createMutationFindingSessionDelivery } from "./mutation-cloud-v3-session-delivery.js";

const NOW_MS = Date.parse("2026-08-31T18:00:00.000Z");
const OUTBOX_ID = `9:${"a".repeat(64)}`;

function sessionSource(...sessionIds: string[]): { getAll(): Array<{ session_id: string }> } {
	return { getAll: () => sessionIds.map((session_id) => ({ session_id })) };
}

function delivered(message = "[interlinked:mutation] adverse result") {
	return { kind: "delivered" as const, outboxId: OUTBOX_ID, message };
}

describe("createMutationFindingSessionDelivery", () => {
	it("does nothing when no session is currently active", () => {
		const queue = new AsyncFindingQueue({ now: () => NOW_MS });
		const notify = createMutationFindingSessionDelivery({
			sessions: sessionSource(),
			queue,
			clock: () => NOW_MS,
		});

		expect(notify(delivered())).toBe(0);
		expect(queue.pending("missing")).toEqual([]);
	});

	it("enqueues one deferred finding for every distinct active session", () => {
		const queue = new AsyncFindingQueue({ now: () => NOW_MS });
		const notify = createMutationFindingSessionDelivery({
			sessions: sessionSource("session-a", "session-b", "session-a"),
			queue,
			clock: () => NOW_MS,
		});

		expect(notify(delivered())).toBe(2);
		for (const sessionId of ["session-a", "session-b"]) {
			expect(queue.pending(sessionId)).toEqual([{
				id: `mutation.finding:${OUTBOX_ID}`,
				check: "mutation_cloud_v3",
				message: "[interlinked:mutation] adverse result",
				computedAt: "2026-08-31T18:00:00.000Z",
			}]);
		}
	});

	it("uses the stable outbox id so an at-least-once duplicate replaces the queued copy", () => {
		const queue = new AsyncFindingQueue({ now: () => NOW_MS });
		const notify = createMutationFindingSessionDelivery({
			sessions: sessionSource("session-a"),
			queue,
			clock: () => NOW_MS,
		});

		notify(delivered("first attempt"));
		notify(delivered("retry attempt"));

		expect(queue.pending("session-a")).toHaveLength(1);
		expect(queue.pending("session-a")[0]).toMatchObject({
			id: `mutation.finding:${OUTBOX_ID}`,
			message: "retry attempt",
		});
	});
});
