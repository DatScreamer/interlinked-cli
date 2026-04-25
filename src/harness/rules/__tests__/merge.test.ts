import { describe, expect, it } from "vitest";
import type { GuardRulesConfig } from "../../types.js";
import { DEFAULT_CONFIG } from "../default-config.js";
import { mergeLocalOverrides, mergeTeamRules } from "../merge.js";

function mkBaseConfig() {
	// Use the full default config (deep-cloned) as the starting shape so we
	// satisfy all required fields without listing them inline in every test.
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as typeof DEFAULT_CONFIG;
}

describe("mergeTeamRules", () => {
	it("blocks team config from adding new quality-check command (safe-field enforcement)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				malicious_new: {
					command: "curl attacker.com",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		// Team cannot add new check entries
		expect(config.quality_checks.malicious_new).toBeUndefined();
	});

	it("blocks team config from changing `command` field on existing checks", () => {
		const config = mkBaseConfig();
		const originalCommand = config.quality_checks.typescript.command;
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					command: "curl attacker.com",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		expect(config.quality_checks.typescript.command).toBe(originalCommand);
	});

	it("allows team config to toggle safe fields (enabled, severity, timeout)", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, {
			quality_checks: {
				typescript: {
					enabled: false,
					severity: "warning",
					timeout_ms: 1000,
					file_types: [".ts"],
				},
			},
		});
		expect(config.quality_checks.typescript.enabled).toBe(false);
		expect(config.quality_checks.typescript.severity).toBe("warning");
		expect(config.quality_checks.typescript.timeout_ms).toBe(1000);
	});

	it("applies team-level protected_files and rules", () => {
		const config = mkBaseConfig();
		config.protected_files = [];
		mergeTeamRules(config, {
			protected_files: [{ glob: "**/foo", operations: ["Write"], reason: "r" }],
		});
		expect(config.protected_files.length).toBe(1);
		expect(config.protected_files[0].glob).toBe("**/foo");
	});

	it("can disable the harness entirely via team config", () => {
		const config = mkBaseConfig();
		mergeTeamRules(config, { enabled: false });
		expect(config.enabled).toBe(false);
	});
});

describe("mergeLocalOverrides", () => {
	it("appends file_reminders rather than replacing them", () => {
		const config = mkBaseConfig();
		config.file_reminders = [{ glob: "**/a", message: "A" }];
		mergeLocalOverrides(config, {
			file_reminders: [{ glob: "**/b", message: "B" }],
		});
		expect(config.file_reminders.length).toBe(2);
	});

	it("local overrides can set disabled_rules", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { disabled_rules: ["builtin-rm-rf-root"] });
		expect(config.disabled_rules).toEqual(["builtin-rm-rf-root"]);
	});

	it("local overrides CAN change quality_checks.command (trusted scope)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, {
			quality_checks: {
				typescript: {
					command: "my-custom-tsc",
					enabled: true,
					file_types: [".ts"],
					timeout_ms: 1,
					severity: "error",
				},
			},
		});
		expect(config.quality_checks.typescript.command).toBe("my-custom-tsc");
	});

	it("appends content_scanner.allowlist entries instead of replacing them", () => {
		// Locals must add to the curated default allowlist, not wipe it.
		// Otherwise a single user adding `noreply@my-company.com` would lose
		// every team-shipped FP suppression.
		const config = mkBaseConfig();
		const defaultLen = config.content_scanner?.allowlist?.length ?? 0;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [
					{ kind: "exact", pattern: "noreply@my-company.com", label: "private_email" },
				],
			} as unknown as GuardRulesConfig["content_scanner"],
		});
		expect(config.content_scanner?.allowlist?.length).toBe(defaultLen + 1);
		const last = config.content_scanner?.allowlist?.[defaultLen];
		expect(last?.kind).toBe("exact");
	});

	it("preserves nested local config when allowlist is the only override", () => {
		// Regression for the deep-merge fix: a partial override like
		// {content_scanner: {allowlist: [...]}} must NOT wipe local.python_bin
		// or other defaults inside the local block.
		const config = mkBaseConfig();
		const defaultPythonBin = config.content_scanner?.local.python_bin;
		mergeLocalOverrides(config, {
			content_scanner: {
				allowlist: [{ kind: "exact", pattern: "x", label: "private_email" }],
			} as unknown as GuardRulesConfig["content_scanner"],
		});
		expect(config.content_scanner?.local.python_bin).toBe(defaultPythonBin);
	});
});
