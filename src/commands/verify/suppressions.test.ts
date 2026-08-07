// ===========================================
// suppressions unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { collectSuppressionFindings, findSuppressionMatch } from "./suppressions.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

describe("findSuppressionMatch", () => {
	it("flags bare ts-ignore with no rationale", () => {
		const line = `// ${["@ts", "ignore"].join("-")}`;
		const hit = findSuppressionMatch(line, line);
		expect(hit).not.toBeNull();
		expect(hit?.label).toBe(["@ts", "ignore"].join("-"));
	});

	it("accepts ts-expect-error with a long rationale", () => {
		const directive = ["@ts", "expect", "error"].join("-");
		const line = `// ${directive}: narrowed via isFoo helper above`;
		expect(findSuppressionMatch(line, line)).toBeNull();
	});

	it("rejects ts-expect-error with too-short rationale", () => {
		const directive = ["@ts", "expect", "error"].join("-");
		const line = `// ${directive}: x`;
		expect(findSuppressionMatch(line, line)).not.toBeNull();
	});

	it("returns null for non-suppression lines", () => {
		expect(findSuppressionMatch("const x = 1;", "const x = 1;")).toBeNull();
	});

	it("does not treat // noqa (JS comment) as a directive", () => {
		// noqa is a Python/flake8 convention; a `// noqa` in TS is prose, e.g. a
		// detector commenting on how it scans noqa ranges.
		const line = "// noqa suppression range scan (Python checks)";
		expect(findSuppressionMatch(line, line)).toBeNull();
	});

	it("flags bare # noqa (Python convention)", () => {
		const line = "x = risky()  # noqa";
		expect(findSuppressionMatch(line, line)).not.toBeNull();
	});
});

describe("collectSuppressionFindings", () => {
	it("ignores suppression strings inside string literals", () => {
		const content = [`const s = "// ${["@ts", "ignore"].join("-")}";`, ""].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "fixture.ts", out);
		expect(out.length).toBe(0);
	});

	it("records suppression findings with the file path", () => {
		const content = [`// ${["@ts", "ignore"].join("-")}`, "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "fixture.ts", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(out[0]).file).toBe("fixture.ts");
		expect(nonNull(out[0]).check).toBe("suppressions");
	});

	it("does not flag # noqa inside a JS/TS string fixture", () => {
		// Python code samples live inside TS template-literal fixtures; `#` is not
		// a comment in TS, so the directive there is data, not a suppression.
		const content = "const code = `value = risky()  # noqa`;";
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/checks/foo.test.ts", out);
		expect(out.length).toBe(0);
	});

	it("flags a bare # noqa in a Python file (real directive there)", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "scripts/foo.py", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("exempts files under a fixtures/ dir (deliberately-crafted bad samples)", () => {
		const content = [`// ${["@ts", "nocheck"].join("-")}`, "const x = 1;"].join("\n");
		const exempt: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/__tests__/fixtures/supermodel/high-risk.ts", exempt);
		expect(exempt.length).toBe(0);
		// Same content in real source is still flagged — the exemption is fixtures-only.
		const real: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/harness/risk.ts", real);
		expect(real.length).toBeGreaterThanOrEqual(1);
	});

	it("exempts a top-level fixtures/ dir with no leading path segment", () => {
		// mutation-kill: the exemption regex is /(?:^|\/)(?:fixtures|__fixtures__)\//ish
		// — it must match at the very start of the path (^fixtures/), not only when
		// preceded by another "/". A relPath that starts exactly with "fixtures/"
		// (no parent directory) exercises the `^` alternative specifically.
		const content = [`// ${["@ts", "nocheck"].join("-")}`, "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "fixtures/sample.ts", out);
		expect(out.length).toBe(0);
	});

	it("records the correct 1-indexed line number for a directive on a later line", () => {
		// mutation-kill: `line: i + 1` vs `i - 1` — put the directive on the SECOND
		// line (i = 1) so the two disagree (2 vs 0), not just sign.
		const content = ["const x = 1;", `// ${["@ts", "ignore"].join("-")}`, "const y = 2;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/sample.ts", out);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).line).toBe(2);
	});

	it("preserves leading whitespace verbatim in the recorded message (no re-trim on output)", () => {
		// mutation-kill: `const trimmed = line.trim();` — if `.trim()` is dropped,
		// the message (built from `trimmed`) keeps the raw leading whitespace.
		const directive = ["@ts", "ignore"].join("-");
		const content = [`   // ${directive}`, "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/sample.ts", out);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).message).toBe(`${directive}: // ${directive}`);
	});

	it("truncates the recorded message to MAX_SUPPRESSION_MESSAGE_LENGTH (120 chars)", () => {
		// mutation-kill: `trimmed.slice(0, MAX_SUPPRESSION_MESSAGE_LENGTH)` vs bare
		// `trimmed` (no truncation) — only observable on a line longer than 120 chars.
		const directive = ["@ts", "ignore"].join("-");
		const longLine = `// ${directive} ${"a".repeat(200)}`;
		const content = [longLine, "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/sample.ts", out);
		expect(out.length).toBe(1);
		expect(nonNull(out[0]).message).toBe(`${directive}: ${longLine.slice(0, 120)}`);
		expect(nonNull(out[0]).message.length).toBe(directive.length + 2 + 120);
	});

	it("skips jsdoc-style `*` continuation lines even when they contain directive-like text", () => {
		// mutation-kill: the `trimmed.startsWith("*") || trimmed.startsWith("/**")`
		// skip guard — ConditionalExpression(false)/LogicalOperator(&&)/
		// MethodExpression(endsWith("*")) mutants all fail to skip this line, which
		// (because it contains a real "//" prefix) would otherwise produce a finding.
		const content = [" * // @ts-ignore standalone", "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/sample.ts", out);
		expect(out.length).toBe(0);
	});

	it("skips a block-comment-opener `/**` line even when it contains directive-like text", () => {
		// mutation-kill: MethodExpression mutant swaps the second disjunct to
		// `trimmed.endsWith("/**")`, which is false for an opener line (it ends
		// with "*/", not "/**") — only distinguishable when the FIRST disjunct
		// (`startsWith("*")`) is also false, i.e. the line starts with "/**" not "*".
		const content = ["/** // @ts-ignore inline text */", "const x = 1;"].join("\n");
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings(content, "src/sample.ts", out);
		expect(out.length).toBe(0);
	});
});

