import { describe, expect, it } from "vitest";
import { detectToolMiss } from "../tool-miss.js";

describe("detectToolMiss — mutation-kill wave 33", () => {
	// test-contract: kill — length guard (whole `||` condition, `&&` swap, single
	// `>MAX` clause, and the emptied if-block) must all still block oversized
	// buffers instead of falling through to pattern matching.
	it("blocks an over-MAX-length buffer even though it contains a matching pattern", () => {
		const longOutput = "x".repeat(20_000) + "bash: command not found: rg";
		expect(detectToolMiss(longOutput)).toBeNull();
	});

	// test-contract: kill — grep's `\s+` must require at least one but tolerate
	// more than one whitespace char before the literal "invalid option".
	it("matches grep option error across multiple whitespace chars", () => {
		expect(detectToolMiss("grep:  invalid option -P")).toMatch(/PCRE/);
	});

	// test-contract: kill — both `.*` wildcards in the readlink pattern must
	// tolerate more than a single character in their gap.
	it("matches readlink option error with extra padding in both wildcard gaps", () => {
		expect(detectToolMiss("readlink:  illegal option  -f")).toMatch(/coreutils/);
	});

	// test-contract: kill — both `.*` wildcards AND the fix string for date.
	it("matches date option error with padding and returns the exact fix text", () => {
		expect(detectToolMiss("date:  illegal option  -d")).toBe(
			"[interlinked:tool-miss] macOS date lacks -d. Install coreutils: brew install coreutils (use gdate)",
		);
	});

	// test-contract: kill — both `.*` wildcards AND the fix string for xargs.
	it("matches xargs option error with padding and returns the exact fix text", () => {
		expect(detectToolMiss("xargs:  illegal option  -r")).toBe(
			"[interlinked:tool-miss] macOS xargs lacks -r (no-run-if-empty). On macOS, xargs already behaves this way by default",
		);
	});

	// test-contract: kill — both `.*` wildcards AND the fix string for sort.
	it("matches sort option error with padding and returns the exact fix text", () => {
		expect(detectToolMiss("sort:  illegal option  -V")).toBe(
			"[interlinked:tool-miss] macOS sort lacks -V (version sort). Install coreutils: brew install coreutils (use gsort)",
		);
	});

	// test-contract: kill — rg's `\s*` must tolerate zero whitespace chars.
	it("matches 'command not found: rg' with zero whitespace before the tool name", () => {
		expect(detectToolMiss("bash: command not found:rg")).toMatch(/ripgrep/);
	});

	// test-contract: kill — fd's `\s*` (zero whitespace) AND the fd fix string.
	it("matches fd with zero whitespace and returns the exact fix text", () => {
		expect(detectToolMiss("bash: command not found:fd")).toBe(
			"[interlinked:tool-miss] fd not installed. Install: brew install fd",
		);
	});

	// test-contract: kill — fd's `\s*` must also tolerate one whitespace char
	// (the `\S*` mutant only accepts non-whitespace and fails here).
	it("matches fd with a single whitespace char before the tool name", () => {
		expect(detectToolMiss("bash: command not found: fd")).toMatch(/brew install fd/);
	});

	// test-contract: kill — bat's `\s*` (zero whitespace) AND the bat fix string.
	it("matches bat with zero whitespace and returns the exact fix text", () => {
		expect(detectToolMiss("bash: command not found:bat")).toBe(
			"[interlinked:tool-miss] bat not installed. Install: brew install bat",
		);
	});

	// test-contract: kill — bat's `\s*` must tolerate one whitespace char.
	it("matches bat with a single whitespace char before the tool name", () => {
		expect(detectToolMiss("bash: command not found: bat")).toMatch(/brew install bat/);
	});

	// test-contract: kill — jq's `\s*` must tolerate zero whitespace chars.
	it("matches jq with zero whitespace before the tool name", () => {
		expect(detectToolMiss("bash: command not found:jq")).toMatch(/brew install jq/);
	});

	// test-contract: kill — yq's `\s*` (zero whitespace) AND the yq fix string.
	it("matches yq with zero whitespace and returns the exact fix text", () => {
		expect(detectToolMiss("bash: command not found:yq")).toBe(
			"[interlinked:tool-miss] yq not installed. Install: brew install yq",
		);
	});

	// test-contract: kill — yq's `\s*` must tolerate one whitespace char.
	it("matches yq with a single whitespace char before the tool name", () => {
		expect(detectToolMiss("bash: command not found: yq")).toMatch(/brew install yq/);
	});

	// test-contract: kill — gh's `\s*` must tolerate zero whitespace chars.
	it("matches gh with zero whitespace before the tool name", () => {
		expect(detectToolMiss("bash: command not found:gh")).toMatch(/brew install gh/);
	});

	// test-contract: kill — bun's `\s*` (zero whitespace) AND the bun fix string.
	it("matches bun with zero whitespace and returns the exact fix text", () => {
		expect(detectToolMiss("bash: command not found:bun")).toBe(
			"[interlinked:tool-miss] Bun not installed. Install: brew install oven-sh/bun/bun",
		);
	});

	// test-contract: kill — bun's `\s*` must tolerate one whitespace char.
	it("matches bun with a single whitespace char before the tool name", () => {
		expect(detectToolMiss("bash: command not found: bun")).toMatch(/brew install oven-sh\/bun\/bun/);
	});

	// test-contract: kill — pnpm's `\s*` (zero whitespace) AND the pnpm fix string.
	it("matches pnpm with zero whitespace and returns the exact fix text", () => {
		expect(detectToolMiss("bash: command not found:pnpm")).toBe(
			"[interlinked:tool-miss] pnpm not installed. Install: brew install pnpm",
		);
	});

	// test-contract: kill — pnpm's `\s*` must tolerate one whitespace char.
	it("matches pnpm with a single whitespace char before the tool name", () => {
		expect(detectToolMiss("bash: command not found: pnpm")).toMatch(/brew install pnpm/);
	});
});
