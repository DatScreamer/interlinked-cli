import { describe, expect, it } from "vitest";
import { detectToolMiss } from "../tool-miss.js";

describe("detectToolMiss", () => {
	it("returns null for buffers outside the min/max size window", () => {
		expect(detectToolMiss("x")).toBeNull();
		expect(detectToolMiss("y".repeat(20_000))).toBeNull();
	});

	it("detects common 'command not found' tools and returns an install hint", () => {
		expect(detectToolMiss("bash: command not found: rg")).toMatch(
			/ripgrep .* brew install ripgrep/,
		);
		expect(detectToolMiss("bash: command not found: jq")).toMatch(/brew install jq/);
		expect(detectToolMiss("bash: command not found: gh")).toMatch(/brew install gh/);
	});

	it("detects BSD/GNU incompatibilities on macOS", () => {
		// Pattern strings must match the exact shapes in TOOL_MISS_FIXES.
		expect(detectToolMiss("grep: invalid option: -P")).toMatch(/PCRE.*brew install grep/);
		expect(detectToolMiss("sed: -i may not be used with stdin: requires an extension")).toMatch(
			/gnu-sed/,
		);
		expect(detectToolMiss("readlink: illegal option -f")).toMatch(/coreutils/);
	});

	it("prefixes matches with the [interlinked:tool-miss] tag", () => {
		expect(
			detectToolMiss("bash: command not found: rg")?.startsWith("[interlinked:tool-miss]"),
		).toBe(true);
	});

	it("returns null for unrelated output", () => {
		expect(detectToolMiss("hello world — nothing to see here")).toBeNull();
	});
});
