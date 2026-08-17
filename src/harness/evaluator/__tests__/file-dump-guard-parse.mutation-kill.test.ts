// Mutation-kill companion for file-dump-guard-parse.test.ts.
//
// Targets the 90 survivors recorded by
// `mutation survivors --file file-dump-guard-parse.ts --json` (fleet-r3,
// 2026-08-12). Each case is designed to distinguish the SPECIFIC textual
// mutation it targets from the pristine behavior — see
// scratch/fleet-r3/src_harness_evaluator_file-dump-guard-parse.ts-shadow-verify.mts
// for the empirical kill mapping (mutantId -> fixture label) this file
// mirrors, and scratch/fleet-r3/receipts/src_harness_evaluator_file-dump-guard-parse.ts.jsonl
// for the per-mutant disposition.
//
// `firstCommandGroup` had ZERO prior test coverage despite being the
// module's most heavily-mutated symbol (27 open survivors) — its block below
// is the first real coverage this function has received.

import { describe, expect, it } from "vitest";
import {
	extractFilePaths,
	firstCommandGroup,
	formatBytes,
	hasFollowFlag,
	hasOutputRedirect,
	parseCountFlag,
	splitPipeline,
	stripLeadingWrappers,
	stripPathPrefix,
	tokenize,
} from "../file-dump-guard-parse.js";

describe("firstCommandGroup — positive (must fire)", () => {
	it("P1: a `;` outside any quote splits the command", () => {
		expect(firstCommandGroup('"a" ; b')).toBe('"a" ');
	});

	it("P2: a newline is a boundary", () => {
		expect(firstCommandGroup("a\nb")).toBe("a");
	});

	it("P3: `&&` is a boundary", () => {
		expect(firstCommandGroup("a&&b")).toBe("a");
	});

	it("P4: `||` is a boundary", () => {
		expect(firstCommandGroup("a||b")).toBe("a");
	});
});

describe("firstCommandGroup — negative (must not fire)", () => {
	it("N1: a double-quoted `;` is protected — whole command comes back unchanged", () => {
		expect(firstCommandGroup('"a;b"')).toBe('"a;b"');
	});

	it("N2: a single-quoted `;` is protected", () => {
		expect(firstCommandGroup("'a;b'")).toBe("'a;b'");
	});

	it("N3: a backtick-quoted `;` is protected", () => {
		expect(firstCommandGroup("`a;b`")).toBe("`a;b`");
	});

	it("N4: an empty quoted string followed by `;` — the quote must close on its own closing char, not on the next char it happens to see", () => {
		// Sharp differentiator for `ch === q` inversions/forced-true/forced-false:
		// pristine closes the quote exactly at the second `"`, so the `;` right
		// after is a real (unprotected) boundary.
		expect(firstCommandGroup('"";b')).toBe('""');
	});

	it("N5: no boundary present returns the full command untouched", () => {
		expect(firstCommandGroup("echo hello")).toBe("echo hello");
	});

	it("N6: a single `&` (backgrounding) is not a boundary", () => {
		expect(firstCommandGroup("cmd &")).toBe("cmd &");
	});

	it("N7: a single `|` (an ordinary pipe) is not a boundary at this level", () => {
		expect(firstCommandGroup("cmd | grep x")).toBe("cmd | grep x");
	});
});

