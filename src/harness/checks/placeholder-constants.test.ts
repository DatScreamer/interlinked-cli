// Unit tests for placeholder-constants.ts
// Check id: placeholder_runtime_constant
//
// Positive (MUST fire):
//   P1  Rust: the Bun #31503 constant verbatim under "/// nonzero stand-in until Phase B"
//   P2  TS:   const MAX_RETRIES = 3; // hardcoded for now
//   P3  Py:   BATCH = 64  # interim until we profile
//   P4  Go:   const MaxConns = 128 under a "provisional … until the pool is tuned" comment
//   P5  TS:   export + hex literal under a "stand-in … until Phase B" comment
//   P6  TS:   confession 3 lines above, reached through comment-only lines
//   P7  Py:   1_000 underscore literal + "to be replaced" arm
//   P8  Rust: static declaration with same-line "temporary until the …" comment
//   P9  Rust: confession above an intervening #[attribute] line
//   P10 Py:   annotated float (TIMEOUT: float = 1.5  # for now)
//   P11 cap:  12 confessing constants report at most 10 matches
//   P12 TS:   unstarred block-comment interior confession (block state tracked)
//   P13 Go:   unstarred doc-block confession above const
//   P14 Py:   CRLF file, same-line # confession (spec P3, Windows line endings)
//   P15 TS:   confession on the block opener, unstarred continuation closing line
//   P16 TS:   bare block-comment interior confession above a later declaration
//   P17 Rust: lifetime + char literal nearby don't derail the scan
//   P18 all:  every supported confession spelling remains meaningful
//   P19 Py:   a triple-quote-looking line inside a # comment is not a docstring
//   P20 Py:   a docstring closes before a real confessing declaration
//   P21 TS:   escaped backtick keeps a multiline template open
//   P22 Go:   raw-string backslash does not escape its closing backtick
//   P23 TS:   same-line block comment closes before the declaration
//   P24 TS:   finding text is capped at the documented report width
//   P26 Py:   spaced blank/comment-only lines remain transparent
//   P27 TS:   malformed single-quoted string does not become multiline state
//   P28 TS:   escaped template delimiter before code remains inside the template
//   P29 TS:   a same-line confessing block closes before the declaration
// Negative (MUST NOT fire):
//   N1  numeric const with no comment at all
//   N2  const UNKNOWN = -1; // sentinel  (no temporariness confession)
//   N3  // TODO: document this  above a constant (confesses about docs, not the value)
//   N4  string constant under a confession-shaped comment (UI placeholder text)
//   N5  test-file path
//   N6  wrong extension (.md)
//   N7  comments-only occurrence (declaration itself commented out, // and /* */ forms)
//   N8  declaration quoted inside a template literal
//   N9  confession 4 lines above (outside the 3-line window)
//   N10 code line between confession and declaration breaks attachment
//   N11 vendored path (node_modules/)
//   N12 generated-file marker in header
//   N13 Py: lowercase name (not a module constant)
//   N14 Py: indented assignment (not module scope)
//   N15 Py: declaration-shaped line inside a docstring
//   N16 Rust: star-leading deref assignment is code, not a comment (no comment in file)
//   N17 JS:  operator-first continuation line is code, not a comment
//   N18 Go:  pointer deref through a confession-named identifier (no comment in file)
//   N19 Rust: deref assignment of a Provisional-named variant (no comment in file)
//   N20 TS:  operator-before continuation with a stand-in identifier
//   N21 Go:  raw-string literal quoting a confessing declaration
//   N22 all:  punctuation/no-space decoys are not confession spellings
//   N23 Rust: ordinary code between a confession and declaration breaks attachment
//   N24 JS:   hash-prefixed code is not a Rust attribute
//   N25 Py:   triple quotes in a comment do not hide a following declaration
//   N26 Py:   code containing a confession word is not comment-only
//   N27 TS:   a code identifier named temporary is not a confession
// Performance:
//   PERF1 pathological unterminated escaped-quote line stays linear (adversarial F6)

import { describe, expect, it } from "vitest";
import { checkPlaceholderRuntimeConstant } from "./placeholder-constants.js";

