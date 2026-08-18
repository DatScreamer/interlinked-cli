// Pins for the row-3 statusline chunk (extracted 2026-08-17 when the
// mutation-loop row pushed hook-installers-statusline.ts over the line cap).

import { describe, expect, it } from "vitest";
import { STATUSLINE_ROW3_BASH } from "./statusline-row3-chunk.js";

describe("STATUSLINE_ROW3_BASH — positive (rows present)", () => {
	// test-contract: public-api — the chunk carries all three row-3 sources:
	// viz link, 24/7 mutation loop, sponsor slot
	it("P1: renders viz, mutation-loop, and sponsor blocks", () => {
		expect(STATUSLINE_ROW3_BASH).toContain("viz.status");
		expect(STATUSLINE_ROW3_BASH).toContain("mutation-24x7.status");
		expect(STATUSLINE_ROW3_BASH).toContain("sponsor.status");
		expect(STATUSLINE_ROW3_BASH).toContain("⟳ mut");
		expect(STATUSLINE_ROW3_BASH).toContain("hardened");
	});

	// test-contract: behavior — priority is dashboard > mutation loop >
	// sponsor: the MUT_SEG override must precede the VIZ_SEG override so viz
	// wins, and sponsor only holds LINE3 when neither overrides it
	it("P2: priority order — MUT_SEG override precedes VIZ_SEG override", () => {
		const mutIdx = STATUSLINE_ROW3_BASH.indexOf('[ -n "$MUT_SEG" ] && LINE3=');
		const vizIdx = STATUSLINE_ROW3_BASH.indexOf('[ -n "$VIZ_SEG" ] && LINE3=');
		expect(mutIdx).toBeGreaterThan(-1);
		expect(vizIdx).toBeGreaterThan(mutIdx);
	});
});

describe("STATUSLINE_ROW3_BASH — negative (stale state never renders)", () => {
	// test-contract: invariant — every row source is freshness- or
	// liveness-gated: viz by pid, mutation by a 900s window, sponsor by 1800s
	it("N1: mutation row is freshness-gated at 900s", () => {
		expect(STATUSLINE_ROW3_BASH).toContain("-lt 900");
	});
});
