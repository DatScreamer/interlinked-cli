import { describe, expect, it } from "vitest";
import { mapActivityLine } from "./event-stream.js";

describe("viz parent identity projection", () => {
	it("copies a non-empty parent_agent from an activity row", () => {
		const event = mapActivityLine(
			JSON.stringify({
				ts: "2026-08-30T10:00:00Z",
				type: "tool_use",
				agent: "child-task",
				session: "root-session",
				subagent_id: "child-thread",
				parent_agent: "root-session",
			}),
		);

		expect(event?.parent_agent).toBe("root-session");
	});
});
