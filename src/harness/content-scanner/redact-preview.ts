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

/**
 * Build the composite reason string the scanner attaches to an `ask`
 * decision. Assembles the policy category summary, a per-source redacted
 * preview (one line per scan part that had findings), and — when set — a
 * pointer to the local-only prompt file.
 *
 * Contract: the returned string is AGENT-SAFE — no matched-span substrings.
 */
export function buildAskReason(args: BuildAskReasonArgs): string {
	const { policySummary, request, findingsBySource, pendingPromptPath } = args;
	const lines: string[] = [policySummary];

	const previewBlocks: string[] = [];
	for (const part of request.parts) {
		const spans = findingsBySource.get(part.source) ?? [];
		if (spans.length === 0) continue;
		previewBlocks.push(`${part.source}: ${buildRedactedPreview(part.text, spans)}`);
	}
	if (previewBlocks.length > 0) {
		lines.push("");
		lines.push("Preview (PII masked — values replaced with <CATEGORY>):");
		for (const block of previewBlocks) lines.push(`  ${block}`);
	}

	if (pendingPromptPath) {
		lines.push("");
		lines.push(
			`Full unmasked content: ${pendingPromptPath}  (local-only — not sent to Anthropic)`,
		);
	}

	return lines.join("\n");
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
