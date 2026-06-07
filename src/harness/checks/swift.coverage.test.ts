// Supplementary coverage for swift.ts — drives the detector functions and the
// P0 env/mock/test-regression helpers NOT exercised by the sibling
// `swift.test.ts` (which pins the seven concurrency/perf/style detectors).
//
// Together with `swift.test.ts` this file is intended to bring swift.ts to
// ~100% line coverage. Each detector gets positive AND negative Swift snippets;
// the env/mock helpers use real temp dirs (mirroring env-documentation.test.ts).
//
// All fixtures use synthetic identifiers — no real vendor/model/provider names.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSwiftAbbreviations,
	checkSwiftDelegateNotWeak,
	checkSwiftFileIdOverFilePath,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftImplicitlyUnwrappedOptional,
	checkSwiftLegacyHashValue,
	checkSwiftLegacyRandom,
	checkSwiftSelfInEscapingClosure,
	checkSwiftUnhandledTaskError,
	checkTestRegressions,
	extractEnvReferences,
	extractMockDefinitions,
	extractModuleExportNames,
	parseEnvDocumentation,
} from "./swift.js";

// ===========================================
// checkSwiftForceCast
// ===========================================
describe("checkSwiftForceCast", () => {
	it("flags `as!` force cast", () => {
		const code = "let widget = anyValue as! WidgetView";
		expect(checkSwiftForceCast(code, "View.swift").length).toBe(1);
	});

	it("flags multiple force casts", () => {
		const code = "let a = x as! Foo\nlet b = y as! Bar";
		expect(checkSwiftForceCast(code, "View.swift").length).toBe(2);
	});

	it("does not flag conditional cast `as?`", () => {
		const code = "let widget = anyValue as? WidgetView";
		expect(checkSwiftForceCast(code, "View.swift")).toEqual([]);
	});

	it("does not flag `as!` inside a string literal", () => {
		const code = 'let note = "cast with as! is unsafe"';
		expect(checkSwiftForceCast(code, "View.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "let x = y as! Foo";
		expect(checkSwiftForceCast(code, "View.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let x = y as! Foo";
		expect(checkSwiftForceCast(code, "WidgetTests.swift")).toEqual([]);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 15 }, (_, i) => `let v${i} = x as! Foo`).join("\n");
		expect(checkSwiftForceCast(code, "View.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftForceTry
// ===========================================
describe("checkSwiftForceTry", () => {
	it("flags `try!` force try", () => {
		const code = "let data = try! decoder.decode(Payload.self, from: raw)";
		expect(checkSwiftForceTry(code, "Service.swift").length).toBe(1);
	});

	it("does not flag optional try `try?`", () => {
		const code = "let data = try? decoder.decode(Payload.self, from: raw)";
		expect(checkSwiftForceTry(code, "Service.swift")).toEqual([]);
	});

	it("does not flag plain `try`", () => {
		const code = "let data = try decoder.decode(Payload.self, from: raw)";
		expect(checkSwiftForceTry(code, "Service.swift")).toEqual([]);
	});

	it("does not flag `try!` inside a string literal", () => {
		const code = 'let warning = "never write try! in production"';
		expect(checkSwiftForceTry(code, "Service.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "let x = try! foo()";
		expect(checkSwiftForceTry(code, "Service.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let x = try! foo()";
		expect(checkSwiftForceTry(code, "ServiceTests.swift")).toEqual([]);
	});
});

// ===========================================
// checkSwiftForceUnwrap
// ===========================================
describe("checkSwiftForceUnwrap", () => {
	it("flags force unwrap on an optional value", () => {
		const code = "let name = user.displayName!";
		expect(checkSwiftForceUnwrap(code, "Profile.swift").length).toBe(1);
	});

	it("flags force unwrap following a closing paren/bracket", () => {
		const code = "let first = collection[index]!";
		expect(checkSwiftForceUnwrap(code, "Profile.swift").length).toBe(1);
	});

	it("does not flag boolean negation `!flag`", () => {
		// `!` preceded by a non-word char (space after `=`) — not a force unwrap.
		const code = "let ready = !isEnabled";
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not flag not-equal operator `!=`", () => {
		const code = "if count != 0 { return }";
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not flag @IBOutlet lines (standard UIKit pattern)", () => {
		const code = "@IBOutlet weak var titleLabel: UILabel!";
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not double-report `as!` (handled by force-cast check)", () => {
		const code = "let widget = anyValue as! WidgetView";
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not double-report `try!` (handled by force-try check)", () => {
		const code = "let data = try! decoder.decode(Payload.self, from: raw)";
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not flag force unwrap inside a string literal", () => {
		const code = 'let msg = "value!"';
		expect(checkSwiftForceUnwrap(code, "Profile.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "let x = y!";
		expect(checkSwiftForceUnwrap(code, "Profile.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let name = user.displayName!";
		expect(checkSwiftForceUnwrap(code, "ProfileTests.swift")).toEqual([]);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 14 }, (_, i) => `let v${i} = obj.field${i}!`).join("\n");
		expect(checkSwiftForceUnwrap(code, "Profile.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftImplicitlyUnwrappedOptional
// ===========================================
describe("checkSwiftImplicitlyUnwrappedOptional", () => {
	it("flags `var name: Type!` declaration", () => {
		const code = "var session: NetworkSession!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift").length).toBe(1);
	});

	it("flags `let name: Type!` with a generic type", () => {
		const code = "let cache: Store<String, Item>!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift").length).toBe(1);
	});

	it("does not flag @IBOutlet declarations", () => {
		const code = "@IBOutlet var titleLabel: UILabel!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift")).toEqual([]);
	});

	it("does not flag a normal optional `Type?`", () => {
		const code = "var session: NetworkSession?";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift")).toEqual([]);
	});

	it("does not flag a non-optional typed declaration", () => {
		const code = "var session: NetworkSession";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift")).toEqual([]);
	});

	it("excludes a declaration line that also contains `as!`", () => {
		// `let z: Foo!` matches the IUO pattern, but the line carries `as!`,
		// which has its own check — so the inner as!/try! guard skips it.
		const code = "let value: Foo! = source as! Foo";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift")).toEqual([]);
	});

	it("excludes a declaration line that also contains `try!`", () => {
		const code = "let value: Foo! = try! make()";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "var session: NetworkSession!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "var session: NetworkSession!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "ClientTests.swift")).toEqual([]);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 13 }, (_, i) => `var prop${i}: Service!`).join("\n");
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Client.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftDelegateNotWeak
// ===========================================
describe("checkSwiftDelegateNotWeak", () => {
	it("flags `var delegate: Type` without weak", () => {
		const code = "var delegate: FlowDelegate";
		expect(checkSwiftDelegateNotWeak(code, "Flow.swift").length).toBe(1);
	});

	it("flags a capitalized `var someDelegate: Type`", () => {
		const code = "var scrollDelegate: ScrollHandler";
		expect(checkSwiftDelegateNotWeak(code, "Flow.swift").length).toBe(1);
	});

	it("does not flag a delegate declared `weak var`", () => {
		const code = "weak var delegate: FlowDelegate";
		expect(checkSwiftDelegateNotWeak(code, "Flow.swift")).toEqual([]);
	});

	it("does not flag a non-delegate var", () => {
		const code = "var counter: Int";
		expect(checkSwiftDelegateNotWeak(code, "Flow.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "var delegate: FlowDelegate";
		expect(checkSwiftDelegateNotWeak(code, "Flow.ts")).toEqual([]);
	});

	it("runs on test files too (no test-file skip in this detector)", () => {
		const code = "var delegate: FlowDelegate";
		expect(checkSwiftDelegateNotWeak(code, "FlowTests.swift").length).toBe(1);
	});

	it("caps results at 10 even with more occurrences", () => {
		// The pattern needs `…[Dd]elegate` immediately before `:`, so the
		// fixture varies the PREFIX (tap/pan/zoom…) rather than suffixing a digit.
		const prefixes = ["tap", "pan", "zoom", "scroll", "swipe", "flow", "nav", "edit", "list", "grid", "form", "menu"];
		const code = prefixes.map((p) => `var ${p}Delegate: Handler`).join("\n");
		expect(checkSwiftDelegateNotWeak(code, "Flow.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftLegacyRandom
// ===========================================
describe("checkSwiftLegacyRandom", () => {
	it("flags arc4random()", () => {
		const code = "let n = arc4random()";
		expect(checkSwiftLegacyRandom(code, "Rng.swift").length).toBe(1);
	});

	it("flags arc4random_uniform()", () => {
		const code = "let n = arc4random_uniform(100)";
		expect(checkSwiftLegacyRandom(code, "Rng.swift").length).toBe(1);
	});

	it("does not flag Int.random(in:)", () => {
		const code = "let n = Int.random(in: 0..<100)";
		expect(checkSwiftLegacyRandom(code, "Rng.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "let n = arc4random()";
		expect(checkSwiftLegacyRandom(code, "Rng.ts")).toEqual([]);
	});

	it("runs on test files too (no test-file skip in this detector)", () => {
		const code = "let n = arc4random()";
		expect(checkSwiftLegacyRandom(code, "RngTests.swift").length).toBe(1);
	});
});

// ===========================================
// checkSwiftLegacyHashValue
// ===========================================
describe("checkSwiftLegacyHashValue", () => {
	it("flags `var hashValue: Int`", () => {
		const code = "var hashValue: Int { return id }";
		expect(checkSwiftLegacyHashValue(code, "Model.swift").length).toBe(1);
	});

	it("does not flag the modern hash(into:) implementation", () => {
		const code = "func hash(into hasher: inout Hasher) { hasher.combine(id) }";
		expect(checkSwiftLegacyHashValue(code, "Model.swift")).toEqual([]);
	});

	it("does not flag a plain hashValue access (not a declaration)", () => {
		const code = "let h = other.hashValue";
		expect(checkSwiftLegacyHashValue(code, "Model.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "var hashValue: Int { return id }";
		expect(checkSwiftLegacyHashValue(code, "Model.ts")).toEqual([]);
	});
});

// ===========================================
// checkSwiftFileIdOverFilePath — extra branches not in swift.test.ts
// ===========================================
describe("checkSwiftFileIdOverFilePath (supplementary branches)", () => {
	it("does not flag a block-comment-opening line `/* ... */`", () => {
		const code = "/* uses #file historically */";
		expect(checkSwiftFileIdOverFilePath(code, "Log.swift")).toEqual([]);
	});

	it("does not flag a continuation comment line starting with `*`", () => {
		const code = " * see #file for details";
		expect(checkSwiftFileIdOverFilePath(code, "Log.swift")).toEqual([]);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 13 }, () => "log(at: #file)").join("\n");
		expect(checkSwiftFileIdOverFilePath(code, "Log.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftAbbreviations — extra branches not in swift.test.ts
// ===========================================
describe("checkSwiftAbbreviations (supplementary branches)", () => {
	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 12 }, (_, i) => `var btn${i}: UIButton`).join("\n");
		expect(checkSwiftAbbreviations(code, "View.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftGlobalVarNoIsolation — branches not in swift.test.ts
// ===========================================
describe("checkSwiftGlobalVarNoIsolation (supplementary branches)", () => {
	it("does not flag when the previous line carries @MainActor", () => {
		const code = "@MainActor\nvar shared = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift")).toEqual([]);
	});

	it("does not flag when an inline global actor annotation is present", () => {
		const code = "@GlobalActor var shared = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift")).toEqual([]);
	});

	it("flags a private file-scope var", () => {
		const code = "private var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift").length).toBe(1);
	});

	it("does not flag a var nested inside a deeper brace scope", () => {
		const code = "struct Box {\n  func make() {\n    var local = 0\n  }\n}";
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift")).toEqual([]);
	});

	it("caps results at 10 even with more file-scope vars", () => {
		const code = Array.from({ length: 12 }, (_, i) => `var global${i} = ${i}`).join("\n");
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftUnhandledTaskError — branches not in swift.test.ts
// ===========================================
describe("checkSwiftUnhandledTaskError (supplementary branches)", () => {
	it("flags Task.detached { try ... } without do/catch", () => {
		const code = ["Task.detached {", "  try await doWork()", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Worker.swift").length).toBe(1);
	});

	it("flags `do {` body that never reaches a matching catch", () => {
		// `do {` opens but no `catch` follows within the task body, so the
		// do/catch lookahead falls through and the unhandled `try` is flagged.
		const code = ["Task {", "  do {", "    try await doWork()", "  }", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Worker.swift").length).toBe(1);
	});

	it("caps results at 10 even with many unhandled-try tasks", () => {
		const block = ["Task {", "  try await doWork()", "}"].join("\n");
		const code = Array.from({ length: 12 }, () => block).join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Worker.swift").length).toBe(10);
	});
});

// ===========================================
// checkSwiftSelfInEscapingClosure — cap branch not in swift.test.ts
// ===========================================
describe("checkSwiftSelfInEscapingClosure (supplementary branches)", () => {
	it("caps results at 10 even with many offending escaping closures", () => {
		// Each pair is an `@escaping` line followed by a `self.` line, so the
		// inner scan records one match per pair; with 12 pairs the outer
		// `matches.length >= 10` guard must stop the loop at 10.
		const code = Array.from({ length: 12 }, (_, i) =>
			[`func reg${i}(h: @escaping () -> Void) {`, `    self.value = ${i}`, "}"].join("\n"),
		).join("\n");
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift").length).toBe(10);
	});
});

// ===========================================
// checkTestRegressions
// ===========================================
describe("checkTestRegressions", () => {
	it("returns empty result for a non-test file", () => {
		const code = "it.skip('x', () => {});";
		expect(checkTestRegressions(code, "src/app.ts")).toEqual({ skipped: [], assertionCount: 0 });
	});

	it("returns empty result for a test file with an unsupported extension", () => {
		const code = "it.skip('x', () => {})";
		// `.py` matches isTestFile (test_*.py) but is not in the JS/TS ext set.
		expect(checkTestRegressions(code, "test_thing.py")).toEqual({
			skipped: [],
			assertionCount: 0,
		});
	});

	it("detects `.skip` and counts assertions in a JS/TS test file", () => {
		const code = [
			"describe('suite', () => {",
			"  it.skip('pending', () => {",
			"    expect(value).toBe(1);",
			"  });",
			"  it('runs', () => {",
			"    expect(other).toBe(2);",
			"    assert.equal(a, b);",
			"  });",
			"});",
		].join("\n");
		const result = checkTestRegressions(code, "src/__tests__/app.test.ts");
		expect(result.skipped.length).toBe(1);
		expect(result.assertionCount).toBe(3);
	});

	it("detects `.todo` and `xit(` patterns", () => {
		const code = ["test.todo('later');", "xit('disabled', () => {});"].join("\n");
		const result = checkTestRegressions(code, "src/__tests__/app.test.ts");
		expect(result.skipped.length).toBe(2);
	});

	it("counts `.should.` style assertions", () => {
		const code = "it('chai', () => { value.should.equal(1); });";
		const result = checkTestRegressions(code, "src/__tests__/app.test.ts");
		expect(result.assertionCount).toBe(1);
	});

	it("returns zero assertions for a test file with none", () => {
		const code = "it('noop', () => { doThing(); });";
		const result = checkTestRegressions(code, "src/__tests__/app.test.ts");
		expect(result.assertionCount).toBe(0);
		expect(result.skipped).toEqual([]);
	});
});

// ===========================================
// extractEnvReferences
// ===========================================
describe("extractEnvReferences", () => {
	it("returns empty for an unsupported extension", () => {
		expect(extractEnvReferences("process.env.FOO", "config.json")).toEqual([]);
	});

	it("returns empty for a test file", () => {
		expect(extractEnvReferences("process.env.FOO", "src/app.test.ts")).toEqual([]);
	});

	it("returns empty for a .d.ts declaration file", () => {
		expect(extractEnvReferences("process.env.FOO", "types/app.d.ts")).toEqual([]);
	});

	it("extracts process.env.X dot access", () => {
		const refs = extractEnvReferences("const t = process.env.SERVICE_TOKEN;", "src/app.ts");
		expect(refs.map((r) => r.name)).toEqual(["SERVICE_TOKEN"]);
		expect(refs[0]?.source).toBe("process.env");
		expect(refs[0]?.line).toBe(1);
	});

	it("extracts import.meta.env, c.env, and bare env.X dot forms", () => {
		const code = [
			"const a = import.meta.env.BUILD_TARGET;",
			"const b = c.env.WORKER_KEY;",
			"const d = env.QUEUE_NAME;",
		].join("\n");
		const refs = extractEnvReferences(code, "src/app.ts");
		const sources = refs.map((r) => r.source).sort();
		expect(sources).toEqual(["c.env", "env.X", "import.meta.env"]);
	});

	it("extracts bracket access with double and single quotes", () => {
		const code = [
			'const a = process.env["DOUBLE_KEY"];',
			"const b = process.env['SINGLE_KEY'];",
		].join("\n");
		const refs = extractEnvReferences(code, "src/app.ts");
		expect(refs.map((r) => r.name).sort()).toEqual(["DOUBLE_KEY", "SINGLE_KEY"]);
	});

	it("extracts Env[\"X\"] / Env['X'] binding bracket forms", () => {
		const code = ['const a = Env["BINDING_A"];', "const b = Env['BINDING_B'];"].join("\n");
		const refs = extractEnvReferences(code, "src/app.ts");
		expect(refs.map((r) => r.name).sort()).toEqual(["BINDING_A", "BINDING_B"]);
	});

	it("filters out system env vars but keeps project ones", () => {
		const code = "const a = process.env.PATH;\nconst b = process.env.MY_FLAG;";
		const refs = extractEnvReferences(code, "src/app.ts");
		expect(refs.map((r) => r.name)).toEqual(["MY_FLAG"]);
	});

	it("does not count an env reference that only appears inside a string literal", () => {
		const code = 'const note = "read process.env.SECRET_VALUE at runtime";';
		expect(extractEnvReferences(code, "src/app.ts")).toEqual([]);
	});

	it("also scans Python files", () => {
		const code = "token = os.environ\nx = env.PY_FLAG";
		const refs = extractEnvReferences(code, "src/app.py");
		expect(refs.map((r) => r.name)).toEqual(["PY_FLAG"]);
	});
});

// ===========================================
// parseEnvDocumentation — real temp dirs
// ===========================================
describe("parseEnvDocumentation", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	const run = (root: string): Set<string> =>
		parseEnvDocumentation(root, { existsSync, readFileSync, readdirSync }, join);

	it("parses var names from a .env.example file (incl. commented form)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		writeFileSync(
			join(dir, ".env.example"),
			["SERVICE_TOKEN=abc", "# OPTIONAL_FLAG=1", "lowercase=skip"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("SERVICE_TOKEN")).toBe(true);
		expect(documented.has("OPTIONAL_FLAG")).toBe(true);
		expect(documented.has("lowercase")).toBe(false);
	});

	it("parses [vars] and binding/name keys from wrangler.toml", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			[
				'name = "WORKER_NAME"',
				"[[kv_namespaces]]",
				'binding = "SESSION_KV"',
				"[vars]",
				'TOOL_MODE = "extended"',
				"[other]",
				'IGNORED_AFTER_VARS = "x"',
			].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("WORKER_NAME")).toBe(true);
		expect(documented.has("SESSION_KV")).toBe(true);
		expect(documented.has("TOOL_MODE")).toBe(true);
		// IGNORED_AFTER_VARS sits under [other], not [vars] — must not leak.
		expect(documented.has("IGNORED_AFTER_VARS")).toBe(false);
	});

	it("parses keys and bindings from wrangler.jsonc", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		writeFileSync(
			join(dir, "wrangler.jsonc"),
			[
				"{",
				'  "vars": { "FEATURE_X": "on" },',
				'  "kv_namespaces": [{ "binding": "CACHE_KV", "id": "1" }]',
				"}",
			].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("FEATURE_X")).toBe(true);
		expect(documented.has("CACHE_KV")).toBe(true);
	});

	it("discovers wrangler config in an immediate subdirectory", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		mkdirSync(join(dir, "site"));
		writeFileSync(
			join(dir, "site", "wrangler.jsonc"),
			['{ "assets": { "binding": "STATIC_ASSETS" } }'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("STATIC_ASSETS")).toBe(true);
	});

	it("skips dot/node_modules/dist subdirectories during the one-level scan", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		for (const skipped of [".hidden", "node_modules", "dist"]) {
			mkdirSync(join(dir, skipped));
			writeFileSync(
				join(dir, skipped, "wrangler.toml"),
				['name = "SHOULD_BE_SKIPPED"'].join("\n"),
			);
		}
		const documented = run(dir);
		expect(documented.has("SHOULD_BE_SKIPPED")).toBe(false);
	});

	it("parses env: blocks and ${{ secrets.X }} from GitHub workflow files", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			[
				"jobs:",
				"  build:",
				"    env:",
				"      DEPLOY_ENV: production",
				"    steps:",
				"      - run: echo ${{ secrets.DEPLOY_TOKEN }}",
			].join("\n"),
		);
		// A non-workflow file in the same dir is ignored by the .yml/.yaml filter.
		writeFileSync(join(dir, ".github", "workflows", "notes.txt"), "IGNORED_TXT: 1");
		const documented = run(dir);
		expect(documented.has("DEPLOY_ENV")).toBe(true);
		expect(documented.has("DEPLOY_TOKEN")).toBe(true);
		expect(documented.has("IGNORED_TXT")).toBe(false);
	});

	it("returns an empty set when no documentation sources exist", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		expect(run(dir).size).toBe(0);
	});

	it("survives an unreadable .env.example (catch path) without throwing", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		// Make `.env.example` a directory so readFileSync throws EISDIR; the
		// detector's try/catch must swallow it and continue.
		mkdirSync(join(dir, ".env.example"));
		expect(() => run(dir)).not.toThrow();
	});

	it("survives an unreadable wrangler config (catch path) without throwing", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		mkdirSync(join(dir, "wrangler.toml"));
		mkdirSync(join(dir, "wrangler.jsonc"));
		expect(() => run(dir)).not.toThrow();
	});

	it("survives an unreadable workflow directory entry (catch path)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		// A directory named like a workflow file → readFileSync throws EISDIR.
		mkdirSync(join(dir, ".github", "workflows", "broken.yml"));
		expect(() => run(dir)).not.toThrow();
	});

	it("survives a non-existent project root (readdirSync catch path)", () => {
		const missing = join(tmpdir(), "swift-env-does-not-exist-xyz");
		expect(() => run(missing)).not.toThrow();
	});
});

// ===========================================
// extractMockDefinitions
// ===========================================
describe("extractMockDefinitions", () => {
	it("returns empty for a non-test file", () => {
		const code = 'vi.mock("./db", () => ({ query: vi.fn() }));';
		expect(extractMockDefinitions(code, "src/db.ts")).toEqual([]);
	});

	it("returns empty for a test file with an unsupported extension", () => {
		const code = 'vi.mock("./db", () => ({ query: vi.fn() }));';
		expect(extractMockDefinitions(code, "src/db_test.py")).toEqual([]);
	});

	it("extracts mocked names from a relative vi.mock factory", () => {
		const code = [
			'import { describe } from "vitest";',
			'vi.mock("./db", () => ({',
			"  query: vi.fn(),",
			"  connect: vi.fn(),",
			"}));",
		].join("\n");
		const mocks = extractMockDefinitions(code, "src/__tests__/db.test.ts");
		expect(mocks.length).toBe(1);
		expect(mocks[0]?.modulePath).toBe("./db");
		expect(mocks[0]?.mockedNames.sort()).toEqual(["connect", "query"]);
		expect(mocks[0]?.line).toBe(2);
	});

	it("supports the @/ alias prefix and jest.mock", () => {
		const code = 'jest.mock("@/service", () => ({ run: jest.fn() }));';
		const mocks = extractMockDefinitions(code, "src/__tests__/svc.test.ts");
		expect(mocks.length).toBe(1);
		expect(mocks[0]?.modulePath).toBe("@/service");
		expect(mocks[0]?.mockedNames).toEqual(["run"]);
	});

	it("ignores non-relative bare-package mocks", () => {
		const code = 'vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));';
		expect(extractMockDefinitions(code, "src/__tests__/fs.test.ts")).toEqual([]);
	});

	it("ignores a factory that declares no vi.fn()/jest.fn() members", () => {
		const code = 'vi.mock("./constants", () => ({ MAX: 5, MIN: 1 }));';
		expect(extractMockDefinitions(code, "src/__tests__/c.test.ts")).toEqual([]);
	});

	it("balances a factory body that contains a NESTED object literal", () => {
		// The nested `{ host: ... }` exercises the depth++ branch of the
		// brace-matching scanner — the closing `}` must not terminate the
		// factory early, so `query` is still extracted past the nested object.
		const code = [
			'vi.mock("./db", () => ({',
			"  config: { host: 'local', retries: 3 },",
			"  query: vi.fn(),",
			"}));",
		].join("\n");
		const mocks = extractMockDefinitions(code, "src/__tests__/db.test.ts");
		expect(mocks.length).toBe(1);
		expect(mocks[0]?.mockedNames).toEqual(["query"]);
	});
});

// ===========================================
// extractModuleExportNames
// ===========================================
describe("extractModuleExportNames", () => {
	it("extracts export function and async function names", () => {
		const code = "export function alpha() {}\nexport async function beta() {}";
		expect(extractModuleExportNames(code)).toEqual(["alpha", "beta"]);
	});

	it("extracts const/let/var exports", () => {
		const code = "export const a = 1;\nexport let b = 2;\nexport var c = 3;";
		expect(extractModuleExportNames(code)).toEqual(["a", "b", "c"]);
	});

	it("extracts class (incl. abstract) names", () => {
		const code = "export class Widget {}\nexport abstract class Base {}";
		expect(extractModuleExportNames(code)).toEqual(["Widget", "Base"]);
	});

	it("extracts interface and type names", () => {
		const code = "export interface Shape {}\nexport type Id = string;";
		expect(extractModuleExportNames(code)).toEqual(["Shape", "Id"]);
	});

	it("extracts enum names", () => {
		const code = "export enum Color { Red, Green }";
		expect(extractModuleExportNames(code)).toEqual(["Color"]);
	});

	it("records `default` for a default export", () => {
		const code = "export default function () {}";
		expect(extractModuleExportNames(code)).toEqual(["default"]);
	});

	it("extracts single-line named export lists, honoring `as` aliases", () => {
		const code = "export { foo, bar as baz };";
		expect(extractModuleExportNames(code)).toEqual(["foo", "baz"]);
	});

	it("flattens a multi-line named export block onto one line", () => {
		const code = ["export {", "  one,", "  two,", "};"].join("\n");
		expect(extractModuleExportNames(code)).toEqual(["one", "two"]);
	});

	it("strips a `type` modifier inside an export-type list", () => {
		const code = "export type { Alpha, Beta };";
		expect(extractModuleExportNames(code)).toEqual(["Alpha", "Beta"]);
	});

	it("ignores non-export lines", () => {
		const code = "const local = 1;\nfunction helper() {}";
		expect(extractModuleExportNames(code)).toEqual([]);
	});
});
