import { describe, expect, it } from "vitest";
import {
	classifyBrowserToolName,
	classifyVerificationCommand,
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	formatBisectNotResetWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatTddRegressionWarning,
	formatUiNotInteractedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
	isCodeFile,
	isDocFactSourceFile,
	isUiFile,
	scanForStubs,
	STUB_INTRODUCED_CAP,
} from "../verification-stop-checks.js";

describe("classifyVerificationCommand", () => {
	it("classifies typechecker invocations", () => {
		expect(classifyVerificationCommand("tsc --noEmit")).toBe("typecheck");
		expect(classifyVerificationCommand("npx tsc -p tsconfig.json")).toBe("typecheck");
		expect(classifyVerificationCommand("ttsc")).toBe("typecheck");
	});

	it("classifies test runners across ecosystems", () => {
		expect(classifyVerificationCommand("bun run test")).toBe("test");
		expect(classifyVerificationCommand("npm test")).toBe("test");
		expect(classifyVerificationCommand("npx vitest run")).toBe("test");
		expect(classifyVerificationCommand("pytest -xvs tests/")).toBe("test");
		expect(classifyVerificationCommand("cargo test")).toBe("test");
		expect(classifyVerificationCommand("cargo nextest run")).toBe("test");
		expect(classifyVerificationCommand("go test ./...")).toBe("test");
	});

	it("classifies linters and biome/clippy as lint", () => {
		expect(classifyVerificationCommand("npx biome check")).toBe("lint");
		expect(classifyVerificationCommand("eslint .")).toBe("lint");
		expect(classifyVerificationCommand("oxlint src/")).toBe("lint");
		expect(classifyVerificationCommand("ruff check .")).toBe("lint");
		expect(classifyVerificationCommand("cargo clippy")).toBe("lint");
		expect(classifyVerificationCommand("cargo check")).toBe("lint");
	});

	it("classifies project builds", () => {
		expect(classifyVerificationCommand("npm run build")).toBe("build");
		expect(classifyVerificationCommand("bun run build")).toBe("build");
		expect(classifyVerificationCommand("cargo build --release")).toBe("build");
		expect(classifyVerificationCommand("go build ./...")).toBe("build");
		// `tsc --build` is intentionally classified as typecheck rather than
		// build: tsc is foremost a typechecker, and both signals satisfy the
		// correctness gate in the unverified-code check, so the user-visible
		// behavior is identical. The first-match-wins regex order documents
		// the priority.
		expect(classifyVerificationCommand("tsc --build")).toBe("typecheck");
	});

	it("classifies dev-server starters", () => {
		expect(classifyVerificationCommand("wrangler dev")).toBe("dev-server");
		expect(classifyVerificationCommand("npm run dev")).toBe("dev-server");
		expect(classifyVerificationCommand("bun run dev")).toBe("dev-server");
		expect(classifyVerificationCommand("vite")).toBe("dev-server");
		expect(classifyVerificationCommand("next dev")).toBe("dev-server");
	});

	it("classifies Python dev servers as dev-server", () => {
		expect(classifyVerificationCommand("python -m http.server 8000")).toBe("dev-server");
		expect(classifyVerificationCommand("python3 -m http.server")).toBe("dev-server");
		expect(classifyVerificationCommand("uvicorn main:app --reload")).toBe("dev-server");
		expect(classifyVerificationCommand("flask run")).toBe("dev-server");
	});

	it("classifies browser-automation CLIs as browser interaction", () => {
		expect(classifyVerificationCommand("uvx rodney screenshot")).toBe("browser");
		expect(classifyVerificationCommand("rodney --help")).toBe("browser");
		expect(classifyVerificationCommand("agent-browser snapshot")).toBe("browser");
		expect(classifyVerificationCommand("npx playwright test")).toBe("browser");
		expect(classifyVerificationCommand("playwright codegen")).toBe("browser");
	});

	it("returns null for unrelated commands", () => {
		expect(classifyVerificationCommand("git status")).toBeNull();
		expect(classifyVerificationCommand("ls -la")).toBeNull();
		expect(classifyVerificationCommand("npm install lodash")).toBeNull();
		// Watch mode of typechecker is also a verification signal — `tsc --watch`
		// matches the typecheck regex (does not require --noEmit/--build).
		// Commands that merely mention "tsc" as a path component, however, must
		// not: e.g. /opt/tsconfig-helper.sh — guarded by the word-boundary anchor.
		expect(classifyVerificationCommand("./tsconfig-helper.sh")).toBeNull();
	});

	it("classifies `interlinked verify` as verify-suite (not typecheck)", () => {
		// The suite signal must win over any individual-tool signal because
		// verify spawns tsc, biome, lint, etc. internally — the suite is
		// strictly more informative than any one of them.
		expect(classifyVerificationCommand("interlinked verify")).toBe("verify-suite");
		expect(classifyVerificationCommand("interlinked verify --json")).toBe("verify-suite");
		expect(classifyVerificationCommand("npx interlinked verify")).toBe("verify-suite");
	});

	it("classifies dev-mode verify invocations as verify-suite", () => {
		// During development, verify is invoked through tsx or via the
		// dist/index.js binary rather than the installed `interlinked` bin.
		// Both should still register as a verify-suite signal.
		expect(classifyVerificationCommand("node dist/index.js verify")).toBe("verify-suite");
		expect(classifyVerificationCommand("npx tsx src/index.ts verify")).toBe("verify-suite");
	});
});

