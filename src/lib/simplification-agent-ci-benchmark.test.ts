import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildSimplificationBenchmarkSuiteReceipt,
	evaluateSimplificationBenchmarkPair,
	parseSimplificationBenchmarkFixture,
	type SimplificationBenchmarkFixture,
	type SimplificationBenchmarkVariantObservation,
} from "./simplification-agent-ci-benchmark.js";

function loadFixtures(): SimplificationBenchmarkFixture[] {
	const directory = fileURLToPath(
		new URL("./__tests__/fixtures/simplification-positive/", import.meta.url),
	);
	return readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const input: unknown = JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
			const parsed = parseSimplificationBenchmarkFixture(input);
			if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`);
			return parsed.fixture;
		});
}

function observation(
	fixture: SimplificationBenchmarkFixture,
	variant: "overbuilt" | "minimal",
): SimplificationBenchmarkVariantObservation {
	return {
		variant,
		scorer_passed: true,
		checks_passed: true,
		findings: variant === "overbuilt"
			? [{
				fingerprint: `${fixture.fixture_id}-finding`,
				remedy: fixture.remedy,
				score: 0.9,
				protected_behavior: false,
			}]
			: [],
	};
}

describe("simplification positive benchmark pairs", () => {
	const fixtures = loadFixtures();

	it("pins an overbuilt/minimal canary for every remedy", () => {
		expect(buildSimplificationBenchmarkSuiteReceipt(fixtures)).toMatchObject({
			fixture_count: 5,
			remedies_covered: ["delete", "stdlib", "native", "yagni", "shrink"],
			complete_remedy_coverage: true,
			fixture_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("requires recall, minimal restraint, independent checks, and rank separation", () => {
		for (const fixture of fixtures) {
			expect(evaluateSimplificationBenchmarkPair(
				fixture,
				observation(fixture, "overbuilt"),
				observation(fixture, "minimal"),
			), fixture.fixture_id).toEqual({ passed: true, failures: [] });
		}
	});

	it("fails an unsafe or indistinguishable specialist result", () => {
		const fixture = fixtures[0]!;
		const overbuilt = observation(fixture, "overbuilt");
		const minimal = observation(fixture, "minimal");
		overbuilt.findings[0]!.protected_behavior = true;
		minimal.findings = [{ ...overbuilt.findings[0]!, score: 0.9 }];
		expect(evaluateSimplificationBenchmarkPair(fixture, overbuilt, minimal)).toMatchObject({
			passed: false,
			failures: expect.arrayContaining([
				"minimal_variant_overcalled",
				"overbuilt_rank_margin_not_met",
				"protected_behavior_false_positive",
			]),
		});
	});
});
