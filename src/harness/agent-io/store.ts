// ===========================================
// agent-io store — the append-only writer
// ===========================================
// Same durability semantics as activity.jsonl: one synchronous append per
// row, no buffering, the file survives daemon restarts, and every row is
// self-describing so a reader never needs daemon state to interpret it.
//
// `recordAgentIo` is the ONE choke point. Everything — content scrub, size
// bounding, blob spill, the log append — happens behind it, so the `dry_run`
// refusal is total: a synthetic `harness test` event cannot leave a log row, a
// blob, or even a directory behind. (CLAUDE.md, "A dry run must not move the
// gate": three simulated writes once opened a real transient debt against a
// file they never touched.)
//
// Best-effort / fail-open (feedback_safety_continuity): capture must never
// break the guard pipeline, so every path swallows its error and returns 0.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactPii, scrubSecrets } from "../../lib/secrets.js";
import {
	type AgentIoContentStatus,
	type AgentIoDirection,
	type AgentIoKind,
	type AgentIoLabelSource,
	type AgentIoRecord,
	type AgentIoSource,
	type AgentIoTokens,
	INLINE_MAX_BYTES,
	MAX_BLOB_BYTES,
	MAX_TOOL_USE_IDS,
} from "./types.js";

/** The log file — sibling of activity.jsonl, same gitignore treatment. */
export function agentIoLogPath(cwd: string): string {
	return join(cwd, ".interlinked", "agent-io.jsonl");
}

/** Directory holding spilled content blobs. */
export function agentIoBlobsDir(cwd: string): string {
	return join(cwd, ".interlinked", "agent-io", "blobs");
}

/** Absolute path of one blob, from a record's `content_ref`. */
export function agentIoBlobPath(cwd: string, contentRef: string): string {
	return join(cwd, ".interlinked", "agent-io", contentRef);
}

/** sha256 of a utf-8 string, hex. */
export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Secrets + PII scrub for one natural-language field. Identical policy to
 *  `scrubFinalMessage` — the same two passes in the same order — so a prompt
 *  captured here and a result captured on the collection record are redacted
 *  the same way. Returns which passes actually redacted something. */
export function scrubContent(text: string): { text: string; passes: string[] } {
	const secrets = scrubSecrets(text);
	const pii = redactPii(secrets.text);
	const passes: string[] = [];
	if (secrets.found > 0) passes.push("secrets");
	if (pii.found > 0) passes.push("pii");
	return { text: pii.text, passes };
}

/** The storage decision for one content string. */
export interface StoredContent {
	content: string | null;
	content_ref: string | null;
	content_sha256: string;
	content_bytes: number;
	truncated: boolean;
	scrubbed: boolean;
	redaction_passes: string[];
}

/** Content fields for a row that carries no content (encrypted at the runner
 *  boundary, or never materialized). The hash of the empty string keeps
 *  `content_sha256` genuinely always-present, so dedup by
 *  agent+kind+sha still collapses repeated placeholders. */
export function emptyContent(): StoredContent {
	return {
		content: null,
		content_ref: null,
		content_sha256: sha256(""),
		content_bytes: 0,
		truncated: false,
		scrubbed: false,
		redaction_passes: [],
	};
}

/** Write a content-addressed blob, skipping the write when it already exists
 *  (the pattern proven in scratchpad-archive.ts). */
function writeBlob(cwd: string, digest: string, body: string): void {
	const dir = agentIoBlobsDir(cwd);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, digest);
	if (existsSync(path)) return;
	writeFileSync(path, body);
}

/**
 * Scrub, bound, and (when oversized) spill one content string.
 *
 * Order matters: the scrub runs BEFORE the hash, so `content_sha256` always
 * identifies the bytes actually stored — never a pre-redaction original that
 * exists nowhere. `content_bytes` is the pre-truncation size, so a truncated
 * row still reports how much there really was.
 */
export function prepareContent(raw: string | null, cwd: string): StoredContent {
	if (raw === null || raw === "") return emptyContent();
	const { text, passes } = scrubContent(raw);
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= INLINE_MAX_BYTES) {
		return {
			content: text,
			content_ref: null,
			content_sha256: sha256(text),
			content_bytes: bytes,
			truncated: false,
			scrubbed: true,
			redaction_passes: passes,
		};
	}
	const truncated = bytes > MAX_BLOB_BYTES;
	const body = truncated
		? Buffer.from(text, "utf-8").subarray(0, MAX_BLOB_BYTES).toString("utf-8")
		: text;
	const digest = sha256(body);
	writeBlob(cwd, digest, body);
	return {
		content: null,
		content_ref: `blobs/${digest}`,
		content_sha256: digest,
		content_bytes: bytes,
		truncated,
		scrubbed: true,
		redaction_passes: passes,
	};
}

