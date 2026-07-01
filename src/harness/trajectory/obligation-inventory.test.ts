import { describe, expect, it } from "vitest";
import {
	formatOpenObligations,
	isExemptPath,
	obligationConflictMarkerRule,
	type ToolEvent,
} from "./obligation-inventory.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function edit(file: string, oldString: string, newString: string): ToolEvent {
	idSeq += 1;
	return {
		ts: new Date(2026, 5, 27, 0, 0, idSeq).toISOString(),
		session: "s1",
		tool: "Edit",
		toolUseId: `e${idSeq}`,
		hook: "PostToolUse",
		input: { file_path: file, old_string: oldString, new_string: newString },
	};
}

function write(file: string, content: string): ToolEvent {
	idSeq += 1;
	return {
		ts: new Date(2026, 5, 27, 0, 0, idSeq).toISOString(),
		session: "s1",
		tool: "Write",
		toolUseId: `w${idSeq}`,
		hook: "PostToolUse",
		input: { file_path: file, content },
	};
}

// ===========================================================================
// Rule 1 — obl_net_open_at_stop  (formatOpenObligations)
// ===========================================================================

describe("formatOpenObligations — positive cases", () => {
	it("lists a TODO added and never removed", () => {
		const events = [
			edit("src/auth.ts", "return user;", "// TODO: handle expired sessions\n  return user;"),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("TODO/FIXME/XXX/HACK");
		expect(msg!).toContain("auth.ts");
		expect(msg!).toContain("1 open obligation");
		expect(msg!).toContain("inventory, not a failure");
	});

	it("lists a not-implemented stub added this session", () => {
		const events = [
			edit(
				"src/handler.ts",
				"function run() {}",
				'function run() { throw new Error("not implemented yet"); }',
			),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("stub / not-implemented");
		expect(msg!).toContain("handler.ts");
	});

	it("lists a disabled test and groups multiple kinds together", () => {
		const events = [
			edit("src/parser.test.ts", "it('parses', () => {", "it.skip('parses', () => {"),
			edit("src/parser.ts", "const x = 1;", "// FIXME: rewrite parser\nconst x = 1;"),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("disabled test");
		expect(msg!).toContain("parser.test.ts");
		expect(msg!).toContain("TODO/FIXME/XXX/HACK");
		expect(msg!).toContain("2 open obligation");
	});

	it("counts a persisted conflict marker as an open obligation", () => {
		const events = [
			write("src/merge.ts", "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> feature\n"),
		];
		const msg = formatOpenObligations(events);
		expect(msg).not.toBeNull();
		expect(msg!).toContain("merge conflict marker");
		expect(msg!).toContain("merge.ts");
	});
});

describe("formatOpenObligations — negative cases", () => {
	it("returns null when every opened obligation is later closed", () => {
		const events = [
			edit("src/a.ts", "return user;", "// TODO: x\nreturn user;"),
			edit("src/a.ts", "// TODO: x\nreturn user;", "return user;"), // TODO removed
			edit("src/b.ts", "function f() {}", 'function f() { throw new Error("not implemented"); }'),
			edit(
				"src/b.ts",
				'function f() { throw new Error("not implemented"); }',
				"function f() { return 1; }",
			), // stub removed
		];
		expect(formatOpenObligations(events)).toBeNull();
	});

	it("does not count a TODO that a later edit removed", () => {
		const events = [
			edit("src/c.ts", "let n = 0;", "// TODO: validate\nlet n = 0;"),
			edit("src/c.ts", "// TODO: validate\nlet n = 0;", "let n = 0; // validated"),
		];
		expect(formatOpenObligations(events)).toBeNull();
	});

	it("ignores a TODO mentioned in markdown / doc prose", () => {
		const events = [
			write("docs/roadmap.md", "# Roadmap\n\n- TODO: write the migration guide\n"),
			write("README.md", "## Tasks\n\nTODO: ship v2, FIXME: the install steps\n"),
		];
		expect(formatOpenObligations(events)).toBeNull();
	});

	it("ignores ticket/author-tagged TODOs", () => {
		const events = [
			edit("src/d.ts", "const y = 2;", "// TODO(alice): refactor\nconst y = 2;"),
			edit("src/e.ts", "const z = 3;", "// FIXME(#4213): tracked elsewhere\nconst z = 3;"),
		];
		expect(formatOpenObligations(events)).toBeNull();
	});

	it("returns null for an empty / edit-free session", () => {
		expect(formatOpenObligations([])).toBeNull();
		const bashOnly: ToolEvent = {
			ts: "t",
			session: "s",
			tool: "Bash",
			toolUseId: "b1",
			hook: "PreToolUse",
			input: { command: "echo 'TODO and <<<<<<< not in a file edit'" },
		};
		expect(formatOpenObligations([bashOnly])).toBeNull();
	});
});

// ===========================================================================
// Rule 2 — obl_conflict_marker_persisted  (obligationConflictMarkerRule)
// ===========================================================================

describe("obligationConflictMarkerRule — positive cases", () => {
	it("fires when an edit leaves a <<<<<<< run in new_string", () => {
		const latest = edit(
			"src/merge.ts",
			"const a = 1;",
			"<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> feature",
		);
		const v = obligationConflictMarkerRule([], latest);
		expect(v).not.toBeNull();
		expect(v!.rule_id).toBe("obl_conflict_marker_persisted");
		expect(v!.action).toBe("nudge");
		expect(v!.severity).toBe("high");
		expect(v!.file).toBe("src/merge.ts");
		expect(v!.evidence.some((e) => e.startsWith("<<<<<<<"))).toBe(true);
	});

	it("fires on a bare ======= separator (7 equals, end of line)", () => {
		const latest = edit("src/x.ts", "old", "left\n=======\nright");
		const v = obligationConflictMarkerRule([], latest);
		expect(v).not.toBeNull();
		expect(v!.evidence).toContain("=======");
	});

	it("fires on a Write whose content has a >>>>>>> run, noting persistence", () => {
		const earlier = edit("src/y.ts", "a", "<<<<<<< HEAD\na");
		const latest = write("src/y.ts", "kept\n>>>>>>> other-branch\nmore");
		const v = obligationConflictMarkerRule([earlier], latest);
		expect(v).not.toBeNull();
		expect(v!.message).toContain("survived this one");
		expect(v!.message).toContain("y.ts");
	});
});

describe("obligationConflictMarkerRule — negative cases", () => {
	it("does not fire when the edit RESOLVES the conflict (marker only in old_string)", () => {
		const latest = edit(
			"src/merge.ts",
			"<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> feature",
			"const a = 2;",
		);
		expect(obligationConflictMarkerRule([], latest)).toBeNull();
	});

	it("does not fire on a string literal containing '<<<<' (not a 7-char line-start run)", () => {
		const latest = edit(
			"src/sep.ts",
			"const sep = '----';",
			"const sep = '<<<<';\nconst banner = '<<<<<<< inside a quoted string';",
		);
		expect(obligationConflictMarkerRule([], latest)).toBeNull();
	});

	it("does not fire on an 8-equals banner or a markdown Setext heading", () => {
		const banner = edit("src/z.ts", "x", "========\nconst x = 1;"); // 8 equals, not 7
		expect(obligationConflictMarkerRule([], banner)).toBeNull();

		const heading = write("docs/guide.md", "Title\n=======\n\nbody"); // exempt doc + Setext
		expect(obligationConflictMarkerRule([], heading)).toBeNull();
	});

	it("does not fire on a non-edit (Bash) or empty event", () => {
		const bash: ToolEvent = {
			ts: "t",
			session: "s",
			tool: "Bash",
			toolUseId: "b",
			hook: "PreToolUse",
			input: { command: "git merge feature" },
		};
		expect(obligationConflictMarkerRule([], bash)).toBeNull();
	});
});

// ===========================================================================
// Exemption predicate (shared FP guard)
// ===========================================================================

describe("isExemptPath", () => {
	it("exempts docs, markdown, fixtures, and snapshots", () => {
		expect(isExemptPath("docs/design/notes.ts")).toBe(true);
		expect(isExemptPath("README.md")).toBe(true);
		expect(isExemptPath("src/__fixtures__/conflict.txt")).toBe(true);
		expect(isExemptPath("src/__snapshots__/x.snap")).toBe(true);
	});

	it("does NOT exempt real source or real test files", () => {
		expect(isExemptPath("src/index.ts")).toBe(false);
		expect(isExemptPath("src/parser.test.ts")).toBe(false);
	});
});
