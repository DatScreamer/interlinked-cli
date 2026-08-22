// Targeted mutation-kill tests for src/harness/checks/export-ripple.ts.
//
// Each `it()` is built from hand-traced pristine behavior against the
// manifest's recorded `originalLexeme` -> `replacement` for one surviving
// mutant, using an input where the mutant's specific token change would flip
// the FINAL observable output (the returned InlineMatch[]). Several tests
// were designed only after tracing through the full pipeline (fast-filter ->
// relative gate -> specTail match -> resolvedImport equality) to find an
// input where a change to one narrow expression actually reaches the output.
//
// See export-ripple.integration.test.ts for the general behavioral contract
// and the `bareRef()` fast-filter quirk this file relies on too.

import { execFileSync as realExecFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkExportRipple } from "./export-ripple.js";

// --- fixture helpers (duplicated from the companion integration test; kept
// local so this file has no non-test dependency beyond the SUT) -----------

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "export-ripple-w31-"));
	realExecFileSync("git", ["init", "-q"], { cwd: dir });
	realExecFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
	realExecFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	return dir;
}

function write(repo: string, rel: string, body: string): void {
	const abs = join(repo, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

function add(repo: string): void {
	realExecFileSync("git", ["add", "-A"], { cwd: repo });
}

/** A bare-quoted basename token that satisfies the coarse fast-filter. */
function bareRef(base: string): string {
	return `\nconst __ref = "${base}";\nvoid __ref;\n`;
}

// =============================================================================
// collectImporterMatches — whitespace / regex-boundary mutants
// =============================================================================

describe("collectImporterMatches — trim + regex-quantifier mutants", () => {
	// test-contract: invariant — (b44adb97d9cd066c: importerLine.trim() -> importerLine)
	// — the import-line regex is `^import…`; without trimming, an indented
	// import line no longer matches at position 0, so the ripple goes unseen.
	it("detects a broken import on an INDENTED import line (trim() required)", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`  import { present, gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
	});

	// test-contract: invariant — (fc3e206eb3d8a664: drops the `^` anchor from
	// the import-line regex) — an import preceded by other code on the SAME
	// line must NOT match once trimmed (no other code before "import" is
	// legal for the anchored regex); the unanchored version would still find
	// it mid-line and misreport.
	it("does not treat a same-line-prefixed 'import {...}' fragment as a real import (anchor required)", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`noop(); import { present, gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	// test-contract: invariant — (65373a1fb83f7cf7: `import\s+` -> `import\s`)
	// — two spaces after "import" must still match (\s+ is one-or-more).
	it("matches an import line with MULTIPLE spaces after 'import'", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import  { present, gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
	});

	// test-contract: invariant — (9d7eaaf1b9904db9: `type\s+` -> `type\s`)
	// — two spaces after inline "type" must still match.
	it("matches 'import type' with MULTIPLE spaces after 'type'", () => {
		const repo = makeRepo();
		const targetSrc = "export type Kept = string;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import type  { Kept, Gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "Gone"');
	});

	// test-contract: invariant — (4b4545fe206caf47: `\}\s+from` -> `\}\sfrom`)
	// — multiple spaces between the closing brace and "from" must still match.
	it("matches an import line with MULTIPLE spaces before 'from'", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { present, gone }  from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
	});

	// test-contract: invariant — (6dcd050075c3c5f6: `from\s+` -> `from\s`)
	// — multiple spaces between "from" and the opening quote must still match.
	it("matches an import line with MULTIPLE spaces after 'from'", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { present, gone } from  "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
	});
});

// =============================================================================
// collectImporterMatches — specTail / resolution-path mutants
// =============================================================================

describe("collectImporterMatches — specTail and specifier-extension mutants", () => {
	// test-contract: invariant — (481637e6017f02e1: `specTail !== baseName` -> `false`)
	// — a specifier whose naive last-path-segment is ".." (so specTail
	// mismatches baseName) must be SKIPPED even though `path.resolve`
	// normalization would coincidentally land it back on the real target
	// (`./target/foo/..` -> the target dir). Disabling the guard would let it
	// through and misreport.
	it("skips an import whose literal specTail mismatches, even if path normalization would resolve to the target", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "target.ts", targetSrc);
		write(
			repo,
			"importer.ts",
			`import { present, gone } from "./target/foo/..";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "target.ts"), repo)).toEqual([]);
	});

	// test-contract: invariant — (434f4db63e8b0ba5: drops the `$` anchor from
	// the specifier's own extension-strip regex) AND
	// (b0f849ec1f2fbf5b: drops the `$` anchor from checkExportRipple's target
	// noExt-strip regex) — a target living in a directory whose NAME itself
	// contains a recognized extension token (`sub.ts/`) exercises both
	// regexes' anchor: an unanchored regex strips the wrong (earlier,
	// mid-path) occurrence instead of the true trailing one, corrupting
	// either specTail or baseName and breaking the ripple detection either
	// way. One fixture kills both mutants independently (either one active
	// drops the match count to 0).
	it("resolves correctly through a directory name that itself contains an extension-like token ('sub.ts/target.ts')", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "sub.ts/target.ts", targetSrc);
		write(
			repo,
			"importer.ts",
			`import { present, gone } from "./sub.ts/target.ts";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "sub.ts/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "gone"');
	});
});

// =============================================================================
// collectImporterMatches — named-import-name parsing mutants
// =============================================================================

describe("collectImporterMatches — named-import-name parsing mutants", () => {
	// test-contract: invariant — (6d31ed338cc3c282: `n.trim()` -> `n`, the
	// FIRST trim in the named-import map, applied before the `as`-alias split)
	// — leading whitespace before a bare "as" changes which portion the
	// `/\s+as\s+/` split consumes: untrimmed, the split eats the leading
	// whitespace + "as" + one trailing space, leaving parts[0] empty (later
	// filtered out); trimmed, "as" sits at position 0 so the split-regex
	// (which requires whitespace BEFORE "as") never matches, so the whole
	// literal "as gone" survives as the reported name.
	it("reports the whole literal name when untrimmed leading whitespace would otherwise feed the alias-split regex", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { present,    as gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "as gone"');
	});

	// test-contract: invariant — (713368c04f108c86: drops the `^` anchor
	// from `/^type\s+/`, the inline-type-prefix strip) — a name that merely
	// CONTAINS the substring "type " (not as a true leading prefix) must be
	// reported verbatim; the unanchored version would incorrectly strip the
	// embedded occurrence.
	it("does not strip an embedded (non-leading) 'type ' substring from an import name", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { present, Xtype y } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain('imports "Xtype y"');
	});

	// test-contract: invariant — (7cee3e6ca19b720b: `type\s+` -> `type\s` on
	// `/^type\s+/`) — the type-prefix replace happens BEFORE the final trim
	// in source order for this literal, so with two spaces after "type" the
	// weaker quantifier leaves one leftover leading space in the reported
	// name (a real, observable difference: "Gone" vs " Gone").
	it("fully strips a MULTI-space inline 'type ' prefix with no residual leading space", () => {
		const repo = makeRepo();
		const targetSrc = "export type Kept = string;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { Kept, type  Gone } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		const matches = checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo);
		expect(matches).toHaveLength(1);
		// Exact substring check: a leftover leading space would read
		// `imports " Gone"` instead, failing this assertion.
		expect(nonNull(matches[0]).text).toContain('imports "Gone" which no longer exists');
	});
});