/** Everything a capture surface knows about one row, before storage decides
 *  how to hold the content. */
export interface AgentIoRowInput {
	ts: string;
	seq?: number | null;
	session?: string | null;
	parent_session?: string | null;
	agent_id?: string | null;
	spawn_tool_use_id?: string | null;
	agent_label?: string | null;
	agent_label_source?: AgentIoLabelSource | null;
	runner: string;
	direction: AgentIoDirection;
	role: "user" | "assistant";
	kind: AgentIoKind;
	source: AgentIoSource;
	/** Raw, unscrubbed content. Null for a placeholder row. */
	raw: string | null;
	content_status?: AgentIoContentStatus;
	/** Default true. Set false with a reason when the direction is
	 *  structurally unreachable for this runner. */
	input_capturable?: boolean;
	uncapturable_reason?: string | null;
	tokens?: AgentIoTokens | null;
	tool_use_ids?: string[] | null;
	cwd?: string | null;
}

/** Cap the join-key list, reporting when it was cut. */
function boundToolUseIds(ids: string[] | null | undefined): {
	ids: string[] | null;
	truncated: boolean;
} {
	if (!ids) return { ids: null, truncated: false };
	if (ids.length <= MAX_TOOL_USE_IDS) return { ids, truncated: false };
	return { ids: ids.slice(0, MAX_TOOL_USE_IDS), truncated: true };
}

/** Assemble one record. Pure apart from the blob spill inside
 *  `prepareContent`, which is content-addressed and idempotent. */
export function buildAgentIoRecord(input: AgentIoRowInput, cwd: string): AgentIoRecord {
	const stored = prepareContent(input.raw, cwd);
	const bounded = boundToolUseIds(input.tool_use_ids);
	return {
		schema: "agent-io.v1",
		ts: input.ts,
		seq: input.seq ?? null,
		session: input.session ?? null,
		parent_session: input.parent_session ?? null,
		agent_id: input.agent_id ?? null,
		spawn_tool_use_id: input.spawn_tool_use_id ?? null,
		agent_label: input.agent_label ?? null,
		agent_label_source: input.agent_label_source ?? null,
		runner: input.runner,
		direction: input.direction,
		role: input.role,
		kind: input.kind,
		source: input.source,
		content: stored.content,
		content_ref: stored.content_ref,
		content_sha256: stored.content_sha256,
		content_bytes: stored.content_bytes,
		truncated: stored.truncated,
		content_status: input.content_status ?? (input.raw ? "captured" : "unavailable"),
		input_capturable: input.input_capturable ?? true,
		uncapturable_reason: input.uncapturable_reason ?? null,
		scrubbed: stored.scrubbed,
		redaction_passes: stored.redaction_passes,
		tokens: input.tokens ?? null,
		tool_use_ids: bounded.ids,
		tool_use_ids_truncated: bounded.truncated,
		cwd: input.cwd ?? cwd,
		dry_run: false,
	};
}

/** Where a batch of rows is written, and whether this is a simulation. */
export interface RecordAgentIoOpts {
	cwd: string;
	/** `harness test` and every other synthetic event. When true this call
	 *  touches NO disk state — no log row, no blob, no directory. */
	dryRun?: boolean;
}

/**
 * Append rows to `.interlinked/agent-io.jsonl`. Returns the number appended.
 * Fail-open: never throws, never affects a guard decision.
 */
export function recordAgentIo(rows: AgentIoRowInput[], opts: RecordAgentIoOpts): number {
	try {
		if (opts.dryRun === true || rows.length === 0) return 0;
		const built = rows.map((row) => JSON.stringify(buildAgentIoRecord(row, opts.cwd)));
		mkdirSync(join(opts.cwd, ".interlinked"), { recursive: true });
		appendFileSync(agentIoLogPath(opts.cwd), `${built.join("\n")}\n`);
		return built.length;
	} catch (err) {
		void err; // capture is best-effort — never break the pipeline
		return 0;
	}
}
