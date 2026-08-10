// Live thinking capture — the daemon-side port of what the old self-contained
// .mjs hook did and the thin hook-entry.js path never replicated (the cause of
// the June-1 thinking-capture regression). On a PreToolUse event the daemon
// resolves the agent's transcript and reads the NEW reasoning blocks recorded
// since the last tool call — that's the thinking that preceded THIS tool — then
// the activity writer attaches it to the tool_use_start record.
//
// Byte-offset cursor per transcript (.interlinked/thinking-cursor.json), so each
// call returns only thinking appended since the previous one; a path change
// (new session) resets to the transcript start. Thinking is SCRUBBED (secrets +
// PII) before it is returned, since the active write path does not otherwise
// scrub and reasoning is the one field we always redact.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { redactPii, scrubSecrets } from "../lib/secrets.js";

interface ThinkingCursor {
	path: string;
	offset: number;
}

/** Narrow a parsed `thinking-cursor.json` value to a `ThinkingCursor`.
 *  Returns null when the value isn't a JSON object or either field is the
 *  wrong type — the caller falls back to a fresh cursor either way. */
function parseThinkingCursor(value: unknown): ThinkingCursor | null {
	if (!isJsonObject(value)) return null;
	const { path, offset } = value;
	if (typeof path !== "string" || typeof offset !== "number") return null;
	return { path, offset };
}

function readCursor(cursorPath: string): ThinkingCursor {
	try {
		const cursor = parseThinkingCursor(JSON.parse(readFileSync(cursorPath, "utf-8")));
		if (cursor) return cursor;
	} catch (e) {
		void e; // missing/corrupt cursor → start fresh
	}
	return { path: "", offset: 0 };
}

/** Narrow a transcript JSONL line to an assistant record's `message` object,
 *  or null when the line isn't a recognized `{type: "assistant", message}`
 *  record. Shared by the thinking-block extractor and the latest-model
 *  reader below — both need the same "is this an assistant line" gate. */
function parseAssistantMessage(value: unknown): JsonObject | null {
	if (!isJsonObject(value) || value.type !== "assistant") return null;
	const message = value.message;
	return isJsonObject(message) ? message : null;
}

/** Extract every non-empty `thinking` string from an assistant record's
 *  content blocks. Returns null when the line isn't a recognized assistant
 *  record, or an array (possibly empty) of the thinking strings found —
 *  non-object/non-thinking entries in `content` are skipped, not fatal. */
function parseAssistantThinkingBlocks(value: unknown): string[] | null {
	const message = parseAssistantMessage(value);
	if (!message) return null;
	const content = message.content;
	if (!Array.isArray(content)) return null;
	const blocks: string[] = [];
	for (const entry of content) {
		if (!isJsonObject(entry)) continue;
		if (entry.type === "thinking" && typeof entry.thinking === "string" && entry.thinking) {
			blocks.push(entry.thinking);
		}
	}
	return blocks;
}

/** Narrow an assistant record's `message.model` field to a string, or null
 *  when the line isn't a recognized assistant record or `model` isn't a
 *  string. */
function parseAssistantModel(value: unknown): string | null {
	const message = parseAssistantMessage(value);
	if (!message) return null;
	return typeof message.model === "string" ? message.model : null;
}

/**
 * Return the SCRUBBED reasoning recorded in `transcriptPath` since the last call
 * (tracked by the cursor at `cursorPath`), or null when there is no new thinking
 * (or the transcript is missing/unreadable). Advances the cursor to EOF. Never
 * throws — fail-open so a capture hiccup never breaks the daemon pipeline.
 */
export function extractNewThinking(transcriptPath: string, cursorPath: string): string | null {
	if (!transcriptPath || !existsSync(transcriptPath)) return null;
	try {
		const size = statSync(transcriptPath).size;
		let cursor = readCursor(cursorPath);
		// New session (or first run): re-read from the transcript start.
		if (cursor.path !== transcriptPath) cursor = { path: transcriptPath, offset: 0 };
		if (cursor.offset >= size) return null;

		const fd = openSync(transcriptPath, "r");
		const buf = Buffer.alloc(size - cursor.offset);
		readSync(fd, buf, 0, buf.length, cursor.offset);
		closeSync(fd);

		const parts: string[] = [];
		for (const line of buf.toString("utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const blocks = parseAssistantThinkingBlocks(JSON.parse(line));
				if (blocks) parts.push(...blocks);
			} catch (e) {
				void e; // a truncated final line is normal — skip it
			}
		}

		// Persist the cursor even when no thinking was found, so we don't re-scan.
		writeFileSync(cursorPath, JSON.stringify({ path: transcriptPath, offset: size }));
		if (parts.length === 0) return null;

		const combined = parts.join("\n---\n");
		return redactPii(scrubSecrets(combined).text).text;
	} catch (e) {
		void e;
		return null;
	}
}

/**
 * Resolve a session's Claude Code transcript path. Prefers the explicit
 * `transcript_path` the payload carries; otherwise derives it from the standard
 * layout `~/.claude/projects/<cwd-with-slashes-as-dashes>/<session>.jsonl`
 * (verified: Claude names the transcript by session id). Returns null when it
 * can't resolve to an existing file.
 */
export function resolveTranscriptPath(
	explicit: string | undefined,
	sessionId: string | undefined,
	cwd: string,
	homeDir: string,
): string | null {
	if (explicit && existsSync(explicit)) return explicit;
	if (!sessionId) return null;
	const slug = cwd.replace(/\//g, "-");
	const derived = `${homeDir}/.claude/projects/${slug}/${sessionId}.jsonl`;
	return existsSync(derived) ? derived : null;
}

/**
 * The model id of the most recent assistant turn in the transcript (reads the
 * tail only). Used to attribute a tool_use_start activity record to the model
 * that made the call. Returns null when unresolvable. Never throws.
 */
export function latestTranscriptModel(transcriptPath: string): string | null {
	if (!transcriptPath || !existsSync(transcriptPath)) return null;
	try {
		const size = statSync(transcriptPath).size;
		const start = Math.max(0, size - 256 * 1024);
		const fd = openSync(transcriptPath, "r");
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
		let model: string | null = null;
		for (const line of buf.toString("utf-8").split("\n")) {
			if (!line.includes('"model"')) continue;
			try {
				const parsedModel = parseAssistantModel(JSON.parse(line));
				if (parsedModel) model = parsedModel;
			} catch (e) {
				void e;
			}
		}
		return model;
	} catch (e) {
		void e;
		return null;
	}
}
