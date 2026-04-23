// ===========================================
// Language Profiles — Multi-language support
// ===========================================
// Defines per-language toolchain profiles: type checkers, linters, test runners,
// and inline code-quality checks. Used by the harness evaluator to run the
// correct quality checks for whatever language a file belongs to.

import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { LanguageId, LanguageProfile } from "./types.js";

// ===========================================
// Extension → Language fast-lookup table
// ===========================================

/** Maps every known file extension to its LanguageId for O(1) lookup at runtime. */
const LANGUAGE_EXTENSION_MAP: Record<string, LanguageId> = {
	// TypeScript / JavaScript
	".ts": "typescript",
	".tsx": "typescript",
	".js": "typescript",
	".jsx": "typescript",
	".mjs": "typescript",
	".cjs": "typescript",

	// Python
	".py": "python",
	".pyi": "python",

	// Rust
	".rs": "rust",

	// Go
	".go": "go",

	// C / C++
	".c": "c_cpp",
	".cpp": "c_cpp",
	".cc": "c_cpp",
	".cxx": "c_cpp",
	".h": "c_cpp",
	".hpp": "c_cpp",
	".hxx": "c_cpp",

	// Java
	".java": "java",

	// Swift
	".swift": "swift",
};

// ===========================================
// Language Profile Definitions
// ===========================================

/**
 * Canonical language profiles keyed by LanguageId.
 *
 * Each profile declares:
 *  - file extensions and project-root markers for detection
 *  - optional type-checker, linter, and test runner commands
 *  - inline code-quality checks (pattern-based, no external tool)
 */
