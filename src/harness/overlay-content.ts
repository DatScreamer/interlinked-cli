// ===========================================
// Overlay Content Resolution
// ===========================================
// Resolves the PROPOSED FULL FILE CONTENT for a write/edit tool call, so
// downstream content-quality checks (biome diff-overlay, tsc diff-overlay,
// pre_block registry) see the file as it WOULD be after the edit lands —
// not just the replacement snippet.
//
// Running checks on just `new_string` produces false-positive "undefined
// symbol" / "unused variable" errors for every out-of-hunk reference,
// because the snippet has no imports, no surrounding function context,
// and no type definitions. This module fixes that by computing the
// post-patch full content.

import { existsSync, readFileSync } from "node:fs";
import type { JsonObject } from "../lib/json-types.js";

interface MultiEditEntry {
	old_string?: string;
	new_string?: string;
}

/**
 * Compute the proposed full file content for a file-write tool call.
 *
 * Semantics by tool:
 *   Write       → `tool_input.content` is already the full file.
 *   Edit        → `tool_input.new_string` is just the replacement snippet;
 *                 splice it into the current disk content at `old_string`.
 *   MultiEdit   → apply `edits` array in sequence.
 *
 * When the splice can't succeed (file missing, old_string not found), we
 * fall back to the raw `new_string` — downstream checks may over-flag, but
 * that's strictly better than skipping checks entirely.
 */
export function resolveProposedContent(filePath: string, toolInput: JsonObject): string {
	// Write tool: `content` is the full file.
	if (typeof toolInput.content === "string") return toolInput.content;

	// Read the current disk content as the base.
	let base = "";
	try {
		if (existsSync(filePath)) base = readFileSync(filePath, "utf-8");
	} catch (_err) {
		void 0; /* intentional: intentional: fall through — no base content means we'll only have
		 * the new_string, which is the best we can do for a new-file Edit. */
	}

	// MultiEdit: apply the `edits` array in sequence.
	const edits = toolInput.edits;
	if (Array.isArray(edits)) {
		let current = base;
		for (const e of edits) {
			if (!e || typeof e !== "object") continue;
			const entry = e as MultiEditEntry;
			const oldStr = entry.old_string ?? "";
			const newStr = entry.new_string ?? "";
			if (oldStr && current.includes(oldStr)) {
				current = current.replace(oldStr, newStr);
			}
		}
		return current;
	}

	// Edit tool: splice old_string → new_string.
	const oldString = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
	const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
	if (oldString && base.includes(oldString)) {
		return base.replace(oldString, newString);
	}

	// Fallback — can't compute proposed content reliably.
	return newString || base;
}
