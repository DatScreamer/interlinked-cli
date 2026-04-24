// ===========================================
// Rules — Default Config
// ===========================================
// Ships the default `GuardRulesConfig` value with built-in protected-file
// globs, the full quality-check catalog (tsc / biome / mypy / cargo / ...),
// taint tracking, output scanning, structural checks, and project-wide
// sweep defaults.
//
// User rules in `.interlinked/guard-rules.json` and `...local.json` are
// merged on top of this default (see `rules/merge.ts`).

import { DEFAULT_TAINT_CONFIG } from "../taint-tracker.js";
import type { GuardRulesConfig } from "../types.js";

/** Seconds in a week — used for the default error-memory expiry. */
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/**
 * Public API — consumed by `rules/loader.ts` via `getDefaultConfig()`
 * and by tests. Do NOT export as a mutable reference — callers should
 * always go through `getDefaultConfig()` which returns a deep clone.
 */
export const DEFAULT_CONFIG: GuardRulesConfig = {
	version: 1,
	enabled: true,
	rules: [],
	protected_files: [
		{
			glob: "**/*.env*",
			operations: ["Write", "Edit"],
			check: "secrets",
			reason: "Environment files may contain secrets",
		},
		{
			glob: "**/*.pem",
			operations: ["Write", "Edit", "Read"],
			reason: "Private key files should not be accessed by agents",
		},
		{
			glob: "**/*.key",
			operations: ["Write", "Edit", "Read"],
			reason: "Private key files should not be accessed by agents",
		},
		{
			glob: ".github/workflows/**",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/.gitlab-ci.yml",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/.circleci/**",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/Jenkinsfile",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/.travis.yml",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/.buildkite/**",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/bitbucket-pipelines.yml",
			operations: ["Delete"],
			reason: "CI/CD config deletion breaks pipelines",
		},
		{
			glob: "**/migrations/**",
			operations: ["Delete"],
			reason: "Migration file deletion corrupts migration history",
		},
		// Security config files
		{
			glob: "**/.gitignore",
			operations: ["Delete"],
			reason: "Deleting .gitignore can cause secrets and build artifacts to be committed",
		},
		{
			glob: "**/CODEOWNERS",
			operations: ["Delete"],
			reason: "CODEOWNERS deletion breaks review enforcement",
		},
		{
			glob: "**/.pre-commit-config.yaml",
			operations: ["Delete"],
			reason: "Pre-commit config deletion disables safety hooks",
		},
		// Lock files — protect from deletion (Write/Edit blocked by builtin-lockfile-tamper rule)
		{
			glob: "**/package-lock.json",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		{
			glob: "**/yarn.lock",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		{
			glob: "**/pnpm-lock.yaml",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		{
			glob: "**/Cargo.lock",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		{
			glob: "**/poetry.lock",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		{
			glob: "**/go.sum",
			operations: ["Delete"],
			reason: "Lock file deletion breaks deterministic builds",
		},
		// Dockerfile and docker-compose
		{
			glob: "**/Dockerfile",
			operations: ["Delete"],
			reason: "Dockerfile deletion breaks container builds and deployments",
		},
		{
			glob: "**/docker-compose*.yml",
			operations: ["Delete"],
			reason: "Docker Compose deletion breaks container orchestration",
		},
	],
	file_reminders: [],
	curl_mcp_detection: {
		enabled: true,
		localhost_ports: [8787, 3000, 4321, 5173, 8080],
		escalate_after: 5,
		message:
			"Agent is curling localhost directly. If an MCP server should be running on this port, it may be disconnected. Consider reconnecting.",
	},
	quality_checks: {
		typescript: {
			enabled: true,
			command:
				"npx tsgo --noEmit --pretty false 2>/dev/null || npx tsc --noEmit --pretty false",
			file_types: [".ts", ".tsx"],
			timeout_ms: 10_000,
			severity: "error",
			description: "TypeScript type checking after file edits",
		},
		biome_lint: {
			enabled: true,
			command: "npx --yes --package @biomejs/biome biome check --no-errors-on-unmatched",
			file_types: [".ts", ".tsx", ".js", ".jsx", ".json"],
			timeout_ms: 5_000,
			severity: "warning",
			description: "Biome lint check after file edits",
		},
		eslint: {
			enabled: true,
			command: "npx eslint --no-error-on-unmatched-pattern",
			file_types: [".ts", ".tsx", ".js", ".jsx"],
			timeout_ms: 10_000,
			severity: "warning",
			description: "ESLint check (used when project has eslint, not biome)",
		},
		secrets_in_source: {
			enabled: true,
			file_types: [".ts", ".js", ".py", ".go", ".rs", ".java", ".env"],
			timeout_ms: 1_000,
			severity: "error",
			description: "Detect secrets written into source files",
		},
		strong_typing: {
			enabled: true,
			file_types: [".ts", ".tsx"],
			timeout_ms: 2_000,
			severity: "warning",
			description:
				"Detect explicit `any` and `unknown` types — encourage stronger typing (interfaces, generics, branded types)",
		},
		affected_tests: {
			enabled: true,
			file_types: [".ts", ".tsx", ".js", ".jsx"],
			timeout_ms: 15_000,
			severity: "error",
			description:
				"Run the test file corresponding to the edited source file (foo.ts → foo.test.ts)",
		},
		python_typecheck: {
			enabled: true,
			command: "python -m mypy --no-error-summary",
			file_types: [".py"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "Python type checking with mypy",
		},
		ruff_lint: {
			enabled: true,
			command: "ruff check",
			file_types: [".py"],
			timeout_ms: 5_000,
			severity: "warning",
			description: "Python linting with ruff",
		},
		cargo_check: {
			enabled: true,
			command: "cargo check --message-format=short",
			file_types: [".rs"],
			timeout_ms: 30_000,
			severity: "error",
			description: "Rust compilation check",
		},
		cargo_clippy: {
			enabled: true,
			command: "cargo clippy --message-format=short -- -D warnings",
			file_types: [".rs"],
			timeout_ms: 30_000,
			severity: "warning",
			description: "Rust linting with clippy",
		},
		go_build: {
			enabled: true,
			command: "go build ./...",
			file_types: [".go"],
			timeout_ms: 15_000,
			severity: "error",
			description: "Go compilation check",
		},
		golangci_lint: {
			enabled: true,
			command: "golangci-lint run",
			file_types: [".go"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "Go linting with golangci-lint",
		},
		c_compile: {
			enabled: true,
			command: "make",
			file_types: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
			timeout_ms: 30_000,
			severity: "error",
			description: "C/C++ compilation check",
		},
		clang_tidy: {
			enabled: true,
			command: "clang-tidy",
			file_types: [".c", ".cpp", ".cc", ".cxx"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "C/C++ linting with clang-tidy",
		},
		semgrep: {
			enabled: true,
			command: "semgrep scan --quiet --no-git-ignore --metrics off --config p/default",
			file_types: [
				".ts",
				".tsx",
				".js",
				".jsx",
				".py",
				".go",
				".rs",
				".java",
				".c",
				".cpp",
				".rb",
				".php",
			],
			timeout_ms: 30_000,
			severity: "warning",
			skip_test_files: true,
			description:
				"SAST analysis with Semgrep — detects security vulnerabilities, injection flaws, and code quality issues",
		},
		dependency_audit: {
			enabled: true,
			file_types: [
				"package.json",
				"package-lock.json",
				"yarn.lock",
				"pnpm-lock.yaml",
				"requirements.txt",
				"pyproject.toml",
				"Pipfile.lock",
				"Cargo.toml",
				"Cargo.lock",
				"go.sum",
				"go.mod",
			],
			timeout_ms: 30_000,
			severity: "warning",
			description:
				"SCA dependency audit — scans for known CVEs in project dependencies when lock/manifest files change",
		},
		gitleaks: {
			enabled: true,
			command: "gitleaks detect --no-git --no-banner -v",
			file_types: [
				".ts",
				".tsx",
				".js",
				".jsx",
				".py",
				".go",
				".rs",
				".java",
				".c",
				".cpp",
				".rb",
				".php",
				".env",
				".yaml",
				".yml",
				".json",
				".toml",
				".cfg",
				".ini",
				".properties",
				".xml",
			],
			timeout_ms: 10_000,
			severity: "error",
			skip_test_files: true,
			description:
				"Secrets scanning with gitleaks — detects leaked credentials, API keys, and tokens (800+ patterns)",
		},
		prompt_injection: {
			enabled: true,
			file_types: [
				".md",
				".txt",
				".json",
				".yaml",
				".yml",
				".csv",
				".xml",
				".html",
				".htm",
				".rst",
			],
			timeout_ms: 1_000,
			severity: "warning",
			description:
				"Detect prompt injection patterns in file content (indirect injection via documents)",
		},
		// --- New tool-runner checks ---
		shellcheck: {
			enabled: true,
			command: "shellcheck --format=json1 --severity=warning",
			file_types: [".sh", ".bash", ".zsh", ".ksh"],
			timeout_ms: 5_000,
			severity: "warning",
			description:
				"Shell script analysis — quoting bugs, undefined variables, POSIX compliance",
		},
		actionlint: {
			enabled: true,
			command: "actionlint",
			file_types: [".yml", ".yaml"],
			timeout_ms: 5_000,
			severity: "warning",
			description:
				"GitHub Actions workflow validation — syntax, expressions, action versions",
		},
		hadolint: {
			enabled: true,
			command: "hadolint --format json",
			file_types: ["Dockerfile", ".dockerfile"],
			timeout_ms: 5_000,
			severity: "warning",
			description: "Dockerfile linting — best practices, missing USER, unpinned base images",
		},
		taplo: {
			enabled: true,
			command: "taplo check",
			file_types: [".toml"],
			timeout_ms: 5_000,
			severity: "error",
			description: "TOML validation — syntax errors in Cargo.toml, pyproject.toml, etc.",
		},
		// --- New inline checks ---
		css_syntax: {
			enabled: true,
			file_types: [".css", ".scss", ".less"],
			timeout_ms: 1_000,
			severity: "warning",
			description: "CSS syntax validation — brace matching, unclosed strings",
		},
		sql_syntax: {
			enabled: true,
			file_types: [".sql"],
			timeout_ms: 1_000,
			severity: "warning",
			description:
				"SQL syntax validation — unbalanced parens, SELECT *, DELETE/UPDATE without WHERE",
		},
		package_json_consistency: {
			enabled: true,
			file_types: ["package.json"],
			timeout_ms: 1_000,
			severity: "warning",
			description: "package.json consistency — duplicate deps, invalid semver",
		},
		lockfile_drift: {
			enabled: true,
			file_types: ["package.json", "Cargo.toml", "pyproject.toml"],
			timeout_ms: 1_000,
			severity: "warning",
			description: "Lockfile drift — manifest changed but lockfile not regenerated",
		},
		schema_drift: {
			enabled: true,
			file_types: [".sql"],
			timeout_ms: 2_000,
			severity: "warning",
			description: "Schema drift — SQL migration references columns not in schema definition",
		},
	},
	error_memory: {
		enabled: true,
		max_age_s: SECONDS_PER_WEEK,
		max_records: 5000,
	},
	taint_tracking: DEFAULT_TAINT_CONFIG,
	output_scanning: {
		enabled: true,
		scan_bash_secrets: true,
		scan_web_injection: true,
		scan_file_injection: true,
		max_scan_bytes: 100_000,
	},
	structural_checks: {
		enabled: true,
		export_surface: true,
		import_resolution: true,
		duplicate_symbols: true,
		co_dependency_staleness: true,
		import_cycles: true,
		interface_change_impact: true,
		test_proximity: true,
		smart_tsc: true,
		blast_radius: true,
		stale_read_warning: true,
		sibling_awareness: true,
		staleness_window_s: 300,
		blast_radius_threshold: 5,
		recently_failed: true,
		completion_tracking: true,
		route_context: true,
		redundant_reread: true,
		dead_imports: true,
		completion_reminder_threshold: 10,
		dead_exports: true,
		hallucinated_imports: true,
		cross_package_imports: true,
		undefined_env_vars: true,
		layer_violations: false,
		impact_analysis: true,
		impact_high_threshold: 4,
		test_first: true,
		// Default hardened 2026-04-24: the TDD commit gate blocks `git commit`
		// when a source edit has no matching test-file change or the cycle is
		// stuck in red/regression. Flip to "warn" in `.interlinked/guard-rules.local.json`
		// for one-off escapes; use "nudge" to downgrade to info-only.
		test_first_mode: "enforce",
		cross_file_switch_discriminant: true,
		single_implementation_interface: true,
	},
	repo_confinement_allowlist: ["~/.claude"],
	required_tools: [],
	strict_skips: false,
	skip_allowlist: ["config_disabled", "file_type_mismatch"],
	diff_aware: {
		enabled: false,
		missing_return_types: "baseline",
		complexity: "edit_region",
		no_test_file: "new_files_only",
		undefined_env_vars: "edit_content",
	},
	project_wide_checks: {
		enabled: true,
		edit_interval: 5,
		on_export_change: true,
		tools: ["tsc", "biome"],
		timeout_ms: 30_000,
		severity: "warning",
		max_findings: 20,
	},
};
