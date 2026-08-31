// ===========================================
// Reservation target path extraction
// ===========================================
// PreToolUse grants and PostToolUse idle-release scheduling must derive the
// exact same cache keys. Keep this leaf free of reservation-manager concerns
// so both evaluator phases can share it without introducing a dependency
// cycle.

import { resolve } from "node:path";
import {
	extractApplyPatchRaw,
	looksLikeApplyPatch,
	parseApplyPatchSections,
} from "./apply-patch-content.js";
import type { HarnessEvent } from "./types.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/**
 * Every path a write-class tool call can mutate.
 *
 * Named Write/Edit paths intentionally retain their existing spelling because
 * remote reservation patterns may be relative. Codex/Copilot `apply_patch`
 * envelopes do not carry a named path, so every section destination and move
 * source is resolved against the event CWD and de-duplicated in source order.
 */
export function reservationTargetPaths(event: HarnessEvent, toolInput: ToolInput): string[] {
	const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
	const pathAlias = typeof toolInput.path === "string" ? toolInput.path : "";
	const namedPath = filePath || pathAlias;
	if (namedPath) return [namedPath];

	const raw = extractApplyPatchRaw(toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return [];

	const cwd = event.cwd || process.cwd();
	const targets = new Set<string>();
	for (const section of parseApplyPatchSections(raw)) {
		targets.add(resolve(cwd, section.path));
		if (section.fromPath) targets.add(resolve(cwd, section.fromPath));
	}
	return [...targets];
}
