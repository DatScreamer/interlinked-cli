// Co-located tests for the content-quality guard's A5 JSON.parse heuristic.
// Regression coverage for the false positive where a JSON.parse guarded by an
// ENCLOSING try block (with the catch many lines below) was flagged, and where a
// JSON.parse mentioned only in a string/comment fired. The detector now delegates
// to the brace-tracked checkJsonParseUnsafe (stripped content + try-depth scan)
// instead of the old "is there a `try {` in the 5 lines directly above" window.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectContentQualityWarnings } from "./write-content-guards-content-quality.js";

const JP = "JSON.parse() without try-catch";

/** Content-quality warnings for a proposed TS file, filtered to the A5 line. */
function jsonParseWarnings(fileName: string, content: string): string[] {
	return collectContentQualityWarnings(`/repo/src/${fileName}`, content, "/repo").filter((w) =>
		w.includes(JP),
	);
}

describe("collectContentQualityWarnings — A5 JSON.parse enclosing-try", () => {
	it("does NOT flag a JSON.parse guarded by an enclosing try whose opener is >5 lines above", () => {
		const content = [
			"export function load(raw: string): unknown {",
			"  try {",
			"    step1();",
			"    step2();",
			"    step3();",
			"    step4();",
			"    step5();",
			"    step6();",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("load.ts", content)).toEqual([]);
	});

	it("does NOT flag a JSON.parse still inside the outer try after an inline try/catch (the hooks-template shape)", () => {
		const content = [
			"export function flush(raw: string): unknown {",
			"  try {",
			"    if (cond) {",
			"      try { cleanup(); } catch (_e) { /* ignore */ }",
			"    }",
			"    const parsed = JSON.parse(raw);",
			"    return parsed;",
			"  } catch {",
			"    return null;",
			"  }",
			"}",
		].join("\n");
		expect(jsonParseWarnings("flush.ts", content)).toEqual([]);
	});

	it("does NOT flag JSON.parse mentioned only in a string or comment", () => {
		const content = [
			"// remember to wrap JSON.parse(x) in a try",
			'const help = "call JSON.parse(raw) carefully";',
			"export const x = 1;",
		].join("\n");
		expect(jsonParseWarnings("doc.ts", content)).toEqual([]);
	});

	it("still flags a bare unguarded JSON.parse", () => {
		const content = ["export function p(raw: string): unknown {", "  return JSON.parse(raw);", "}"].join("\n");
		expect(jsonParseWarnings("bare.ts", content).length).toBe(1);
	});

	it("still flags an unguarded JSON.parse AFTER an enclosing try has closed", () => {
		const content = [
			"export function f(a: string, b: string): unknown {",
			"  try {",
			"    return JSON.parse(a);",
			"  } catch {",
			"    /* fall through */",
			"  }",
			"  return JSON.parse(b);",
			"}",
		].join("\n");
		expect(jsonParseWarnings("after.ts", content).length).toBe(1);
	});
});

// Field report 2026-07-06: the console.log debug-logging warning fired on CLI
// entrypoints whose console.log IS their output. Exempt: shebang first line,
// nearest package.json bin target, scripts|bin path segment. Ordinary library
// files must keep firing.
describe("collectContentQualityWarnings — console.log entrypoint exemption", () => {
	const THREE_LOGS = 'console.log("a");\nconsole.log("b");\nconsole.log("c");\nexport const n = 1;\n';
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-ep-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function consoleWarnings(filePath: string, content: string, cwd?: string): string[] {
		return collectContentQualityWarnings(filePath, content, cwd).filter((w) =>
			w.includes("console.log statements"),
		);
	}

	// --- entrypoints: must NOT fire ---

	it("does NOT flag a file whose first line is a shebang", () => {
		expect(consoleWarnings("/repo/src/tool.ts", `#!/usr/bin/env node\n${THREE_LOGS}`, "/repo")).toEqual([]);
	});

	it("does NOT flag a file under a scripts/ path segment", () => {
		expect(consoleWarnings("/repo/scripts/migrate.ts", THREE_LOGS, "/repo")).toEqual([]);
	});

	it("does NOT flag a file under a bin/ path segment", () => {
		expect(consoleWarnings("/repo/bin/runner.ts", THREE_LOGS, "/repo")).toEqual([]);
	});

	it("does NOT flag the target of a string-form package.json bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.mjs" }));
		expect(consoleWarnings(join(dir, "cli.mjs"), THREE_LOGS, dir)).toEqual([]);
	});

	it("does NOT flag a target of an object-form package.json bin (nested path)", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "t", bin: { mytool: "./nested/entry.js" } }),
		);
		mkdirSync(join(dir, "nested"), { recursive: true });
		expect(consoleWarnings(join(dir, "nested", "entry.js"), THREE_LOGS, dir)).toEqual([]);
	});

	// --- ordinary library/source files: must keep firing ---

	it("still flags an ordinary library file with 3+ console.log", () => {
		expect(consoleWarnings("/repo/src/lib/util.ts", THREE_LOGS, "/repo").length).toBe(1);
	});

	it("still flags when the nearest package.json has NO bin field", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(consoleWarnings(join(dir, "src", "service.ts"), THREE_LOGS, dir).length).toBe(1);
	});

	it("still flags when the bin map points at a DIFFERENT file", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: { t: "./cli.js" } }));
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(consoleWarnings(join(dir, "src", "other.ts"), THREE_LOGS, dir).length).toBe(1);
	});
});

