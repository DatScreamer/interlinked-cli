// Test coverage for the seven swift.ts detector functions that were
// orphaned (defined but not registered) prior to the 2026-05 Swift rollout.
// All seven are now wired through `check-registry/entries-swift.ts`; these
// tests pin their behavior in their newly-active state.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSwiftAbbreviations,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftLegacyHashValue,
	checkSwiftLegacyRandom,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
	parseEnvDocumentation,
} from "./swift.js";

describe("checkSwiftTaskDetached", () => {
	it("flags Task.detached { ... }", () => {
		const code = "Task.detached { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("flags Task.detached(priority:) { ... }", () => {
		const code = "Task.detached(priority: .background) { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("flags multiple Task.detached", () => {
		const code = "Task.detached { a() }\nTask.detached { b() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(2);
	});

	it("does not flag Task { ... } (structured)", () => {
		const code = "Task { await work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag inside string literal", () => {
		const code = 'let s = "use Task.detached only when needed"';
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "Task.detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.ts")).toEqual([]);
	});

	it("N1: checkSwiftTaskDetached does not fire when the call is only in a comment", () => {
		const code = "// avoid Task.detached { legacy() } here, use structured concurrency";
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});

	it("N2: checkSwiftTaskDetached does not fire on a differently-named type ending in Task", () => {
		const code = "MyTask.detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([]);
	});
});

