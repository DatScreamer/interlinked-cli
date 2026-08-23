import { describe, expect, it } from "vitest";
import type { GuardRulesConfig, QualityCheckConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./default-config.js";
import { mergeLocalOverrides, mergeTeamRules } from "./merge.js";

function mkBaseConfig() {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as typeof DEFAULT_CONFIG;
}

describe("mergeTeamRules — mutation kills (w52)", () => {
	it("does NOT wipe project_specific when team config omits it (kills 193de00d4ba258bb)", () => {
		const config = mkBaseConfig();
		config.project_specific = { protected_paths: ["keep/"], protected_reason: "kept" };
		mergeTeamRules(config, {});
		expect(config.project_specific).toEqual({
			protected_paths: ["keep/"],
			protected_reason: "kept",
		});
	});

	it("does NOT wipe policy_classifier when team config omits it (kills 16da46afce780efe)", () => {
		const config = mkBaseConfig();
		const classifier = {
			enabled: true,
			mode: "shadow",
			provider: "groq",
			endpoint: "https://example.com",
			api_key_env: "K",
			model: "m",
			timeout_ms: 100,
		} as unknown as NonNullable<GuardRulesConfig["policy_classifier"]>;
		config.policy_classifier = classifier;
		mergeTeamRules(config, {});
		expect(config.policy_classifier).toBe(classifier);
	});

	it("does NOT wipe auto_coordination when team config omits it (kills 7ad9510e286b0c54)", () => {
		const config = mkBaseConfig();
		const ac = {
			enabled: true,
			check_interval: 5,
			min_interval_ms: 1,
			max_interval_ms: 2,
			timeout_ms: 10,
			skip_tools: [],
		} as unknown as NonNullable<GuardRulesConfig["auto_coordination"]>;
		config.auto_coordination = ac;
		mergeTeamRules(config, {});
		expect(config.auto_coordination).toBe(ac);
	});

	it("team config applies file_types to an existing quality check (kills 66206e5b8581b9c6)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					file_types: [".foo"],
				} as unknown as QualityCheckConfig,
			},
		});
		expect(config.quality_checks.typescript?.file_types).toEqual([".foo"]);
	});

	it("team config applies description to an existing quality check (kills 6bf542bee5b6b61f)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					description: "custom desc",
				} as unknown as QualityCheckConfig,
			},
		});
		expect(config.quality_checks.typescript?.description).toBe("custom desc");
	});

	it("skips a truthy non-object quality-check override, e.g. a function (kills f8d47c0f1bbeb6c1)", () => {
		// typeof a function is "function", not "object", so the real code's
		// `typeof teamCheck !== "object"` guard must skip it even though the
		// function is truthy and even carries an own `enabled` property.
		const config = mkBaseConfig();
		const before = config.quality_checks.typescript?.enabled;
		const fakeCheck = function fakeCheck() {} as unknown as QualityCheckConfig;
		(fakeCheck as unknown as { enabled: boolean }).enabled = !before;
		mergeTeamRules(config, {
			quality_checks: {
				typescript: fakeCheck,
			},
		});
		expect(config.quality_checks.typescript?.enabled).toBe(before);
	});
});

describe("mergeLocalOverrides — mutation kills (w52)", () => {
	it("does NOT wipe disabled_rules when local config omits it (kills afa3419ac6ace3a8)", () => {
		const config = mkBaseConfig();
		config.disabled_rules = ["keep-this-rule"];
		mergeLocalOverrides(config, {});
		expect(config.disabled_rules).toEqual(["keep-this-rule"]);
	});

	it("does NOT wipe extra_exceptions when local config omits it (kills 7009d7a1822ffadc)", () => {
		const config = mkBaseConfig();
		config.extra_exceptions = { "some-rule": ["allow this"] };
		mergeLocalOverrides(config, {});
		expect(config.extra_exceptions).toEqual({ "some-rule": ["allow this"] });
	});

	const optionalSectionKeys: Array<{ key: keyof GuardRulesConfig; mutantId: string }> = [
		{ key: "trajectory_shadow", mutantId: "45c8531b39eb6384" },
		{ key: "scratchpad_guard", mutantId: "50a3a4679c0a768e" },
		{ key: "spec_checks", mutantId: "b2f1d998a4042a5f" },
		{ key: "baseline_autofold", mutantId: "e8f84f97023986cd" },
		{ key: "edit_contract", mutantId: "ccb1bf44c55ac987" },
		{ key: "scratchpad_archive", mutantId: "475453f918cc90ab" },
		{ key: "verification_stop_checks", mutantId: "52a3633adb8e6af4" },
		{ key: "mutation_directed_strict_profile", mutantId: "9e0b91315eb9449d" },
	];

	for (const { key, mutantId } of optionalSectionKeys) {
		it(`installs a new ${String(key)} section from local override (kills ${mutantId})`, () => {
			// If the string literal naming this section inside mergeOptionalSection
			// were mutated to "", the read `local[""]` would find nothing and this
			// section would never be installed even though we supplied it.
			const config = mkBaseConfig();
			delete (config as unknown as Record<string, unknown>)[key as string];
			const marker = { enabled: true, __marker: true };
			mergeLocalOverrides(config, {
				[key]: marker,
			} as unknown as Partial<GuardRulesConfig>);
			expect((config as unknown as Record<string, unknown>)[key as string]).toEqual(marker);
		});
	}

	it("mergeOptionalSection leaves the section untouched for an explicit null override (kills a4159ab9b4c5a747)", () => {
		// !override -> false would make the function proceed even though override
		// is falsy (null), assigning config.trajectory_shadow = null instead of
		// leaving it undefined.
		const config = mkBaseConfig();
		delete (config as unknown as Record<string, unknown>).trajectory_shadow;
		mergeLocalOverrides(config, {
			trajectory_shadow: null,
		} as unknown as Partial<GuardRulesConfig>);
		expect(config.trajectory_shadow).toBeUndefined();
	});

	it("does not create an empty content_scanner.allowlist from an empty override array (kills 76e8358041f86893 / 4f466d1d93858db6)", () => {
		const config = mkBaseConfig();
		if (config.content_scanner) {
			delete (config.content_scanner as unknown as Record<string, unknown>).allowlist;
		}
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [],
			} as unknown as NonNullable<GuardRulesConfig["content_scanner"]>,
		});
		expect(config.content_scanner?.allowlist).toBeUndefined();
	});

	it("does not create an empty content_scanner.disabled_labels from an empty override array (kills f3eb03f2734994ef / 1e92a1f6210c7b6d)", () => {
		const config = mkBaseConfig();
		if (config.content_scanner) {
			delete (config.content_scanner as unknown as Record<string, unknown>).disabled_labels;
		}
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: [],
			} as unknown as NonNullable<GuardRulesConfig["content_scanner"]>,
		});
		expect(config.content_scanner?.disabled_labels).toBeUndefined();
	});
});
