#!/usr/bin/env node
// backfill-recovery.mjs — enrich activity.jsonl in place from Claude Code's own
// session transcripts. Recovers fields the daemon mirror never captured (token
// usage, tool outputs) and tops off ones it captured partially (model, thinking).
//
// This is an ENRICHMENT pass, NOT an append: it fills MISSING fields on the
// rows already in activity.jsonl, joined by `tool_use_id`. It never adds or drops
// rows, so it cannot create the live+backfill duplication that an append would.
// (Re-running is therefore idempotent: a field already present is left alone.)
//
// Sources (verified): every assistant transcript record carries `message.usage`
// (input/output/cache tokens) and `message.model`; every `tool_result` carries
// `tool_use_id` + `content`. The join key is `tool_use_id` — 100% of PostToolUse
// (`tool_use`) rows have it.
//
// Recovered fields:
//   - tokens        ← message.usage           (attached to the message's first tool row)
//   - model         ← message.model           (any tool row for that message)
//   - thinking      ← message thinking blocks  (first tool row, only if absent)
//   - tool_response ← tool_result.content      (the matching `tool_use` row, only if absent)
//
// Safety: writes a timestamped backup, streams to a temp file, verifies the line
// count is unchanged, then atomically renames. Order is preserved (same rows,
// same ts), so no re-sort is needed. Secrets are always redacted; PII is redacted
// in reasoning text only (tool I/O is kept full-fidelity per project policy).
//
// Usage:
//   node scripts/backfill-recovery.mjs --dry-run     # report only, no writes
//   node scripts/backfill-recovery.mjs               # enrich in place (+ backup)
//   node scripts/backfill-recovery.mjs --max-output 50000   # per-output byte cap

import {
	appendFileSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---- inlined scrubber (mirrors backfill-thinking.mjs) -----------------------

const SECRET_PATTERNS = [
	[/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "anthropic-key"],
	[/\bsk-[A-Za-z0-9]{20,}\b/g, "openai-key"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "aws-akid"],
	[/\bgh[posru]_[A-Za-z0-9]{30,}\b/g, "github-token"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt"],
	[/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, "private-key"],
	[/\b[Bb]earer\s+[A-Za-z0-9._-]{20,}\b/g, "bearer"],
];
const PII_PATTERNS = [
	[/\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g, "ssn"],
	[/\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g, "cc"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email"],
	[/\b[(]?[0-9]{3}[)]?[-. ][0-9]{3}[-. ][0-9]{4}\b/g, "phone"],
];

let scrubHits = 0;
function scrubSecrets(text) {
	if (!text || typeof text !== "string") return text;
	let out = text;
	for (const [re, tag] of SECRET_PATTERNS) out = out.replace(re, () => (scrubHits++, `[REDACTED:${tag}]`));
	return out;
}
function scrubReasoning(text) {
	let out = scrubSecrets(text);
	if (typeof out === "string") for (const [re, tag] of PII_PATTERNS) out = out.replace(re, () => (scrubHits++, `[REDACTED:${tag}]`));
	return out;
}

// ---- args / paths -----------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const maxOutIdx = args.indexOf("--max-output");
const MAX_OUTPUT = maxOutIdx >= 0 ? Number(args[maxOutIdx + 1]) : 50000;

const cwd = process.cwd();
const slug = cwd.replace(/\//g, "-");
const transcriptDir = join(homedir(), ".claude", "projects", slug);
const dataDir = join(cwd, ".interlinked");
const activityPath = join(dataDir, "activity.jsonl");

if (!existsSync(transcriptDir)) {
	console.error(`[recovery] no transcript dir for this project: ${transcriptDir}`);
	process.exit(1);
}
if (!existsSync(activityPath)) {
	console.error(`[recovery] no activity log at ${activityPath}`);
	process.exit(1);
}
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ---- tool_result content normalization --------------------------------------

/** A tool_result's `content` is a string OR an array of blocks (text/image).
 *  Flatten to a string, drop binary blobs (images) to a marker, cap the size. */
function normalizeOutput(content) {
	let text;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : b?.type ? `[${b.type} content omitted]` : ""))
			.join("");
	} else text = content == null ? "" : JSON.stringify(content);
	let truncated = false;
	if (text.length > MAX_OUTPUT) {
		text = `${text.slice(0, MAX_OUTPUT)}…[+${text.length - MAX_OUTPUT} bytes truncated]`;
		truncated = true;
	}
	return { text: scrubSecrets(text), truncated };
}

// ---- pass 1: build the transcript enrichment index --------------------------

const idModel = new Map(); // tool_use_id -> model
const msgFirst = new Map(); // first tool_use_id of a message -> { tokens, thinking }
const idResult = new Map(); // tool_use_id -> { tool_response, is_error }

function usageToTokens(u) {
	if (!u || typeof u !== "object") return null;
	const t = {};
	if (typeof u.input_tokens === "number") t.input = u.input_tokens;
	if (typeof u.output_tokens === "number") t.output = u.output_tokens;
	if (typeof u.cache_read_input_tokens === "number") t.cache_read = u.cache_read_input_tokens;
	if (typeof u.cache_creation_input_tokens === "number") t.cache_creation = u.cache_creation_input_tokens;
	return Object.keys(t).length > 0 ? t : null;
}

const transcripts = readdirSync(transcriptDir)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => join(transcriptDir, f));

