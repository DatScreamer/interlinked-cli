// Mutation-kill companion for src/harness/checks/redos-catastrophic.ts.
//
// Fleet W7 (2026-08-14), CONTRACT-W6: 58 surviving mutants against this file
// (fresh provenance). checkRedosCatastrophic is the ONLY export —
// isCommentOnlyLine and regexBodies are private helpers, exercised here only
// indirectly through checkRedosCatastrophic's observable output (findings
// array: line number + trimmed/truncated text).
//
// Every fixture below was shadow-verified empirically against the real
// mutant text (search/replace applied to a scratch copy of the module, both
// pristine and mutant imported and run against the full fixture set) via
// scratch/fleet-r3/redos-catastrophic-shadow-verify.mts. Receipts:
// scratch/fleet-r3/receipts/src_harness_checks_redos-catastrophic.ts.jsonl.
//
// 11 of the 58 survivors are classified `equivalent_candidate` (not
// killable — see the receipts file for the structural argument + empirical
// confirmation behind each). The remaining 47 are killed by the fixtures
// below.
import { describe, expect, it } from "vitest";
import { checkRedosCatastrophic } from "./redos-catastrophic.js";

function nCatastrophicLines(n: number): string {
	return Array.from({ length: n }, (_, i) => `const re${i} = /(a${i}+)+/;`).join("\n") + "\n";
}

describe("checkRedosCatastrophic — extension gating (JS_EXTS / PY_EXTS)", () => {
	// test-contract: boundary — PY_EXTS must still include ".pyi" stub files, not only ".py"
	it("P: .pyi stub file with a Python catastrophic regex still fires", () => {
		const m = checkRedosCatastrophic('re.compile(r"(a+)+")\n', "svc/types.pyi");
		expect(m).toHaveLength(1);
	});
	// test-contract: boundary — ".py" is the baseline member of PY_EXTS
	it("P: .py file with a Python catastrophic regex fires", () => {
		expect(checkRedosCatastrophic('re.compile(r"(a+)+")\n', "svc/v.py")).toHaveLength(1);
	});
	// test-contract: boundary — every JS_EXTS member must gate the scan the same way
	it.each([".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts"])(
		"P: %s file with a JS literal catastrophic regex fires",
		(ext) => {
			expect(checkRedosCatastrophic("const re = /(a+)+/;\n", `src/v${ext}`)).toHaveLength(1);
		},
	);
	// test-contract: boundary — an extension outside both JS_EXTS and PY_EXTS must never scan
	it("N: an unsupported extension (.rb) never fires", () => {
		expect(checkRedosCatastrophic("re = /(a+)+/\n", "svc/v.rb")).toHaveLength(0);
	});
	// test-contract: boundary — a dotless filename must resolve to an empty extension and skip
	it("N: a path with no extension at all (Makefile) never fires", () => {
		expect(checkRedosCatastrophic("re = /(a+)+/\n", "Makefile")).toHaveLength(0);
	});
});

describe("checkRedosCatastrophic — isTestFile / isVendoredOrFixturePath skip", () => {
	// test-contract: public-api — documented skip: vendored trees are never scanned for ReDoS
	it("N: node_modules path never fires despite a real hit", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "node_modules/pkg/v.ts")).toHaveLength(0);
	});
	// test-contract: public-api — documented skip: vendor/ is a vendored-tree alias
	it("N: vendor path never fires despite a real hit", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "vendor/pkg/v.ts")).toHaveLength(0);
	});
	// test-contract: public-api — documented skip: build output trees are never scanned
	it("N: dist path never fires despite a real hit", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "dist/v.js")).toHaveLength(0);
	});
	// test-contract: public-api — documented skip: the check never scans test sources
	it("N: test file never fires despite a real hit", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "src/v.test.ts")).toHaveLength(0);
	});
});

