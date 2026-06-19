// interlinked-tdd: exempt
// ===========================================
// Hook-entry cold fail-closed gates — block-reason computation
// ===========================================
// The pure "should the cold path BLOCK this event?" helpers, extracted from
// hook-entry.ts (leaf cluster: depends only on its own logic + imports; the
// main file imports the five `cold*BlockReason` entry points back). Each
// returns the block reason string, or null when the event is benign / not the
// shape that gate guards. No daemon state — these run when the socket is
// unreachable, so they must mirror the daemon's deterministic checks exactly.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { evaluatePackageInstall } from "./harness/evaluator/package-install-guard.js";
import { loadAllowlist } from "./harness/package-allowlist.js";
import { parseInstallCommands } from "./harness/package-install-parser.js";
import { checkLargeFileLineCountWrite } from "./harness/pre-checks.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import { checkDestructiveCommand } from "./lib/hook-template-chunks/destructive-command-guard.js";
import type { JsonObject } from "./lib/json-types.js";

// Unified phase tag (a subset of UnifiedPhase). Local copy of the constant in
// hook-entry.ts so this leaf module does not import back from the main file
// (which would be a circular import).
const PHASE_PRE_TOOL = "pre-tool";

// Discriminator values for UnifiedAction. Same rationale as above.
const ACTION_TOOL_CALL = "tool_call";
const ACTION_SHELL_COMMAND = "shell_command";
const ACTION_FILE_OPERATION = "file_operation";

// Graph-prediction protocol mirror for the cold path. When the harness daemon
// is unreachable or times out, the runner-adapter path (this file) used to
// fall through to `allow`. The protocol explicitly requires that edits to
// files with a fresh `.graph.*` shard go through predict/reveal/reconcile;
// allowing them silently when the daemon is busy or down breaks the
// protocol's "must" guarantee. This function mirrors the inline check in
// `src/lib/hook-template-chunks/guards-inline.ts::inlineGraphShardCheck` —
// any change here should be reflected there (and vice versa).
const GRAPH_SHARD_STALENESS_GRACE_MS = 60_000;
// Tool names AFTER `normalizeToolName` in the Claude Code adapter (PascalCase
// → snake_case, e.g. `Edit` → `edit`, `MultiEdit` → `multi_edit`). Other
// adapters use the snake_case form directly. Both are covered here so a future
// adapter that forwards the raw PascalCase string still hits the same set.
const GRAPH_SHARD_WRITE_TOOLS = new Set([
	// Normalized (snake_case) forms — the canonical UnifiedHookEvent shape.
	"write",
	"edit",
	"multi_edit",
	"notebook_edit",
	"write_file",
	"edit_file",
	"file_write",
	"file_edit",
	"create",
	"str_replace",
	"apply_patch",
	// Raw PascalCase fallbacks for adapters that bypass normalization.
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"WriteFile",
	"EditFile",
	"FileWrite",
	"FileEdit",
]);

// Path keys that appear on tool_input across runners. Centralized so the
// cold-fallback path doesn't have to keep a separate copy of the list. The
// adapters normalize input keys but historic callers have used all of these.
const FILE_PATH_INPUT_KEYS = ["file_path", "filePath", "path", "target_file"] as const;

// `apply_patch` body markers used in OpenAI Codex CLI and similar tools.
const APPLY_PATCH_TOOL = "apply_patch";
const APPLY_PATCH_FILE_HEADER_RE = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm;
const APPLY_PATCH_MOVE_HEADER_RE = /^\*\*\* Move to:\s+(.+)$/gm;

// What `colColdToolName` returns when the unified event is a generic
// file_operation (no specific tool name). "edit" matches the normalized
// form in GRAPH_SHARD_WRITE_TOOLS.
const FILE_OPERATION_DEFAULT_TOOL = "edit";

// Sentinel value for `INTERLINKED_DISABLE_GRAPH_SHARD_INLINE` that opts out of
// the cold-fallback gate. Stored as a constant so the comparison is
// self-documenting and matches the inline-fallback variant exactly.
const DISABLE_GRAPH_SHARD_FLAG = "1";

interface ApplyPatchInput {
	command?: string;
	patch?: string;
	content?: string;
	_raw_patch?: string;
}

interface FileTargetInput {
	file_path?: string;
	filePath?: string;
	path?: string;
	target_file?: string;
}

type ColdToolInput = FileTargetInput & ApplyPatchInput;

