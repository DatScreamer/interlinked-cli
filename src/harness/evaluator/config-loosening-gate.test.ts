import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	detectConfigLoosening,
	evaluateConfigLooseningForEvent,
} from "./config-loosening-gate.js";
import { nonNull } from "../../lib/non-null.js";

/** Minimal PreToolUse event factory — only the fields the gate reads. */
function makeEvent(toolInput: Record<string, unknown>, cwd?: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: toolInput,
		timestamp: "2026-06-07T00:00:00Z",
		...(cwd ? { cwd } : {}),
	};
}

/**
 * Spin up a throwaway git repo with one committed file so the event-level
 * gate (which reads `git show HEAD:<rel>`) has a real baseline to diff
 * against. Returns the git toplevel path (canonicalized — on macOS the
 * `mkdtemp` path lives under the `/var → /private/var` symlink, and the
 * source resolves file paths with `path.resolve`, so we must hand the gate
 * the same resolved root git itself reports or `relative()` produces a
 * `..`-prefixed path and the gate fails open). Caller is responsible for
 * cleanup via `rmSync`.
 */
function makeRepoWithCommittedFile(relPath: string, committedContent: string): string {
	const raw = mkdtempSync(join(tmpdir(), "clg-gate-"));
	execSync("git init -q -b main", { cwd: raw });
	execSync("git config user.email test@example.com", { cwd: raw });
	execSync("git config user.name test", { cwd: raw });
	writeFileSync(join(raw, relPath), committedContent);
	execSync(`git add ${relPath}`, { cwd: raw });
	execSync('git commit -q -m "initial"', { cwd: raw });
	return execSync("git rev-parse --show-toplevel", { cwd: raw, encoding: "utf-8" }).trim();
}

