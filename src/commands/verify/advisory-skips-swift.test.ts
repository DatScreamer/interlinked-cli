import { describe, expect, it } from "vitest";
import { SWIFT_ADVISORY_SKIP_IDS } from "./advisory-skips-swift.js";

describe("SWIFT_ADVISORY_SKIP_IDS", () => {
	it("P1: contains the ten swift/iOS advisory-skip ids", () => {
		expect(SWIFT_ADVISORY_SKIP_IDS).toEqual([
			"swift_unhandled_task_error",
			"swift_global_var_no_isolation",
			"swift_self_in_escaping_closure",
			"swift_notification_observer_no_removal",
			"swift_timer_no_invalidate",
			"swift_combine_no_store",
			"swift_try_question_discarded",
			"swift_fatalerror_in_guard",
			"swift_print_in_view_body",
			"swift_abbreviations",
		]);
	});

	it("P2: every id is unique and snake_case", () => {
		expect(new Set(SWIFT_ADVISORY_SKIP_IDS).size).toBe(SWIFT_ADVISORY_SKIP_IDS.length);
		for (const id of SWIFT_ADVISORY_SKIP_IDS) expect(id).toMatch(/^[a-z0-9_]+$/);
	});

	it("N1: does not include a non-swift advisory id", () => {
		expect(SWIFT_ADVISORY_SKIP_IDS).not.toContain("cognitive_complexity");
	});
});
