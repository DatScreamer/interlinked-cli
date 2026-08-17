// Mutation-kill companion for src/harness/checks/readme-script-drift.ts.
//
// Targets the 47 killable survivors from a fresh mutation-manifest
// measurement (2026-08-14; see scratch/fleet-r3/receipts/
// src_harness_checks_readme-script-drift.ts.jsonl for the per-mutant
// disposition, and scratch/fleet-r3/rsd-shadow-verify.mts for the shadow
// runner that empirically confirmed every fixture below against the exact
// mutant text). The remaining 14 survivors are equivalent_candidate
// (provably redundant guards / try-catch-swallowed exceptions / an
// unreachable filesystem-root branch) and are NOT targeted here — see the
// receipts file.
//
// Grouped by the source region each fixture exercises, mirroring
// readme-script-drift.ts's own section markers.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectReadmeScriptDrift, resolveNearestPackageScripts } from "./readme-script-drift.js";

const MD = "docs/setup.md";

function scriptsOf(...names: string[]): (p: string) => ReadonlySet<string> | null {
	const set: ReadonlySet<string> = new Set(names);
	return (_p: string) => set;
}

// ─── module-level regex/constant whitespace & anchor tolerance ─────────────

describe("MARKDOWN_EXT_RE / NPM_RUN_RE / NPM_TEST_RE — whitespace and anchor edges", () => {
	it("a file that merely CONTAINS \".md\" but doesn't end in it is not markdown", () => {
		const md = "Run `npm run missing` now.";
		// ".md.bak" contains the substring ".md" but does not END in .md/.markdown.
		expect(detectReadmeScriptDrift(md, "notes.md.bak", scriptsOf("build"))).toEqual([]);
	});

	it("tolerates extra whitespace between `run` and the script name", () => {
		const md = "Run `npm run  missing` now."; // two spaces
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"missing"');
	});

	it("tolerates extra whitespace between `npm` and `run`", () => {
		const md = "Run `npm  run missing` now."; // two spaces
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"missing"');
		// The raw line does NOT contain the literal substring "npm run" (two
		// spaces, not one) — pin the reported COMMAND text too, so a script
		// found via unusual spacing is still reported as "npm run missing",
		// never as "npm test".
		expect(results[0]?.text).toContain('"npm run missing"');
	});

	it("tolerates extra whitespace between `npm` and `test`", () => {
		const md = "Then run `npm  test` before pushing."; // two spaces
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"npm test"');
	});
});

// ─── FENCE_DELIM_RE — fences must be recognized only at (indented) line start ─

