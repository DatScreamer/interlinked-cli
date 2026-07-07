import { describe, expect, it } from "vitest";
import {
	OBLIGATION_RULES,
	oblConflictMarkerPersisted,
	oblNetOpenAtStop,
} from "./rules-obligations.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryRule, Verdict } from "./types.js";

let counter = 0;
function ev(hook: string, tool: string, input: ToolEvent["input"], toolUseId?: string): ToolEvent {
	counter += 1;
	return {
		ts: `2026-07-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
		session: "s1",
		agent: "claude",
		tool,
		toolUseId: toolUseId ?? `u${counter}`,
		hook,
		input,
		toolOutcome: "success",
	};
}

const MARKER_BODY = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch";

/** Fold every event into a fresh state, then run `rule` against the last event. */
function run(rule: TrajectoryRule, events: ToolEvent[]): Verdict | null {
	const state = createState("s1");
	for (const e of events) applyEvent(state, e);
	const last = events[events.length - 1];
	if (!last) throw new Error("run() needs at least one event");
	return rule(state, last);
}

describe("obl_conflict_marker_persisted adapter (positive: fires)", () => {
	it("fires when a PostToolUse Edit leaves conflict markers in the file", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: MARKER_BODY }),
		]);
		expect(v?.ruleId).toBe("obl_conflict_marker_persisted");
		expect(v?.action).toBe("nudge");
		expect(v?.severity).toBe("high");
		// The inner [interlinked:obligation] tag is stripped (the shadow formatter re-tags).
		expect(v?.reason).not.toContain("[interlinked:obligation]");
	});

	it("fires on a Write whose content carries a bare ======= separator run", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Write", { file_path: "/repo/src/b.ts", content: "a\n=======\nb" }),
		]);
		expect(v?.ruleId).toBe("obl_conflict_marker_persisted");
	});

	it("fires as 'persisted' when an earlier edit already carried the marker", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/c.ts", old_string: "x", new_string: MARKER_BODY }),
			ev("PostToolUse", "Edit", { file_path: "/repo/src/c.ts", old_string: "y", new_string: MARKER_BODY }),
		]);
		expect(v?.ruleId).toBe("obl_conflict_marker_persisted");
		expect(v?.reason).toContain("survived");
	});

	it("does NOT read its own PreToolUse leg as a prior edit (fresh, not 'survived')", () => {
		// Same toolUseId on the Pre and Post leg — the adapter must exclude the twin.
		const pre = ev("PreToolUse", "Edit", { file_path: "/repo/src/d.ts", old_string: "x", new_string: MARKER_BODY }, "twin");
		const post = ev("PostToolUse", "Edit", { file_path: "/repo/src/d.ts", old_string: "x", new_string: MARKER_BODY }, "twin");
		const v = run(oblConflictMarkerPersisted, [pre, post]);
		expect(v?.ruleId).toBe("obl_conflict_marker_persisted");
		expect(v?.reason).not.toContain("survived");
	});
});

describe("obl_conflict_marker_persisted adapter (negative: stays silent)", () => {
	it("does NOT fire on the PreToolUse leg (evaluates once, at Post)", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PreToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: MARKER_BODY }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire when the edit removes the marker (resolution path)", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: MARKER_BODY, new_string: "resolved" }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire on exempt paths (markdown docs carry Setext ======= underlines)", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Edit", { file_path: "/repo/docs/guide.md", old_string: "x", new_string: MARKER_BODY }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire on an 8-char banner run (not a 7-char marker)", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "a\n========\nb" }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire on a Bash event", () => {
		const v = run(oblConflictMarkerPersisted, [
			ev("PostToolUse", "Bash", { command: "echo '<<<<<<< HEAD'" }),
		]);
		expect(v).toBeNull();
	});
});

describe("obl_net_open_at_stop adapter (positive: fires)", () => {
	it("fires at Stop when an edit opened a TODO that was never closed", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "// TODO wire this" }),
			ev("Stop", "", {}),
		]);
		expect(v?.ruleId).toBe("obl_net_open_at_stop");
		expect(v?.action).toBe("nudge");
		expect(v?.reason).toContain("open obligation");
		expect(v?.reason).not.toContain("[interlinked:obligations]");
	});

	it("fires at Stop for a stub left open (throw not-implemented)", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Write", {
				file_path: "/repo/src/b.ts",
				content: 'export function f() { throw new Error("not implemented"); }',
			}),
			ev("Stop", "", {}),
		]);
		expect(v?.ruleId).toBe("obl_net_open_at_stop");
	});

	it("fires at Stop for a disabled test introduced and never re-enabled", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/c.test.ts", old_string: "it(", new_string: "it.skip(" }),
			ev("Stop", "", {}),
		]);
		expect(v?.ruleId).toBe("obl_net_open_at_stop");
	});
});

describe("obl_net_open_at_stop adapter (negative: stays silent)", () => {
	it("does NOT fire before Stop (per-edit events never trigger the inventory)", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "// TODO wire this" }),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire at Stop when the obligation was closed by a later edit", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "// TODO wire this" }),
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "// TODO wire this", new_string: "wired()" }),
			ev("Stop", "", {}),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire at Stop for a clean session (no obligations opened)", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "const y = 1;" }),
			ev("Stop", "", {}),
		]);
		expect(v).toBeNull();
	});

	it("does NOT fire for a ticket-tagged TODO (tracked, not a loose end)", () => {
		const v = run(oblNetOpenAtStop, [
			ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "// TODO(#123) wire this" }),
			ev("Stop", "", {}),
		]);
		expect(v).toBeNull();
	});
});

describe("Family 3 — wiring", () => {
	it("OBLIGATION_RULES exports exactly the two adapters", () => {
		expect(OBLIGATION_RULES).toHaveLength(2);
		expect(OBLIGATION_RULES).toContain(oblConflictMarkerPersisted);
		expect(OBLIGATION_RULES).toContain(oblNetOpenAtStop);
	});
});
