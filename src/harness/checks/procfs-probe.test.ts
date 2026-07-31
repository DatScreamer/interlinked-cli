// Check Evidence Contract cases for `procfs_probe_in_test` (advisory, post
// tier: ≥1 positive / ≥1 negative required — this file covers every branch of
// the detector instead).
//
// FIXTURE RULE — read before adding a case: every fixture line is carried as a
// line INSIDE an outer quoted literal (`'const p = "/proc/x";'`). The detector
// matches only a literal whose whole value is a procfs path, so the outer
// literal ("const p = …") is what it sees here and this file stays clean under
// its own check. A bare `"/proc/…"` literal, or a multi-line template fixture
// (whose interior lines ARE bare literals), would make the detector fire on its
// own tests. The last negative case pins that.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProcfsProbeInTest } from "./procfs-probe.js";

const TEST_FILE = "src/harness/server/stop-nudge-throttle.test.ts";

/** Join fixture lines into file content. */
function src(...lines: string[]): string {
	return lines.join("\n");
}

describe("detectProcfsProbeInTest — positive (must fire)", () => {
	it("P1: the historical recurrence.test.ts fixture (double-quoted /proc path)", () => {
		const content = src(
			'it("recordToolFailure never throws on an unwritable cwd", () => {',
			'	recordToolFailure({ cwd: "/proc/nonexistent/x" });',
			"});",
		);
		const out = detectProcfsProbeInTest(content, TEST_FILE);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(2);
	});

	it("P2: the historical stop-nudge-throttle fixture (single-quoted /proc path)", () => {
		const content = src("suppressRepeatedNudges({ projectRoot: '/proc/nonexistent-root' });");
		const out = detectProcfsProbeInTest(content, TEST_FILE);
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toBe(1);
	});

	it("P3: bare '/proc' passed as a join() segment", () => {
		const content = src('const p = join("/proc", "nonexistent", "x");');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toHaveLength(1);
	});

	it("P4: a template literal beginning with the procfs path", () => {
		const content = src("const p = `/proc/${pid}/mem`;");
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toHaveLength(1);
	});

	it("P5: two probes on separate lines report both, with their own line numbers", () => {
		const content = src(
			'const a = "/proc/nonexistent/one";',
			"const untouched = 1;",
			'const b = "/proc/nonexistent/two";',
		);
		const out = detectProcfsProbeInTest(content, TEST_FILE);
		expect(out.map((m) => m.line)).toEqual([1, 3]);
	});

	it("P6: two probes on the SAME line report twice", () => {
		const content = src('expect(f("/proc/a")).toEqual(g("/proc/b"));');
		const out = detectProcfsProbeInTest(content, TEST_FILE);
		expect(out).toHaveLength(2);
		expect(out.map((m) => m.line)).toEqual([1, 1]);
	});

	it("P7: a path nested BELOW an informational procfs file is not exempt", () => {
		const content = src('const p = "/proc/cpuinfo/nested";');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toHaveLength(1);
	});

	it("P8: non-JS test files are in scope too (Python)", () => {
		const content = src('def test_unwritable():', '    path = "/proc/nonexistent/x"');
		expect(detectProcfsProbeInTest(content, "tests/test_paths.py")).toHaveLength(1);
	});

	it("P9: a __tests__/ directory file with no .test suffix is in scope", () => {
		const content = src('const p = "/proc/nonexistent/x";');
		expect(detectProcfsProbeInTest(content, "src/harness/__tests__/helpers.ts")).toHaveLength(1);
	});

	it("P10: reports at most 10 probes even when the file has more", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `const p${i} = "/proc/nonexistent/${i}";`);
		expect(detectProcfsProbeInTest(src(...lines), TEST_FILE)).toHaveLength(10);
	});

	it("P11: reports all 10 when the file has exactly 10 probes", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `const p${i} = "/proc/nonexistent/${i}";`);
		expect(detectProcfsProbeInTest(src(...lines), TEST_FILE)).toHaveLength(10);
	});

	it("P12: the message names the offending path, the mechanism, and the safe fixture", () => {
		const content = src('const p = "/proc/nonexistent/x";');
		const text = detectProcfsProbeInTest(content, TEST_FILE)[0]?.text ?? "";
		// Leading slash dropped on purpose: an assertion string whose value IS a
		// procfs path is indistinguishable from a fixture and fires the check (see
		// the fixture rule at the top of this file — N12 pins it).
		expect(text).toContain("proc/nonexistent/x");
		expect(text).toContain("spins forever");
		expect(text).toContain("ENOTDIR");
		expect(text).toContain("writeFileSync");
		expect(text).toContain('join(f, "nested")');
	});

	it("P13: the echoed source line is trimmed and truncated to 100 characters", () => {
		const padding = "x".repeat(200);
		const content = src(`\t\tconst p = "/proc/nonexistent/x"; // ${padding}`);
		const text = detectProcfsProbeInTest(content, TEST_FILE)[0]?.text ?? "";
		const echoed = text.slice(text.indexOf("] ") + 2);
		expect(echoed).toHaveLength(100);
		expect(echoed.startsWith("const p =")).toBe(true);
	});
});

