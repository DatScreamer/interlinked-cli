import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateTypeErasureOverlay } from "./type-erasure-overlay.js";

const tmpDir = mkdtempSync(join(tmpdir(), "type-erasure-w42-"));

function writeTmp(name: string, content: string): string {
	const p = join(tmpDir, name);
	writeFileSync(p, content, "utf-8");
	return p;
}

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("unjustified_ts_directive guard regex — positive/negative (must fire / must not fire)", () => {
	// 3e00578358271dcb — negated char class matches unadorned trailing text too permissively
	// test-contract: public-api — evaluateTypeErasureOverlay's unjustified_ts_directive rule
	// must flag a suppression directive with no justification separator.
	it("P: flags @ts-ignore with unadorned trailing text (no separator) as unjustified", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "// @ts-ignore reason\n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("unjustified_ts_directive");
	});

	// 2e4927f251d2f38f — \s* -> \s (exactly one) breaks zero-whitespace justification
	// test-contract: public-api — the same rule must NOT flag a directive that carries a
	// zero-whitespace colon-attached justification.
	it("N: treats @ts-ignore:reason (no space) as justified", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "// @ts-ignore:reason\n");
		expect(r.newFindings.length).toBe(0);
	});

	// e472c33a4a0df37b — \s*\S+ -> \S*\S+ breaks whitespace-then-word justification
	// test-contract: public-api — the same rule must NOT flag the canonical
	// "colon, space, word" justification form.
	it("N: treats @ts-ignore: reason (colon space word) as justified", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "// @ts-ignore: reason\n");
		expect(r.newFindings.length).toBe(0);
	});

	// f6ceefd192149379 — \S+ -> \s+ wrongly accepts trailing whitespace-only as a justification
	// test-contract: public-api — a colon followed only by whitespace carries no real reason
	// text and must still be flagged as unjustified.
	it("P: flags @ts-ignore: (colon, trailing space, no actual reason) as unjustified", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "// @ts-ignore: \n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("unjustified_ts_directive");
	});

	// test-contract: public-api — TypeErasureFinding.message is part of the returned public
	// shape and must carry the exact authored guidance text.
	it("message text on unjustified_ts_directive finding is the full guidance string", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "// @ts-ignore reason\n");
		expect(r.newFindings[0]?.message).toBe(
			"TypeScript suppression directive without an inline justification — write `// @ts-expect-error: <reason>` so the next reader knows why.",
		);
	});
});

