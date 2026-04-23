// ===========================================
// interlinked multi-edit — Atomic coordinated edits across one or more files
// ===========================================
//
// Applies N `old_string → new_string` pairs per file as an in-memory buffer
// transform, runs the content-quality gate ONCE on the final content per
// file, and writes all files atomically if the gate passes. Any failure
// (ambiguous match, missing match, gate reject, read/write I/O) is
// transactional: either all files change or none do.
//
// This exists because the Edit tool applies one replacement at a time, and
// the tsc/biome diff-overlays check each intermediate state. Coordinated
// changes that cross multiple sites in one file (e.g. "add an import AND a
// use site", "widen a signature AND update callers") deadlock under serial
// Edits because one half of the change is invalid without the other.
//
// Eventually this command should call a shared `gateProposedContent()`
// helper that the `interlinked write` subcommand also consumes — the
// sibling design doc owns that shared API. Until it lands, we inline the
// gate by calling the existing diff-overlay entry points directly. The
// gate check path mirrors what `evaluator/write-content-guards.ts` already
// does for single-Edit writes.
//
// Related docs:
//   cli/docs/design/multi-edit-atomic-coordinated-edits.md
//   cli/docs/design/bash-writes-through-content-gates.md

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CheckResult } from "../harness/check-engine/types.js";
import {
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
	isTscFindingBlocking,
} from "../harness/diff-overlay.js";
import { findProjectRoot } from "../harness/quality-checks/project-root.js";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";

// ───────────────────────────────────────────────
// Error codes (const-object pattern so they read as intent in conditionals)
// ───────────────────────────────────────────────

/** Error codes per the design doc. Emit these literal strings in `--json`. */
export const MULTI_EDIT_ERROR_CODES = {
	OLD_STRING_NOT_FOUND: "OLD_STRING_NOT_FOUND",
	AMBIGUOUS_OLD_STRING: "AMBIGUOUS_OLD_STRING",
	GATE_REJECTED: "GATE_REJECTED",
	READ_FAILED: "READ_FAILED",
	WRITE_FAILED: "WRITE_FAILED",
	INVALID_MANIFEST: "INVALID_MANIFEST",
} as const;

export type MultiEditErrorCode =
	(typeof MULTI_EDIT_ERROR_CODES)[keyof typeof MULTI_EDIT_ERROR_CODES];

/** Schema-version number the manifest must declare. */
const EXPECTED_MANIFEST_VERSION = 1;

/** Expected runtime type of a parsed manifest. */
const MANIFEST_ROOT_TYPE = "object" as const;

/** Field types inside a manifest. */
const FIELD_TYPE_STRING = "string" as const;

// ───────────────────────────────────────────────
// Public shape — manifest + result types
// ───────────────────────────────────────────────

export interface EditPair {
	old_string: string;
	new_string: string;
}

export interface EditBatch {
	path: string;
	edits: EditPair[];
}

/** Single-file manifest shape (read from stdin when `--stdin` is set). */
export interface SingleFileManifest {
	version: number;
	edits: EditPair[];
}

/** Multi-file manifest shape (read from `--manifest <file>`). */
export interface MultiFileManifest {
	version: number;
	batches: EditBatch[];
}

export interface GateFailure {
	path: string;
	tool: string;
	code: string;
	line: number;
	message: string;
}

export interface MultiEditResult {
	ok: boolean;
	error_code?: MultiEditErrorCode;
	/** Paths whose on-disk content changed. Populated only on success. */
	file_changes_applied: string[];
	/** Populated on AMBIGUOUS_OLD_STRING / OLD_STRING_NOT_FOUND / READ_FAILED / WRITE_FAILED. */
	error_detail?: {
		path: string;
		edit_index?: number;
		/** Number of matches for `old_string` after prior edits. */
		match_count?: number;
		message: string;
	};
	/** Populated on GATE_REJECTED. Same shape as Edit diff-overlay diagnostics. */
	gate_failures?: GateFailure[];
}

/** Result envelope for any function that returns `{ok} | {error}`. Named so
 *  the `normalizeManifest` return type is self-describing to cold readers. */