describe("detectConfigLoosening — tsconfig.json", () => {
	it("flags `strict: true` → `strict: false`", () => {
		// Flipping strict from true → false also flips every implied
		// subflag (noImplicitAny, strictNullChecks, …) from effectively
		// true to effectively false. The check surfaces all of them so
		// the user sees the full blast radius.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("strict");
		expect(rules).toContain("noImplicitAny");
	});

	it("flags `noImplicitAny: true` → `noImplicitAny: false`", () => {
		const before = `{ "compilerOptions": { "noImplicitAny": true } }`;
		const after = `{ "compilerOptions": { "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags `strictNullChecks: true` → `strictNullChecks: false`", () => {
		const before = `{ "compilerOptions": { "strictNullChecks": true } }`;
		const after = `{ "compilerOptions": { "strictNullChecks": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after).length).toBe(1);
	});

	it("does not flag adding a new strict flag", () => {
		const before = `{ "compilerOptions": {} }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("does not flag tightening (false → true)", () => {
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags adding a `noImplicitAny: false` override under `strict: true`", () => {
		// strict: true makes noImplicitAny effectively true. Adding an
		// explicit `noImplicitAny: false` is a real loosening even though
		// the literal `noImplicitAny` was undefined before.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "noImplicitAny": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("noImplicitAny");
	});

	it("flags adding `strictNullChecks: false` override under `strict: true`", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": true, "strictNullChecks": false } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("strictNullChecks");
	});

	it("does not flag adding a strict subflag override under `strict: false`", () => {
		// If strict was already false, adding noImplicitAny: false isn't a
		// loosening — the umbrella was already off.
		const before = `{ "compilerOptions": { "strict": false } }`;
		const after = `{ "compilerOptions": { "strict": false, "noImplicitAny": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("flags removing `noUncheckedIndexedAccess: true` (TS default is false)", () => {
		// noUncheckedIndexedAccess is NOT implied by strict — its TS default
		// is false. Removing an explicit `true` therefore IS a loosening.
		const before = `{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true } }`;
		const after = `{ "compilerOptions": { "strict": true } }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("noUncheckedIndexedAccess");
	});

	it("flags removing `strict: true` entirely", () => {
		// Removing strict drops every implied subflag from true → false (TS
		// defaults each to false when strict is absent).
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": {} }`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		// Should fire on `strict` itself plus the 8 implied subflags.
		expect(findings.length).toBeGreaterThanOrEqual(1);
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("strict");
	});

	it("does not flag removing a flag that's already false", () => {
		const before = `{ "compilerOptions": { "noImplicitReturns": false } }`;
		const after = `{ "compilerOptions": {} }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — package.json", () => {
	it("flags engines.node version drop", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("engines.node");
	});

	it("flags engines.node removal entirely (no floor at all)", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("engines.node");
	});

	it("flags engines block removal", () => {
		const before = `{ "engines": { "node": ">=22.0.0" }, "name": "x" }`;
		const after = `{ "name": "x" }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
	});

	it("flags removal of test script", () => {
		const before = `{ "scripts": { "test": "vitest run", "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup" } }`;
		const findings = detectConfigLoosening("package.json", before, after);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).rule).toBe("scripts.test");
	});

	it("does not flag adding a script", () => {
		const before = `{ "scripts": { "build": "tsup" } }`;
		const after = `{ "scripts": { "build": "tsup", "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — non-config files", () => {
	it("returns empty for non-config file paths", () => {
		expect(
			detectConfigLoosening(
				"src/lib/foo.ts",
				`{"strict": true}`,
				`{"strict": false}`,
			),
		).toEqual([]);
	});
});

describe("reconstructEditContent — Edit tool reconstruction", () => {
	it("reconstructs from old_string + new_string", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const before = `{ "compilerOptions": { "strict": true } }`;
		const result = reconstructEditContent(before, '"strict": true', '"strict": false');
		expect(result).toBe(`{ "compilerOptions": { "strict": false } }`);
	});

	it("returns null when old_string is not present in disk content", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		const result = reconstructEditContent("{}", "missing", "x");
		expect(result).toBeNull();
	});

	it("returns null when old_string is ambiguous (matches multiple times)", async () => {
		const { reconstructEditContent } = await import("./config-loosening-gate.js");
		// `replaceAll` is intentionally unsupported — agents pass replace_all=true
		// for that, and we can't reproduce ambiguity safely. Return null so the
		// caller falls back to the next gate rather than firing on the wrong
		// reconstructed content.
		const result = reconstructEditContent("aa\naa", "aa", "bb");
		expect(result).toBeNull();
	});
});

// ==========================================================================
// detectConfigLoosening — parser + branch coverage of the pure detector
// ==========================================================================

describe("detectConfigLoosening — parsing + fail-open edges", () => {
	it("returns empty when beforeText is empty (new file)", () => {
		expect(
			detectConfigLoosening("tsconfig.json", "", `{ "compilerOptions": { "strict": false } }`),
		).toEqual([]);
	});

	it("returns empty when the proposed (after) text is unparseable", () => {
		// Can't parse the proposed file → defer to tsc/biome; fail open.
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false`; // truncated, invalid
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("returns empty when the proposed (after) text is empty (safeJsonParse('') → null)", () => {
		// beforeText is non-empty so the new-file guard is passed; the empty
		// `after` must funnel through safeJsonParse's `!text` short-circuit and
		// fail open rather than throw.
		const before = `{ "compilerOptions": { "strict": true } }`;
		expect(detectConfigLoosening("tsconfig.json", before, "")).toEqual([]);
	});

	it("does not throw when compilerOptions is a non-object scalar", () => {
		// `get(before, "compilerOptions")` must early-return undefined when the
		// node isn't an object — exercises the typeof-guard inside get().
		const before = `{ "compilerOptions": "oops" }`;
		const after = `{ "compilerOptions": 42 }`;
		expect(detectConfigLoosening("tsconfig.json", before, after)).toEqual([]);
	});

	it("tolerates JSONC // line comments and trailing commas", () => {
		const before = `{
			// project strictness
			"compilerOptions": { "strict": true, }
		}`;
		const after = `{
			// project strictness
			"compilerOptions": { "strict": false, }
		}`;
		const findings = detectConfigLoosening("tsconfig.json", before, after);
		expect(findings.map((f) => f.rule)).toContain("strict");
	});

	it("tolerates JSONC /* block */ comments", () => {
		const before = `{ /* strict on */ "compilerOptions": { "strictNullChecks": true } }`;
		const after = `{ /* strict off */ "compilerOptions": { "strictNullChecks": false } }`;
		expect(detectConfigLoosening("tsconfig.json", before, after).length).toBe(1);
	});

	it("matches a monorepo-nested tsconfig path", () => {
		const before = `{ "compilerOptions": { "strict": true } }`;
		const after = `{ "compilerOptions": { "strict": false } }`;
		const findings = detectConfigLoosening("packages/api/tsconfig.json", before, after);
		expect(findings.map((f) => f.rule)).toContain("strict");
		expect(nonNull(findings[0]).file).toBe("packages/api/tsconfig.json");
	});

	it("matches tsconfig.build.json variant", () => {
		const before = `{ "compilerOptions": { "noImplicitReturns": true } }`;
		const after = `{ "compilerOptions": { "noImplicitReturns": false } }`;
		expect(detectConfigLoosening("tsconfig.build.json", before, after).length).toBe(1);
	});

	it("fails open (empty) for biome.json — detector not yet implemented", () => {
		const before = `{ "linter": { "enabled": true } }`;
		const after = `{ "linter": { "enabled": false } }`;
		expect(detectConfigLoosening("biome.json", before, after)).toEqual([]);
	});

	it("fails open (empty) for .eslintrc.json — detector not yet implemented", () => {
		const before = `{ "rules": { "no-console": "error" } }`;
		const after = `{ "rules": { "no-console": "off" } }`;
		expect(detectConfigLoosening(".eslintrc.json", before, after)).toEqual([]);
	});
});

describe("detectConfigLoosening — package.json semver + script edges", () => {
	it("does NOT flag engines.node being raised (>=18 → >=22)", () => {
		const before = `{ "engines": { "node": ">=18.0.0" } }`;
		const after = `{ "engines": { "node": ">=22.0.0" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when engines.node is absent in both", () => {
		const before = `{ "name": "x" }`;
		const after = `{ "name": "y" }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when an engines block exists but lacks a node key", () => {
		// parseSemverFloor(undefined) → 0 on both sides; no floor to compare.
		const before = `{ "engines": { "npm": ">=9" } }`;
		const after = `{ "engines": {} }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when only a non-required script is removed", () => {
		const before = `{ "scripts": { "test": "vitest", "docs": "typedoc" } }`;
		const after = `{ "scripts": { "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("does NOT flag when engines.node has no parseable number", () => {
		// parseSemverFloor returns 0 for a spec with no digits → no floor known.
		const before = `{ "engines": { "node": "latest" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("flags every removed required script independently", () => {
		const before = `{ "scripts": { "test": "vitest", "typecheck": "tsc", "lint": "biome", "build": "tsup" } }`;
		const after = `{ "scripts": {} }`;
		const findings = detectConfigLoosening("package.json", before, after);
		const rules = findings.map((f) => f.rule).sort();
		expect(rules).toEqual(["scripts.build", "scripts.lint", "scripts.test", "scripts.typecheck"]);
	});

	it("returns empty when proposed package.json is invalid JSON (before/after null guard)", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": `; // unparseable
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("returns empty when the committed (before) package.json is itself invalid JSON", () => {
		// before parses to null while after is valid → detectPackageJsonLoosening
		// hits its `before === null` early return rather than dereferencing null.
		const before = `{ "engines": { "node": `; // unparseable HEAD baseline
		const after = `{ "engines": { "node": ">=22.0.0" }, "scripts": { "test": "vitest" } }`;
		expect(detectConfigLoosening("package.json", before, after)).toEqual([]);
	});

	it("emits a human-readable message naming the rule and the regression", () => {
		const before = `{ "engines": { "node": ">=22.0.0" } }`;
		const after = `{ "engines": { "node": ">=18.0.0" } }`;
		const [finding] = detectConfigLoosening("package.json", before, after);
		expect(nonNull(finding).message).toContain("22");
		expect(nonNull(finding).message).toContain("18");
		expect(nonNull(finding).before).toBe(">=22.0.0");
		expect(nonNull(finding).after).toBe(">=18.0.0");
	});
});

// ==========================================================================
// evaluateConfigLooseningForEvent — full event path (Write + Edit + git HEAD)
// ==========================================================================

describe("evaluateConfigLooseningForEvent — applicability gating", () => {
	it("returns null when the event carries no tool_input at all", () => {
		// `event.tool_input || {}` must tolerate an absent tool_input rather
		// than dereferencing undefined — exercises the `|| {}` fallback.
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			tool_name: "Write",
			timestamp: "2026-06-07T00:00:00Z",
		};
		expect(evaluateConfigLooseningForEvent(event)).toBeNull();
	});

	it("returns null when there is no file_path", () => {
		expect(evaluateConfigLooseningForEvent(makeEvent({ content: "{}" }))).toBeNull();
	});

	it("returns null for a non-config file_path", () => {
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: "src/lib/foo.ts", content: `{ "strict": false }` }),
		);
		expect(decision).toBeNull();
	});

	it("returns null for a config file with neither content nor old/new strings", () => {
		// e.g. a Read-shaped tool_input — nothing to reconstruct.
		expect(
			evaluateConfigLooseningForEvent(makeEvent({ file_path: "tsconfig.json" })),
		).toBeNull();
	});

	it("returns null when old_string is present but new_string is missing", () => {
		expect(
			evaluateConfigLooseningForEvent(
				makeEvent({ file_path: "tsconfig.json", old_string: '"strict": true' }),
			),
		).toBeNull();
	});
});

describe("evaluateConfigLooseningForEvent — Write tool against git HEAD", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("returns an `ask` decision when a Write loosens strict relative to HEAD", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": false } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("ask");
		expect(decision?.rule_id).toBe("config_loosening_gate");
		expect(decision?.severity).toBe("high");
		expect(decision?.category).toBe("config");
		expect(decision?.reason).toContain("strict");
		expect(decision?.reason).toContain("weakens config");
	});

	it("aggregates multiple findings into one reason (engines + script removal)", () => {
		dir = makeRepoWithCommittedFile(
			"package.json",
			`{ "engines": { "node": ">=22.0.0" }, "scripts": { "test": "vitest" } }`,
		);
		const proposed = `{ "engines": { "node": ">=18.0.0" }, "scripts": {} }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "package.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("[engines.node]");
		expect(decision?.reason).toContain("[scripts.test]");
	});

	it("returns null when the Write does not loosen anything (tightening)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": false } }`,
		);
		const proposed = `{ "compilerOptions": { "strict": true } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ file_path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision).toBeNull();
	});

	it("returns null when the file's directory is not a git repo (rev-parse fails)", () => {
		// Plain temp dir, NO `git init` → `git -C <dir> rev-parse` exits non-zero
		// → readHeadVersion returns "" → detectConfigLoosening's empty-before
		// guard fails open. Exercises the rev-parse failure branch.
		dir = mkdtempSync(join(tmpdir(), "clg-nogit-"));
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					content: `{ "compilerOptions": { "strict": false } }`,
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("fails open when the file path resolves outside its own repo root", () => {
		// readHeadVersion guards against `relative(repoRoot, absFile)` producing a
		// `..`-prefixed path (a file that resolves outside the repo `git -C` found
		// for its dirname). The divergence is constructed with an EXPLICIT symlink
		// of our own so the condition exists on every platform: `git rev-parse`
		// resolves symlinks and reports the REAL repo root, while `path.resolve`
		// keeps the symlinked prefix, so `relative()` yields `..` and the gate
		// must fail open (null) — never an `ask` on a phantom baseline. The
		// previous version leaned on macOS's `/var → /private/var` tmpdir symlink
		// for the divergence; on Linux CI runners `/tmp` is real, the path
		// resolved INSIDE the repo, and the gate correctly fired `ask` on the
		// genuine strict→false loosening — a platform-conditional fixture
		// asserting unconditionally (finding 2026-06).
		const real = mkdtempSync(join(tmpdir(), "clg-symreal-"));
		dir = real;
		execSync("git init -q -b main", { cwd: real });
		execSync("git config user.email test@example.com", { cwd: real });
		execSync("git config user.name test", { cwd: real });
		writeFileSync(join(real, "tsconfig.json"), `{ "compilerOptions": { "strict": true } }`);
		execSync("git add tsconfig.json", { cwd: real });
		execSync('git commit -q -m "init"', { cwd: real });
		const linkParent = mkdtempSync(join(tmpdir(), "clg-symlink-"));
		try {
			const link = join(linkParent, "repo");
			symlinkSync(real, link, "dir");
			// Pass the path THROUGH the symlink as file_path. content loosens
			// strict, so a phantom-baseline bug would surface as a false `ask`;
			// correct behavior is null (the path resolves outside the repo root
			// git reported, so no valid HEAD baseline can be located).
			const decision = evaluateConfigLooseningForEvent(
				makeEvent(
					{
						file_path: join(link, "tsconfig.json"),
						content: `{ "compilerOptions": { "strict": false } }`,
					},
					link,
				),
			);
			expect(decision).toBeNull();
		} finally {
			rmSync(linkParent, { recursive: true, force: true });
		}
	});

	it("returns null when the config exists in a repo but was never committed (git show fails)", () => {
		// Repo with an empty initial commit; tsconfig.json is on disk but not in
		// HEAD → `git show HEAD:tsconfig.json` exits non-zero → readHeadVersion
		// returns "" → fails open. Exercises the show-status failure branch
		// distinct from the rev-parse failure above.
		const raw = mkdtempSync(join(tmpdir(), "clg-uncommitted-"));
		execSync("git init -q -b main", { cwd: raw });
		execSync("git config user.email test@example.com", { cwd: raw });
		execSync("git config user.name test", { cwd: raw });
		execSync('git commit -q --allow-empty -m "init"', { cwd: raw });
		dir = execSync("git rev-parse --show-toplevel", { cwd: raw, encoding: "utf-8" }).trim();
		writeFileSync(join(dir, "tsconfig.json"), `{ "compilerOptions": { "strict": true } }`);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					content: `{ "compilerOptions": { "strict": false } }`,
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("resolves a relative Write file_path against the ambient repo and fails open when uncommitted", () => {
		// A relative config path drives readHeadVersion down its
		// `resolve(file)` (non-absolute) branch. The test runner's cwd IS a git
		// repo, but this fixture basename is not committed at HEAD, so
		// `git show HEAD:<rel>` fails → empty baseline → fails open → null.
		// Deterministic regardless of the repo's real config contents.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({
				file_path: "tsconfig.test-fixture.json",
				content: `{ "compilerOptions": { "strict": false } }`,
			}),
		);
		expect(decision).toBeNull();
	});

	it("accepts the `path` tool-input key as an alias for file_path", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strictNullChecks": true } }`,
		);
		const proposed = `{ "compilerOptions": { "strictNullChecks": false } }`;
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({ path: join(dir, "tsconfig.json"), content: proposed }, dir),
		);
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("strictNullChecks");
	});
});