describe("bare_any_annotation type-alias guard regex — anchor/quantifier boundaries", () => {
	// L1 baseline: kills 4029c5e98a3c509c, 8225619c86b0cb07, dedd2609d4930919,
	// e56bb8ee31ff76be, c151d67710daf34e, 3f5dd3ebd30919b2
	// test-contract: invariant — the bare_any_annotation guard deliberately exempts
	// `type X = { ...: any }` alias declarations from the bare-`any` rule.
	it("suppresses bare-any inside a zero-indent, no-export type alias line", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "type Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});

	// dcee660262465eba — removed ^ anchor wrongly treats a non-type-start line as a type alias
	// test-contract: boundary — the type-alias exemption is anchored to the true start of
	// the line; a line that merely contains "type " mid-string is not exempt.
	it("does NOT suppress when 'type ...' is not at the true start of the line", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "xtype Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(1);
	});

	// cf9a53c8914b3264 — \s* -> \S* leading breaks indented type aliases
	// test-contract: boundary — the type-alias exemption must still apply when the
	// declaration is indented inside a block.
	it("suppresses bare-any inside an indented type alias line", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "  type Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});

	// a0cdf0e2d8ce7a0b — export\s+ -> export\s breaks multi-space-after-export
	// test-contract: boundary — the exemption's "export" clause must tolerate more than
	// one space of separation, not just exactly one.
	it("suppresses bare-any inside an exported type alias with extra space after export", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "export  type Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});

	// c1a6ab7e3b0aae37 — export\s+ -> export\S+ breaks single-space-after-export
	// test-contract: public-api — the exemption must recognize the ordinary
	// "export type X = ..." form with exactly one space after "export".
	it("suppresses bare-any inside an exported type alias with a single space after export", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "export type Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});

	// 5b98351cec36ca3c — type\s+ -> type\s breaks multi-space-after-'type'
	// test-contract: boundary — the exemption must tolerate more than one space between
	// the "type" keyword and the alias name.
	it("suppresses bare-any inside a type alias with extra space after 'type'", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "type  Foo = { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});

	// ab5c6cd79c569260 — trailing \s* -> \s breaks zero-space-before-'='
	// test-contract: boundary — the exemption must tolerate zero spaces between the alias
	// name and the "=" sign.
	it("suppresses bare-any inside a type alias with no space before '='", () => {
		const r = evaluateTypeErasureOverlay("src/types.ts", "type Foo= { bar: any };\n");
		expect(r.newFindings.length).toBe(0);
	});
});

describe("module-level pattern constants — extension / test-file / cast regexes", () => {
	// 45908cefb470c723 — JS_TS_EXT loses its trailing $ anchor
	// test-contract: boundary — applicability must key off the file's true trailing
	// extension, not any substring match on "ts".
	it("is not applicable to a path whose real extension isn't ts/tsx/mts/cts", () => {
		const r = evaluateTypeErasureOverlay("file.ts.orig", "const x: any = 1;\n");
		expect(r.applicable).toBe(false);
		expect(r.newFindings.length).toBe(0);
	});

	// bd7451a048dfa7de — TEST_FILE first alt loses its trailing $ anchor
	// test-contract: boundary — the test-file classification requires the ".test.EXT"
	// marker to be the true end of the path, not merely present mid-path.
	it("does not classify a mid-path '.test.' segment as a test file", () => {
		const r = evaluateTypeErasureOverlay("src/foo.test.helper.ts", "const x: any = 1;\n");
		expect(r.newFindings.length).toBe(1);
	});

	// fdf6070dea43eab6 — /tests?/ loses its '?' becoming mandatory-plural /tests/
	// test-contract: boundary — the singular "/test/" directory form is a documented
	// test-file marker, not just the plural "/tests/".
	it("classifies a singular /test/ directory segment as a test file", () => {
		const r = evaluateTypeErasureOverlay("src/test/foo.ts", "const x: any = 1;\n");
		expect(r.newFindings.length).toBe(0);
	});

	// c5d9f4fed2f27ca9 — as_any pattern's \s+ -> \s breaks multi-space 'as  any'
	// test-contract: public-api — the as_any rule must match one-or-more whitespace
	// between "as" and "any", not exactly one.
	it("flags 'as  any' with two spaces between 'as' and 'any'", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as  any;\n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("as_any");
	});

	// 6e4da1e5a6c91835 — as_any message emptied
	// test-contract: public-api — TypeErasureFinding.message must carry the authored
	// guidance text for the as_any rule.
	it("as_any finding carries the full cast-erasure message", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as any;\n");
		expect(r.newFindings[0]?.message).toBe(
			"`as any` cast erases types — use a typed assertion, generic, or schema validator.",
		);
	});

	// 126950e1e79b4c36 — as_unknown_chain first \s+ -> \s breaks 'as  unknown as'
	// test-contract: public-api — the as_unknown_chain rule must match one-or-more
	// whitespace between "as" and "unknown", not exactly one.
	it("flags 'as  unknown as' with two spaces after the first 'as'", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = y as  unknown as z;\n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("as_unknown_chain");
	});

	// 18c484922e87d22e — as_unknown_chain second \s+ -> \s breaks 'unknown  as'
	// test-contract: public-api — the as_unknown_chain rule must match one-or-more
	// whitespace between "unknown" and the second "as", not exactly one.
	it("flags 'as unknown  as' with two spaces before the second 'as'", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = y as unknown  as z;\n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("as_unknown_chain");
	});

	// 46751a386ec7a367 — as_unknown_chain message emptied
	// test-contract: public-api — TypeErasureFinding.message must carry the authored
	// guidance text for the as_unknown_chain rule.
	it("as_unknown_chain finding carries the full bypass message", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = y as unknown as z;\n");
		expect(r.newFindings[0]?.message).toBe(
			"`as unknown as T` chain bypasses type checking — narrow with a type guard or runtime validator.",
		);
	});

	// ace47d7334060fa8 — bare_any pattern's \s* -> \s breaks zero-space ':any'
	// test-contract: public-api — the bare_any_annotation rule must match zero-or-more
	// whitespace after the colon, not require exactly one space.
	it("flags ':any' with zero spaces after the colon", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x:any = 1;\n");
		expect(r.newFindings.length).toBe(1);
		expect(r.newFindings[0]?.ruleId).toBe("bare_any_annotation");
	});

	// df3905e279cf3695 — bare_any message emptied
	// test-contract: public-api — TypeErasureFinding.message must carry the authored
	// guidance text for the bare_any_annotation rule.
	it("bare_any_annotation finding carries the full naming message", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x: any = 1;\n");
		expect(r.newFindings[0]?.message).toBe(
			"Bare `: any` annotation — name the actual shape (interface, generic, or branded type).",
		);
	});
});

