// interlinked-ignore: test_missing_sut_import — detector strips only a trailing .test.ts/.spec.ts suffix and does not recognize the .mutation-kill. infix; this file's static, same-directory import of ./plan-capture.js below IS the real SUT.
import { mkdtempSync, rmSync } from "node:fs";
// ===========================================
// plan-capture — mutation-kill companion (PASS-1, W10)
// ===========================================
//
// Targets the 94 surviving mutants reported by
// `mutation survivors --file src/harness/plan-capture.ts`. Every regex
// boundary case below was verified against pristine source with a scratch
// probe (scratch/verify-plan-capture-*.mts) before being written here, so
// the exact expected values are measured, not hand-derived.
//
// LEAN MODE: no mutant modules are built here; this file only asserts
// precise observable behavior of the pristine SUT. See
// scratch/fleet-r3/receipts/src_harness_plan-capture.ts.jsonl for the
// per-mutant disposition (killed_by_test / equivalent_candidate).

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractHints,
	extractPlanSection,
	maybeCaptureFromPreToolUse,
	maybeCaptureFromUserPromptSubmit,
	parseExitPlanMode,
	parseMarkdownBullets,
	parseTaskCreate,
} from "./plan-capture.js";
import { SessionTracker } from "./session-state.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

const TIMESTAMP = "2026-04-23T00:00:00.000Z";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-plan-mkill-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const tracker = new SessionTracker();
	return tracker.recordEvent({
		hook_event: "SessionStart",
		session_id: overrides.session_id ?? "sess-1",
		agent_source: "claude",
		agent_name: overrides.agent_name ?? "agent-claude",
		timestamp: TIMESTAMP,
	});
}

function preEvent(partial: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		agent_name: "agent-claude",
		timestamp: TIMESTAMP,
		...partial,
	};
}

describe("extractHints — read pattern (anchoring + spacing)", () => {
	// test-contract: public-api — extractHints only recognizes an imperative at the START of the intent; "read" appearing later is prose, not a hint.
	it("does not match 'read' embedded mid-string (anchored, not searched)", () => {
		expect(extractHints("Please read src/foo.ts")).toEqual({});
	});

	// test-contract: public-api — the mandatory space after 'read' is a greedy `\s+`, so extra whitespace must still resolve to the same hint, not silently fail to reach the path.
	it("tolerates more than one space after 'read' (greedy quantifier)", () => {
		expect(extractHints("Read  src/foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "src/foo.ts",
		});
	});

	// test-contract: public-api — "Read the file X" is a documented alias for "Read X" per the module's own header comment examples.
	it("tolerates the optional 'the file' phrase with standard single spacing", () => {
		expect(extractHints("Read the file src/foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "src/foo.ts",
		});
	});

	// test-contract: public-api — the 'the'-to-'file' gap inside the optional phrase is also a greedy `\s+`; extra whitespace there must not drop the whole optional phrase.
	it("tolerates more than one space between 'the' and 'file'", () => {
		expect(extractHints("Read the  file src/foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "src/foo.ts",
		});
	});

	// test-contract: public-api — mirrors the previous case for the trailing side of the optional phrase.
	it("tolerates more than one space between 'file' and the path", () => {
		expect(extractHints("Read the file  src/foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "src/foo.ts",
		});
	});
});

