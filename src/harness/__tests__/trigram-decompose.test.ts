// @perf — benchmark tests in this file use Date.now() for timing
// characterization. Fake timers would defeat the measurement. Opt out of
// the non_deterministic_test check via this marker (see taste-checks.ts).

import { describe, expect, it } from "vitest";
import { decomposePattern, parseGrepCommand } from "../regex-trigrams.js";

// ===========================================
// Regex Decomposition
// ===========================================

describe("decomposePattern", () => {
	describe("literal patterns", () => {
		it("extracts trigrams from a literal string", () => {
			const result = decomposePattern("handleAuth", false);
			expect(result.isLiteral).toBe(true);
			expect(result.hasLiterals).toBe(true);
			expect(result.requiredTrigrams.length).toBeGreaterThan(0);
			// Literal segments preserve original case; trigrams are lowercased internally
			expect(result.literalSegments).toEqual(["handleAuth"]);
		});

		it("handles short strings (< 3 chars)", () => {
			const result = decomposePattern("ab", false);
			expect(result.hasLiterals).toBe(false);
			expect(result.requiredTrigrams.length).toBe(0);
		});

		it("handles empty string", () => {
			const result = decomposePattern("", false);
			expect(result.hasLiterals).toBe(false);
		});
	});

	describe("regex patterns", () => {
		it("extracts literals from simple regex", () => {
			const result = decomposePattern("handleAuth", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments.length).toBeGreaterThan(0);
		});

		it("extracts literals around wildcards", () => {
			// "foo.*bar" → literals "foo" and "bar"
			const result = decomposePattern("foo.*bar", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("bar");
		});

		it("handles dot wildcard", () => {
			// "fo.bar" → "fo" (too short) and "bar"
			const result = decomposePattern("fo.bar", true);
			expect(result.literalSegments).toContain("bar");
		});

		it("handles character classes by breaking literal chain", () => {
			// "[abc]def" → literals from "def" only
			const result = decomposePattern("[abc]def", true);
			expect(result.literalSegments).toContain("def");
		});

		it("handles escaped special characters as literals", () => {
			// "foo\.bar" → literal "foo.bar"
			const result = decomposePattern("foo\\.bar", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles escape sequences", () => {
			// "foo\\nbar" → includes newline literal
			const result = decomposePattern("foo\\nbar", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles quantifiers by removing preceding char", () => {
			// "foob+ar" → "foo" (b is variable) and then "ar" (too short)
			const result = decomposePattern("foob+ar", true);
			expect(result.literalSegments).toContain("foo");
		});

		it("handles alternation by intersecting branches", () => {
			// "foo|bar" → no common trigrams between branches, so no required trigrams
			const result = decomposePattern("foo|bar", true);
			expect(result.hasLiterals).toBe(false);
			expect(result.requiredTrigrams).toHaveLength(0);
		});

		it("extracts common trigrams from alternation branches", () => {
			// "fooXYZ|fooABC" → both produce trigram "foo", so it's in the intersection
			const result = decomposePattern("fooXYZ|fooABC", true);
			expect(result.hasLiterals).toBe(true);
			// The trigram for "foo" should be in the required set (common to both branches)
			expect(result.requiredTrigrams.length).toBeGreaterThan(0);
		});

		it("extracts literals around group alternation", () => {
			// "prefix(?:abc|def)suffix" → "prefix" and "suffix" are outside the alternation
			const result = decomposePattern("prefix(?:abc|def)suffix", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("prefix");
			expect(result.literalSegments).toContain("suffix");
		});

		it("handles anchors without affecting literals", () => {
			// "^handleAuth$" → "handleauth"
			const result = decomposePattern("^handleAuth$", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("handleauth");
		});

		it("handles non-capturing groups", () => {
			// "foo(?:bar)baz" → should extract literals from group content
			const result = decomposePattern("foo(?:bar)baz", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles groups with alternation by skipping them", () => {
			// "foo(a|b)bar" → "foo" and "bar"
			const result = decomposePattern("foo(a|b)bar", true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("bar");
		});

		it("handles character class shorthands", () => {
			// "\\d+\\.handleAuth" → dot breaks, "handleauth"
			const result = decomposePattern("\\d+\\.handleAuth", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles repetition braces", () => {
			// "a{3,5}bcdef" → "bcde" and "cdef"
			const result = decomposePattern("a{3,5}bcdef", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles lookahead by skipping", () => {
			const result = decomposePattern("foo(?=bar)baz", true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("baz");
		});

		it("returns no literals for pure wildcard regex", () => {
			const result = decomposePattern(".*", true);
			expect(result.hasLiterals).toBe(false);
		});

		it("returns no literals for short regex segments", () => {
			const result = decomposePattern("[a-z].", true);
			expect(result.hasLiterals).toBe(false);
		});

		it("handles complex real-world pattern", () => {
			// Searching for function definitions
			const result = decomposePattern("export\\s+function\\s+handle", true);
			expect(result.hasLiterals).toBe(true);
			// "export" and "function" and "handle" should be extractable
			expect(result.literalSegments.some((s) => s.includes("export"))).toBe(true);
		});

		it("handles pattern with multiple literal segments", () => {
			const result = decomposePattern("MAX_FILE_SIZE", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.requiredTrigrams.length).toBeGreaterThan(5);
		});
	});
});

// ===========================================
// Grep Command Parsing
// ===========================================

describe("parseGrepCommand", () => {
	it("parses basic rg command", () => {
		const result = parseGrepCommand("rg 'handleAuth'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("handleAuth");
		expect(result!.isRegex).toBe(true);
	});

	it("parses rg with path", () => {
		const result = parseGrepCommand("rg 'pattern' src/");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("pattern");
		expect(result!.path).toBe("src/");
	});

	it("parses case-insensitive flag", () => {
		const result = parseGrepCommand("rg -i 'Pattern'");
		expect(result).not.toBeNull();
		expect(result!.caseInsensitive).toBe(true);
	});

	it("parses fixed-string flag", () => {
		const result = parseGrepCommand("rg -F 'literal.string'");
		expect(result).not.toBeNull();
		expect(result!.isRegex).toBe(false);
	});

	it("declines on the glob flag (-g) — unsound glob filter, so native runs", () => {
		// Reproducing rg's glob semantics (braces, negation) is error-prone, so
		// the conservative contract declines rather than risk a wrong file set.
		expect(parseGrepCommand("rg -g '*.ts' 'pattern'")).toBeNull();
	});

	it("parses double-quoted pattern", () => {
		const result = parseGrepCommand('rg "handleAuth"');
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("handleAuth");
	});

	it("parses grep command", () => {
		const result = parseGrepCommand("grep 'pattern' file.ts");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("pattern");
	});

	it("parses -e flag for pattern", () => {
		const result = parseGrepCommand("rg -e 'mypattern' src/");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("mypattern");
	});

	it("returns null for non-grep commands", () => {
		expect(parseGrepCommand("ls -la")).toBeNull();
		expect(parseGrepCommand("cat file.ts")).toBeNull();
		expect(parseGrepCommand("npm test")).toBeNull();
	});

	it("returns null for empty pattern", () => {
		expect(parseGrepCommand("rg")).toBeNull();
	});

	it("parses safe combined flags (-i -F)", () => {
		const result = parseGrepCommand("rg -i -F 'test'");
		expect(result).not.toBeNull();
		expect(result!.caseInsensitive).toBe(true);
		expect(result!.isRegex).toBe(false);
	});

	it("declines on unmodeled flags (-n, --color) → native", () => {
		// Conservative contract: any flag outside {-i,-F,-s,-e} forces a decline —
		// even harmless ones — so the accelerator can never diverge from the
		// native command's output. Coverage is traded for provable correctness.
		expect(parseGrepCommand("rg -n --color=never -i 'test'")).toBeNull();
		expect(parseGrepCommand("rg -v 'test'")).toBeNull(); // invert — must never substitute
		expect(parseGrepCommand("rg -l 'test'")).toBeNull(); // files-with-matches
		expect(parseGrepCommand("rg -w 'test'")).toBeNull(); // word boundary
		expect(parseGrepCommand("rg -A2 'test'")).toBeNull(); // context lines
	});

	it("declines on pipelines / compound commands → native", () => {
		// The accelerator can only answer the single rg invocation; substituting
		// it would drop the rest of the command, so the whole thing runs natively.
		expect(parseGrepCommand("rg 'pattern' | head -20")).toBeNull();
		expect(parseGrepCommand("rg 'x' && echo done")).toBeNull();
		expect(parseGrepCommand("rg 'x' $(cat f)")).toBeNull();
		expect(parseGrepCommand("rg 'x'; rm y")).toBeNull();
	});

	it("handles backslash-escaped characters in pattern", () => {
		const result = parseGrepCommand("rg 'foo\\.bar'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("foo\\.bar");
	});

	// Native Claude Code (macOS/Linux) replaced the Grep tool with embedded
	// `ugrep` (`ug` / `ugrep`) invoked through Bash. These must parse so the
	// accelerator still recognizes search on native builds.
	it("parses ugrep command", () => {
		const result = parseGrepCommand("ugrep 'handleAuth' src/");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("handleAuth");
		expect(result!.path).toBe("src/");
	});

	it("parses the ug short binary with flags", () => {
		const result = parseGrepCommand("ug -i 'pattern'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("pattern");
		expect(result!.caseInsensitive).toBe(true);
	});

	it("parses ugrep invoked by absolute path (embedded binary)", () => {
		const result = parseGrepCommand("/opt/claude/bin/ugrep 'needle'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("needle");
	});

	it("does not treat a command merely starting with other letters as ugrep", () => {
		// Anchored at command start: 'debug …' begins with 'd', not a search verb.
		expect(parseGrepCommand("debug --port 9229")).toBeNull();
	});
});