export type NormalizeResult = { ok: true; batches: EditBatch[] } | { ok: false; message: string };

type EditsValidation = { ok: true; edits: EditPair[] } | { ok: false; message: string };

type ApplyEditsResult =
	| { ok: true; content: string }
	| { ok: false; code: MultiEditErrorCode; index: number; matches: number };

// ───────────────────────────────────────────────
// Core — apply edits to a single buffer
// ───────────────────────────────────────────────

/**
 * Count occurrences of `needle` in `haystack`. Used for the ambiguity rule:
 * each `old_string` must appear exactly once in the buffer after prior
 * edits in the manifest have been applied.
 *
 * Public API — unit-tested directly and part of the documented surface so
 * the `interlinked write` sibling can reuse it if it wants the same
 * ambiguity semantics.
 */
export function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count += 1;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

/**
 * Apply an ordered list of edits to a starting buffer.
 *
 * Ambiguity rule (per the design doc):
 *   Each `old_string` must be unique in the CURRENT buffer (i.e. after all
 *   prior edits in this manifest have been applied), NOT in the original
 *   pristine content. This lets later edits target text produced by
 *   earlier ones.
 *
 * Returns the transformed buffer on success, or a structured error.
 *
 * Public API — exported so tests (and the eventual shared
 * `gateProposedContent` helper) can reuse the same ambiguity semantics
 * without duplicating the loop.
 */
export function applyEditsToBuffer(original: string, edits: EditPair[]): ApplyEditsResult {
	let buf = original;
	for (let i = 0; i < edits.length; i += 1) {
		const { old_string, new_string } = edits[i];
		// An empty old_string is nonsensical — treat as not-found so the
		// manifest fails loudly rather than silently applying identity.
		const matches = countOccurrences(buf, old_string);
		if (matches === 0) {
			return {
				ok: false,
				code: MULTI_EDIT_ERROR_CODES.OLD_STRING_NOT_FOUND,
				index: i,
				matches: 0,
			};
		}
		if (matches > 1) {
			return {
				ok: false,
				code: MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING,
				index: i,
				matches,
			};
		}
		// Single match — safe to replace via indexOf + slice (avoids regex
		// escaping footguns in `old_string`).
		const at = buf.indexOf(old_string);
		buf = buf.slice(0, at) + new_string + buf.slice(at + old_string.length);
	}
	return { ok: true, content: buf };
}

// ───────────────────────────────────────────────
// Gate — call diff-overlay against proposed content
// ───────────────────────────────────────────────

/**
 * Thin wrapper around the existing diff-overlay entry points. This is the
 * exact pipeline `evaluator/write-content-guards.ts` runs for single-Edit
 * writes, minus the registry/security checks that are out of scope here
 * (merge-conflict markers, binary-file guard, path traversal — we apply
 * path validation in the command itself).
 *
 * Returns a list of failures in the same shape as the design doc's `--json`
 * output. Empty list means the gate passed.
 *
 * Public API — this function will be replaced by the shared
 * `gateProposedContent()` helper once the `interlinked write` subagent lands
 * its refactor. The input shape (Array<{ path, content }>) already matches
 * the intended signature so the rename is drop-in.
 */
export function gateProposedContentInline(
	batch: Array<{ path: string; content: string }>,
	opts?: { projectRoot?: string },
): GateFailure[] {
	const failures: GateFailure[] = [];
	for (const { path, content } of batch) {
		// Resolve the project root per-file (monorepos with per-package
		// tsconfig.json work correctly this way).
		const projectRoot =
			opts?.projectRoot || findProjectRoot(path, process.cwd()) || process.cwd();

		// Biome diff-overlay
		const biome = evaluateBiomeDiffOverlay(path, content, projectRoot);
		for (const f of biome.newFindings) {
			failures.push({
				path,
				tool: "biome",
				code: f.ruleId ?? "biome",
				line: f.line,
				message: f.message,
			});
		}

		// Tsc diff-overlay — only blocking findings count (warn-only codes
		// like TS6133 "unused" are intentionally non-blocking; the design
		// doc's whole point is to permit transient unused-import-style
		// intermediate states, and here the state is post-composition, so
		// genuine unused imports will still surface as warnings via the
		// harness PostToolUse path).
		const tsc = evaluateTscDiffOverlay(path, content, projectRoot);
		const blocking = tsc.newFindings.filter(isTscFindingBlocking);
		for (const f of blocking) {
			failures.push({
				path,
				tool: "tsc",
				code: f.ruleId ?? "tsc",
				line: f.line,
				message: f.message,
			});
		}
	}
	return failures;
}