describe("classifyBrowserToolName", () => {
	it("classifies chrome-devtools MCP tools as browser interaction", () => {
		expect(classifyBrowserToolName("mcp__chrome-devtools__navigate_page")).toBe("browser");
		expect(classifyBrowserToolName("mcp__chrome-devtools__take_screenshot")).toBe("browser");
	});

	it("classifies playwright browser_* MCP tools as browser interaction", () => {
		expect(classifyBrowserToolName("mcp__playwright__browser_navigate")).toBe("browser");
		expect(classifyBrowserToolName("mcp__playwright__browser_click")).toBe("browser");
	});

	it("returns null for unrelated tools", () => {
		expect(classifyBrowserToolName(undefined)).toBeNull();
		expect(classifyBrowserToolName("Bash")).toBeNull();
		expect(classifyBrowserToolName("Write")).toBeNull();
		expect(classifyBrowserToolName("mcp__some-other-server__do_thing")).toBeNull();
	});
});

describe("isUiFile / isCodeFile", () => {
	it("isUiFile matches the component-framework + markup/style extensions", () => {
		expect(isUiFile("src/App.tsx")).toBe(true);
		expect(isUiFile("components/Button.jsx")).toBe(true);
		expect(isUiFile("pages/Index.vue")).toBe(true);
		expect(isUiFile("routes/_index.svelte")).toBe(true);
		expect(isUiFile("layouts/Default.astro")).toBe(true);
		expect(isUiFile("public/index.html")).toBe(true);
		expect(isUiFile("styles/main.css")).toBe(true);
		expect(isUiFile("styles/main.scss")).toBe(true);
	});

	it("isUiFile does NOT match plain ts/js or back-end files", () => {
		expect(isUiFile("src/server.ts")).toBe(false);
		expect(isUiFile("src/util.js")).toBe(false);
		expect(isUiFile("src/api.py")).toBe(false);
	});

	it("isCodeFile matches source code across languages", () => {
		expect(isCodeFile("src/index.ts")).toBe(true);
		expect(isCodeFile("src/index.tsx")).toBe(true);
		expect(isCodeFile("server.py")).toBe(true);
		expect(isCodeFile("main.rs")).toBe(true);
		expect(isCodeFile("main.go")).toBe(true);
		expect(isCodeFile("script.sh")).toBe(true);
	});

	it("isCodeFile excludes doc/markdown/plan files", () => {
		expect(isCodeFile("README.md")).toBe(false);
		expect(isCodeFile("docs/intro.mdx")).toBe(false);
		expect(isCodeFile("CLAUDE.md")).toBe(false);
		expect(isCodeFile("plans/q3.yaml")).toBe(false);
	});

	it("isCodeFile excludes config/data files", () => {
		expect(isCodeFile("package.json")).toBe(false);
		expect(isCodeFile("bun.lock")).toBe(false);
		expect(isCodeFile("Cargo.toml")).toBe(false);
	});
});

