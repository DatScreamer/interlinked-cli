#!/usr/bin/env node
// backfill-thinking.mjs — recover reasoning traces the active hook
// (dist/hook-entry.js) stopped capturing when the install switched away from the
// standalone .mjs hook (which alone ran extractNewThinking).
//
// The raw thinking is intact in Claude Code's own session transcripts
// (~/.claude/projects/<slug>/<session>.jsonl); only interlinked's copy in
// .interlinked/activity.jsonl is missing it. This script reads those transcripts
// and appends scrubbed records carrying a top-level `thinking` field.
//
// Shape: matches the EXISTING pre-June-1 shape — thinking is a FIELD on a
// schema_version:5 lifecycle record (`tool_use_start` for a turn that called a
// tool, `agent_stop` for a text-only turn), NOT a dedicated record type. No
// schema-version change. Backfilled rows carry `source:"backfill-thinking"` for
// provenance (additive; existing consumers read `record.thinking` either way).
//
// Self-contained (no imports from the built CLI): scrubbing is inlined,
// mirroring src/lib/hook-template-chunks/redaction.ts + src/lib/secrets.ts.
//
// Idempotent + incremental: a per-transcript byte cursor in
// .interlinked/backfill-thinking-cursor.json means re-runs only process new
// transcript content. Records are appended (land out of ts-order at the tail —
// consumers sort by `ts`).
//
// Usage:
//   node scripts/backfill-thinking.mjs [--dry-run] [--since <ISO>] [--reset]
//   node scripts/backfill-thinking.mjs --all-tools [--reset]
//     --all-tools: emit a tool_use_start for EVERY tool call (the full history),
//     not just turns that had preceding thinking. Best for a fresh-install import
//     of all past activity; pair with --reset to re-scan transcripts already seen.

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- inlined scrubber (mirrors redaction.ts PII + secrets.ts patterns) ------

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
function scrubText(text) {
	if (!text || typeof text !== "string") return text;
	let out = text;
	for (const [re, tag] of SECRET_PATTERNS) out = out.replace(re, () => (scrubHits++, `[REDACTED:${tag}]`));
	for (const [re, tag] of PII_PATTERNS) out = out.replace(re, () => (scrubHits++, `[REDACTED:${tag}]`));
	return out;
}

// ---- args / paths -----------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const NO_SORT = args.includes("--no-sort");
const ALL_TOOLS = args.includes("--all-tools");
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