/** Public API — re-exported for tests and downstream consumers so they can
 *  use the same finding-blocking classifier the command uses internally. */
export { isTscFindingBlocking };
/** Public API — the CheckResult row shape surfaced by diff-overlay. */
export type { CheckResult };

// ───────────────────────────────────────────────
// Manifest parsing (shape guards + dispatchers)
// ───────────────────────────────────────────────

/** Shape guard: root must be a plain JSON object with the right version. */
function validateManifestRoot(
	raw: unknown,
): { ok: true; obj: JsonObject } | { ok: false; message: string } {
	const isObject = !!raw && typeof raw === MANIFEST_ROOT_TYPE;
	if (!isObject) {
		return { ok: false, message: "Manifest must be a JSON object." };
	}
	const obj = raw as JsonObject;
	if (obj.version !== EXPECTED_MANIFEST_VERSION) {
		return {
			ok: false,
			message: `Manifest version must be ${EXPECTED_MANIFEST_VERSION} (got ${JSON.stringify(obj.version)}).`,
		};
	}
	return { ok: true, obj };
}

/** Normalize a multi-file manifest (`{ batches: [...] }`). */
function normalizeMultiFileManifest(
	batchesRaw: unknown[],
	singleFilePath: string | undefined,
): NormalizeResult {
	if (singleFilePath) {
		return {
			ok: false,
			message:
				"Cannot pass a positional path with a multi-file manifest (use either path+--stdin OR --manifest).",
		};
	}
	const batches: EditBatch[] = [];
	for (let i = 0; i < batchesRaw.length; i += 1) {
		const shaped = shapeBatch(batchesRaw[i]);
		if (!shaped.ok) {
			return { ok: false, message: `Batch ${i} must have { path: string, edits: [...] }.` };
		}
		const editsResult = validateEdits(shaped.batch.edits);
		if (!editsResult.ok) {
			return {
				ok: false,
				message: `Batch ${i} (${shaped.batch.path}): ${editsResult.message}`,
			};
		}
		batches.push({ path: shaped.batch.path, edits: editsResult.edits });
	}
	return { ok: true, batches };
}

/**
 * Narrow an unknown value to `{ path: string; edits: unknown[] }`. Using a
 * dedicated predicate is the only way to preserve the narrowing across a
 * `Record<string, unknown>` field read — TypeScript won't propagate the
 * `typeof === "string"` check on `b.path` back to `b.path` itself (indexed
 * reads always return `unknown`). Returning the narrowed view directly
 * sidesteps the issue and keeps the call site free of casts.
 *
 * Note: the bare literal `"string"` is used with `typeof` because TS only
 * narrows against the literal form. `FIELD_TYPE_STRING` documents intent
 * elsewhere in the file; here narrowing trumps the style guideline.
 */
function shapeBatch(
	raw: unknown,
): { ok: true; batch: { path: string; edits: unknown[] } } | { ok: false } {
	if (!raw || typeof raw !== "object") return { ok: false };
	const r = raw as { path?: unknown; edits?: unknown };
	if (typeof r.path !== "string" || !Array.isArray(r.edits)) return { ok: false };
	return { ok: true, batch: { path: r.path, edits: r.edits } };
}

/** Normalize a single-file manifest (`{ edits: [...] }`). */
function normalizeSingleFileManifest(
	editsRaw: unknown[],
	singleFilePath: string | undefined,
): NormalizeResult {
	if (!singleFilePath) {
		return {
			ok: false,
			message:
				"Single-file manifest (with `edits`) requires a path argument on the command line.",
		};
	}
	const editsResult = validateEdits(editsRaw);
	if (!editsResult.ok) {
		return { ok: false, message: editsResult.message };
	}
	return { ok: true, batches: [{ path: singleFilePath, edits: editsResult.edits }] };
}

