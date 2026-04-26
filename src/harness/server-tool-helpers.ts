// ===========================================
// Server tool-event helpers
// ===========================================
// Extracted from server.ts. Pure functions — no module-level state.

import type { HarnessEvent } from "./types.js";

const APPLY_PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/m;
const APPLY_PATCH_MOVE_LINE = /^\*\*\* Move to:\s+(.+)$/m;

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Extract the destination file path from a raw apply_patch payload. */
export function extractApplyPatchFilePath(command: string): string | null {
	const movePath = nonEmptyString(command.match(APPLY_PATCH_MOVE_LINE)?.[1]);
	if (movePath) return movePath;
	return nonEmptyString(command.match(APPLY_PATCH_FILE_LINE)?.[1]);
}

/** Resolve the edited file path from a hook event when one exists. */
export function extractEditedFilePath(event: HarnessEvent): string | null {
	const explicitPath =
		nonEmptyString(event.tool_input?.file_path) ??
		nonEmptyString(event.tool_input?.filePath) ??
		nonEmptyString(event.tool_input?.path) ??
		nonEmptyString(event.tool_input?.target_file);
	if (explicitPath) return explicitPath;

	const modifiedPath = nonEmptyString(event.files_modified?.[0]);
	if (modifiedPath) return modifiedPath;

	if (event.tool_name === "apply_patch") {
		return extractApplyPatchFilePath(String(event.tool_input?.command || ""));
	}

	return null;
}

/** Build a one-line summary of the tool being invoked. Used in log lines
 *  and error messages. Capped at 200 chars for commands/URLs. */
export function summarizeToolInput(event: HarnessEvent): string {
	if (!event.tool_input) return event.tool_name || "";
	const input = event.tool_input;
	if (event.tool_name === "apply_patch") {
		const patchPath = extractApplyPatchFilePath(String(input.command || ""));
		if (patchPath) return patchPath;
	}
	if (input.command) return String(input.command).slice(0, 200);
	if (input.file_path) return String(input.file_path);
	if (input.url) return String(input.url).slice(0, 200);
	return event.tool_name || "";
}

/** True for Pre-tool-use events across all supported runners (Claude Code
 *  "PreToolUse" and Gemini CLI "BeforeTool"). */
export function isPreToolUse(event: HarnessEvent): boolean {
	return event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool";
}

/** True for Post-tool-use events (including the failure variant) across
 *  all supported runners. */
export function isPostToolUse(event: HarnessEvent): boolean {
	return (
		event.hook_event === "PostToolUse" ||
		event.hook_event === "AfterTool" ||
		event.hook_event === "PostToolUseFailure"
	);
}