describe("extractHints — open|inspect pattern (anchoring + spacing + path shape)", () => {
	// test-contract: public-api — same anchoring contract as the read pattern.
	it("does not match 'open' embedded mid-string", () => {
		expect(extractHints("Please open the file foo.ts")).toEqual({});
	});

	// test-contract: public-api — the mandatory space after 'open'/'inspect' is a greedy `\s+`, so extra whitespace must still resolve to the same hint.
	it("tolerates more than one space after 'open'/'inspect'", () => {
		expect(extractHints("open  foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — pins the optional "the file" phrase as optional, the basename requiring 1+ non-space chars, the literal dot separator, and the extension requiring 1+ alnum chars all at once via the exact returned target_hint.
	it("recognizes a bare 'open <path>' and captures the full basename.ext", () => {
		expect(extractHints("open foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — the 'the'-to-'file' gap (open variant) is also a greedy `\s+`; extra whitespace there must not drop the phrase.
	it("tolerates more than one space between 'the' and 'file' (open variant)", () => {
		expect(extractHints("open the  file foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — pins both the leading and trailing mandatory single space inside "the file" at once.
	it("tolerates the optional 'the file' phrase with standard spacing (open variant)", () => {
		expect(extractHints("open the file foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — mirrors the previous case for the trailing side of the optional phrase (open variant).
	it("tolerates more than one space between 'file' and the path (open variant)", () => {
		expect(extractHints("open the file  foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "foo.ts",
		});
	});
});

describe("extractHints — edit pattern (anchoring + spacing)", () => {
	// test-contract: public-api — same anchoring contract as the read pattern.
	it("does not match 'edit' embedded mid-string", () => {
		expect(extractHints("Please edit src/foo.ts")).toEqual({});
	});

	// test-contract: public-api — the mandatory space after the edit-family keyword is a greedy `\s+`, so extra whitespace must still resolve to the same hint.
	it("tolerates more than one space after the edit-family keyword", () => {
		expect(extractHints("Edit  src/foo.ts")).toEqual({
			tool_hint: "Edit",
			target_hint: "src/foo.ts",
		});
	});
});

describe("extractHints — write pattern (anchoring + all three optional-phrase alternatives)", () => {
	// test-contract: public-api — same anchoring contract as the read pattern.
	it("does not match 'write' embedded mid-string", () => {
		expect(extractHints("Please write foo.ts")).toEqual({});
	});

	// test-contract: public-api — the mandatory space after 'write'/'create' is a greedy `\s+`, so extra whitespace must still resolve to the same hint.
	it("tolerates more than one space after 'write'/'create'", () => {
		expect(extractHints("write  foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — the 'new'-to-'file' gap inside the "a new file" alternative is also a greedy `\s+`; extra whitespace there must not drop the alternative.
	it("'a new file' alternative: tolerates more than one space between 'new' and 'file'", () => {
		expect(extractHints("write a new  file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — pins both mandatory single spaces inside "a new file" at once.
	it("'a new file' alternative: standard spacing resolves the target", () => {
		expect(extractHints("write a new file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — mirrors the previous case for the trailing side of the "a new file" alternative.
	it("'a new file' alternative: tolerates more than one space between 'file' and the path", () => {
		expect(extractHints("write a new file  foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — the 'the'-to-'file' gap inside the "the file" alternative is also a greedy `\s+`; extra whitespace there must not drop the alternative.
	it("'the file' alternative: tolerates more than one space between 'the' and 'file'", () => {
		expect(extractHints("write the  file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — pins both mandatory single spaces inside "the file" at once.
	it("'the file' alternative: standard spacing resolves the target", () => {
		expect(extractHints("write the file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — mirrors the previous case for the trailing side of the "the file" alternative.
	it("'the file' alternative: tolerates more than one space between 'file' and the path", () => {
		expect(extractHints("write the file  foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — the 'new'-to-'file' gap inside the bare "new file" alternative is also a greedy `\s+`; extra whitespace there must not drop the alternative.
	it("'new file' alternative: tolerates more than one space between 'new' and 'file'", () => {
		expect(extractHints("write new  file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — pins both mandatory single spaces inside the bare "new file" alternative at once.
	it("'new file' alternative: standard spacing resolves the target", () => {
		expect(extractHints("write new file foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});

	// test-contract: public-api — mirrors the previous case for the trailing side of the bare "new file" alternative.
	it("'new file' alternative: tolerates more than one space between 'file' and the path", () => {
		expect(extractHints("write new file  foo.ts")).toEqual({
			tool_hint: "Write",
			target_hint: "foo.ts",
		});
	});
});

describe("extractHints — grep|search pattern (anchoring + keyword spacing)", () => {
	// test-contract: public-api — same anchoring contract as the read pattern.
	it("does not match 'grep' embedded mid-string", () => {
		expect(extractHints("Please grep for foo")).toEqual({});
	});

	// test-contract: public-api — also pins that the optional "for" phrase is genuinely optional and that "Grep" (not "") is the returned hint.
	it("requires whitespace (not a bare non-space run) after 'grep'/'search'", () => {
		expect(extractHints("grep foo")).toEqual({ tool_hint: "Grep" });
	});
});

describe("extractHints — list|find pattern (anchoring + mandatory 'files' spacing)", () => {
	// test-contract: public-api — same anchoring contract as the read pattern.
	it("does not match 'list' embedded mid-string", () => {
		expect(extractHints("Please list files")).toEqual({});
	});

	// test-contract: public-api — the gap before the mandatory 'files' word is a greedy `\s+`, so extra whitespace there must still resolve to the Glob hint.
	it("tolerates more than one space between 'list'/'find' and the mandatory 'files' word", () => {
		expect(extractHints("list  files")).toEqual({ tool_hint: "Glob" });
	});

	// test-contract: public-api — pins that a matching "list files" returns the Glob hint, not an empty result.
	it("recognizes standard 'list files' and returns Glob (not an empty hint)", () => {
		expect(extractHints("list files")).toEqual({ tool_hint: "Glob" });
	});
});

describe("extractHints — run|execute|invoke pattern (anchoring)", () => {
	// test-contract: public-api — "you run this" must not be read as an imperative just because "run" appears somewhere in the sentence.
	it("does not match 'run' embedded mid-sentence", () => {
		expect(extractHints("Investigate before you run this")).toEqual({});
	});
});

describe("extractHints — leading-whitespace normalization", () => {
	// test-contract: public-api — every TOOL_HINT_PATTERNS entry is ^-anchored with no leading-whitespace tolerance of its own, so the function-level trim is what makes indented bullet text still hint.
	it("trims the intent before matching so a leading-indented bullet still resolves", () => {
		expect(extractHints("  Read src/foo.ts")).toEqual({
			tool_hint: "Read",
			target_hint: "src/foo.ts",
		});
	});
});

describe("extractPlanSection — heading detection", () => {
	// test-contract: public-api — HEADING_RE must anchor at line start; prose that merely contains a hash sequence is not a heading and must not prematurely end the captured section.
	it("does not treat a mid-line '##' as a section-closing heading", () => {
		expect(extractPlanSection("## Plan\nprose ## not a heading\n- step a\n")).toBe(
			"prose ## not a heading\n- step a\n",
		);
	});

	// test-contract: public-api — an indented '## ...' line still counts as a heading and must close an already-open Plan section.
	it("recognizes an indented heading (leading whitespace tolerated before '#')", () => {
		expect(extractPlanSection("## Plan\n  ## indented (should close)\n- unreached\n")).toBe("");
	});

	// test-contract: public-api — "## Plan " (trailing space) must still be recognized as the Plan heading, not silently rejected.
	it("trims trailing whitespace off the heading text before the 'plan' comparison", () => {
		expect(extractPlanSection("## Plan \n- step a\n")).toBe("- step a\n");
	});

	// test-contract: public-api — multi-line sections must stay line-delimited; concatenating them would corrupt bullet parsing downstream.
	it("joins collected lines with a real newline, not an empty separator", () => {
		expect(extractPlanSection("## Plan\n- step a\n- step b\n")).toBe("- step a\n- step b\n");
	});
});

describe("parseMarkdownBullets — BULLET_RE boundary cases", () => {
	// test-contract: public-api — a bullet-shaped line containing an embedded standalone CR (never split into its own line, since split() only breaks on \r?\n) must fail the marker match entirely rather than truncate at the CR.
	it("does not treat a mid-line dash as a bullet marker (requires reaching end-of-line)", () => {
		const steps = parseMarkdownBullets("- abc\rdef\n- next\n");
		expect(steps.map((s) => s.intent)).toEqual(["next"]);
	});

	// test-contract: public-api — BULLET_RE must anchor at line start (after optional leading whitespace), not search anywhere in the line.
	it("does not treat a dash appearing later in a prose line as a bullet start", () => {
		expect(parseMarkdownBullets("prose - embedded dash\n").map((s) => s.intent)).toEqual([]);
	});

	// test-contract: public-api — leading whitespace before the marker must be tolerated (indented bullets are a documented shape).
	it("recognizes an indented bullet (leading whitespace tolerated before the marker)", () => {
		expect(parseMarkdownBullets("  - indented item\n").map((s) => s.intent)).toEqual(["indented item"]);
	});

	// test-contract: public-api — the ordinal marker must accept multi-digit numbers, not just a single digit.
	it("recognizes a multi-digit ordinal marker ('12.', not just a single digit)", () => {
		expect(parseMarkdownBullets("12. multi-digit ordinal\n").map((s) => s.intent)).toEqual([
			"multi-digit ordinal",
		]);
	});
});

describe("parseMarkdownBullets — blank-line and heading flush", () => {
	// test-contract: public-api — a line of pure spaces is blank by `.trim() === ""`; a dangling continuation after it must NOT merge into the already-flushed bullet.
	it("treats a whitespace-only (non-empty) line as blank, closing the current bullet", () => {
		expect(
			parseMarkdownBullets("- first bullet\n   \nmore text after blank\n").map((s) => s.intent),
		).toEqual(["first bullet"]);
	});

	// test-contract: public-api — this is the module's documented "ignores prose lines before the first bullet" contract applied after a bullet has already closed: once flushed, currentIntent is null and a stray prose line must be discarded rather than silently absorbed.
	it("flushes the current bullet on a blank line so trailing prose is dropped, not merged", () => {
		expect(
			parseMarkdownBullets("- first bullet\n\nmore text after blank\n").map((s) => s.intent),
		).toEqual(["first bullet"]);
	});
});

describe("parseMarkdownBullets — continuation-line whitespace handling", () => {
	// test-contract: public-api — indented continuation lines are the documented shape ("- first line\n  continued text\n"); each one's own leading indentation must not accumulate into the joined intent.
	it("collapses each indented continuation line's own leading whitespace to a single joining space", () => {
		expect(parseMarkdownBullets("- foo\n  bar\n  baz\n").map((s) => s.intent)).toEqual(["foo bar baz"]);
	});
});

describe("parseMarkdownBullets.flush — trim, truncation, and step shape", () => {
	// test-contract: invariant — flush() is documented to trim the accumulated intent before it becomes a PlanStep; a bullet with trailing spaces and no continuation line is the case that most directly exercises that trim (no append-time trim intervenes).
	it("trims trailing whitespace off a single-line bullet with no continuation", () => {
		expect(parseMarkdownBullets("- foo   \n").map((s) => s.intent)).toEqual(["foo"]);
	});

	// test-contract: invariant — the module's own header comment documents the cap: "Cap on per-step intent text... trimmed here."
	it("truncates an oversized intent to MAX_INTENT_CHARS (4000)", () => {
		const steps = parseMarkdownBullets(`- ${"a".repeat(5000)}\n`);
		expect(steps[0]?.intent.length).toBe(4000);
	});

	// test-contract: invariant — PlanStep.status starts life as "pending" for every freshly parsed step.
	it("sets status to the literal string 'pending', never empty", () => {
		const step = parseMarkdownBullets("- alpha\n")[0];
		expect(step?.status).toBe("pending");
	});

	// test-contract: invariant — the module documents "Anything unclear leaves both hints undefined; we never guess" — implemented by never assigning the key, observable via key presence (Object.hasOwn / JSON.stringify), not just value.
	it("omits the tool_hint key entirely when no pattern matched (not present-but-undefined)", () => {
		const step = parseMarkdownBullets("- alpha\n")[0]!;
		expect(Object.hasOwn(step, "tool_hint")).toBe(false);
	});

	// test-contract: invariant — mirrors the tool_hint case above for the paired optional field.
	it("omits the target_hint key entirely when no pattern matched", () => {
		const step = parseMarkdownBullets("- alpha\n")[0]!;
		expect(Object.hasOwn(step, "target_hint")).toBe(false);
	});
});

describe("parseExitPlanMode / parseTaskCreate — malformed tool_input safety", () => {
	// test-contract: boundary — the optional-chaining read of event.tool_input?.plan must fail closed (null) rather than throw when a runner omits tool_input altogether.
	it("parseExitPlanMode does not throw when tool_input is entirely absent", () => {
		const session = makeSession();
		expect(parseExitPlanMode(preEvent({ tool_name: "ExitPlanMode" }), session)).toBeNull();
	});

	// test-contract: boundary — mirrors the ExitPlanMode case for the TaskCreate parser's own optional-chaining read.
	it("parseTaskCreate does not throw when tool_input is entirely absent", () => {
		const session = makeSession();
		expect(parseTaskCreate(preEvent({ tool_name: "TaskCreate" }), session)).toBeNull();
	});

	// test-contract: boundary — a task array entry that is not a plain object (e.g. a function value smuggled through untrusted tool_input) must be rejected by the typeof guard regardless of what properties happen to be attached to it.
	it("parseTaskCreate excludes non-object task entries even when they carry a .content property", () => {
		const fakeTask = (): void => {};
		Object.assign(fakeTask, { content: "fn content" });
		const session = makeSession();
		const plan = parseTaskCreate(
			preEvent({ tool_name: "TaskCreate", tool_input: { tasks: [fakeTask] } }),
			session,
		);
		expect(plan).toBeNull();
	});

	// test-contract: invariant — same 4000-char cap as the markdown-bullet path, enforced independently in parseTaskCreate's own loop body.
	it("parseTaskCreate truncates an oversized task content to MAX_INTENT_CHARS", () => {
		const session = makeSession();
		const plan = parseTaskCreate(
			preEvent({
				tool_name: "TaskCreate",
				tool_input: { tasks: [{ content: "a".repeat(5000), activeForm: "" }] },
			}),
			session,
		);
		expect(plan?.steps[0]?.intent.length).toBe(4000);
	});
});

describe("maybeCaptureFromPreToolUse — tool-name dispatch", () => {
	// test-contract: public-api — the module's own header documents this as a no-op for any tool other than TaskCreate/ExitPlanMode; a tool_input that HAPPENS to carry a valid `.plan` markdown string must not leak through if tool_name doesn't say ExitPlanMode.
	it("does not attempt ExitPlanMode parsing for an unrelated tool, even with a plan-shaped payload", () => {
		const session = makeSession();
		return maybeCaptureFromPreToolUse({
			event: preEvent({ tool_name: "SomeOtherTool", tool_input: { plan: "- do a thing\n" } }),
			session,
			cwd: tmp,
			enabled: true,
		}).then((captured) => {
			expect(captured).toBeNull();
		});
	});
});

describe("maybeCaptureFromUserPromptSubmit — prompt-body resolution", () => {
	// test-contract: public-api — the resolution order documented at the top of the module is event.prompt, then tool_input.user_prompt, then tool_input.prompt; an empty (not absent) event.prompt must not be treated as "found" and short-circuit the fallback chain.
	it("falls back to tool_input.user_prompt when event.prompt is present but empty", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				prompt: "",
				tool_input: { user_prompt: "## Plan\n- do thing\n" },
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured?.source).toBe("structured_userprompt");
		expect(captured?.steps).toEqual([{ intent: "do thing", status: "pending" }]);
	});

	// test-contract: boundary — a malformed/untrusted tool_input.prompt of the wrong runtime type must be rejected by the typeof guard, not passed through to the markdown parser (which expects a string).
	it("does not use tool_input.prompt when it is present but not a string", async () => {
		const session = makeSession();
		const captured = await maybeCaptureFromUserPromptSubmit({
			event: {
				hook_event: "UserPromptSubmit",
				session_id: "sess-1",
				agent_source: "claude",
				timestamp: TIMESTAMP,
				tool_input: { prompt: 42 },
			},
			session,
			cwd: tmp,
			enabled: true,
			parseUserPrompt: true,
		});
		expect(captured).toBeNull();
	});
});

describe("buildPlan — agent_name precedence (via parseExitPlanMode)", () => {
	// test-contract: invariant — CapturedPlan.agent_name is documented as the resolved agent name; when the triggering event carries its own (truthy) agent_name it must win over the session's, not the reverse.
	it("prefers the event's own agent_name over the session's when both are present", () => {
		const session = makeSession({ agent_name: "session-level-agent" });
		const plan = parseExitPlanMode(
			preEvent({ tool_name: "ExitPlanMode", agent_name: "event-level-agent", tool_input: { plan: "- do it\n" } }),
			session,
		);
		expect(plan?.agent_name).toBe("event-level-agent");
	});
});