describe("findAll internals — column/matchKey/array-init behavior", () => {
	// 30f2807d5ef0d7c1 — [] -> ["Stryker was here"] contaminates the initial findings array
	// test-contract: invariant — clean content with no type-erasure pattern must produce
	// an empty findings array, not a residual seed element.
	it("returns zero findings for clean content with no type-erasure patterns", () => {
		const r = evaluateTypeErasureOverlay(
			"src/clean.ts",
			"export function add(a: number, b: number): number {\n  return a + b;\n}\n",
		);
		expect(r.newFindings).toEqual([]);
	});

	// e5633003d5869fee — m.index + 1 -> m.index - 1 (reported column)
	// test-contract: public-api — TypeErasureFinding.column must be the 1-based column
	// of the actual match start.
	it("reports the 1-based column of the match, not index or index-1", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as any;\n");
		// "const x = 1 " is 12 chars (indices 0-11); "as any" starts at index 12.
		expect(r.newFindings[0]?.column).toBe(13);
	});

	// 8cb9d41c76ac8bf8 — matchKey template literal emptied
	// test-contract: public-api — TypeErasureFinding.matchKey is the diff key and must
	// be the composed "ruleId:trimmed-line" string, not empty.
	it("matchKey combines the ruleId and the trimmed original line text", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as any;\n");
		expect(r.newFindings[0]?.matchKey).toBe("as_any:const x = 1 as any;");
	});

	// 5aaf489b1bc6b49b — origLine.trim() -> origLine (untrimmed) in matchKey
	// test-contract: public-api — matchKey must be built from the trimmed line so
	// whitespace-only edits don't change the diff key.
	it("matchKey uses the trimmed line, dropping leading/trailing whitespace", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "   const y = 1 as any;   \n");
		expect(r.newFindings[0]?.matchKey).toBe("as_any:const y = 1 as any;");
	});
});

describe("evaluateTypeErasureOverlay — applicable flag across all return paths", () => {
	// 6b3be5e5f527f066 / 06920d9c5b071ddf — true -> false at any of the three 'applicable: true' sites
	// test-contract: public-api — a .ts file is applicable regardless of whether the
	// content contains a finding.
	it("applicable is true on the no-findings early-return path", () => {
		const r = evaluateTypeErasureOverlay("src/clean.ts", "const x = 1;\n");
		expect(r.applicable).toBe(true);
	});

	// test-contract: public-api — applicable stays true on the no-pre-content fallback path.
	it("applicable is true on the no-pre-content early-return path", () => {
		const r = evaluateTypeErasureOverlay(
			join(tmpDir, "does-not-exist-w42.ts"),
			"const x = 1 as any;\n",
		);
		expect(r.applicable).toBe(true);
		expect(r.newFindings.length).toBe(1);
	});

	// test-contract: public-api — applicable stays true on the full pre/post diff path.
	it("applicable is true on the full-diff return path", () => {
		const r = evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as any;\n", {
			preContent: "no matches here\n",
		});
		expect(r.applicable).toBe(true);
	});
});

