import { describe, expect, it } from "vitest";

import { sha256 } from "./helpers.js";
import {
	CHURN_RULES,
	churnEditsWithoutGreen,
	churnLiteralEditRevert,
	churnRepeatedFailingBash,
	churnRerunFailingTestNoSourceChange,
	churnRevertAfterCheckFailCombo,
	churnShaCycleRevisit,
	churnUndoWarValueToggle,
} from "./rules-churn.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryRule, Verdict } from "./types.js";

// ===========================================
// Compact event builders
// ===========================================

let seq = 0;
function nextId(): string {
	seq += 1;
	return `t${seq}`;
}

interface EditOpts {
	fail?: boolean;
	outcome?: "success" | "fail";
	tool?: "Edit" | "Write" | "MultiEdit";
}
function editEvents(file: string, oldStr: string, newStr: string, opts: EditOpts = {}): ToolEvent[] {
	const tool = opts.tool ?? "Edit";
	const id = nextId();
	const input = { file_path: file, old_string: oldStr, new_string: newStr };
	const failed = opts.fail ?? false;
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool, toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool,
			toolUseId: id,
			hook: "PostToolUse",
			input,
			contentSha256: sha256(newStr),
			toolOutcome: opts.outcome ?? "success",
			checkDecision: "allow",
			failedCheckIds: failed ? ["some_check"] : [],
		},
	];
}

function bashEvents(command: string, opts: { outcome?: "success" | "fail" } = {}): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool: "Bash",
			toolUseId: id,
			hook: "PostToolUse",
			input,
			toolOutcome: opts.outcome ?? "success",
		},
	];
}

function run(events: ToolEvent[], rules: ReadonlyArray<TrajectoryRule> = CHURN_RULES): Verdict[] {
	const state = createState("s");
	const out: Verdict[] = [];
	for (const ev of events) {
		applyEvent(state, ev);
		for (const r of rules) {
			const v = r(state, ev);
			if (v) out.push(v);
		}
	}
	return out;
}
function firedIds(verdicts: Verdict[]): Set<string> {
	return new Set(verdicts.map((v) => v.ruleId));
}

// Stable multi-line block whose first+last lines are constant → constant anchor.
const F1 = "function f() {\n  return 1;\n}";
const F2 = "function f() {\n  return 2;\n}";
const F3 = "function f() {\n  return 3;\n}";

// ===========================================
// churn_sha_cycle_revisit
// ===========================================
describe("churn_sha_cycle_revisit", () => {
	it("fires on A→B→A when a failing check intervened", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B", { fail: true }),
			...editEvents("src/a.ts", "B", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(true);
	});

	it("fires on A→B→A→B→A with two distinct revisits", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(true);
	});

	it("fires on A→B→C→A with a failing edit in the loop", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B", { fail: true }),
			...editEvents("src/a.ts", "B", "C"),
			...editEvents("src/a.ts", "C", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(true);
	});

	it("does NOT fire on a single A→B→A with no failing check (one revisit)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire on a whitespace-only cycle (x=1 → x=1 → x=1)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "x=1"),
			...editEvents("src/a.ts", "x=1", "x=1 "),
			...editEvents("src/a.ts", "x=1 ", "x=1"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire when there is no cycle (A→B→C distinct)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "C"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});
});

