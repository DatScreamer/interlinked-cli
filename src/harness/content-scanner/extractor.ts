// ===========================================
// Content Scanner — Extractor
// ===========================================
//
// Pure synchronous helper: given a PreToolUse HarnessEvent + scanner config,
// return the scannable text fragments (or undefined when nothing applies).
// Per-tool extraction is explicit — there is no generic `tool_input` walker,
// which matches how the rest of the evaluator classifies tool calls.
//
// Gating: each hook phase is guarded by its own `scan_points` toggle so
// operators can narrow the feature without losing the others.

import type { JsonObject } from "../../lib/json-types.js";
import { resolveProposedContent } from "../overlay-content.js";
import type { HarnessEvent } from "../types.js";
import type { ContentScannerConfig, ContentScanRequest } from "./types.js";

// ===========================================
// Tool-name sets
// ===========================================

/** Write/Edit family — any tool that proposes new file content to land on disk. */
const WRITE_EDIT_TOOLS = new Set([
	"Write",
	"WriteFile",
	"write_file",
	"Edit",
	"EditFile",
	"edit_file",
	"MultiEdit",
	"NotebookEdit",
	"str_replace",
	"create",
	"apply_patch",
]);

/** Bash-family — any tool whose `tool_input.command` is a shell command string. */
const BASH_TOOLS = new Set(["Bash", "Shell", "shell", "bash", "run_command"]);

/** Web-fetching tools — first-class egress surface. */
const WEB_FETCH_TOOLS = new Set(["WebFetch", "web_fetch", "WebSearch"]);

// ===========================================
// Public API
// ===========================================

/**
 * Build the scannable-content bundle for a PreToolUse event.
 *
 * Returns `undefined` when the event carries nothing worth scanning, or when
 * every relevant `scan_points` toggle is off. Callers (pre-tool.ts) attach
 * the result to `decision._contentScan`; the async scan itself happens in
 * server.ts alongside the existing classifier flow.
 */
export function extractScannableContent(
	event: HarnessEvent,
	config: ContentScannerConfig,
): ContentScanRequest | undefined {
	const toolName = event.tool_name ?? "";
	if (!toolName) return undefined;

	const toolInput: JsonObject = event.tool_input ?? {};

	if (WRITE_EDIT_TOOLS.has(toolName)) {
		if (!config.scan_points.write_edit) return undefined;
		return buildWriteEditRequest(toolName, toolInput);
	}

	if (BASH_TOOLS.has(toolName)) {
		if (!config.scan_points.bash_command) return undefined;
		return buildBashRequest(toolInput);
	}

	if (WEB_FETCH_TOOLS.has(toolName)) {
		if (!config.scan_points.external_egress) return undefined;
		return buildWebFetchRequest(toolName, toolInput);
	}

	if (toolName.startsWith("mcp__")) {
		if (!config.scan_points.external_egress) return undefined;
		return buildMcpRequest(toolName, toolInput);
	}

	return undefined;
}

// ===========================================
// Per-tool builders
// ===========================================

/** Type-predicate that narrows `unknown` to a non-empty `string`. Encapsulates
 *  the `typeof` discriminator so callers read as intent. */
function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/** Return the value of a `JsonObject` key iff it is a non-empty string. */
function stringField(obj: JsonObject, key: string): string | undefined {
	const v = obj[key];
	return isNonEmptyString(v) ? v : undefined;
}

function buildWriteEditRequest(
	toolName: string,
	toolInput: JsonObject,
): ContentScanRequest | undefined {
	const filePath = stringField(toolInput, "file_path") ?? stringField(toolInput, "path") ?? "";
	const content = resolveProposedContent(filePath, toolInput);
	if (!content || content.length === 0) return undefined;
	return {
		hook: "pre_write_edit",
		parts: [{ source: `${toolName}.content`, text: content }],
	};
}

function buildBashRequest(toolInput: JsonObject): ContentScanRequest | undefined {
	const command = stringField(toolInput, "command");
	if (!command) return undefined;
	return {
		hook: "pre_bash_command",
		parts: [{ source: "Bash.command", text: command }],
	};
}

function buildWebFetchRequest(
	toolName: string,
	toolInput: JsonObject,
): ContentScanRequest | undefined {
	const parts: ContentScanRequest["parts"] = [];
	// URL — query params can carry email addresses, access tokens, etc.
	const url = stringField(toolInput, "url");
	if (url) parts.push({ source: `${toolName}.url`, text: url });
	// Prompt — agent-crafted text sent to the fetcher; ripe for accidental leakage.
	const prompt = stringField(toolInput, "prompt");
	if (prompt) parts.push({ source: `${toolName}.prompt`, text: prompt });
	// WebSearch carries its query in `query`.
	const query = stringField(toolInput, "query");
	if (query) parts.push({ source: `${toolName}.query`, text: query });
	if (parts.length === 0) return undefined;
	return { hook: "pre_external_egress", parts };
}

function buildMcpRequest(
	toolName: string,
	toolInput: JsonObject,
): ContentScanRequest | undefined {
	// Walk top-level string fields only — MCP tool schemas are typically flat,
	// and a full recursive walk raises the FP surface (keys, enum values, etc.).
	const parts: ContentScanRequest["parts"] = [];
	for (const key of Object.keys(toolInput)) {
		const v = stringField(toolInput, key);
		if (v) parts.push({ source: `${toolName}.${key}`, text: v });
	}
	if (parts.length === 0) return undefined;
	return { hook: "pre_external_egress", parts };
}