// =============================================================================
// checkExportRipple — guard mutants (each needs a REAL ripple behind the
// guard to observe the guard's absence; a guard test with no reachable
// importer proves nothing, since other later guards also return []).
// =============================================================================

describe("checkExportRipple — early-return guards, proven via a real ripple behind each", () => {
	// test-contract: invariant — (41c8328a7e9c3c7f: the extension allow-list
	// check forced to `false`) — a disallowed extension (.py) must return []
	// even though a fully-formed ripple exists behind it.
	it("returns [] for a disallowed extension even with a real ripple reachable behind it", () => {
		const repo = makeRepo();
		const targetSrc = "export const present = 1;\n";
		write(
			repo,
			"src/importer.ts",
			`import { present, gone } from "./target.py";\nconst t = "target.py";\nvoid t;\n`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.py"), repo)).toEqual([]);
	});

	// test-contract: invariant — (27e31342962679cb: `.d.ts` guard forced
	// `false`) AND (4c3a062819b7ad36: `.endsWith(".d.ts")` -> `.startsWith(".d.ts")`)
	// — a normal (non-.d.ts-prefixed) `.d.ts` path must return [] even with a
	// real ripple reachable behind it; either mutant lets it fall through.
	it("returns [] for a .d.ts file even with a real ripple reachable behind it", () => {
		const repo = makeRepo();
		const targetSrc = "export const kept: number;\n";
		write(repo, "src/mod.d.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { kept, gone } from "./mod.d.js";${bareRef("mod.d")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/mod.d.ts"), repo)).toEqual([]);
	});

	// test-contract: invariant — (a963a19494ccb455: `currentExports.size === 0` -> `false`)
	// — a file with ZERO exports must return [] even with a real,
	// resolvable importer behind it (otherwise every named import in every
	// importer of a non-exporting file would be misreported as missing).
	it("returns [] for a file with no exports even with a resolvable importer behind it", () => {
		const repo = makeRepo();
		const targetSrc = "const notExported = 1;\n";
		write(repo, "src/target.ts", targetSrc);
		write(
			repo,
			"src/importer.ts",
			`import { anything } from "./target.js";${bareRef("target")}`,
		);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});

	// test-contract: invariant — (d1dda512672f7ae1: `!baseName` guard forced
	// `false`) — a filePath that reduces to an EMPTY baseName (".ts") must
	// return [] even though a contrived `"../"` importer exists whose
	// specTail also reduces to "" and whose resolved path normalizes back to
	// the bare cwd (matching the target's own degenerate noExt="").
	it("returns [] for an empty-basename filePath even though a contrived '../' importer would otherwise resolve", () => {
		const repo = makeRepo();
		const targetSrc = "export const a = 1;\n";
		write(repo, "sub/importer.ts", `import { foo } from "../";\nconst bait = "";\nvoid bait;\n`);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, ".ts"), repo)).toEqual([]);
	});

	// test-contract: invariant — (506d3e0b9f5ce4fd: removes the
	// `.filter((f) => f !== relFromRoot)` self-exclusion call entirely) AND
	// (374ddea7ed7cacf3: the same filter's condition forced to `true`) — a
	// target file that ALSO contains a (self-referential) broken import of
	// itself must not be treated as its own importer; either mutant lets the
	// target re-scan itself and misreport.
	it("does not scan the target file as its own importer, even when it self-imports a name that doesn't exist", () => {
		const repo = makeRepo();
		const targetSrc = [
			"export const present = 1;",
			'import { gone } from "./target.js";',
			'const bait = "target";',
			"",
		].join("\n");
		write(repo, "src/target.ts", targetSrc);
		add(repo);
		expect(checkExportRipple(targetSrc, join(repo, "src/target.ts"), repo)).toEqual([]);
	});
});

