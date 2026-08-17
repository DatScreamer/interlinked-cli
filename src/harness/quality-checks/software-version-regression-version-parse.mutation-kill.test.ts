import { describe, expect, it } from "vitest";
import {
	classifyGenericKind,
	isVersionRegression,
	looksComparable,
	looksLikeModelIdentifier,
	modelFamilyOf,
} from "./software-version-regression-version-parse.js";

// Pass-1 mutation-kill companion for software-version-regression-version-parse.ts.
// comparableVersion/parseDateVersion/parseModelVersion/parseNamedModelVersion/
// parseNumericVersion/compareParts are unexported — exercised here only through
// the public surface (isVersionRegression / looksComparable / classifyGenericKind /
// modelFamilyOf / looksLikeModelIdentifier), matching how real callers observe them.

function ref(version: string, kind: "generic" | "model" | "api_version" = "generic") {
	return { anchor: "a", label: "a", version, kind, line: 1, text: "a" } as const;
}

describe("looksLikeModelIdentifier — MODEL_IDENTIFIER_RE boundary shape", () => {
	// test-contract: boundary — must reject the short "yml" spelling, not only "yaml"
	it("rejects a claude-shaped token ending in the short .yml extension", () => {
		expect(looksLikeModelIdentifier("claude-3.5.yml")).toBe(false);
	});

	// test-contract: boundary — a single leading whitespace char is a valid delimiter
	it("recognizes a model token preceded by a single leading space", () => {
		expect(looksLikeModelIdentifier(" claude-4-5")).toBe(true);
	});

	// test-contract: boundary — an ordinary letter must not itself act as a delimiter
	it("does not recognize a model token glued directly onto a preceding letter", () => {
		expect(looksLikeModelIdentifier("Xclaude-4-5")).toBe(false);
	});

	// test-contract: boundary — digit right after the family separator is recognized
	it("recognizes claude-9 (digit immediately after the separator)", () => {
		expect(looksLikeModelIdentifier("claude-9")).toBe(true);
	});

	// test-contract: boundary — a provider word with no digit anywhere is not a model id
	it("does not recognize a provider word with no digit anywhere after it", () => {
		expect(looksLikeModelIdentifier("claude-opus")).toBe(false);
	});

	// test-contract: boundary — o-series capture must extend far enough to see .yml
	it("rejects an o-series token whose captured span includes a .yml extension", () => {
		// REAL_WORLD_VERSION_FIXTURE_OK — the SUT's o-series provider regex is the behavior under test
		expect(looksLikeModelIdentifier("o3.yml")).toBe(false);
	});
});

describe("classifyGenericKind — api_version key shape", () => {
	// test-contract: boundary — underscore is an accepted api/version separator
	it("classifies a key using the literal api_version separator", () => {
		expect(classifyGenericKind("api_version", "not-a-date")).toBe("api_version");
	});
});

describe("isVersionRegression — comparableVersion branch integrity", () => {
	// test-contract: invariant — date-vs-date must return a real boolean, never throw
	it("compares two date versions without throwing and returns the correct verdict", () => {
		expect(() => isVersionRegression(ref("2024-06-15"), ref("2024-06-14"))).not.toThrow();
		expect(isVersionRegression(ref("2024-06-15"), ref("2024-06-14"))).toBe(true);
	});

	// test-contract: invariant — a digit-less model provider must not throw downstream
	it("returns false (no throw) comparing a digit-less model provider against a real model version", () => {
		expect(() => isVersionRegression(ref("claude", "model"), ref("claude-3", "model"))).not.toThrow();
		expect(isVersionRegression(ref("claude", "model"), ref("claude-3", "model"))).toBe(false);
	});
});

describe("looksComparable — named-model branch gating", () => {
	// test-contract: boundary — named-model fallback only runs when kind is "model"
	it("does not treat a generic named version as comparable without a provider", () => {
		expect(looksComparable("widget-9", "generic")).toBe(false);
	});
});

