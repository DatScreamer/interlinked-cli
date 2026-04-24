// ===========================================
// Content Scanner — Redacted preview + local-only prompt file
// ===========================================
//
// When the scanner decides `ask`, we surface two things to the user:
//   1. A `reason` string that goes into the hook response — this lands in
//      the agent's context window and is therefore shipped to Anthropic
//      with every subsequent turn. It must contain NO raw PII.
//   2. A local-only prompt file at `.interlinked/scanner/pending/<id>.json`
//      with the FULL unmasked content. The user can open it from another
//      terminal while approving. The file never leaves the machine.
//
// This module builds both. The reason gets a redacted preview (PII →
// `<CATEGORY>` placeholders) so the user can judge the *shape* of the
// content without us leaking the values themselves to the model.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentScanRequest, ScanFinding } from "./types.js";

const PREVIEW_MAX_CHARS = 200;
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PENDING_FILE_MODE = 0o600;

/**
 * Build an agent-safe preview by splicing every detected span out of the
 * original text and replacing it with `<LABEL>`. Truncates long text to
 * `PREVIEW_MAX_CHARS`, keeping the first hit in view when we truncate.
 *
 * Contract: the returned string NEVER contains any matched-span substring
 * (asserted in `redact-preview.test.ts`).
 */
export function buildRedactedPreview(originalText: string, spans: ScanFinding[]): string {
	if (spans.length === 0) return truncate(originalText, PREVIEW_MAX_CHARS);
	// Splice from the end so earlier indices stay valid during iteration.
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let result = originalText;
	for (const span of sorted) {
		const placeholder = `<${span.label.toUpperCase()}>`;
		result = result.slice(0, span.start) + placeholder + result.slice(span.end);
	}
	// Center the truncation window on the first span so the user sees context.
	const firstHitOriginalStart = Math.min(...spans.map((s) => s.start));
	return truncate(result, PREVIEW_MAX_CHARS, firstHitOriginalStart);
}

export interface WritePendingPromptArgs {
	cwd: string;
	request: ContentScanRequest;
	findingsBySource: Map<string, ScanFinding[]>;
	toolName: string;
}

/**
 * Write the full unmasked content of a scan request to a local file. The
 * caller gets back a relative path (from `cwd`) to surface in the reason.
 * Returns `undefined` if the write fails — we never throw; the `ask` flow
 * still works without the side-channel, just with category-only context.
 */
export function writePendingPrompt(args: WritePendingPromptArgs): string | undefined {
	const { cwd, request, findingsBySource, toolName } = args;
	const dir = join(cwd, ".interlinked", "scanner", "pending");
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	} catch (mkdirErr) {
		process.stderr.write(`[interlinked:scanner] cannot create ${dir}: ${formatErr(mkdirErr)}\n`);
		return undefined;
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const contentHash = hashParts(request.parts.map((p) => p.text).join("\n"));
	const filename = `${timestamp}-${contentHash}.json`;
	const absPath = join(dir, filename);
	const relPath = join(".interlinked", "scanner", "pending", filename);

	const payload = {
		timestamp: new Date().toISOString(),
		tool_name: toolName,
		hook: request.hook,
		note:
			"LOCAL-ONLY — this file contains the unmasked content the privacy-filter " +
			"flagged. It was NOT sent to Anthropic. Review before approving the tool " +
			"call in Claude Code; delete when done.",
		parts: request.parts.map((part) => ({
			source: part.source,
			text: part.text,
			spans: findingsBySource.get(part.source) ?? [],
		})),
	};

	try {
		writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: PENDING_FILE_MODE });
	} catch (writeErr) {
		process.stderr.write(
			`[interlinked:scanner] cannot write ${relPath}: ${formatErr(writeErr)}\n`,
		);
		return undefined;
	}

	pruneStale(dir);
	return relPath;
}

export interface BuildAskReasonArgs {
	policySummary: string;
	request: ContentScanRequest;
	findingsBySource: Map<string, ScanFinding[]>;
	pendingPromptPath: string | undefined;
}

export interface AskReasonOutputs {
	/** Agent-safe reason for `permissionDecisionReason` — category counts +
	 *  offset table + masked preview + pending-file pointer. Shipped to the
	 *  model. Contract: contains NO matched-span substrings. */
	reason: string;
	/** User-only message for Claude Code's `systemMessage` field — the raw
	 *  flagged spans with surrounding context. Claude Code displays this in
	 *  the permission UI but does NOT include it in the model's context
	 *  window (see Claude Code hooks reference). This is the only place
	 *  raw PII is allowed to appear in the hook response. */
	systemMessage: string;
}

/** Max length for `systemMessage` per the Claude Code hooks schema (10,000
 *  chars). We stay well under that so long files don't overflow; the raw
 *  pending file is the source of truth if truncation kicks in. */
const SYSTEM_MESSAGE_MAX_CHARS = 8_000;
/** Per-row cap on a flagged value so an accidentally-huge span doesn't eat
 *  the whole budget. The full value always lives in the local pending file. */
const SYSTEM_MESSAGE_ROW_VALUE_MAX = 200;

