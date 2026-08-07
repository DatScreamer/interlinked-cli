// Co-located tests for the CLI-entrypoint exemption (field report 2026-07-06):
// `console_statements` (checkConsoleDebug — the PostToolUse registry check,
// also run by verify's file-checks) fired on entrypoints whose console.log IS
// their output. `isCliEntrypoint` is the shared predicate — the write-guard
// content-quality console heuristic consumes the same function, so both
// surfaces inherit these semantics.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	checkBinaryContent,
	checkConsoleDebug,
	isCliCommandModule,
	isCliEntrypoint,
	locateBinaryContent,
} from "./language-agnostic.js";

const LOGS = 'console.log("output line");\nconsole.log("another");\n';
/** Absolute path with more segments than BIN_LOOKUP_MAX_DEPTH (40) — none of
 *  which exist on disk — so the ancestor-walk loop exhausts without ever
 *  reaching the filesystem root or finding a package.json. */
const DEEP_FAKE_PATH = `/${Array.from({ length: 45 }, (_, i) => `seg${i}`).join("/")}/file.js`;

describe("isCliEntrypoint", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cli-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects a shebang first line", () => {
		expect(isCliEntrypoint("/proj/src/tool.ts", "#!/usr/bin/env node\nrun();")).toBe(true);
	});

	it("detects scripts/ and bin/ path segments", () => {
		expect(isCliEntrypoint("/proj/scripts/migrate.ts", "run();")).toBe(true);
		expect(isCliEntrypoint("proj/bin/tool.js", "run();")).toBe(true);
	});

	it("detects a string-form package.json bin target", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliEntrypoint(join(dir, "run.js"), "run();")).toBe(true);
	});

	it("detects an object-form package.json bin target via the NEAREST package.json", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "t", bin: { tool: "./dist/entry.js" } }),
		);
		mkdirSync(join(dir, "dist"), { recursive: true });
		expect(isCliEntrypoint(join(dir, "dist", "entry.js"), "run();")).toBe(true);
	});

	it("resolves a relative path against cwd for the bin lookup", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliEntrypoint("run.js", "run();", dir)).toBe(true);
	});

	it("is false for ordinary source files, non-bin-target files, and malformed package.json", () => {
		expect(isCliEntrypoint("/proj/src/lib/util.ts", "export const x = 1;")).toBe(false);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(isCliEntrypoint(join(dir, "src", "other.ts"), "export const x = 1;")).toBe(false);
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(isCliEntrypoint(join(dir, "run.js"), "run();")).toBe(false);
	});

	it("skips the bin lookup for a relative path without cwd (no crash, path rules still apply)", () => {
		expect(isCliEntrypoint("src/app.ts", "export const x = 1;")).toBe(false);
	});
});

describe("checkConsoleDebug — CLI-entrypoint exemption", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cd-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does NOT flag a shebang entrypoint", () => {
		expect(checkConsoleDebug(`#!/usr/bin/env node\n${LOGS}`, "/proj/src/tool.ts")).toEqual([]);
	});

	it("does NOT flag a package.json bin target", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.mjs" }));
		expect(checkConsoleDebug(LOGS, join(dir, "run.mjs"))).toEqual([]);
	});

	it("still flags ordinary library files (path- and bin-map-negative)", () => {
		expect(checkConsoleDebug(LOGS, "/proj/src/app.ts").length).toBeGreaterThanOrEqual(1);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(checkConsoleDebug(LOGS, join(dir, "src", "app.ts")).length).toBeGreaterThanOrEqual(1);
	});
});

// locateBinaryContent supplies the position/count that makes the
// binary_content error actionable — the raw byte is invisible in editors.
// Fixtures build the NUL with String.fromCharCode so this test file never
// contains a raw control byte itself.
describe("locateBinaryContent", () => {
	const NUL = String.fromCharCode(0);

	it("returns null for clean content", () => {
		expect(locateBinaryContent("plain text\nsecond line\n")).toBeNull();
		expect(locateBinaryContent("")).toBeNull();
		expect(locateBinaryContent("escaped \\u0000 text is fine")).toBeNull();
	});

	it("reports a 1-based line:column for the first NUL", () => {
		expect(locateBinaryContent(`valid text${NUL}rest`)).toEqual({
			count: 1,
			line: 1,
			column: 11,
		});
	});

	it("tracks line breaks before the first NUL", () => {
		expect(locateBinaryContent(`line one\nab${NUL}cd`)).toEqual({
			count: 1,
			line: 2,
			column: 3,
		});
	});

	it("counts every NUL but positions only the first", () => {
		expect(locateBinaryContent(`a${NUL}b\nc${NUL}${NUL}d`)).toEqual({
			count: 3,
			line: 1,
			column: 2,
		});
	});

	it("handles a NUL as the very first character", () => {
		expect(locateBinaryContent(`${NUL}payload`)).toEqual({ count: 1, line: 1, column: 1 });
	});
});

describe("checkBinaryContent", () => {
	it("returns true when content contains a NUL byte", () => {
		expect(checkBinaryContent(`abc${String.fromCharCode(0)}def`)).toBe(true);
	});

	it("returns false for clean text content", () => {
		expect(checkBinaryContent("plain text\nsecond line\n")).toBe(false);
	});
});

describe("checkConsoleDebug — isConsoleDebugExempt path-substring fallbacks", () => {
	it("exempts a /server/ path segment that isn't otherwise a CLI/script path", () => {
		expect(checkConsoleDebug(LOGS, "/proj/server/handler.ts")).toEqual([]);
	});

	it("exempts an /evals/ path segment", () => {
		expect(checkConsoleDebug(LOGS, "/proj/evals/runner.ts")).toEqual([]);
	});

	it("exempts a /workers/ path segment", () => {
		expect(checkConsoleDebug(LOGS, "/proj/workers/handler.ts")).toEqual([]);
	});

	it("exempts via isCliFile's /commands/ directory rule ahead of the path-substring fallback", () => {
		expect(checkConsoleDebug(LOGS, "/proj/commands/deploy.ts")).toEqual([]);
	});
});

