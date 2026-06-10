// ===========================================
// test-portability — env-divergent test detection (finding 2026-06)
// ===========================================
// Two write-time detectors born from a red CI run that local validation never
// saw coming (both tests passed on the dev Mac, failed on every runner):
//   1. a test whose COMMENT narrates platform-conditional behavior while its
//      assertions run unconditionally (the config-loosening symlink test relied
//      on macOS's /tmp symlink; Linux made the gate legitimately fire);
//   2. a silent early-return availability guard (`if (!X_AVAILABLE) return;`)
//      that records a PASS where the external dependency is missing — coverage
//      theater that hid the rg gap on CI until an unguarded sibling failed.

import { describe, expect, it } from "vitest";
import {
	checkPlatformConditionalAssertion,
	checkSilentDependencySkip,
} from "./test-portability.js";

const TEST_PATH = "src/feature.test.ts";

describe("checkPlatformConditionalAssertion", () => {
	it("fires when a comment narrates platform-variance and the file has no platform gate", () => {
		const content = [
			"it('fails open', () => {",
			"  // On platforms where the temp dir lives under a symlink (macOS",
			"  // /var -> /private/var), the unresolved path diverges from git's root.",
			"  expect(decision).toBeNull();",
			"});",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(matches[0].text).toMatch(/platform/i);
	});

	it("fires on a 'macOS-only' comment without any gate", () => {
		const content = "// this trick is macOS-only\nit('x', () => { expect(1).toBe(1); });\n";
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("fires on 'platform-dependent' narration without a gate", () => {
		const content = "/* the fixture is platform-dependent */\nit('x', () => {});\n";
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("stays quiet when the file gates on process.platform", () => {
		const content = [
			"// On platforms where /tmp is a symlink this diverges.",
			"const onMac = process.platform === 'darwin';",
			"it.skipIf(!onMac)('x', () => {});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("stays quiet when the file uses skipIf/runIf gating", () => {
		const content = [
			"// linux-only path semantics below",
			"describe.skipIf(IS_NOT_LINUX)('paths', () => {});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("ignores neutral platform mentions ('on every platform', 'all platforms')", () => {
		const content = [
			"// the condition exists on every platform — constructed explicitly",
			"// works across all platforms",
			"it('x', () => {});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("ignores non-test files entirely", () => {
		const content = "// macOS-only fast path\nexport const x = 1;\n";
		expect(checkPlatformConditionalAssertion(content, "src/feature.ts")).toEqual([]);
	});
});

describe("checkSilentDependencySkip", () => {
	it("fires on the early-return availability guard", () => {
		const content = [
			"const RG_AVAILABLE = findRipgrep() !== null;",
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('match');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(matches[0].line).toBe(3);
		expect(matches[0].text).toMatch(/skipIf/);
	});

	it("fires on camelCase availability flags and explicit null/false comparisons", () => {
		const content = [
			"it('a', () => { if (!radonAvailable) return; });",
			"it('b', () => {",
			"  if (dockerAvailable === false) return;",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(2);
	});

	it("fires once per guard line in a file with several", () => {
		const content = [
			"it('a', () => { if (!RG_AVAILABLE) return; });",
			"it('b', () => { if (!RG_AVAILABLE) return; });",
			"it('c', () => { if (!RG_AVAILABLE) return; });",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(3);
	});

	it("stays quiet for it.skipIf — the visible, reported form", () => {
		const content = [
			"const RG_AVAILABLE = findRipgrep() !== null;",
			"it.skipIf(!RG_AVAILABLE)('uses rg', () => {",
			"  expect(runRg()).toContain('match');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("stays quiet for ordinary early returns that are not availability guards", () => {
		const content = [
			"it('x', () => {",
			"  if (!result) return;",
			"  if (!parsed.ok) return;",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("ignores non-test files (source code may guard on availability freely)", () => {
		const content = "if (!RG_AVAILABLE) return;\n";
		expect(checkSilentDependencySkip(content, "src/grep-accelerator.ts")).toEqual([]);
	});
});
