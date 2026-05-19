// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Language Profile & Tool Concurrency Types
// ===========================================

// ===========================================
// Language Profiles — Multi-language support
// ===========================================

export type LanguageId =
	| "typescript"
	| "python"
	| "rust"
	| "go"
	| "c_cpp"
	| "java"
	| "swift"
	| "cuda"
	| "opencl"
	| "metal"
	| "hlsl"
	| "wgsl";

export interface LanguageProfile {
	id: LanguageId;
	display_name: string;
	file_extensions: string[];
	project_root_markers: string[];
	type_check: LanguageCheckDef | null;
	linter: LanguageCheckDef | null;
	test_runner: LanguageTestDef | null;
	inline_checks: InlineCheckDef[];
}

export interface LanguageCheckDef {
	command: string;
	append_file: boolean;
	config_files?: string[];
	timeout_ms: number;
	severity: "error" | "warning";
	description: string;
}

export interface LanguageTestDef {
	command: string;
	timeout_ms: number;
	severity: "error" | "warning";
	description: string;
}

export interface InlineCheckDef {
	name: string;
	description: string;
	file_types: string[];
	severity: "error" | "warning";
	skip_test_files?: boolean;
	fix_instruction: string;
	/** Regex source matched (after comment/string stripping) against each line.
	 *  Runner uses `new RegExp(pattern, pattern_flags ?? "gm")`. */
	pattern: string;
	/** Optional regex flags; default "gm". */
	pattern_flags?: string;
	/** Optional per-line exemption regex. If set and the raw (un-stripped) line
	 *  matches, the finding on that line is dropped. Useful for // SAFETY:
	 *  comments above an unsafe block, or @IBOutlet on implicitly-unwrapped. */
	exempt_if_line_matches?: string;
}

// ===========================================
// Tool Concurrency Classification
// ===========================================

/** Whether a tool call is safe to run concurrently with other calls */
export type ToolConcurrencyClass = "read_only" | "state_changing" | "unknown";