describe("collectContentQualityWarnings — scoping fixes (2026-07 dogfood)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cq-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// #1 hardcoded-URL heuristic: exempt .claude/workflows tooling scripts.
	const FOUR_URLS =
		'const r = ["https://github.com/a/b","https://github.com/c/d","https://github.com/e/f","https://github.com/g/h"];\n';
	const urlHits = (filePath: string): string[] =>
		collectContentQualityWarnings(filePath, FOUR_URLS, "/repo").filter((w) => w.includes("hardcoded URLs"));
	it("does NOT flag hardcoded URLs in a .claude/workflows script", () => {
		expect(urlHits("/repo/.claude/workflows/cross-repo.js")).toEqual([]);
	});
	it("does NOT flag hardcoded URLs in a session-persisted .claude/**/workflows script", () => {
		expect(urlHits("/home/u/.claude/projects/x/workflows/scripts/wf.js")).toEqual([]);
	});
	it("STILL flags hardcoded URLs in an ordinary source file", () => {
		expect(urlHits("/repo/src/net.ts").length).toBe(1);
	});

	// #2 task-marker heuristic: a marker documented inside backticks/quotes (a
	// detector's own patterns) is not a real marker; a genuine // TODO: still is.
	const markerHits = (content: string): string[] =>
		collectContentQualityWarnings("/repo/src/detector.ts", content, "/repo").filter((w) =>
			w.includes("task marker"),
		);
	it("does NOT flag markers documented inside backticks in a comment", () => {
		expect(markerHits("// matches \x60TODO:\x60 / \x60TODO(x):\x60 / \x60FIXME\x60\nexport const a = 1;\n")).toEqual([]);
	});
	it("does NOT flag markers inside a quoted string in a comment", () => {
		expect(markerHits('// the "TODO:" and "FIXME" detector kinds\nexport const a = 1;\n')).toEqual([]);
	});
	it("STILL flags a genuine // TODO: comment", () => {
		expect(markerHits("// TODO: wire this up\nexport const a = 1;\n").length).toBe(1);
	});
	it("STILL flags a genuine // FIXME comment", () => {
		expect(markerHits("// FIXME broken here\nexport const a = 1;\n").length).toBe(1);
	});

	// #3 console.log heuristic: exempt CLI command modules of a bin package.
	const THREE_LOGS = 'console.log("a");\nconsole.log("b");\nconsole.log("c");\nexport const n = 1;\n';
	const logHits = (filePath: string, cwd: string): string[] =>
		collectContentQualityWarnings(filePath, THREE_LOGS, cwd).filter((w) => w.includes("console.log statements"));
	it("does NOT flag a commands/ module when the package declares a bin", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.js" }));
		mkdirSync(join(dir, "src", "commands"), { recursive: true });
		expect(logHits(join(dir, "src", "commands", "reload.ts"), dir)).toEqual([]);
	});
	it("STILL flags a commands/ module when the package has NO bin (not a CLI)", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }));
		mkdirSync(join(dir, "src", "commands"), { recursive: true });
		expect(logHits(join(dir, "src", "commands", "svc.ts"), dir).length).toBe(1);
	});
	it("STILL flags a non-commands module in a bin package", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", bin: "./cli.js" }));
		mkdirSync(join(dir, "src", "lib"), { recursive: true });
		expect(logHits(join(dir, "src", "lib", "util.ts"), dir).length).toBe(1);
	});
});

// Field report 2026-07-06: A4 flagged statement-position calls whose rejection
// IS handled at the call site by a `.catch(...)` on a LATER line of the same
// chain (multi-line chains). Same-line handling was already exempt.
describe("collectContentQualityWarnings — A4 floating promise chain handling", () => {
	function floatingWarnings(content: string): string[] {
		return collectContentQualityWarnings("/repo/src/boot.ts", content, "/repo").filter((w) =>
			w.includes("potential floating promise"),
		);
	}

	// --- handled at the call site: must NOT fire ---

	it("does NOT flag a call handled by .catch on the same line", () => {
		expect(floatingWarnings("mainAsync().catch((err) => { report(err); });")).toEqual([]);
	});

	it("does NOT flag a multi-line chain ending in .catch", () => {
		const content = ["mainAsync()", "  .catch((err) => {", "    report(err);", "  });"].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a multi-line .then chain that ends in .catch (multi-line callbacks)", () => {
		const content = [
			"loadAsync()",
			"  .then((cfg) => {",
			"    apply(cfg);",
			"  })",
			"  .catch((err) => {",
			"    report(err);",
			"  });",
		].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a call whose argument list spans lines and closes into .catch", () => {
		const content = ["runAsync(", "  config,", ").catch(handleErr);"].join("\n");
		expect(floatingWarnings(content)).toEqual([]);
	});

	it("does NOT flag a void-prefixed call", () => {
		expect(floatingWarnings("void mainAsync();")).toEqual([]);
	});

	// --- genuinely floating: must keep firing ---

	it("still flags a bare async-named statement call", () => {
		expect(floatingWarnings("startAsync();\n").length).toBe(1);
	});

	it("still flags a bare call mid-function with no handling", () => {
		const content = ["function boot() {", "  doAsync();", "  finish();", "}"].join("\n");
		expect(floatingWarnings(content).length).toBe(1);
	});

	it("still flags a multi-line chain that ends in .then only (rejection unhandled)", () => {
		const content = ["runAsync()", "  .then((x) => use(x));"].join("\n");
		expect(floatingWarnings(content).length).toBe(1);
	});
});
