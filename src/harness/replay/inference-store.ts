// ===========================================
// G1 inference-envelope store
// ===========================================
// Append/load for `inference-envelope.v1` records — the exact model
// request/response pairs captured at the inference boundary by the proxy
// (docs/design/reproducibility/g1-inference-capture.md). The proxy appends to
// `pending.jsonl` (it knows nothing about harness sessions); the Tier-1
// trace assembler later joins envelopes to hook events by `tool_use_id`,
// stamps `session_id`/`seq`, and rewrites into per-session files.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";

export interface InferenceEnvelope {
	schema: "inference-envelope.v1";
	/** Monotonic per proxy process — proxy-local ordering only. */
	request_index: number;
	ts_request: string;
	ts_response: string;
	latency_ms: number;
	provider: "anthropic";
	/** Non-auth headers that are part of the exact input (version + beta
	 *  flags). Auth material is stripped before persistence — see
	 *  `persistableHeaders` in inference-envelope.ts. */
	request_headers: JsonObject;
	/** The EXACT request body as sent: model/system/tools/messages plus every
	 *  other parameter under `params`. */
	request: JsonObject;
	/** Reassembled (or direct-JSON) response: id, stop_reason, usage, content. */
	response: JsonObject;
	/** tool_use block ids extracted from response.content — the join key to
	 *  the hook logs. Empty for text-only turns. */
	tool_use_ids: string[];
	request_sha256: string;
	/** Stamped by the trace assembler after the tool_use_id join; null as
	 *  written by the proxy. */
	session_id: string | null;
	seq: number | null;
}

/** Resolve the capture file the proxy appends to. */
export function pendingEnvelopePath(replayDir: string): string {
	return join(replayDir, "inference", "pending.jsonl");
}

/** Append one envelope. Creates the directory on first use. Throws on I/O
 *  failure — the PROXY decides to log-and-continue (capture must never break
 *  forwarding), so the fail-open lives at the call site, not here. */
export function appendEnvelope(replayDir: string, envelope: InferenceEnvelope): void {
	const path = pendingEnvelopePath(replayDir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(envelope)}\n`);
}

/** Load every parseable envelope from a JSONL file. Tolerant: unparseable or
 *  wrong-schema lines are skipped (a torn tail write must not poison reads). */
export function loadEnvelopes(path: string): InferenceEnvelope[] {
	if (!existsSync(path)) return [];
	const out: InferenceEnvelope[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as InferenceEnvelope;
			if (parsed && parsed.schema === "inference-envelope.v1") out.push(parsed);
		} catch (err) {
			void err; // torn tail / foreign line — skipping is this reader's contract
		}
	}
	return out;
}

/** Find the envelope whose response contains this tool_use id. The id
 *  namespace is shared with the hook logs' `tool_use_id`, which makes this
 *  the Tier-1 join. Returns the FIRST match (ids are unique per API). */
export function envelopeForToolUseId(
	envelopes: readonly InferenceEnvelope[],
	toolUseId: string,
): InferenceEnvelope | null {
	for (const e of envelopes) {
		if (e.tool_use_ids.includes(toolUseId)) return e;
	}
	return null;
}