const cwd = process.cwd();
const slug = cwd.replace(/\//g, "-");
const transcriptDir = join(homedir(), ".claude", "projects", slug);
const dataDir = join(cwd, ".interlinked");
const activityPath = join(dataDir, "activity.jsonl");
const cursorPath = join(dataDir, "backfill-thinking-cursor.json");

if (!existsSync(transcriptDir)) {
	console.error(`[backfill] no transcript dir for this project: ${transcriptDir}`);
	process.exit(1);
}
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// Per-project constant keys — read from an existing real record so backfilled
// rows match exactly; fall back to "main".
function readProjectKeys() {
	const keys = { workspace_key: "main", project_key: "main" };
	if (!existsSync(activityPath)) return keys;
	try {
		const fd = openSync(activityPath, "r");
		const buf = Buffer.alloc(256 * 1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		closeSync(fd);
		for (const line of buf.subarray(0, n).toString("utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const r = JSON.parse(line);
				if (r.workspace_key && r.project_key && r.source !== "backfill-thinking") {
					keys.workspace_key = r.workspace_key;
					keys.project_key = r.project_key;
					return keys;
				}
			} catch (e) {
				void e;
			}
		}
	} catch (e) {
		void e;
	}
	return keys;
}
const PROJECT_KEYS = readProjectKeys();

let cursor = {};
if (!RESET && existsSync(cursorPath)) {
	try {
		cursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
	} catch (e) {
		void e;
		cursor = {};
	}
}

function summarize(tool, input) {
	if (!input || typeof input !== "object") return tool || "";
	return String(input.file_path || input.path || input.command || input.pattern || input.url || tool || "");
}

// ---- backfill ---------------------------------------------------------------

const transcripts = readdirSync(transcriptDir)
	.filter((f) => f.endsWith(".jsonl"))
	.map((f) => join(transcriptDir, f));

let totalThinking = 0;
let totalRecords = 0;
const pending = [];

for (const tpath of transcripts) {
	let size = 0;
	try {
		size = statSync(tpath).size;
	} catch (e) {
		void e;
		continue;
	}
	const startOffset = cursor[tpath] || 0;
	if (startOffset >= size) continue;

	let content = "";
	try {
		content = readFileSync(tpath).subarray(startOffset).toString("utf-8");
	} catch (e) {
		void e;
		continue;
	}

	const sessionFromFile = tpath.split("/").pop().replace(/\.jsonl$/, "");

	// Interleaved thinking is logged as STANDALONE assistant records, each
	// immediately BEFORE the tool_use record it precedes (verified: thinking and
	// tool_use are never co-located in the same record). So buffer thinking and
	// attach it to the FOLLOWING tool_use's tool_use_start record — matching how
	// the old .mjs captured thinking at PreToolUse. Thinking not followed by a
	// tool before the turn ends (a user message intervenes / transcript ends)
	// lands on an agent_stop record.
	let pend = [];
	let pendTs = null;
	let pendSession = null;
	let pendModel = null;
	const emit = (rec) => {
		if (SINCE && rec.ts && rec.ts < SINCE) return;
		pending.push(rec);
		totalRecords++;
	};
	const flushAgentStop = () => {
		if (pend.length === 0) return;
		totalThinking += pend.length;
		emit({
			schema_version: 5,
			ts: pendTs || new Date(0).toISOString(),
			agent: "claude",
			workspace_key: PROJECT_KEYS.workspace_key,
			project_key: PROJECT_KEYS.project_key,
			type: "agent_stop",
			tool: null,
			summary: "",
			session: pendSession || sessionFromFile,
			hook: "Stop",
			tool_input: {},
			cwd,
			thinking: scrubText(pend.join("\n---\n")),
			source: "backfill-thinking",
			model: pendModel ?? undefined,
		});
		pend = [];
		pendTs = null;
		pendSession = null;
		pendModel = null;
	};

	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let obj;
		try {
			obj = JSON.parse(t);
		} catch (e) {
			void e;
			continue;
		}
		if (obj.type !== "assistant") {
			flushAgentStop(); // a user/non-assistant turn boundary ends any pending thinking
			continue;
		}
		const blocks = obj.message?.content;
		if (!Array.isArray(blocks)) continue;

		const toolsInMsg = [];
		for (const b of blocks) {
			if (!b || typeof b !== "object") continue;
			if (b.type === "thinking" && b.thinking) {
				pend.push(b.thinking);
				if (!pendTs) pendTs = obj.timestamp || obj.ts || null;
				pendSession = obj.sessionId || sessionFromFile;
				if (!pendModel) pendModel = obj.message?.model ?? null;
			} else if (b.type === "tool_use") {
				toolsInMsg.push({ id: b.id, name: b.name, input: b.input });
			}
		}
		// Default (legacy): emit ONLY the first tool of a thinking-bearing turn, so
		// the row mirrors what the old PreToolUse hook captured at that moment.
		// --all-tools broadens to the FULL tool history: every tool_use becomes its
		// own tool_use_start, the buffered thinking rides the first call, the rest
		// carry empty thinking. (A message can hold parallel tool_use blocks.)
		const toEmit = ALL_TOOLS ? toolsInMsg : pend.length > 0 && toolsInMsg.length > 0 ? [toolsInMsg[0]] : [];
		for (let ti = 0; ti < toEmit.length; ti++) {
			const tool = toEmit[ti];
			if (ti === 0 && pend.length > 0) totalThinking += pend.length;
			const rec = {
				schema_version: 5,
				ts: obj.timestamp || obj.ts || pendTs || new Date(0).toISOString(),
				agent: "claude",
				workspace_key: PROJECT_KEYS.workspace_key,
				project_key: PROJECT_KEYS.project_key,
				type: "tool_use_start",
				tool: tool.name ?? null,
				summary: summarize(tool.name, tool.input),
				session: obj.sessionId || sessionFromFile,
				hook: "PreToolUse",
				tool_input: tool.input ?? {},
				cwd: obj.cwd || cwd,
				thinking: scrubText(ti === 0 ? pend.join("\n---\n") : ""),
				source: "backfill-thinking",
				model: obj.message?.model ?? pendModel ?? undefined,
			};
			if (tool.id) rec.tool_use_id = tool.id;
			emit(rec);
		}
		if (toEmit.length > 0) {
			pend = [];
			pendTs = null;
			pendSession = null;
			pendModel = null;
		}
	}
	flushAgentStop(); // end of transcript — any trailing thinking
	if (!DRY_RUN) cursor[tpath] = size;
}

// ---- write ------------------------------------------------------------------

if (DRY_RUN) {
	console.log(
		`[backfill] DRY RUN: would append ${totalRecords} record(s)${ALL_TOOLS ? " (incl. every tool call)" : ""} carrying thinking ` +
			`(${totalThinking} block(s)) across ${transcripts.length} transcript(s). ` +
			`scrub hits: ${scrubHits}. keys: ${PROJECT_KEYS.workspace_key}/${PROJECT_KEYS.project_key}. No files written.`,
	);
	process.exit(0);
}

if (pending.length > 0) appendFileSync(activityPath, pending.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));

// Backfilled rows are appended at the tail with historical timestamps, so the
// file is no longer time-ordered. Re-sort the whole log by `ts` (stable, so
// equal-ts rows keep insertion order). The live capture path appends in-order,
// so this is only needed after a backfill. `ts` is extracted by regex to avoid
// JSON.parse on every (sometimes huge) line.
function sortActivityByTs() {
	if (!existsSync(activityPath)) return 0;
	const raw = readFileSync(activityPath, "utf-8");
	const lines = raw.split("\n").filter((l) => l.length > 0);
	const tsRe = /"ts":"([^"]+)"/;
	const keyed = lines.map((l, i) => {
		const m = tsRe.exec(l);
		return { ts: m ? m[1] : "", i, l };
	});
	keyed.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i));
	const tmp = `${activityPath}.sorted.tmp`;
	writeFileSync(tmp, keyed.map((k) => k.l).join("\n") + "\n");
	renameSync(tmp, activityPath);
	return keyed.length;
}

let sortedCount = 0;
if (!NO_SORT) sortedCount = sortActivityByTs();

console.log(
	`[backfill] appended ${totalRecords} record(s)${ALL_TOOLS ? " (incl. every tool call)" : ""} carrying thinking ` +
		`(${totalThinking} block(s)) to ${activityPath}. scrub hits: ${scrubHits}.` +
		(NO_SORT ? " (--no-sort: not re-sorted)" : ` sorted ${sortedCount} line(s) by ts.`),
);