describe("checkSwiftUnhandledTaskError", () => {
	it("flags try inside Task { } with no do/catch", () => {
		const code = `
			Task {
				try await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag try? inside Task { }", () => {
		const code = `
			Task {
				try? await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag try! inside Task { } (force-try is a separate check)", () => {
		const code = `
			Task {
				try! await doWork()
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag try wrapped in do/catch", () => {
		const code = `
			Task {
				do {
					try await doWork()
				} catch {
					logger.error(error)
				}
			}
		`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag Task without try", () => {
		const code = `Task { await doWork() }`;
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "Task { try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftGlobalVarNoIsolation", () => {
	it("flags file-scope var without @MainActor", () => {
		const code = "var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags public var at file scope", () => {
		const code = "public var sharedCount = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag var inside a class", () => {
		const code = `
			class Foo {
				var inside = 0
			}
		`;
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag let at file scope (immutable)", () => {
		const code = "let constant = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag @MainActor var at file scope", () => {
		const code = "@MainActor\nvar counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftSelfInEscapingClosure", () => {
	it("flags self. in @escaping closure body without capture list", () => {
		const code = `
			func register(handler: @escaping () -> Void) {
				handler()
				self.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag with [weak self]", () => {
		const code = `
			func register(handler: @escaping () -> Void) { }
			let h: () -> Void = { [weak self] in
				self?.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag with [unowned self]", () => {
		const code = `
			func register(handler: @escaping () -> Void) { }
			let h: () -> Void = { [unowned self] in
				self.value = 42
			}
		`;
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag file with no @escaping", () => {
		const code = "func f() { self.value = 42 }";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "@escaping closure with self.x";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.ts")).toEqual([]);
	});
});

describe("checkSwiftFilterCount", () => {
	it("flags .filter { ... }.count", () => {
		const code = "let n = items.filter { $0.isActive }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});

	it("flags .filter with multiple-statement body", () => {
		const code = "let n = items.filter { x in x > 0 }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag .count alone", () => {
		const code = "let n = items.count";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag .filter without subsequent .count", () => {
		const code = "let active = items.filter { $0.isActive }";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag .count(where:) (the recommended replacement)", () => {
		const code = "let n = items.count(where: { $0.isActive })";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "items.filter { $0 }.count";
		expect(checkSwiftFilterCount(code, "Foo.ts")).toEqual([]);
	});

	it("N1: checkSwiftFilterCount does not fire when .filter{} and .count are on separate lines", () => {
		const code = "let active = items.filter { $0.isActive }\n	.count";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});

	it("N2: checkSwiftFilterCount does not fire when the call is only in a comment", () => {
		const code = "// consider: items.filter { $0.isActive }.count is wasteful";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([]);
	});
});

describe("checkSwiftFileIdOverFilePath", () => {
	it("flags #file", () => {
		const code = "logger.log(message, file: #file)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift").length).toBe(1);
	});

	it("flags #filePath", () => {
		const code = "logger.log(message, file: #filePath)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag #fileID (the safe form)", () => {
		const code = "logger.log(message, file: #fileID)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag #fileLiteral", () => {
		const code = "let url = #fileLiteral(resourceName: \"img\")";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in comment", () => {
		const code = "// #file is forbidden — use #fileID";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "#file";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "logger.log(message, file: #file)";
		expect(checkSwiftFileIdOverFilePath(code, "FooTests.swift")).toEqual([]);
	});
});

describe("checkSwiftAbbreviations", () => {
	it("flags var btnX", () => {
		const code = "var btnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("flags func mgrFoo", () => {
		const code = "func mgrInit() { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("flags labeled parameter cfg:", () => {
		const code = "func setup(cfg: Config) { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag spelled-out names", () => {
		const code = "var submitButton: UIButton!\nfunc setup(config: Config) { }";
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag abbreviation inside a string literal", () => {
		const code = 'let label = "btn"';
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag in non-Swift file", () => {
		const code = "var btnSubmit: UIButton";
		expect(checkSwiftAbbreviations(code, "Foo.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "var btnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "FooTests.swift")).toEqual([]);
	});
});

// ===========================================
// Mutation-hardening additions (2026-07-31 survivor-elimination campaign).
//
// The per-edit mutation runner scopes coverage to THIS exact-stem companion
// file only (`swift.test.ts`), not the sibling `swift.coverage.test.ts` — so
// every case below duplicates or sharpens assertions even where the sibling
// file already exercises the same function, and adds value-assertions
// (`.toEqual([{ line, text }])` instead of just `.length`) where a
// length-only check let an ObjectLiteral/arithmetic/method-chain mutant
// through undetected.
// ===========================================

describe("checkSwiftLegacyRandom (mutation hardening)", () => {
	it("records the exact line and text for a match", () => {
		const code = "let n = arc4random()";
		expect(checkSwiftLegacyRandom(code, "Rng.swift")).toEqual([{ line: 1, text: "let n = arc4random()" }]);
	});

	it("does not flag when arc4random is a suffix of a longer identifier (word boundary)", () => {
		const code = "let x = myarc4randomHelper()";
		expect(checkSwiftLegacyRandom(code, "Rng.swift")).toEqual([]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "let n = arc4random()";
		expect(checkSwiftLegacyRandom(code, "Rng.ts")).toEqual([]);
	});
});

describe("checkSwiftLegacyHashValue (mutation hardening)", () => {
	it("records the exact line and text for a match", () => {
		const code = "var hashValue: Int { return id }";
		expect(checkSwiftLegacyHashValue(code, "Model.swift")).toEqual([
			{ line: 1, text: "var hashValue: Int { return id }" },
		]);
	});

	it("does not flag in a non-Swift file", () => {
		const code = "var hashValue: Int { return id }";
		expect(checkSwiftLegacyHashValue(code, "Model.ts")).toEqual([]);
	});

	it("tolerates extra whitespace around 'var', 'hashValue', ':' and 'Int'", () => {
		const code = "var   hashValue   :   Int { return x }";
		expect(checkSwiftLegacyHashValue(code, "Model.swift").length).toBe(1);
	});
});

describe("parseEnvDocumentation (mutation hardening)", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	const run = (root: string): Set<string> =>
		parseEnvDocumentation(root, { existsSync, readFileSync, readdirSync }, join);

	it("discovers .env.example two directories above the scanned path (ancestor walk)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-anc-"));
		writeFileSync(join(dir, ".env.example"), "ANCESTOR_TOKEN=abc\n");
		mkdirSync(join(dir, "sub1", "sub2"), { recursive: true });
		const documented = run(join(dir, "sub1", "sub2"));
		expect(documented.has("ANCESTOR_TOKEN")).toBe(true);
	});

	it("parses a heavily-spaced commented .env.example line", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws1-"));
		writeFileSync(join(dir, ".env.example"), "#   SPACED_VAR   =   value\n");
		const documented = run(dir);
		expect(documented.has("SPACED_VAR")).toBe(true);
	});

	it("parses a heavily-spaced wrangler.toml binding= line", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws2-"));
		writeFileSync(join(dir, "wrangler.toml"), '   binding   =   "SPACED_BINDING"\n');
		const documented = run(dir);
		expect(documented.has("SPACED_BINDING")).toBe(true);
	});

	it("parses a heavily-spaced [vars] key in wrangler.toml", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws3-"));
		writeFileSync(join(dir, "wrangler.toml"), ["[vars]", '   SPACED_KEY   = "value"'].join("\n"));
		const documented = run(dir);
		expect(documented.has("SPACED_KEY")).toBe(true);
	});

	it("parses a wrangler.jsonc key with a space before the colon", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws4-"));
		writeFileSync(join(dir, "wrangler.jsonc"), '{ "SPACED_KEY"   : "value" }\n');
		const documented = run(dir);
		expect(documented.has("SPACED_KEY")).toBe(true);
	});

	it("parses a heavily-spaced binding/name key in wrangler.jsonc", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws5-"));
		writeFileSync(join(dir, "wrangler.jsonc"), '{ "binding"   :   "SPACED_BIND" }\n');
		const documented = run(dir);
		expect(documented.has("SPACED_BIND")).toBe(true);
	});

	it("parses a workflow env: key with a space before its colon", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws6-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			["jobs:", "  build:", "    env:", "      SPACED_KEY : production"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("SPACED_KEY")).toBe(true);
	});

	it("parses a heavily-spaced ${{ secrets.X }} reference", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-ws7-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			["jobs:", "  build:", "    steps:", "      - run: echo ${{  secrets.SPACED_TOKEN  }}"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("SPACED_TOKEN")).toBe(true);
	});

	it("does not document a var-shaped name that only appears mid-line, not at line start", () => {
		// `.env.example` line matching is anchored (`^#?\s*...`) — a removed
		// anchor would let it match anywhere in the line.
		dir = mkdtempSync(join(tmpdir(), "swift-env-anchor1-"));
		writeFileSync(join(dir, ".env.example"), "prefix_HELLO=world\n");
		const documented = run(dir);
		expect(documented.has("HELLO")).toBe(false);
	});

	it("also parses .env.sample and .env.template alongside .env.example", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-samples-"));
		writeFileSync(join(dir, ".env.sample"), "SAMPLE_TOKEN=1\n");
		writeFileSync(join(dir, ".env.template"), "TEMPLATE_TOKEN=1\n");
		const documented = run(dir);
		expect(documented.has("SAMPLE_TOKEN")).toBe(true);
		expect(documented.has("TEMPLATE_TOKEN")).toBe(true);
	});

	it("discovers wrangler.jsonc in an immediate subdirectory (one-level scan)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-subdir-"));
		mkdirSync(join(dir, "site"));
		writeFileSync(
			join(dir, "site", "wrangler.jsonc"),
			'{ "assets": { "binding": "STATIC_ASSETS" } }',
		);
		const documented = run(dir);
		expect(documented.has("STATIC_ASSETS")).toBe(true);
	});

	it.each([".hidden", "node_modules", "dist"])(
		"skips the '%s' subdirectory alone during the one-level scan",
		(skipped) => {
			dir = mkdtempSync(join(tmpdir(), "swift-env-skip-"));
			mkdirSync(join(dir, skipped));
			writeFileSync(join(dir, skipped, "wrangler.toml"), 'name = "SHOULD_SKIP"\n');
			const documented = run(dir);
			expect(documented.has("SHOULD_SKIP")).toBe(false);
		},
	);

	it("parses a .yaml workflow file, not just .yml", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-yaml-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(join(dir, ".github", "workflows", "notonly.yaml"), "env:\n  YAML_KEY: value\n");
		const documented = run(dir);
		expect(documented.has("YAML_KEY")).toBe(true);
	});

	it("parses a workflow env: key with zero space before its colon", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-zerocolon-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			["jobs:", "  build:", "    env:", "      SPACEDCOLON:production"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("SPACEDCOLON")).toBe(true);
	});

	it("parses an indented [vars] section header (trim before the anchor test)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-indvars-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			["  [vars]", 'INDENTED_VARS_KEY = "x"'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("INDENTED_VARS_KEY")).toBe(true);
	});

	it("does not enter [vars] mode when '[vars]' only appears mid-line", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-varsmid-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			['note = "see [vars] section in docs"', "NOT_REALLY_A_VAR = 1"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("NOT_REALLY_A_VAR")).toBe(false);
	});

	it("closes an indented [vars] section on the next bracketed header", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-closevars-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			["[vars]", 'IN_VARS = "1"', "  [other]", 'AFTER_OTHER = "2"'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("IN_VARS")).toBe(true);
		expect(documented.has("AFTER_OTHER")).toBe(false);
	});

	it("bounds the ancestor walk to 8 levels even when a real filesystem root is farther away", () => {
		// A .env.example placed 9 levels above the scanned directory must NOT be
		// found — proves the walk's own iteration cap (not just "hit the
		// filesystem root") is what bounds it. A decremented loop counter would
		// never hit the cap and would keep walking past this point.
		dir = mkdtempSync(join(tmpdir(), "swift-env-deep-"));
		writeFileSync(join(dir, ".env.example"), "TOO_DEEP_TOKEN=x\n");
		let deepDir = dir;
		for (const lvl of ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]) {
			deepDir = join(deepDir, lvl);
		}
		mkdirSync(deepDir, { recursive: true });
		const documented = run(deepDir);
		expect(documented.has("TOO_DEEP_TOKEN")).toBe(false);
	});

	it("does not find a .env.example exactly 8 levels up (precise off-by-one boundary)", () => {
		// AUDIT NOTE (2026-08-01): the sibling "bounds the ancestor walk to 8
		// levels" test above places its fixture at 9 levels up, which is ONE
		// LEVEL PAST the actual discriminating distance — both the real code
		// (max reachable ancestor: 7 steps up) and an `i < 8` → `i <= 8`
		// boundary mutant (max reachable ancestor: 8 steps up) return `false`
		// for a target 9 steps up, so that test does NOT kill the classic
		// off-by-one mutant it claims to pin. A target exactly 8 steps up sits
		// past the real code's reach (7) but within the `i <= 8` mutant's reach
		// (8), so only THIS fixture actually distinguishes them. Verified via
		// scratch/audit-swift-2026-07-31/run-boundary-precise-n8.mts: original
		// → false, `i <= 8` mutant → true, at N=8 (not N=9).
		dir = mkdtempSync(join(tmpdir(), "swift-env-deep-precise-"));
		writeFileSync(join(dir, ".env.example"), "EXACT_BOUNDARY_TOKEN=x\n");
		let deepDir = dir;
		for (const lvl of ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]) {
			deepDir = join(deepDir, lvl);
		}
		mkdirSync(deepDir, { recursive: true });
		const documented = run(deepDir);
		expect(documented.has("EXACT_BOUNDARY_TOKEN")).toBe(false);
	});

	it("does not throw on a relative single-segment project root (parent === current)", () => {
		expect(() => run("soloreltoken")).not.toThrow();
		expect(run("soloreltoken").size).toBe(0);
	});
});

