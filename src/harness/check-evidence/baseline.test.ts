// Tests for the Check Evidence Contract baseline loader.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHECK_EVIDENCE_BASELINE_PATH,
	EMPTY_BASELINE,
	enforcedDimensions,
	exemptSet,
	loadCheckEvidenceBaseline,
	parseBaseline,
} from "./baseline.js";

let root: string;

function writeBaseline(content: string): void {
	const full = join(root, CHECK_EVIDENCE_BASELINE_PATH);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cec-baseline-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("parseBaseline", () => {
	it("reads a well-formed baseline", () => {
		expect(parseBaseline({ exempt: ["a", "b"], note: "hi" })).toEqual({
			exempt: ["a", "b"],
			note: "hi",
		});
	});

	it("drops non-string entries rather than trusting them", () => {
		expect(parseBaseline({ exempt: ["a", 3, null, "b"] }).exempt).toEqual(["a", "b"]);
	});

	it("omits a non-string note", () => {
		expect(parseBaseline({ exempt: [], note: 42 })).toEqual({ exempt: [] });
	});

	it("fails closed on a missing exempt array", () => {
		expect(parseBaseline({ note: "no list" })).toEqual(EMPTY_BASELINE);
	});

	it("fails closed on non-object input", () => {
		expect(parseBaseline(null)).toEqual(EMPTY_BASELINE);
		expect(parseBaseline("nope")).toEqual(EMPTY_BASELINE);
	});
});

describe("loadCheckEvidenceBaseline", () => {
	it("returns no exemptions when the file is absent", () => {
		expect(loadCheckEvidenceBaseline(root)).toEqual(EMPTY_BASELINE);
	});

	it("returns no exemptions when the file is malformed JSON", () => {
		writeBaseline("{ not json");
		expect(loadCheckEvidenceBaseline(root)).toEqual(EMPTY_BASELINE);
	});

	it("loads exemptions from a valid file", () => {
		writeBaseline(JSON.stringify({ exempt: ["check_a"] }));
		expect(loadCheckEvidenceBaseline(root).exempt).toEqual(["check_a"]);
	});
});

describe("enforced dimensions", () => {
	it("P1: reads an explicit enforced list", () => {
		expect(parseBaseline({ exempt: [], enforced: ["cases", "corpus"] }).enforced).toEqual([
			"cases",
			"corpus",
		]);
	});

	it("P2: drops unrecognized dimension names", () => {
		expect(parseBaseline({ exempt: [], enforced: ["cases", "vibes"] }).enforced).toEqual(["cases"]);
	});

	it("N1: a baseline predating the field defaults to cases, not nothing", () => {
		// Absent must NOT read as "enforce nothing" — that would silently retire
		// the obligation the baseline was written to hold.
		expect(enforcedDimensions({ exempt: [] })).toEqual(["cases"]);
	});

	it("N2: an explicit empty list is honored as written", () => {
		expect(enforcedDimensions({ exempt: [], enforced: [] })).toEqual([]);
	});

	it("N3: a non-array enforced field is ignored", () => {
		expect(parseBaseline({ exempt: [], enforced: "cases" }).enforced).toBeUndefined();
	});
});

describe("exemptSet", () => {
	it("provides membership lookup", () => {
		const set = exemptSet({ exempt: ["x", "y"] });
		expect(set.has("x")).toBe(true);
		expect(set.has("z")).toBe(false);
	});

	it("is empty for an empty baseline", () => {
		expect(exemptSet(EMPTY_BASELINE).size).toBe(0);
	});
});
