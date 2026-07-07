import { describe, expect, it } from "vitest";
import {
	READ_EDIT_RULES,
	rebBlindEditUnreadFile,
	rebColdStartFirstEditZeroReads,
	rebImportAddedWithoutReadingModule,
	rebReadRecencyDecayEdit,
	rebReadStormNoEdit,
} from "./rules-read-edit.js";
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

const TWO_LINES = "line one\nline two";

function edit(file: string, oldStr = TWO_LINES, newStr = "replacement\ncode"): ToolEvent {
	return ev("PostToolUse", "Edit", { file_path: file, old_string: oldStr, new_string: newStr });
}
function read(file: string): ToolEvent {
	return ev("PostToolUse", "Read", { file_path: file });
}
function bash(command: string): ToolEvent {
	return ev("PostToolUse", "Bash", { command });
}

/** Fold every event into a fresh state, then run `rule` against the last event. */
function run(rule: TrajectoryRule, events: ToolEvent[]): Verdict | null {
	const state = createState("s1");
	for (const e of events) applyEvent(state, e);
	const last = events[events.length - 1];
	if (!last) throw new Error("run() needs at least one event");
	return rule(state, last);
}

function reads(n: number, prefix = "src/other"): ToolEvent[] {
	const out: ToolEvent[] = [];
	for (let i = 0; i < n; i++) out.push(read(`/repo/${prefix}${i}.ts`));
	return out;
}

// ============================================================
// reb_blind_edit_unread_file
// ============================================================