describe("scanForStubs", () => {
	it("matches TODO with delimiter", () => {
		const stubs = scanForStubs("// TODO: implement this");
		expect(stubs).toHaveLength(1);
		expect(stubs[0]?.kind).toBe("TODO");
		expect(stubs[0]?.snippet).toContain("TODO: implement this");
	});

	it("matches FIXME", () => {
		const stubs = scanForStubs("function foo() { /* FIXME — broken */ }");
		expect(stubs.map((s) => s.kind)).toContain("FIXME");
	});

	it("matches not-implemented throw forms", () => {
		const stubs = scanForStubs('function bar() { throw new Error("not implemented"); }');
		expect(stubs.map((s) => s.kind)).toContain("not-implemented-throw");
	});

	it("matches throw new Error('TODO ...') variants", () => {
		const stubs = scanForStubs(`throw new TypeError("TODO: handle stripe webhook")`);
		expect(stubs.map((s) => s.kind)).toContain("not-implemented-throw");
	});

	it("matches disabled tests (.skip and xit / xdescribe)", () => {
		expect(scanForStubs("it.skip('flaky', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("test.skip('TODO', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("describe.skip('legacy', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
		expect(scanForStubs("xit('was broken', () => {});").map((s) => s.kind)).toContain(
			"disabled-test",
		);
	});

	it("returns at most one match per kind even when multiple appear", () => {
		const content = "// TODO: one\n// TODO: two\n// FIXME: three";
		const stubs = scanForStubs(content);
		const kinds = stubs.map((s) => s.kind);
		expect(kinds.filter((k) => k === "TODO")).toHaveLength(1);
		expect(kinds.filter((k) => k === "FIXME")).toHaveLength(1);
	});

	it("does NOT match TODO embedded inside identifiers", () => {
		const stubs = scanForStubs("const KOMODOItem = 1;\nfunction MyTODOList() {}");
		expect(stubs.map((s) => s.kind)).not.toContain("TODO");
	});

	it("returns empty array for empty / non-string input", () => {
		expect(scanForStubs("")).toEqual([]);
		expect(scanForStubs("just a plain line")).toEqual([]);
		// @ts-expect-error — null is not a string, but the function should
		// guard against it rather than throw on hostile callers.
		expect(scanForStubs(null)).toEqual([]);
	});

	it("truncates long lines to ~120 chars in the snippet", () => {
		const content = "// TODO: " + "a".repeat(300);
		const stubs = scanForStubs(content);
		expect(stubs[0]?.snippet.length).toBeLessThanOrEqual(120);
		expect(stubs[0]?.snippet.endsWith("...")).toBe(true);
	});

	it("exports a non-trivial cap constant", () => {
		expect(STUB_INTRODUCED_CAP).toBeGreaterThanOrEqual(10);
	});
});

describe("formatUnverifiedCodeWarning", () => {
	it("returns null when no code files were edited", () => {
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 0,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when any correctness signal was observed", () => {
		for (const signal of ["typecheck", "test", "lint", "build"]) {
			expect(
				formatUnverifiedCodeWarning({
					codeFilesEdited: 3,
					verificationObserved: new Set([signal]),
				}),
			).toBeNull();
		}
	});

	it("returns null when only dev-server / browser signals seen (not correctness)", () => {
		// Hitting only the dev server doesn't prove the code typechecks or tests pass.
		// This is the case the unverified-code check exists to catch.
		expect(
			formatUnverifiedCodeWarning({
				codeFilesEdited: 1,
				verificationObserved: new Set(["dev-server"]),
			}),
		).not.toBeNull();
	});

	it("warns with the file count when unverified", () => {
		const msg = formatUnverifiedCodeWarning({
			codeFilesEdited: 4,
			verificationObserved: new Set(),
		});
		expect(msg).toMatch(/4 code file edit\(s\)/);
		expect(msg).toMatch(/tsc \/ test \/ lint \/ build/);
		expect(msg).toMatch(/Don't claim done on unverified work/);
	});
});

describe("formatVerifyNotRunWarning", () => {
	it("returns null when no code files were edited (nothing to verify)", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 0,
				verificationObserved: new Set(["typecheck"]),
			}),
		).toBeNull();
	});

	it("returns null when verify-suite was observed (covered)", () => {
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 5,
				verificationObserved: new Set(["verify-suite"]),
			}),
		).toBeNull();
	});

	it("returns null when NO correctness signals were observed (avoids double-nudge)", () => {
		// formatUnverifiedCodeWarning carries the message in this case;
		// formatVerifyNotRunWarning stays silent to avoid stacking nudges.
		expect(
			formatVerifyNotRunWarning({
				codeFilesEdited: 5,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("fires when individual correctness tools ran but not the suite", () => {
		const msg = formatVerifyNotRunWarning({
			codeFilesEdited: 5,
			verificationObserved: new Set(["typecheck", "test"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/5 code file edit\(s\)/);
		expect(msg).toMatch(/interlinked verify/);
	});

	it("fires even on a single correctness signal (e.g., just tsc)", () => {
		// A solo tsc run is verified-enough for warn_unverified_code (one
		// correctness signal satisfies it), but still triggers the verify-
		// not-run nudge because the suite catches what tsc misses (docs,
		// secrets, SAST, dep-audit).
		const msg = formatVerifyNotRunWarning({
			codeFilesEdited: 1,
			verificationObserved: new Set(["typecheck"]),
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/docs:check/);
	});
});

describe("formatUiNotInteractedWarning", () => {
	it("returns null when no UI files were edited", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 0,
				verificationObserved: new Set(),
			}),
		).toBeNull();
	});

	it("returns null when a dev server was started", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 2,
				verificationObserved: new Set(["dev-server"]),
			}),
		).toBeNull();
	});

	it("returns null when a browser MCP tool was used", () => {
		expect(
			formatUiNotInteractedWarning({
				uiFilesEdited: 2,
				verificationObserved: new Set(["browser"]),
			}),
		).toBeNull();
	});

	it("warns when only typecheck/test/build/lint were seen but no browser/dev-server", () => {
		// Type-checking is not feature-checking.
		const msg = formatUiNotInteractedWarning({
			uiFilesEdited: 1,
			verificationObserved: new Set(["typecheck", "test"]),
		});
		expect(msg).toMatch(/UI file edit\(s\)/);
		expect(msg).toMatch(/Type-checking is not feature-checking/);
	});
});