describe("evaluateConfigLooseningForEvent — Edit tool reconstruction path", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("reconstructs Edit content from disk and asks when it loosens HEAD", () => {
		// HEAD == disk == strict:true; the edit flips it to false.
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"strict": true',
					new_string: '"strict": false',
				},
				dir,
			),
		);
		expect(decision?.decision).toBe("ask");
		expect(decision?.reason).toContain("strict");
	});

	it("returns null when the Edit's old_string is not found on disk", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"noSuchKey": 1',
					new_string: '"noSuchKey": 2',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("returns null when the disk file does not exist (readDiskContent → null)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": true } }`,
		);
		// Target a config basename that is NOT on disk in this repo.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "biome.json"),
					old_string: '"strict": true',
					new_string: '"strict": false',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("returns null when an Edit reconstructs but does not loosen (false→true)", () => {
		dir = makeRepoWithCommittedFile(
			"tsconfig.json",
			`{ "compilerOptions": { "strict": false } }`,
		);
		const decision = evaluateConfigLooseningForEvent(
			makeEvent(
				{
					file_path: join(dir, "tsconfig.json"),
					old_string: '"strict": false',
					new_string: '"strict": true',
				},
				dir,
			),
		);
		expect(decision).toBeNull();
	});

	it("resolves a relative Edit file_path against process.cwd() when event.cwd is absent", () => {
		// No `cwd` on the event + a relative config path forces readDiskContent
		// down the `resolve(process.cwd(), file)` fallback. The test runner's cwd
		// is the repo root, whose package.json exists; a synthetic old_string that
		// is absent from it makes reconstruction return null → decision null.
		// This exercises the cwd-fallback branch without mutating process state.
		const decision = evaluateConfigLooseningForEvent(
			makeEvent({
				file_path: "package.json",
				old_string: '"__interlinked_synthetic_absent_key__": "vendor-model-v6"',
				new_string: '"__interlinked_synthetic_absent_key__": "vendor-model-v7"',
			}),
		);
		expect(decision).toBeNull();
	});
});