describe("isVersionRegression — parseDateVersion separator and digit-range boundaries", () => {
	// test-contract: boundary — a compact 8-digit date parses as y/m/d, not one big number
	it("parses a compact 8-digit date as year/month/day, not as one big number", () => {
		expect(isVersionRegression(ref("2024-06-15"), ref("20230615"))).toBe(true);
	});

	// test-contract: boundary — day 31 and month 12 sit at the top of their digit ranges
	it("recognizes day 31 and month 12 as valid date components", () => {
		expect(isVersionRegression(ref("2024-12-31"), ref("2024-01-01"))).toBe(true);
	});

	// test-contract: invariant — a parsed date must carry its real [y,m,d] parts
	it("carries real date parts into the comparison (adjacent days differ)", () => {
		expect(isVersionRegression(ref("2024-06-15"), ref("2024-06-14"))).toBe(true);
	});
});

describe("isVersionRegression — parseModelVersion provider-tail extraction", () => {
	// test-contract: boundary — provider lookup must use the same casing as the index
	it("ignores a leading unrelated digit that sits before the o-series provider", () => {
		// REAL_WORLD_VERSION_FIXTURE_OK — the SUT's o-series provider lookup is the behavior under test
		expect(isVersionRegression(ref("9-o3"), ref("2-o5"))).toBe(false);
	});

	// test-contract: boundary — the version tail is sliced from just after the provider
	it("slices the version tail from immediately after the provider token", () => {
		// REAL_WORLD_VERSION_FIXTURE_OK — the SUT's gpt provider-prefix slicing is the behavior under test
		expect(isVersionRegression(ref("gpt-4-turbo-2024"), ref("gpt-1-turbo-2024"))).toBe(true);
	});

	// test-contract: boundary — a multi-digit tail run is one component, not split apart
	it("keeps a multi-digit tail component (2024) intact as one part", () => {
		// REAL_WORLD_VERSION_FIXTURE_OK — the SUT's gpt provider-tail parsing is the behavior under test
		expect(isVersionRegression(ref("gpt-4-turbo-2024"), ref("gpt-4-turbo-2023"))).toBe(true);
	});

	// test-contract: boundary — only the first four tail digit-runs are significant
	it("ignores a fifth numeric component beyond the first four", () => {
		expect(isVersionRegression(ref("claude-1-2-3-4-5"), ref("claude-1-2-3-4-0"))).toBe(false);
	});
});

describe("isVersionRegression — parseNamedModelVersion fallback grammar", () => {
	// test-contract: boundary — the leading digit run may start at index 0, no separator
	it("recognizes a leading digit run with no separator before it", () => {
		expect(isVersionRegression(ref("4_widget", "model"), ref("3_widget", "model"))).toBe(true);
	});

	// test-contract: boundary — an ordinary word char must not itself act as a leading separator
	it("does not treat an ordinary letter as a valid leading separator", () => {
		expect(isVersionRegression(ref("4-widget-9", "model"), ref("4-widget-3", "model"))).toBe(true);
	});

	// test-contract: boundary — a multi-digit leading number compares by full value, not first digit
	it("compares multi-digit leading numbers by full value, not by first digit", () => {
		expect(isVersionRegression(ref("19_widget", "model"), ref("5_widget", "model"))).toBe(true);
	});

	// test-contract: boundary — a multi-digit minor component stays intact as one number
	it("keeps a multi-digit minor component (12) distinct from a single-digit one", () => {
		expect(isVersionRegression(ref("1-12-widget", "model"), ref("1-9-widget", "model"))).toBe(true);
	});

	// test-contract: boundary — minor/patch groups must land at their own array index
	it("keeps minor and patch components at their own array positions", () => {
		expect(isVersionRegression(ref("widget-1-9-2", "model"), ref("widget-1-2-9", "model"))).toBe(true);
	});

	// test-contract: boundary — the patch group is not limited to a single digit
	it("compares a multi-digit patch component (34) by full value", () => {
		expect(isVersionRegression(ref("widget-1-2-34", "model"), ref("widget-1-2-9", "model"))).toBe(true);
	});

	// test-contract: boundary — a real patch value must not be defaulted away to 0
	it("uses the real trailing patch value rather than forcing it to 0", () => {
		expect(isVersionRegression(ref("widget-1-2-9", "model"), ref("widget-1-2-3", "model"))).toBe(true);
	});

	// test-contract: boundary — a real minor value must not be defaulted away to 0
	it("uses the real trailing minor value rather than forcing it to 0", () => {
		expect(isVersionRegression(ref("widget-4-9", "model"), ref("widget-4-3", "model"))).toBe(true);
	});
});

