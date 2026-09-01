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

	it("renders test deferral as no verdict and never as a failing test", () => {
		const out = nonNull(
			formatQualityWarnings([
				{
					name: "affected_tests_deferred",
					severity: "warning",
					message: "Affected tests deferred for src/a.ts (another test check is running)",
					detail: "No test verdict was produced.",
				},
			])[0],
		);
		expect(out).toContain("Affected tests deferred");
		expect(out).toContain("No test result exists");
		expect(out).not.toContain("test file for this source file is failing");
	});

	it("renders an external-tool deferral as no verdict and never as a finding", () => {
		const out = nonNull(
			formatQualityWarnings([
				{
					name: "external_check_deferred",
					severity: "warning",
					message: "External check deferred for src/a.ts (typescript)",
					detail: "No check verdict was produced.",
				},
			])[0],
		);
		expect(out).toContain("No external-check verdict exists");
		expect(out).not.toContain("Fix the type errors");
		expect(out).not.toContain("found issues");
	});

	it("omits the tag entirely for an unregistered check id", () => {
		const out = nonNull(formatQualityWarnings([res("totally_made_up_check_zzz")])[0]);
		expect(out).toContain("[interlinked:totally_made_up_check_zzz]");
		expect(out).not.toContain("[proven]");
		expect(out).not.toContain("[heuristic]");
	});
});
