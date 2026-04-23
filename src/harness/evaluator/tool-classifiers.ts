// ===========================================
// Tool Classification + Glob Matching Helpers
// ===========================================
//
// Small utilities shared across the evaluator split. Keeping these in a
// single module avoids forcing callers to remember which helper lives
// where when they classify tool names during guard evaluation.

import { existsSync, readFileSync } from "node:fs";

/** Public API — consumed by evaluator sub-modules to detect Bash-family tool calls. */
export function isBash(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Bash", "Shell", "shell", "bash", "run_command"].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect browser-navigation tool calls. */
export function isBrowserNavigate(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return /^mcp__(?:playwright|chrome-devtools)__(?:browser_navigate|navigate_page|new_page)$/.test(
		toolName,
	);
}

/** Public API — consumed by evaluator sub-modules to detect any file-related tool (read + write). */
export function isFileOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Read",
		"Write",
		"Edit",
		"ReadFile",
		"WriteFile",
		"EditFile",
		"read_file",
		"write_file",
		"edit_file",
		"FileRead",
		"FileWrite",
		"FileEdit",
		"FileDelete",
		// Copilot CLI
		"view",
		"str_replace",
		"create",
		"apply_patch",
	].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect file-read tool calls. */
export function isReadOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Read", "ReadFile", "read_file", "FileRead", "view"].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect file-write tool calls. */
export function isFileWrite(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"FileWrite",
		"FileEdit",
		"NotebookEdit",
		// Copilot CLI
		"str_replace",
		"create",
		"apply_patch",
	].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to estimate the line number of an Edit by
 *  finding old_string in the file. Returns undefined when file is missing or match fails. */
export function estimateEditLine(filePath: string, oldString: string): number | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const idx = content.indexOf(oldString);
		if (idx === -1) return undefined;
		// Count newlines before the match
		return content.slice(0, idx).split("\n").length;
	} catch {
		return undefined;
	}
}

/** Jupyter NotebookEdit is classified as a write despite its name containing "edit",
 *  because its semantics match Write for reservation + protected-file purposes. */
const NOTEBOOK_EDIT_TOOL = "notebookedit";

/** Public API — consumed by evaluator sub-modules to map a tool name to a canonical
 *  protected-file operation identifier (Read / Write / Edit / Delete). */
export function normalizeToolToOp(toolName: string): string {
	const lower = toolName.toLowerCase();
	if (lower.includes("read")) return "Read";
	if (lower.includes("write") || lower === NOTEBOOK_EDIT_TOOL) return "Write";
	if (lower.includes("edit")) return "Edit";
	if (lower.includes("delete")) return "Delete";
	return toolName;
}

// ===========================================
// Glob Matching (simple, no dependencies)
// ===========================================

/** Public API — consumed by evaluator sub-modules to match file paths against
 *  the subset of glob patterns used in guard-rules.json + file_reminders. */
export function globMatch(filePath: string, pattern: string): boolean {
	// Handle pipe-separated patterns: "**/*.pem|**/*.key"
	if (pattern.includes("|")) {
		return pattern.split("|").some((p) => globMatch(filePath, p.trim()));
	}

	// Exact match
	if (filePath === pattern) return true;

	// "**/*.ext" — match any file with that extension
	if (pattern.startsWith("**/")) {
		const rest = pattern.slice(3);
		if (rest.startsWith("*.")) {
			const suffix = rest.slice(1); // e.g., ".env*"
			if (suffix.endsWith("*")) {
				// "**/*.env*" — match files containing ".env" in the name
				const core = suffix.slice(0, -1); // ".env"
				return filePath.includes(core);
			}
			return filePath.endsWith(suffix);
		}
		return filePath.endsWith(`/${rest}`) || filePath === rest;
	}

	// "*.ext" — match files with that extension (any directory)
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1);
		if (suffix.endsWith("*")) {
			const core = suffix.slice(0, -1);
			return filePath.includes(core);
		}
		return filePath.endsWith(suffix);
	}

	// "dir/**" — match anything under dir
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return filePath.startsWith(`${prefix}/`) || filePath === prefix;
	}

	// "dir/*" — match direct children
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2);
		return (
			filePath.startsWith(`${prefix}/`) && !filePath.slice(prefix.length + 1).includes("/")
		);
	}

	return false;
}
