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

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_TAINT_CONFIG } from "../taint-tracker.js";
import type { GuardRulesConfig } from "../types.js";
import { DEFAULT_QUALITY_CHECKS } from "./default-config-quality-checks.js";

/** Seconds in a week — used for the default error-memory expiry. */
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/** Resolve the OPF Python sidecar path across three deployment layouts:
 *    (1) dev (tsx):          src/harness/rules/default-config.ts  →  ../content-scanner/sidecars/opf-sidecar.py
 *    (2) prod-from-source:   dist/chunk-XYZ.js                     →  ../src/harness/content-scanner/sidecars/opf-sidecar.py
 *    (3) bundled server:     dist/harness/server.js                →  ../sidecars/opf-sidecar.py
 *    (4) bundled chunk:      dist/chunk-XYZ.js                     →  ./sidecars/opf-sidecar.py
 *  First existing candidate wins; if none exist we return the source-tree
 *  default so the error message points at the expected dev location. */
function resolveDefaultOpfSidecarScript(): string {
	const candidates = [
		new URL("../content-scanner/sidecars/opf-sidecar.py", import.meta.url),
		new URL("../src/harness/content-scanner/sidecars/opf-sidecar.py", import.meta.url),
		new URL("../sidecars/opf-sidecar.py", import.meta.url),
		new URL("./sidecars/opf-sidecar.py", import.meta.url),
		new URL("./opf-sidecar.py", import.meta.url),
	];
	for (const url of candidates) {
		const candidatePath = fileURLToPath(url);
		if (existsSync(candidatePath)) return candidatePath;
	}
	return fileURLToPath(candidates[0]);
}

/** Resolve a shipped Viterbi calibration preset by filename across the same
 *  four deployment layouts as the sidecar script. Internal — only consumed by
 *  HIGH_PRECISION_OPF_CALIBRATION_PATH below. Promote to an export if/when
 *  external code (custom-preset bundles, programmatic config builders) needs
 *  to resolve installed presets without hard-coding deployment paths. */
