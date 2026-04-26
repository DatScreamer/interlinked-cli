// ===========================================
// Calibration preset shape tests
// ===========================================
//
// Validates that every JSON file under sidecars/calibrations/ matches the
// schema OPF's `_validate_exact_keys` enforces at runtime: artifact must
// contain exactly `operating_points`, which contains exactly `default`,
// which contains exactly `biases`, which contains exactly the six
// `VITERBI_BIAS_KEYS`. Any drift here would surface as a sidecar boot
// failure — catching it in unit tests instead saves the user a 90s
// startup-timeout when their first scan request lands.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../rules/default-config.js";

const VITERBI_BIAS_KEYS = [
	"transition_bias_background_stay",
	"transition_bias_background_to_start",
	"transition_bias_inside_to_continue",
	"transition_bias_inside_to_end",
	"transition_bias_end_to_background",
	"transition_bias_end_to_start",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const CALIBRATIONS_DIR = join(HERE, "..", "sidecars", "calibrations");

function listPresets(): string[] {
	return readdirSync(CALIBRATIONS_DIR)
		.filter((f) => f.endsWith(".json"))
		.sort();
}

describe("OPF calibration presets", () => {
	const presets = listPresets();

	it("ships at least default.json and high_precision.json", () => {
		expect(presets).toContain("default.json");
		expect(presets).toContain("high_precision.json");
	});

	for (const preset of presets) {
		describe(preset, () => {
			const raw = readFileSync(join(CALIBRATIONS_DIR, preset), "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;

			it("has exactly the operating_points top-level key (OPF schema)", () => {
				expect(Object.keys(parsed)).toEqual(["operating_points"]);
			});

			it("operating_points contains exactly the `default` entry", () => {
				const ops = parsed.operating_points as Record<string, unknown>;
				expect(Object.keys(ops)).toEqual(["default"]);
			});

			it("default entry contains exactly a `biases` field", () => {
				const ops = parsed.operating_points as Record<string, unknown>;
				const def = ops.default as Record<string, unknown>;
				expect(Object.keys(def)).toEqual(["biases"]);
			});

			it("biases contains exactly the six VITERBI_BIAS_KEYS as numbers", () => {
				const ops = parsed.operating_points as Record<string, unknown>;
				const def = ops.default as Record<string, unknown>;
				const biases = def.biases as Record<string, unknown>;
				const keys = Object.keys(biases).sort();
				expect(keys).toEqual([...VITERBI_BIAS_KEYS].sort());
				for (const k of VITERBI_BIAS_KEYS) {
					expect(typeof biases[k]).toBe("number");
					expect(Number.isFinite(biases[k] as number)).toBe(true);
				}
			});
		});
	}

	it("default.json has all-zero biases (matches OPF native default)", () => {
		const raw = readFileSync(join(CALIBRATIONS_DIR, "default.json"), "utf-8");
		const parsed = JSON.parse(raw) as {
			operating_points: { default: { biases: Record<string, number> } };
		};
		for (const k of VITERBI_BIAS_KEYS) {
			expect(parsed.operating_points.default.biases[k]).toBe(0);
		}
	});

	it("high_precision.json penalizes span entry (background_to_start < 0)", () => {
		// The actual numeric values are tunable — but the SIGN must reflect
		// the preset's intent, otherwise the file is mislabeled. This catches
		// accidental "high precision" presets that boost recall instead.
		const raw = readFileSync(join(CALIBRATIONS_DIR, "high_precision.json"), "utf-8");
		const parsed = JSON.parse(raw) as {
			operating_points: { default: { biases: Record<string, number> } };
		};
		const b = parsed.operating_points.default.biases;
		expect(b.transition_bias_background_to_start).toBeLessThan(0);
		expect(b.transition_bias_background_stay).toBeGreaterThan(0);
	});

	it("DEFAULT_CONFIG points content_scanner.local.viterbi_calibration_path at high_precision.json", () => {
		const path = DEFAULT_CONFIG.content_scanner?.local.viterbi_calibration_path;
		expect(path).toBeDefined();
		expect(path).toMatch(/calibrations\/high_precision\.json$/);
	});
});