describe("reb_blind_edit_unread_file (positive: fires)", () => {
	it("fires on a multi-line Edit to a source file never read this session", () => {
		const v = run(rebBlindEditUnreadFile, [read("/repo/src/other.ts"), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
		expect(v?.action).toBe("nudge");
	});

	it("fires even when many OTHER files were read (only the target counts)", () => {
		const v = run(rebBlindEditUnreadFile, [...reads(5), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});

	it("fires on a MultiEdit to an unread source file", () => {
		const v = run(rebBlindEditUnreadFile, [
			ev("PostToolUse", "MultiEdit", { file_path: "/repo/src/x.ts", old_string: TWO_LINES, new_string: "y\nz" }),
		]);
		expect(v?.ruleId).toBe("reb_blind_edit_unread_file");
	});
});

describe("reb_blind_edit_unread_file (negative: stays silent)", () => {
	it("does NOT fire after the file was Read", () => {
		expect(run(rebBlindEditUnreadFile, [read("/repo/src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire after a bash pseudo-read naming the file (cat with relative path)", () => {
		expect(run(rebBlindEditUnreadFile, [bash("cat src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire on a targeted single-line replacement (grep output alone locates it)", () => {
		expect(run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts", "const a = 1;")])).toBeNull();
	});

	it("does NOT fire on the second edit to the same file (region already seen)", () => {
		expect(
			run(rebBlindEditUnreadFile, [edit("/repo/src/x.ts"), edit("/repo/src/x.ts", "other\nregion")]),
		).toBeNull();
	});

	it("does NOT fire on a Write (may create the file) or a non-source file", () => {
		expect(
			run(rebBlindEditUnreadFile, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/new.ts", content: "a\nb" }),
			]),
		).toBeNull();
		expect(run(rebBlindEditUnreadFile, [edit("/repo/docs/notes.md")])).toBeNull();
	});
});

// ============================================================
// reb_cold_start_first_edit_zero_reads
// ============================================================

describe("reb_cold_start_first_edit_zero_reads (positive: fires)", () => {
	it("fires on the session's first Edit with zero reads and zero searches", () => {
		const v = run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
		expect(v?.action).toBe("nudge");
		expect(v?.severity).toBe("low");
	});

	it("fires when only non-read bash ran before the first edit", () => {
		const v = run(rebColdStartFirstEditZeroReads, [bash("git status"), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
	});

	it("fires for a MultiEdit as the first edit", () => {
		const v = run(rebColdStartFirstEditZeroReads, [
			ev("PostToolUse", "MultiEdit", { file_path: "/repo/src/x.ts", old_string: "a", new_string: "b" }),
		]);
		expect(v?.ruleId).toBe("reb_cold_start_first_edit_zero_reads");
	});
});

describe("reb_cold_start_first_edit_zero_reads (negative: stays silent)", () => {
	it("does NOT fire when any file was Read first", () => {
		expect(run(rebColdStartFirstEditZeroReads, [read("/repo/src/other.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire when a search ran first (Grep tool)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [ev("PostToolUse", "Grep", {}), edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire when a bash pseudo-read ran first", () => {
		expect(run(rebColdStartFirstEditZeroReads, [bash("cat src/x.ts"), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire on the second edit (one-shot)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [edit("/repo/src/x.ts"), edit("/repo/src/y.ts")]),
		).toBeNull();
	});

	it("does NOT fire on a Write create (no old_string — nothing unseen to clobber)", () => {
		expect(
			run(rebColdStartFirstEditZeroReads, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/new.ts", content: "a" }),
			]),
		).toBeNull();
	});
});

// ============================================================
// reb_read_recency_decay_edit
// ============================================================

describe("reb_read_recency_decay_edit (positive: fires)", () => {
	it("fires when the file's read is >40 steps stale and intervening work is unrelated", () => {
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(45), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
		expect(v?.action).toBe("silent_metric");
	});

	it("fires when the original read has scrolled out of the event window entirely", () => {
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(70), edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
	});

	it("fires when the intervening work is unrelated bash", () => {
		const cmds: ToolEvent[] = [];
		for (let i = 0; i < 45; i++) cmds.push(bash(`echo step-${i}`));
		const v = run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...cmds, edit("/repo/src/x.ts")]);
		expect(v?.ruleId).toBe("reb_read_recency_decay_edit");
	});
});

describe("reb_read_recency_decay_edit (negative: stays silent)", () => {
	it("does NOT fire when the read is recent (gap under the threshold)", () => {
		expect(
			run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...reads(10), edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire when the intervening work stays related to the file", () => {
		const related: ToolEvent[] = [];
		for (let i = 0; i < 45; i++) related.push(bash(`echo x.ts pass ${i}`));
		expect(
			run(rebReadRecencyDecayEdit, [read("/repo/src/x.ts"), ...related, edit("/repo/src/x.ts")]),
		).toBeNull();
	});

	it("does NOT fire for a never-read file (blind-edit territory, not decay)", () => {
		expect(run(rebReadRecencyDecayEdit, [...reads(45), edit("/repo/src/x.ts")])).toBeNull();
	});

	it("does NOT fire when a re-Read refreshed the file just before the edit", () => {
		expect(
			run(rebReadRecencyDecayEdit, [
				read("/repo/src/x.ts"),
				...reads(45),
				read("/repo/src/x.ts"),
				edit("/repo/src/x.ts"),
			]),
		).toBeNull();
	});
});

// ============================================================
// reb_read_storm_no_edit
// ============================================================

describe("reb_read_storm_no_edit (positive: fires)", () => {
	it("fires on the 10th distinct Read with no edit in the run", () => {
		const v = run(rebReadStormNoEdit, reads(10));
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
		expect(v?.action).toBe("silent_metric");
	});

	it("fires when the run starts fresh after an edit", () => {
		const v = run(rebReadStormNoEdit, [edit("/repo/src/x.ts"), ...reads(10, "src/post")]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});

	it("fires once at the crossing even with an interspersed re-read", () => {
		// 9 distinct + 1 re-read of the first (no fire) + a 10th distinct → fires on the 10th.
		const v = run(rebReadStormNoEdit, [
			...reads(9),
			read("/repo/src/other0.ts"),
			read("/repo/src/tenth.ts"),
		]);
		expect(v?.ruleId).toBe("reb_read_storm_no_edit");
	});
});

describe("reb_read_storm_no_edit (negative: stays silent)", () => {
	it("does NOT fire at 9 distinct reads", () => {
		expect(run(rebReadStormNoEdit, reads(9))).toBeNull();
	});

	it("does NOT fire on a re-read (not a new distinct file)", () => {
		expect(run(rebReadStormNoEdit, [...reads(9), read("/repo/src/other0.ts")])).toBeNull();
	});

	it("does NOT fire when an edit broke the run", () => {
		expect(run(rebReadStormNoEdit, [...reads(6), edit("/repo/src/x.ts"), ...reads(6, "src/late")])).toBeNull();
	});

	it("does NOT re-fire past the crossing (11th distinct read is silent)", () => {
		expect(run(rebReadStormNoEdit, reads(11))).toBeNull();
	});
});

// ============================================================
// reb_import_added_without_reading_module
// ============================================================

describe("reb_import_added_without_reading_module (positive: fires)", () => {
	it("fires when an edit adds a relative import of a module never read or written", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'import { x } from "./unseen.js";'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
		expect(v?.action).toBe("silent_metric");
		expect(v?.reason).toContain("./unseen.js");
	});

	it("fires on a require() of an unseen parent-dir module", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			edit("/repo/src/a.ts", "// top", 'const u = require("../lib/util");'),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});

	it("fires on a Write whose content imports an unseen sibling", () => {
		const v = run(rebImportAddedWithoutReadingModule, [
			ev("PostToolUse", "Write", {
				file_path: "/repo/src/a.ts",
				content: 'import "./side-effect.js";\nexport const a = 1;',
			}),
		]);
		expect(v?.ruleId).toBe("reb_import_added_without_reading_module");
	});
});

describe("reb_import_added_without_reading_module (negative: stays silent)", () => {
	it("does NOT fire when the imported module was Read (extension-insensitive)", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				read("/repo/src/helper.ts"),
				edit("/repo/src/a.ts", "// top", 'import { h } from "./helper.js";'),
			]),
		).toBeNull();
	});

	it("does NOT fire when the module was created by this session (exporter landed first)", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				ev("PostToolUse", "Write", { file_path: "/repo/src/helper.ts", content: "export const h = 1;" }),
				edit("/repo/src/a.ts", "// top", 'import { h } from "./helper.js";'),
			]),
		).toBeNull();
	});

	it("does NOT fire on package (non-relative) imports", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				edit("/repo/src/a.ts", "// top", 'import { program } from "commander";'),
			]),
		).toBeNull();
	});

	it("does NOT fire when the import was already present before the edit", () => {
		expect(
			run(rebImportAddedWithoutReadingModule, [
				edit(
					"/repo/src/a.ts",
					'import { x } from "./unseen.js"; // old',
					'import { x } from "./unseen.js"; // touched comment',
				),
			]),
		).toBeNull();
	});
});

// ============================================================
// Wiring
// ============================================================

describe("Family 9 — wiring", () => {
	it("READ_EDIT_RULES exports all five rules", () => {
		expect(READ_EDIT_RULES).toHaveLength(5);
		expect(READ_EDIT_RULES).toContain(rebBlindEditUnreadFile);
		expect(READ_EDIT_RULES).toContain(rebColdStartFirstEditZeroReads);
		expect(READ_EDIT_RULES).toContain(rebReadRecencyDecayEdit);
		expect(READ_EDIT_RULES).toContain(rebReadStormNoEdit);
		expect(READ_EDIT_RULES).toContain(rebImportAddedWithoutReadingModule);
	});
});
