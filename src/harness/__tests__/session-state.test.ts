import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractNonTrivialLiterals, SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";

/** sha256 helper used to assert content_hash and literal_hash equality. */
function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** Minimal PreToolUse event — enough for recordEvent to mint a trajectory.
 *  The timestamp is a fixed literal: this suite asserts on signal merges,
 *  not on time, so a deterministic value keeps the tests flake-free. */
function evt(sessionId: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: sessionId,
		agent_source: "claude",
		timestamp: "2026-05-17T00:00:00.000Z",
	};
}

describe("SessionTracker.rollUpVerificationSignals", () => {
	it("merges the child's verification_observed into the parent (set union)", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.verification_observed = new Set(["test", "lint"]);
		parent.verification_observed = new Set(["typecheck"]);

		expect(t.rollUpVerificationSignals("child", "parent")).toBe(true);
		expect([...(t.get("parent")?.verification_observed ?? [])].sort()).toEqual([
			"lint",
			"test",
			"typecheck",
		]);
	});

	it("gap-fills test_runs without clobbering the parent's own entry", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		const parent = t.recordEvent(evt("parent"));
		child.test_runs.set("a.test.ts", { status: "pass", at_step: 1 });
		child.test_runs.set("shared.test.ts", { status: "fail", at_step: 2 });
		// The parent already has its own (newer, authoritative) result for the
		// shared file — the roll-up must not overwrite it.
		parent.test_runs.set("shared.test.ts", { status: "pass", at_step: 9 });

		t.rollUpVerificationSignals("child", "parent");
		const runs = t.get("parent")?.test_runs;
		expect(runs?.get("a.test.ts")?.status).toBe("pass");
		expect(runs?.get("shared.test.ts")?.status).toBe("pass");
	});

	it("merges stubs_introduced from the child", () => {
		const t = new SessionTracker();
		const child = t.recordEvent(evt("child"));
		t.recordEvent(evt("parent"));
		child.stubs_introduced = [{ file: "x.ts", kind: "TODO", snippet: "// TODO" }];

		t.rollUpVerificationSignals("child", "parent");
		expect(t.get("parent")?.stubs_introduced).toHaveLength(1);
	});

	it("returns false when from and to are the same session", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("solo"));
		expect(t.rollUpVerificationSignals("solo", "solo")).toBe(false);
	});

	it("returns false when either session is missing", () => {
		const t = new SessionTracker();
		t.recordEvent(evt("only"));
		expect(t.rollUpVerificationSignals("only", "ghost")).toBe(false);
		expect(t.rollUpVerificationSignals("ghost", "only")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Sequence-detector input population.
//
// `recent_line_edits` and `literal_occurrences` were added as fields on
// SessionTrajectory for the §3.21 add-then-revert and §3.18 magic-literal
// cross-file detectors. These tests pin the recordEvent population so the
// detectors don't silently no-op in production.
// ─────────────────────────────────────────────────────────────────────────

/** Build a PostToolUse Edit event with the given content. Defaults to a
 *  successful outcome (`tool_outcome === undefined` is treated as success
 *  by the writeSucceeded predicate). */
function editEvt(opts: {
	sessionId?: string;
	tool?: string;
	filePath?: string;
	newString?: string;
	content?: string;
	edits?: ReadonlyArray<{ new_string: string }>;
	tool_outcome?: "success" | "error" | "interrupted";
}): HarnessEvent {
	const ev: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: opts.sessionId ?? "s",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		tool_name: opts.tool ?? "Edit",
		tool_input: {
			file_path: opts.filePath ?? "src/foo.ts",
		},
	};
	if (opts.newString !== undefined && ev.tool_input) ev.tool_input.new_string = opts.newString;
	if (opts.content !== undefined && ev.tool_input) ev.tool_input.content = opts.content;
	if (opts.edits !== undefined && ev.tool_input) ev.tool_input.edits = [...opts.edits];
	if (opts.tool_outcome !== undefined) ev.tool_outcome = opts.tool_outcome;
	return ev;
}

describe("SessionTracker.recordEvent — recent_line_edits population", () => {
	it("creates one ring-buffer entry after one successful Edit", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(1);
		expect(entries?.[0]?.content_hash).toBe(sha256("const x = 1;"));
	});

	it("appends a second entry on a second Edit to the same file", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "first" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "second" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(2);
		expect(entries?.[1]?.content_hash).toBe(sha256("second"));
	});

	it("emits identical content_hash on identical re-edits (so detectors can match)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "same" }));
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "other" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "same" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.[0]?.content_hash).toBe(entries?.[2]?.content_hash);
	});

	it("caps the ring buffer at 20 entries per file (drops oldest)", () => {
		const t = new SessionTracker();
		let session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "x0" }));
		for (let i = 1; i < 25; i++) {
			session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: `x${i}` }));
		}
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(20);
		// First entry should now be x5 (we wrote x0..x24, kept last 20 → x5..x24).
		expect(entries?.[0]?.content_hash).toBe(sha256("x5"));
		expect(entries?.[19]?.content_hash).toBe(sha256("x24"));
	});

	it("does not record an entry when tool_outcome === 'error'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "won't land",
				tool_outcome: "error",
			}),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("does not record an entry when tool_outcome === 'interrupted'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "halted",
				tool_outcome: "interrupted",
			}),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("records each MultiEdit edit as a separate ring-buffer entry", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				tool: "MultiEdit",
				filePath: "src/a.ts",
				edits: [{ new_string: "a" }, { new_string: "b" }, { new_string: "c" }],
			}),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(3);
	});

	it("records Write events via their `content` field", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ tool: "Write", filePath: "src/new.ts", content: "fresh module" }),
		);
		const entries = session.recent_line_edits?.get("src/new.ts");
		expect(entries?.[0]?.content_hash).toBe(sha256("fresh module"));
	});

	it("`range.end` reflects the chunk's line count (spec simplification)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "line1\nline2\nline3" }),
		);
		const entry = session.recent_line_edits?.get("src/a.ts")?.[0];
		expect(entry?.range).toEqual({ start: 0, end: 3 });
	});

	// --- FALSE-POSITIVE regression: blocked / intended PreToolUse edits ---
	// The §3.21 add-then-revert detector reasons about content states the file
	// ACTUALLY reached. A PreToolUse Edit event is an intended edit that may be
	// blocked (tsc overlay / reservation / guard) and never land. Recording it
	// counted a phantom prior state and fired "cycled back N times" on clean
	// forward progress. Population is now PostToolUse-only.

	/** Build a PreToolUse Edit event (the proposed edit, before it runs). In
	 *  production `tool_outcome` is undefined here — the tool has not executed. */
	function preEditEvt(opts: {
		sessionId?: string;
		filePath?: string;
		newString?: string;
	}): HarnessEvent {
		return {
			hook_event: "PreToolUse",
			session_id: opts.sessionId ?? "s",
			agent_source: "claude",
			timestamp: "2026-05-27T00:00:00.000Z",
			tool_name: "Edit",
			tool_input: {
				file_path: opts.filePath ?? "src/foo.ts",
				new_string: opts.newString ?? "x",
			},
		};
	}

	it("does NOT record a PreToolUse Edit (intended edit, may be blocked, hasn't landed)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			preEditEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")).toBeUndefined();
	});

	it("records a successful edit exactly once (no Pre+Post double-count)", () => {
		const t = new SessionTracker();
		// Real shape of one successful edit: a PreToolUse then a PostToolUse,
		// both carrying the same new_string. Only the Post should be recorded.
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const x = 1;" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = 1;" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")?.length).toBe(1);
	});

	it("blocked-then-retry produces NO revert history (the observed FP)", () => {
		const t = new SessionTracker();
		// Agent proposes content C (PreToolUse) — blocked by the overlay, so NO
		// PostToolUse success fires. Retries C (PreToolUse) — blocked again.
		// Finally C lands (PostToolUse success). The file only ever held one
		// state, so the history must be a single entry — zero oscillation.
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }));
		t.recordEvent(preEditEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }));
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const fixed = compute();" }),
		);
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(1);
	});

	it("drops a no-op re-apply of identical content (same hash as last entry)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "same body" }));
		// A second successful PostToolUse with the EXACT same content is a no-op
		// re-apply — not a state transition. The ring buffer stays at one entry.
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "same body" }),
		);
		expect(session.recent_line_edits?.get("src/a.ts")?.length).toBe(1);
	});

	it("STILL records a genuine A→B→A oscillation across successful edits (true positive)", () => {
		const t = new SessionTracker();
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "A" }));
		t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "B" }));
		const session = t.recordEvent(editEvt({ filePath: "src/a.ts", newString: "A" }));
		const entries = session.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(3);
		expect(entries?.[0]?.content_hash).toBe(entries?.[2]?.content_hash);
	});
});