describe("checkRedosCatastrophic — MATCH_LIMIT boundary (cap 10)", () => {
	// test-contract: boundary — MATCH_LIMIT=10 is the exact cap, neither early nor late
	it("P: exactly 10 hit lines returns all 10 (at the cap, not over it)", () => {
		expect(checkRedosCatastrophic(nCatastrophicLines(10), "src/v.ts")).toHaveLength(10);
	});
	// test-contract: boundary — one hit line past the cap must still be truncated to 10
	it("P: 11 hit lines is still capped at exactly 10", () => {
		const m = checkRedosCatastrophic(nCatastrophicLines(11), "src/v.ts");
		expect(m).toHaveLength(10);
		expect(m.map((x) => x.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});
	// test-contract: boundary — well past the cap must still stop at exactly 10
	it("P: 15 hit lines is still capped at exactly 10", () => {
		expect(checkRedosCatastrophic(nCatastrophicLines(15), "src/v.ts")).toHaveLength(10);
	});
	// test-contract: boundary — one hit line under the cap must NOT be truncated
	it("N: 9 hit lines (under the cap) returns all 9, uncapped", () => {
		expect(checkRedosCatastrophic(nCatastrophicLines(9), "src/v.ts")).toHaveLength(9);
	});
});

describe("checkRedosCatastrophic — noqa suppression", () => {
	// test-contract: public-api — documented suppression: bare `# noqa` silences every check
	it("N: bare '# noqa' suppresses a Python hit", () => {
		expect(checkRedosCatastrophic('re.compile(r"(a+)+")  # noqa\n', "svc/v.py")).toHaveLength(0);
	});
	// test-contract: public-api — a coded noqa must only suppress checks its code maps to
	it("P: a coded '# noqa:S608' (an unrelated bandit code) does NOT suppress redos", () => {
		expect(checkRedosCatastrophic('re.compile(r"(a+)+")  # noqa:S608\n', "svc/v.py")).toHaveLength(1);
	});
});

describe("checkRedosCatastrophic — finding shape (line number, trim, 150-char truncation)", () => {
	// test-contract: public-api — documented output shape: finding text is truncated to 150 chars
	it("P: an overlong hit line's finding text is truncated to exactly 150 chars", () => {
		const content = ["// leading comment line", `const ${"x".repeat(140)} = /(a+)+/;`].join("\n") + "\n";
		const m = checkRedosCatastrophic(content, "src/v.ts");
		expect(m).toHaveLength(1);
		expect(m[0]?.line).toBe(2);
		expect(m[0]?.text).toHaveLength(150);
	});
	// test-contract: public-api — documented output shape: finding text is the trimmed line
	it("P: leading/trailing whitespace on the hit line is trimmed in the finding text", () => {
		const m = checkRedosCatastrophic("    const re = /(a+)+/;   \n", "src/v.ts");
		expect(m).toHaveLength(1);
		expect(m[0]?.text).toBe("const re = /(a+)+/;");
	});
});

describe("checkRedosCatastrophic — regexBodies: Python extraction", () => {
	// test-contract: boundary — every re.* function name the extractor lists must be recognized
	it.each(["match", "search", "fullmatch", "sub", "subn", "split", "findall", "finditer"])(
		"P: re.%s finds a catastrophic body",
		(fn) => {
			expect(checkRedosCatastrophic(`re.${fn}(r"(a+)+", s)\n`, "svc/v.py")).toHaveLength(1);
		},
	);
	// test-contract: boundary — two independent calls on one line must both contribute bodies
	it("P: two re.compile calls on one line both contribute bodies", () => {
		expect(
			checkRedosCatastrophic('re.compile(r"(a+)+"); re.compile(r"(b+)+")\n', "svc/v.py"),
		).toHaveLength(1);
	});
	// test-contract: boundary — a safe body earlier on the line must not mask a later catastrophic one
	it("P: a safe body alongside a catastrophic body still fires (any-hit semantics)", () => {
		expect(
			checkRedosCatastrophic('re.compile(r"[a-z]+"); re.compile(r"(a+)+")\n', "svc/v.py"),
		).toHaveLength(1);
	});
	// test-contract: boundary — the raw-string `r` prefix is optional per the extractor's own `r?`
	it("P: unquoted-r prefix body is extracted too", () => {
		expect(checkRedosCatastrophic('re.compile("(a+)+")\n', "svc/v.py")).toHaveLength(1);
	});
	// test-contract: boundary — a space before the call's opening paren must still be recognized
	it("P: space BEFORE the opening paren is still recognized (re.compile (...))", () => {
		expect(checkRedosCatastrophic('re.compile (r"(a+)+")\n', "svc/v.py")).toHaveLength(1);
	});
	// test-contract: boundary — a space after the opening paren, before the r-prefix, still parses
	it("P: space AFTER the opening paren, before the r-prefix, still recognized", () => {
		expect(checkRedosCatastrophic('re.compile( r"(a+)+")\n', "svc/v.py")).toHaveLength(1);
	});
	// test-contract: boundary — an empty regex source is a legitimate no-op, not a crash
	it("N: empty-string regex source is a no-op, not a crash", () => {
		expect(checkRedosCatastrophic('re.compile("")\n', "svc/v.py")).toHaveLength(0);
	});
});

describe("checkRedosCatastrophic — regexBodies: JS RegExp() constructor extraction", () => {
	// test-contract: boundary — double-quoted RegExp() source must be extracted
	it("P: new RegExp double-quoted catastrophic body fires", () => {
		expect(checkRedosCatastrophic('new RegExp("(a+)+");\n', "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — single-quoted RegExp() source must be extracted too
	it("P: RegExp single-quoted catastrophic body fires", () => {
		expect(checkRedosCatastrophic("RegExp('(a+)+');\n", "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — a safe RegExp() body must not false-positive
	it("N: RegExp(...) safe body does not fire", () => {
		expect(checkRedosCatastrophic('const r = new RegExp("[a-z]+@[a-z]+");\n', "src/v.ts")).toHaveLength(0);
	});
	// test-contract: boundary — a space before RegExp's opening paren must still be recognized
	it("P: space BEFORE RegExp's opening paren is still recognized", () => {
		expect(checkRedosCatastrophic('new RegExp ("(a+)+");\n', "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — a space after RegExp's opening paren, before the quote, still parses
	it("P: space AFTER RegExp's opening paren, before the quote, still recognized", () => {
		expect(checkRedosCatastrophic('new RegExp( "(a+)+");\n', "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — an empty RegExp() source is a legitimate no-op, not a crash
	it("N: empty-string RegExp source is a no-op, not a crash", () => {
		expect(checkRedosCatastrophic('new RegExp("");\n', "src/v.ts")).toHaveLength(0);
	});
});

describe("checkRedosCatastrophic — regexBodies: JS literal extraction", () => {
	// test-contract: boundary — division must never be mistaken for a regex literal
	it("N: division is not mistaken for a regex literal", () => {
		expect(checkRedosCatastrophic("const q = a / (b + 1) / c;\n", "src/v.ts")).toHaveLength(0);
	});
	// test-contract: boundary — a slash directly after an identifier/`)` is division, not a literal
	it("N: a regex-shaped slash pair right after a call is still a division, not extracted", () => {
		expect(checkRedosCatastrophic("const q = total(x) / (y+1) / z;\n", "src/v.ts")).toHaveLength(0);
	});
	// test-contract: boundary — trailing regex flags must not block body extraction
	it("P: regex literal with flags still extracts its body", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/gi;\n", "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — only the catastrophic one of two literals on a line must fire
	it("P: two literals on one line — only the second is catastrophic", () => {
		expect(checkRedosCatastrophic("const a = /[a-z]+/; const b = /(x+)+/;\n", "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — a flag-alphabet char right after the first literal must not corrupt pairing
	it("P: two literals with a flag-safe separator both extract correctly", () => {
		expect(checkRedosCatastrophic("const a = /x+/s; const b = /(y+)+/;\n", "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — back-to-back literals with no separator must both extract correctly
	it("P: two literals back to back with no separating character still both extract", () => {
		expect(checkRedosCatastrophic("const a = /x+/;const b = /(y+)+/;\n", "src/v.ts")).toHaveLength(1);
	});
	// test-contract: boundary — filler with no flag-alphabet letter must not swallow the second literal's slash
	it("P: filler with no flag-alphabet letter between two literals still finds the second hit", () => {
		expect(checkRedosCatastrophic("let a = /x+/1234=/(y+)+/;\n", "src/v.ts")).toHaveLength(1);
	});
});
