import { describe, expect, it } from "vitest";

import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { noopSequenceDetector } from "./_placeholder.js";

describe("noopSequenceDetector", () => {
	it("returns an empty array regardless of trajectory or candidate", () => {
		const session = {} as unknown as SessionTrajectory;
		const event = { hook_event: "PreToolUse" } as unknown as HarnessEvent;
		expect(noopSequenceDetector.fn(session, event)).toEqual([]);
	});

	it("is disabled by default", () => {
		expect(noopSequenceDetector.default_enabled).toBe(false);
	});

	it("declares fully_deterministic determinism", () => {
		expect(noopSequenceDetector.determinism).toBe("fully_deterministic");
	});
});