describe("evaluateTypeErasureOverlay — options.preContent / disk-fallback branching", () => {
	// e43b4b73d95179a1 / 56f93725e466323f — forcing the options-guard branch to 'true' or '||'
	// dereferences/evaluates against `options` while it is undefined, which throws.
	// test-contract: bug — calling the public function with the options argument omitted
	// must never throw.
	it("does not throw when called with no options object and content has a finding", () => {
		expect(() => evaluateTypeErasureOverlay("src/foo.ts", "const x = 1 as any;\n")).not.toThrow();
	});

	// 58a2310d8397a051 — condition2 forced false skips the legitimate disk-read fallback
	// test-contract: invariant — with no options given, the on-disk file is the pre-content
	// source of truth, so a matching pre-existing occurrence must be filtered out.
	it("reads pre-existing disk content when no options are passed and filters a matching finding", () => {
		const content = "const z = 3 as any;\n";
		const filePath = writeTmp("disk-match-58a.ts", content);
		const r = evaluateTypeErasureOverlay(filePath, content);
		expect(r.newFindings.length).toBe(0);
	});

	// 110c6a66ed07c1c0 / ab12556e17c25019 / 84202d8be4a7a6bb — options={preContent: undefined}
	// (hasOwn true, value explicitly undefined) must SKIP the disk-read fallback entirely.
	// test-contract: invariant — an explicitly-provided preContent:undefined means "diff
	// against nothing", distinct from "no options given" (which reads disk).
	it("honors an explicit preContent:undefined and does not fall back to disk", () => {
		const content = "const q1 = 9 as any;\n";
		const filePath = writeTmp("disk-explicit-undefined.ts", content);
		const r = evaluateTypeErasureOverlay(filePath, content, { preContent: undefined });
		expect(r.newFindings.length).toBe(1);
	});

	// 2f6d0d8899850d7c / c8a8087d90660957 — options={} (hasOwn false) must legitimately
	// fall back to disk and filter a matching finding.
	// test-contract: invariant — an options object with no "preContent" key is the same
	// as no options: the disk-read fallback still applies.
	it("falls back to disk when options is an empty object with no preContent key", () => {
		const content = "const q2 = 9 as any;\n";
		const filePath = writeTmp("disk-empty-options.ts", content);
		const r = evaluateTypeErasureOverlay(filePath, content, {});
		expect(r.newFindings.length).toBe(0);
	});

	// ebc55d03528bd8d1 — forcing condition2 to 'true' wrongly re-reads disk even when a real
	// preContent value was already supplied via options.
	// test-contract: invariant — an explicitly supplied non-undefined preContent must win
	// over whatever the on-disk file happens to contain.
	it("does not overwrite a supplied preContent with disk content", () => {
		const diskContent = "const y = 2 as any;\n";
		const filePath = writeTmp("disk-should-be-ignored.ts", diskContent);
		const r = evaluateTypeErasureOverlay(filePath, diskContent, {
			preContent: "no matches here\n",
		});
		expect(r.newFindings.length).toBe(1);
	});

	// d98586a0947b225e / f17870f5977912e7 — 'preContent === undefined' mutated at the
	// early-return check must not bypass a real diff when preContent is genuinely supplied.
	// test-contract: invariant — when preContent equals postContent, the diff must filter
	// the finding to zero, proving the real subtract logic ran (not the early return).
	it("performs the real diff (not the early-return) when preContent is genuinely supplied", () => {
		const content = "const w = 4 as any;\n";
		const r = evaluateTypeErasureOverlay("src/nonexistent-w42.ts", content, {
			preContent: content,
		});
		expect(r.newFindings.length).toBe(0);
	});

	// d6130e3a1cf46a9c — the "preContent" key literal used by Object.hasOwn emptied to ""
	// test-contract: invariant — Object.hasOwn must check the real "preContent" key so a
	// genuinely supplied preContent value is actually used for the diff.
	it("recognizes the literal 'preContent' key (not an empty-string key)", () => {
		const content = "const q3 = 5 as any;\n";
		const r = evaluateTypeErasureOverlay("src/nonexistent-w42-b.ts", content, {
			preContent: content,
		});
		expect(r.newFindings.length).toBe(0);
	});
});

describe("evaluateTypeErasureOverlay — pre/post multiset diff counting", () => {
	// 683ddbdb57e135ed (remaining - 1 -> remaining + 1) and dc2acc254557f167
	// (the decrement block emptied) both break the multiset subtract: with 1 pre-existing
	// occurrence and 3 identical post occurrences, exactly 2 must be reported as new.
	// test-contract: invariant — the pre/post diff is a multiset subtract: consuming a
	// pre-existing occurrence must decrement its remaining count, not leave it unchanged
	// or increment it, so only genuinely new occurrences are reported.
	it("reports exactly the post occurrences beyond the pre-existing count for a repeated line", () => {
		const line = "const p = 1 as any;\n";
		const r = evaluateTypeErasureOverlay("src/foo.ts", line + line + line, {
			preContent: line,
		});
		expect(r.newFindings.length).toBe(2);
	});
});