function extractColdTargetPaths(event: UnifiedHookEvent): string[] {
	const paths: string[] = [];
	const action = event.action;
	if (action.kind === ACTION_TOOL_CALL) {
		const ti = (action.tool_input ?? {}) as ColdToolInput;
		for (const key of FILE_PATH_INPUT_KEYS) {
			const v = ti[key];
			if (typeof v === "string" && v.trim() !== "") paths.push(v.trim());
		}
		if (action.tool_name === APPLY_PATCH_TOOL) {
			const patch = String(ti.command ?? ti.patch ?? ti.content ?? ti._raw_patch ?? "");
			let m: RegExpExecArray | null;
			while ((m = APPLY_PATCH_FILE_HEADER_RE.exec(patch)) !== null) {
				const p = (m[1] ?? "").trim();
				if (p && !paths.includes(p)) paths.push(p);
			}
			while ((m = APPLY_PATCH_MOVE_HEADER_RE.exec(patch)) !== null) {
				const p = (m[1] ?? "").trim();
				if (p && !paths.includes(p)) paths.push(p);
			}
			APPLY_PATCH_FILE_HEADER_RE.lastIndex = 0;
			APPLY_PATCH_MOVE_HEADER_RE.lastIndex = 0;
		}
	} else if (action.kind === ACTION_FILE_OPERATION) {
		if (typeof action.path === "string" && action.path.trim() !== "") {
			paths.push(action.path.trim());
		}
	}
	return paths;
}

function colColdToolName(event: UnifiedHookEvent): string | null {
	const action = event.action;
	if (action.kind === ACTION_TOOL_CALL) return action.tool_name;
	if (action.kind === ACTION_FILE_OPERATION) return FILE_OPERATION_DEFAULT_TOOL;
	return null;
}

export function coldGraphShardBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	if (process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE === DISABLE_GRAPH_SHARD_FLAG) return null;
	const toolName = colColdToolName(event);
	if (!toolName || !GRAPH_SHARD_WRITE_TOOLS.has(toolName)) return null;
	const paths = extractColdTargetPaths(event);
	if (paths.length === 0) return null;
	const cwd = event.context?.cwd ?? process.cwd();
	for (const t of paths) {
		const abs = isAbsolute(t) ? t : resolvePath(cwd, t);
		try {
			if (!existsSync(abs)) continue;
			const m = abs.match(/\.[^./]+$/);
			const ext = m ? m[0] : "";
			const shardPath = ext ? abs.slice(0, -ext.length) + ".graph" + ext : abs + ".graph";
			if (!existsSync(shardPath)) continue;
			const sourceMtime = statSync(abs).mtimeMs;
			const shardMtime = statSync(shardPath).mtimeMs;
			if (shardMtime < sourceMtime - GRAPH_SHARD_STALENESS_GRACE_MS) continue;
			return (
				"[interlinked:graph-pred][harness-offline] Cannot evaluate the graph-prediction protocol because the harness daemon is unreachable (or did not respond in time), but " +
				abs +
				" has a fresh Supermodel shard colocated. Edits to E-fresh files MUST go through the predict/reveal/reconcile loop. " +
				"Start the harness with: interlinked harness start  (or restart it). Once it's up, retry your edit. " +
				"Override (advanced, defeats the protocol): set INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1."
			);
		} catch {
			continue;
		}
	}
	return null;
}

/** Merge-conflict marker regex — mirrors evaluator/write-content-guards.ts. */
const MERGE_CONFLICT_MARKER_RE = /^<{7}\s|^={7}$|^>{7}\s/m;

interface ColdWriteContentInput {
	content?: unknown;
	new_string?: unknown;
	new_source?: unknown;
	edits?: unknown;
}

/** Extract the text a file-write tool call would put on disk, across the
 *  Write (`content`), Edit (`new_string`), NotebookEdit (`new_source`) and
 *  MultiEdit (`edits[].new_string`) shapes. Returns null when no write
 *  content is present (a non-write tool, or apply_patch — whose
 *  line-prefixed diff body the daemon parses separately). */
