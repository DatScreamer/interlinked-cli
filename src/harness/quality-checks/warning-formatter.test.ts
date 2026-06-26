// Tests for the proven/heuristic determinism classifier + warning formatter.
// Focus: the agent-facing [proven]/[heuristic] tag must agree with the
// check-results sink. In particular library-footgun checks classify as
// heuristic (regex shape, not behaviour-verified) — they used to fall through
// to null here while the sink defaulted them to "proven", so the two surfaces
// disagreed (the node_fetch_no_timeout report that motivated this).

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { getAllFootguns } from "../library-footguns/registry.js";
import type { QualityCheckResult } from "./result-types.js";
import { classifyDeterminism, formatQualityWarnings } from "./warning-formatter.js";

describe("classifyDeterminism", () => {
	it("tags a real tool check as proven", () => {
		expect(classifyDeterminism("typescript")).toBe("proven");
	});

	it("tags every library-footgun check as heuristic (regex shape, not behaviour-verified)", () => {
		const footguns = getAllFootguns();
		expect(footguns.length).toBeGreaterThan(0);
		for (const fg of footguns) {
			expect(classifyDeterminism(fg.id)).toBe("heuristic");
		}
	});

	it("tags node_fetch_no_timeout specifically as heuristic (the reported case)", () => {
		expect(classifyDeterminism("node_fetch_no_timeout")).toBe("heuristic");
	});

	it("returns null (no tag) for an id registered nowhere", () => {
		expect(classifyDeterminism("totally_made_up_check_zzz")).toBeNull();
	});
});

describe("formatQualityWarnings determinism tag", () => {
	const res = (name: string): QualityCheckResult => ({ name, severity: "warning", message: "x" });

	it("prefixes a footgun finding with [heuristic]", () => {
		const out = nonNull(formatQualityWarnings([res("node_fetch_no_timeout")])[0]);
		expect(out).toContain("[interlinked:node_fetch_no_timeout] [heuristic]");
	});

	it("prefixes a proven tool finding with [proven]", () => {
		const out = nonNull(formatQualityWarnings([res("typescript")])[0]);
		expect(out).toContain("[interlinked:typescript] [proven]");
	});

	it("omits the tag entirely for an unregistered check id", () => {
		const out = nonNull(formatQualityWarnings([res("totally_made_up_check_zzz")])[0]);
		expect(out).toContain("[interlinked:totally_made_up_check_zzz]");
		expect(out).not.toContain("[proven]");
		expect(out).not.toContain("[heuristic]");
	});
});