describe("detectProcfsProbeInTest — negative (must not fire)", () => {
	it("N1: does not fire on a non-test source file", () => {
		const content = src('const p = "/proc/nonexistent/x";');
		expect(detectProcfsProbeInTest(content, "src/harness/paths.ts")).toEqual([]);
	});

	it("N2: does not fire on the line comment that documents the hazard", () => {
		const content = src(
			"// A path nested under a regular file is unwritable on every platform.",
			'// This must NOT use a "/proc/…" path: on Linux, recursive mkdir against',
			"// a /proc subpath spins forever instead of throwing.",
			"const fileAsParent = join(root, 'not-a-directory');",
		);
		expect(detectProcfsProbeInTest(content, "src/lib/guard-state.test.ts")).toEqual([]);
	});

	it("N3: does not fire on a block comment mentioning the path", () => {
		const content = src("/*", ' * never probe "/proc/nonexistent/x" here', " */", "const x = 1;");
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N4: does not fire on a Python # comment mentioning the path", () => {
		const content = src('# never probe "/proc/nonexistent/x" here', "x = 1");
		expect(detectProcfsProbeInTest(content, "tests/test_paths.py")).toEqual([]);
	});

	it("N5: does not fire on prose that merely contains the word", () => {
		const content = src(
			'expect(msg).toContain("the /proc hazard is documented in guard-state");',
			'const label = "process";',
		);
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N6: does not fire on sibling paths that only share the prefix", () => {
		const content = src('const a = "/procedures/list";', 'const b = "/processes";');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N7: does not fire on a URL whose path contains /proc", () => {
		const content = src('const u = "https://example.com/proc/nonexistent/x";');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N8: does not fire on a legitimate /proc/cpuinfo platform probe", () => {
		const content = src('const cores = readFileSync("/proc/cpuinfo", "utf8");');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N9: does not fire on the other informational procfs files", () => {
		const content = src(
			'readFileSync("/proc/meminfo");',
			'readFileSync("/proc/self/cgroup");',
			'readFileSync("/proc/loadavg");',
			'readFileSync("/proc/uptime");',
			'readFileSync("/proc/stat");',
			'readFileSync("/proc/version");',
			'readFileSync("/proc/mounts");',
			'readFileSync("/proc/net/dev");',
			'readFileSync("/proc/self/status");',
			'readFileSync("/proc/self/mountinfo");',
		);
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N10: does not fire on a test file with no procfs mention at all", () => {
		const content = src('it("works", () => { expect(1).toBe(1); });');
		expect(detectProcfsProbeInTest(content, TEST_FILE)).toEqual([]);
	});

	it("N11: does not fire on the canonical safe file-as-parent fixture", () => {
		const content = src(
			'const fileAsParent = join(root, "not-a-directory");',
			'writeFileSync(fileAsParent, "x");',
			'expect(() => appendGuardEvent(join(fileAsParent, "nested"), {})).not.toThrow();',
		);
		expect(detectProcfsProbeInTest(content, "src/lib/guard-state.test.ts")).toEqual([]);
	});

	it("N12: does not fire on this test file — fixtures stay nested inside outer literals", () => {
		const selfPath = join(import.meta.dirname, "procfs-probe.test.ts");
		const self = readFileSync(selfPath, "utf8");
		expect(detectProcfsProbeInTest(self, selfPath)).toEqual([]);
	});
});
