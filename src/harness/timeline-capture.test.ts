import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	boundKeySet,
	captureAgentTranscript,
	captureTimeline,
	MAX_SEEN_KEYS_PER_CWD,
} from "./timeline-capture.js";
import { timelinePath, writeTimeline } from "./timeline-writer.js";
import type { HarnessEvent } from "./types/events.js";

function assistantLine(uuid: string, ts: string, text: string): string {
	return `${JSON.stringify({
		type: "assistant",
		uuid,
		timestamp: ts,
		sessionId: "S",
		message: { model: "claude-test-5", content: [{ type: "text", text }] },
	})}\n`;
}

function stopEvent(cwd: string, transcriptPath: string): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "S",
		agent_source: "claude",
		timestamp: "2026-06-28T00:00:00.000Z",
		cwd,
		transcript_path: transcriptPath,
	};
}

function timelineTexts(cwd: string): string[] {
	if (!existsSync(timelinePath(cwd))) return [];
	const body = readFileSync(timelinePath(cwd), "utf-8").trim();
	if (!body) return [];
	return body.split("\n").map((l) => {
		const p: { text?: string } = JSON.parse(l);
		return p.text ?? "";
	});
}

describe("captureTimeline (live drain)", () => {
	let cwd: string;
	let transcript: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlc-"));
		transcript = join(cwd, "transcript.jsonl");
		writeFileSync(
			transcript,
			assistantLine("u1", "2026-06-28T10:00:00.000Z", "first message") +
				assistantLine("u2", "2026-06-28T10:00:01.000Z", "second message"),
		);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("captures assistant messages from the transcript on first drain", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	it("appends nothing on a second drain with no new transcript content (cursor at EOF)", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	it("captures only the NEW records on an incremental drain", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		appendFileSync(transcript, assistantLine("u3", "2026-06-28T10:00:02.000Z", "third message"));
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message", "third message"]);
	});

	it("dedups against a pre-existing timeline (backfill overlap)", () => {
		// Pre-seed the timeline as if a backfill already captured u1, then let the
		// live drain re-read the whole transcript (fresh cursor) — u1 must not dup.
		writeTimeline(
			[
				{
					schema: "timeline.v1",
					ts: "2026-06-28T10:00:00.000Z",
					session: "S",
					uuid: "u1",
					seq: 0,
					category: "agent_message",
					role: "assistant",
					text: "first message",
				},
			],
			cwd,
		);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		const texts = timelineTexts(cwd);
		expect(texts.filter((t) => t === "first message")).toHaveLength(1);
		expect(texts).toContain("second message");
	});

	it("is a no-op when the transcript can't be resolved", () => {
		const bare = mkdtempSync(join(tmpdir(), "tlc-bare-"));
		const event: HarnessEvent = {
			hook_event: "Stop",
			session_id: "no-such-session",
			agent_source: "claude",
			timestamp: "2026-06-28T00:00:00.000Z",
			cwd: bare,
		};
		captureTimeline(event, bare);
		expect(existsSync(timelinePath(bare))).toBe(false);
		rmSync(bare, { recursive: true, force: true });
	});
});

describe("captureAgentTranscript (one-shot subagent drain)", () => {
	let cwd: string;

	function agentLine(uuid: string, text: string, agentId: string): string {
		return `${JSON.stringify({
			type: "assistant",
			uuid,
			timestamp: "2026-07-09T10:00:00.000Z",
			sessionId: "S",
			agentId,
			message: { model: "claude-test-5", content: [{ type: "text", text }] },
		})}\n`;
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlc-agent-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("drains an agent transcript with agent_id attribution, without touching the main cursor", () => {
		const agentTranscript = join(cwd, "agent-z9.jsonl");
		writeFileSync(agentTranscript, agentLine("az1", "agent result", "z9"));
		const drained = captureAgentTranscript(agentTranscript, cwd);
		expect(drained).toBe(1);
		expect(existsSync(join(cwd, ".interlinked", "timeline-cursor.json"))).toBe(false);
		const rows = readFileSync(timelinePath(cwd), "utf-8")
			.trim()
			.split("\n")
			// SAFETY: our own timeline JSONL, written one line above.
			.map((l) => JSON.parse(l) as { text?: string; agent_id?: string });
		expect(rows).toEqual([expect.objectContaining({ text: "agent result", agent_id: "z9" })]);
	});

	it("is idempotent — a second drain appends nothing", () => {
		const agentTranscript = join(cwd, "agent-z9.jsonl");
		writeFileSync(agentTranscript, agentLine("az1", "agent result", "z9"));
		expect(captureAgentTranscript(agentTranscript, cwd)).toBe(1);
		expect(captureAgentTranscript(agentTranscript, cwd)).toBe(0);
		expect(timelineTexts(cwd)).toEqual(["agent result"]);
	});

	it("returns 0 for a missing or undefined path", () => {
		expect(captureAgentTranscript(undefined, cwd)).toBe(0);
		expect(captureAgentTranscript(join(cwd, "nope.jsonl"), cwd)).toBe(0);
		expect(existsSync(timelinePath(cwd))).toBe(false);
	});
});

describe("boundKeySet (daemon dedup memory bound)", () => {
	it("evicts the oldest keys to hold the set at the cap, retaining the most recent", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(`k${i}`);
		boundKeySet(set, 50);
		expect(set.size).toBe(50);
		expect(set.has("k99")).toBe(true); // newest retained
		expect(set.has("k50")).toBe(true); // boundary retained
		expect(set.has("k49")).toBe(false); // oldest evicted
		expect(set.has("k0")).toBe(false);
	});

	it("is a no-op when the set is at or under the cap", () => {
		const set = new Set(["a", "b", "c"]);
		boundKeySet(set, 10);
		expect([...set]).toEqual(["a", "b", "c"]);
	});

	it("ships a positive default bound", () => {
		expect(MAX_SEEN_KEYS_PER_CWD).toBeGreaterThan(0);
	});
});
