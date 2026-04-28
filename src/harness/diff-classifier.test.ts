// ===========================================
// Diff classifier — Phase B.4 of the Free-CLI roadmap
// ===========================================
// Tests are written BEFORE the implementation (TDD red→green) per the
// project's pre-commit guard. The classifier reuses `extractScannableText`
// from spans.ts to mask quoted/comment/heredoc regions, then compares the
// executed-text deltas to decide whether the diff is whitespace-only,
// comment/string-only, or semantic.

import { describe, expect, it } from "vitest";
import { classifyDiff } from "./diff-classifier.js";

describe("classifyDiff", () => {
	it("returns whitespace_only when only leading whitespace changes", () => {
		const result = classifyDiff("  a", "    a");
		expect(result.diff_class).toBe("whitespace_only");
	});

	it("returns whitespace_only when only trailing whitespace changes", () => {
		const result = classifyDiff("a\n", "a\n\n\n");
		expect(result.diff_class).toBe("whitespace_only");
	});

	it("returns whitespace_only when indentation style changes (tabs vs spaces)", () => {
		const result = classifyDiff("\tfoo()", "  foo()");
		expect(result.diff_class).toBe("whitespace_only");
	});

	it("returns comment_only when a # comment body changes", () => {
		const result = classifyDiff("a # foo", "a # bar");
		expect(result.diff_class).toBe("comment_only");
	});

	it("returns comment_only when a quoted string body changes (single quotes)", () => {
		const result = classifyDiff("echo 'a'", "echo 'b'");
		expect(result.diff_class).toBe("comment_only");
	});

	it("returns comment_only when a quoted string body changes (double quotes)", () => {
		const result = classifyDiff('echo "hello"', 'echo "world"');
		expect(result.diff_class).toBe("comment_only");
	});

	it("returns semantic when an identifier changes", () => {
		const result = classifyDiff("a", "b");
		expect(result.diff_class).toBe("semantic");
	});

	it("returns semantic when a mixed whitespace + identifier change is made", () => {
		const result = classifyDiff("foo  ()", "bar()");
		expect(result.diff_class).toBe("semantic");
	});

	it("returns semantic on an empty old (insertion)", () => {
		const result = classifyDiff("", "const x = 1;");
		expect(result.diff_class).toBe("semantic");
	});

	it("returns semantic on an empty new (deletion)", () => {
		const result = classifyDiff("const x = 1;", "");
		expect(result.diff_class).toBe("semantic");
	});

	it("returns whitespace_only when both old and new are empty", () => {
		// Idempotent identity: no actual change. Treat as whitespace_only since
		// every detector would have nothing to fire on.
		const result = classifyDiff("", "");
		expect(result.diff_class).toBe("whitespace_only");
	});

	it("returns semantic when a comment is removed and replaced with executed code", () => {
		const result = classifyDiff("# old comment", "executed_code()");
		expect(result.diff_class).toBe("semantic");
	});

	it("returns comment_only when a heredoc body changes", () => {
		const oldText = "cat <<EOF\nold body\nEOF\n";
		const newText = "cat <<EOF\nnew body\nEOF\n";
		const result = classifyDiff(oldText, newText);
		expect(result.diff_class).toBe("comment_only");
	});

	it("populates old_executed_chars and new_executed_chars for telemetry", () => {
		const result = classifyDiff("foo", "bar");
		expect(result.old_executed_chars).toBeGreaterThan(0);
		expect(result.new_executed_chars).toBeGreaterThan(0);
	});

	it("reports executed-char counts that exclude masked spans", () => {
		// `'rm -rf /'` becomes 10 spaces under the spans mask; the surrounding
		// `git commit -m ` (16 chars including the trailing space) is executed.
		const text = "git commit -m 'rm -rf /'";
		const result = classifyDiff(text, text);
		// All executed chars are in `git commit -m `; the quoted region is masked.
		expect(result.old_executed_chars).toBeLessThan(text.length);
		expect(result.new_executed_chars).toBeLessThan(text.length);
	});

	it("classifies a multi-line edit that only adds blank lines as whitespace_only", () => {
		const oldText = "function foo() {\n  return 1;\n}";
		const newText = "function foo() {\n\n  return 1;\n\n}";
		const result = classifyDiff(oldText, newText);
		expect(result.diff_class).toBe("whitespace_only");
	});

	it("classifies an edit that adds a new statement as semantic", () => {
		const oldText = "const x = 1;\n";
		const newText = "const x = 1;\nconst y = 2;\n";
		const result = classifyDiff(oldText, newText);
		expect(result.diff_class).toBe("semantic");
	});
});
