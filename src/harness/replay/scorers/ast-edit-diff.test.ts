// T1 structural scorers — AST multiset distance for code edits (formatting-
// insensitive where string diffs are not) and argv token distance for Bash
// (docs/design/reproducibility/tier1-teacher-forced-eval.md). The TS compiler
// is runtime-loaded the same way the cyclomatic gate loads it; when absent
// the scorer degrades to comparable:false rather than lying.

import { describe, expect, it } from "vitest";
import { argvDistance, astAvailable, astEditDistance, scoreEditActions } from "./ast-edit-diff.js";

describe("astEditDistance", () => {
	it("scores identical code as zero distance", () => {
		expect(astAvailable()).toBe(true);
		const d = astEditDistance("const a = 1;\n", "const a = 1;\n");
		expect(d.comparable).toBe(true);
		expect(d.distance).toBe(0);
		expect(d.normalized).toBe(0);
	});

	it("is formatting-insensitive (whitespace/newline churn scores zero)", () => {
		const d = astEditDistance("const a=1;const b=2;", "const a = 1;\n\nconst b = 2;\n");
		expect(d.distance).toBe(0);
	});

	it("scores a rename as a small nonzero distance", () => {
		const d = astEditDistance("const alpha = 1;\n", "const beta = 1;\n");
		expect(d.distance).toBeGreaterThan(0);
		expect(d.normalized).toBeLessThan(0.5);
	});

	it("scores structural change larger than a rename", () => {
		const rename = astEditDistance("const alpha = 1;", "const beta = 1;");
		const rewrite = astEditDistance("const alpha = 1;", "function alpha() { return compute(1) + 2; }");
		expect(rewrite.distance).toBeGreaterThan(rename.distance);
	});

	it("normalized stays within [0, 1]", () => {
		const d = astEditDistance("const a = 1;", "class Totally { different(): void {} }");
		expect(d.normalized).toBeGreaterThan(0);
		expect(d.normalized).toBeLessThanOrEqual(1);
	});
});

describe("argvDistance", () => {
	it("identical commands score zero", () => {
		expect(argvDistance("git status --short", "git status --short").distance).toBe(0);
	});

	it("flag differences count, order does not", () => {
		expect(argvDistance("ls -la /tmp", "ls /tmp -la").distance).toBe(0);
		expect(argvDistance("ls -la /tmp", "ls -l /tmp").distance).toBe(2);
	});
});

describe("scoreEditActions — routes by tool", () => {
	it("compares Edit new_strings structurally", () => {
		const score = scoreEditActions(
			{ tool: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "const x=1;" } },
			{ tool: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "const x = 1;" } },
		);
		expect(score?.kind).toBe("ast");
		expect(score?.distance).toBe(0);
	});

	it("compares Write contents structurally", () => {
		const score = scoreEditActions(
			{ tool: "Write", input: { file_path: "/x.ts", content: "const a = 1;" } },
			{ tool: "Write", input: { file_path: "/x.ts", content: "const b = 2;" } },
		);
		expect(score?.kind).toBe("ast");
		expect(score?.distance).toBeGreaterThan(0);
	});

	it("compares Bash commands by argv", () => {
		const score = scoreEditActions(
			{ tool: "Bash", input: { command: "npm test" } },
			{ tool: "Bash", input: { command: "npm run test" } },
		);
		expect(score?.kind).toBe("argv");
		expect(score?.distance).toBe(1);
	});

	it("returns null for tools it does not model", () => {
		expect(
			scoreEditActions(
				{ tool: "Glob", input: { pattern: "*" } },
				{ tool: "Glob", input: { pattern: "*" } },
			),
		).toBeNull();
	});
});