function resolveDefaultOpfCalibrationPath(presetFileName: string): string {
	const candidates = [
		new URL(`../content-scanner/sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(
			`../src/harness/content-scanner/sidecars/calibrations/${presetFileName}`,
			import.meta.url,
		),
		new URL(`../sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(`./sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(`./calibrations/${presetFileName}`, import.meta.url),
	];
	for (const url of candidates) {
		const candidatePath = fileURLToPath(url);
		if (existsSync(candidatePath)) return candidatePath;
	}
	return fileURLToPath(candidates[0]);
}

const DEFAULT_OPF_SIDECAR_SCRIPT = resolveDefaultOpfSidecarScript();

/** Absolute path to the shipped precision-leaning calibration preset. Used
 *  by DEFAULT_CONFIG.content_scanner.local below as the out-of-the-box
 *  `viterbi_calibration_path`. Will be re-exported once the calibration
 *  shape test (content-scanner/__tests__/calibration.test.ts) imports it. */
const HIGH_PRECISION_OPF_CALIBRATION_PATH =
	resolveDefaultOpfCalibrationPath("high_precision.json");

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
		// Content scanner LOCAL-ONLY artifacts. The whole point of
		// .interlinked/scanner/pending/ is that the raw flagged content
		// stays out of the agent's context window — if the agent can Read
		// or Edit those JSON files, the systemMessage / redacted-reason
		// design collapses. Mode 0600 only blocks OTHER users on the
		// system; the agent runs as the file owner, so the rule layer
		// has to enforce the boundary. Same logic for the audit log,
		// which records who toggled the filter off and when.
		{
			glob: ".interlinked/scanner/pending/**",
			operations: ["Read", "Write", "Edit", "Delete"],
			reason: "Pending content-scanner files contain raw flagged PII that must NOT enter the agent's context window. Mode 0600 only blocks other users; this rule blocks the agent itself. Open the file in a separate terminal/editor if you need to review.",
		},
		{
			glob: ".interlinked/content-scanner.audit.jsonl",
			operations: ["Read", "Write", "Edit", "Delete"],
			reason: "Content-scanner audit log records every toggle with actor + reason. Treat as audit data, not as program input — agents reading this could rationalize toggling the filter off in subsequent turns.",
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
	quality_checks: DEFAULT_QUALITY_CHECKS,
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
		// Off by default: dependency-graph scans add latency and warning volume that
		// many repos don't want by default. Re-enable per repo via
		// .interlinked/guard-rules.local.json once you've sized the project graph cost.
		enabled: false,
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
	// No linked sibling projects by default — single-root confinement. A
	// multi-repo workspace (e.g. public CLI + private cloud) declares its
	// sibling roots here, relative to the project root.
	linked_projects: [],
	// Path globs that short-circuit the PostToolUse check pipeline entirely.
	// See `SharedConfig.skip_paths` JSDoc in `src/lib/config.ts` and the
	// matcher in `src/lib/path-glob.ts`. Opinionated defaults below cover
	// build artifacts, vendored deps, generated code, lockfiles, and IDE
	// metadata. Per Phase B.2 of `docs/plans/free-cli-adoption/`.
	skip_paths: [
		"dist/**",
		"build/**",
		"out/**",
		"node_modules/**",
		"vendor/**",
		".next/**",
		".nuxt/**",
		".astro/**",
		"target/**",
		".svelte-kit/**",
		"**/generated/**",
		// Brace-alternation `{a,b,c}` is NOT supported by the hook-side
		// inline matcher in `lib/hook-template-chunks/skip-paths.ts` (Phase B.3
		// cuts daemon round-trip). Listing each extension explicitly so the
		// hook-side and daemon-side matchers agree and the path actually
		// short-circuits before opening the harness socket.
		"**/*.generated.ts",
		"**/*.generated.js",
		"**/*.generated.py",
		"**/*.generated.rs",
		"**/*.generated.go",
		"**/*.min.js",
		"**/*.min.css",
		"**/*.bundle.js",
		"**/*.bundle.css",
		"*.lock",
		"**/package-lock.json",
		"**/yarn.lock",
		"**/Cargo.lock",
		"**/uv.lock",
		".git/**",
		".idea/**",
		".vscode/**",
	],
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
	commit_cadence: {
		// Default-on: stderr-only nudges, never block. Stop-hook fires when
		// the agent ends a session with > stop_threshold uncommitted code-file
		// edits; the mid-session backstop is a one-shot for the absurd case
		// of >40 distinct files touched without a commit. Doc/plan files
		// are excluded so transient agent scratch (markdown plans, /docs)
		// doesn't pull the trigger. Token-band escalations only fire at
		// Stop, when the transcript is read once.
		enabled: true,
		stop_threshold: 5,
		mid_session_threshold: 40,
		token_band_low: 200_000,
		token_band_high: 400_000,
		doc_globs: [
			"**/*.md",
			"**/*.mdx",
			"**/*.txt",
			"**/*.rst",
			"docs/**",
			"plans/**",
			"notes/**",
			"**/CLAUDE.md",
			"**/AGENTS.md",
			"**/PLAN*.md",
		],
	},
	verification_stop_checks: {
		// Default-on: stderr-only Stop / SessionEnd reflection nudges, never
		// block. Six independent axes:
		//   - warn_unverified_code: code edits with no tsc/test/lint/build
		//     observed this session (signals captured at PreToolUse).
		//   - warn_verify_not_run: code edits where individual tools ran but
		//     `interlinked verify` (canonical local CI mirror) did not. The
		//     verify suite catches what individual tools miss — docs:check
		//     drift, secrets, SAST findings, dep-audit. A green tsc + npm test
		//     doesn't prove the verify suite is green.
		//   - warn_ui_not_interacted: UI-file edits with no dev-server or
		//     chrome-devtools/playwright MCP call (type-checking is not
		//     feature-checking, per feedback_landing_test_before_push.md).
		//   - warn_stubs_introduced: TODO/FIXME/disabled-test/throw-not-
		//     implemented patterns pushed into Write/Edit content during
		//     the session (scanned at PostToolUse).
		//   - warn_fixture_leaks: untracked src/**/_*.ts-shaped files whose
		//     basename appears in a writeFixture()/setupFixture()/createFixture()
		//     call in a tracked test file — the afterAll cleanup didn't run.
		//   - warn_unresolved_red: a check/test OBSERVED red this session
		//     (tsc/build/lint from observed_checks, plus stayed-red TDD
		//     cycles) that never went green again. Reflection only — the
		//     wording grants the legitimate "meant to leave it red" case.
		// Flip per-kind to false in `.interlinked/guard-rules.local.json` to
		// disable individual checks; flip the master `enabled` to silence
		// all six.
		enabled: true,
		warn_unverified_code: true,
		warn_verify_not_run: true,
		warn_ui_not_interacted: true,
		warn_stubs_introduced: true,
		warn_fixture_leaks: true,
		warn_unresolved_red: true,
	},
	content_scanner: {
		// Off by default — local runtime needs `pip install opf`; users opt in via
		// `.interlinked/guard-rules.local.json` → `"content_scanner": {"enabled": true}`.
		enabled: false,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
			user_prompt: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: DEFAULT_OPF_SIDECAR_SCRIPT,
			// Cold load (first scan includes multi-second model load + JIT warmup).
			startup_timeout_ms: 90_000,
			// Warm scans on CPU: ~200 ms for small inputs, but larger files (10-20
			// KB diffs) plus serialization behind other queued scans can exceed
			// 10s. 30s gives realistic headroom on CPU; GPUs can lower it.
			scan_timeout_ms: 30_000,
			// Free the model after 30 min idle to reclaim RAM; next scan re-spawns.
			idle_shutdown_ms: 30 * 60 * 1000,
			max_restarts: 3,
			// Three sidecars behind a round-robin pool — each Python instance is
			// single-threaded, so N children give N× concurrency for parallel
			// scans from multiple Claude sessions. ~800 MB per instance.
			// Children spawn lazily, so an idle workstation pays zero.
			pool_size: 3,
			// Precision-leaning Viterbi biases shipped under
			// sidecars/calibrations/high_precision.json. Trades recall for
			// fewer false positives on file paths, identifier-shaped strings,
			// and other low-confidence span entries the model loves to flag.
			// To restore stock OPF behavior, override to undefined or to the
			// adjacent default.json (zero biases) in guard-rules.local.json.
			viterbi_calibration_path: HIGH_PRECISION_OPF_CALIBRATION_PATH,
		},
		huggingface: {
			// NOT `openai/privacy-filter` — that model requires `trust_remote_code=True`
			// and is not served by the free HF Inference API. This slot is prepared for
			// `openai/gpt-oss-safeguard-20b` and similar standard-architecture models.
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		},
		custom_http: {
			endpoint: "",
			timeout_ms: 4000,
		},
		// 0 = every detected span blocks; OPF local omits score so min_score is
		// mostly meaningful for HF / custom-HTTP backends that do emit scores.
		min_score: 0,
		// Reuses the existing output_scanning cap so operators tune one knob, not two.
		max_scan_bytes: 100_000,
		// Curated FP-suppression list. Each entry kills a known false-positive
		// class observed against the OPF model in practice. Locals can append
		// in `.interlinked/guard-rules.local.json` — appended, never replaced.
		allowlist: [
			// noreply / no-reply addresses are transactional, not contactable PII.
			// `noreply@anthropic.com`, `no-reply@github.com`, etc.
			{
				kind: "prefix",
				pattern: "noreply@",
				label: "private_email",
				reason: "Transactional no-reply addresses are not personal contact info",
			},
			{
				kind: "prefix",
				pattern: "no-reply@",
				label: "private_email",
				reason: "Transactional no-reply addresses are not personal contact info",
			},
			// RFC 2606 reserved test domains.
			{
				kind: "email_domain",
				pattern: "example.com",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			{
				kind: "email_domain",
				pattern: "example.net",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			{
				kind: "email_domain",
				pattern: "example.org",
				label: "private_email",
				reason: "RFC 2606 reserved test domain",
			},
			// snake_case identifiers misread as person names — `content_scanner`,
			// `user_id`, `private_email` (yes, the model sometimes flags label
			// names from its own training set), etc. Real human names contain
			// spaces or capitals; this catches the FP cleanly.
			{
				kind: "snake_case_identifier",
				label: "private_person",
				reason: "snake_case identifier (config key, function name, etc.) — not a person",
			},
			// UUIDs in `secret` slot — canonical IDs are routinely flagged as
			// secrets by entropy-based detectors. UUIDs are designed to be
			// non-secret stable identifiers; treat as benign.
			{
				kind: "uuid",
				label: "secret",
				reason: "UUIDs are public stable identifiers, not secrets",
			},
		],
	},
	per_edit_coverage: {
		// DEFAULT OFF — per-edit coverage is opt-in per repo. A repo that does
		// not set this (or leaves `enabled: false`) pays ZERO cost: the guard
		// short-circuits to allow before any suite run, so there is no behavior
		// change. Repos with a fast suite opt in via
		// `.interlinked/guard-rules.local.json`:
		//   "per_edit_coverage": { "enabled": true }
		// THIS repo (interlinked-cli, ~16k tests) must NOT enable it — the suite
		// vastly exceeds the per-edit budget; the budget-gate would defer every
		// edit to a commit-time obligation anyway. See
		// docs/design/per-edit-coverage-enforcement.md.
		enabled: false,
		mode: "block",
		budget_ms: 25_000,
		languages: ["js", "ts"],
	},
};
