// interlinked-tdd: exempt
// ===========================================
// PostToolUse pipeline — edited-path resolution
// ===========================================
// Leaf helper split verbatim out of `post-tool-pipeline.ts` to keep the
// orchestrator under the per-file line cap. Resolves which file(s) a
// PostToolUse edited (direct-edit declared paths or a source path scanned out
// of a Bash command). No module-private state — depends only on its argument
// + imports.

import { nonNull } from "../../lib/non-null.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";

/** Tool names that write a file to disk (direct dirty-layer + index update). */
const FILE_WRITE_TOOLS = [
	"Write",
	"Edit",
	"Update",
	"WriteFile",
	"EditFile",
	"write_file",
	"edit_file",
	"NotebookEdit",
];

/** Tool names treated as a direct single-file edit by the quality pipeline.
 *  Superset of {@link FILE_WRITE_TOOLS} plus the Copilot-CLI patch verbs. */
const DIRECT_FILE_EDIT_TOOLS = [
	...FILE_WRITE_TOOLS,
	// Copilot CLI
	"apply_patch",
	"str_replace",
	"create",
];

/** Tool names whose payload is a shell command that may edit files. */
const SHELL_TOOLS = ["Bash", "Shell", "shell", "run_command"];

/** Match an edited source-file path inside a Bash command (sed -i, awk >, tee,
 *  cat >, …) across the languages the pipeline knows how to check. Global so
 *  the resolver can skip PAST a generated artifact to a real source path. */
const BASH_EDITED_FILE_RE =
	/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|kt|kts|scala|lua|zig|nim|ex|exs|clj|cljs|ml|mli|hs|lhs|erl|hrl|dart|r|R|jl|v|sv|vhd|vhdl|pro|pl|pm|sh|bash|zsh|fish))\b/g;

/** Directory segments whose contents are GENERATED — never worth analyzing. */
const GENERATED_DIR_SEGMENTS = [
	"dist",
	"build",
	"node_modules",
	"coverage",
	".wrangler",
	".stryker-tmp",
	// Dotless twin of the above. Stryker's sandbox directory is only called
	// `.stryker-tmp` by DEFAULT — `tempDirName` renames it, and a sweep that
	// gives each run its own sandbox necessarily does. The contents are just as
	// generated (a full tree copy per run), so matching only the dotted form
	// left ~1GB of copied tree analyzable: measured 2026-08-04 as a 936MB RSS
	// spike in the daemon ledger plus anti-stomp restart churn.
	"stryker-tmp",
	".next",
	"out",
];

/**
 * Generated build artifacts must never enter the quality pipeline.
 *
 * The bash extractor used to match ANY source-looking path, so `rg -c …
 * dist/index.js` fed a 25,000-line bundle to the full inline-check family —
 * clone detection and AST parses over 300KB of generated code. Ledgered
 * 2026-07-28 as +922MB…+1078MB heap spikes in single 30s ticks ending in
 * row-less daemon deaths (OOM): the direct mechanism behind "the harness
 * keeps going down". Analyzing a bundle also has zero value — findings in
 * generated output are not actionable by editing it.
 *
 * Exported as the ONE generated-artifact predicate: the test corpus pins it
 * directly, and any other surface that fans analyzers over paths should
 * consult it rather than grow a second segment list.
 */
export function isGeneratedArtifactPath(path: string): boolean {
	const norm = path.replace(/\\/g, "/");
	if (/\.min\.[cm]?js$/.test(norm)) return true;
	const segments = norm.split("/");
	return segments.some((s) => GENERATED_DIR_SEGMENTS.includes(s));
}

/** The set of files a PostToolUse should fan its quality pipeline across,
 *  plus whether the triggering tool was a direct file edit and whether any
 *  checks should run at all. */
export interface EditedPathResolution {
	/** First/primary edited file (back-compat single-path value). */
	readonly editedFilePath: string;
	/** Full fan-out set — Codex `apply_patch` can carry multiple file sections. */
	readonly editedFilePaths: string[];
	readonly isDirectFileEdit: boolean;
	readonly shouldRunChecks: boolean;
}

function resolveDeclaredPaths(event: HarnessEvent, isDirectFileEdit: boolean): string[] {
	if (isDirectFileEdit) {
		return extractAllEditedFilePaths(event).filter((path) => !isGeneratedArtifactPath(path));
	}
	if (!event.tool_name || !SHELL_TOOLS.includes(event.tool_name)) return [];
	const cmd = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	BASH_EDITED_FILE_RE.lastIndex = 0;
	for (const match of cmd.matchAll(BASH_EDITED_FILE_RE)) {
		const candidate = nonNull(match[1]);
		if (!isGeneratedArtifactPath(candidate)) return [candidate];
	}
	return [];
}

function observedPaths(event: HarnessEvent): string[] {
	return (event.change_set?.files ?? [])
		.map((effect) => effect.path)
		.filter((path) => !isGeneratedArtifactPath(path));
}

/**
 * Resolve which file(s) this PostToolUse edited. Direct edits use the tool's
 * declared paths (Codex `apply_patch` may carry several); Bash/shell commands
 * are scanned for an edited source path so sed/awk/tee edits still get checked.
 */
export function resolveEditedPaths(event: HarnessEvent): EditedPathResolution {
	const isDirectFileEdit = Boolean(
		event.tool_name && DIRECT_FILE_EDIT_TOOLS.includes(event.tool_name),
	);
	const effects = observedPaths(event);
	const editedFilePaths = effects.length > 0
		? effects
		: resolveDeclaredPaths(event, isDirectFileEdit);
	const editedFilePath = editedFilePaths[0] || "";
	const shouldRunChecks = isDirectFileEdit || editedFilePaths.length > 0;
	return { editedFilePath, editedFilePaths, isDirectFileEdit, shouldRunChecks };
}
