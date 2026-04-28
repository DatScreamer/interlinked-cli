// ===========================================
// Detector fixture runner — canonical-examples per detector
// ===========================================
//
// Why this exists:
// Every regex-based detector in `src/harness/checks/` has a coverage cliff:
// the author writes the regex against the form they had in mind, and tests
// verify *that* form. Other plausible real-world variants get missed —
// e.g. `crypto.createHash("md5")` for the weak-hash check, or
// `snprintf(buf, n, "%s", input)` (size in slot 2) for the unsafe-format
// check. A reviewer surfaces the gap; the fix is one regex line.
//
// The pattern this file enables: each detector ships a sibling
// `*.fixtures.ts` declaring a list of `FixtureRow`s — one row per known
// real-world form, each marked `shouldFire: true | false`. A single
// `runDetectorFixtures(detector, fixtures)` helper walks the rows and
// asserts the detector's behavior matches the row's intent. New variants
// land as new fixture rows, not new ad-hoc tests scattered across files.
//
// What this is NOT:
// - Not a fuzzer. It's a curated corpus of known shapes.
// - Not a property-test framework. Each row is hand-authored.
// - Not exhaustive. The point is to capture the shapes the team has
//   *encountered* in real codebases or PR reviews.

import { expect, it } from "vitest";
import type { InlineMatch } from "../shared.js";

/** One canonical example a detector should classify correctly. */
export interface FixtureRow {
	/** Source content the detector receives (pre-strip). */
	input: string;
	/** File path passed to the detector — drives language gating. */
	filePath: string;
	/** Whether the detector should produce ≥1 match for this input. */
	shouldFire: boolean;
	/** One-line description (becomes the test title; appears in failure output). */
	note: string;
}

export type Detector = (content: string, filePath: string) => InlineMatch[];

/**
 * Register one `it()` per fixture row so failures point at the specific
 * canonical example that broke. Use inside a `describe()` block so the
 * detector name groups the rows together.
 *
 * Convention: name the describe block after the detector's check id (e.g.
 * `describe("ubs_weak_hash fixtures", ...)`) so search results connect the
 * fixture file to the registry entry.
 */
export function runDetectorFixtures(detector: Detector, fixtures: FixtureRow[]): void {
	for (const row of fixtures) {
		const verb = row.shouldFire ? "fires on" : "skips";
		it(`${verb}: ${row.note}`, () => {
			const result = detector(row.input, row.filePath);
			if (row.shouldFire) {
				expect(result.length, `expected match for: ${row.note}`).toBeGreaterThan(0);
			} else {
				expect(result, `expected no match for: ${row.note}`).toEqual([]);
			}
		});
	}
}