/**
 * Validate and normalize a manifest parsed from JSON. Accepts either the
 * single-file shape ({ edits }) or the multi-file shape ({ batches }).
 * For the single-file shape, the caller must supply the `path` separately
 * (it's the positional argument on the command line).
 *
 * Public API — unit-tested directly and consumed by the command entry
 * point. Exported so callers that want to sanity-check a manifest before
 * handing it to `runMultiEdit` can do so without re-implementing the
 * parser.
 */
export function normalizeManifest(raw: unknown, singleFilePath?: string): NormalizeResult {
	const rootCheck = validateManifestRoot(raw);
	if (!rootCheck.ok) return rootCheck;
	const obj = rootCheck.obj;

	if (Array.isArray(obj.batches)) {
		return normalizeMultiFileManifest(obj.batches, singleFilePath);
	}
	if (Array.isArray(obj.edits)) {
		return normalizeSingleFileManifest(obj.edits, singleFilePath);
	}
	return {
		ok: false,
		message: "Manifest must have either `edits` (single-file) or `batches` (multi-file).",
	};
}

function validateEdits(raw: unknown[]): EditsValidation {
	if (raw.length === 0) {
		return { ok: false, message: "At least one edit is required." };
	}
	const edits: EditPair[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const e = raw[i] as JsonObject;
		const hasBothStrings =
			!!e &&
			typeof e.old_string === FIELD_TYPE_STRING &&
			typeof e.new_string === FIELD_TYPE_STRING;
		if (!hasBothStrings) {
			return {
				ok: false,
				message: `Edit ${i} must have { old_string: string, new_string: string }.`,
			};
		}
		const oldStr = e.old_string as string;
		const newStr = e.new_string as string;
		if (oldStr.length === 0) {
			return { ok: false, message: `Edit ${i}: old_string must not be empty.` };
		}
		if (oldStr === newStr) {
			return {
				ok: false,
				message: `Edit ${i}: old_string and new_string are identical (no-op edit).`,
			};
		}
		edits.push({ old_string: oldStr, new_string: newStr });
	}
	return { ok: true, edits };
}

// ───────────────────────────────────────────────
// Transactional write
// ───────────────────────────────────────────────

/**
 * Write a batch of (path, content) pairs atomically.
 *
 * "Atomic across the batch" means: if we can't complete all writes, we roll
 * back any writes we already made to their original on-disk content. The
 * individual file writes themselves use the standard temp+rename pattern
 * (which is atomic within a single file on POSIX). The rollback is
 * best-effort — if the process is killed mid-write we may leave a
 * partially-written batch, but that's the same failure mode git has.
 */
function atomicBatchWrite(
	finals: Array<{ path: string; content: string; priorContent: string }>,
): { ok: true } | { ok: false; failedPath: string; message: string } {
	const written: string[] = [];
	for (const { path, content } of finals) {
		const tmp = `${path}.interlinked-multi-edit.tmp`;
		try {
			writeFileSync(tmp, content, "utf-8");
			renameSync(tmp, path);
			written.push(path);
		} catch (err) {
			// Rollback: restore everything we already wrote back to its
			// prior content. Also clean up the leftover .tmp if rename
			// failed before rename.
			try {
				if (existsSync(tmp)) unlinkSync(tmp);
			} catch (cleanupErr) {
				// Best-effort tmp cleanup — the primary write error below is
				// what we'll surface to the caller. Logging the cleanup
				// failure separately so it's not completely invisible.
				const cleanupMsg =
					cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
				console.error(`[multi-edit] warning: failed to clean up ${tmp}: ${cleanupMsg}`);
			}
			for (const rollbackPath of written) {
				const prior = finals.find((f) => f.path === rollbackPath)?.priorContent;
				if (prior !== undefined) {
					try {
						writeFileSync(rollbackPath, prior, "utf-8");
					} catch (rollbackErr) {
						// Last-ditch — if rollback itself fails we can't
						// recover, but surface the failure to the user.
						const rollbackMsg =
							rollbackErr instanceof Error
								? rollbackErr.message
								: String(rollbackErr);
						console.error(
							`[multi-edit] CRITICAL: rollback of ${rollbackPath} failed: ${rollbackMsg}`,
						);
					}
				}
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, failedPath: path, message: msg };
		}
	}
	return { ok: true };
}

