// interlinked-tdd: exempt — module-level constant `Set`s only (env-var
// safety classification data); no logic, exercised by evaluator tests.
// ===========================================
// Interlinked Harness — Env Var Safety Classification
// ===========================================

/**
 * Environment variables known to be safe as command prefixes.
 * These don't alter code execution semantics — they only control
 * output, locale, or build-tool behavior.
 */
export const SAFE_ENV_VARS = new Set([
	// Build/runtime flags
	"NODE_ENV",
	"NODE_OPTIONS",
	"CI",
	"DEBUG",
	"VERBOSE",
	"LOG_LEVEL",
	"RUST_LOG",
	"RUST_BACKTRACE",
	"GOEXPERIMENT",
	"GOFLAGS",
	"CGO_ENABLED",
	"PYTHONDONTWRITEBYTECODE",
	"PYTHONUNBUFFERED",
	"PIP_DISABLE_PIP_VERSION_CHECK",
	// Locale/terminal
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"COLORTERM",
	"FORCE_COLOR",
	"NO_COLOR",
	"TZ",
	"COLUMNS",
	"LINES",
	// Common tool configs
	"EDITOR",
	"VISUAL",
	"PAGER",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	// Package managers
	"NPM_CONFIG_LOGLEVEL",
	"YARN_SILENT",
	"CARGO_TERM_COLOR",
]);

/**
 * Environment variables that are DANGEROUS as command prefixes.
 * These can alter execution, inject code, or hijack library loading.
 * If ANY of these appear, the command is flagged regardless of what follows.
 */
export const DANGEROUS_ENV_VARS = new Set([
	"PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"RUBYLIB",
	"RUBYOPT",
	"PERL5LIB",
	"PERL5OPT",
	"NODE_PATH",
	"HOME",
	"USER",
	"SHELL",
	"DOCKER_HOST",
	"KUBECONFIG",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"NPM_TOKEN",
]);
