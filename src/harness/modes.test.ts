import { describe, expect, it } from "vitest";
import {
	ALL_PRESETS,
	BALANCED,
	diffPresets,
	getPreset,
	isKnownMode,
	LENIENT,
	presetToPolicyEntries,
	STRICT,
} from "./modes.js";

describe("mode presets", () => {
	it("exposes all three built-in presets", () => {
		expect(ALL_PRESETS.length).toBe(3);
		const names = ALL_PRESETS.map((p) => p.name).sort();
		expect(names).toEqual(["balanced", "lenient", "strict"]);
	});

	it("balanced carries no overrides (shipping defaults)", () => {
		expect(Object.keys(BALANCED.check_overrides).length).toBe(0);
		expect(BALANCED.default_action).toBeUndefined();
	});

	it("strict promotes test-quality checks to ask", () => {
		expect(STRICT.check_overrides.focused_tests).toBe("ask");
		expect(STRICT.check_overrides.placeholder_test).toBe("ask");
	});

	it("lenient drops the global default to info", () => {
		expect(LENIENT.default_action).toBe("info");
	});
});

describe("getPreset", () => {
	it("returns a preset for each named mode", () => {
		expect(getPreset("balanced")?.name).toBe("balanced");
		expect(getPreset("strict")?.name).toBe("strict");
		expect(getPreset("lenient")?.name).toBe("lenient");
	});
	it("returns null for custom", () => {
		expect(getPreset("custom")).toBeNull();
	});
});

describe("isKnownMode", () => {
	it("accepts the four known names", () => {
		expect(isKnownMode("balanced")).toBe(true);
		expect(isKnownMode("strict")).toBe(true);
		expect(isKnownMode("lenient")).toBe(true);
		expect(isKnownMode("custom")).toBe(true);
	});
	it("rejects unknown strings", () => {
		expect(isKnownMode("super-strict")).toBe(false);
		expect(isKnownMode("")).toBe(false);
	});
});

describe("presetToPolicyEntries", () => {
	it("maps each check override to a policy entry with an action", () => {
		const entries = presetToPolicyEntries(STRICT);
		expect(entries.focused_tests).toEqual({ action: "ask" });
		expect(Object.keys(entries).length).toBe(Object.keys(STRICT.check_overrides).length);
	});
	it("returns empty for balanced", () => {
		expect(presetToPolicyEntries(BALANCED)).toEqual({});
	});
});

describe("diffPresets — balanced → strict", () => {
	const diff = diffPresets(BALANCED, STRICT);
	it("surfaces every strict override as a change from (default)", () => {
		expect(diff.length).toBe(Object.keys(STRICT.check_overrides).length);
		for (const entry of diff) {
			expect(entry.from_action).toBe("(default)");
		}
	});
	it("includes focused_tests going to ask", () => {
		const hit = diff.find((d) => d.check_id === "focused_tests");
		expect(hit?.to_action).toBe("ask");
	});
});

describe("diffPresets — strict → balanced (reversal)", () => {
	const diff = diffPresets(STRICT, BALANCED);
	it("surfaces every strict override as relaxing to default (warn_after)", () => {
		expect(diff.length).toBeGreaterThan(0);
		for (const entry of diff) {
			expect(entry.to_action).toBe("warn_after");
		}
	});
});

describe("diffPresets — balanced → lenient", () => {
	it("does not report per-check differences when only default_action moves", () => {
		// balanced has no explicit overrides; lenient has no explicit overrides
		// either — the change is in default_action. diffPresets intentionally
		// only diffs the override map; default_action shifts are surfaced by
		// the caller separately.
		const diff = diffPresets(BALANCED, LENIENT);
		expect(diff.length).toBe(0);
	});
});
