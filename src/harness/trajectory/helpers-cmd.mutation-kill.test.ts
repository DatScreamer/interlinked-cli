import { describe, expect, it } from "vitest";
import {
	anchorHash,
	commandFamily,
	commandHeads,
	hasEgressVerb,
	isEgressCommandToExternalHost,
	isVerifyCommand,
	normalizeCommand,
	sha256,
	splitSegments,
} from "./helpers.js";

// Mutation-kill companion targeting anchorHash, normalizeCommand, commandFamily
// / commandHeads own literals, splitSegments, EGRESS_VERBS / PREFIX_SKIP, and
// the egress-verb / verify-command composition functions. Mutant-id -> fixture
// mapping lives in scratch/fleet-r3/receipts/src_harness_trajectory_helpers.ts.jsonl.

describe("anchorHash — pinned to the exact sha256(first + \\x00 + last) formula", () => {
	it("two real non-empty lines: first and last are exactly what the formula predicts", () => {
		expect(anchorHash("ab\ncd")).toBe(sha256("ab\x00cd"));
	});

	it("the empty-input sentinel is exactly sha256('\\x00empty'), taken only when lines truly is empty", () => {
		expect(anchorHash("")).toBe(sha256("\x00empty"));
	});

	it("blank lines (incl. a trailing one) are filtered before first/last are picked, not kept as ''", () => {
		expect(anchorHash("ab\ncd\n\n")).toBe(sha256("ab\x00cd"));
	});
});

describe("normalizeCommand", () => {
	it("collapse-then-trim: leading/trailing whitespace runs must be removed, not just collapsed", () => {
		expect(normalizeCommand("  ls -la  ")).toBe("ls -la");
	});

	it("an internal multi-char whitespace run collapses to ONE space, not one-per-char", () => {
		expect(normalizeCommand("a\t\tb")).toBe("a b");
	});

	it("a multi-digit hex literal is matched and replaced with 0xN as a whole (quantifier, digit class, replacement text)", () => {
		expect(normalizeCommand("port 0xFF")).toBe("port 0xN");
	});

	it("a multi-digit decimal (incl. a multi-digit fraction) collapses to one N, not a split N.N", () => {
		expect(normalizeCommand("wait 1.234")).toBe("wait N");
		expect(normalizeCommand("wait 42")).toBe("wait N");
	});
});

describe("commandFamily — own literals (trim before split, and the split regex)", () => {
	it("leading whitespace must be trimmed before the head-verb split, not left as an empty first token", () => {
		expect(commandFamily("  foobar arg1")).toBe("foobar");
	});
});

describe("commandHeads / hasEgressVerb — every EGRESS_VERBS string literal is independently load-bearing", () => {
	it.each([
		"nc", "ncat", "netcat", "scp", "sftp", "rsync",
		"telnet", "ftp", "socat", "http", "https", "httpie",
	])("%s alone makes hasEgressVerb true", (verb) => {
		expect(hasEgressVerb(`${verb} example.com`)).toBe(true);
	});

	it("a non-verb head is not egress (control for the table above)", () => {
		expect(hasEgressVerb("ls -la")).toBe(false);
	});

	it("ANY segment head being an egress verb is enough (some, not every)", () => {
		expect(hasEgressVerb("curl example.com && ls")).toBe(true);
	});
});

describe("commandHeads — PREFIX_SKIP anchors (^ and $)", () => {
	it("a token that merely ENDS in a skip-word (no leading ^ match) is not itself a prefix to skip", () => {
		expect(commandHeads("asudo curl example.com")).toEqual(["asudo"]);
	});

	it("a token that merely STARTS with a skip-word (no trailing $ match) is not itself a prefix to skip", () => {
		expect(commandHeads("sudoedit example.com")).toEqual(["sudoedit"]);
	});
});

describe("splitSegments — trim, and the final non-empty filter", () => {
	it("whitespace around a delimiter is trimmed off each segment", () => {
		expect(splitSegments("curl a.com ; ls")).toEqual(["curl a.com", "ls"]);
	});

	it("a doubled delimiter must not leave a blank '' segment in the result", () => {
		expect(splitSegments("ls;;pwd")).toEqual(["ls", "pwd"]);
	});
});

describe("isEgressCommandToExternalHost / isVerifyCommand — composition guards", () => {
	it("a non-egress command with an incidentally external-looking argument is still not an egress command", () => {
		expect(isEgressCommandToExternalHost("echo example.com")).toBe(false);
	});

	it("ANY extracted host being external is enough (some, not every)", () => {
		expect(isEgressCommandToExternalHost("curl 10.0.0.1 example.com")).toBe(true);
	});

	it("a fallback (non test/build/lint) family is not a verify command", () => {
		expect(isVerifyCommand("ls -la")).toBe(false);
	});
});
