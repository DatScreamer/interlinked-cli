import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkAccumulatingSpread,
	checkCircularImports,
	checkDeadExports,
	checkDefaultExport,
	checkLifecycleCleanup,
	checkManualFieldCopy,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkThrowLiteral,
	checkUnvalidatedJsonBoundary,
} from "./agent-safety-advanced.js";

// Behavioral coverage companion for agent-safety-advanced.ts. The deeper
// existing tests live in src/harness/__tests__/generic-checks-extended*.test.ts
// but import through the `generic-checks.js` barrel, so v8 attributes their
// executed lines to the barrel's module instance — leaving THIS source file at
// ~53%. This file imports the detectors DIRECTLY so coverage lands on the file
// under test, and drives the branches the barrel-path tests don't reach:
// checkThrowLiteral, checkCircularImports (real temp-repo cycle walk),
// checkRequireAwait, checkAccumulatingSpread, plus the checkDeadExports
// project-walk against real files on disk.

// ---------------------------------------------------------------------------
// checkThrowLiteral — throw of a non-Error value loses stack traces.
// ---------------------------------------------------------------------------
describe("checkThrowLiteral", () => {
	it("flags throwing a string literal", () => {
		const out = checkThrowLiteral('function f() {\n  throw "boom";\n}\n', "src/x.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(2);
	});

	it("flags throwing a numeric literal", () => {
		const out = checkThrowLiteral("function f() {\n  throw 42;\n}\n", "src/x.ts");
		expect(out.length).toBe(1);
	});

	it("flags throwing true / false / null / undefined", () => {
		for (const lit of ["true", "false", "null", "undefined"]) {
			const out = checkThrowLiteral(`function f() {\n  throw ${lit};\n}\n`, "src/x.ts");
			expect(out.length).toBe(1);
		}
	});

	it("N1: does NOT flag throw new Error(...)", () => {
		const out = checkThrowLiteral(
			'function f() {\n  throw new Error("boom");\n}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("N2: does NOT flag throw new CustomError(...) — real Error subclass", () => {
		const out = checkThrowLiteral(
			"function f() {\n  throw new ValidationError(msg);\n}\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("N3: does NOT flag re-throwing a caught variable (too ambiguous — could be an Error instance)", () => {
		const out = checkThrowLiteral(
			"function f() {\n  try {\n    risky();\n  } catch (err) {\n    throw err;\n  }\n}\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("N4: does NOT flag throwing the result of an error-factory call (not `new`, not a literal)", () => {
		const out = checkThrowLiteral(
			'function f() {\n  throw createValidationError("boom");\n}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("caps output at 10 matches", () => {
		const body = Array.from({ length: 25 }, () => '  throw "x";').join("\n");
		const out = checkThrowLiteral(`function f() {\n${body}\n}\n`, "src/x.ts");
		expect(out.length).toBe(10);
	});

	it("does NOT run on test files", () => {
		expect(checkThrowLiteral('throw "boom";\n', "src/x.test.ts")).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		expect(checkThrowLiteral('throw "boom"\n', "src/x.py")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkDefaultExport — the branches the barrel tests miss: .d.ts skip and the
// non-`export default` line continue.
// ---------------------------------------------------------------------------
describe("checkDefaultExport — extra branches", () => {
	it("does NOT run on .d.ts files", () => {
		expect(checkDefaultExport("export default function () {}\n", "/tmp/foo.d.ts")).toEqual([]);
	});

	it("skips lines that are not `export default` while still scanning the file", () => {
		// First several lines are not default exports; the real one is mid-file.
		const code = [
			"const a = 1;",
			"export const b = 2;",
			"function helper() { return a; }",
			"export default function () { return helper(); }",
		].join("\n");
		const out = checkDefaultExport(code, "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(4);
	});

	it("flags a named default whose name differs from the filename", () => {
		const out = checkDefaultExport("export default function widget() {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("does not match filename");
	});

	it("does NOT flag a named default matching the filename (case-insensitive)", () => {
		const out = checkDefaultExport("export default function Foo() {}\n", "/tmp/foo.ts");
		expect(out).toEqual([]);
	});

	it("exempts a Cloudflare Worker handler default export (named-default + decl shape)", () => {
		const code = [
			"const handler = {",
			"  async fetch(req) { return new Response('ok'); },",
			"};",
			"export default handler;",
		].join("\n");
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("does NOT flag `export default` followed by a value matching neither the anonymous nor named forms", () => {
		// `42` doesn't match any ANON_FORMS shape and doesn't start with
		// `[A-Za-z_$]`, so NAMED_FORM.exec returns null (the `named` false branch).
		expect(checkDefaultExport("export default 42;\n", "/tmp/foo.ts")).toEqual([]);
	});

	// -------------------------------------------------------------------
	// Mutant-kill hardening (survivor-kill campaign, agent-safety-advanced).
	// Each case below is written to distinguish real behavior from one or
	// more specific surviving mutants, not just to exercise a branch.
	// -------------------------------------------------------------------

	it("N: a non-JS extension still returns [] even though the content would otherwise flag (guard is load-bearing)", () => {
		expect(checkDefaultExport("export default function () {}\n", "/tmp/foo.py")).toEqual([]);
	});

	it("N: a test-file path still returns [] even though the content would otherwise flag (guard is load-bearing)", () => {
		expect(checkDefaultExport("export default function () {}\n", "/tmp/foo.test.ts")).toEqual([]);
	});

	it("P: the base-extension regex strips the trailing extension, not an earlier extension-shaped substring", () => {
		// Without the trailing `$` anchor, `.replace()` removes the FIRST
		// (leftmost) extension-shaped run — here ".mts" — instead of the real
		// trailing ".ts", changing the filename embedded in the mismatch text.
		const out = checkDefaultExport(
			"export default function Something() {}\n",
			"/tmp/handler.mts.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Something' does not match filename 'handler.mts' — grep-hostile for cold readers",
		);
	});

	it("N: a .js file's named default matching the filename is NOT flagged (jsx? alternation must still strip .js)", () => {
		expect(checkDefaultExport("export default function Handler() {}\n", "/tmp/handler.js")).toEqual(
			[],
		);
	});

	it("N: vite.config.ts still skips an anonymous default export (config-skip guard is load-bearing)", () => {
		expect(checkDefaultExport("export default function () {}\n", "/tmp/vite.config.ts")).toEqual([]);
	});

	it("P: a filename merely ENDING in vite.config (not starting with it) is not treated as a config file", () => {
		// Without the config regex's leading `^`, "my-vite.config" would
		// match as a trailing substring, wrongly suppressing this finding.
		const out = checkDefaultExport("export default function () {}\n", "/tmp/my-vite.config.ts");
		expect(out.length).toBe(1);
	});

	it("P: a filename merely STARTING WITH vite.config (with a trailing suffix) is not treated as a config file", () => {
		// Without the config regex's trailing `$`, "vite.config.foo" would
		// match as a leading substring, wrongly suppressing this finding.
		const out = checkDefaultExport("export default function () {}\n", "/tmp/vite.config.foo.ts");
		expect(out.length).toBe(1);
	});

	it("P: the anonymous-export match text embeds the full, untouched original source line", () => {
		const out = checkDefaultExport("export default function () { return 1; }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(1);
		expect(out[0]?.text).toBe(
			"anonymous default export: export default function () { return 1; }",
		);
	});

	it("P: flags an anonymous object-literal default export", () => {
		const out = checkDefaultExport("export default { a: 1, b: 2 };\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: flags an anonymous array-literal default export", () => {
		const out = checkDefaultExport("export default [1, 2, 3];\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: flags an anonymous arrow-function default export", () => {
		const out = checkDefaultExport("export default (x) => x + 1;\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the function-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		// The first "export default zzz" doesn't match any ANON_FORMS shape
		// (falls through to the named-form fallback, capturing "zzz"); an
		// unanchored regex would instead find the SECOND "export default
		// function (" and wrongly flag it as anonymous.
		const out = checkDefaultExport(
			"export default zzz export default function () {}\n",
			"/tmp/foo.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace between `default` and `function`", () => {
		const out = checkDefaultExport("export default  function () { return 1; }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: tolerates zero whitespace between `function` and `(`", () => {
		const out = checkDefaultExport("export default function() { return 1; }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the async-function-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		const out = checkDefaultExport(
			"export default zzz export default async function () {}\n",
			"/tmp/foo.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace between `default` and `async`", () => {
		const out = checkDefaultExport(
			"export default  async function () { return 1; }\n",
			"/tmp/foo.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: tolerates extra whitespace between `async` and `function`", () => {
		const out = checkDefaultExport(
			"export default async  function () { return 1; }\n",
			"/tmp/foo.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: tolerates zero whitespace between async `function` and `(`", () => {
		const out = checkDefaultExport(
			"export default async function() { return 1; }\n",
			"/tmp/foo.ts",
		);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the class-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		const out = checkDefaultExport("export default zzz export default class {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace between `default` and `class`", () => {
		const out = checkDefaultExport("export default  class {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: flags a plain `class {}` with no extends clause (the extends clause is genuinely optional)", () => {
		const out = checkDefaultExport("export default class {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: tolerates extra whitespace before `extends`", () => {
		const out = checkDefaultExport("export default class  extends Base {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: flags a class with a real multi-character superclass name", () => {
		const out = checkDefaultExport("export default class extends Base {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("P: tolerates zero whitespace between the superclass name and `{`", () => {
		const out = checkDefaultExport("export default class extends Base{}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the arrow-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		const out = checkDefaultExport("export default zzz export default (x) => x\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace before an arrow-function anonymous default", () => {
		const out = checkDefaultExport("export default  (x) => x\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the object-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		const out = checkDefaultExport("export default zzz export default { a: 1 }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace before an object-literal anonymous default", () => {
		const out = checkDefaultExport("export default  { a: 1 }\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: the array-anon regex's leading anchor prevents matching a LATER occurrence mid-line", () => {
		const out = checkDefaultExport("export default zzz export default [1, 2]\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("P: tolerates extra whitespace before an array-literal anonymous default", () => {
		const out = checkDefaultExport("export default  [1, 2]\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});

	it("N: NAMED_FORM's leading anchor prevents matching a LATER identifier mid-line", () => {
		// "42" isn't an identifier start, so with `^` intact nothing is
		// flagged; without it, the SECOND "export default Widget" would be
		// found and wrongly flagged.
		expect(checkDefaultExport("export default 42; export default Widget\n", "/tmp/foo.ts")).toEqual(
			[],
		);
	});

	it("P: tolerates extra whitespace between `default` and a bare named identifier (no async/function/class prefix)", () => {
		const out = checkDefaultExport("export default  Widget\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Widget' does not match filename 'foo' — grep-hostile for cold readers",
		);
	});

	it("P: tolerates extra whitespace between `default` and `async`, named form", () => {
		const out = checkDefaultExport("export default async  Widget\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Widget' does not match filename 'foo' — grep-hostile for cold readers",
		);
	});

	it("P: tolerates whitespace around the generator `*` before a named function default", () => {
		const out = checkDefaultExport("export default function * Widget() {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Widget' does not match filename 'foo' — grep-hostile for cold readers",
		);
	});

	it("P: tolerates extra whitespace between the generator `*` and the function name", () => {
		const out = checkDefaultExport("export default function*   Widget() {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Widget' does not match filename 'foo' — grep-hostile for cold readers",
		);
	});

	it("P: tolerates extra whitespace between `class` and the class name, named form", () => {
		const out = checkDefaultExport("export default class  Widget {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'Widget' does not match filename 'foo' — grep-hostile for cold readers",
		);
	});

	it("caps output at exactly 10 matches, not 11, for 11 anonymous exports", () => {
		const code = `${Array.from({ length: 11 }, () => "export default function () {}").join("\n")}\n`;
		const out = checkDefaultExport(code, "/tmp/foo.ts");
		expect(out.length).toBe(10);
	});

	it("N: a leading-whitespace-indented default-export line is still recognized (trim before matching)", () => {
		const out = checkDefaultExport("  export default function () {}\n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
	});

	it("N: a tab between `export` and `default` is NOT recognized as a default-export line", () => {
		// The outer gate does a literal `.startsWith("export default")` (one
		// regular space); a tab there fails it even though ANON_FORMS's `\s+`
		// would happily match a tab if this line were ever reached.
		expect(
			checkDefaultExport("export\tdefault function () { return 1; }\n", "/tmp/foo.ts"),
		).toEqual([]);
	});

	it("P: truncates a very long anonymous-export line's embedded text to 120 characters", () => {
		const longSuffix = "a".repeat(200);
		const code = `export default function () { ${longSuffix} }\n`;
		const out = checkDefaultExport(code, "/tmp/foo.ts");
		expect(out.length).toBe(1);
		const expectedFullLine = `export default function () { ${longSuffix} }`;
		expect(out[0]?.text).toBe(`anonymous default export: ${expectedFullLine.slice(0, 120)}`);
		expect(out[0]?.text.length).toBeLessThan(expectedFullLine.length);
	});

	it("P: trims trailing whitespace from the embedded source line in the match text", () => {
		const out = checkDefaultExport("export default function () {}   \n", "/tmp/foo.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe("anonymous default export: export default function () {}");
	});

	it("N: recognizes a worker handler even with extra whitespace between `default` and the handler name", () => {
		const code = [
			"const handler = {",
			"  async fetch(req) { return new Response('ok'); },",
			"};",
			"export default  handler;",
		].join("\n");
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("N: recognizes a worker handler even with whitespace before the trailing semicolon", () => {
		const code = [
			"const handler = {",
			"  async fetch(req) { return new Response('ok'); },",
			"};",
			"export default handler ;",
		].join("\n");
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	// -- isCloudflareWorkerHandler: each of its 3 detection paths, isolated --

	it("N: recognizes a worker handler via the `satisfies ExportedHandler` type path ALONE", () => {
		// Neither an anonymous-object nor a const-decl shape is present, so
		// only the type-annotation path (path 1) can make this a no-op skip.
		// The annotation lives in a COMMENT — isCloudflareWorkerHandler reads
		// raw content (before comment-stripping), so this isolates path 1
		// from the other two paths cleanly.
		const code = "export default zzz;\n// satisfies ExportedHandler\n";
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("P: without the type-annotation match, the same named default is flagged as a mismatch", () => {
		// Same shape as above but with a typo breaking the TYPE_RE match —
		// confirms the previous test's [] came from path 1 actually firing,
		// not from some other guard.
		const code = "export default zzz;\n// satisfies NotExportedHandler\n";
		const out = checkDefaultExport(code, "/tmp/worker.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("does not match filename");
	});

	it("N: recognizes an anonymous worker-handler object literal via the ANON path ALONE", () => {
		// No `satisfies` annotation and no named export — only the anonymous
		// object + method-name path (path 2) can make this a no-op skip.
		const code = ["export default {", "  async fetch(req) { return new Response('ok'); },", "};"].join(
			"\n",
		);
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("N: recognizes an anonymous worker-handler object literal declared with `queue`", () => {
		const code = ["export default {", "  async queue(batch, env) { /* … */ },", "};"].join("\n");
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("P: a named default's declaration must actually contain a handler method, not just exist", () => {
		// "helper" resolves via WORKER_HANDLER_NAMED_DEFAULT_RE, but its own
		// `const helper = {...}` declaration has no fetch/email/queue/etc
		// method — the decl-shape check (path 3's SECOND half) must still
		// reject it, not treat "a const declaration exists at all" as enough.
		const code = ["const helper = {", "  doStuff() { return 1; },", "};", "export default helper;"].join(
			"\n",
		);
		const out = checkDefaultExport(code, "/tmp/worker.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"default export 'helper' does not match filename 'worker' — grep-hostile for cold readers",
		);
	});

	it("N: recognizes a worker handler even with zero whitespace before ExportedHandler (satisfies:ExportedHandler)", () => {
		// `\s*` in WORKER_HANDLER_TYPE_RE must tolerate ZERO whitespace, not
		// just one-or-more.
		const code = "export default zzz;\n// satisfiesExportedHandler\n";
		expect(checkDefaultExport(code, "/tmp/worker.ts")).toEqual([]);
	});

	it("P: flags an anonymous object default whose only method is unrelated to any worker handler name", () => {
		// Guards WORKER_HANDLER_METHODS itself: an object literal with SOME
		// method (just not fetch/email/queue/scheduled/tail/trace) must not
		// be treated as a worker handler.
		const code = ["export default {", "  doStuff() { return 1; },", "};"].join("\n");
		const out = checkDefaultExport(code, "/tmp/worker.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("anonymous default export");
	});
});

// ---------------------------------------------------------------------------
// checkLifecycleCleanup — drive the brace-tracking, the clean-present skip, the
// 10-match cap, and the unbalanced-brace `continue`.
// ---------------------------------------------------------------------------
describe("checkLifecycleCleanup — extra branches", () => {
	it("flags setInterval without clearInterval in a lifecycle method", () => {
		const code = [
			"class Poller {",
			"  start() {",
			"    this.id = setInterval(() => this.tick(), 1000);",
			"  }",
			"  stop() {",
			"    this.running = false;",
			"  }",
			"}",
		].join("\n");
		const out = checkLifecycleCleanup(code, "src/poller.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("setInterval");
	});

	it("does NOT flag when the lifecycle method clears the timer (clean present)", () => {
		const code = [
			"class Poller {",
			"  start() {",
			"    this.id = setInterval(() => this.tick(), 1000);",
			"  }",
			"  stop() {",
			"    clearInterval(this.id);",
			"  }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "src/poller.ts")).toEqual([]);
	});

	it("does NOT flag a class with NO lifecycle method", () => {
		const code = [
			"class Widget {",
			"  init() {",
			"    setInterval(() => {}, 1000);",
			"  }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "src/widget.ts")).toEqual([]);
	});

	it("handles addEventListener / removeEventListener pairing", () => {
		const dirty = [
			"class View {",
			"  mount() {",
			"    window.addEventListener('resize', this.onResize);",
			"  }",
			"  unmount() {",
			"    this.done = true;",
			"  }",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(dirty, "src/view.ts").length).toBe(1);
	});

	it("matches an arrow-form lifecycle method body (dispose = () => { ... })", () => {
		const code = [
			"class Conn {",
			"  open() {",
			"    this.t = setTimeout(() => this.ping(), 500);",
			"  }",
			"  dispose = () => {",
			"    clearTimeout(this.t);",
			"  };",
			"}",
		].join("\n");
		expect(checkLifecycleCleanup(code, "src/conn.ts")).toEqual([]);
	});

	it("does NOT crash on an unbalanced class brace (no matching close)", () => {
		// depth never returns to 0 → the `if (depth !== 0) continue` branch.
		const code = "class Broken {\n  stop() {}\n  start() { setInterval(f, 1); }\n";
		expect(checkLifecycleCleanup(code, "src/broken.ts")).toEqual([]);
	});

	it("caps output at 10 matches across many classes", () => {
		const oneClass = (n: number) =>
			[
				`class C${n} {`,
				"  start() { window.addEventListener('x', h); }",
				"  stop() { this.x = 1; }",
				"}",
			].join("\n");
		const code = Array.from({ length: 14 }, (_, i) => oneClass(i)).join("\n\n");
		expect(checkLifecycleCleanup(code, "src/many.ts").length).toBe(10);
	});

	it("does NOT run on test files or non-JS/TS files", () => {
		const code = "class C { start() { setInterval(f,1); } stop() {} }";
		expect(checkLifecycleCleanup(code, "src/c.test.ts")).toEqual([]);
		expect(checkLifecycleCleanup(code, "src/c.py")).toEqual([]);
	});

	it("reports line 1 for a violation on a single-line class (no preceding newline)", () => {
		// `stripped.slice(0, absOffset).match(/\n/g)` returns null (no newlines
		// before the match) — exercises the `|| []` fallback at the lineIdx calc.
		const code = "class C { start() { setInterval(f,1); } stop() { this.x = 1; } }";
		const out = checkLifecycleCleanup(code, "src/oneline.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	it("stops mid-class once the 10-match cap is hit across multiple violation pairs in ONE class", () => {
		// Seed 9 matches from 9 single-violation classes, then a 10th class with
		// THREE simultaneous unclosed subscriptions (setInterval / setTimeout /
		// addEventListener). The first pair fills the cap to 10; the PAIRS loop's
		// own `if (matches.length >= 10) break` then short-circuits before the
		// second and third pairs are even tested.
		const filler = Array.from({ length: 9 }, (_, i) =>
			[
				`class Filler${i} {`,
				"  start() { setInterval(f, 1); }",
				"  stop() { this.x = 1; }",
				"}",
			].join("\n"),
		).join("\n\n");
		const overloaded = [
			"class Overloaded {",
			"  start() {",
			"    setInterval(f, 1);",
			"    setTimeout(g, 1);",
			"    window.addEventListener('x', h);",
			"  }",
			"  stop() { this.x = 1; }",
			"}",
		].join("\n");
		const code = `${filler}\n\n${overloaded}`;
		const out = checkLifecycleCleanup(code, "src/many-pairs.ts");
		expect(out.length).toBe(10);
	});

	// -------------------------------------------------------------------
	// Mutant-kill hardening (survivor-kill campaign, agent-safety-advanced).
	// -------------------------------------------------------------------

	it("P: recognizes a class declaration with extra whitespace after `class`", () => {
		const code = "class  Widget {\n  start() { setInterval(f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setInterval");
	});

	it("P: recognizes a class declaration with extra whitespace before `extends`", () => {
		const code =
			"class Widget  extends Base {\n  start() { setInterval(f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setInterval");
	});

	it("P: recognizes a class declaration with zero whitespace before the opening brace", () => {
		const code = "class Widget{\n  start() { setInterval(f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setInterval");
	});

	it("P: recognizes setInterval() with extra whitespace before the paren as an unclosed subscription", () => {
		const code = "class P {\n  start() { setInterval (f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setInterval");
	});

	it("N: recognizes clearInterval() with extra whitespace before the paren as valid cleanup", () => {
		const code =
			"class P {\n  start() { setInterval(f,1); }\n  stop() { clearInterval (id); }\n}\n";
		expect(checkLifecycleCleanup(code, "src/x.ts")).toEqual([]);
	});

	it("P: recognizes setTimeout() with zero whitespace before the paren as an unclosed subscription", () => {
		const code = "class P {\n  start() { setTimeout(f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setTimeout");
	});

	it("P: recognizes setTimeout() with one space before the paren as an unclosed subscription", () => {
		const code = "class P {\n  start() { setTimeout (f,1); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setTimeout");
	});

	it("N: recognizes clearTimeout() with extra whitespace before the paren as valid cleanup", () => {
		const code =
			"class P {\n  start() { setTimeout(f,1); }\n  stop() { clearTimeout (id); }\n}\n";
		expect(checkLifecycleCleanup(code, "src/x.ts")).toEqual([]);
	});

	it("P: recognizes addEventListener() with extra whitespace before the paren as an unclosed subscription", () => {
		const code = "class P {\n  start() { addEventListener (e,h); }\n  stop() { this.x=1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("addEventListener");
	});

	it("N: recognizes removeEventListener() with zero whitespace before the paren as valid cleanup", () => {
		const code =
			"class P {\n  start() { addEventListener(e,h); }\n  stop() { removeEventListener(e,h); }\n}\n";
		expect(checkLifecycleCleanup(code, "src/x.ts")).toEqual([]);
	});

	it("N: recognizes removeEventListener() with one space before the paren as valid cleanup", () => {
		const code =
			"class P {\n  start() { addEventListener(e,h); }\n  stop() { removeEventListener (e,h); }\n}\n";
		expect(checkLifecycleCleanup(code, "src/x.ts")).toEqual([]);
	});

	it("P: the reported line number and classBody slice are relative to THIS class, not the whole file", () => {
		// Leading content before the class pushes `bodyStart` to a non-zero
		// offset; a mutant that used the whole `stripped` string as classBody
		// (instead of slicing) would corrupt both the reported line number and
		// the add/clean scan itself.
		const code = [
			"const unused = 1;",
			"class Widget {",
			"  start() {",
			"    setInterval(f, 1);",
			"  }",
			"  stop() {",
			"    this.x = 1;",
			"  }",
			"}",
		].join("\n");
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(4);
		expect(out[0]?.text).toBe(
			"setInterval() without matching clearInterval in lifecycle method: setInterval(f, 1);",
		);
	});

	it("P: truncates a very long violation line's embedded text to 120 characters", () => {
		const longSuffix = "a".repeat(200);
		const code = `class P {\n  start() { setInterval(f, 1); ${longSuffix} }\n  stop() { this.x = 1; }\n}\n`;
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		const expectedFullLine = `start() { setInterval(f, 1); ${longSuffix} }`;
		expect(out[0]?.text).toBe(
			`setInterval() without matching clearInterval in lifecycle method: ${expectedFullLine.slice(0, 120)}`,
		);
		expect(out[0]?.text.length).toBeLessThan(expectedFullLine.length);
	});

	it("P: trims trailing whitespace from the embedded source line in the match text", () => {
		const code = "class P {\n  start() { setInterval(f, 1); }   \n  stop() { this.x = 1; }\n}\n";
		const out = checkLifecycleCleanup(code, "src/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe(
			"setInterval() without matching clearInterval in lifecycle method: start() { setInterval(f, 1); }",
		);
	});

	it("caps output at exactly 10 matches, not 11, across 11 single-violation classes", () => {
		const oneClass = (n: number) =>
			[
				`class C${n} {`,
				"  start() { setInterval(f,1); }",
				"  stop() { this.x=1; }",
				"}",
			].join("\n");
		const code = Array.from({ length: 11 }, (_, i) => oneClass(i)).join("\n\n");
		const out = checkLifecycleCleanup(code, "src/many.ts");
		expect(out.length).toBe(10);
	});

	it("P: a cleanup call OUTSIDE the lifecycle method does not count as pairing (body text must be sliced)", () => {
		// `clearInterval` appears in a plain helper method, never inside the
		// recognized lifecycle method (`stop`) — collectLifecycleBodies must
		// push only the SLICED lifecycle-method body, not the whole class, or
		// this stray call would be wrongly credited as valid cleanup.
		const code = [
			"class P {",
			"  start() { setInterval(f, 1); }",
			"  helper() { clearInterval(999); }",
			"  stop() { this.x = 1; }",
			"}",
		].join("\n");
		const out = checkLifecycleCleanup(code, "/tmp/x.ts");
		expect(out.length).toBe(1);
		expect(out[0]?.text).toContain("setInterval");
	});
});

// ---------------------------------------------------------------------------
// checkCircularImports — DFS walk over real files on disk in a temp git repo.
// ---------------------------------------------------------------------------
describe("checkCircularImports", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cov41-cyc-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags a two-file import cycle (a → b → a)", () => {
		const aPath = join(dir, "a.ts");
		writeFileSync(aPath, 'import { b } from "./b.js";\nexport const a = () => b();\n');
		writeFileSync(join(dir, "b.ts"), 'import { a } from "./a.js";\nexport const b = () => a();\n');
		const aContent = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		const out = checkCircularImports(aContent, aPath, dir);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).text).toContain("import cycle");
	});

	it("does NOT flag an acyclic import chain", () => {
		const head = join(dir, "head.ts");
		writeFileSync(head, 'import { mid } from "./mid.js";\nexport const head = () => mid();\n');
		writeFileSync(join(dir, "mid.ts"), "export const mid = () => 1;\n");
		const out = checkCircularImports(
			'import { mid } from "./mid.js";\nexport const head = () => mid();\n',
			head,
			dir,
		);
		expect(out).toEqual([]);
	});

	it("skips type-only imports (erased at compile time, no runtime cycle)", () => {
		const tPath = join(dir, "t.ts");
		// t imports a TYPE from u; u imports a value from t. The type edge is
		// skipped so no runtime cycle is reported.
		writeFileSync(tPath, 'import type { U } from "./u.js";\nexport const t: U = {} as U;\n');
		writeFileSync(join(dir, "u.ts"), 'import { t } from "./t.js";\nexport type U = typeof t;\n');
		const out = checkCircularImports(
			'import type { U } from "./u.js";\nexport const t: U = {} as U;\n',
			tPath,
			dir,
		);
		expect(out).toEqual([]);
	});

	it("ignores unresolvable bare-module imports", () => {
		const p = join(dir, "bare.ts");
		writeFileSync(p, 'import { z } from "some-pkg";\nexport const bare = () => z;\n');
		const out = checkCircularImports(
			'import { z } from "some-pkg";\nexport const bare = () => z;\n',
			p,
			dir,
		);
		expect(out).toEqual([]);
	});

	it("does NOT run on non-JS/TS, test, or .d.ts files", () => {
		expect(checkCircularImports("", join(dir, "x.py"), dir)).toEqual([]);
		expect(checkCircularImports("", join(dir, "x.test.ts"), dir)).toEqual([]);
		expect(checkCircularImports("", join(dir, "x.d.ts"), dir)).toEqual([]);
	});

	it("does NOT run on files outside the project root", () => {
		expect(checkCircularImports("export const a = 1;", "/elsewhere/a.ts", dir)).toEqual([]);
	});

	it("resolves relative paths via the cwd when filePath is relative", () => {
		// relative filePath → resolved against cwd; acyclic so no findings, but
		// exercises the isAbsolute=false branch.
		writeFileSync(join(dir, "rel.ts"), "export const rel = 1;\n");
		expect(checkCircularImports("export const rel = 1;", "rel.ts", dir)).toEqual([]);
	});

	it("reuses a cached file read on a diamond dependency (b and c both import d)", () => {
		const aPath = join(dir, "diamond-a.ts");
		const aContent =
			'import { b } from "./diamond-b.js";\nimport { c } from "./diamond-c.js";\nexport const a = () => b() + c();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "diamond-b.ts"),
			'import { d } from "./diamond-d.js";\nexport const b = () => d();\n',
		);
		writeFileSync(
			join(dir, "diamond-c.ts"),
			'import { d } from "./diamond-d.js";\nexport const c = () => d();\n',
		);
		writeFileSync(join(dir, "diamond-d.ts"), "export const d = () => 1;\n");
		// d is read once via readCached (miss), then again via the c branch
		// (cache hit) — no crash, no cycle.
		expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
	});

	it("skips a file it cannot read (readCached catch branch) without crashing", () => {
		const aPath = join(dir, "locked-a.ts");
		const aContent = 'import { z } from "./locked-b.js";\nexport const a = () => z;\n';
		writeFileSync(aPath, aContent);
		const bPath = join(dir, "locked-b.ts");
		writeFileSync(bPath, "export const z = 1;\n");
		chmodSync(bPath, 0o000);
		try {
			expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
		} finally {
			chmodSync(bPath, 0o644);
		}
	});

	it("caps reported cycles at MAX_PATHS (5) when more than 5 distinct 2-node cycles exist", () => {
		const aPath = join(dir, "fan-a.ts");
		const imports = Array.from(
			{ length: 6 },
			(_, i) => `import { v${i} } from "./fan-b${i}.js";`,
		).join("\n");
		const aContent = `${imports}\nexport const a = 1;\n`;
		writeFileSync(aPath, aContent);
		for (let i = 0; i < 6; i++) {
			writeFileSync(
				join(dir, `fan-b${i}.ts`),
				`import { a } from "./fan-a.js";\nexport const v${i} = () => a;\n`,
			);
		}
		const out = checkCircularImports(aContent, aPath, dir);
		expect(out.length).toBe(5);
	});

	it("avoids infinite recursion on an inner cycle that doesn't touch the start file", () => {
		// a -> b -> c -> b (cycle among b/c, not involving a). Must terminate
		// and report no cycle back to `a`.
		const aPath = join(dir, "inner-a.ts");
		const aContent = 'import { b } from "./inner-b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "inner-b.ts"),
			'import { c } from "./inner-c.js";\nexport const b = () => c();\n',
		);
		writeFileSync(
			join(dir, "inner-c.ts"),
			'import { b } from "./inner-b.js";\nexport const c = () => b();\n',
		);
		expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
	});

	it("de-duplicates an identical cycle string reached via two separate import statements", () => {
		const aPath = join(dir, "dup-a.ts");
		const aContent =
			'import { x } from "./dup-b.js";\nimport { y } from "./dup-b.js";\nexport const a = () => x + y;\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "dup-b.ts"),
			'import { a } from "./dup-a.js";\nexport const x = 1;\nexport const y = 2;\n',
		);
		const out = checkCircularImports(aContent, aPath, dir);
		// Both import statements to dup-b produce the identical [a,b,a] cycle
		// trail — the `seen` de-dupe collapses them to one reported finding.
		expect(out.length).toBe(1);
	});

	it("caps recursion at MAX_DEPTH (10) on a long acyclic import chain without crashing", () => {
		const N = 13;
		const rootPath = join(dir, "chain-0.ts");
		let rootContent = "";
		for (let i = 0; i < N; i++) {
			const content =
				i < N - 1
					? `import { v } from "./chain-${i + 1}.js";\nexport const v${i} = () => v;\n`
					: "export const v = 1;\n";
			writeFileSync(join(dir, `chain-${i}.ts`), content);
			if (i === 0) rootContent = content;
		}
		expect(checkCircularImports(rootContent, rootPath, dir)).toEqual([]);
	});

	// -------------------------------------------------------------------
	// Mutant-kill hardening (survivor-kill campaign, agent-safety-advanced).
	// Several of these deliberately construct a REAL cycle that a guard
	// should suppress — an empty-content "does not run on X" case returns
	// [] regardless of whether the guard actually fired, so it does not
	// distinguish the guard being disabled from the guard working.
	// -------------------------------------------------------------------

	it("N: a non-JS extension still returns [] even though a real cycle exists (ext guard is load-bearing)", () => {
		const aPath = join(dir, "nonjs-a.xyz");
		const aContent = 'import { b } from "./nonjs-b.xyz";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "nonjs-b.xyz"),
			'import { a } from "./nonjs-a.xyz";\nexport const b = () => a();\n',
		);
		expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
	});

	it("N: a test-file path still returns [] even though a real cycle exists (isTestFile guard is load-bearing)", () => {
		const aPath = join(dir, "guard.test.ts");
		const aContent = 'import { b } from "./guard-tf-b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "guard-tf-b.ts"),
			'import { a } from "./guard.test.js";\nexport const b = () => a();\n',
		);
		expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
	});

	it("N: a .d.ts path still returns [] even though a real cycle exists (.d.ts guard is load-bearing)", () => {
		const aPath = join(dir, "guard.d.ts");
		const aContent = 'import { b } from "./guard-dts-b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "guard-dts-b.ts"),
			'import { a } from "./guard.d.js";\nexport const b = () => a();\n',
		);
		expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
	});

	it("P: still flags a real cycle when the file lives outside the project root (outside-root guard boundary)", () => {
		// Points cwd at `dir` while the cycle's own files live in a SEPARATE
		// temp dir — proves the guard actually fires for a genuine cycle,
		// not just for empty/no-import content that returns [] either way.
		const outsideDir = mkdtempSync(join(tmpdir(), "il-cov41-outside-"));
		try {
			const aPath = join(outsideDir, "out-a.ts");
			const aContent = 'import { b } from "./out-b.js";\nexport const a = () => b();\n';
			writeFileSync(aPath, aContent);
			writeFileSync(
				join(outsideDir, "out-b.ts"),
				'import { a } from "./out-a.js";\nexport const b = () => a();\n',
			);
			expect(checkCircularImports(aContent, aPath, dir)).toEqual([]);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	for (const ext of [".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) {
		it(`P: detects a two-file cycle between ${ext} files`, () => {
			const aPath = join(dir, `ext-a${ext}`);
			const aContent = `import { b } from "./ext-b${ext}";\nexport const a = () => b();\n`;
			writeFileSync(aPath, aContent);
			writeFileSync(
				join(dir, `ext-b${ext}`),
				`import { a } from "./ext-a${ext}";\nexport const b = () => a();\n`,
			);
			const out = checkCircularImports(aContent, aPath, dir);
			expect(out.length).toBeGreaterThanOrEqual(1);
		});
	}

	it("P: the cycle path text joins file names with the ' → ' arrow separator", () => {
		const aPath = join(dir, "sep-a.ts");
		const aContent = 'import { b } from "./sep-b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(join(dir, "sep-b.ts"), 'import { a } from "./sep-a.js";\nexport const b = () => a();\n');
		const out = checkCircularImports(aContent, aPath, dir);
		expect(out.length).toBe(1);
		expect(out[0]?.text).toBe("import cycle: sep-a.ts → sep-b.ts → sep-a.ts");
	});

	it("P: finds an 11-file cycle (closing edge discovered at trail depth exactly 10)", () => {
		// MAX_DEPTH is 10; the closing edge back to the start is only reached
		// once trail.length reaches 10, which the `> MAX_DEPTH` check must
		// still allow (an off-by-one `>= MAX_DEPTH` would stop one hop early
		// and miss this cycle entirely).
		const N = 11;
		const p0 = join(dir, "depth11-0.ts");
		let content0 = "";
		for (let i = 0; i < N; i++) {
			const next = (i + 1) % N;
			const c = `import { v } from "./depth11-${next}.js";\nexport const v${i} = () => v;\n`;
			writeFileSync(join(dir, `depth11-${i}.ts`), c);
			if (i === 0) content0 = c;
		}
		const out = checkCircularImports(content0, p0, dir);
		expect(out.length).toBe(1);
	});

	it("N: does NOT find a 13-file cycle (closing edge would require trail depth 12, past MAX_DEPTH)", () => {
		const N = 13;
		const p0 = join(dir, "depth13-0.ts");
		let content0 = "";
		for (let i = 0; i < N; i++) {
			const next = (i + 1) % N;
			const c = `import { v } from "./depth13-${next}.js";\nexport const v${i} = () => v;\n`;
			writeFileSync(join(dir, `depth13-${i}.ts`), c);
			if (i === 0) content0 = c;
		}
		expect(checkCircularImports(content0, p0, dir)).toEqual([]);
	});

	it("P: uses the PASSED-IN content for the starting file, not its on-disk content", () => {
		// On disk, mismatch-a.ts is acyclic; the CONTENT argument describes a
		// cyclic version of the same file (the in-flight edit being judged).
		// Only the first (trail.length===0) call may use `content` directly —
		// every other file is read from disk via readCached.
		const aPath = join(dir, "mismatch-a.ts");
		writeFileSync(aPath, "export const a = 1;\n");
		writeFileSync(
			join(dir, "mismatch-b.ts"),
			'import { a } from "./mismatch-a.js";\nexport const b = () => a;\n',
		);
		const cyclicPassedContent =
			'import { b } from "./mismatch-b.js";\nexport const a = () => b();\n';
		const out = checkCircularImports(cyclicPassedContent, aPath, dir);
		expect(out.length).toBe(1);
	});

	it("N: a file that imports only itself is NOT reported as a cycle (trail must be non-empty)", () => {
		const aPath = join(dir, "self-a.ts");
		const content = 'import { a } from "./self-a.js";\nexport const a = () => a;\n';
		writeFileSync(aPath, content);
		expect(checkCircularImports(content, aPath, dir)).toEqual([]);
	});

	it("P: onPath cycle-avoidance does not multiply an already-found real cycle into duplicates", () => {
		// b imports BOTH a (closes a real a→b→a cycle) and c; c imports b
		// (an inner cycle that does not involve a). Without onPath correctly
		// blocking re-entry into b from within c, the DFS bounces b<->c
		// repeatedly, rediscovering the SAME a→b→a relationship through
		// progressively longer (and therefore non-deduplicated) trails.
		const aPath = join(dir, "onpath-a.ts");
		const aContent = 'import { b } from "./onpath-b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(
			join(dir, "onpath-b.ts"),
			'import { a } from "./onpath-a.js";\nimport { c } from "./onpath-c.js";\nexport const b = () => a() + c();\n',
		);
		writeFileSync(
			join(dir, "onpath-c.ts"),
			'import { b } from "./onpath-b.js";\nexport const c = () => b();\n',
		);
		const out = checkCircularImports(aContent, aPath, dir);
		expect(out.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// checkDeadExports — project-wide walk over real files (getGitSourceFiles uses
// `git ls-files`, so the fixture must be a git repo).
// ---------------------------------------------------------------------------
describe("checkDeadExports", () => {
	let dir: string;

	// A FRESH temp dir per test: getGitSourceFiles caches its `git ls-files`
	// result per-cwd for 30s, so reusing one dir would hide files written by
	// later tests behind the first test's cached listing.
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-cov41-dead-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags an export that no other file imports", () => {
		const libPath = join(dir, "lib.ts");
		writeFileSync(libPath, "export const used = 1;\nexport const orphan = 2;\n");
		// consumer imports only `used`, leaving `orphan` dead.
		writeFileSync(join(dir, "consumer.ts"), 'import { used } from "./lib.js";\nconsole.log(used);\n');
		const out = checkDeadExports(
			"export const used = 1;\nexport const orphan = 2;\n",
			libPath,
			dir,
		);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("orphan");
	});

	it("does NOT flag exports that are imported elsewhere", () => {
		const modPath = join(dir, "mod.ts");
		writeFileSync(modPath, "export const live = 7;\n");
		writeFileSync(join(dir, "user.ts"), 'import { live } from "./mod.js";\nexport const v = live;\n');
		expect(checkDeadExports("export const live = 7;\n", modPath, dir)).toEqual([]);
	});

	it("treats a namespace import as making every export used", () => {
		const nsPath = join(dir, "ns.ts");
		writeFileSync(nsPath, "export const one = 1;\nexport const two = 2;\n");
		writeFileSync(
			join(dir, "ns-user.ts"),
			'import * as NS from "./ns.js";\nexport const sum = NS.one + NS.two;\n',
		);
		expect(checkDeadExports("export const one = 1;\nexport const two = 2;\n", nsPath, dir)).toEqual(
			[],
		);
	});

	it("returns [] when the file has no non-default/non-type exports", () => {
		const onlyType = join(dir, "types-only.ts");
		writeFileSync(onlyType, "export type Foo = { a: number };\n");
		expect(checkDeadExports("export type Foo = { a: number };\n", onlyType, dir)).toEqual([]);
	});

	it("skips python / .d.ts / test / index(barrel) / outside-root / no-export files", () => {
		expect(checkDeadExports("export const x = 1;", join(dir, "f.py"), dir)).toEqual([]);
		expect(checkDeadExports("export const x = 1;", join(dir, "f.d.ts"), dir)).toEqual([]);
		expect(checkDeadExports("export const x = 1;", join(dir, "f.test.ts"), dir)).toEqual([]);
		expect(checkDeadExports("export const x = 1;", join(dir, "index.ts"), dir)).toEqual([]);
		expect(checkDeadExports("export const x = 1;", "/other/root/f.ts", dir)).toEqual([]);
		expect(checkDeadExports("const x = 1;", join(dir, "noexport.ts"), dir)).toEqual([]);
	});

	it("handles a relative filePath (resolved against cwd)", () => {
		const relName = "rellib.ts";
		writeFileSync(join(dir, relName), "export const solo = 1;\n");
		const out = checkDeadExports("export const solo = 1;\n", relName, dir);
		// No importer → solo is dead.
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("solo");
	});
});

// ---------------------------------------------------------------------------
// checkUnvalidatedJsonBoundary — extra branch coverage on the validated path.
// ---------------------------------------------------------------------------
describe("checkUnvalidatedJsonBoundary — extra branches", () => {
	it("flags JSON.parse followed by a property access before validation", () => {
		const code = "const data = JSON.parse(raw);\nreturn data.id;\n";
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts").length).toBe(1);
	});

	it("flags `await res.json()` reaching a field access", () => {
		const code = "const body = await res.json();\nuse(body.token);\n";
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts").length).toBe(1);
	});

	it("does NOT flag when the value is run through a schema parser first", () => {
		const code = "const data = JSON.parse(raw);\nconst safe = Schema.parse(data);\nuse(safe.id);\n";
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});

	it("does NOT flag when the value is only returned / passed onward", () => {
		const code = "const data = JSON.parse(raw);\nreturn data;\n";
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});

	it("does NOT run on test / non-JS files", () => {
		const code = "const data = JSON.parse(raw);\nreturn data.id;\n";
		expect(checkUnvalidatedJsonBoundary(code, "src/x.test.ts")).toEqual([]);
		expect(checkUnvalidatedJsonBoundary(code, "src/x.py")).toEqual([]);
	});

	// Local-validator recognition (boundary-parser campaign R2-4, 2026-08-10):
	// the swept pattern routes parsed JSON through a local `parseX(v): X | null`
	// (or an `isX(v)` guard) instead of a schema library — that IS the
	// validation this check demands, so it must not keep firing on swept code.
	it("N: does NOT flag when a local parseX validator consumes the value first", () => {
		const code = [
			"const data = JSON.parse(raw);",
			"const finding = parseFinding(data);",
			"if (finding === null) return null;",
			"use(finding.id);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});

	it("N: does NOT flag when an isX type-guard gates the value first", () => {
		const code = [
			"const body = await res.json();",
			"if (!isSandboxJobRequest(body)) return null;",
			"run(body.riskTier);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});

	it("N: does NOT flag a validateX call with the value as first argument", () => {
		const code = [
			"const cfg = JSON.parse(text);",
			"const checked = validateConfig(cfg, opts);",
			"use(checked.mode);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});

	it("P: still flags when the local-validator call comes AFTER the field access", () => {
		const code = [
			"const data = JSON.parse(raw);",
			"use(data.id);",
			"const finding = parseFinding(data);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts").length).toBe(1);
	});

	it("P: a dotted .parse-like name does not fake local validation (JSON.parse(data) re-parse)", () => {
		const code = [
			"const data = JSON.parse(raw);",
			"const again = JSON.parse(data);",
			"use(data.id);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts").length).toBe(1);
	});

	it("N: an Array.isArray gate on the value counts as shape validation", () => {
		// The per-element mapper (`.map(parseCiRun)`) is a bare function
		// REFERENCE, invisible to call-shaped recognition — the array gate is
		// the narrowing this check should credit.
		const code = [
			"const parsed: unknown = JSON.parse(raw);",
			"if (!Array.isArray(parsed)) return [];",
			"return parsed.map(parseCiRun).filter(Boolean);",
		].join("\n");
		expect(checkUnvalidatedJsonBoundary(code, "src/x.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkPromiseRejectNonError — literal rejection argument.
// ---------------------------------------------------------------------------
describe("checkPromiseRejectNonError", () => {
	it("flags Promise.reject with a string / number / boolean / null literal", () => {
		for (const lit of ['"oops"', "5", "-1", "true", "false", "null", "undefined"]) {
			const out = checkPromiseRejectNonError(`return Promise.reject(${lit});\n`, "src/x.ts");
			expect(out.length).toBe(1);
		}
	});

	it("does NOT flag Promise.reject(new Error(...))", () => {
		expect(
			checkPromiseRejectNonError('Promise.reject(new Error("x"));\n', "src/x.ts"),
		).toEqual([]);
	});

	it("does NOT flag Promise.reject(err) with a variable", () => {
		expect(checkPromiseRejectNonError("Promise.reject(err);\n", "src/x.ts")).toEqual([]);
	});

	it("does NOT run on test / non-JS files", () => {
		expect(checkPromiseRejectNonError('Promise.reject("x");\n', "src/x.test.ts")).toEqual([]);
		expect(checkPromiseRejectNonError('Promise.reject("x")\n', "src/x.py")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkRequireAwait — async function that never awaits anything.
// ---------------------------------------------------------------------------
describe("checkRequireAwait", () => {
	it("flags a long async function with no await / promise usage", () => {
		const code = [
			"async function compute(input) {",
			"  const a = input + 1;",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  const d = c / 4;",
			"  const e = d % 5;",
			"  return e + a + b + c;",
			"}",
		].join("\n");
		const out = checkRequireAwait(code, "src/calc.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	it("does NOT flag an async function that uses await", () => {
		const code = [
			"async function load(input) {",
			"  const a = input + 1;",
			"  const r = await fetchThing(a);",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  return r + b + c;",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/load.ts")).toEqual([]);
	});

	it("does NOT flag a short (<=5 line) async wrapper", () => {
		const code = ["async function tiny(x) {", "  const y = x + 1;", "  return y;", "}"].join("\n");
		expect(checkRequireAwait(code, "src/tiny.ts")).toEqual([]);
	});

	it("does NOT flag an async function that returns a promise via .then()", () => {
		const code = [
			"async function chain(x) {",
			"  const a = x + 1;",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  const d = c - 4;",
			"  return doThing(a).then((v) => v + b + c + d);",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/chain.ts")).toEqual([]);
	});

	it("does NOT flag an async function whose body references Promise", () => {
		const code = [
			"async function gather(x) {",
			"  const a = x + 1;",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  const d = c - 4;",
			"  const e = d - 5;",
			"  return Promise.all([a, b, c, d, e]);",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/gather.ts")).toEqual([]);
	});

	it("does NOT flag Next.js route-handler names (GET/POST/...)", () => {
		const code = [
			"async function GET(req) {",
			"  const a = 1;",
			"  const b = 2;",
			"  const c = 3;",
			"  const d = 4;",
			"  const e = 5;",
			"  return a + b + c + d + e;",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/route.ts")).toEqual([]);
	});

	it("does NOT run on files under a servers/ or scripts/ path", () => {
		const code = [
			"async function handler(x) {",
			"  const a = x + 1;",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  const d = c - 4;",
			"  const e = d - 5;",
			"  return a + b + c + d + e;",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/servers/handler.ts")).toEqual([]);
		expect(checkRequireAwait(code, "scripts/build.ts")).toEqual([]);
	});

	it("does NOT flag a short return-call delegate (<=10 lines)", () => {
		// `return foo(...)` with body <=10 lines is treated as a delegating wrapper.
		const code = [
			"async function wrap(x) {",
			"  const a = x + 1;",
			"  const b = a * 2;",
			"  const c = b - 3;",
			"  const d = c - 4;",
			"  const e = d - 5;",
			"  return delegate(a + b + c + d + e);",
			"}",
		].join("\n");
		expect(checkRequireAwait(code, "src/wrap.ts")).toEqual([]);
	});

	it("does NOT run on test / non-JS files", () => {
		const code = "async function f() { const a = 1; const b = 2; const c = 3; const d = 4; const e = 5; return a+b+c+d+e; }";
		expect(checkRequireAwait(code, "src/f.test.ts")).toEqual([]);
		expect(checkRequireAwait(code, "src/f.py")).toEqual([]);
	});

	it("does NOT flag a line without `async function`", () => {
		const code = ["function plain(x) {", "  return x + 1;", "}"].join("\n");
		expect(checkRequireAwait(code, "src/plain.ts")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkAccumulatingSpread — O(n^2) spread-in-reduce.
// ---------------------------------------------------------------------------
describe("checkAccumulatingSpread", () => {
	it("flags object spread of the accumulator in reduce", () => {
		const code = "const m = items.reduce((acc, x) => ({ ...acc, [x.k]: x.v }), {});\n";
		expect(checkAccumulatingSpread(code, "src/x.ts").length).toBe(1);
	});

	it("flags array spread of the accumulator in reduce", () => {
		const code = "const a = items.reduce((acc, x) => [ ...acc, x ], []);\n";
		expect(checkAccumulatingSpread(code, "src/x.ts").length).toBe(1);
	});

	it("flags a multi-line spread-in-reduce within the 5-line window", () => {
		const code = [
			"const m = items.reduce((acc, x) => ({",
			"  ...acc,",
			"  [x.k]: x.v,",
			"}), {});",
		].join("\n");
		expect(checkAccumulatingSpread(code, "src/x.ts").length).toBe(1);
	});

	it("does NOT flag a reduce that does not spread the accumulator", () => {
		const code = "const total = nums.reduce((acc, x) => acc + x, 0);\n";
		expect(checkAccumulatingSpread(code, "src/x.ts")).toEqual([]);
	});

	it("does NOT flag a line without .reduce(", () => {
		const code = "const copy = { ...source };\n";
		expect(checkAccumulatingSpread(code, "src/x.ts")).toEqual([]);
	});

	it("does NOT run on non-JS/TS files", () => {
		const code = "const m = items.reduce((acc, x) => ({ ...acc }), {})\n";
		expect(checkAccumulatingSpread(code, "src/x.py")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// checkManualFieldCopy — sanity guard so the direct-import path also exercises
// this detector (deeper cases live in the barrel-path test).
// ---------------------------------------------------------------------------
describe("checkManualFieldCopy — direct-import smoke", () => {
	it("flags a run of 5+ consecutive field copies", () => {
		const code = [
			"function build(dst, src) {",
			"  dst.a = src.a;",
			"  dst.b = src.b;",
			"  dst.c = src.c;",
			"  dst.d = src.d;",
			"  dst.e = src.e;",
			"}",
		].join("\n");
		const out = checkManualFieldCopy(code, "src/build.ts");
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).text).toContain("consecutive field copies");
	});

	it("does NOT flag fewer than 5 copies", () => {
		const code = ["dst.a = src.a;", "dst.b = src.b;", "dst.c = src.c;"].join("\n");
		expect(checkManualFieldCopy(code, "src/x.ts")).toEqual([]);
	});
});