// =============================================================================
// checkExportRipple — extension allow-list literals (one per surviving
// StringLiteral mutant; each replaces exactly one allowed extension with "").
// =============================================================================

// note: ".mts"/".cts" were dropped from extCases below (deleted, not fixed in
// source) — the real collectImporterMatches() specBase strip regex
// (`/\.(js|ts|tsx|jsx|mjs|cjs)$/`) never included mts/cts, so a
// "./target.mts" specifier never strips to a baseName-matching specTail and
// checkExportRipple() genuinely returns [] for these two extensions today.
// The deleted cases asserted length-1 against behavior the untouched source
// does not have; per this pass's contract, only source drives assertions.
describe("checkExportRipple — every non-.ts allow-listed extension still passes the gate", () => {
	const extCases: string[] = [".tsx", ".js", ".jsx", ".mjs", ".cjs"];

	for (const ext of extCases) {
		// test-contract: invariant — (one StringLiteral mutant per extension:
		// f722ede3ef7244c5/.tsx, ceff1980916e88fa/.js, fb1c68b01c0d70ff/.jsx,
		// de74e1a14d6d18fc/.mjs, b15d04600295e827/.cjs — each replaces its extension literal with "")
		// — a target file with this extension and a genuine ripple must be
		// PROCESSED (not early-returned []); if the literal is blanked, the
		// allow-list no longer recognizes this extension and the file is
		// wrongly skipped.
		it(`processes a target file with extension ${ext} (allow-list entry intact)`, () => {
			const repo = makeRepo();
			const targetSrc = "export const present = 1;\n";
			write(repo, `src/target${ext}`, targetSrc);
			write(
				repo,
				"src/importer.ts",
				`import { present, gone } from "./target${ext}";${bareRef("target")}`,
			);
			add(repo);
			const matches = checkExportRipple(targetSrc, join(repo, `src/target${ext}`), repo);
			expect(matches).toHaveLength(1);
			expect(nonNull(matches[0]).text).toContain('imports "gone"');
		});
	}
});