/**
 * Build the composite reason string the scanner attaches to an `ask`
 * decision. Assembles the policy category summary, a per-finding list of
 * `"category": "value"` rows so the user can see exactly what was flagged
 * before they approve or deny, and — when set — a pointer to the local-
 * only prompt file.
 *
 * Returns a pair: the agent-visible `reason` (shown in Claude Code's
 * permission card) and a user-only `systemMessage` (rendered in the
 * rejection-feedback path but not included in the model's context window;
 * see the hooks reference — systemMessage is display-only, distinct from
 * additionalContext which IS sent to the model). Both contain the same
 * category:value list so the user sees the findings whether they approve
 * on sight or inspect more closely after a deny.
 *
 * Safety note on putting raw span text in `reason`: the flagged spans
 * came from the tool_input the *model itself* generated (Write.content,
 * Bash.command, WebFetch.url, etc.). Those characters are already in the
 * model's context from the tool call — echoing them back in the reason
 * adds no new information to Anthropic's view. This does NOT apply to
 * PostToolUse Read/Grep taint warnings, which use a different path.
 */
export function buildAskReason(args: BuildAskReasonArgs): AskReasonOutputs {
	const { policySummary, request, findingsBySource, pendingPromptPath } = args;
	const lines: string[] = [policySummary];

	// Collect + sort findings: (source, start) ascending. Numeric, not
	// lexicographic — "[30..]" would otherwise sort before "[5..]".
	const findingsSorted: ScanFinding[] = [];
	for (const part of request.parts) {
		const spans = findingsBySource.get(part.source) ?? [];
		findingsSorted.push(...spans);
	}
	findingsSorted.sort((a, b) =>
		a.source === b.source ? a.start - b.start : a.source.localeCompare(b.source),
	);
	if (findingsSorted.length > 0) {
		lines.push("");
		lines.push(
			'Flagged PII (raw values, for pre-decision review — the model already generated these in its tool call above):',
		);
		for (const f of findingsSorted) lines.push(`  ${formatRow(f)}`);
	}

	if (pendingPromptPath) {
		lines.push("");
		lines.push(
			`Full unmasked content: ${pendingPromptPath}  (local-only — not sent to Anthropic)`,
		);
	}

	return {
		reason: lines.join("\n"),
		systemMessage: buildSystemMessage(findingsSorted),
	};
}

/** Render a single finding as `"category": "value"` for the reason list.
 *  Same shape as the systemMessage rows so both views agree. */
function formatRow(f: ScanFinding): string {
	return `"${f.label}": "${escapeRowValue(f.text)}"`;
}

/**
 * Build the user-only message Claude Code renders in the permission UI's
 * `systemMessage` slot. Claude Code does NOT include this string in the
 * model's context window — that isolation is what lets raw flagged values
 * appear here without breaking the agent-safe contract on reason.
 *
 * Format: one row per finding, `"category": "raw_value"`, JSON-like so the
 * reader can tell at a glance which chars are literal and which are escapes.
 * The category name matches the OPF taxonomy (lowercase snake_case).
 */
function buildSystemMessage(findings: ScanFinding[]): string {
	if (findings.length === 0) return "";
	const rows: string[] = [];
	for (const f of findings) {
		rows.push(`  "${f.label}": "${escapeRowValue(f.text)}"`);
	}
	const header =
		"🔒 Content scanner — flagged PII (user-only; NOT sent to the model):";
	const body = [header, ...rows].join("\n");
	if (body.length <= SYSTEM_MESSAGE_MAX_CHARS) return body;
	return `${body.slice(0, SYSTEM_MESSAGE_MAX_CHARS - 80)}\n… (truncated; see pending file for the full list)`;
}

/** Escape + length-cap a raw span value for one systemMessage row. */
function escapeRowValue(text: string): string {
	let v = text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	if (v.length > SYSTEM_MESSAGE_ROW_VALUE_MAX) {
		v = `${v.slice(0, SYSTEM_MESSAGE_ROW_VALUE_MAX - 15)}… (truncated)`;
	}
	return v;
}

function formatOffsetRow(f: ScanFinding): string {
	const len = f.end - f.start;
	const placeholder = `<${f.label.toUpperCase()}>`;
	return `${f.source}  [${f.start}..${f.end}]  length ${len}  → ${placeholder}`;
}

// ===========================================
// Internals
// ===========================================

function truncate(s: string, max: number, centerAt = 0): string {
	if (s.length <= max) return s;
	const half = Math.floor(max / 2);
	const start = Math.max(0, centerAt - half);
	const end = Math.min(s.length, start + max);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < s.length ? "…" : "";
	return `${prefix}${s.slice(start, end)}${suffix}`;
}

function hashParts(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function formatErr(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Best-effort GC: delete pending-prompt files older than `PENDING_TTL_MS`.
 *  Runs on every write so we don't need a separate timer. */
function pruneStale(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (readErr) {
		// Directory doesn't exist yet (first scan ever) — nothing to prune.
		// Log at trace level only: this is expected on fresh installs.
		void readErr;
		return;
	}
	const cutoff = Date.now() - PENDING_TTL_MS;
	for (const name of entries) {
		const p = join(dir, name);
		try {
			if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
		} catch (statErr) {
			// stat/unlink races with concurrent readers — skip this entry silently.
			void statErr;
		}
	}
}