describe("checkSwiftFileIdOverFilePath (mutation hardening)", () => {
	it("records the exact line number and trimmed text", () => {
		const code = "ignored\nlogger.log(message, file: #file)";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([
			{ line: 2, text: "logger.log(message, file: #file)" },
		]);
	});

	it("truncates a long matching line's recorded text to 150 chars", () => {
		const filler = "x".repeat(200);
		const code = `logger.log(message, file: #file) // ${filler}`;
		const result = checkSwiftFileIdOverFilePath(code, "Foo.swift");
		expect(result.length).toBe(1);
		expect(result[0]?.text.length).toBe(150);
	});

	it("does not flag an indented comment line (trimStart, not trimEnd)", () => {
		const code = "    // #file example";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a block-comment-opening line", () => {
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

	it("trims leading/trailing whitespace in the recorded text", () => {
		const code = "ignored\n   logger.log(message, file: #file)   ";
		expect(checkSwiftFileIdOverFilePath(code, "Foo.swift")).toEqual([
			{ line: 2, text: "logger.log(message, file: #file)" },
		]);
	});
});

describe("checkSwiftAbbreviations (mutation hardening)", () => {
	it("records the matched line's number and trimmed text", () => {
		const code = "var btnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([
			{ line: 1, text: "var btnSubmit: UIButton!" },
		]);
	});

	it("matches case-insensitively", () => {
		const code = "var BtnSubmit: UIButton!";
		expect(checkSwiftAbbreviations(code, "Foo.swift").length).toBe(1);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 12 }, (_, i) => `var btn${i}: UIButton`).join("\n");
		expect(checkSwiftAbbreviations(code, "View.swift").length).toBe(10);
	});

	it("trims leading/trailing whitespace in the recorded text", () => {
		const code = "   var btnSubmit: UIButton!   ";
		expect(checkSwiftAbbreviations(code, "Foo.swift")).toEqual([
			{ line: 1, text: "var btnSubmit: UIButton!" },
		]);
	});

	it("truncates a long matching line's recorded text to 150 chars", () => {
		const filler = "x".repeat(200);
		const code = `var btnSubmit: UIButton! // ${filler}`;
		const result = checkSwiftAbbreviations(code, "Foo.swift");
		expect(result.length).toBe(1);
		expect(result[0]?.text.length).toBe(150);
	});
});