describe("findSuppressionMatch — idx guard in hasSuppressionRationale (line 46)", () => {
	it("treats a directive-shaped rawLine as unsuppressed when the label is absent from trimmedLine", () => {
		// mutation-kill: `if (idx === -1) return false;` — both the
		// ConditionalExpression(false) mutant and the UnaryOperator(+1) mutant
		// disable/relocate this early return. Passing a trimmedLine that does NOT
		// contain the label (unusual, but the parameter is not re-derived from
		// rawLine) forces idx === -1 under the real implementation. Craft the
		// trimmedLine's tail so that if the guard is skipped, the resulting
		// (wrong) slice offset would accidentally look like a valid rationale —
		// that's exactly the behavior the guard exists to prevent.
		const directive = ["@ts", "ignore"].join("-"); // length 10
		const rawLine = `// ${directive}`;
		const trimmedLine = "xxxxxxxxx: this is a long reason"; // slice(-1+10)=slice(9) => ": this is..."
		const hit = findSuppressionMatch(rawLine, trimmedLine);
		expect(hit).not.toBeNull();
		expect(hit?.label).toBe(directive);
	});
});

describe("hasSuppressionRationale — rationale-separator regex (line 49)", () => {
	it("does NOT accept prose with no colon/dash separator as rationale", () => {
		// mutation-kill: Regex mutant negating the leading class to
		// `[^:—–-]` accepts almost any character as a "separator", so plain
		// prose with no real separator would incorrectly pass.
		const directive = ["@ts", "ignore"].join("-");
		const rawLine = `// ${directive} justAWord`;
		const hit = findSuppressionMatch(rawLine, rawLine);
		expect(hit).not.toBeNull();
		expect(hit?.label).toBe(directive);
	});

	it("does NOT accept a colon directly followed by text with no whitespace as satisfying the [^\\s]/[\\s] capture-start mutants", () => {
		// mutation-kill: three Regex mutants — dropping the `\s*` quantifier
		// (requires exactly one whitespace char after the separator), and negating
		// the capture's leading class (`[^\s]` -> `[\s]` / `[^\S]`, requiring the
		// captured rationale to START with whitespace). `:reason` has a separator
		// immediately followed by a non-whitespace char and no whitespace anywhere
		// else in `after`, so all three mutants fail to match while the real regex
		// (zero-or-more whitespace, then a non-whitespace char) succeeds.
		const directive = ["@ts", "ignore"].join("-");
		const rawLine = `// ${directive}:reason text here`;
		const hit = findSuppressionMatch(rawLine, rawLine);
		expect(hit).toBeNull();
	});
});