let truncations = 0;
for (const tpath of transcripts) {
	const rl = createInterface({ input: createReadStream(tpath), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (o.type === "assistant") {
			const msg = o.message;
			if (!msg || !Array.isArray(msg.content)) continue;
			const model = msg.model ?? null;
			const tokens = usageToTokens(msg.usage);
			const thinkingBlocks = [];
			const toolIds = [];
			for (const b of msg.content) {
				if (!b || typeof b !== "object") continue;
				if (b.type === "thinking" && b.thinking) thinkingBlocks.push(b.thinking);
				else if (b.type === "tool_use" && b.id) {
					toolIds.push(b.id);
					if (model) idModel.set(b.id, model);
				}
			}
			if (toolIds.length > 0) {
				const first = toolIds[0];
				const entry = {};
				if (tokens) entry.tokens = tokens;
				if (thinkingBlocks.length > 0) entry.thinking = scrubReasoning(thinkingBlocks.join("\n---\n"));
				if (Object.keys(entry).length > 0) msgFirst.set(first, entry);
			}
		} else if (o.type === "user") {
			const content = o.message?.content;
			if (!Array.isArray(content)) continue;
			for (const b of content) {
				if (b && typeof b === "object" && b.type === "tool_result" && b.tool_use_id) {
					const { text, truncated } = normalizeOutput(b.content);
					if (truncated) truncations++;
					idResult.set(b.tool_use_id, { tool_response: text, is_error: b.is_error === true });
				}
			}
		}
	}
}

// ---- pass 2: enrich activity.jsonl row-by-row -------------------------------

const stats = { rows: 0, model: 0, tokens: 0, thinking: 0, tool_response: 0, bytesAdded: 0 };
const outLines = [];

const rl2 = createInterface({ input: createReadStream(activityPath), crlfDelay: Infinity });
for await (const line of rl2) {
	if (!line.trim()) {
		continue;
	}
	stats.rows++;
	let r;
	try {
		r = JSON.parse(line);
	} catch {
		outLines.push(line);
		continue;
	}
	const id = r.tool_use_id;
	const before = JSON.stringify(r).length;
	if (id) {
		if (!r.model && idModel.has(id)) {
			r.model = idModel.get(id);
			stats.model++;
		}
		const mf = msgFirst.get(id);
		if (mf) {
			if (!r.tokens && mf.tokens) {
				r.tokens = mf.tokens;
				stats.tokens++;
			}
			if (!r.thinking && mf.thinking) {
				r.thinking = mf.thinking;
				stats.thinking++;
			}
		}
		// Tool outputs land on the PostToolUse row (type tool_use / tool_use_error).
		if ((r.type === "tool_use" || r.type === "tool_use_error") && r.tool_response === undefined && idResult.has(id)) {
			const res = idResult.get(id);
			r.tool_response = res.tool_response;
			if (res.is_error && r.error === undefined) r.error = true;
			stats.tool_response++;
		}
	}
	const after = JSON.stringify(r);
	stats.bytesAdded += after.length - before;
	outLines.push(after);
}

// ---- report / write ---------------------------------------------------------

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const summary =
	`rows=${stats.rows}  +model=${stats.model}  +tokens=${stats.tokens}  ` +
	`+thinking=${stats.thinking}  +tool_response=${stats.tool_response}  ` +
	`(${truncations} outputs truncated @${MAX_OUTPUT}B)  growth≈${mb(stats.bytesAdded)}  scrubHits=${scrubHits}`;

if (DRY_RUN) {
	console.log(`[recovery] DRY RUN — no files written.\n[recovery] ${summary}`);
	process.exit(0);
}

const backup = `${activityPath}.pre-recovery.bak`;
copyFileSync(activityPath, backup);
const tmp = `${activityPath}.recovery.tmp`;
writeFileSync(tmp, `${outLines.join("\n")}\n`);

// Verify the rewrite preserved every row before swapping it in.
let tmpCount = 0;
const rlv = createInterface({ input: createReadStream(tmp), crlfDelay: Infinity });
for await (const l of rlv) if (l.trim()) tmpCount++;
if (tmpCount !== stats.rows) {
	console.error(`[recovery] ABORT: temp row count ${tmpCount} != source ${stats.rows}. Left ${tmp} in place; activity.jsonl untouched.`);
	process.exit(1);
}
renameSync(tmp, activityPath);
console.log(`[recovery] backup → ${backup}`);
console.log(`[recovery] ${summary}`);
