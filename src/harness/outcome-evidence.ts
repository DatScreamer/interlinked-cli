// ===========================================
// Post-tool outcome-evidence lift (shared, protocol-agnostic)
// ===========================================
// The `.mjs` hook flattens a runner's object tool_response into the flat
// `stdout` / `stderr` / `exit_code` / `tool_outcome` fields via
// `deriveToolOutcome` BEFORE sending. The compiled `dist/hook-entry.js` path
// forwards the runner's object untouched, so every daemon consumer of the
// flat fields — `trackTestRun`, `classifyObservedOutcome`, the observed-check
// tracker, `trackErrorOutcome` — saw nothing. Observed live 2026-07-28: a
// PASSING bare `vitest run` classified "neither" and was dropped silently,
// while failures still recorded via the PostToolUseFailure event name — reds
// accumulated, greens could not clear them, and the commit gate wedged shut.
//
// This is the ONE implementation of the daemon-side lift. It is called from
// `processEvent` (server-event-loop) — the choke point BOTH socket protocols
// funnel through — and from `toHarnessEvent` (evaluator-unified) for direct
// framed evaluation. Idempotent by design: an event whose `tool_outcome` is
// already set (the `.mjs` path, or a second pass) is left untouched, so the
// two call sites cannot fight and hook-derived evidence always wins.

import type { HarnessEvent } from "./types.js";

/** Longest lifted stdout/stderr — evidence for classification, not storage.
 *  Tail-kept because test runners print their summary LAST. */
const EVIDENCE_TAIL_BYTES = 8_192;

function tailString(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	return v.length > EVIDENCE_TAIL_BYTES ? v.slice(-EVIDENCE_TAIL_BYTES) : v;
}

/**
 * Populate the flat outcome fields from an OBJECT tool_response, in place.
 *
 * Outcome derivation is conservative: any failure marker (PostToolUseFailure
 * event name, `is_error`, nonzero exit code) wins over "success", and
 * `interrupted` beats both, so a runner that folds failures into plain
 * PostToolUse events never gets a synthesized green. String responses are
 * left exactly as before (`observedOutput` reads them directly).
 */
export function liftOutcomeEvidence(event: HarnessEvent): void {
	if (event.hook_event !== "PostToolUse" && event.hook_event !== "PostToolUseFailure") return;
	// Already derived upstream (.mjs hook, or a prior pass) — never second-guess.
	if (event.tool_outcome !== undefined) return;
	const resp = event.tool_response;
	if (resp === null || resp === undefined || typeof resp !== "object" || Array.isArray(resp))
		return;
	// SAFETY: narrowed to a non-null, non-array object; every read below
	// re-checks its own field's type before use.
	const fields = resp as Record<string, unknown>;

	const stdout = tailString(fields.stdout);
	const stderr = tailString(fields.stderr);
	if (stdout !== undefined && event.stdout === undefined) event.stdout = stdout;
	if (stderr !== undefined && event.stderr === undefined) event.stderr = stderr;

	const codeRaw = fields.exitCode ?? fields.exit_code ?? fields.returncode;
	if (typeof codeRaw === "number" && event.exit_code === undefined) event.exit_code = codeRaw;

	const failed =
		event.hook_event === "PostToolUseFailure" ||
		fields.is_error === true ||
		(typeof codeRaw === "number" && codeRaw !== 0);
	if (fields.interrupted === true) event.tool_outcome = "interrupted";
	else event.tool_outcome = failed ? "error" : "success";
}
