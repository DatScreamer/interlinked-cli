import { describe, expect, it } from "vitest";
import { classifyTopLevelSplit, nextBracketDepth } from "./command-split-classifiers.js";

// ===========================================
// nextBracketDepth
// ===========================================

describe("nextBracketDepth", () => {
	it("opens a level on a bare '('", () => {
		expect(nextBracketDepth("(", undefined, 0)).toBe(1);
	});

	it("opens a level on '(' from a non-zero depth (nested subshells)", () => {
		expect(nextBracketDepth("(", undefined, 2)).toBe(3);
	});

	it("opens a level on '$(' (command substitution)", () => {
		expect(nextBracketDepth("$", "(", 0)).toBe(1);
	});

	it("does NOT open a level on a bare '$' not followed by '('", () => {
		expect(nextBracketDepth("$", "x", 0)).toBeNull();
	});

	it("closes a level on ')' when depth > 0", () => {
		expect(nextBracketDepth(")", undefined, 1)).toBe(0);
		expect(nextBracketDepth(")", undefined, 3)).toBe(2);
	});

	it("does NOT close on ')' when depth is already 0 (unbalanced/stray paren)", () => {
		expect(nextBracketDepth(")", undefined, 0)).toBeNull();
	});

	it("toggles depth 0 -> 1 on a backtick", () => {
		expect(nextBracketDepth("`", undefined, 0)).toBe(1);
	});

	it("toggles depth back to 0 on a closing backtick", () => {
		expect(nextBracketDepth("`", undefined, 1)).toBe(0);
	});

	it("returns null for characters that never affect nesting", () => {
		expect(nextBracketDepth("a", "b", 0)).toBeNull();
		expect(nextBracketDepth(";", undefined, 0)).toBeNull();
		expect(nextBracketDepth(undefined, undefined, 0)).toBeNull();
	});
});

// ===========================================
// classifyTopLevelSplit
// ===========================================

// Stub predicates: default to "no heredoc involvement" unless a test needs
// the glue path, keeping each case focused on the operator being exercised.
const noHeredoc = () => false;
const alwaysPendingHeredoc = () => true;

describe("classifyTopLevelSplit — newline", () => {
	it("splits a bare newline with no continuation/heredoc", () => {
		const cmd = "a\nb";
		const action = classifyTopLevelSplit(cmd, 1, "\n", undefined, noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "", split: true });
	});

	it("glues a newline preceded by a backslash line continuation", () => {
		const cmd = "a\\\nb";
		const action = classifyTopLevelSplit(cmd, 2, "\n", undefined, noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "\n", split: false });
	});

	it("glues a newline that starts a heredoc header line", () => {
		const cmd = "cat <<EOF\nbody";
		const action = classifyTopLevelSplit(cmd, 9, "\n", undefined, () => true, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "\n", split: false });
	});
});

describe("classifyTopLevelSplit — && / ||", () => {
	it("splits on '&&' with no pending heredoc", () => {
		const action = classifyTopLevelSplit("a && b", 2, "&", "&", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 1, append: "", split: true });
	});

	it("splits on '||' with no pending heredoc", () => {
		const action = classifyTopLevelSplit("a || b", 2, "|", "|", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 1, append: "", split: true });
	});

	it("glues '&&' that sits on a heredoc header line", () => {
		const action = classifyTopLevelSplit(
			"cat <<EOF && x",
			10,
			"&",
			"&",
			noHeredoc,
			alwaysPendingHeredoc,
		);
		expect(action).toEqual({ extraChars: 1, append: "&&", split: false });
	});
});

describe("classifyTopLevelSplit — ';' / single '|'", () => {
	it("splits on ';' with no pending heredoc", () => {
		const action = classifyTopLevelSplit("a; b", 1, ";", " ", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "", split: true });
	});

	it("splits on a single pipe with no pending heredoc", () => {
		const action = classifyTopLevelSplit("a | b", 2, "|", " ", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "", split: true });
	});

	it("glues ';' that sits on a heredoc header line", () => {
		const action = classifyTopLevelSplit(
			"cat <<EOF; x",
			9,
			";",
			" ",
			noHeredoc,
			alwaysPendingHeredoc,
		);
		expect(action).toEqual({ extraChars: 0, append: ";", split: false });
	});
});

describe("classifyTopLevelSplit — background '&'", () => {
	it("splits on background '&' with no redirect/heredoc context", () => {
		const action = classifyTopLevelSplit("run &", 4, "&", undefined, noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "", split: true });
	});

	it("glues '&' preceded by '>' (the '2>&1' redirect form)", () => {
		const cmd = "cmd 2>&1";
		const action = classifyTopLevelSplit(cmd, 6, "&", "1", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "&", split: false });
	});

	it("glues '&' followed by '>' (the '&>' redirect form)", () => {
		const cmd = "cmd &> log";
		const action = classifyTopLevelSplit(cmd, 4, "&", ">", noHeredoc, noHeredoc);
		expect(action).toEqual({ extraChars: 0, append: "&", split: false });
	});

	it("glues a background '&' that sits on a heredoc header line", () => {
		const action = classifyTopLevelSplit(
			"cat <<EOF & x",
			10,
			"&",
			" ",
			noHeredoc,
			alwaysPendingHeredoc,
		);
		expect(action).toEqual({ extraChars: 0, append: "&", split: false });
	});
});

describe("classifyTopLevelSplit — non-operator characters", () => {
	it("returns null for a character that isn't a compound operator", () => {
		expect(classifyTopLevelSplit("abc", 1, "b", "c", noHeredoc, noHeredoc)).toBeNull();
	});
});
