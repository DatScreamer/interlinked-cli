// Smoke tests for the split check-metadata constants. Verifies each file
// exports a non-empty record with the expected CheckMeta shape.

import { describe, expect, it } from "vitest";
import { BEHAVIORAL_CHECK_META } from "./behavioral.js";
import { GENERIC_CHECK_META } from "./generic.js";
import { QUALITY_CHECK_META } from "./quality.js";
import { STRUCTURAL_CHECK_META } from "./structural.js";
import { SUGGESTION_CHECK_META } from "./suggestion.js";

const ALL = {
	behavioral: BEHAVIORAL_CHECK_META,
	generic: GENERIC_CHECK_META,
	quality: QUALITY_CHECK_META,
	structural: STRUCTURAL_CHECK_META,
	suggestion: SUGGESTION_CHECK_META,
} as const;

describe("check-metadata (smoke)", () => {
	for (const [label, meta] of Object.entries(ALL)) {
		it(`${label} exports a non-empty record`, () => {
			const keys = Object.keys(meta);
			expect(keys.length).toBeGreaterThan(0);
		});

		it(`${label} entries have the CheckMeta shape`, () => {
			for (const [id, entry] of Object.entries(meta)) {
				expect(typeof entry.name, `${id}.name`).toBe("string");
				expect(typeof entry.description, `${id}.description`).toBe("string");
				expect([1, 2, 3], `${id}.tier`).toContain(entry.tier);
				expect(
					["fully_deterministic", "partially_deterministic", "heuristic"],
					`${id}.determinism`,
				).toContain(entry.determinism);
			}
		});
	}
});