describe("formatStubsIntroducedWarning", () => {
	it("returns null when no stubs were tracked", () => {
		expect(formatStubsIntroducedWarning({ stubs: [] })).toBeNull();
	});

	it("includes file basenames and kinds for the first few stubs", () => {
		const msg = formatStubsIntroducedWarning({
			stubs: [
				{ file: "/repo/src/foo.ts", kind: "TODO", snippet: "// TODO: implement" },
				{ file: "/repo/src/bar.ts", kind: "FIXME", snippet: "// FIXME broken" },
			],
		});
		expect(msg).toMatch(/2 stub \/ TODO \/ disabled-test addition\(s\)/);
		expect(msg).toContain("foo.ts");
		expect(msg).toContain("bar.ts");
		expect(msg).toContain("[TODO]");
		expect(msg).toContain("[FIXME]");
	});

	it("truncates to maxShown and adds an 'and N more' suffix", () => {
		const stubs = Array.from({ length: 12 }, (_, i) => ({
			file: `src/file-${i}.ts`,
			kind: "TODO",
			snippet: `// TODO ${i}`,
		}));
		const msg = formatStubsIntroducedWarning({ stubs, maxShown: 5 });
		expect(msg).toContain("...and 7 more");
		// Only the first 5 file basenames should be shown
		expect(msg).toContain("file-0.ts");
		expect(msg).toContain("file-4.ts");
		expect(msg).not.toContain("file-5.ts");
	});
});

describe("countCodeFilesEdited / countUiFilesEdited", () => {
	it("counts code files written, excluding docs", () => {
		const set = new Set([
			"src/foo.ts",
			"src/bar.py",
			"README.md",
			"docs/intro.mdx",
			"package.json",
		]);
		expect(countCodeFilesEdited(set)).toBe(2);
	});

	it("counts UI files written", () => {
		const set = new Set([
			"src/Button.tsx",
			"src/util.ts",
			"src/page.svelte",
			"src/server.py",
			"styles/main.css",
		]);
		expect(countUiFilesEdited(set)).toBe(3);
	});

	it("dedupes raw + absolute forms of the same file", () => {
		// session-state.ts stores both forms when the resolved abs differs from raw.
		// The counter should treat them as one file.
		const set = new Set(["src/foo.ts", "/Users/me/proj/src/foo.ts"]);
		expect(countCodeFilesEdited(set)).toBe(1);
	});

	it("returns 0 on an empty set", () => {
		expect(countCodeFilesEdited(new Set())).toBe(0);
		expect(countUiFilesEdited(new Set())).toBe(0);
	});
});

