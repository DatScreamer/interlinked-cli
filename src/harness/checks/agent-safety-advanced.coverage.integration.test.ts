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
