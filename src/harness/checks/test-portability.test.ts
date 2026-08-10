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
//
// Hardened per two review rounds (2026-06); the "review regressions" blocks
// below pin each reported FP/FN class: evidence tied to the narrated test,
// platform-related gate conditions (a docker gate is not platform evidence),
// expression-bodied call extents (a gated one-liner must not swallow and
// vouch for its sibling), braced consequents, guards scoped to test callback
// spans (helpers/hooks exempt), strict test-file gating, and literal masking.
// The dogfood sweep at the bottom runs both detectors over every committed
// test file, so a fixture added anywhere in the suite can never reintroduce
// the FP class.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { isStrictTestFile } from "./shared.js";
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
		expect(nonNull(matches[0]).text).toMatch(/platform/i);
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

describe("checkPlatformConditionalAssertion — evidence tied to the narrated test (review 2026-06)", () => {
	it("fires when an UNRELATED sibling is gated but the narrated test is not", () => {
		const content = [
			"const DOCKER_AVAILABLE = hasDocker();",
			"it.skipIf(!DOCKER_AVAILABLE)('talks to the daemon', () => {",
			"  expect(client.ping()).toBe(true);",
			"});",
			"",
			"// linux-only: the raw socket path has no macOS equivalent",
			"it('binds the raw socket', () => {",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(6);
	});

	it("fires when process.platform appears only in a comment (prose is not evidence)", () => {
		const content = [
			"// macOS-only: relies on the /tmp -> /private/tmp symlink",
			"// TODO: should gate on process.platform someday",
			"it('resolves the symlinked temp dir', () => {",
			"  expect(resolveTmp()).toBe('/private/tmp');",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("stays quiet when the gate sits on the narrated test, even with ungated siblings", () => {
		const content = [
			"// linux-only ioctl behavior",
			"it.skipIf(process.platform !== 'linux')('uses the ioctl', () => {",
			"  expect(ioctl()).toBe(0);",
			"});",
			"it('unrelated, runs everywhere', () => { expect(1).toBe(1); });",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("counts a process.platform branch inside the narrated test's body as evidence", () => {
		const content = [
			"it('adjusts path separators', () => {",
			"  // windows-only quirk in the expectation below",
			"  const expected = process.platform === 'win32' ? 'a\\\\b' : 'a/b';",
			"  expect(joinPath('a', 'b')).toBe(expected);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("resolves platform-derived constants referenced in the narrated test's body", () => {
		const content = [
			"const onLinux = process.platform === 'linux';",
			"describe('socket suite', () => {",
			"  it('binds', (ctx) => {",
			"    // linux-only raw socket semantics",
			"    if (!onLinux) { ctx.skip(); return; }",
			"    expect(bind()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("inherits a describe.skipIf gate for narration inside a child test", () => {
		const content = [
			"describe.skipIf(process.platform !== 'darwin')('keychain', () => {",
			"  it('stores the token', () => {",
			"    // macOS-only keychain API under test",
			"    expect(store()).toBe(true);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("does not read narration from comment-shaped lines inside template fixtures", () => {
		const content = [
			"const fixture = `",
			"// this trick is macOS-only",
			"it('x', () => {});",
			"`;",
			"it('parses narration fixtures', () => {",
			"  expect(parse(fixture)).toHaveLength(1);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("stays out of non-JS test files (its gating idioms are JS-specific)", () => {
		const content = "/* linux-only quirk documented here */\nconst x = probe();\n";
		expect(checkPlatformConditionalAssertion(content, "tests/test_x.py")).toEqual([]);
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});
});

describe("checkPlatformConditionalAssertion — gates must be platform-related (review round 2)", () => {
	it("fires when the narrated test's only gate is a dependency condition", () => {
		const content = [
			"// linux-only: raw socket semantics differ",
			"it.skipIf(!dockerAvailable)('binds inside the container', () => {",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(1);
	});

	it("stays quiet when the gate condition mixes the platform in", () => {
		const content = [
			"// linux-only: raw socket semantics differ",
			"it.skipIf(!dockerAvailable || process.platform !== 'linux')('binds', () => {",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("accepts platform-named flags imported from helper modules", () => {
		const content = [
			"import { IS_WINDOWS } from './platform-helpers.js';",
			"// windows-only path separator handling",
			"it.skipIf(!IS_WINDOWS)('joins with backslashes', () => {",
			"  expect(joinPath('a', 'b')).toBe('a\\\\b');",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("accepts an unconditional .skip on the narrated test (the case never runs)", () => {
		const content = [
			"// macOS-only quirk acknowledged below",
			"it.skip('handles the quirk', () => {",
			"  expect(quirk()).toBe(1);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("fires past a gated expression-bodied sibling (span must not swallow it)", () => {
		const content = [
			"const onMac = process.platform === 'darwin';",
			"it.skipIf(!onMac)('mac fast path', () => expect(macProbe()).toBe(1));",
			"// linux-only: must still be flagged despite the gated sibling above",
			"it('binds the raw socket', () => {",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(3);
	});
});

describe("checkPlatformConditionalAssertion — runtime skips are judged by their condition (review round 3)", () => {
	it("fires when the only runtime skip is guarded by an unrelated dependency", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // linux-only raw socket semantics under test",
			"  if (!dockerAvailable) ctx.skip();",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
	});

	it("fires when the dependency-guarded skip uses a braced consequent", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // windows-only named-pipe semantics under test",
			"  if (!dockerAvailable) { ctx.skip(); return; }",
			"  expect(bindPipe()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("stays quiet when the skip's guard references the platform", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // linux-only raw socket semantics under test",
			"  if (process.platform !== 'linux') ctx.skip();",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("stays quiet for an UNCONDITIONAL runtime skip (the test never runs)", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  ctx.skip();",
			"  // linux-only raw socket semantics, parked until CI has a runner",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
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
		expect(nonNull(matches[0]).line).toBe(3);
		expect(nonNull(matches[0]).text).toMatch(/skipIf/);
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

describe("checkSilentDependencySkip — braced and multi-line consequents (review 2026-06)", () => {
	it("fires on the single-line braced form `{ return; }`", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
	});

	it("fires on the multi-line braced form", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) {",
			"    return;",
			"  }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
	});

	it("fires when the block only logs before silently returning", () => {
		const content = [
			"it('uses docker', () => {",
			"  if (!dockerAvailable) {",
			"    console.warn('docker missing');",
			"    return;",
			"  }",
			"  expect(ping()).toBe(true);",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(1);
	});

	it("stays quiet when the consequent reports the skip (ctx.skip)", () => {
		const content = [
			"it('uses rg', (ctx) => {",
			"  if (!RG_AVAILABLE) { ctx.skip(); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("stays quiet when the consequent fails loudly or asserts the absence", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { throw new Error('install ripgrep'); }",
			"  if (!fallbackAvailable) { expect(scanMode()).toBe('builtin'); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("stays quiet for value returns in test-file helpers", () => {
		const content = [
			"function findRg() { if (!RG_AVAILABLE) return null; return RG_PATH; }",
			"it('x', () => { expect(findRg()).toBeNull(); });",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkSilentDependencySkip — only inside test callbacks (review round 2)", () => {
	it("ignores bare-return guards in module-level helpers (not a test skip)", () => {
		const content = [
			"function maybeStartDocker() {",
			"  if (!dockerAvailable) return;",
			"  startDocker();",
			"}",
			"it('pings the daemon', () => {",
			"  expect(ping()).toBe(true);",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("ignores guards in lifecycle hooks and describe-level setup", () => {
		const content = [
			"beforeAll(() => {",
			"  if (!dockerAvailable) return;",
			"});",
			"describe('suite', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  it('x', () => { expect(1).toBe(1); });",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("still fires inside a test when the same file has helper guards", () => {
		const content = [
			"function maybeStartDocker() {",
			"  if (!dockerAvailable) return;",
			"}",
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(5);
	});

	it("stays out of non-JS test files (callsite shapes are JS-specific)", () => {
		const content = "if (!rgAvailable) { return; }\n";
		expect(checkSilentDependencySkip(content, "src/SomethingTest.java")).toEqual([]);
	});

	it("catches a silent skip inside a test whose formatted header spans four lines (round 5)", () => {
		const content = [
			"it.skipIf(",
			"  isCi ||",
			"  isFlaky",
			")('uses rg', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(5);
	});
});

describe("strict test-file gating (review 2026-06)", () => {
	// The broad isTestFile treats interlinked-cli's own detector / registry
	// sources as test-equivalents so CONTENT scans skip them. Test-hygiene
	// checks gate the opposite way and must use isStrictTestFile — otherwise
	// pattern text in registry metadata fires this warning on every edit.
	const REGISTRY_PATH =
		"/Users/dev/interlinked-cli/src/harness/check-registry/entries-warnings/code-quality.ts";
	const registryContent = [
		"export const entry = {",
		"  description:",
		"    '`if (!X_AVAILABLE) return;` inside a test records a PASS wherever the dependency is missing',",
		"};",
	].join("\n");

	it("does not fire on registry/detector sources carrying patterns as data", () => {
		expect(checkSilentDependencySkip(registryContent, REGISTRY_PATH)).toEqual([]);
		const narrated = "// macOS-only fast path documented in rule metadata\nexport const r = 1;\n";
		expect(
			checkPlatformConditionalAssertion(
				narrated,
				"/Users/dev/interlinked-cli/src/harness/checks/code-quality.ts",
			),
		).toEqual([]);
	});
});

describe("literal masking (review 2026-06)", () => {
	it("does not fire on guard text inside string fixtures", () => {
		const content = [
			"it('detects the guard', () => {",
			"  const fixture = [",
			'    "it(\'a\', () => {",',
			'    "  if (!RG_AVAILABLE) return;",',
			'    "});",',
			"  ].join('\\n');",
			"  expect(check(fixture)).toHaveLength(1);",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("does not fire on guard text inside template fixtures", () => {
		const content = [
			"const fixture = `",
			"if (!dockerAvailable) { return; }",
			"`;",
			"it('x', () => { expect(check(fixture)).toHaveLength(1); });",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("does not fire on guard text inside comments", () => {
		const content = [
			"it('x', () => {",
			"  // the old form was: if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("still fires on a real guard in a file that also holds fixture copies", () => {
		const content = [
			"const fixture = 'if (!RG_AVAILABLE) return;';",
			"it('x', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(3);
	});
});

// ===========================================
// Mutation-kill pins (2026-08) — added against `interlinked mutation
// survivors --file test-portability.ts`. Each block below targets a
// specific surviving mutant id (named in the test title or a leading
// comment) rather than a behavior class already covered above. Kept
// separate from the hand-written suite above so the provenance of each
// assertion stays traceable back to a mutant.
// ===========================================

describe("checkPlatformConditionalAssertion — narration regex boundaries (mutation pin)", () => {
	it("fires on the singular 'on platform where' phrasing (platforms? optional s)", () => {
		const content = [
			"it('x', () => {",
			"  // on platform where the fixture behaves differently, this leaks",
			"  expect(1).toBe(1);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("does not treat a line as a comment merely because it CONTAINS // later on", () => {
		const content = [
			"it('x', () => {",
			"  expect(1).toBe(1); // macOS-only quirk noted here in passing",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("does not read narration from a bare prose line that carries no comment marker at all", () => {
		const content = [
			"on platforms where legacy code lived, tests broke silently across runners",
			"it('example', () => { expect(1).toBe(1); });",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — MAX_MATCHES cap is enforced exactly (mutation pin)", () => {
	it("caps at exactly 10 findings even when 12 files' worth of narration is ungated", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`// on platforms where case ${i} behaves differently, unaddressed`);
			lines.push(`it('case ${i}', () => { expect(${i}).toBe(${i}); });`);
		}
		const matches = checkPlatformConditionalAssertion(lines.join("\n"), TEST_PATH);
		expect(matches).toHaveLength(10);
	});
});

describe("checkPlatformConditionalAssertion — exact message text and slicing (mutation pin)", () => {
	it("produces the exact narration message, trimmed and truncated to 100 chars", () => {
		const filler = "z".repeat(90);
		const rawLine = `    // on platforms where the archive layout differs across runners ${filler} tail-marker`;
		const content = [
			"it('setup', () => { expect(0).toBe(0); });",
			rawLine,
			"it('subject', () => { expect(1).toBe(1); });",
		].join("\n");
		const matches = checkPlatformConditionalAssertion(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
		const expectedSuffix = rawLine.trim().slice(0, 100);
		const expectedText =
			"[comment narrates platform-conditional behavior but the narrated test never gates on it — " +
			"the assertions encode ONE platform's outcome and will fail on the others (CI). " +
			"Construct the condition explicitly in the fixture, or gate THIS test with " +
			`skipIf/process.platform] ${expectedSuffix}`;
		expect(nonNull(matches[0]).text).toBe(expectedText);
	});

	it("resolves file-level narration evidence from anywhere in real code, not just the test's own span", () => {
		const content = [
			"// on platforms where a symlink exists this behaves differently — see below",
			"const isDarwinHost = process.platform === 'darwin';",
			"const helper = () => 1;",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("scopes evidence to the narrated test's FULL body through its LAST line (endLine+1 slice)", () => {
		const content = [
			"// windows-only path separator handling below",
			"it('joins with backslashes', () => { const expected = process.platform === 'win32' ? 'a\\\\b' : 'a/b'; expect(joinPath('a','b')).toBe(expected); });",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — PLATFORM_REF_RE whitespace boundaries (mutation pin)", () => {
	it("recognizes os.platform() with zero interior whitespace as platform evidence", () => {
		const content = ["// on platforms where behavior differs by architecture", "const kind = os.platform();"].join(
			"\n",
		);
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("recognizes os.platform ( ) with interior whitespace as platform evidence", () => {
		const content = ["// on platforms where behavior differs by architecture", "const kind = os.platform ();"].join(
			"\n",
		);
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — RUNTIME_SKIP_RE whitespace boundaries (mutation pin)", () => {
	it("recognizes ctx. skip() — space after the dot — as an unconditional skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  ctx. skip();",
			"  // linux-only raw socket semantics, parked until CI has a runner",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("recognizes ctx .skip() — space before the dot — as an unconditional skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  ctx .skip();",
			"  // linux-only raw socket semantics, parked until CI has a runner",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("recognizes ctx.skip () — space before the call parens — as an unconditional skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  ctx.skip ();",
			"  // linux-only raw socket semantics, parked until CI has a runner",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — IF_CONDITION_RE nested-paren boundaries (mutation pin)", () => {
	it("recognizes if(cond())ctx.skip(); — zero whitespace, empty call parens — as a guarded skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // linux-only raw socket semantics under test",
			"  if(!dockerAvailable())ctx.skip();",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("recognizes if (cond(true)) ctx.skip(); — an argument inside the nested call — as a guarded skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // linux-only raw socket semantics under test",
			"  if (!dockerAvailable(true)) ctx.skip();",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("recognizes if (cond() === false) ctx.skip(); — a trailing comparison — as a guarded skip", () => {
		const content = [
			"it('binds the raw socket', (ctx) => {",
			"  // linux-only raw socket semantics under test",
			"  if (dockerAvailable() === false) ctx.skip();",
			"  expect(bindRawSocket()).toBe(0);",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});
});

describe("checkPlatformConditionalAssertion — platform-derived const declaration spacing (mutation pin)", () => {
	it("resolves a compact declaration (const flagX=process.platform===...) via its bare identifier", () => {
		const content = [
			"const flagX=process.platform==='darwin';",
			"describe('socket suite', () => {",
			"  it('binds', (ctx) => {",
			"    // linux-only raw socket semantics",
			"    if (!flagX) { ctx.skip(); return; }",
			"    expect(bind()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("resolves a normally-spaced declaration (const flagX = process.platform === ...) via its bare identifier", () => {
		const content = [
			"const flagX = process.platform === 'darwin';",
			"describe('socket suite', () => {",
			"  it('binds', (ctx) => {",
			"    // linux-only raw socket semantics",
			"    if (!flagX) { ctx.skip(); return; }",
			"    expect(bind()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("resolves a declaration with double interior whitespace (const  flagX = process.platform === ...)", () => {
		const content = [
			"const  flagX = process.platform === 'darwin';",
			"describe('socket suite', () => {",
			"  it('binds', (ctx) => {",
			"    // linux-only raw socket semantics",
			"    if (!flagX) { ctx.skip(); return; }",
			"    expect(bind()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — PLATFORM_NAME_SEGMENTS allowlist (mutation pin)", () => {
	const cases: Array<[word: string, identifier: string]> = [
		["mac", "useMacFallback"],
		["macos", "useMacosFallback"],
		["osx", "runsOsxLegacy"],
		["darwin", "targetDarwinKernel"],
		["win32", "onWin32Only"],
		["wsl", "runsWslShim"],
		["unix", "targetsUnixSocket"],
		["posix", "usesPosixApi"],
		["platform", "readPlatformInfo"],
		["arch", "checkArchType"],
		["os", "getOsRelease"],
	];
	for (const [word, identifier] of cases) {
		it(`recognizes '${word}' as a platform-name segment pinned in the identifier scan`, () => {
			const content = [
				"it('adjusts for the environment', () => {",
				"  // on platforms where this diverges, the fallback below applies",
				`  if (!${identifier}) { return; }`,
				"  expect(1).toBe(1);",
				"});",
			].join("\n");
			expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
		});
	}
});

describe("checkPlatformConditionalAssertion — ancestor gate identifier resolution (mutation pin)", () => {
	it("resolves an ancestor describe.skipIf gate via a platform-named identifier, isolated from the child's own slice", () => {
		const content = [
			"describe.skipIf(IS_NOT_LINUX)('raw socket suite', () => {",
			"  it('binds the socket', () => {",
			"    // linux-only raw socket semantics under test",
			"    expect(bindRawSocket()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("requires only ONE identifier in a multi-condition ancestor gate to be platform-related (some, not every)", () => {
		const content = [
			"describe.skipIf(isNotLinux && dockerAvailable)('raw socket suite', () => {",
			"  it('binds the socket', () => {",
			"    // linux-only raw socket semantics under test",
			"    expect(bindRawSocket()).toBe(0);",
			"  });",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkPlatformConditionalAssertion — subjectBlockFor resolution (mutation pin)", () => {
	it("does not let a later sibling test's evidence vouch for an earlier narrated test with none of its own", () => {
		const content = [
			"it('first', () => {",
			"  // linux-only raw socket semantics under test",
			"  doStuff();",
			"});",
			"it('second', () => {",
			"  const kind = process.platform;",
			"  expect(kind).toBeDefined();",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});

	it("falls through past a non-test enclosing describe to a lookdown sibling, not the describe's own (empty) span", () => {
		const content = [
			"describe('suite', () => {",
			"  // linux-only semantics for the sibling below",
			"});",
			"it('elsewhere', () => {",
			"  const kind = process.platform;",
			"  expect(kind).toBeDefined();",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toEqual([]);
	});

	it("does not let an unrelated sibling test's evidence vouch for narration scattered across a describe's own helpers", () => {
		const content = [
			"describe('suite', () => {",
			"  // linux-only semantics scattered across this suite",
			"  const helper = () => 1;",
			"  const another = () => 2;",
			"  const yetAnother = () => 3;",
			"  const stillMore = () => 4;",
			"  const finalHelper = () => 5;",
			"  it('runs eventually', () => { expect(1).toBe(1); });",
			"});",
			"it('elsewhere', () => {",
			"  const kind = process.platform;",
			"  expect(kind).toBeDefined();",
			"});",
		].join("\n");
		expect(checkPlatformConditionalAssertion(content, TEST_PATH)).toHaveLength(1);
	});
});

describe("checkSilentDependencySkip — MAX_MATCHES cap is enforced exactly (mutation pin)", () => {
	it("caps at exactly 10 findings even when 12 tests each carry a silent guard", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`it('case ${i}', () => {`);
			lines.push(`  if (!RG_AVAILABLE) return;`);
			lines.push(`  expect(${i}).toBe(${i});`);
			lines.push(`});`);
		}
		const matches = checkSilentDependencySkip(lines.join("\n"), TEST_PATH);
		expect(matches).toHaveLength(10);
	});
});

describe("checkSilentDependencySkip — exact message text and slicing (mutation pin)", () => {
	it("produces the exact silent-skip message, trimmed and truncated to 100 chars", () => {
		const filler = "w".repeat(90);
		const guardLine = `  if (!RG_AVAILABLE) return; // dependency binary entirely absent in this environment ${filler} tail`;
		const content = [
			"it('uses rg', () => {",
			guardLine,
			"  expect(runRg()).toContain('match');",
			"});",
		].join("\n");
		const matches = checkSilentDependencySkip(content, TEST_PATH);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(2);
		const expectedSuffix = guardLine.trim().slice(0, 100);
		const expectedText =
			"[silent dependency skip — this early return records a PASS wherever the " +
			"dependency is missing (CI included), hiding the gap. Use it.skipIf(...)/" +
			`describe.skipIf(...) so the skip is REPORTED] ${expectedSuffix}`;
		expect(nonNull(matches[0]).text).toBe(expectedText);
	});
});

describe("checkSilentDependencySkip — non-test-file exemption is || not && (mutation pin)", () => {
	it("stays quiet on a JS/TS source file that is not a strict test file, even with a guard-shaped body", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) return;",
			"  expect(runRg()).toContain('match');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, "src/regular-source.ts")).toEqual([]);
	});
});

describe("checkSilentDependencySkip — CONSEQUENT_HANDLED_RE whitespace and char-class boundaries (mutation pin)", () => {
	it("treats ctx .skip() — space before the dot — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { ctx .skip(); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats ctx. skip() — space after the dot — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { ctx. skip(); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats expect (...) — space before the paren — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { expect (1).toBe(1); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats a bare assert(...) — zero-width assert\\w* suffix — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { assert(true); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats assertEqual(...) — word characters after assert — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { assertEqual(1, 1); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats assertOk (...) — space before the paren — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { assertOk (true); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats a bare fail() — zero-width whitespace before the paren — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { fail(); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("treats fail (...) — space before the paren — inside the consequent as handled, not silent", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE) { fail ('nope'); return; }",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});
});

describe("checkSilentDependencySkip — TRAILING_BARE_RETURN_RE boundary conditions (mutation pin)", () => {
	it("does not flag a bare return that is followed by more code before the closing brace (must reach the end)", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE){return;doSetup();}",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toEqual([]);
	});

	it("flags a compact trailing return preceded directly by a semicolon with no whitespace", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE){doSetup();return;}",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(1);
	});

	it("flags a trailing return followed by a space then the semicolon", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE){doSetup();return ;}",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(1);
	});

	it("flags a trailing return with NO semicolon at all before the closing brace", () => {
		const content = [
			"it('uses rg', () => {",
			"  if (!RG_AVAILABLE){doSetup();return}",
			"  expect(runRg()).toContain('x');",
			"});",
		].join("\n");
		expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(1);
	});
});

describe("checkSilentDependencySkip — AVAILABILITY_GUARD_RE whitespace boundaries (mutation pin)", () => {
	const guards = [
		"if(!RG_AVAILABLE)return;",
		"if ( !RG_AVAILABLE ) return;",
		"if(!dockerAvailable())return;",
		"if(dockerAvailable()===false)return;",
		"if (dockerAvailable()==false) return;",
		"if (! RG_AVAILABLE) return;",
		"if (!dockerAvailable( )) return;",
		"if (!dockerAvailable() ) return;",
		"if (dockerAvailable( ) === false) return;",
		"if (dockerAvailable() === false ) return;",
	];
	for (const guard of guards) {
		it(`recognizes the guard '${guard}' as a silent dependency skip`, () => {
			const content = ["it('uses the dependency', () => {", `  ${guard}`, "  expect(1).toBe(1);", "});"].join(
				"\n",
			);
			expect(checkSilentDependencySkip(content, TEST_PATH)).toHaveLength(1);
		});
	}
});

describe("dogfood sweep — the repo's own suite stays portability-clean", () => {
	function collectTestFiles(dir: string, out: string[]): string[] {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
				continue;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) collectTestFiles(full, out);
			else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && isStrictTestFile(full)) {
				out.push(full);
			}
		}
		return out;
	}

	it(
		"finds zero silent skips and zero ungated narration across all test files",
		() => {
			const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
			const files = collectTestFiles(srcRoot, []);
			expect(files.length).toBeGreaterThan(40); // sanity: the walk found the suite
			const offenders: string[] = [];
			for (const file of files) {
				const content = readFileSync(file, "utf8");
				for (const m of checkSilentDependencySkip(content, file)) {
					offenders.push(`${file}:${m.line} silent-dependency-skip`);
				}
				for (const m of checkPlatformConditionalAssertion(content, file)) {
					offenders.push(`${file}:${m.line} ungated-platform-narration`);
				}
			}
			expect(offenders).toEqual([]);
		},
		60_000,
	);

	it("self-scan: this very file is clean for both detectors", () => {
		const own = fileURLToPath(import.meta.url);
		const content = readFileSync(own, "utf8");
		expect(checkSilentDependencySkip(content, own)).toEqual([]);
		expect(checkPlatformConditionalAssertion(content, own)).toEqual([]);
	});
});
