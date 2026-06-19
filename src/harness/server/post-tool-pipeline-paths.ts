// interlinked-tdd: exempt
// ===========================================
// PostToolUse pipeline — edited-path resolution
// ===========================================
// Leaf helper split verbatim out of `post-tool-pipeline.ts` to keep the
// orchestrator under the per-file line cap. Resolves which file(s) a
// PostToolUse edited (direct-edit declared paths or a source path scanned out
// of a Bash command). No module-private state — depends only on its argument
// + imports.

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
 *  cat >, …) across the languages the pipeline knows how to check. */
const BASH_EDITED_FILE_RE =
	/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|kt|kts|scala|lua|zig|nim|ex|exs|clj|cljs|ml|mli|hs|lhs|erl|hrl|dart|r|R|jl|v|sv|vhd|vhdl|pro|pl|pm|sh|bash|zsh|fish))\b/;

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

/**
 * Resolve which file(s) this PostToolUse edited. Direct edits use the tool's
 * declared paths (Codex `apply_patch` may carry several); Bash/shell commands
 * are scanned for an edited source path so sed/awk/tee edits still get checked.
 */
export function resolveEditedPaths(event: HarnessEvent): EditedPathResolution {
	const isDirectFileEdit = Boolean(
		event.tool_name && DIRECT_FILE_EDIT_TOOLS.includes(event.tool_name),
	);

	let editedFilePath = "";
	let editedFilePaths: string[] = [];
	if (!isDirectFileEdit && event.tool_name && SHELL_TOOLS.includes(event.tool_name)) {
		const cmd = (event.tool_input?.command as string) || "";
		const editedFileMatch = cmd.match(BASH_EDITED_FILE_RE);
		if (editedFileMatch) {
			editedFilePath = editedFileMatch[1];
			editedFilePaths = [editedFilePath];
		}
	} else if (isDirectFileEdit) {
		editedFilePaths = extractAllEditedFilePaths(event);
		editedFilePath = editedFilePaths[0] || "";
	}

	const shouldRunChecks =
		isDirectFileEdit || editedFilePath.length > 0 || editedFilePaths.length > 0;
	return { editedFilePath, editedFilePaths, isDirectFileEdit, shouldRunChecks };
}