describe("isVersionRegression / looksComparable — parseNumericVersion cleanup and grammar", () => {
	// test-contract: boundary — trailing whitespace must be trimmed, not only leading
	it("still parses a version after trimming trailing whitespace", () => {
		expect(looksComparable("1.2.3 ")).toBe(true);
	});

	// test-contract: boundary — the leading strip must consume the whole operator run
	it("strips a full multi-character range-operator prefix", () => {
		expect(looksComparable(">=1.2.3")).toBe(true);
	});

	// test-contract: boundary — the "v" strip only applies at the very start of the string
	it("does not strip a v that appears in the middle of the string", () => {
		expect(looksComparable("1v2")).toBe(false);
	});

	// test-contract: boundary — the reject-list check only fires on a leading keyword
	it("does not reject a numeric version merely because a suffix looks like a keyword", () => {
		expect(looksComparable("1.2.3-canary")).toBe(true);
	});

	// test-contract: boundary — the numeric grammar is anchored at the start of the string
	it("rejects a numeric-looking version with a non-numeric prefix", () => {
		expect(looksComparable("abc1.2.3")).toBe(false);
	});

	// test-contract: boundary — the numeric grammar is anchored at the end of the string
	it("rejects a numeric-looking version with a non-numeric suffix", () => {
		expect(looksComparable("1.2.3abc")).toBe(false);
	});

	// test-contract: boundary — the minor component accepts more than a single digit
	it("accepts a multi-digit minor component", () => {
		expect(looksComparable("1.23.4")).toBe(true);
	});

	// test-contract: boundary — the patch component accepts more than a single digit
	it("accepts a multi-digit patch component", () => {
		expect(looksComparable("1.2.34")).toBe(true);
	});

	// test-contract: boundary — a present minor value must be used, not defaulted to 0
	it("uses the real minor value rather than defaulting it to 0 when present", () => {
		expect(isVersionRegression(ref("1.5.3"), ref("1.2.3"))).toBe(true);
	});

	// test-contract: boundary — a present patch value must be used, not defaulted to 0
	it("uses the real patch value rather than defaulting it to 0 when present", () => {
		expect(isVersionRegression(ref("1.2.5"), ref("1.2.3"))).toBe(true);
	});
});

describe("modelFamilyOf — trailing version-suffix stripping grammar", () => {
	// test-contract: boundary — the version-suffix strip is anchored to the string's end
	it("does not strip a version-like sequence that isn't at the very end", () => {
		expect(modelFamilyOf("widget-9-1-suffix-extra")).toBe("widget-9-1-suffix-extra");
	});

	// test-contract: boundary — the leading version digit run accepts multiple digits
	it("strips a multi-digit leading version number", () => {
		expect(modelFamilyOf("widget-12")).toBe("widget");
	});

	// test-contract: boundary — a repeated minor/patch group accepts multiple digits
	it("strips a multi-digit minor version component", () => {
		expect(modelFamilyOf("widget-1-12")).toBe("widget");
	});

	// test-contract: boundary — the trailing letter-suffix separator is optional
	it("strips a letter suffix with no separator before it", () => {
		expect(modelFamilyOf("widget-9x")).toBe("widget");
	});

	// test-contract: boundary — the trailing letter-suffix separator, when present, is honored
	it("strips a letter suffix that has a separator before it", () => {
		expect(modelFamilyOf("widget-9-x")).toBe("widget");
	});

	// test-contract: boundary — the trailing letter suffix accepts more than one letter
	it("strips a multi-letter suffix glued directly to the digits", () => {
		expect(modelFamilyOf("widget-9beta")).toBe("widget");
	});

	// test-contract: boundary — every trailing separator is stripped, and stripped to empty
	it("strips every trailing separator character left after the version strip", () => {
		expect(modelFamilyOf("widget-9---")).toBe("widget-9");
	});
});