// ===========================================
// churn_literal_edit_revert
// ===========================================
describe("churn_literal_edit_revert", () => {
	it("fires on a strict exact undo (foo→bar then bar→foo)", () => {
		const v = run([
			...editEvents("src/a.ts", "foo", "bar"),
			...editEvents("src/a.ts", "bar", "foo"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("fires when the revert follows an unrelated edit in between", () => {
		const v = run([
			...editEvents("src/a.ts", "alpha", "beta"),
			...editEvents("src/b.ts", "p", "q"),
			...editEvents("src/a.ts", "beta", "alpha"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("fires on a second region's exact undo", () => {
		const v = run([
			...editEvents("src/a.ts", "let x = 1", "let x = 2"),
			...editEvents("src/a.ts", "let x = 2", "let x = 1"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("does NOT fire on a non-exact (substring) reversal", () => {
		const v = run([
			...editEvents("src/a.ts", "bar", "foobar"),
			...editEvents("src/a.ts", "foobar", "bar2"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});

	it("does NOT fire when the second edit is not the inverse (a→b then b→c)", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b"),
			...editEvents("src/a.ts", "b", "c"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});

	it("does NOT fire on a no-op edit (old === new)", () => {
		const v = run([
			...editEvents("src/a.ts", "same", "same"),
			...editEvents("src/a.ts", "same", "same"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});
});

// ===========================================
// churn_undo_war_value_toggle
// ===========================================
describe("churn_undo_war_value_toggle", () => {
	it("fires on A→B→A at a stable anchor with no verify between", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(true);
	});

	it("fires with the high severity band", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F2),
		]);
		const hit = v.find((x) => x.ruleId === "churn_undo_war_value_toggle");
		expect(hit?.severity).toBe("high");
	});

	it("fires on a different file's toggle", () => {
		const v = run([
			...editEvents("src/z.ts", F1, F2),
			...editEvents("src/z.ts", F2, F1),
			...editEvents("src/z.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(true);
	});

	it("does NOT fire when a test ran between the toggles (bisection)", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...bashEvents("npm test", { outcome: "fail" }),
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});

	it("does NOT fire on a single flip A→B (no return)", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});

	it("does NOT fire on three distinct values A→B→C", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F3),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});
});

// ===========================================
// churn_edits_without_green
// ===========================================
describe("churn_edits_without_green", () => {
	function nFailingEdits(file: string, n: number): ToolEvent[] {
		const evs: ToolEvent[] = [];
		for (let i = 0; i < n; i++) evs.push(...editEvents(file, `v${i}`, `v${i + 1}`, { fail: true }));
		return evs;
	}

	it("fires at exactly 5 failing edits on a source file", () => {
		const v = run(nFailingEdits("src/a.ts", 5));
		expect(firedIds(v).has("churn_edits_without_green")).toBe(true);
	});

	it("fires at the 8-edit escalation", () => {
		const v = run(nFailingEdits("src/a.ts", 8));
		expect(v.filter((x) => x.ruleId === "churn_edits_without_green").length).toBeGreaterThanOrEqual(2);
	});

	it("fires with high severity at 12", () => {
		const v = run(nFailingEdits("src/a.ts", 12));
		const hits = v.filter((x) => x.ruleId === "churn_edits_without_green");
		expect(hits.some((h) => h.severity === "high")).toBe(true);
	});

	it("does NOT fire on a non-source (doc) file", () => {
		const v = run(nFailingEdits("docs/notes.md", 6));
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});

	it("does NOT fire below the threshold (4 edits)", () => {
		const v = run(nFailingEdits("src/a.ts", 4));
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});

	it("does NOT fire when a clean edit resets the counter", () => {
		const v = run([
			...nFailingEdits("src/a.ts", 4),
			...editEvents("src/a.ts", "clean-old", "clean-new"), // clean → reset
			...nFailingEdits("src/a.ts", 4),
		]);
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});
});

// ===========================================
// churn_repeated_failing_bash
// ===========================================
describe("churn_repeated_failing_bash", () => {
	it("fires on the third identical failing command", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(true);
	});

	it("keeps firing on the fourth failing run", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(v.filter((x) => x.ruleId === "churn_repeated_failing_bash").length).toBeGreaterThanOrEqual(2);
	});

	it("fires across number-normalized variants (port drift)", () => {
		const v = run([
			...bashEvents("node server.js 3000", { outcome: "fail" }),
			...bashEvents("node server.js 3001", { outcome: "fail" }),
			...bashEvents("node server.js 3002", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(true);
	});

	it("does NOT fire after only two failures", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("does NOT fire when an edit intervenes (reset)", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...editEvents("src/a.ts", "x", "y"),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("does NOT fire on flaky/network verbs (curl)", () => {
		const v = run([
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});
});

// ===========================================
// churn_rerun_failing_test_no_source_change
// ===========================================
describe("churn_rerun_failing_test_no_source_change", () => {
	it("fires on a third failing test run with no source change", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(true);
	});

	it("fires for a build-family rerun", () => {
		const v = run([
			...bashEvents("npm run build", { outcome: "fail" }),
			...bashEvents("npm run build", { outcome: "fail" }),
			...bashEvents("npm run build", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(true);
	});

	it("fires for a direct vitest rerun", () => {
		const v = run([
			...bashEvents("vitest run", { outcome: "fail" }),
			...bashEvents("vitest run", { outcome: "fail" }),
			...bashEvents("vitest run", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(true);
	});

	it("does NOT fire when a source edit lands between runs", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...editEvents("src/a.ts", "x", "y"),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});

	it("does NOT fire on a single confirmation re-run (twice)", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});

	it("does NOT fire when an install disruptor resets the family", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm install left-pad", { outcome: "success" }),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});
});

// ===========================================
// churn_revert_after_check_fail_combo
// ===========================================
describe("churn_revert_after_check_fail_combo", () => {
	function combo(opts: { e1Fail?: boolean; revertClean?: boolean; reapplyNew?: string } = {}): ToolEvent[] {
		const e1Fail = opts.e1Fail ?? true;
		const revertClean = opts.revertClean ?? false;
		const reNew = opts.reapplyNew ?? "b";
		return [
			...editEvents("src/a.ts", "a", "b", { fail: e1Fail }), // E1 (fails)
			...editEvents("src/a.ts", "b", "a", { fail: !revertClean }), // revert
			...editEvents("src/a.ts", "a", reNew, { fail: true }), // E3 re-apply
		];
	}

	it("fires on fail → literal revert → byte-identical re-apply with no green between", () => {
		expect(firedIds(run(combo())).has("churn_revert_after_check_fail_combo")).toBe(true);
	});

	it("fires when an unrelated-region edit sits inside the window", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b", { fail: true }),
			...editEvents("src/a.ts", "b", "a", { fail: true }),
			...editEvents("src/a.ts", "zzz", "yyy", { fail: true }),
			...editEvents("src/a.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(true);
	});

	it("fires in a different file", () => {
		const v = run([
			...editEvents("src/q.ts", "a", "b", { fail: true }),
			...editEvents("src/q.ts", "b", "a", { fail: true }),
			...editEvents("src/q.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(true);
	});

	it("does NOT fire when a green (clean check) happens between (revert went green)", () => {
		expect(firedIds(run(combo({ revertClean: true }))).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when an install/git disruptor intervenes", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b", { fail: true }),
			...editEvents("src/a.ts", "b", "a", { fail: true }),
			...bashEvents("git checkout -- src/a.ts"),
			...editEvents("src/a.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when E1 never failed a check", () => {
		expect(firedIds(run(combo({ e1Fail: false }))).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when the re-apply is not byte-identical", () => {
		expect(
			firedIds(run(combo({ reapplyNew: "different" }))).has("churn_revert_after_check_fail_combo"),
		).toBe(false);
	});
});

// ===========================================
// Wiring sanity
// ===========================================
describe("CHURN_RULES registry", () => {
	it("exports all seven churn rules", () => {
		expect(CHURN_RULES.length).toBe(7);
	});
	it("every rule is nudge action (no churn blocks)", () => {
		const sample = [
			churnShaCycleRevisit,
			churnLiteralEditRevert,
			churnUndoWarValueToggle,
			churnEditsWithoutGreen,
			churnRepeatedFailingBash,
			churnRerunFailingTestNoSourceChange,
			churnRevertAfterCheckFailCombo,
		];
		expect(sample.length).toBe(7);
		const v = run([
			...editEvents("src/a.ts", "foo", "bar"),
			...editEvents("src/a.ts", "bar", "foo"),
		]);
		expect(v.every((x) => x.action === "nudge")).toBe(true);
	});
});