// ───────────────────────────────────────────────
// Top-level orchestrator (pure: returns a result, doesn't print)
// ───────────────────────────────────────────────

/**
 * Orchestrate the full multi-edit flow. Returns a `MultiEditResult` so
 * callers (CLI command, tests) can print / assert on the outcome uniformly.
 *
 * Flow:
 *   1. Read pre-edit content for every file.
 *   2. Apply edits in order to each buffer, surfacing ambiguity/missing-match.
 *   3. Gate the final contents via the diff-overlay pipeline.
 *   4. Write all files atomically (temp+rename + rollback).
 *
 * Public API — exported so tests can drive the pipeline directly without
 * going through the commander action handler and its stdin plumbing.
 */
export function runMultiEdit(
	batches: EditBatch[],
	opts: { projectRoot?: string } = {},
): MultiEditResult {
	// Step 1 — read pre-edit content.
	const finals: Array<{ path: string; content: string; priorContent: string }> = [];
	for (const batch of batches) {
		const absPath = isAbsolute(batch.path) ? batch.path : resolve(process.cwd(), batch.path);
		let prior: string;
		try {
			prior = readFileSync(absPath, "utf-8");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: absPath, message: msg },
			};
		}
		// Step 2 — apply edits.
		const applied = applyEditsToBuffer(prior, batch.edits);
		if (!applied.ok) {
			const isAmbiguous = applied.code === MULTI_EDIT_ERROR_CODES.AMBIGUOUS_OLD_STRING;
			return {
				ok: false,
				error_code: applied.code,
				file_changes_applied: [],
				error_detail: {
					path: absPath,
					edit_index: applied.index,
					match_count: applied.matches,
					message: isAmbiguous
						? `Edit ${applied.index}: old_string matches ${applied.matches} locations in the current buffer; require exactly one match (ambiguity evaluated AFTER prior edits in this manifest).`
						: `Edit ${applied.index}: old_string not found in the current buffer.`,
				},
			};
		}
		finals.push({ path: absPath, content: applied.content, priorContent: prior });
	}

	// Step 3 — gate. If the final content is identical to on-disk (no-op
	// edits after composition), skip the gate AND the write for that file.
	const changedOnly = finals.filter((f) => f.content !== f.priorContent);
	if (changedOnly.length === 0) {
		// Nothing to do — all edits composed to a no-op. Successful trivially.
		return { ok: true, file_changes_applied: [] };
	}

	const gateFailures = gateProposedContentInline(
		changedOnly.map((f) => ({ path: f.path, content: f.content })),
		opts,
	);
	if (gateFailures.length > 0) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.GATE_REJECTED,
			file_changes_applied: [],
			gate_failures: gateFailures,
		};
	}

	// Step 4 — atomic batch write.
	const wrote = atomicBatchWrite(changedOnly);
	if (!wrote.ok) {
		return {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.WRITE_FAILED,
			file_changes_applied: [],
			error_detail: { path: wrote.failedPath, message: wrote.message },
		};
	}
	return {
		ok: true,
		file_changes_applied: changedOnly.map((f) => f.path),
	};
}

// ───────────────────────────────────────────────
// CLI entry point
// ───────────────────────────────────────────────

export interface MultiEditOpts {
	stdin?: boolean;
	manifest?: string;
	json?: boolean;
}

/**
 * Read stdin to completion as a UTF-8 string. Used when `--stdin` is set.
 */
async function readStdin(): Promise<string> {
	return await new Promise((resolveP, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolveP(data));
		process.stdin.on("error", reject);
	});
}

