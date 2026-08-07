import { describe, expect, it } from "vitest";
import {
	VERIFICATION_RULES,
	vdCodeEditStreakNoVerify,
	vdCodeToTestEditRatio,
	vdCommitNoVerify,
	vdVerificationCadenceDecay,
} from "./rules-verification.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryRule, Verdict } from "./types.js";

let counter = 0;
function ev(hook: string, tool: string, input: ToolEvent["input"]): ToolEvent {
	counter += 1;
	return {
		ts: `2026-07-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
		session: "s1",
		agent: "claude",
		tool,
		toolUseId: `u${counter}`,
		hook,
		input,
		toolOutcome: "success",
	};
}
const TEN_LINES = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
function edit(file: string, newStr = TEN_LINES): ToolEvent {
	return ev("PostToolUse", "Edit", { file_path: file, old_string: "x", new_string: newStr });
}
function verify(): ToolEvent {
	return ev("PostToolUse", "Bash", { command: "npm test" });
}
function read(file = "src/other.ts"): ToolEvent {
	return ev("PostToolUse", "Read", { file_path: file });
}

/** Fold every event into a fresh state, then run `rule` against the last event. */
function run(rule: TrajectoryRule, events: ToolEvent[]): Verdict | null {
	const state = createState("s1");
	for (const e of events) applyEvent(state, e);
	const last = events[events.length - 1];
	if (!last) throw new Error("run() needs at least one event");
	return rule(state, last);
}

function sourceEdits(n: number, newStr = TEN_LINES): ToolEvent[] {
	const out: ToolEvent[] = [];
	for (let i = 0; i < n; i++) out.push(edit(`src/mod${i}.ts`, newStr));
	return out;
}

describe("Family 7 — verification discipline (positive: rules fire)", () => {
	it("vd_code_edit_streak_no_verify fires at 8 source edits + ≥60 lines with no verifier", () => {
		const v = run(vdCodeEditStreakNoVerify, sourceEdits(8));
		expect(v?.ruleId).toBe("vd_code_edit_streak_no_verify");
		expect(v?.action).toBe("nudge");
	});

	it("vd_commit_no_verify_this_session fires on a commit after 3 source edits with no verifier", () => {
		const events = [...sourceEdits(3), ev("PreToolUse", "Bash", { command: "git commit -m 'wip'" })];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
		expect(v?.action).toBe("nudge");
	});

	it("vd_code_to_test_edit_ratio fires at 10 source edits with zero test edits", () => {
		const v = run(vdCodeToTestEditRatio, sourceEdits(10));
		expect(v?.ruleId).toBe("vd_code_to_test_edit_ratio");
		expect(v?.action).toBe("silent_metric");
	});

	it("vd_verification_cadence_decay fires when inter-verify gaps grow (2 → 3 → 6)", () => {
		// window positions: V1=0, V2=2, V3=5, V4=11 → gaps [2,3,6]: increasing and 6 > 2×2.
		const events = [
			verify(), read(), verify(), read(), read(), verify(),
			read(), read(), read(), read(), read(), verify(),
		];
		const v = run(vdVerificationCadenceDecay, events);
		expect(v?.ruleId).toBe("vd_verification_cadence_decay");
		expect(v?.action).toBe("silent_metric");
	});
});

describe("Family 7 — verification discipline (negative: rules stay silent)", () => {
	it("streak does NOT fire when a verifier run reset the streak (only 4 edits since verify)", () => {
		const events = [...sourceEdits(4), verify(), ...sourceEdits(4)];
		expect(run(vdCodeEditStreakNoVerify, events)).toBeNull();
	});

	it("streak does NOT fire on 8 edits below the 60-line floor", () => {
		expect(run(vdCodeEditStreakNoVerify, sourceEdits(8, "a\nb"))).toBeNull();
	});

	it("commit_no_verify does NOT fire when a verifier ran this session", () => {
		const events = [...sourceEdits(3), verify(), ev("PreToolUse", "Bash", { command: "git commit -m 'ok'" })];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("commit_no_verify does NOT fire on a docs-only commit (no source edits)", () => {
		const events = [
			ev("PostToolUse", "Edit", { file_path: "README.md", old_string: "x", new_string: TEN_LINES }),
			ev("PostToolUse", "Edit", { file_path: "docs/a.md", old_string: "x", new_string: TEN_LINES }),
			ev("PostToolUse", "Edit", { file_path: "docs/b.md", old_string: "x", new_string: TEN_LINES }),
			ev("PreToolUse", "Bash", { command: "git commit -m 'docs'" }),
		];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("code_to_test_ratio does NOT fire when a test file was also edited", () => {
		const events = [...sourceEdits(9), edit("src/mod.test.ts"), edit("src/mod10.ts")];
		expect(run(vdCodeToTestEditRatio, events)).toBeNull();
	});

	it("cadence_decay does NOT fire with fewer than 4 verifier runs", () => {
		const events = [verify(), read(), verify(), read(), read(), verify()];
		expect(run(vdVerificationCadenceDecay, events)).toBeNull();
	});
});

describe("Family 7 — additional branch coverage", () => {
	it("streak escalates to 'high' severity at the 16-edit threshold", () => {
		const v = run(vdCodeEditStreakNoVerify, sourceEdits(16));
		expect(v?.severity).toBe("high");
	});

	it("streak counts a Write edit using the content field (not new_string) and a bare edit with neither", () => {
		const events = [
			...sourceEdits(6),
			ev("PostToolUse", "Write", { file_path: "src/a.ts", content: "l1\nl2\nl3" }),
			ev("PostToolUse", "Write", { file_path: "src/b.ts" }),
		];
		const v = run(vdCodeEditStreakNoVerify, events);
		expect(v?.ruleId).toBe("vd_code_edit_streak_no_verify");
	});

	it("commit_no_verify returns null when the Bash event carries no command at all", () => {
		const events = [...sourceEdits(3), ev("PreToolUse", "Bash", {})];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("commit_no_verify returns null on a non-git command", () => {
		const events = [...sourceEdits(3), ev("PreToolUse", "Bash", { command: "npm test" })];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("commit_no_verify returns null when git's first subcommand isn't commit/push", () => {
		const events = [...sourceEdits(3), ev("PreToolUse", "Bash", { command: "git status" })];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("commit_no_verify skips a leading non-git segment then matches git in a later segment", () => {
		const events = [
			...sourceEdits(3),
			ev("PreToolUse", "Bash", { command: "echo hi && git commit -m x" }),
		];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
	});

	it("commit_no_verify recognizes a full-path git binary (endsWith '/git')", () => {
		const events = [...sourceEdits(3), ev("PreToolUse", "Bash", { command: "/usr/bin/git commit -m x" })];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
	});

	it("commit_no_verify skips the -C global option's argument then matches commit", () => {
		const events = [
			...sourceEdits(3),
			ev("PreToolUse", "Bash", { command: "git -C /repo commit -m x" }),
		];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
	});

	it("commit_no_verify skips the -c global option's argument then matches push", () => {
		const events = [
			...sourceEdits(3),
			ev("PreToolUse", "Bash", { command: "git -c user.name=x push" }),
		];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
	});

	it("commit_no_verify skips an ordinary flag then matches commit", () => {
		const events = [
			...sourceEdits(3),
			ev("PreToolUse", "Bash", { command: "git --no-pager commit -m x" }),
		];
		const v = run(vdCommitNoVerify, events);
		expect(v?.ruleId).toBe("vd_commit_no_verify_this_session");
	});

	it("cadence_decay returns null when the passed verify event isn't the freshest in the window", () => {
		const events = [
			verify(), read(), verify(), read(), read(), verify(),
			read(), read(), read(), read(), read(), verify(), read(),
		];
		const state = createState("s1");
		for (const e of events) applyEvent(state, e);
		// The window now ends with a `read` after the last verify, so the
		// freshest-verify check fails even though `event` itself is a verify.
		const someVerify = events[5];
		if (!someVerify) throw new Error("fixture missing verify event");
		expect(vdVerificationCadenceDecay(state, someVerify)).toBeNull();
	});

	it("streak recognizes a MultiEdit tool call and ignores an interleaved non-edit Read", () => {
		const events = [
			...sourceEdits(5),
			read(), // non-edit event mixed into the streak (isPostSourceEdit false)
			ev("PostToolUse", "MultiEdit", { file_path: "src/multi.ts", old_string: "x", new_string: TEN_LINES }),
			...sourceEdits(2),
		];
		const v = run(vdCodeEditStreakNoVerify, events);
		expect(v?.ruleId).toBe("vd_code_edit_streak_no_verify");
	});

	it("commit_no_verify returns null for a non-PreToolUse or non-Bash event", () => {
		const events = [...sourceEdits(3), ev("PostToolUse", "Bash", { command: "git commit -m x" })];
		expect(run(vdCommitNoVerify, events)).toBeNull();
	});

	it("code_to_test_ratio skips an edit with no file_path and doesn't count a non-source non-test file", () => {
		const events = [
			...sourceEdits(10),
			read(), // non-edit event — isPostEdit false, must be skipped by continue
			ev("PostToolUse", "Edit", { old_string: "x", new_string: TEN_LINES }),
			edit("README.md"),
		];
		const v = run(vdCodeToTestEditRatio, events);
		expect(v?.ruleId).toBe("vd_code_to_test_edit_ratio");
	});
});

describe("Family 7 — wiring", () => {
	it("exports exactly the four verification-discipline rules", () => {
		expect(VERIFICATION_RULES).toHaveLength(4);
	});

	it("every rule is metric-only or nudge — none blocks (shadow-safe)", () => {
		const events = [...sourceEdits(8), ev("PreToolUse", "Bash", { command: "git commit -m 'x'" })];
		for (const rule of VERIFICATION_RULES) {
			const state = createState("s1");
			for (const e of events) applyEvent(state, e);
			const last = events[events.length - 1];
			if (!last) throw new Error("no events");
			const v = rule(state, last);
			if (v) expect(v.action).not.toBe("block");
		}
	});
});