describe("hasSuppressionRationale — MIN_RATIONALE_LENGTH boundary and trim (line 54)", () => {
	it("accepts a rationale of exactly MIN_RATIONALE_LENGTH (8) characters", () => {
		// mutation-kill: EqualityOperator mutant `>` instead of `>=` rejects the
		// exact-8-char boundary that the real `>=` accepts.
		const directive = ["@ts", "ignore"].join("-");
		const rawLine = `// ${directive}: abcdefgh`; // captured rationale = "abcdefgh" (8 chars)
		const hit = findSuppressionMatch(rawLine, rawLine);
		expect(hit).toBeNull();
	});

	it("does not count trailing whitespace toward the rationale length (requires .trim())", () => {
		// mutation-kill: MethodExpression mutant drops `.trim()` from
		// `nonNull(rationaleMatch[1]).trim().length`. Craft a trimmedLine argument
		// directly (bypassing the real per-line `.trim()` upstream) whose captured
		// rationale is 7 real chars plus 3 trailing spaces — 10 raw chars (>=8,
		// mutant accepts) but only 7 once trimmed (<8, real code rejects).
		const directive = ["@ts", "ignore"].join("-");
		const rawLine = `// ${directive}: abcdefg   `;
		const trimmedLine = `// ${directive}: abcdefg   `;
		const hit = findSuppressionMatch(rawLine, trimmedLine);
		expect(hit).not.toBeNull();
	});
});

describe("hasSuppressionRationale — namespaced rule-spec fallback (line 58)", () => {
	it("accepts a bare namespaced spec (plugin/rule) with no colon/dash separator as rationale", () => {
		// mutation-kill: ConditionalExpression(false) skips this branch entirely;
		// Regex mutants negating the first class (`[^A-Za-z0-9_-]+`) or negating
		// the second class (`[^A-Za-z0-9_-]+` after the slash) all fail to match
		// "foo/bar" for boundary/character-class reasons verified directly against
		// the actual regex engine.
		const directive = ["@ts", "ignore"].join("-");
		const rawLine = `// ${directive} foo/bar`;
		const hit = findSuppressionMatch(rawLine, rawLine);
		expect(hit).toBeNull();
	});
});

describe("suppression pattern table — directive text and comment-prefix pinning (lines 64-72)", () => {
	const cases: Array<{ name: string; directive: string; prefix: string; suffix?: string }> = [
		{ name: "ts-ignore", directive: ["@ts", "ignore"].join("-"), prefix: "//" },
		{ name: "ts-expect-error", directive: ["@ts", "expect", "error"].join("-"), prefix: "//" },
		{ name: "ts-nocheck", directive: ["@ts", "nocheck"].join("-"), prefix: "//" },
		{ name: "eslint-disable-next-line", directive: ["eslint", "disable", "next", "line"].join("-"), prefix: "//" },
		{ name: "eslint-disable", directive: ["eslint", "disable"].join("-"), prefix: "/*", suffix: " */" },
		{ name: "biome-ignore", directive: ["biome", "ignore"].join("-"), prefix: "//" },
		{ name: "prettier-ignore", directive: ["prettier", "ignore"].join("-"), prefix: "//" },
		{ name: "noinspection", directive: "noinspection", prefix: "//" },
		{ name: "nolint", directive: "nolint", prefix: "//" },
	];

	for (const { name, directive, prefix, suffix } of cases) {
		it(`flags a bare ${name} directive with the correct comment prefix`, () => {
			// mutation-kill: any StringLiteral mutant blanking a joined-directive
			// segment (e.g. "expect" -> "") changes the literal text the pattern
			// looks for, so it no longer matches this real, correctly-spelled line.
			const line = `${prefix} ${directive}${suffix ?? ""}`;
			const hit = findSuppressionMatch(line, line);
			expect(hit).not.toBeNull();
			expect(hit?.label).toBe(directive);
		});

		it(`does NOT flag "${name}" text lacking its required comment prefix`, () => {
			// mutation-kill: StringLiteral mutant blanking the `sup()` prefix
			// argument (e.g. "\\/\\/" -> "") would make the prefix optional, so
			// this prose (same directive text, no comment marker) would wrongly match.
			const line = `discussing the ${directive} directive in prose`;
			const hit = findSuppressionMatch(line, line);
			expect(hit).toBeNull();
		});
	}
});

