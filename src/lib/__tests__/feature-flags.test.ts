import { describe, expect, it } from "vitest";
import { FEATURE_DEFAULTS, isFeatureEnabled, type SharedConfig } from "../config.js";

const baseConfig: SharedConfig = { version: 1, server_url: "http://x" };

describe("isFeatureEnabled", () => {
	it("returns the FEATURE_DEFAULTS value when no override is present", () => {
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", baseConfig)).toBe(true);
		expect(isFeatureEnabled("harness.checks.ubs_advisory_tier", baseConfig)).toBe(false);
	});

	it("returns false for unknown feature keys (dark-ship safety)", () => {
		expect(isFeatureEnabled("harness.totally.invented.feature", baseConfig)).toBe(false);
	});

	it("honors a nested config override that flips a default-on flag off", () => {
		const config: SharedConfig = {
			...baseConfig,
			harness: { evaluator: { wrapper_normalization: false } },
		};
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", config)).toBe(false);
		// Unrelated default-on flag is still on.
		expect(isFeatureEnabled("harness.evaluator.span_classification", config)).toBe(true);
	});

	it("honors a nested config override that flips a default-off flag on", () => {
		const config: SharedConfig = {
			...baseConfig,
			harness: { trajectory: { tool_loop: true } },
		};
		expect(isFeatureEnabled("harness.trajectory.tool_loop", config)).toBe(true);
	});

	it("falls through to defaults when the path segment exists but the leaf does not", () => {
		const config: SharedConfig = {
			...baseConfig,
			harness: { evaluator: { dual_engine_regex: false } },
		};
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", config)).toBe(true);
	});

	it("treats a null config the same as no config (defaults only)", () => {
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", null)).toBe(true);
		expect(isFeatureEnabled("harness.checks.ubs_advisory_tier", null)).toBe(false);
	});

	it("falls through to defaults when the harness override path stops short of a leaf", () => {
		// e.g., user wrote { harness: { evaluator: {} } } — no leaf for the
		// requested flag, so the lookup must fall through to FEATURE_DEFAULTS
		// rather than treating the empty object as "off".
		const config: SharedConfig = { ...baseConfig, harness: { evaluator: {} } };
		expect(isFeatureEnabled("harness.evaluator.wrapper_normalization", config)).toBe(true);
	});
});

describe("FEATURE_DEFAULTS", () => {
	it("is frozen so accidental mutation is prevented", () => {
		expect(Object.isFrozen(FEATURE_DEFAULTS)).toBe(true);
	});

	it("only registers Phase-1 wins as default-on", () => {
		expect(FEATURE_DEFAULTS["harness.evaluator.wrapper_normalization"]).toBe(true);
		expect(FEATURE_DEFAULTS["harness.rules.destructive_v1_extras"]).toBe(true);
		expect(FEATURE_DEFAULTS["harness.rules.resource_bomb"]).toBe(true);
		expect(FEATURE_DEFAULTS["harness.checks.ubs_critical_tier"]).toBe(true);
		expect(FEATURE_DEFAULTS["harness.checks.ubs_warning_tier"]).toBe(true);
	});

	it("dark-ships Phase-2 features (default off until telemetry confirms)", () => {
		expect(FEATURE_DEFAULTS["harness.checks.ubs_advisory_tier"]).toBe(false);
		expect(FEATURE_DEFAULTS["harness.trajectory.tool_loop"]).toBe(false);
		expect(FEATURE_DEFAULTS["harness.impact_analysis.pagerank"]).toBe(false);
	});
});