function run(src: string, path = "src/config.ts") {
	return checkPlaceholderRuntimeConstant(src, path);
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — positive (must fire)", () => {
	it("P1: Rust — the Bun BSS_OVERFLOW_BLOCK_SIZE stand-in, verbatim", () => {
		const src = [
			"/// nonzero stand-in until Phase B",
			"pub const BSS_OVERFLOW_BLOCK_SIZE: usize = 64;",
		].join("\n");
		const found = run(src, "src/interner.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toMatch(/^placeholder_runtime_constant: /);
		expect(found[0]?.text).toContain("BSS_OVERFLOW_BLOCK_SIZE");
	});

	it("P2: TS — const MAX_RETRIES = 3; // hardcoded for now", () => {
		const src = `const MAX_RETRIES = 3; // hardcoded for now`;
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("MAX_RETRIES");
	});

	it("P3: Python — BATCH = 64  # interim until we profile", () => {
		const src = ["import os", "", "BATCH = 64  # interim until we profile"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P4: Go — const under a provisional-until comment", () => {
		const src = [
			"package main",
			"",
			"// provisional cap until the pool is tuned",
			"const MaxConns = 128",
		].join("\n");
		const found = run(src, "server/pool.go");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P5: TS — export const with hex literal under a stand-in comment", () => {
		const src = [
			"// stand-in value until Phase B lands",
			"export const BLOCK_SIZE = 0x40;",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P6: TS — confession 3 lines above, through comment-only lines", () => {
		const src = [
			"// Provisional buffer ceiling until we wire the real config",
			"// through the daemon handshake.",
			"// See the design doc.",
			"const BUFFER_CEILING = 4096;",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P7: Python — underscore literal with a to-be-replaced confession", () => {
		const src = `MAX_QUEUE = 1_000  # to be replaced by the profiled value`;
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P8: Rust — static with same-line temporary-until comment", () => {
		const src = `static RETRY_LIMIT: u32 = 5; // temporary until the scheduler lands`;
		const found = run(src, "src/sched.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P9: Rust — confession reaches across an intervening attribute line", () => {
		const src = [
			"/// stand-in until Phase B",
			"#[allow(dead_code)]",
			"pub const INTERN_CAP: usize = 4096;",
		].join("\n");
		const found = run(src, "src/interner.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P10: Python — annotated float constant with a for-now comment", () => {
		const src = `TIMEOUT: float = 1.5  # for now`;
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P11: caps reported matches at 10 per file", () => {
		const src = Array.from(
			{ length: 12 },
			(_, i) => `const CAP_${i} = 33; // hardcoded for now`,
		).join("\n");
		const found = run(src);
		expect(found).toHaveLength(10);
	});

	it("P18: every supported confession spelling remains meaningful", () => {
		// Contract receipt: numeric declarations must fire for each documented
		// temporariness vocabulary, including the less-common regex alternatives.
		const comments = [
			"temporary for now",
			"temporarily reserved",
			"stand in until Phase B",
			"to be threaded",
			"to be wired",
			"to be computed",
			"hardcode for now",
			"hardcoding for now",
			"nonzero stub",
			"nonzero stand",
		];
		const src = comments.map((comment, i) => `const CAP_${i} = 1; // ${comment}`).join("\n");
		const found = run(src);
		expect(found).toHaveLength(comments.length);
		expect(found.map((match) => match.line)).toEqual(
			comments.map((_, i) => i + 1),
		);
	});

	it("P19: Python comment text containing triple quotes is not a docstring opener", () => {
		// Contract receipt: only real docstring spans suppress declaration scanning.
		const src = [
			'# """ this is still a line comment',
			"LIMIT = 3  # temporary for now",
		].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P20: Python docstring closes before a real confessing declaration", () => {
		// Contract receipt: a closed triple-quoted span must not swallow later module constants.
		const src = [
			'"""module documentation',
			'"""',
			"LIMIT = 3  # temporary for now",
		].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P21: escaped backtick keeps a TypeScript template open", () => {
		// Contract receipt: declaration-shaped text inside an escaped template remains non-code.
		const src = [
			"const tmpl = `",
			"const FAKE = 1; // temporary for now \\`",
			"const ALSO_FAKE = 2; // temporary for now",
			"`;",
			"const REAL = 3; // temporary for now",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(5);
		expect(found[0]?.text).toContain("const REAL = 3");
	});

	it("P22: Go raw-string backslash does not escape its closing backtick", () => {
		// Contract receipt: Go raw strings close at the next backtick, even after a backslash.
		const src = [
			"package main",
			"const tmpl = `",
			"const FAKE = 1 // provisional until the pool is tuned",
			"\\`",
			"const REAL = 2 // provisional until the pool is tuned",
		].join("\n");
		const found = run(src, "server/tmpl.go");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(5);
		expect(found[0]?.text).toContain("const REAL = 2");
	});

	it("P23: same-line block comment closes before the declaration", () => {
		// Contract receipt: comments are blanked while code after a closed block remains scannable.
		const src = "/* ordinary note */ const LIMIT = 3; // temporary for now";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P24: finding text is capped at the documented report width", () => {
		// Contract receipt: public finding text includes at most 150 trimmed declaration-line characters.
		const src = `   const LIMIT = 3; // temporary for now ${"x".repeat(300)}`;
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text.endsWith("x".repeat(300))).toBe(false);
		expect(found[0]?.text).toContain("const LIMIT = 3; // temporary for now");
		expect(found[0]?.text).not.toContain("—    const LIMIT");
		expect(found[0]?.text.length).toBeLessThan(
			"placeholder_runtime_constant: comment confesses this numeric constant is a temporary stand-in — replace it with the real value (or wire it) before shipping — ".length + 150 + 1,
		);
	});

	it("P26: Python spaced blank and comment-only lines remain transparent", () => {
		// Contract receipt: the three-line upward window walks through whitespace and comments.
		const src = [
			"# temporary for now",
			"   ",
			"    # explanatory note",
			"LIMIT = 3",
		].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P27: malformed single-quoted string does not become multiline state", () => {
		// Contract receipt: only backtick templates carry string state across JavaScript lines.
		const src = [
			"const broken = 'unterminated",
			"const REAL = 3; // temporary for now",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P28: escaped template delimiter before code remains inside the template", () => {
		// Contract receipt: an escaped backtick cannot close a multiline template before its content.
		const src = [
			"const tmpl = `",
			"\\` escaped delimiter",
			"const FAKE = 1; // temporary for now",
			"`;",
			"const REAL = 2; // temporary for now",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(5);
	});

	it("P29: a same-line confessing block closes before the declaration", () => {
		// Contract receipt: a confession in a closed block comment attaches to code that follows it.
		const src = "/* temporary for now */ const LIMIT = 3;";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P30: repeated spaces remain valid in every multi-word confession", () => {
		// Contract receipt: the public vocabulary accepts runs of whitespace, not
		// only the one-space examples used in the compact fixtures above.
		const src = [
			"const A = 1; // standin",
			"const B = 2; // for   now",
			"const C = 3; // until   we wire it",
			"const D = 4; // to   be   wired",
			"const E = 5; // hardcoded   for   now",
			"const F = 6; // nonzero   stub",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(6);
		expect(found.map((match) => match.line)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("P31: report text trims the declaration line before applying the cap", () => {
		const src = "  \tconst LIMIT = 3; // temporary for now   \t";
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/— const LIMIT = 3; \/\/ temporary for now$/);
	});

	it("P32: a closed single-line Python docstring does not hide a declaration", () => {
		// Contract receipt: two delimiters on one line leave docstring state closed.
		const src = ['"""module docs"""', "LIMIT = 3  # temporary for now"].join("\n");
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});

	it("P33: escaped template delimiters do not hide a following confession", () => {
		// Contract receipt: resume scanning after the real closing delimiter and
		// retain a comment that follows it on the same line.
		const src = [
			"const tmpl = `",
			"\\` escaped close, then ` // temporary for now",
			"const LIMIT = 3;",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P34: division operators do not open a block comment", () => {
		const src = [
			"const ratio = total / limit;",
			"// temporary for now",
			"const MAX_ITEMS = 50;",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("checkPlaceholderRuntimeConstant — negative (must NOT fire)", () => {
	it("N1: numeric constant with no comment anywhere", () => {
		const src = ["const BUFFER_SIZE = 4096;", "export const RETRIES = 3;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N2: sentinel comment is not a temporariness confession", () => {
		const src = `const UNKNOWN = -1; // sentinel`;
		expect(run(src)).toHaveLength(0);
	});

	it("N3: bare TODO about docs does not confess about the value", () => {
		const src = ["// TODO: document this", "const TIMEOUT_MS = 30000;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N4: string constant under a confession-shaped comment (UI placeholder)", () => {
		const src = [
			"// temporary label for now",
			'const PLACEHOLDER_TEXT = "Enter name";',
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N5: test-file path is skipped", () => {
		const src = `const MAX_RETRIES = 3; // hardcoded for now`;
		expect(run(src, "src/config.test.ts")).toHaveLength(0);
	});

	it("N6: wrong extension (.md) is out of scope", () => {
		const src = `const MAX_RETRIES = 3; // hardcoded for now`;
		expect(run(src, "docs/notes.md")).toHaveLength(0);
	});

	it("N7: commented-out declarations never fire (// and /* */ forms)", () => {
		const lineComment = ["// temporary for now", "// const OLD_LIMIT = 3;"].join("\n");
		expect(run(lineComment)).toHaveLength(0);
		const blockComment = [
			"/*",
			" * temporary for now",
			" * const OLD_LIMIT = 3;",
			" */",
			"const REAL_LIMIT = loadLimit();",
		].join("\n");
		expect(run(blockComment)).toHaveLength(0);
	});

	it("N8: declaration quoted inside a template literal never fires", () => {
		const src = [
			"const tmpl = `",
			"const MAX = 3; // temporary for now",
			"`;",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N9: confession 4 lines above is outside the 3-line window", () => {
		const src = [
			"// temporary for now",
			"// filler one",
			"// filler two",
			"// filler three",
			"const CAP = 9;",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N10: a code line between confession and declaration breaks attachment", () => {
		const src = [
			"// retry until the server responds",
			"await poll();",
			"const MAX_ATTEMPTS = 5;",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N11: vendored path (node_modules/) is skipped", () => {
		const src = `const MAX_RETRIES = 3; // hardcoded for now`;
		expect(run(src, "node_modules/lib/config.ts")).toHaveLength(0);
	});

	it("N12: generated-file marker exempts the whole file", () => {
		const src = ["// @generated by configgen", "const MAX_RETRIES = 3; // hardcoded for now"].join(
			"\n",
		);
		expect(run(src)).toHaveLength(0);
	});

	it("N13: Python lowercase name is not a module constant", () => {
		const src = `batch = 64  # interim until we profile`;
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});

	it("N14: Python indented assignment is not module scope", () => {
		const src = ["def setup():", "    BATCH = 64  # interim until we profile"].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});

	it("N15: Python declaration-shaped line inside a docstring never fires", () => {
		const src = [
			'"""Module docs.',
			"",
			"BATCH = 64  # interim until we profile",
			'"""',
			"VERSION = 2",
		].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});
});

// ─── Regressions from adversarial review (2026-07) ───────────────────────────
// Root causes fixed: (a) no block-comment open/close state across lines — the
// old star-prefix heuristic both missed unstarred interiors (false negatives)
// and misread star-leading CODE (deref / continuation) as comments (false
// positives); (b) trailing CR broke the dollar-anchored Python declaration
// pattern on CRLF files; (c) the shared regex stripper was quadratic on a
// pathological unterminated-string line.

describe("checkPlaceholderRuntimeConstant — adversarial regressions (must fire)", () => {
	it("P12: TS — unstarred block-comment interior confession fires", () => {
		const src = ["/*", "temporary stand-in until Phase B", "*/", "const BLOCK_SIZE = 64;"].join(
			"\n",
		);
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P13: Go — unstarred doc-block confession above const fires", () => {
		const src = [
			"package main",
			"",
			"/*",
			"MaxConns is a provisional cap until the pool is tuned.",
			"*/",
			"const MaxConns = 128",
		].join("\n");
		const found = run(src, "server/pool.go");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(6);
	});

	it("P14: Python — CRLF line endings still fire on a same-line # confession", () => {
		const src = "import os\r\n\r\nBATCH = 64  # interim until we profile\r\n";
		const found = run(src, "app/settings.py");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P15: TS — confession on the block opener, unstarred continuation close", () => {
		const src = [
			"/* stand-in until Phase B",
			"   lands in the daemon. */",
			"const BLOCK_SIZE = 64;",
		].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P16: TS — bare block-comment interior confession above a later decl", () => {
		const src = ["/*", "temporary for now", "*/", "const OLD_LIMIT = 3;"].join("\n");
		const found = run(src);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	it("P17: Rust — lifetime and char literal nearby don't derail the scan", () => {
		const src = [
			"fn width<'a>(v: &'a u32) -> u32 { *v }",
			"const SEP: char = 'x';",
			"// temporary until the tokenizer lands",
			"const LOOKAHEAD: usize = 2;",
		].join("\n");
		const found = run(src, "src/lex.rs");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});
});

describe("checkPlaceholderRuntimeConstant — adversarial regressions (must NOT fire)", () => {
	it("N16: Rust — star-leading deref assignment is code, not a comment", () => {
		const src = [
			"fn reset(temporary: &mut u32) {",
			"    *temporary = 0;",
			"    const RETRY_CAP: u32 = 3;",
			"}",
		].join("\n");
		expect(run(src, "src/reset.rs")).toHaveLength(0);
	});

	it("N17: JS — operator-first continuation line is code, not a comment", () => {
		const src = ["const budget = total", "  * (interim ?? 1);", "const MAX_ITEMS = 50;"].join(
			"\n",
		);
		expect(run(src)).toHaveLength(0);
	});

	it("N18: Go — pointer deref through a confession-named identifier", () => {
		const src = [
			"package main",
			"",
			"func reset(cfg *Config) {",
			"\t*cfg = Provisional",
			"\tconst RetryCap = 3",
			"}",
		].join("\n");
		expect(run(src, "server/reset.go")).toHaveLength(0);
	});

	it("N19: Rust — deref assignment of a Provisional-named variant", () => {
		const src = [
			"fn reset(state: &mut State) {",
			"    *state = State::Provisional;",
			"    const RETRY_CAP: u32 = 3;",
			"}",
		].join("\n");
		expect(run(src, "src/reset.rs")).toHaveLength(0);
	});

	it("N20: TS — operator-before continuation with a stand-in identifier", () => {
		const src = ["const combined = base", "  * standIn;", "const RETRY_CAP = 3;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N21: Go — raw-string literal quoting a confessing declaration", () => {
		const src = [
			"package main",
			"",
			"const tmpl = `",
			"const MaxConns = 128 // provisional until the pool is tuned",
			"`",
			"const Real = 2",
		].join("\n");
		expect(run(src, "server/tmpl.go")).toHaveLength(0);
	});

	it("N22: punctuation and no-space decoys are not confession spellings", () => {
		// Contract receipt: only the documented word boundaries and whitespace are actionable.
		const src = [
			"const A = 1; // for-now",
			"const B = 2; // until_we",
			"const C = 3; // to-be replaced",
			"const D = 4; // hardcoded-now",
			"const E = 5; // nonzerostub",
			"const F = 6; // fornow",
			"const G = 7; // untilwe",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N23: Rust code between a confession and declaration breaks attachment", () => {
		// Contract receipt: the upward walk stops at unrelated code, including Rust item code.
		const src = [
			"// temporary for now",
			"let unrelated = 0;",
			"const RETRY_CAP: u32 = 3;",
		].join("\n");
		expect(run(src, "src/reset.rs")).toHaveLength(0);
	});

	it("N24: hash-prefixed JavaScript code is not a Rust attribute", () => {
		// Contract receipt: attribute transparency is scoped to Rust and must not bridge JS code.
		const src = [
			"// temporary for now",
			"# unrelated directive",
			"const RETRY_CAP = 3;",
		].join("\n");
		expect(run(src, "src/reset.ts")).toHaveLength(0);
	});

	it("N25: triple quotes in a Python comment do not hide a following declaration", () => {
		// Contract receipt: a # comment cannot open a docstring state that suppresses later code.
		const src = [
			'# """ not a docstring',
			"VALUE = 1",
			"LIMIT = 3  # temporary for now",
		].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(1);
		expect(run(src, "app/settings.py")[0]?.line).toBe(3);
	});

	it("N26: code containing a confession word is not comment-only", () => {
		// Contract receipt: a matching word in code cannot attach an earlier confession across that line.
		const src = [
			"# temporary for now",
			"temporary = 1  # ordinary value",
			"LIMIT = 3",
		].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});

	it("N27: a code identifier named temporary is not a confession", () => {
		// Contract receipt: only original comment text can confess; code tokens are never evidence.
		const src = "const temporary = 1; /* ordinary note */";
		expect(run(src)).toHaveLength(0);
	});

	it("N28: punctuation and unexpected words do not broaden confession matching", () => {
		const src = [
			"const A = 1; // stand.in",
			"const B = 2; // until random",
			"const C = 3; // nonzeroXstub",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N29: a hash inside a Python string is not a comment confession", () => {
		const src = ['MESSAGE = "# temporary for now"', "LIMIT = 3"].join("\n");
		expect(run(src, "app/settings.py")).toHaveLength(0);
	});
});

describe("checkPlaceholderRuntimeConstant — performance", () => {
	it("PERF1: pathological unterminated escaped-quote line stays linear", () => {
		// 50KB single line: an unterminated string of 25k escaped quotes. The
		// old shared-stripper path was quadratic here (~700ms at 50KB); the
		// linear scanner must stay orders of magnitude under the old floor even
		// on slow CI hosts.
		const src = `const s = "${'\\"'.repeat(25_000)}`;
		const t0 = performance.now();
		const found = run(src, "src/a.ts");
		const elapsedMs = performance.now() - t0;
		expect(found).toHaveLength(0);
		expect(elapsedMs).toBeLessThan(500);
	});
});