describe("hash-comment suppression patterns — prefix and directive-text pinning (lines 81-84)", () => {
	it("does not flag bare 'noqa' text with no '#' prefix", () => {
		const line = "noqa mentioned in the docs";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag an unrelated '#' comment as 'type: ignore'", () => {
		const line = "# just a comment, not a directive";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag bare 'type: ignore' text with no '#' prefix", () => {
		const line = "type: ignore this sentence, it is prose";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag an unrelated '#' comment as 'nosec'", () => {
		const line = "# unrelated comment";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag bare 'nosec' text with no '#' prefix", () => {
		const line = "nosec is a keyword some scanners look for";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag an unrelated '#' comment as 'nolint'", () => {
		const line = "# a plain hash comment";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});

	it("does not flag bare 'nolint' text with no '#' prefix", () => {
		const line = "nolint appears here as plain prose";
		const hit = findSuppressionMatch(line, line, true);
		expect(hit).toBeNull();
	});
});

describe("isHashCommentFile — extension table pinning (lines 90-91)", () => {
	const extensions = [
		".py", ".pyi", ".rb", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".tf",
		".pl", ".r", ".jl", ".ex", ".exs", ".nim", ".cr", ".rake", ".gemspec", ".coffee",
	];

	for (const ext of extensions) {
		it(`treats a "${ext}" file as hash-comment (flags bare # noqa)`, () => {
			// mutation-kill: StringLiteral mutant blanking THIS specific extension
			// literal in the Set removes it from membership, so only a file with
			// exactly this extension stops being flagged.
			const out: CodeQualityIssue[] = [];
			collectSuppressionFindings("x = risky()  # noqa\n", `scripts/foo${ext}`, out);
			expect(out.length).toBeGreaterThanOrEqual(1);
		});
	}

	it("does not treat an unlisted extension (.js) as hash-comment", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "src/app.js", out);
		expect(out.length).toBe(0);
	});
});

describe("isHashCommentFile — basename table and branch pinning (lines 93, 98-99, 103)", () => {
	it("recognizes 'Makefile' via the basename Set branch", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "project/Makefile", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes exact 'Dockerfile' via the basename Set branch", () => {
		// mutation-kill: pins the "dockerfile" string literal in
		// HASH_COMMENT_BASENAMES specifically (distinct from the
		// startsWith("dockerfile.") branch exercised by "Dockerfile.dev" below).
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "infra/Dockerfile", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes 'Gemfile' via the basename Set branch", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "Gemfile", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes 'Rakefile' via the basename Set branch", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "Rakefile", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes 'Dockerfile.dev' via the startsWith('dockerfile.') branch", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "infra/Dockerfile.dev", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("recognizes 'common.mk' via the endsWith('.mk') branch", () => {
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "build/common.mk", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does not recognize an unrelated basename+extension ('app.js')", () => {
		// mutation-kill: this negative case is what kills the
		// ConditionalExpression(true)-forces-always-hash-comment mutant, since
		// every positive case above still passes under an always-true mutant.
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "src/app.js", out);
		expect(out.length).toBe(0);
	});

	it("respects a trailing space in the basename (requires .trim() on the split segment)", () => {
		// mutation-kill: MethodExpression mutant drops the `.trim()` applied to
		// `relPath.toLowerCase().split("/").pop() ?? ""`, so a trailing space in
		// the basename would survive and break the exact Set/prefix/suffix checks.
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "scratch/Dockerfile ", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("treats a bare '.py' filename (dot at index 0) as hash-comment", () => {
		// mutation-kill: EqualityOperator mutant `dot > 0` instead of `dot >= 0`
		// rejects the boundary case where the extension starts at index 0.
		const out: CodeQualityIssue[] = [];
		collectSuppressionFindings("x = risky()  # noqa\n", "scratch/.py", out);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});
