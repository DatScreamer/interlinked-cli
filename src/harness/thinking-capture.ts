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
import { redactPii, scrubSecrets } from "../lib/secrets.js";

interface ThinkingCursor {
	path: string;
	offset: number;
}

function readCursor(cursorPath: string): ThinkingCursor {
	try {
		const c = JSON.parse(readFileSync(cursorPath, "utf-8")) as ThinkingCursor;
		if (typeof c.path === "string" && typeof c.offset === "number") return c;
	} catch (e) {
		void e; // missing/corrupt cursor → start fresh
	}
	return { path: "", offset: 0 };
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
				const obj = JSON.parse(line) as {
					type?: string;
					message?: { content?: Array<{ type?: string; thinking?: string }> };
				};
				if (obj.type === "assistant") {
					for (const block of obj.message?.content ?? []) {
						if (block?.type === "thinking" && block.thinking) parts.push(block.thinking);
					}
				}
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
				const o = JSON.parse(line) as { type?: string; message?: { model?: string } };
				if (o.type === "assistant" && o.message?.model) model = o.message.model;
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