describe("stripLeadingWrappers — positive (must fire)", () => {
	it("P1: a bare `sudo` token strips down to an empty array without throwing", () => {
		const tokens = ["sudo"];
		expect(() => stripLeadingWrappers(tokens)).not.toThrow();
		expect(tokens).toEqual([]);
	});

	it("P2: `exec` strips as a wrapper", () => {
		const tokens = ["exec", "cat", "f"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cat", "f"]);
	});

	it("P3: `nohup` strips as a wrapper", () => {
		const tokens = ["nohup", "cmd"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cmd"]);
	});

	it("P4: `command` strips as a wrapper", () => {
		const tokens = ["command", "cmd"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["cmd"]);
	});

	it("P5: a multi-letter bare assignment strips fully", () => {
		const tokens = ["FOO=bar", "x"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["x"]);
	});

	it("P6: a multi-letter assignment after `env` strips fully", () => {
		const tokens = ["env", "FOO=bar", "x"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["x"]);
	});
});

describe("stripLeadingWrappers — negative (must not fire)", () => {
	it("N1: a digit-leading, assignment-shaped bare token is not stripped (the `^` anchor matters)", () => {
		const tokens = ["1FOO=bar", "x"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["1FOO=bar", "x"]);
	});

	it("N2: a digit-leading, assignment-shaped token right after `env` is not stripped either", () => {
		const tokens = ["env", "1FOO=bar", "x"];
		stripLeadingWrappers(tokens);
		expect(tokens).toEqual(["1FOO=bar", "x"]);
	});
});

describe("extractFilePaths — positive (must fire)", () => {
	it("P1: `-c` is a value-taking flag — its value token is skipped, not collected", () => {
		expect(extractFilePaths(["tail", "-c", "5", "file.txt"], "tail")).toEqual(["file.txt"]);
	});

	it("P2: `--lines` is a value-taking flag", () => {
		expect(extractFilePaths(["tail", "--lines", "5", "file.txt"], "tail")).toEqual(["file.txt"]);
	});

	it("P3: `--bytes` is a value-taking flag", () => {
		expect(extractFilePaths(["tail", "--bytes", "5", "file.txt"], "tail")).toEqual(["file.txt"]);
	});

	it("P4: an empty-string token is skipped, never collected as a path", () => {
		expect(extractFilePaths(["cat", "", "file.txt"], "cat")).toEqual(["file.txt"]);
	});

	it("P5: after `--`, remaining tokens are taken verbatim but an empty one is still dropped", () => {
		expect(extractFilePaths(["cat", "--", "", "real.txt"], "cat")).toEqual(["real.txt"]);
	});
});

describe("extractFilePaths — negative (must not fire)", () => {
	it("N1: a backtick-wrapped token bails as a command-substitution shape", () => {
		expect(extractFilePaths(["cat", "`cmd`"], "cat")).toEqual([]);
	});

	it("N2: a token containing `$(` bails even without a leading backtick", () => {
		expect(extractFilePaths(["cat", "a$(x)b"], "cat")).toEqual([]);
	});

	it("N3: an unclosed leading-backtick token still bails (startsWith, not endsWith)", () => {
		expect(extractFilePaths(["cat", "`cmd"], "cat")).toEqual([]);
	});
});

describe("splitPipeline — mutation-kill positive (must fire)", () => {
	it("P1: a single-quoted `|` is protected from the split", () => {
		expect(splitPipeline("echo 'a|b'")).toEqual(["echo 'a|b'"]);
	});

	it("P2: a backtick-quoted `|` is protected from the split", () => {
		expect(splitPipeline("echo `a|b`")).toEqual(["echo `a|b`"]);
	});

	it("P3: a trailing pipe with nothing after it does not push a trailing empty segment", () => {
		expect(splitPipeline("echo a|")).toEqual(["echo a"]);
	});
});

describe("hasOutputRedirect — mutation-kill negative (must not fire)", () => {
	it("N5: a single-quoted `>` is protected", () => {
		expect(hasOutputRedirect("echo 'a>b'")).toBe(false);
	});

	it("N6: a backtick-quoted `>` is protected", () => {
		expect(hasOutputRedirect("echo `a>b`")).toBe(false);
	});
});

describe("parseCountFlag — mutation-kill positive (must fire)", () => {
	it("P5: `--bytes=N` resolves for the `-c` short flag", () => {
		expect(parseCountFlag(["cmd", "--bytes=5"], "-c")).toBe(5);
	});

	it("P6: a non-matching token before a real `-n` flag must not short-circuit the scan", () => {
		expect(parseCountFlag(["cmd", "randomtoken", "-n", "50"], "-n")).toBe(50);
	});

	it("P7: a long-flag-shaped combined token (`--lines50`, no `=`) before a real `-n` flag must not be mistaken for a match — the scan must continue", () => {
		expect(parseCountFlag(["cmd", "--lines50", "-n", "50"], "-n")).toBe(50);
	});

	it("P8: a long garbage token before a real `-n` flag must not short-circuit the scan", () => {
		expect(parseCountFlag(["cmd", "xxxxx", "-n", "50"], "-n")).toBe(50);
	});
});

describe("parseCountFlag — mutation-kill negative (must not fire)", () => {
	it("N4: digits not at the start of the value token do not parse (parseLeadingInt is anchored)", () => {
		expect(parseCountFlag(["tail", "-n", "x50"], "-n")).toBeNull();
	});
});

describe("hasFollowFlag — mutation-kill negative (must not fire)", () => {
	it("N3: a `--long` flag whose text happens to contain `f` must not be mistaken for `-f`", () => {
		expect(hasFollowFlag(["cmd", "--format=json"])).toBe(false);
	});
});

describe("formatBytes — mutation-kill boundary (must fire)", () => {
	it("P4: exactly 1024 bytes renders as `1KB`, not `1024B`", () => {
		expect(formatBytes(1024)).toBe("1KB");
	});

	it("P5: exactly 1MB renders as `1.0MB`, not `1024KB`", () => {
		expect(formatBytes(1024 * 1024)).toBe("1.0MB");
	});
});

describe("stripPathPrefix — mutation-kill negative (must not fire)", () => {
	it("N2: a leading-slash-only path strips to the remainder (idx === 0 is still `>= 0`)", () => {
		expect(stripPathPrefix("/etc")).toBe("etc");
	});
});

describe("tokenize — mutation-kill positive (must fire)", () => {
	it("P3: single-quoted content with an embedded space stays one token", () => {
		expect(tokenize("echo 'a b'")).toEqual(["echo", "a b"]);
	});
});
