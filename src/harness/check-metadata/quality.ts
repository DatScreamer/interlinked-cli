// Metadata for quality checks (PostToolUse, external tool-based + inline).
// Keys must match the keys in DEFAULT_CONFIG.quality_checks (rules-loader.ts).

import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const QUALITY_CHECK_META: Record<string, CheckMeta> = {
	typescript: {
		name: "TypeScript",
		description: "TypeScript type checking after file edits",
		tier: 1,
		determinism: "fully_deterministic",
	},
	biome_lint: {
		name: "Biome Lint",
		description: "Biome lint check after file edits",
		tier: 1,
		determinism: "fully_deterministic",
	},
	eslint: {
		name: "ESLint",
		description: "ESLint check (used when project has eslint, not biome)",
		tier: 1,
		determinism: "fully_deterministic",
	},
	secrets_in_source: {
		name: "Secrets in Source",
		description: "Detect secrets written into source files",
		tier: 1,
		determinism: "fully_deterministic",
	},
	strong_typing: {
		name: "Strong Typing",
		description: "Detect explicit `any` and `unknown` types",
		tier: 2,
		determinism: "heuristic",
	},
	affected_tests: {
		name: "Affected Tests",
		description: "Run the test file corresponding to the edited source file",
		tier: 2,
		determinism: "fully_deterministic",
	},
	python_typecheck: {
		name: "Python Typecheck",
		description: "Python type checking with mypy",
		tier: 1,
		determinism: "fully_deterministic",
	},
	ruff_lint: {
		name: "Ruff Lint",
		description: "Python linting with ruff",
		tier: 1,
		determinism: "fully_deterministic",
	},
	cargo_check: {
		name: "Cargo Check",
		description: "Rust compilation check",
		tier: 1,
		determinism: "fully_deterministic",
	},
	cargo_clippy: {
		name: "Cargo Clippy",
		description: "Rust linting with clippy",
		tier: 1,
		determinism: "fully_deterministic",
	},
	go_build: {
		name: "Go Build",
		description: "Go compilation check",
		tier: 1,
		determinism: "fully_deterministic",
	},
	golangci_lint: {
		name: "Golangci-lint",
		description: "Go linting with golangci-lint",
		tier: 1,
		determinism: "fully_deterministic",
	},
	c_compile: {
		name: "C/C++ Compile",
		description: "C/C++ compilation check",
		tier: 1,
		determinism: "fully_deterministic",
	},
	clang_tidy: {
		name: "Clang-Tidy",
		description: "C/C++ linting with clang-tidy",
		tier: 1,
		determinism: "fully_deterministic",
	},
	semgrep: {
		name: "Semgrep",
		description: "SAST analysis with Semgrep",
		tier: 2,
		determinism: "fully_deterministic",
	},
	dependency_audit: {
		name: "Dependency Audit",
		description: "SCA dependency audit for known CVEs",
		tier: 2,
		determinism: "fully_deterministic",
	},
	gitleaks: {
		name: "Gitleaks",
		description: "Secrets scanning with gitleaks",
		tier: 1,
		determinism: "fully_deterministic",
	},
	prompt_injection: {
		name: "Prompt Injection",
		description: "Detect prompt injection patterns in file content",
		tier: 2,
		determinism: "heuristic",
	},
	shellcheck: {
		name: "ShellCheck",
		description: "Shell script analysis",
		tier: 1,
		determinism: "fully_deterministic",
	},
	actionlint: {
		name: "Actionlint",
		description: "GitHub Actions workflow validation",
		tier: 1,
		determinism: "fully_deterministic",
	},
	hadolint: {
		name: "Hadolint",
		description: "Dockerfile linting",
		tier: 1,
		determinism: "fully_deterministic",
	},
	taplo: {
		name: "Taplo",
		description: "TOML validation",
		tier: 1,
		determinism: "fully_deterministic",
	},
	css_syntax: {
		name: "CSS Syntax",
		description: "CSS syntax validation — brace matching, unclosed strings",
		tier: 2,
		determinism: "fully_deterministic",
	},
	sql_syntax: {
		name: "SQL Syntax",
		description: "SQL syntax validation — unbalanced parens, SELECT *, DELETE without WHERE",
		tier: 2,
		determinism: "fully_deterministic",
	},
	package_json_consistency: {
		name: "Package JSON Consistency",
		description: "package.json consistency — duplicate deps, invalid semver",
		tier: 2,
		determinism: "fully_deterministic",
	},
	lockfile_drift: {
		name: "Lockfile Drift",
		description: "Lockfile drift — manifest changed but lockfile not regenerated",
		tier: 2,
		determinism: "fully_deterministic",
	},
	schema_drift: {
		name: "Schema Drift",
		description: "Schema drift — SQL migration references columns not in schema definition",
		tier: 2,
		determinism: "fully_deterministic",
	},
};
