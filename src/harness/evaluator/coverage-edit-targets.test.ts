import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { coverageTargetsFor } from "./coverage-edit-targets.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-targets-"));
	mkdirSync(join(root, "src"), { recursive: true });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const CFG = {
	enabled: true,
	mode: "block",
	budget_ms: 25_000,
	languages: ["js", "ts", "python"],
} as NonNullable<GuardRulesConfig["per_edit_coverage"]>;

function event(toolName: string, toolInput: Record<string, unknown>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: toolName,
		tool_input: toolInput,
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function writeFile(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/** Assemble a V4A apply_patch payload from its body lines. */
function patch(...lines: string[]): string {
	return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

describe("coverageTargetsFor — single-file write shapes", () => {
	it("Write yields one target carrying the proposed content", () => {
		const targets = coverageTargetsFor(
			event("Write", { file_path: join(root, "src/m.ts"), content: "export const a = 1;\n" }),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath)).toEqual(["src/m.ts"]);
		expect(targets[0].language).toBe("ts");
		expect(targets[0].proposed).toContain("export const a = 1;");
	});

	it("Edit yields one target with the post-edit content", () => {
		writeFile("src/m.ts", "export const a = 1;\n");
		const targets = coverageTargetsFor(
			event("Edit", { file_path: join(root, "src/m.ts"), old_string: "= 1", new_string: "= 2" }),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath)).toEqual(["src/m.ts"]);
		expect(targets[0].proposed).toContain("export const a = 2;");
	});

	it("returns [] for a non-code file", () => {
		const targets = coverageTargetsFor(
			event("Write", { file_path: join(root, "README.md"), content: "# hi" }),
			root,
			CFG,
		);
		expect(targets).toEqual([]);
	});

	it("returns [] for a test file (coverage unit is production code)", () => {
		const targets = coverageTargetsFor(
			event("Write", { file_path: join(root, "src/m.test.ts"), content: "export const a = 1;\n" }),
			root,
			CFG,
		);
		expect(targets).toEqual([]);
	});

	it("returns [] for an out-of-tree path", () => {
		const targets = coverageTargetsFor(event("Write", { file_path: "/etc/passwd", content: "x" }), root, CFG);
		expect(targets).toEqual([]);
	});
});

describe("coverageTargetsFor — apply_patch (the finding-1 gap)", () => {
	it("Update File: reconstructs content from the PAYLOAD path (no file_path present)", () => {
		writeFile("src/m.ts", "export function f() {\n\treturn 1;\n}\n");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/m.ts", "@@", "-\treturn 1;", "+\treturn 2;"),
			}),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath)).toEqual(["src/m.ts"]);
		expect(targets[0].proposed).toContain("return 2;");
		// Edited-line scoping: only the changed line is "added", not the whole file.
		expect(targets[0].editedLines).toEqual(new Set([2]));
	});

	it("Add File: yields a whole-new-file target with every line added", () => {
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Add File: src/new.ts", "+export const x = 1;", "+export const y = 2;"),
			}),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath)).toEqual(["src/new.ts"]);
		expect(targets[0].proposed).toBe("export const x = 1;\nexport const y = 2;");
		expect(targets[0].editedLines).toEqual(new Set([1, 2]));
	});

	it("yields ONE target per code file for a multi-file patch", () => {
		writeFile("src/a.ts", "export const a = 1;\n");
		writeFile("src/b.ts", "export const b = 1;\n");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch(
					"*** Update File: src/a.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
					"*** Update File: src/b.ts",
					"@@",
					"-export const b = 1;",
					"+export const b = 2;",
				),
			}),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("filters non-code / test sections out of a mixed patch", () => {
		writeFile("src/a.ts", "export const a = 1;\n");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch(
					"*** Add File: docs/readme.md",
					"+# hi",
					"*** Add File: src/a.test.ts",
					"+export const t = 1;",
					"*** Update File: src/a.ts",
					"@@",
					"-export const a = 1;",
					"+export const a = 2;",
				),
			}),
			root,
			CFG,
		);
		expect(targets.map((t) => t.relPath)).toEqual(["src/a.ts"]); // only the code file
	});

	it("fail-opens (skips) a section that cannot be reconstructed — never a false target", () => {
		// An Update whose context is absent on disk can't be applied confidently.
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/missing.ts", "@@", "-not present", "+changed"),
			}),
			root,
			CFG,
		);
		expect(targets).toEqual([]);
	});

	it("does not throw on a rename (Move to:) and fail-opens when unreconstructable", () => {
		// V4A renames retarget to the NEW path, whose before-content is absent, so
		// the section fail-opens (skipped) — matching the cyclomatic gate. The
		// commit-time gate still covers the renamed file via git-diff.
		writeFile("src/old.ts", "export const a = 1;\n");
		const targets = coverageTargetsFor(
			event("apply_patch", {
				command: patch("*** Update File: src/old.ts", "*** Move to: src/new.ts"),
			}),
			root,
			CFG,
		);
		expect(Array.isArray(targets)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// MUTATING-TOOL PARITY CONTRACT (finding 1): every supported mutating-tool shape
// must resolve to a coverage target for the same edit. A shape that silently
// yields NO target is an unchecked write — the exact class of bug finding 1 was.
// When a new payload-embedded tool is added to `isFileWrite`, add a branch to
// `coverageTargetsFor` AND a case here.
// ---------------------------------------------------------------------------

describe("mutating-tool parity contract (finding 1)", () => {
	beforeEach(() => writeFile("src/m.ts", "export function f() {\n\treturn 1;\n}\n"));

	/** The code files the gate would evaluate for a given mutating-tool event. */
	function gatedPaths(ev: HarnessEvent): string[] {
		return coverageTargetsFor(ev, root, CFG).map((t) => t.relPath);
	}

	it("Write is gated", () => {
		const ev = event("Write", {
			file_path: join(root, "src/m.ts"),
			content: "export function f() {\n\treturn 2;\n}\n",
		});
		expect(gatedPaths(ev)).toContain("src/m.ts");
	});

	it("Edit is gated", () => {
		const ev = event("Edit", {
			file_path: join(root, "src/m.ts"),
			old_string: "return 1",
			new_string: "return 2",
		});
		expect(gatedPaths(ev)).toContain("src/m.ts");
	});

	it("MultiEdit is gated", () => {
		const ev = event("MultiEdit", {
			file_path: join(root, "src/m.ts"),
			edits: [{ old_string: "return 1", new_string: "return 2" }],
		});
		expect(gatedPaths(ev)).toContain("src/m.ts");
	});

	it("apply_patch is gated (was the bypass)", () => {
		const ev = event("apply_patch", {
			command: patch("*** Update File: src/m.ts", "@@", "-\treturn 1;", "+\treturn 2;"),
		});
		expect(gatedPaths(ev)).toContain("src/m.ts");
	});
});

// ---------------------------------------------------------------------------
// PATH-CONFINEMENT CONTRACT (finding: path traversal). Agent-controlled paths
// that become overlay filesystem WRITES must pass project confinement. The
// apply_patch payload carries no file_path, so this can't lean on the tool's own
// confinement — `toProjectRel` is the shared primitive. Fire traversal paths
// through every mutation-tool shape and assert NO target escapes the project.
// ---------------------------------------------------------------------------

describe("coverageTargetsFor — path confinement (traversal-safe)", () => {
	it("rejects a ../ traversal in an apply_patch Update (the no-file_path vector)", () => {
		const ev = event("apply_patch", {
			command: patch("*** Update File: ../../victim.ts", "@@", "-x", "+y"),
		});
		expect(coverageTargetsFor(ev, root, CFG)).toEqual([]);
	});

	it("rejects a ../ traversal in an apply_patch Add", () => {
		const ev = event("apply_patch", { command: patch("*** Add File: ../escape.ts", "+export const x = 1;") });
		expect(coverageTargetsFor(ev, root, CFG)).toEqual([]);
	});

	it("rejects an absolute path outside the project (apply_patch + Write)", () => {
		const patchEv = event("apply_patch", { command: patch("*** Add File: /etc/evil.ts", "+export const x = 1;") });
		expect(coverageTargetsFor(patchEv, root, CFG)).toEqual([]);
		const writeEv = event("Write", { file_path: "/etc/evil.ts", content: "export const x = 1;\n" });
		expect(coverageTargetsFor(writeEv, root, CFG)).toEqual([]);
	});

	it("accepts an in-project path that merely NORMALIZES through ../ (stays inside)", () => {
		writeFile("src/m.ts", "export const a = 1;\n");
		const ev = event("apply_patch", {
			command: patch("*** Update File: src/sub/../m.ts", "@@", "-export const a = 1;", "+export const a = 2;"),
		});
		expect(coverageTargetsFor(ev, root, CFG).map((t) => t.relPath)).toEqual(["src/m.ts"]);
	});
});

// ---------------------------------------------------------------------------
// POSITIONAL EDITED-LINES PROPERTY (finding: content-bag aliasing). When a patch
// inserts a line identical to an existing later line, the NEW occurrence's
// post-edit line number — not the shifted old one — must be in editedLines.
// ---------------------------------------------------------------------------

describe("coverageTargetsFor — editedLines are positional, not content-keyed", () => {
	it("marks the INSERTED duplicate line (position 1), not the shifted original", () => {
		writeFile("src/m.ts", "export const a = 1;\nexport const dup = 2;\n");
		// Insert a line identical to the existing later `dup` line, at the top.
		const ev = event("apply_patch", {
			command: patch(
				"*** Update File: src/m.ts",
				"@@",
				"+export const dup = 2;",
				" export const a = 1;",
				" export const dup = 2;",
			),
		});
		const targets = coverageTargetsFor(ev, root, CFG);
		expect(targets.map((t) => t.relPath)).toEqual(["src/m.ts"]);
		// LCS aligns the existing lines; only the inserted line 1 is "added". The
		// content-bag bug marked line 3 (the shifted original) instead.
		expect(targets[0].editedLines).toEqual(new Set([1]));
		expect(targets[0].editedLines?.has(3)).toBe(false);
	});
});
