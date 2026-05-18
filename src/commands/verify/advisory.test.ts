// ===========================================
// advisory unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import {
	DEFAULT_ADVISORY_SKIPS,
	getEffectiveSkipChecks,
	getSkipTools,
	JS_TS_EXTS,
	TOOL_IDS,
} from "./advisory.js";

describe("DEFAULT_ADVISORY_SKIPS", () => {
	it("is a non-empty set", () => {
		expect(DEFAULT_ADVISORY_SKIPS.size).toBeGreaterThan(0);
	});

	it("includes the catch_and_log heuristic", () => {
		expect(DEFAULT_ADVISORY_SKIPS.has("catch_and_log")).toBe(true);
	});
});

describe("TOOL_IDS", () => {
	it("includes tsc + biome + semgrep", () => {
		expect(TOOL_IDS).toContain("tsc");
		expect(TOOL_IDS).toContain("biome");
		expect(TOOL_IDS).toContain("semgrep");
	});
});

describe("JS_TS_EXTS", () => {
	it("includes .ts and .tsx", () => {
		expect(JS_TS_EXTS.has(".ts")).toBe(true);
		expect(JS_TS_EXTS.has(".tsx")).toBe(true);
	});

	it("excludes python and rust extensions", () => {
		expect(JS_TS_EXTS.has(".py")).toBe(false);
		expect(JS_TS_EXTS.has(".rs")).toBe(false);
	});
});

describe("getEffectiveSkipChecks", () => {
	it("merges advisory defaults when allChecks is false", () => {
		const skip = getEffectiveSkipChecks(undefined, false);
		expect(skip.has("catch_and_log")).toBe(true);
	});

	it("omits advisory defaults when allChecks is true", () => {
		const skip = getEffectiveSkipChecks(undefined, true);
		expect(skip.has("catch_and_log")).toBe(false);
	});

	it("parses CLI skip string", () => {
		const skip = getEffectiveSkipChecks("tsc, biome", true);
		expect(skip.has("tsc")).toBe(true);
		expect(skip.has("biome")).toBe(true);
	});
});

describe("getSkipTools", () => {
	it("only returns entries that are actual tool ids", () => {
		const result = getSkipTools(new Set(["tsc", "not_a_tool", "biome"]));
		expect(result).toContain("tsc");
		expect(result).toContain("biome");
		expect(result).not.toContain("not_a_tool");
	});
});