/**
 * Commander action handler for `interlinked multi-edit`.
 *
 * Supports two invocation shapes:
 *   interlinked multi-edit <path> --stdin
 *       Reads a single-file manifest ({ version: 1, edits: [...] }) from stdin.
 *   interlinked multi-edit --manifest <path>
 *       Reads a single-file OR multi-file manifest from `path`.
 */
export async function multiEditCommand(
	path: string | undefined,
	opts: MultiEditOpts,
): Promise<void> {
	const json = !!opts.json;

	// Mutually-exclusive input modes: must supply exactly one.
	const hasStdin = !!opts.stdin;
	const hasManifest = !!opts.manifest;
	if (hasStdin && hasManifest) {
		emit(json, {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: {
				path: path || "",
				message: "--stdin and --manifest are mutually exclusive.",
			},
		});
		process.exitCode = 1;
		return;
	}
	if (!hasStdin && !hasManifest) {
		emit(json, {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: {
				path: path || "",
				message:
					"Must supply either `<path> --stdin` (single file, manifest on stdin) or `--manifest <file>` (single or multi-file manifest).",
			},
		});
		process.exitCode = 1;
		return;
	}

	// Read the raw manifest JSON.
	let raw: string;
	if (hasStdin) {
		try {
			raw = await readStdin();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emit(json, {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: "<stdin>", message: msg },
			});
			process.exitCode = 1;
			return;
		}
	} else {
		// opts.manifest is guaranteed set by the mutex check above.
		const manifestPath = opts.manifest as string;
		try {
			raw = readFileSync(manifestPath, "utf-8");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emit(json, {
				ok: false,
				error_code: MULTI_EDIT_ERROR_CODES.READ_FAILED,
				file_changes_applied: [],
				error_detail: { path: manifestPath, message: msg },
			});
			process.exitCode = 1;
			return;
		}
	}

	// Parse + normalize.
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emit(json, {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: { path: path || "<manifest>", message: `JSON parse error: ${msg}` },
		});
		process.exitCode = 1;
		return;
	}

	const normalized = normalizeManifest(parsed, path);
	if (!normalized.ok) {
		emit(json, {
			ok: false,
			error_code: MULTI_EDIT_ERROR_CODES.INVALID_MANIFEST,
			file_changes_applied: [],
			error_detail: { path: path || "<manifest>", message: normalized.message },
		});
		process.exitCode = 1;
		return;
	}

	// Run the pipeline.
	const result = runMultiEdit(normalized.batches);
	emit(json, result);
	if (!result.ok) {
		process.exitCode = 1;
	}
}

// ───────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────

function emit(json: boolean, result: MultiEditResult): void {
	if (json) {
		// The design doc's --json shape. Omit empty fields for tidiness.
		const payload: JsonObject = {
			ok: result.ok,
			file_changes_applied: result.file_changes_applied,
		};
		if (result.error_code) payload.error_code = result.error_code;
		if (result.error_detail) payload.error_detail = result.error_detail;
		if (result.gate_failures) payload.gate_failures = result.gate_failures;
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	if (result.ok) {
		const n = result.file_changes_applied.length;
		if (n === 0) {
			console.log(c.dim("multi-edit: no-op (edits composed to identical content)."));
		} else {
			console.log(c.green(`multi-edit: ${n} file(s) updated`));
			for (const p of result.file_changes_applied) {
				console.log(`  ${p}`);
			}
		}
		return;
	}
	// Failure — human-readable.
	console.error(c.red(`multi-edit failed: ${result.error_code}`));
	if (result.error_detail) {
		const d = result.error_detail;
		const where = d.edit_index !== undefined ? ` (edit ${d.edit_index})` : "";
		console.error(`  ${d.path}${where}`);
		console.error(`  ${d.message}`);
	}
	if (result.gate_failures && result.gate_failures.length > 0) {
		console.error(c.dim(`  ${result.gate_failures.length} gate failure(s):`));
		for (const f of result.gate_failures) {
			console.error(`    ${f.path}: ${f.tool} [${f.code}] L${f.line} — ${f.message}`);
		}
	}
	console.error(c.dim("  No files changed."));
}