describe("SessionTracker.recordEvent — literal_occurrences population", () => {
	it("introducing the same string literal in two files yields a Set of size 2", () => {
		const t = new SessionTracker();
		t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: 'const SECRET_KEY_PATH = "/etc/secret-keys/app";',
			}),
		);
		const session = t.recordEvent(
			editEvt({
				filePath: "src/b.ts",
				newString: 'const KEY = "/etc/secret-keys/app";',
			}),
		);
		const hash = sha256("/etc/secret-keys/app");
		expect(session.literal_occurrences?.get(hash)?.size).toBe(2);
		expect(session.literal_occurrences?.get(hash)?.has("src/a.ts")).toBe(true);
		expect(session.literal_occurrences?.get(hash)?.has("src/b.ts")).toBe(true);
	});

	it("includes a non-trivial integer literal (≥3 digits, outside HTTP-status / -1..256)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const PORT_HIGH = 65535;" }),
		);
		const hash = sha256("65535");
		expect(session.literal_occurrences?.get(hash)?.has("src/a.ts")).toBe(true);
	});

	it("ignores numbers in the -1..256 boring range (255, 100 still possible via HTTP)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const MAX = 256;" }),
		);
		const hash = sha256("256");
		expect(session.literal_occurrences?.get(hash)).toBeUndefined();
	});

	it("ignores HTTP status codes (200, 404, 500)", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: "if (res.status === 200) return; if (res.status === 404) throw;",
			}),
		);
		expect(session.literal_occurrences?.get(sha256("200"))).toBeUndefined();
		expect(session.literal_occurrences?.get(sha256("404"))).toBeUndefined();
	});

	it("does not pollute the map when the chunk contains no qualifying literals", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: "const x = a + b" }),
		);
		// No string literal ≥8 chars, no number ≥3 digits outside boring range.
		expect(session.literal_occurrences?.size ?? 0).toBe(0);
	});

	it("does not record literals when tool_outcome === 'error'", () => {
		const t = new SessionTracker();
		const session = t.recordEvent(
			editEvt({
				filePath: "src/a.ts",
				newString: 'const LONG_LITERAL = "this_is_a_long_string";',
				tool_outcome: "error",
			}),
		);
		expect(session.literal_occurrences?.size ?? 0).toBe(0);
	});

	it("caps literal extraction per edit at 50 entries", () => {
		const t = new SessionTracker();
		// Build a chunk with 80 unique non-trivial number literals (each
		// 4-digit, outside HTTP-status and boring ranges).
		const parts: string[] = [];
		for (let i = 0; i < 80; i++) parts.push(`const N${i} = ${1000 + i};`);
		const session = t.recordEvent(
			editEvt({ filePath: "src/a.ts", newString: parts.join("\n") }),
		);
		expect(session.literal_occurrences?.size).toBe(50);
	});
});

describe("extractNonTrivialLiterals — unit tests for the literal scanner", () => {
	it("returns string literals ≥8 chars", () => {
		expect(extractNonTrivialLiterals('const x = "abcdefghij";')).toContain("abcdefghij");
	});

	it("skips short string literals (<8 chars)", () => {
		expect(extractNonTrivialLiterals('const x = "abc";')).not.toContain("abc");
	});

	it("returns numbers ≥3 digits outside boring and HTTP-status ranges", () => {
		expect(extractNonTrivialLiterals("const x = 12345;")).toContain("12345");
	});

	it("skips HTTP status codes (200/404/500)", () => {
		expect(extractNonTrivialLiterals("status === 200")).not.toContain("200");
		expect(extractNonTrivialLiterals("status === 404")).not.toContain("404");
	});

	it("skips boring numbers (≤256)", () => {
		expect(extractNonTrivialLiterals("const x = 256;")).not.toContain("256");
	});
});
