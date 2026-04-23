// ===========================================
// Built-in Rules — Language-Specific Destructive Write Patterns
// ===========================================
// These fire on Write/Edit tools when the source code being written
// contains destructive filesystem operations: Python/Rust/Go/C/C++/Java.
// Also covers lockfile tampering via Write/Edit and shell rm of lockfiles.

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const LANGUAGE_DESTRUCTIVE_RULES: GuardRule[] = [
	// --- Python destructive filesystem operations ---
	{
		id: "builtin-python-destructive-fs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bos\\.remove\\s*\\(" },
			{ field: "new_string", regex: "\\bos\\.remove\\s*\\(" },
			{ field: "content", regex: "\\bshutil\\.rmtree\\s*\\(" },
			{ field: "new_string", regex: "\\bshutil\\.rmtree\\s*\\(" },
			{
				field: "content",
				regex: "\\bsubprocess\\.(?:run|call|Popen)\\s*\\(\\s*['\"]rm\\b",
			},
			{
				field: "new_string",
				regex: "\\bsubprocess\\.(?:run|call|Popen)\\s*\\(\\s*['\"]rm\\b",
			},
		],
		reason: "Python code contains destructive filesystem operations",
		suggestion:
			"Verify the target paths are correct and consider using a safer pattern (e.g., moving to trash instead of deleting)",
		severity: "medium",
		category: "language-destructive",
	},

	// --- Python DROP TABLE in ORM/raw SQL ---
	{
		id: "builtin-python-drop-table",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bDROP\\s+TABLE\\b", flags: "i" },
			{ field: "new_string", regex: "\\bDROP\\s+TABLE\\b", flags: "i" },
		],
		reason: "Code contains DROP TABLE statement in ORM/raw SQL",
		suggestion: "Verify this is intentional and ensure a backup exists before dropping tables",
		severity: "high",
		category: "language-destructive",
	},

	// --- Rust destructive filesystem operations ---
	{
		id: "builtin-rust-destructive-fs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bfs::remove_dir_all\\s*\\(" },
			{ field: "new_string", regex: "\\bfs::remove_dir_all\\s*\\(" },
			{ field: "content", regex: '\\bCommand::new\\s*\\(\\s*"rm"' },
			{ field: "new_string", regex: '\\bCommand::new\\s*\\(\\s*"rm"' },
		],
		reason: "Rust code contains destructive filesystem operations",
		suggestion: "Verify the target paths are correct and consider using a safer pattern",
		severity: "medium",
		category: "language-destructive",
	},

	// --- Go destructive filesystem operations ---
	{
		id: "builtin-go-destructive-fs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bos\\.RemoveAll\\s*\\(" },
			{ field: "new_string", regex: "\\bos\\.RemoveAll\\s*\\(" },
			{ field: "content", regex: '\\bexec\\.Command\\s*\\(\\s*"rm"' },
			{ field: "new_string", regex: '\\bexec\\.Command\\s*\\(\\s*"rm"' },
		],
		reason: "Go code contains destructive filesystem operations",
		suggestion: "Verify the target paths are correct and consider using a safer pattern",
		severity: "medium",
		category: "language-destructive",
	},

	// --- C/C++ destructive filesystem operations ---
	{
		id: "builtin-c-destructive-fs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bunlink\\s*\\(" },
			{ field: "new_string", regex: "\\bunlink\\s*\\(" },
			{ field: "content", regex: '\\bsystem\\s*\\(\\s*"rm\\b' },
			{ field: "new_string", regex: '\\bsystem\\s*\\(\\s*"rm\\b' },
			{ field: "content", regex: "\\bremove\\s*\\(\\s*[\"']" },
			{ field: "new_string", regex: "\\bremove\\s*\\(\\s*[\"']" },
		],
		reason: "C/C++ code contains destructive filesystem operations",
		suggestion: "Verify the target paths are correct and consider safer alternatives",
		severity: "medium",
		category: "language-destructive",
	},

	// --- Java destructive filesystem operations ---
	{
		id: "builtin-java-destructive-fs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{ field: "content", regex: "\\bFileUtils\\.deleteDirectory\\s*\\(" },
			{ field: "new_string", regex: "\\bFileUtils\\.deleteDirectory\\s*\\(" },
			{ field: "content", regex: "\\bFiles\\.deleteIfExists\\s*\\(" },
			{ field: "new_string", regex: "\\bFiles\\.deleteIfExists\\s*\\(" },
			{ field: "content", regex: '\\bRuntime\\..*exec\\s*\\(\\s*"rm\\b' },
			{ field: "new_string", regex: '\\bRuntime\\..*exec\\s*\\(\\s*"rm\\b' },
		],
		reason: "Java code contains destructive filesystem operations",
		suggestion: "Verify the target paths are correct and consider safer alternatives",
		severity: "medium",
		category: "language-destructive",
	},

	// ===========================================
	// Lock file deletion via shell (Feature 1)
	// ===========================================
	{
		id: "builtin-rm-lockfile",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\brm\\s+(-[rf]+\\s+)*(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb|Cargo\\.lock|poetry\\.lock|Gemfile\\.lock|go\\.sum|composer\\.lock|uv\\.lock)\\b",
				flags: "i",
			},
		],
		reason: "Deleting lock files breaks deterministic dependency resolution",
		suggestion:
			"If you need to regenerate, delete the lock file and reinstall: rm <lockfile> && <install_command>",
		severity: "high",
		category: "supply-chain",
	},

	// ===========================================
	// Lock file tampering via Write/Edit (Feature 3)
	// ===========================================
	{
		id: "builtin-lockfile-tamper",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "block",
		patterns: [
			{
				field: "file_path",
				regex: "(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb|Cargo\\.lock|poetry\\.lock|Gemfile\\.lock|go\\.sum|composer\\.lock|uv\\.lock)$",
			},
		],
		reason: "Lock files should only be modified by package managers, not by direct editing. Direct edits can introduce supply chain vulnerabilities",
		suggestion:
			"Use the package manager (npm install, cargo update, etc.) to update dependencies",
		severity: "critical",
		category: "supply-chain",
	},

	// ===========================================
	// Supply chain: --ignore-scripts enforcement
	// ===========================================
	// npm postinstall/preinstall lifecycle scripts are the #1 supply chain attack vector.
	// The axios@1.14.1 compromise (2026-03-31) used a phantom dependency with a postinstall
	// script that dropped a cross-platform RAT. --ignore-scripts prevents this entire class.
	{
		id: "builtin-npm-no-ignore-scripts",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{
				field: "command",
				regex: "\\b(?:npm|pnpm)\\s+(?:install|ci|add|i)(?:\\s|$|&&|\\||;)|\\b(?:yarn|bun)\\s+(?:install|add|i)(?:\\s|$|&&|\\||;)",
			},
			{
				field: "command",
				regex: "--ignore-scripts",
				negate: true,
			},
		],
		reason: "Package install without --ignore-scripts. Lifecycle scripts (postinstall/preinstall) can execute arbitrary code from dependencies — this is the #1 npm supply chain attack vector (ref: axios@1.14.1 compromise, plain-crypto-js RAT dropper)",
		suggestion:
			"Add --ignore-scripts to prevent malicious lifecycle scripts: npm install --ignore-scripts. If native modules need compilation (esbuild, sharp, bcrypt), run their build scripts explicitly after review",
		severity: "medium",
		category: "supply-chain",
	},
];
