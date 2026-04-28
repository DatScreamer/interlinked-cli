import { describe, expect, it } from "vitest";
import { classifySpans, extractScannableText } from "./spans.js";

describe("classifySpans", () => {
	it("returns a single executed span for a plain command", () => {
		const spans = classifySpans("rm -rf /");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("executed");
		expect(spans[0]?.text).toBe("rm -rf /");
	});

	it("classifies single-quoted regions as quoted", () => {
		const cmd = "git commit -m 'rm -rf /'";
		const spans = classifySpans(cmd);
		const quoted = spans.find((s) => s.kind === "quoted");
		expect(quoted?.text).toBe("'rm -rf /'");
	});

	it("classifies double-quoted regions as quoted", () => {
		const cmd = 'echo "hello world"';
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "quoted" && s.text === '"hello world"')).toBe(true);
	});

	it("classifies $'...' ANSI-C quoted regions as quoted", () => {
		const cmd = "echo $'hello\\nworld'";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "quoted")).toBe(true);
	});

	it("classifies # comments as comment", () => {
		const cmd = "rm -rf / # don't actually do this";
		const spans = classifySpans(cmd);
		const comment = spans.find((s) => s.kind === "comment");
		expect(comment?.text).toBe("# don't actually do this");
	});

	it("does not treat # inside a token as a comment", () => {
		const cmd = "echo abc#xyz";
		const spans = classifySpans(cmd);
		expect(spans.every((s) => s.kind !== "comment")).toBe(true);
	});

	it("classifies heredoc bodies as heredoc", () => {
		const cmd = "cat <<EOF\nrm -rf /\nEOF\n";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "heredoc")).toBe(true);
	});

	it("covers the full input contiguously", () => {
		const cmd = "git commit -m 'rm -rf /' # dangerous\necho ok";
		const spans = classifySpans(cmd);
		// Every byte in [0, cmd.length) covered by exactly one span.
		const reassembled = spans.map((s) => s.text).join("");
		expect(reassembled).toBe(cmd);
	});

	it("preserves byte offsets between spans", () => {
		const cmd = "a 'b' c";
		const spans = classifySpans(cmd);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i]?.start).toBe(spans[i - 1]?.end);
		}
	});
});

describe("extractScannableText", () => {
	it("replaces quoted text with same-length whitespace", () => {
		const cmd = "git commit -m 'rm -rf /'";
		const out = extractScannableText(cmd);
		expect(out).toHaveLength(cmd.length);
		expect(out).not.toContain("rm");
	});

	it("replaces comments with whitespace", () => {
		const cmd = "ls # this comment has rm -rf in it";
		const out = extractScannableText(cmd);
		expect(out).toContain("ls");
		expect(out).not.toContain("rm");
	});

	it("preserves executed text untouched", () => {
		const cmd = "rm -rf /";
		expect(extractScannableText(cmd)).toBe("rm -rf /");
	});

	it("preserves index alignment for regex matching", () => {
		const cmd = "ls && 'rm -rf /' && pwd";
		const out = extractScannableText(cmd);
		expect(out.indexOf("ls")).toBe(cmd.indexOf("ls"));
		expect(out.indexOf("pwd")).toBe(cmd.indexOf("pwd"));
		// 'rm -rf /' should be all whitespace in `out`.
		expect(out.slice(cmd.indexOf("'"), cmd.indexOf("'") + "'rm -rf /'".length)).toMatch(/^\s+$/);
	});

	it("a destructive regex against scannable text does not fire on quoted occurrences", () => {
		const cmd = "git commit -m 'rm -rf /'";
		expect(/\brm\s+-rf\b/.test(cmd)).toBe(true); // raw input would falsely match
		expect(/\brm\s+-rf\b/.test(extractScannableText(cmd))).toBe(false); // sanitized input does not
	});
});