function extractColdWriteContent(event: UnifiedHookEvent): string | null {
	const action = event.action;
	if (action.kind !== ACTION_TOOL_CALL) return null;
	const ti = (action.tool_input ?? {}) as ColdWriteContentInput;
	if (typeof ti.content === "string") return ti.content;
	if (typeof ti.new_string === "string") return ti.new_string;
	if (typeof ti.new_source === "string") return ti.new_source;
	if (Array.isArray(ti.edits)) {
		const parts: string[] = [];
		for (const e of ti.edits) {
			if (e && typeof e === "object" && "new_string" in e) {
				const ns = (e as { new_string?: unknown }).new_string;
				if (typeof ns === "string") parts.push(ns);
			}
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return null;
}

/** Cold fail-closed gate: refuse a file write whose content carries
 *  merge-conflict markers. A file with `<<<<<<<` / `=======` / `>>>>>>>`
 *  markers is a guaranteed parse error; the daemon blocks it at
 *  write-content-guards check A1, so the cold path must too — otherwise a
 *  daemon outage silently lets broken content through. Returns the block
 *  reason, or null when the write is clean / not a file write. */
export function coldMergeConflictBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const toolName = colColdToolName(event);
	if (!toolName || !GRAPH_SHARD_WRITE_TOOLS.has(toolName)) return null;
	const content = extractColdWriteContent(event);
	if (!content || !MERGE_CONFLICT_MARKER_RE.test(content)) return null;
	const paths = extractColdTargetPaths(event);
	const where = paths.length > 0 ? paths[0] : "the target file";
	return (
		"[interlinked:merge-conflict] BLOCKED: merge-conflict markers " +
		"(<<<<<<<, =======, >>>>>>>) detected in the content being written to " +
		where +
		". A file with conflict markers is a guaranteed parse error — resolve " +
		"the conflict before writing."
	);
}

// Shell-command tool names across runners — normalized (Claude Code
// lowercases via normalizeToolName, Cursor lowercases) and raw forms.
// Over-inclusion is harmless: a non-shell tool here simply has no
// `.command` and yields null.
const COLD_BASH_TOOL_NAMES = new Set([
	"bash",
	"Bash",
	"shell",
	"Shell",
	"run_command",
	"local_shell",
]);

/** Cold fail-closed gate: refuse a destructive shell command (`rm -rf`,
 *  force push, `DROP TABLE`, ...) when the daemon is unreachable. Runs the
 *  SAME `checkDestructiveCommand` the generated .mjs hook runs inline as its
 *  primary guard, so the two hook paths block the identical set — daemon up
 *  or down. Returns the block reason, or null when the command is benign. */
export function coldDestructiveCommandBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;

	let command = "";
	if (action.kind === ACTION_SHELL_COMMAND) {
		// Cursor's beforeShellExecution produces shell_command actions with the
		// command string directly on `action.command` — no tool_name gating needed.
		command = action.command;
	} else if (action.kind === ACTION_TOOL_CALL) {
		if (!COLD_BASH_TOOL_NAMES.has(action.tool_name)) return null;
		const ti = (action.tool_input ?? {}) as { command?: unknown };
		command = typeof ti.command === "string" ? ti.command : "";
	} else {
		return null;
	}

	if (!command) return null;
	const verdict = checkDestructiveCommand(command);
	return verdict ? verdict.reason : null;
}

/** Cold fail-closed gate: refuse a package-install shell command when the
 *  daemon is unreachable. Mirrors the daemon-side `evaluatePackageInstall`
 *  by loading the same `.interlinked/package-allowlist.json` and running
 *  the same parser, so the .mjs path and hook-entry cold path block the
 *  identical set whether the daemon is up or down. Returns the block
 *  reason, or null when the command is benign / approved / not an install.
 *  Bypass via INTERLINKED_DISABLE_PACKAGE_GUARD=1. */
export function coldPackageInstallBlockReason(event: UnifiedHookEvent): string | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD === "1") return null;
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;
	let command = "";
	if (action.kind === ACTION_SHELL_COMMAND) {
		command = action.command;
	} else if (action.kind === ACTION_TOOL_CALL) {
		if (!COLD_BASH_TOOL_NAMES.has(action.tool_name)) return null;
		const ti = (action.tool_input ?? {}) as { command?: unknown };
		command = typeof ti.command === "string" ? ti.command : "";
	} else {
		return null;
	}
	if (!command) return null;
	const installCommands = parseInstallCommands(command);
	if (installCommands.length === 0) return null;
	const cwd = event.context?.cwd || process.cwd();
	const allowlist = loadAllowlist(cwd);
	const decision = evaluatePackageInstall(installCommands, cwd, allowlist);
	if (!decision || decision.decision !== "block") return null;
	return decision.reason ?? "package install blocked by supply-chain allowlist";
}

/** Cold fail-closed gate: refuse a Write/Edit/MultiEdit that would grow (or create)
 *  a hand-written code file past the per-file line cap when the daemon is
 *  unreachable. Runs the SAME pure `checkLargeFileLineCountWrite` the daemon uses —
 *  file content + the committed `.interlinked/large-files-baseline.json`, no daemon
 *  state — so the cap holds whether the daemon is up or down. This closes the gap
 *  that let an over-cap edit slip through when the socket blipped: the line cap is
 *  a quality gate, but it's deterministic and daemon-independent, so it belongs in
 *  the cold path alongside the destructive-command and supply-chain guards. */
export function coldLargeFileBlockReason(event: UnifiedHookEvent): string | null {
	if (event.phase !== PHASE_PRE_TOOL) return null;
	const action = event.action;
	if (action.kind !== ACTION_TOOL_CALL) return null;
	const cwd = event.context?.cwd || process.cwd();
	// `checkLargeFileLineCountWrite` self-filters: it returns null for any input
	// that isn't a file-write shape (no file_path / unknown tool), so no tool-name
	// gate is needed here.
	const result = checkLargeFileLineCountWrite((action.tool_input ?? {}) as JsonObject, cwd);
	return result?.block ?? null;
}