describe("checkConsoleDebug — Python", () => {
	it("skips a script/sandbox-named file entirely (no pattern)", () => {
		expect(checkConsoleDebug("breakpoint()\n", "/proj/lib/sandbox_runner.py")).toEqual([]);
	});

	it("flags breakpoint() in an ordinary app file", () => {
		const out = checkConsoleDebug("breakpoint()\n", "/proj/lib/app_logic.py");
		expect(out.length).toBe(1);
	});
});

describe("checkConsoleDebug — Go", () => {
	it("does not flag zero fmt.Println occurrences (match() → null → [] fallback)", () => {
		expect(checkConsoleDebug("x := 1\n", "/proj/lib/handler.go")).toEqual([]);
	});

	it("does not flag fewer than 3 fmt.Println occurrences", () => {
		const code = 'fmt.Println("one")\nfmt.Println("two")\n';
		expect(checkConsoleDebug(code, "/proj/lib/handler.go")).toEqual([]);
	});

	it("flags 3 or more fmt.Println occurrences", () => {
		const code = 'fmt.Println("one")\nfmt.Println("two")\nfmt.Println("three")\n';
		const out = checkConsoleDebug(code, "/proj/lib/handler.go");
		expect(out.length).toBe(3);
	});
});

describe("checkConsoleDebug — C/C++", () => {
	it("skips a main.* file", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/src/main.c")).toEqual([]);
	});

	it("skips a file whose NAME contains 'examples' even without an examples/ path segment", () => {
		expect(checkConsoleDebug('printf("hi");\n', "/proj/lib/examples.c")).toEqual([]);
	});

	it("skips a file whose name contains 'demo' with no trailing word boundary (fileName-only check)", () => {
		// "demo_test.c": the path-wide \bdemos?\b check fails (no boundary before
		// the trailing `_test`), but the filename-only \b(example|demo|sample)
		// check (no trailing boundary required) still matches.
		expect(checkConsoleDebug('printf("hi");\n', "/proj/lib/demo_test.c")).toEqual([]);
	});

	it("flags printf in an ordinary non-main, non-example C file", () => {
		const out = checkConsoleDebug('printf("hi");\n', "/proj/src/app.c");
		expect(out.length).toBe(1);
	});
});

describe("checkConsoleDebug — Swift and unsupported extensions", () => {
	it("flags NSLog in a Swift file", () => {
		const out = checkConsoleDebug('NSLog("hi")\n', "/proj/src/App.swift");
		expect(out.length).toBe(1);
	});

	it("returns [] for an extension no language branch recognizes", () => {
		expect(checkConsoleDebug('puts "hi"\n', "/proj/src/app.rb")).toEqual([]);
	});
});

describe("isCliEntrypoint — ancestor-walk exhaustion", () => {
	it("returns false when the walk exceeds BIN_LOOKUP_MAX_DEPTH without finding package.json or root", () => {
		expect(isCliEntrypoint(DEEP_FAKE_PATH, "run();")).toBe(false);
	});

	it("returns false when bin is neither a string nor an object (binTargets empty)", () => {
		const binDir = mkdtempSync(join(tmpdir(), "il-cli-ep-bin-"));
		try {
			writeFileSync(join(binDir, "package.json"), JSON.stringify({ name: "t", bin: 42 }));
			expect(isCliEntrypoint(join(binDir, "run.js"), "run();")).toBe(false);
		} finally {
			rmSync(binDir, { recursive: true, force: true });
		}
	});

	it("returns false when package.json parses to a non-object JSON value", () => {
		const primDir = mkdtempSync(join(tmpdir(), "il-cli-ep-prim-"));
		try {
			writeFileSync(join(primDir, "package.json"), "42");
			expect(isCliEntrypoint(join(primDir, "run.js"), "run();")).toBe(false);
		} finally {
			rmSync(primDir, { recursive: true, force: true });
		}
	});
});

describe("isCliCommandModule", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cli-cmd-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is false for a path outside commands/cli/cmd regardless of package.json", () => {
		expect(isCliCommandModule("/proj/src/util.ts", dir)).toBe(false);
	});

	it("is false for a relative commands/ path with no cwd given", () => {
		expect(isCliCommandModule("commands/deploy.ts")).toBe(false);
	});

	it("resolves a relative commands/ path against cwd and finds a declared bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliCommandModule("commands/deploy.ts", dir)).toBe(true);
	});

	it("is true for an absolute commands/ path whose nearest package.json declares bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./run.js" }));
		expect(isCliCommandModule(join(dir, "commands", "deploy.ts"))).toBe(true);
	});

	it("is false when the nearest package.json declares no bin field", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		expect(isCliCommandModule(join(dir, "commands", "deploy.ts"))).toBe(false);
	});

	it("is false when the ancestor walk reaches the filesystem root with no package.json", () => {
		expect(isCliCommandModule(join(dir, "commands", "deploy.ts"))).toBe(false);
	});

	it("returns false when the walk exceeds BIN_LOOKUP_MAX_DEPTH without finding package.json or root", () => {
		const deepCommandsPath = DEEP_FAKE_PATH.replace("/file.js", "/commands/deploy.ts");
		expect(isCliCommandModule(deepCommandsPath)).toBe(false);
	});

	it("returns false when the nearest package.json is malformed JSON", () => {
		writeFileSync(join(dir, "package.json"), "{ not json");
		expect(isCliCommandModule(join(dir, "commands", "deploy.ts"))).toBe(false);
	});
});