describe("checkSwiftTaskDetached (mutation hardening)", () => {
	it("records the matched line's number and text", () => {
		const code = "Task.detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift")).toEqual([
			{ line: 1, text: "Task.detached { work() }" },
		]);
	});

	it("tolerates whitespace before the dot", () => {
		const code = "Task .detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("tolerates whitespace after the dot", () => {
		const code = "Task. detached { work() }";
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(1);
	});

	it("caps results at 10 even with more occurrences", () => {
		const code = Array.from({ length: 12 }, (_, i) => `Task.detached { a${i}() }`).join("\n");
		expect(checkSwiftTaskDetached(code, "Foo.swift").length).toBe(10);
	});
});

describe("checkSwiftUnhandledTaskError (mutation hardening)", () => {
	it("records the matched line's number and text", () => {
		const code = "Task { try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([
			{ line: 1, text: "Task { try await doWork() }" },
		]);
	});

	it("caps results at 10 even with more occurrences", () => {
		const block = ["Task {", "  try await doWork()", "}"].join("\n");
		const code = Array.from({ length: 12 }, () => block).join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(10);
	});

	it("flags Task{ with no space before the brace", () => {
		const code = "Task{ try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags Task.detached { with zero space around the dot", () => {
		const code = "Task.detached { try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags Task. detached { with a space after the dot", () => {
		const code = "Task. detached { try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags Task.detached{ with no space before the brace", () => {
		const code = "Task.detached{ try await doWork() }";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags a try that appears several lines into the task body", () => {
		const code = ["Task {", "  let x = compute()", "  try await doWork()", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag a try that appears after the task's own closing brace", () => {
		const code = ["Task {", "  doWork()", "}", "try somethingElse()"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("flags a try nested one brace level deeper (if-block) inside the task", () => {
		const code = ["Task {", "  if condition {", "    try await doWork()", "  }", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags a try on the line right after a Task{} that closes on its own opening line", () => {
		// A same-line-closed `Task {}` returns depth to 0 while j === i, so the
		// scan does not stop until the NEXT line — this is the detector's actual
		// (imperfect but current) behavior, and it pins the `j > i` requirement
		// in the break condition: forcing `j > i` to always be true would end
		// the scan one line early and miss this try entirely.
		const code = ["Task {}", "try somethingElse()"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag a try wrapped in do{ with no space before the brace", () => {
		const code = [
			"Task {",
			"  do{",
			"    try await doWork()",
			"  } catch {",
			"    handle(error)",
			"  }",
			"}",
		].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([]);
	});

	it("flags an unhandled try even when a later line has 'catch' only as a labeled parameter", () => {
		const code = ["Task {", "  try await doWork()", "  retryHandler(catch: true)", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("flags a do{} block that never finds a matching catch within the whole scan bound", () => {
		// Short body forces the catch-lookahead's Math.min(i+30, length) bound to
		// be `length`, not `i+30` — a Math.max mix-up or an off-by-one on the
		// lookahead's own end condition would walk past the array and throw.
		const code = ["Task {", "  do {", "    try await doWork()", "  }", "}"].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("does not let a 'catch' word BEFORE the do{ block satisfy its own do/catch", () => {
		const code = [
			"Task {",
			"  someHandler(catch: true)",
			"  do {",
			"    try await doWork()",
			"  }",
			"}",
		].join("\n");
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift").length).toBe(1);
	});

	it("trims leading/trailing whitespace in the recorded text", () => {
		const code = "   Task { try await doWork() }   ";
		expect(checkSwiftUnhandledTaskError(code, "Foo.swift")).toEqual([
			{ line: 1, text: "Task { try await doWork() }" },
		]);
	});

	it("truncates a long matching line's recorded text to 150 chars", () => {
		const filler = "x".repeat(200);
		const code = `Task { try await doWork() } // ${filler}`;
		const result = checkSwiftUnhandledTaskError(code, "Foo.swift");
		expect(result.length).toBe(1);
		expect(result[0]?.text.length).toBe(150);
	});
});

describe("checkSwiftGlobalVarNoIsolation (mutation hardening)", () => {
	it("records the matched line's number and text", () => {
		const code = "var counter = 0";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([
			{ line: 1, text: "var counter = 0" },
		]);
	});

	it("caps results at 10 even with more file-scope vars", () => {
		const code = Array.from({ length: 12 }, (_, i) => `var global${i} = ${i}`).join("\n");
		expect(checkSwiftGlobalVarNoIsolation(code, "State.swift").length).toBe(10);
	});

	it("does not flag a line where 'var' appears mid-expression, not as a declaration", () => {
		const code = "someExpr.var thing = 5";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("flags an indented file-scope var declaration", () => {
		const code = "    var indented = 5";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags 'public' with doubled internal whitespace", () => {
		const code = "public  var a = 1";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags 'internal' with doubled internal whitespace", () => {
		const code = "internal  var b = 2";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags 'fileprivate' with doubled internal whitespace", () => {
		const code = "fileprivate  var c = 3";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags 'private' with doubled internal whitespace", () => {
		const code = "private  var d = 4";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("flags a var declaration with doubled whitespace before the identifier", () => {
		const code = "var  spaced = 5";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift").length).toBe(1);
	});

	it("does not flag a var whose own line carries a @MainActor closure-type annotation", () => {
		// The @Actor check tests the CURRENT line first, falling back to the
		// PREVIOUS line. A single-line fixture can't isolate the current-line
		// regex: `Math.max(0, i - 1)` clamps back to the SAME line when i === 0,
		// so the (unmutated) previous-line check silently re-validates it. A
		// second, annotation-free line before the var forces the current-line
		// regex to be the only thing that can suppress the flag.
		const code = "someOtherCode()\nvar handler: @MainActor () -> Void";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag a var declared after a closed nested block returns brace depth to 0", () => {
		const code = ["class Foo {", "    var inside = 0", "}", "var outside = 1"].join("\n");
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([
			{ line: 4, text: "var outside = 1" },
		]);
	});

	it("trims leading/trailing whitespace and records the true line number", () => {
		const code = "   var counter = 0   ";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([
			{ line: 1, text: "var counter = 0" },
		]);
	});

	it("truncates a long matching line's recorded text to 150 chars", () => {
		const filler = "x".repeat(200);
		const code = `var counter = 0 // ${filler}`;
		const result = checkSwiftGlobalVarNoIsolation(code, "Foo.swift");
		expect(result.length).toBe(1);
		expect(result[0]?.text.length).toBe(150);
	});

	it("still flags a var declaration whose line also contains the literal text 'let ' later on", () => {
		// The "skip let (immutable)" check at L227 is unreachable in its real,
		// anchored form: by this point `line` has already matched the L221
		// var-regex (anchored `^`, requiring literal "var" right after the
		// optional modifier), so an anchored "let" regex tested against the
		// SAME string can never also match at position 0 -- "var" and "let"
		// can't both be the literal text at one fixed start position. A mutant
		// that drops the `^` anchor turns L227 into an UNANCHORED search that
		// would find "let " anywhere in the line -- including here, where it
		// appears after a semicolon -- and wrongly `continue`s past this var
		// declaration instead of flagging it.
		const code = "var counter = 1; let y = 2";
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([
			{ line: 1, text: "var counter = 1; let y = 2" },
		]);
	});
});

describe("checkSwiftSelfInEscapingClosure (mutation hardening)", () => {
	it("caps results at 10 even with more offending closures", () => {
		const code = Array.from({ length: 12 }, (_, i) =>
			[`func reg${i}(h: @escaping () -> Void) {`, `    self.value = ${i}`, "}"].join("\n"),
		).join("\n");
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift").length).toBe(10);
	});

	it("does not flag a later self reference in a non-Swift file (extension guard)", () => {
		const code = "func f(handler: @escaping () -> Void) {\n  self.value = 1\n}";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.ts")).toEqual([]);
	});

	it("does not flag self on the same line as the @escaping declaration", () => {
		const code = "func register(handler: @escaping () -> Void) { self.value = 42 }";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag when no self reference follows within the closure", () => {
		const code = "func register(handler: @escaping () -> Void) {\n    doSomethingElse()\n}";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag with a leading space inside the [weak self] capture list", () => {
		const code = [
			"func register(handler: @escaping () -> Void) { }",
			"let h: () -> Void = { [ weak self] in",
			"    self.value = 42",
			"}",
		].join("\n");
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag with a trailing space inside the [weak self] capture list", () => {
		const code = [
			"func register(handler: @escaping () -> Void) { }",
			"let h: () -> Void = { [weak self ] in",
			"    self.value = 42",
			"}",
		].join("\n");
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("does not flag with doubled internal whitespace inside the capture list", () => {
		const code = [
			"func register(handler: @escaping () -> Void) { }",
			"let h: () -> Void = { [weak  self] in",
			"    self.value = 42",
			"}",
		].join("\n");
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([]);
	});

	it("records the exact line and trimmed text for a match", () => {
		const code = "func register(handler: @escaping () -> Void) {\n   self.value = 42   \n}";
		expect(checkSwiftSelfInEscapingClosure(code, "Foo.swift")).toEqual([
			{ line: 2, text: "self.value = 42" },
		]);
	});

	it("truncates a long matching line's recorded text to 150 chars", () => {
		const filler = "x".repeat(200);
		const code = `func register(handler: @escaping () -> Void) {\nself.value = 42 // ${filler}\n}`;
		const result = checkSwiftSelfInEscapingClosure(code, "Foo.swift");
		expect(result.length).toBe(1);
		expect(result[0]?.text.length).toBe(150);
	});
});

describe("checkSwiftFilterCount (mutation hardening)", () => {
	it("records the matched line's number and text", () => {
		const code = "let n = items.filter { $0.isActive }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift")).toEqual([
			{ line: 1, text: "let n = items.filter { $0.isActive }.count" },
		]);
	});

	it("flags .filter{ with no space before the brace", () => {
		const code = "let n = items.filter{ $0.isActive }.count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});

	it("flags a space between the closing brace and .count", () => {
		const code = "let n = items.filter { $0.isActive } .count";
		expect(checkSwiftFilterCount(code, "Foo.swift").length).toBe(1);
	});
});

// ===========================================
// Mutation-hardening round 2 (2026-08-01 survivor-elimination continuation).
//
// This round targets `parseEnvDocumentation`'s ancestor-walk arithmetic, its
// four `existsSync`-guard early-returns, and the anchor-sensitive regexes in
// its wrangler/workflow parsing — all only reachable through the injected
// `fs` parameter, which is exactly the seam the function's own JSDoc
// documents as the testing interface (not a builtin stub).
// ===========================================

type FakeFs = {
	existsSync: (p: string) => boolean;
	readFileSync: (p: string, e: BufferEncoding) => string;
	readdirSync: (p: string) => string[];
};

describe("parseEnvDocumentation (mutation hardening round 2)", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	const run = (root: string): Set<string> =>
		parseEnvDocumentation(root, { existsSync, readFileSync, readdirSync }, join);

	it("scans projectRoot itself first — no placeholder entry ahead of the real root", () => {
		const seen: string[] = [];
		const fakeFs: FakeFs = {
			existsSync: (p) => {
				seen.push(p);
				return false;
			},
			readFileSync: () => "",
			readdirSync: () => [],
		};
		parseEnvDocumentation("/abc/def", fakeFs, join);
		// An ArrayDeclaration mutant seeding `roots` with a placeholder entry
		// would make this the SECOND existsSync call, not the first.
		expect(seen[0]).toBe(join("/abc/def", ".env.example"));
	});

	it("finds a token exactly at the 8-hop ancestor boundary (kills the i<=8 off-by-one)", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-deep8-"));
		writeFileSync(join(dir, ".env.example"), "EIGHT_LEVEL_TOKEN=x\n");
		let deepDir = dir;
		for (const lvl of ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]) {
			deepDir = join(deepDir, lvl);
		}
		mkdirSync(deepDir, { recursive: true });
		// dir sits exactly 8 hops above deepDir. The real loop's max reach is
		// 7 hops (i<8, pushing BEFORE advancing) — one short of dir — so this
		// must be false. A relaxed i<=8 walks one hop further and would find it.
		const documented = run(deepDir);
		expect(documented.has("EIGHT_LEVEL_TOKEN")).toBe(false);
	});

	it("stops the ancestor walk immediately once parent === current (self-referential root)", () => {
		const calls: string[] = [];
		const fakeFs: FakeFs = {
			existsSync: (p) => {
				calls.push(p);
				return false;
			},
			readFileSync: () => "",
			readdirSync: () => {
				throw new Error("unused in this probe");
			},
		};
		parseEnvDocumentation("soloreltoken", fakeFs, join);
		// A relative single-segment root's own "parent" is itself, so the walk
		// must break after pushing it exactly once. Any break-condition mutant
		// that fails to stop here re-scans the same identical root up to the
		// i<8 bound instead.
		const envExampleCalls = calls.filter((p) => p.endsWith(".env.example"));
		expect(envExampleCalls.length).toBe(1);
	});

	it("stops the ancestor walk immediately once parent becomes falsy (root collapses to '')", () => {
		const calls: string[] = [];
		const fakeFs: FakeFs = {
			existsSync: (p) => {
				calls.push(p);
				return false;
			},
			readFileSync: () => "",
			readdirSync: () => {
				throw new Error("unused in this probe");
			},
		};
		parseEnvDocumentation("/some", fakeFs, join);
		// "/some"'s computed parent is "" (falsy) on the very first hop.
		const envExampleCalls = calls.filter((p) => p.endsWith(".env.example"));
		expect(envExampleCalls.length).toBe(1);
	});

	it("stops the ancestor walk immediately once parent becomes the literal '/' root", () => {
		const calls: string[] = [];
		const fakeFs: FakeFs = {
			existsSync: (p) => {
				calls.push(p);
				return false;
			},
			readFileSync: () => "",
			readdirSync: () => {
				throw new Error("unused in this probe");
			},
		};
		// A double-leading-slash root's computed parent collapses to the
		// literal "/" on the first hop — the third break clause specifically.
		parseEnvDocumentation("//abnormal", fakeFs, join);
		const envExampleCalls = calls.filter((p) => p.endsWith(".env.example"));
		expect(envExampleCalls.length).toBe(1);
	});

	it("never reads an env-doc / wrangler config / workflow dir that existsSync says is absent", () => {
		const readFileCalls: string[] = [];
		const readdirCalls: string[] = [];
		const fakeFs: FakeFs = {
			existsSync: () => false,
			readFileSync: (p) => {
				readFileCalls.push(p);
				return "";
			},
			readdirSync: (p) => {
				readdirCalls.push(p);
				return [];
			},
		};
		parseEnvDocumentation("/fake/root/xyz", fakeFs, join);
		// The env-doc and wrangler-config existsSync guards must prevent any
		// readFileSync call when nothing exists on disk.
		expect(readFileCalls).toEqual([]);
		// readdirSync IS called once, unconditionally, for the immediate-
		// subdirectory scan of projectRoot itself — but the .github/workflows
		// existsSync guard must prevent any further readdirSync calls.
		expect(readdirCalls).toEqual([join("/fake/root/xyz")]);
	});

	it("keeps discovering vars from later .env.example lines after an earlier line fails to match", () => {
		// `if (m) documented.add(nonNull(m[1]))` -- a mutant that always enters
		// this branch (`if (true)`) would call `m[1]` while `m` is null on the
		// non-matching first line. That throws INSIDE the `for (const line of
		// content.split("\n"))` loop, which is caught by the surrounding
		// try/catch -- aborting the rest of the loop entirely, so a valid var on
		// a LATER line is never reached. The real code's `if (m)` guard simply
		// skips the non-matching line and keeps iterating.
		dir = mkdtempSync(join(tmpdir(), "swift-env-l337-"));
		writeFileSync(join(dir, ".env.example"), "lowercase=nope\nVALID_VAR=1\n");
		const documented = run(dir);
		expect(documented.has("VALID_VAR")).toBe(true);
	});

	it("does not treat a mid-line 'binding =' occurrence as a real TOML binding declaration", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-midbind-"));
		writeFileSync(join(dir, "wrangler.toml"), 'note: binding = "SHOULD_NOT_APPEAR"\n');
		const documented = run(dir);
		expect(documented.has("SHOULD_NOT_APPEAR")).toBe(false);
	});

	it("does not exit [vars] mode from a bracket that only appears mid-line", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-midbracket-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			["[vars]", 'IN_VARS = "1"', "docs mention [other] bracket format", 'AFTER_BRACKET = "2"'].join(
				"\n",
			),
		);
		const documented = run(dir);
		expect(documented.has("AFTER_BRACKET")).toBe(true);
	});

	it("does not document a var-shaped key that is commented out inside a [vars] block", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-commentedvar-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			["[vars]", "# NOT_A_VAR = 1", 'REAL_VAR = "2"'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("NOT_A_VAR")).toBe(false);
		expect(documented.has("REAL_VAR")).toBe(true);
	});

	it("does not lose a later valid [vars] entry when an earlier line in the block fails to match", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-varsskip-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			["[vars]", "not a key value line at all", 'REAL_VAR = "1"'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("REAL_VAR")).toBe(true);
	});

	it("does not lose a later JSONC key when an earlier line has no binding info", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-jsoncskip-"));
		writeFileSync(
			join(dir, "wrangler.jsonc"),
			['{ "FIRST_KEY": "x",', '  "SECOND_KEY": "y" }'].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("SECOND_KEY")).toBe(true);
	});

	it("discovers wrangler.jsonc in a subdirectory via the JSONC branch, not the TOML branch", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-subdir2-"));
		mkdirSync(join(dir, "site2"));
		writeFileSync(
			join(dir, "site2", "wrangler.jsonc"),
			'{ "binding": "STATIC_ASSETS_2" }',
		);
		const documented = run(dir);
		expect(documented.has("STATIC_ASSETS_2")).toBe(true);
	});

	it("discovers a wrangler.toml (TOML syntax, not JSONC) binding in an immediate subdirectory", () => {
		// Distinct from the JSONC-subdir test above: this is the ONLY case that
		// exercises `parseWranglerFile(join(subdir, "wrangler.toml"), true)`
		// with a REAL file on disk. A StringLiteral mutant on the filename
		// ("wrangler.toml" -> "") would target the subdir itself (a directory),
		// throw EISDIR on read (caught silently), and never find this binding.
		// A BooleanLiteral mutant on `isToml` (true -> false) would parse this
		// TOML-syntax file with the JSONC-only regexes, which require the key
		// itself to be quoted (`"binding":`) -- `binding = "..."` has no
		// quotes around `binding`, so it wouldn't match either. Both mutants
		// fail to discover the binding; only the real code does.
		dir = mkdtempSync(join(tmpdir(), "swift-env-subdir-toml-"));
		mkdirSync(join(dir, "site3"));
		writeFileSync(join(dir, "site3", "wrangler.toml"), '  binding   =   "SUBDIR_TOML_BINDING"\n');
		const documented = run(dir);
		expect(documented.has("SUBDIR_TOML_BINDING")).toBe(true);
	});

	it("skips a non-.yml/.yaml file in .github/workflows even if it looks like it has env content", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-nonyml-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "readme.txt"),
			"env:\n  SHOULD_NOT_APPEAR: value\n",
		);
		const documented = run(dir);
		expect(documented.has("SHOULD_NOT_APPEAR")).toBe(false);
	});

	it("does not document a mid-line indented-looking workflow key that isn't at line start", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-midkey-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			["jobs:", "  build:", "    steps:", "      - run: xyz  MIDLINE_KEY: value"].join("\n"),
		);
		const documented = run(dir);
		expect(documented.has("MIDLINE_KEY")).toBe(false);
	});
});
