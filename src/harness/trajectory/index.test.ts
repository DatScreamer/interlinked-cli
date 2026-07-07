import { describe, expect, it } from "vitest";
import { createState, evaluateTrajectory, TRAJECTORY_RULES } from "./index.js";
import type { ToolEvent } from "./types.js";

interface EditSpec {
	file: string;
	from: string;
	to: string;
	step: string;
}

function postEdit({ file, from, to, step }: EditSpec): ToolEvent {
	return {
		ts: "2026-07-01T00:00:00.000Z",
		session: "s1",
		agent: "claude",
		tool: "Edit",
		toolUseId: `tu-${step}`,
		hook: "PostToolUse",
		input: { file_path: file, old_string: from, new_string: to },
		contentSha256: `sha-${step}`,
		toolOutcome: "success",
		checkDecision: "allow",
	};
}

describe("evaluateTrajectory", () => {
	it("aggregates the churn + security rule families", () => {
		expect(TRAJECTORY_RULES.length).toBeGreaterThan(0);
	});

	it("folds events and fires churn_literal_edit_revert on a literal undo", () => {
		const state = createState("s1");
		evaluateTrajectory(state, postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" })); // seed E1
		const verdicts = evaluateTrajectory(state, postEdit({ file: "/x.ts", from: "bar", to: "foo", step: "2" })); // E2 = exact revert
		expect(verdicts.some((v) => v.ruleId === "churn_literal_edit_revert")).toBe(true);
	});

	it("does NOT fire the revert when the second edit is not an exact undo (negative path)", () => {
		const state = createState("s3");
		evaluateTrajectory(state, postEdit({ file: "/x.ts", from: "foo", to: "bar", step: "1" }));
		// bar -> baz restores nothing a prior edit replaced, so it is not a literal revert.
		const verdicts = evaluateTrajectory(state, postEdit({ file: "/x.ts", from: "bar", to: "baz", step: "2" }));
		expect(verdicts.some((v) => v.ruleId === "churn_literal_edit_revert")).toBe(false);
	});

	it("mutates state incrementally — step count advances per folded event", () => {
		const state = createState("s2");
		evaluateTrajectory(state, postEdit({ file: "/y.ts", from: "a", to: "b", step: "1" }));
		expect(state.stepCount).toBe(1);
	});

	it("wires the obligation family — a persisted conflict marker fires through the entry", () => {
		const state = createState("s4");
		const verdicts = evaluateTrajectory(
			state,
			postEdit({ file: "/repo/src/x.ts", from: "a\nb", to: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> br", step: "1" }),
		);
		expect(verdicts.some((v) => v.ruleId === "obl_conflict_marker_persisted")).toBe(true);
	});

	it("wires the read/edit-balance family — a blind multi-line edit fires through the entry", () => {
		const state = createState("s5");
		const verdicts = evaluateTrajectory(
			state,
			postEdit({ file: "/repo/src/x.ts", from: "a\nb", to: "c\nd", step: "1" }),
		);
		expect(verdicts.some((v) => v.ruleId === "reb_blind_edit_unread_file")).toBe(true);
	});

	it("does NOT fire read/edit-balance rules once the file was read (negative path)", () => {
		const state = createState("s6");
		evaluateTrajectory(state, {
			ts: "2026-07-01T00:00:00.000Z",
			session: "s6",
			agent: "claude",
			tool: "Read",
			toolUseId: "tu-r1",
			hook: "PostToolUse",
			input: { file_path: "/repo/src/x.ts" },
			toolOutcome: "success",
		});
		const verdicts = evaluateTrajectory(
			state,
			postEdit({ file: "/repo/src/x.ts", from: "a\nb", to: "c\nd", step: "2" }),
		);
		expect(verdicts.some((v) => v.ruleId.startsWith("reb_"))).toBe(false);
	});
});