// =============================================================================
// checkExportRipple — fs mocked mutants (exact call-arg / control-flow mutants
// that need a deterministic, sequenced mock rather than a real filesystem).
// =============================================================================

describe("checkExportRipple — mocked-fs mutants", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:child_process");
		vi.resetModules();
	});

	// test-contract: invariant — (c26162c10faceebf: `"utf-8"` -> `""` on the
	// Step-3 fast-filter readFileSync call) — assert the EXACT call arguments
	// of the first readFileSync invocation (the fast-filter read), pinning
	// the literal encoding string the mutant blanks.
	it("passes the exact 'utf-8' encoding literal to the fast-filter readFileSync call", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFileSync: () => "src/importer.ts\0",
		}));
		const readSpy = vi.fn(() => `import { gone } from "./target.js";\nconst t = "target";`);
		vi.doMock("node:fs", () => ({ readFileSync: readSpy }));
		const mod = await import("./export-ripple.js");
		mod.checkExportRipple("export const present = 1;\n", "/repo/src/target.ts", "/repo");
		expect(readSpy.mock.calls[0]).toEqual([join("/repo", "src/importer.ts"), "utf-8"]);
	});

	// test-contract: invariant — (5765a3be0b9152a5: the fast-filter's inner
	// `catch { return false; }` -> `catch { return true; }`) — a fast-filter
	// read that throws must EXCLUDE the file from importerFiles. Sequenced
	// mock: 1st readFileSync call (fast-filter) throws, 2nd (Step-4 re-read)
	// would succeed and contain a genuine broken import IF the file were
	// (wrongly) included by the mutant.
	it("excludes a file from importerFiles when its fast-filter read throws (catch must return false)", async () => {
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			execFileSync: () => "src/importer.ts\0",
		}));
		let call = 0;
		vi.doMock("node:fs", () => ({
			readFileSync: () => {
				call++;
				if (call === 1) {
					throw new Error("transient EIO");
				}
				return `import { phantom } from "./target.js";\nconst t = "target";`;
			},
		}));
		const mod = await import("./export-ripple.js");
		const out = mod.checkExportRipple("export const real = 1;\n", "/repo/src/target.ts", "/repo");
		expect(out).toEqual([]);
	});
});