describe("formatTddRegressionWarning", () => {
	it("returns null when there are no regressions", () => {
		expect(formatTddRegressionWarning({ regressions: [] })).toBeNull();
	});

	it("warns with the file basename and count for a regression", () => {
		const msg = formatTddRegressionWarning({
			regressions: [{ sourceFile: "/repo/src/parser.ts" }],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/1 test regression\(s\)/);
		expect(msg).toContain("parser.ts");
		expect(msg).toMatch(/green→red/);
	});

	it("truncates to maxShown and adds an 'and N more' suffix", () => {
		const regressions = Array.from({ length: 9 }, (_, i) => ({
			sourceFile: `src/mod-${i}.ts`,
		}));
		const msg = formatTddRegressionWarning({ regressions, maxShown: 5 });
		expect(msg).toContain("...and 4 more");
		expect(msg).toContain("mod-0.ts");
		expect(msg).not.toContain("mod-5.ts");
	});
});

describe("formatBisectNotResetWarning", () => {
	it("returns null when no bisect command ran", () => {
		expect(
			formatBisectNotResetWarning({ commandsRun: ["git status", "npm test"] }),
		).toBeNull();
	});

	it("returns null when a reset followed the last bisect step", () => {
		expect(
			formatBisectNotResetWarning({
				commandsRun: ["git bisect start", "git bisect bad", "git bisect reset"],
			}),
		).toBeNull();
	});

	it("warns when a bisect was started but never reset", () => {
		const msg = formatBisectNotResetWarning({
			commandsRun: ["git bisect start HEAD HEAD~10", "git bisect good"],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/unfinished git bisect/);
		expect(msg).toMatch(/git bisect reset/);
	});

	it("warns when a new bisect starts after a prior reset", () => {
		const msg = formatBisectNotResetWarning({
			commandsRun: ["git bisect start", "git bisect reset", "git bisect start"],
		});
		expect(msg).not.toBeNull();
	});
});

describe("isDocFactSourceFile / countDocFactSourcesEdited", () => {
	it("matches the gen-marker source files (rule families, runner registry, modes)", () => {
		expect(isDocFactSourceFile("src/harness/rules/builtin-rules-database.ts")).toBe(true);
		expect(isDocFactSourceFile("src/harness/rules/builtin-rules-processes.ts")).toBe(true);
		expect(isDocFactSourceFile("src/lib/hooks.ts")).toBe(true);
		expect(isDocFactSourceFile("src/harness/modes.ts")).toBe(true);
	});

	it("matches an absolute path to a rule family (files_written stores the abs form)", () => {
		expect(
			isDocFactSourceFile("/Users/me/interlinked-cli/src/harness/rules/builtin-rules-railway.ts"),
		).toBe(true);
	});

	it("does NOT match unrelated source, test mirrors, or package.json", () => {
		// Plain source that feeds no gen-marker counter.
		expect(isDocFactSourceFile("src/harness/evaluator/pre-tool.ts")).toBe(false);
		// A test file beside the rules — editing it cannot change the rule count.
		expect(isDocFactSourceFile("src/harness/rules/__tests__/merge.test.ts")).toBe(false);
		// package.json (node-min) is deliberately excluded — it over-fires.
		expect(isDocFactSourceFile("package.json")).toBe(false);
		// Substring, not path-anchored: `(?:^|/)` requires start-or-slash before src.
		expect(isDocFactSourceFile("notsrc/harness/modes.ts")).toBe(false);
	});

	it("counts distinct doc-fact sources, deduping raw + absolute forms", () => {
		const set = new Set([
			"src/harness/rules/builtin-rules-database.ts",
			"/abs/proj/src/harness/rules/builtin-rules-database.ts",
			"src/lib/hooks.ts",
			"src/harness/evaluator/pre-tool.ts", // not a doc-fact source
		]);
		expect(countDocFactSourcesEdited(set)).toBe(2);
	});

	it("returns 0 when no doc-fact source was edited", () => {
		expect(countDocFactSourcesEdited(new Set(["src/foo.ts", "README.md"]))).toBe(0);
	});
});

describe("formatDocMarkerDriftWarning", () => {
	it("returns null when no doc-fact source was edited", () => {
		expect(formatDocMarkerDriftWarning({ docSourcesEdited: 0, commandsRun: [] })).toBeNull();
	});

	it("warns when a rule family was edited and docs were not regenerated", () => {
		const msg = formatDocMarkerDriftWarning({
			docSourcesEdited: 1,
			commandsRun: ["npm test", "git add -A"],
		});
		expect(msg).not.toBeNull();
		expect(msg).toMatch(/1 edit\(s\)/);
		expect(msg).toMatch(/docs:build/);
		expect(msg).toMatch(/gen:/);
	});

	it("suppresses once docs:build ran this session", () => {
		expect(
			formatDocMarkerDriftWarning({ docSourcesEdited: 2, commandsRun: ["npm run docs:build"] }),
		).toBeNull();
	});

	it("suppresses once docs:check ran this session", () => {
		expect(
			formatDocMarkerDriftWarning({ docSourcesEdited: 2, commandsRun: ["npm run docs:check"] }),
		).toBeNull();
	});

	it("suppresses when `interlinked verify` ran (it aggregates docs:check)", () => {
		expect(
			formatDocMarkerDriftWarning({
				docSourcesEdited: 1,
				commandsRun: ["interlinked verify --json"],
			}),
		).toBeNull();
	});

	it("suppresses on a direct check-docs.mjs invocation", () => {
		expect(
			formatDocMarkerDriftWarning({
				docSourcesEdited: 1,
				commandsRun: ["node scripts/check-docs.mjs --build"],
			}),
		).toBeNull();
	});
});
