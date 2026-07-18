// Recurrence signature derivation + assembly-ranking helpers, split out of
// recurrence.ts for the per-file line cap. `deriveSignature` maps an event to
// its grouping key (each kind namespaces its own key so distinct kinds never
// merge); `signaturePayload` / `SIGNATURE_ASSEMBLY_CAP` feed the assembly-index
// tiebreak in aggregateRecurrences.

import { createHash } from "node:crypto";
import type { RecurrenceEvent } from "./recurrence.js";

/** The free-text payload of a signatureless kind: explicit signature, else
 *  message, else the "untagged" sentinel. Shared by harness_missed and
 *  outcome_marker so deriveSignature stays flat. */
function signatureOrMessage(event: RecurrenceEvent): string {
	return event.signature ?? event.message ?? "untagged";
}

/** Max readable message prefix in a signatureless tool_failure key. */
const TOOL_FAILURE_MSG_CAP = 120;

/** 128-bit SHA-256 prefix — collision-resistant disambiguator (round-18's
 *  32-bit djb2 could theoretically collide two distinct long messages sharing a
 *  prefix; round-19 sol #1). 128 bits puts an accidental collision far beyond
 *  any realistic message volume. */
function shortHash(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** Group a signatureless failure by its message, but don't collapse distinct
 *  messages that merely share a prefix (round-18 sol #2): keep short messages
 *  readable; disambiguate longer ones with a hash of the FULL message. */
function messageKey(message: string): string {
	return message.length <= TOOL_FAILURE_MSG_CAP
		? message
		: `${message.slice(0, TOOL_FAILURE_MSG_CAP)}#${shortHash(message)}`;
}

/** outcome_marker identity is the FIRE it marks — (check_id, file, session_id,
 *  fire_ts) per the RecurrenceEvent contract (round-13 sol #1) — NOT free text.
 *  Grouping by message would collapse unrelated outcomes and split one fire by
 *  wording, breaking the FP-rate aggregator's pairing. */
function outcomeMarkerKey(event: RecurrenceEvent): string {
	// JSON-encode the tuple so no field value (a file path, or a colon-bearing
	// fire_ts) can collide with the separator.
	const parts = [event.check_id, event.file, event.session_id, event.fire_ts];
	return `outcome_marker:${JSON.stringify(parts.map((p) => p ?? null))}`;
}

/** Map an event to its recurrence grouping signature. Every kind namespaces its
 *  own key. */
export function deriveSignature(event: RecurrenceEvent): string {
	if (event.kind === "harness_caught") {
		return `harness_caught:${event.check_id ?? "unknown"}:${event.agent_source ?? "unknown"}`;
	}
	if (event.kind === "codebase_existing") {
		return `codebase_existing:${event.check_id ?? "unknown"}`;
	}
	if (event.kind === "tool_failure") {
		// Forward the harness's pre-built `tool_failure:<tool>:<error_class>:<msg>`
		// signature when set, else a coarse fallback so old rows still aggregate.
		// Enforce the `tool_failure:` namespace on a forwarded signature (round-15
		// sol #3) so a caller-supplied value can't impersonate another kind's key.
		if (event.signature) {
			return event.signature.startsWith("tool_failure:")
				? event.signature
				: `tool_failure:${event.signature}`;
		}
		return `tool_failure:${event.check_id ?? "unknown"}:${messageKey(event.message ?? "untagged")}`;
	}
	// outcome_marker gets its OWN namespace (round-12 sol #2): otherwise it fell
	// through to harness_missed and every unsignatured outcome inflated one
	// "harness_missed:untagged" row.
	if (event.kind === "outcome_marker") {
		return outcomeMarkerKey(event);
	}
	return `harness_missed:${signatureOrMessage(event)}`;
}

/** Cap on the signature prefix fed to the assembly-index ranker. The index is
 *  O(min(512,n)·n); a `harness_missed` signature carries an unbounded
 *  user-supplied message, so a pathological length would make each per-row call
 *  cost tens of ms. The first N chars carry more than enough structure to rank
 *  by — truncation only affects the tiebreak, never correctness. */
export const SIGNATURE_ASSEMBLY_CAP = 256;

/** The variable payload of a signature — everything after the leading "<kind>:"
 *  transport prefix (round-9 sol #2). Ranking must score THIS, not the whole
 *  signature: the fixed kind prefix is reusable boilerplate that both inflates
 *  structure and consumes the cap unevenly across kinds, biasing cross-kind
 *  ordering. Falls back to the whole string when there's no colon. */
export function signaturePayload(signature: string): string {
	const colon = signature.indexOf(":");
	return colon >= 0 ? signature.slice(colon + 1) : signature;
}
