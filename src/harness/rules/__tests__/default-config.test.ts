import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../default-config.js";

describe("DEFAULT_CONFIG", () => {
	it("has expected shape", () => {
		expect(DEFAULT_CONFIG.version).toBe(1);
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(Array.isArray(DEFAULT_CONFIG.rules)).toBe(true);
		expect(Array.isArray(DEFAULT_CONFIG.protected_files)).toBe(true);
		expect(typeof DEFAULT_CONFIG.quality_checks).toBe("object");
	});

	it("ships protected_files for env, keys, CI/CD, lockfiles", () => {
		const globs = DEFAULT_CONFIG.protected_files.map((p) => p.glob);
		expect(globs).toContain("**/*.env*");
		expect(globs).toContain("**/*.pem");
		expect(globs).toContain("**/*.key");
		expect(globs).toContain(".github/workflows/**");
		expect(globs).toContain("**/package-lock.json");
		expect(globs).toContain("**/Dockerfile");
	});

	it("quality_checks includes core languages", () => {
		expect(DEFAULT_CONFIG.quality_checks.typescript).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.biome_lint).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.python_typecheck).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.cargo_check).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.go_build).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.semgrep).toBeDefined();
		expect(DEFAULT_CONFIG.quality_checks.gitleaks).toBeDefined();
	});

	it("ships the four advisory checks off-by-default", () => {
		// These four cost more than they pay off in the median repo.
		// Repos can re-enable per-project via .interlinked/guard-rules.local.json.
		expect(DEFAULT_CONFIG.quality_checks.affected_tests.enabled).toBe(false);
		expect(DEFAULT_CONFIG.quality_checks.semgrep.enabled).toBe(false);
		expect(DEFAULT_CONFIG.quality_checks.prompt_injection.enabled).toBe(false);
		expect(DEFAULT_CONFIG.structural_checks?.enabled).toBe(false);
	});

	it("every quality check has required fields", () => {
		for (const [name, check] of Object.entries(DEFAULT_CONFIG.quality_checks)) {
			expect(typeof check.enabled).toBe("boolean");
			expect(Array.isArray(check.file_types)).toBe(true);
			expect(typeof check.timeout_ms).toBe("number");
			expect(check.severity).toMatch(/^(error|warning)$/);
			// description is required for docs generation
			expect(check.description, `missing description for ${name}`).toBeTruthy();
		}
	});

	it("curl_mcp_detection enabled with localhost ports", () => {
		expect(DEFAULT_CONFIG.curl_mcp_detection.enabled).toBe(true);
		expect(DEFAULT_CONFIG.curl_mcp_detection.localhost_ports.length).toBeGreaterThan(0);
	});

	it("structural_checks ships off-by-default but with detectors pre-wired", () => {
		// Off so dependency-graph cost is opt-in. Detectors stay declared so
		// flipping `enabled = true` in guard-rules.local.json gets full coverage.
		expect(DEFAULT_CONFIG.structural_checks?.enabled).toBe(false);
		expect(DEFAULT_CONFIG.structural_checks?.export_surface).toBe(true);
		expect(DEFAULT_CONFIG.structural_checks?.import_resolution).toBe(true);
	});

	it("error_memory defaults to one-week retention", () => {
		expect(DEFAULT_CONFIG.error_memory.enabled).toBe(true);
		expect(DEFAULT_CONFIG.error_memory.max_age_s).toBe(7 * 24 * 60 * 60);
	});

	it("project_wide_checks enabled with tsc and biome", () => {
		expect(DEFAULT_CONFIG.project_wide_checks?.enabled).toBe(true);
		expect(DEFAULT_CONFIG.project_wide_checks?.tools).toContain("tsc");
		expect(DEFAULT_CONFIG.project_wide_checks?.tools).toContain("biome");
	});
});