describe("FENCE_DELIM_RE — fence delimiters must anchor to line start", () => {
	it("triple-backticks appearing mid-line (not at line start) do NOT open a fence", () => {
		const md = ["Text before ```json", "npm run missing", "more text"].join("\n");
		// If this were mistaken for a fence-open, "npm run missing" would land
		// inside a (data-lang) fence and get suppressed instead of flagged.
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"missing"');
	});

	it("an indented fence (leading whitespace before the backticks) still suppresses its content", () => {
		const md = ["Setup:", "", "  ```json", '  { "suggestion": "Use `npm run missing` instead" }', "  ```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});
});

// ─── DATA_FENCE_LANGS — every listed data language is honored ──────────────

describe("DATA_FENCE_LANGS — every data-language fence is skipped", () => {
	it.each(["jsonc", "json5", "yaml", "yml", "toml", "xml", "html", "diff", "csv"])(
		"skips a %s fence quoting an npm command as data",
		(lang) => {
			const md = ["```" + lang, "`npm run missing` quoted", "```"].join("\n");
			expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
		},
	);
});

// ─── FOREIGN_SETUP_LINE_RE — git-clone / cd recognition inside a fence ──────

describe("FOREIGN_SETUP_LINE_RE — foreign-repo setup line recognition", () => {
	it("recognizes `git clone` even with extra whitespace before `clone`", () => {
		const md = ["```bash", "git  clone https://example.com/foo.git", "npm run missing", "```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("a `cd` appearing mid-line (not at line start) does NOT count as foreign setup", () => {
		const md = ["```bash", "Then cd into the folder", "npm run missing", "```"].join("\n");
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).toContain('"missing"');
	});

	it("an indented `cd` line still counts as foreign setup", () => {
		const md = ["```bash", "  cd myrepo", "npm run missing", "```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("`$cd` with no space after the dollar prompt still counts as foreign setup", () => {
		const md = ["```bash", "$cd repo", "npm run missing", "```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("`$ cd` with the standard space after the dollar prompt counts as foreign setup", () => {
		const md = ["```bash", "$ cd repo", "npm run missing", "```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("tolerates extra whitespace between `cd` and its target directory", () => {
		const md = ["```bash", "cd  repo", "npm run missing", "```"].join("\n");
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});
});

// ─── fence-id tracking across multiple fences in one document ──────────────

describe("fence id tracking — a SECOND fence must keep its own (non-zero) id", () => {
	it("a data fence that isn't the first one in the file is still suppressed", () => {
		const md = ["```bash", "echo hello", "```", "```json", '{ "example": "npm run missing" }', "```"].join("\n");
		// The first fence is fence 0 (not data). The SECOND fence gets id 1 —
		// this only suppresses correctly if fence id 1 (not just id 0) survives
		// the `?? null` lookup used to skip data/foreign fences.
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});

	it("a delimiter that closes a fence must be treated as a close, not another open", () => {
		// "```yaml" here is a CLOSING delimiter for the json fence (its own info
		// word is irrelevant when closing) — so "npm run missing" ends up
		// OUTSIDE any fence and must be flagged, not swallowed into a phantom
		// nested yaml fence.
		const md = ["```json", "stuff", "```yaml", "npm run missing", "```"].join("\n");
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.line).toBe(4);
		expect(results[0]?.text).toContain('"missing"');
	});
});

// ─── per-line match cap (MAX_MATCHES_PER_FILE) — enforced WITHIN one line ───

describe("MAX_MATCHES_PER_FILE — capped even when many refs share one line", () => {
	it("a single line with 12 distinct missing scripts still caps the total at 10", () => {
		const md = Array.from({ length: 12 }, (_, i) => `npm run many${i}`).join("; ") + ";";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(10);
	});
});

// ─── reported-line snippet: trim + truncate ─────────────────────────────────

describe("reported snippet — trimmed and truncated", () => {
	it("truncates a long line before REPORT_LINE_TRUNC, dropping trailing content", () => {
		const md = "Run `npm run missing` then " + "x".repeat(200) + " ZZZMARKER";
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		expect(results[0]?.text).not.toContain("ZZZMARKER");
	});

	it("strips leading whitespace from the line before appending it", () => {
		const md = "   npm run missing"; // three leading spaces
		const results = detectReadmeScriptDrift(md, MD, scriptsOf("build"));
		expect(results.length).toBe(1);
		// Exactly ONE space (the template literal's own "— ") before "npm" —
		// an untrimmed line would leave the three leading spaces too.
		expect(results[0]?.text).toContain("— npm run missing");
	});
});

// ─── mapFences internals reached through a fence-open line carrying text ───

describe("mapFences — fence-open line itself is still suppressed when data-lang", () => {
	it("text trailing the info word on a fence-open line is still inside that fence", () => {
		const md = ["```bash", "echo hi", "```", "```json npm run missing", "```"].join("\n");
		// "npm run missing" trails directly on the SAME line as the ```json
		// fence-open marker. That line is fence 1 (the second fence in the
		// file) and must be suppressed just like any other line inside it.
		expect(detectReadmeScriptDrift(md, MD, scriptsOf("build"))).toEqual([]);
	});
});

// ─── resolveNearestPackageScripts — boundary + shape edge cases ────────────

describe("resolveNearestPackageScripts — boundary and manifest-shape edge cases", () => {
	const fixtures: string[] = [];
	function makeFixture(): string {
		const dir = mkdtempSync(join(tmpdir(), "readme-script-drift-mk-"));
		fixtures.push(dir);
		return dir;
	}
	afterEach(() => {
		while (fixtures.length > 0) {
			const dir = fixtures.pop();
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a markdown dir that is a SIBLING of stopDir (not a descendant) stays outside the boundary", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { outsideScript: "x" } }));
		mkdirSync(join(root, "unrelated", "nested"), { recursive: true });
		const stopDir = join(root, "unrelated", "nested", "inner"); // need not exist
		const md = join(root, "unrelated", "nested", "x.md");
		expect(resolveNearestPackageScripts(md, stopDir)).toBeNull();
	});

	it("a name that merely shares stopDir's prefix (foo vs foobar) is not inside it", () => {
		const root = makeFixture();
		mkdirSync(join(root, "foo"), { recursive: true });
		mkdirSync(join(root, "foobar"), { recursive: true });
		writeFileSync(join(root, "foobar", "package.json"), JSON.stringify({ scripts: { sib: "x" } }));
		const md = join(root, "foobar", "x.md");
		const stopDir = join(root, "foo");
		expect(resolveNearestPackageScripts(md, stopDir)).toBeNull();
	});

	it("a `scripts` field that is a string (not an object) is rejected, not read as indices", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: "not an object" }));
		expect(resolveNearestPackageScripts(join(root, "x.md"), root)).toBeNull();
	});

	it("a malformed NEAREST package.json fails open — it does NOT fall back to a valid ancestor", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { fromRoot: "x" } }));
		mkdirSync(join(root, "sub"), { recursive: true });
		writeFileSync(join(root, "sub", "package.json"), "{ not json");
		expect(resolveNearestPackageScripts(join(root, "sub", "x.md"), root)).toBeNull();
	});

	it("the walk stops AT stopDir and does not continue past it looking for an ancestor manifest", () => {
		const root = makeFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { aboveStop: "x" } }));
		mkdirSync(join(root, "workspace", "docs"), { recursive: true });
		const stopDir = join(root, "workspace"); // no package.json here or below
		const md = join(root, "workspace", "docs", "x.md");
		expect(resolveNearestPackageScripts(md, stopDir)).toBeNull();
	});
});