const LANGUAGE_PROFILES: Record<LanguageId, LanguageProfile> = {
	// -----------------------------------------
	// TypeScript / JavaScript
	// -----------------------------------------
	typescript: {
		id: "typescript",
		display_name: "TypeScript",
		file_extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		project_root_markers: ["tsconfig.json", "package.json"],
		type_check: {
			command: "npx tsc --noEmit --pretty false",
			append_file: false,
			config_files: ["tsconfig.json"],
			timeout_ms: 15_000,
			severity: "error",
			description: "TypeScript type checker (tsc --noEmit)",
		},
		linter: null, // handled by separate biome/eslint quality checks
		test_runner: {
			command: "npx vitest run",
			timeout_ms: 15_000,
			severity: "error",
			description: "Vitest test runner",
		},
		inline_checks: [], // strong_typing is handled separately in quality-checks.ts
	},

	// -----------------------------------------
	// Python
	// -----------------------------------------
	python: {
		id: "python",
		display_name: "Python",
		file_extensions: [".py", ".pyi"],
		project_root_markers: [
			"pyproject.toml",
			"setup.py",
			"setup.cfg",
			"requirements.txt",
			"Pipfile",
		],
		type_check: {
			command: "python -m mypy --no-error-summary",
			append_file: true,
			config_files: ["mypy.ini", "pyproject.toml", "setup.cfg"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "mypy static type checker",
		},
		linter: {
			command: "ruff check",
			append_file: true,
			config_files: ["ruff.toml", "pyproject.toml", ".ruff.toml"],
			timeout_ms: 5_000,
			severity: "warning",
			description: "Ruff linter",
		},
		test_runner: {
			command: "python -m pytest -x --tb=short -q",
			timeout_ms: 15_000,
			severity: "error",
			description: "pytest test runner",
		},
		inline_checks: [
			{
				name: "python_bare_except",
				description: "Detect bare `except:` without exception type",
				file_types: [".py"],
				severity: "warning",
				fix_instruction: "Catch specific exceptions instead of bare except",
			},
			{
				name: "python_mutable_default",
				description: "Detect mutable default arguments (def foo(x=[]) or def foo(x={}))",
				file_types: [".py"],
				severity: "warning",
				fix_instruction: "Use None as default and assign mutable in function body",
			},
		],
	},

	// -----------------------------------------
	// Rust
	// -----------------------------------------
	rust: {
		id: "rust",
		display_name: "Rust",
		file_extensions: [".rs"],
		project_root_markers: ["Cargo.toml"],
		type_check: {
			command: "cargo check --message-format=short",
			append_file: false,
			config_files: ["Cargo.toml"],
			timeout_ms: 30_000,
			severity: "error",
			description: "cargo check (type and borrow checker)",
		},
		linter: {
			command: "cargo clippy --message-format=short -- -D warnings",
			append_file: false,
			config_files: ["Cargo.toml"],
			timeout_ms: 30_000,
			severity: "warning",
			description: "Clippy lint suite",
		},
		test_runner: {
			command: "cargo test --no-run",
			timeout_ms: 30_000,
			severity: "error",
			description: "cargo test (compile-only, no execution)",
		},
		inline_checks: [
			{
				name: "rust_unsafe_blocks",
				description: "Detect `unsafe {` or `unsafe fn` blocks",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Document safety invariants with // SAFETY: comment",
			},
			{
				name: "rust_unwrap_usage",
				description: "Detect .unwrap() in non-test code",
				file_types: [".rs"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Use .expect() with a message or handle the error with ?",
			},
			{
				name: "rust_todo_macro",
				description: "Detect todo!() or unimplemented!() macros",
				file_types: [".rs"],
				severity: "warning",
				fix_instruction: "Replace with actual implementation or proper error handling",
			},
		],
	},

	// -----------------------------------------
	// Go
	// -----------------------------------------
	go: {
		id: "go",
		display_name: "Go",
		file_extensions: [".go"],
		project_root_markers: ["go.mod"],
		type_check: {
			command: "go build ./...",
			append_file: false,
			config_files: ["go.mod"],
			timeout_ms: 15_000,
			severity: "error",
			description: "go build (compile check)",
		},
		linter: {
			command: "golangci-lint run",
			append_file: false,
			config_files: ["go.mod", ".golangci.yml", ".golangci.yaml"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "golangci-lint meta-linter",
		},
		test_runner: {
			command: "go test ./...",
			timeout_ms: 15_000,
			severity: "error",
			description: "go test runner",
		},
		inline_checks: [
			{
				name: "go_error_ignored",
				description: "Detect ignored errors (err assigned to _ or discarded)",
				file_types: [".go"],
				severity: "warning",
				fix_instruction: "Handle errors explicitly \u2014 don't discard with _",
			},
		],
	},

	// -----------------------------------------
	// C / C++
	// -----------------------------------------
	c_cpp: {
		id: "c_cpp",
		display_name: "C/C++",
		file_extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
		project_root_markers: ["CMakeLists.txt", "Makefile", "meson.build", "configure.ac"],
		type_check: {
			command: "make",
			append_file: false,
			config_files: ["Makefile", "CMakeLists.txt"],
			timeout_ms: 30_000,
			severity: "error",
			description: "make (compile check)",
		},
		linter: {
			command: "clang-tidy",
			append_file: true,
			config_files: [".clang-tidy"],
			timeout_ms: 15_000,
			severity: "warning",
			description: "clang-tidy static analyzer",
		},
		test_runner: {
			command: "ctest --output-on-failure",
			timeout_ms: 30_000,
			severity: "error",
			description: "CTest runner",
		},
		inline_checks: [
			{
				name: "c_unsafe_functions",
				description:
					"Detect unsafe C functions: strcpy, strcat, gets, sprintf (not snprintf)",
				file_types: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
				severity: "warning",
				fix_instruction: "Use safer alternatives: strncpy, strncat, fgets, snprintf",
			},
			{
				name: "c_include_guard",
				description: "Detect header files missing #pragma once or #ifndef guard",
				file_types: [".h", ".hpp", ".hxx"],
				severity: "warning",
				fix_instruction: "Add #pragma once or include guard",
			},
		],
	},

	// -----------------------------------------
	// Java
	// -----------------------------------------
	java: {
		id: "java",
		display_name: "Java",
		file_extensions: [".java"],
		project_root_markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
		type_check: null, // compile check via build tool is too slow for per-edit
		linter: null, // checkstyle is heavy; rely on inline checks
		test_runner: null, // mvn test / gradle test too slow for per-edit
		inline_checks: [
			{
				name: "java_wildcard_import",
				description: "Detect wildcard imports (import .*.*)",
				file_types: [".java"],
				severity: "warning",
				fix_instruction: "Use explicit imports instead of wildcards",
			},
			{
				name: "java_system_exit",
				description: "Detect System.exit() calls in non-main files",
				file_types: [".java"],
				severity: "warning",
				fix_instruction: "Throw an exception instead of calling System.exit()",
			},
		],
	},
	// -----------------------------------------
	// Swift
	// -----------------------------------------
	swift: {
		id: "swift",
		display_name: "Swift",
		file_extensions: [".swift"],
		project_root_markers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
		type_check: {
			command: "swift build --skip-update 2>&1",
			append_file: false,
			config_files: ["Package.swift"],
			timeout_ms: 30_000,
			severity: "error",
			description: "swift build (SPM type/compile check)",
		},
		linter: {
			command: "swiftlint lint --quiet --reporter json",
			append_file: true,
			config_files: [".swiftlint.yml", ".swiftlint.yaml"],
			timeout_ms: 10_000,
			severity: "warning",
			description: "SwiftLint linter",
		},
		test_runner: {
			command: "swift test --skip-build",
			timeout_ms: 30_000,
			severity: "error",
			description: "swift test runner",
		},
		inline_checks: [
			// --- Apple API Design Guidelines ---
			{
				name: "swift_force_cast",
				description: "Detect force casts (as!) — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use conditional cast (as?) with optional binding instead of force cast (as!)",
			},
			{
				name: "swift_force_try",
				description: "Detect force try (try!) — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction: "Use do/catch or try? instead of try!",
			},
			{
				name: "swift_force_unwrap",
				description: "Detect force unwrap (!) on optionals — runtime crash risk",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use optional binding (if let/guard let) or nil-coalescing (??) instead of force unwrap",
			},
			{
				name: "swift_implicitly_unwrapped_optional",
				description: "Detect implicitly unwrapped optionals (Type!) outside @IBOutlet",
				file_types: [".swift"],
				severity: "warning",
				skip_test_files: true,
				fix_instruction:
					"Use regular optionals (Type?) with proper unwrapping instead of implicitly unwrapped optionals",
			},
			// --- Memory Safety (Apple Swift Book) ---
			{
				name: "swift_delegate_not_weak",
				description: "Detect delegate properties not declared as weak — retain cycle risk",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Declare delegate properties as weak: `weak var delegate: SomeDelegate?`",
			},
			{
				name: "swift_legacy_random",
				description: "Detect legacy arc4random() usage — use modern Swift random APIs",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Use Int.random(in:), Bool.random(), or Collection.randomElement() instead of arc4random",
			},
			{
				name: "swift_legacy_hashvalue",
				description: "Detect legacy hashValue implementation — use hash(into:) instead",
				file_types: [".swift"],
				severity: "warning",
				fix_instruction:
					"Implement hash(into hasher: inout Hasher) instead of var hashValue: Int",
			},
		],
	},
};

// ===========================================
// Helper Functions
// ===========================================

/**
 * Detect the language of a file by its extension.
 * Returns null if the extension is not recognised.
 */
function detectLanguage(filePath: string): LanguageId | null {
	const ext = extname(filePath).toLowerCase();
	return LANGUAGE_EXTENSION_MAP[ext] ?? null;
}

/**
 * Return the full language profile for a file, or null if unrecognised.
 */
export function getProfileForFile(filePath: string): LanguageProfile | null {
	const lang = detectLanguage(filePath);
	if (!lang) return null;
	return LANGUAGE_PROFILES[lang];
}

/**
 * Walk up the directory tree from `startPath` looking for any of the
 * profile's `project_root_markers`. Returns the first directory that
 * contains a marker, or null if none is found (stops at filesystem root).
 */
export function findProjectRootForLanguage(
	startPath: string,
	profile: LanguageProfile,
): string | null {
	let dir = resolve(startPath);

	// If startPath is a file, begin from its parent directory
	try {
		// extname returns "" for directories — quick heuristic
		if (extname(dir) !== "") {
			dir = dirname(dir);
		}
	} catch {
		// resolve/dirname failed — bail out
		return null;
	}

	const root = resolve("/");

	while (true) {
		for (const marker of profile.project_root_markers) {
			if (existsSync(join(dir, marker))) {
				return dir;
			}
		}

		const parent = dirname(dir);
		if (parent === dir || parent === root) {
			// Reached filesystem root without finding a marker
			return null;
		}
		dir = parent;
	}
}
